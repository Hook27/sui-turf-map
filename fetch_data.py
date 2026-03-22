#!/usr/bin/env python3
"""
SUI Turf Map — data fetcher with timeline support
Saves versioned snapshots and maintains history.json.
Max 90 snapshots (≈30 days at 3x/day).
"""

import json, time, sys, os, glob, urllib.request, urllib.error
from datetime import datetime, timezone

# ── CONSTANTS ──────────────────────────────────────────────────────────────────
TURF_SYSTEM      = "0x372e8fd0e12d2051860553b9e61065729dcddec11970b295bbcf19d7261cc502"
PLAYERS_REGISTRY = "0x84a4a83842e92d8091563ae7a033797ad5182baca84de9f89573cb5b3722b494"
NULL_ID          = "0x" + "0" * 64
MAX_SNAPSHOTS    = 90   # keep last 90 snapshots (~30 days at 3x/day)
SNAPSHOTS_DIR    = "snapshots"

RPC_ENDPOINTS = [
    "https://fullnode.mainnet.sui.io:443",
    "https://mainnet.suiet.app",
    "https://sui-rpc.publicnode.com",
    "https://sui-mainnet.blockvision.org/v1/",
]

BATCH      = 50
DELAY      = 0.2
DELAY_PAGE = 0.3

# ── RPC ────────────────────────────────────────────────────────────────────────
rpc_index = 0

def rpc(method, params, retries=5):
    global rpc_index
    for attempt in range(retries):
        url = RPC_ENDPOINTS[rpc_index % len(RPC_ENDPOINTS)]
        payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type":"application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                if "error" in data:
                    raise ValueError(data["error"])
                return data["result"]
        except urllib.error.HTTPError as e:
            if e.code in (429, 403):
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited ({e.code}), waiting {wait}s...")
                time.sleep(wait)
                continue
            rpc_index += 1
            if attempt == retries - 1: raise
            time.sleep(3)
        except Exception:
            rpc_index += 1
            if attempt == retries - 1: raise
            time.sleep(3)

def signed(v, neg):
    v = int(v)
    return -abs(v) if neg in (True, "true") else v

def find_id(obj):
    if isinstance(obj, str) and obj.startswith("0x") and len(obj) == 66:
        return obj
    if isinstance(obj, dict):
        if "id" in obj:
            r = find_id(obj["id"])
            if r: return r
        for v in obj.values():
            r = find_id(v)
            if r: return r
    return None

# ── STEP 1: PlayersRegistry ────────────────────────────────────────────────────
print("Step 1/4: Loading PlayersRegistry...")
reg = rpc("sui_getObject", [PLAYERS_REGISTRY, {"showContent": True}])
reg_fields = reg["data"]["content"]["fields"]
tv = reg_fields["players"]
tv_id = find_id(tv)
if not tv_id:
    print("ERROR: TableVec ID not found"); sys.exit(1)
print(f"  TableVec ID: {tv_id}")

wrap_ids = []
cursor = None
page = 0
while True:
    res = rpc("suix_getDynamicFields", [tv_id, cursor, 50])
    for item in res["data"]:
        if item.get("objectId"): wrap_ids.append(item["objectId"])
    page += 1
    if page % 20 == 0: print(f"  Page {page}: {len(wrap_ids)} wrappers")
    if not res["hasNextPage"]: break
    cursor = res["nextCursor"]
    time.sleep(DELAY_PAGE)
print(f"  Registry done: {len(wrap_ids)} wrappers")

real_pids = []
for i in range(0, len(wrap_ids), BATCH):
    objs = rpc("sui_multiGetObjects", [wrap_ids[i:i+BATCH], {"showContent":True,"showType":True}])
    if not isinstance(objs, list): continue
    for obj in objs:
        if not obj or obj.get("error"): continue
        if "Player" in (obj.get("data") or {}).get("type", ""):
            real_pids.append(obj["data"]["objectId"]); continue
        val = ((obj.get("data") or {}).get("content") or {}).get("fields", {}).get("value")
        if isinstance(val, str) and val.startswith("0x"): real_pids.append(val)
        elif isinstance(val, dict):
            pid = find_id(val)
            if pid: real_pids.append(pid)
    if i % 2000 == 0 and i > 0: print(f"  {i}/{len(wrap_ids)} resolved → {len(real_pids)} IDs")
    time.sleep(DELAY)

if not real_pids:
    print("  Fallback: using wrapper IDs directly")
    real_pids = wrap_ids
print(f"  Profile IDs: {len(real_pids)}")

# ── STEP 2: Player profiles ────────────────────────────────────────────────────
print("Step 2/4: Loading player profiles...")
profiles = {}

for i in range(0, len(real_pids), BATCH):
    objs = rpc("sui_multiGetObjects", [real_pids[i:i+BATCH], {"showContent":True,"showType":True}])
    if not isinstance(objs, list): continue
    for obj in objs:
        if not obj or obj.get("error"): continue
        if "Player" not in (obj.get("data") or {}).get("type", ""): continue
        f = ((obj.get("data") or {}).get("content") or {}).get("fields")
        if not f: continue
        pid = obj["data"]["objectId"]
        profiles[pid] = {
            "name":       f.get("player_name", ""),
            "wallet":     f.get("player_address", ""),
            "isInactive": f.get("is_inactive") in (True, "true"),
            "hqTile":     f.get("headquarter_tile"),
        }
    if i % 2000 == 0 and i > 0: print(f"  {i}/{len(real_pids)} profiles loaded")
    time.sleep(DELAY)

named = sum(1 for p in profiles.values() if p["name"])
print(f"  Profiles: {len(profiles)} ({named} with name)")
hq_set = {p["hqTile"] for p in profiles.values() if p.get("hqTile")}

# ── STEP 3: TurfSystem ────────────────────────────────────────────────────────
print("Step 3/4: Loading TurfSystem...")
ts = rpc("sui_getObject", [TURF_SYSTEM, {"showContent": True}])
cf = ts["data"]["content"]["fields"].get("coordinates_turfs", {})
turf_table_id = find_id(cf)
if not turf_table_id:
    print("ERROR: TurfSystem Table ID not found"); sys.exit(1)
print(f"  Table ID: {turf_table_id}")

dyn_ids = []
cursor = None
page = 0
while True:
    res = rpc("suix_getDynamicFields", [turf_table_id, cursor, 50])
    for item in res["data"]:
        if item.get("objectId"): dyn_ids.append(item["objectId"])
    page += 1
    if page % 20 == 0: print(f"  Page {page}: {len(dyn_ids)} tile entries")
    if not res["hasNextPage"]: break
    cursor = res["nextCursor"]
    time.sleep(DELAY_PAGE)
print(f"  TurfSystem done: {len(dyn_ids)} entries")

tile_ids = []
for i in range(0, len(dyn_ids), BATCH):
    objs = rpc("sui_multiGetObjects", [dyn_ids[i:i+BATCH], {"showContent": True}])
    if not isinstance(objs, list): continue
    for obj in objs:
        if not obj or obj.get("error"): continue
        val = ((obj.get("data") or {}).get("content") or {}).get("fields", {}).get("value")
        if isinstance(val, str) and val.startswith("0x"): tile_ids.append(val)
        elif isinstance(val, dict):
            tid = find_id(val)
            if tid: tile_ids.append(tid)
    if i % 2000 == 0 and i > 0: print(f"  {i}/{len(dyn_ids)} resolved → {len(tile_ids)} tile IDs")
    time.sleep(DELAY)
print(f"  Tile IDs: {len(tile_ids)}")

# ── STEP 4: Tile data ─────────────────────────────────────────────────────────
print("Step 4/4: Loading tile data...")
owner_count = {}
raw_tiles = []
unclaimed = 0

for i in range(0, len(tile_ids), BATCH):
    objs = rpc("sui_multiGetObjects", [tile_ids[i:i+BATCH], {"showContent": True}])
    if not isinstance(objs, list): time.sleep(0.5); continue
    for obj in objs:
        if not obj or obj.get("error"): continue
        f = ((obj.get("data") or {}).get("content") or {}).get("fields")
        if not f: continue
        x = signed(f.get("x", 0), f.get("x_neg", False))
        y = signed(f.get("y", 0), f.get("y_neg", False))
        pid = f.get("owner_id")
        tile_id = obj["data"]["objectId"]
        if not pid or pid == NULL_ID:
            unclaimed += 1; continue
        # ── GARRISON (v2.6) ──────────────────────────────────────────────────
        # garrison is a VecMap<String, u64> stored as:
        # garrison.fields.contents = [{fields:{key:"enforcer",value:"12"}},...]
        g_h = g_b = g_e = 0
        gar = f.get("garrison")
        if isinstance(gar, dict):
            contents = gar.get("fields", {}).get("contents", [])
            for entry in contents:
                ef = entry.get("fields", {}) if isinstance(entry, dict) else {}
                k = (ef.get("key") or "").lower()
                v = int(ef.get("value", 0) or 0)
                if k == "henchman":   g_h = v
                elif k == "bouncer":  g_b = v
                elif k == "enforcer": g_e = v
        raw_tiles.append({"x": x, "y": y, "pid": pid, "hq": tile_id in hq_set,
                          "g_h": g_h, "g_b": g_b, "g_e": g_e,
                          "oid": tile_id if (g_h or g_b or g_e or tile_id in hq_set) else None})
        owner_count[pid] = owner_count.get(pid, 0) + 1
    if i % 2000 == 0 and i > 0: print(f"  {i}/{len(tile_ids)} tiles → {len(owner_count)} players")
    time.sleep(DELAY)

print(f"  Tiles: {len(raw_tiles)} occupied, {unclaimed} unclaimed")

# ── BUILD OUTPUT ───────────────────────────────────────────────────────────────
print("Building output...")

MY_IDS = set()  # Determined client-side per user via localStorage

def pid_color(pid, tile_count=0):
    h = 0
    for c in pid: h = (h * 31 + ord(c)) & 0xFFFFFFFF
    hue = (h % 300) + 30
    # Vary saturation and lightness slightly per player so nearby hues look distinct
    sat = 55 + (h >> 8 & 0xF)        # 55–70 %
    lig = 38 + (h >> 4 & 0xF)        # 38–53 %
    return f"hsl({hue},{sat}%,{lig}%)"

player_list = []
pid_to_index = {}
for pid, count in sorted(owner_count.items(), key=lambda x: -x[1]):
    p = profiles.get(pid, {})
    is_me = pid in MY_IDS
    idx = len(player_list)
    pid_to_index[pid] = idx
    player_list.append({
        "pid":     pid,
        "name":    p.get("name", ""),
        "wallet":  p.get("wallet", ""),
        "inactive":p.get("isInactive", False),
        "tiles":   count,
        "me":      is_me,
        "color":   "#7F77DD" if is_me else pid_color(pid, count),
    })

compact_tiles = []
for t in raw_tiles:
    idx = pid_to_index.get(t["pid"])
    if idx is None: continue
    entry = {"x": t["x"], "y": t["y"], "p": idx}
    if t["hq"]: entry["hq"] = True
    if t.get("g_h"): entry["g_h"] = t["g_h"]
    if t.get("g_b"): entry["g_b"] = t["g_b"]
    if t.get("g_e"): entry["g_e"] = t["g_e"]
    if t.get("oid"): entry["oid"] = t["oid"]  # object ID for garrison recall
    compact_tiles.append(entry)

# Build HQ register: {tile_oid: owner_pid} for all HQ tiles
hq_register = {}
for t in raw_tiles:
    if t["hq"] and t.get("oid"):
        hq_register[t["oid"]] = t["pid"]

now_utc = datetime.now(timezone.utc)
output = {
    "generated":   now_utc.isoformat(),
    "total_tiles": len(tile_ids),
    "unclaimed":   unclaimed,
    "players":     player_list,
    "tiles":       compact_tiles,
    "hq_register": hq_register,
}


# ── LAST CHANGE TRACKING ──────────────────────────────────────────────────────
# Compare current turf counts against previous snapshots to find when each
# player's count last changed. Scans snapshots newest-first, stops when change found.
print("Computing last-change days per player...")
current_counts = {p["pid"]: p["tiles"] for p in player_list}
last_change_days = {}  # pid -> days since last change (None = never changed in history)

all_snaps_sorted = sorted(glob.glob(f"{SNAPSHOTS_DIR}/data_*.json"), reverse=True)
# Skip the snapshot we just wrote (index 0 = current)
for snap_path in all_snaps_sorted[1:]:
    basename = os.path.basename(snap_path)
    ts_str = basename[5:-5]
    try:
        dt = datetime.strptime(ts_str, "%Y-%m-%d_%H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        continue
    days_ago = (now_utc - dt).total_seconds() / 86400
    try:
        snap_data = json.loads(open(snap_path, encoding="utf-8").read())
        snap_counts = {p["pid"]: p["tiles"] for p in snap_data.get("players", [])}
    except Exception:
        continue
    # For each player not yet resolved, check if count differs from current
    for pid, cur_count in current_counts.items():
        if pid in last_change_days:
            continue  # already found their last change
        snap_count = snap_counts.get(pid)
        if snap_count is None:
            # Player didn't exist yet in this snapshot — count as change
            last_change_days[pid] = round(days_ago)
        elif snap_count != cur_count:
            # Count changed between this snapshot and a newer one
            last_change_days[pid] = round(days_ago)

# Players with no change found in all history: days since oldest snapshot
oldest_days = None
if all_snaps_sorted[1:]:
    oldest_snap = all_snaps_sorted[-1]
    ts_str = os.path.basename(oldest_snap)[5:-5]
    try:
        dt = datetime.strptime(ts_str, "%Y-%m-%d_%H%M").replace(tzinfo=timezone.utc)
        oldest_days = round((now_utc - dt).total_seconds() / 86400)
    except ValueError:
        pass

for pid in current_counts:
    if pid not in last_change_days:
        last_change_days[pid] = oldest_days  # unchanged since oldest snapshot

# Add last_change_days to player_list
for p in player_list:
    lcd = last_change_days.get(p["pid"])
    if lcd is not None:
        p["lcd"] = lcd  # days since last turf count change

print(f"  Done — {sum(1 for p in player_list if 'lcd' in p)} players with change data")

# ── HQ CAPTURE TRACKING ───────────────────────────────────────────────────────
# Scan all consecutive snapshot pairs to detect HQ ownership changes.
# This catches captures that happened between any two snapshots, not just the last two.
print("Computing HQ captures...")
HQ_CAPTURES_FILE = "hq_captures.json"
try:
    existing_captures = json.loads(open(HQ_CAPTURES_FILE, encoding="utf-8").read())
except Exception:
    existing_captures = []

# Build set of already-known capture keys to avoid duplicates
known_keys = {f"{c['oid']}_{c['timestamp']}" for c in existing_captures}

# Load all snapshots oldest-first that have a hq_register
snaps_with_hq = []
for snap_path in sorted(glob.glob(f"{SNAPSHOTS_DIR}/data_*.json")):
    basename = os.path.basename(snap_path)
    ts_str = basename[5:-5]
    try:
        dt = datetime.strptime(ts_str, "%Y-%m-%d_%H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        continue
    try:
        snap_data = json.loads(open(snap_path, encoding="utf-8").read())
        hq_reg = snap_data.get("hq_register", {})
        if hq_reg:
            snaps_with_hq.append((dt, hq_reg, {p["pid"]: p.get("name","") for p in snap_data.get("players",[])}))
    except Exception:
        continue

print(f"  Snapshots with hq_register: {len(snaps_with_hq)}")

# Also add current run as the latest entry
pid_to_name = {p["pid"]: p.get("name","") for p in player_list}
snaps_with_hq.append((now_utc, hq_register, pid_to_name))

# Compare each consecutive pair
new_captures = []
for i in range(1, len(snaps_with_hq)):
    dt_prev, reg_prev, names_prev = snaps_with_hq[i-1]
    dt_curr, reg_curr, names_curr = snaps_with_hq[i]
    ts_curr = dt_curr.isoformat()
    for oid, new_owner in reg_curr.items():
        prev_owner = reg_prev.get(oid)
        if prev_owner and prev_owner != new_owner:
            key = f"{oid}_{ts_curr}"
            if key not in known_keys:
                new_captures.append({
                    "oid":       oid,
                    "prev_pid":  prev_owner,
                    "prev_name": names_prev.get(prev_owner, ""),
                    "new_pid":   new_owner,
                    "new_name":  names_curr.get(new_owner, ""),
                    "timestamp": ts_curr,
                })
                known_keys.add(key)

if new_captures:
    print(f"  {len(new_captures)} new HQ captures detected!")
else:
    print(f"  No new HQ captures detected")

# Merge, sort by timestamp, keep last 500
all_captures = existing_captures + new_captures
all_captures.sort(key=lambda c: c["timestamp"])
all_captures = all_captures[-500:]

with open(HQ_CAPTURES_FILE, "w", encoding="utf-8") as f:
    json.dump(all_captures, f, separators=(",", ":"), ensure_ascii=False)
print(f"  hq_captures.json updated ({len(all_captures)} total captures)")

output_json = json.dumps(output, separators=(",", ":"), ensure_ascii=False)
size_kb = len(output_json) / 1024

# ── SAVE VERSIONED SNAPSHOT ───────────────────────────────────────────────────
os.makedirs(SNAPSHOTS_DIR, exist_ok=True)

timestamp = now_utc.strftime("%Y-%m-%d_%H%M")
snapshot_filename = f"{SNAPSHOTS_DIR}/data_{timestamp}.json"

with open(snapshot_filename, "w", encoding="utf-8") as f:
    f.write(output_json)
print(f"  Snapshot saved: {snapshot_filename} ({size_kb:.0f} KB)")

# Also write as current data.json for backward compatibility
with open("data.json", "w", encoding="utf-8") as f:
    f.write(output_json)
print(f"  data.json updated")

# ── PRUNE OLD SNAPSHOTS ───────────────────────────────────────────────────────
all_snapshots = sorted(glob.glob(f"{SNAPSHOTS_DIR}/data_*.json"))
if len(all_snapshots) > MAX_SNAPSHOTS:
    to_delete = all_snapshots[:len(all_snapshots) - MAX_SNAPSHOTS]
    for f in to_delete:
        os.remove(f)
        print(f"  Pruned old snapshot: {f}")

# ── UPDATE HISTORY.JSON ───────────────────────────────────────────────────────
all_snapshots = sorted(glob.glob(f"{SNAPSHOTS_DIR}/data_*.json"), reverse=True)

history_entries = []
for snap_path in all_snapshots:
    # Parse timestamp from filename: snapshots/data_YYYY-MM-DD_HH.json
    basename = os.path.basename(snap_path)  # data_YYYY-MM-DD_HH.json
    ts_str = basename[5:-5]                  # YYYY-MM-DD_HHMM
    try:
        dt = datetime.strptime(ts_str, "%Y-%m-%d_%H%M").replace(tzinfo=timezone.utc)
        history_entries.append({
            "file":      snap_path,
            "timestamp": dt.isoformat(),
            "label":     dt.strftime("%b %d, %H:%M UTC"),
        })
    except ValueError:
        continue

history = {
    "updated":   now_utc.isoformat(),
    "count":     len(history_entries),
    "snapshots": history_entries,
}

with open("history.json", "w", encoding="utf-8") as f:
    json.dump(history, f, separators=(",", ":"), ensure_ascii=False)

# ── PLAYER HISTORY.JSON ────────────────────────────────────────────────────────
# Compact tile-count per player per snapshot, for the history chart in the UI.
# Format: {"snapshots":["label",...], "players":{"pid":[count,...]}}
# Only players present in the current snapshot are included.
# Missing snapshots for a player are filled with null.
print("Computing player history...")

snap_labels = [e["label"] for e in history_entries]  # newest-first from history_entries
# Reverse to oldest-first for the chart
snap_paths_asc  = list(reversed([e["file"]  for e in history_entries]))
snap_labels_asc = list(reversed(snap_labels))

# Load all snapshots once, build pid→count per snapshot
snap_counts = []  # list of {pid: count} dicts, oldest-first
for path in snap_paths_asc:
    try:
        d = json.loads(open(path, encoding="utf-8").read())
        snap_counts.append({p["pid"]: p["tiles"] for p in d.get("players", [])})
    except Exception:
        snap_counts.append({})

# Only track pids in the current snapshot (player_list already built)
current_pids = {p["pid"] for p in player_list}

ph_players = {}
for pid in current_pids:
    series = [sc.get(pid, None) for sc in snap_counts]
    # Only include if there's at least 2 non-null values
    non_null = [v for v in series if v is not None]
    if len(non_null) >= 2:
        ph_players[pid] = series

player_history_out = {
    "updated":   now_utc.isoformat(),
    "snapshots": snap_labels_asc,
    "players":   ph_players,
}

with open("player_history.json", "w", encoding="utf-8") as f:
    json.dump(player_history_out, f, separators=(",", ":"), ensure_ascii=False)

ph_size = os.path.getsize("player_history.json") / 1024
print(f"  player_history.json written ({ph_size:.0f} KB, {len(ph_players)} players tracked)")

# ── DAILY HISTORY ─────────────────────────────────────────────────────────────
# Keeps one entry per day with tile counts per player.
# Grows indefinitely but stays compact (~5-10 KB/month).
# Format: {"days": [{"date": "YYYY-MM-DD", "players": {"pid": count}}, ...]}
DAILY_HISTORY_FILE = "player_history_daily.json"
today_str = now_utc.strftime("%Y-%m-%d")

try:
    daily = json.loads(open(DAILY_HISTORY_FILE, encoding="utf-8").read())
except Exception:
    daily = {"days": []}

# Build today's snapshot: {pid: tile_count} for all current players
today_counts = {p["pid"]: p["tiles"] for p in player_list}

# Replace or append today's entry
days = daily.get("days", [])
if days and days[-1]["date"] == today_str:
    days[-1]["players"] = today_counts  # update existing entry for today
else:
    days.append({"date": today_str, "players": today_counts})

daily = {"updated": now_utc.isoformat(), "days": days}

with open(DAILY_HISTORY_FILE, "w", encoding="utf-8") as f:
    json.dump(daily, f, separators=(",", ":"), ensure_ascii=False)

dh_size = os.path.getsize(DAILY_HISTORY_FILE) / 1024
print(f"  player_history_daily.json updated ({len(days)} days, {dh_size:.0f} KB)")

# ── RAID TRACKING ──────────────────────────────────────────────────────────────
# Fetches recent RaidBattleEvent events from the SUI blockchain.
# Keeps the last MAX_RAIDS entries in raids.json, deduplicated by tx digest.
print("Fetching raid events...")

RAIDS_FILE  = "raids.json"
MAX_RAIDS   = 500
# Exact event type addresses from on-chain inspection
RAID_EVENT_TYPES = [
    # Primary: RaidEvent — attacker/defender names, cash, weapon
    "0xe660c11d5cddf961e2f153e2e9c89517bdbb2dfa64b9d3aae711672aeb7f240d::game_events::RaidEvent",
    # XP source: SimulationResultEvent — has raided_resources {cash, weapon, xp}
    "0x63081c5dd824a49289b6557d9f9bcf8613fe801e89dbad728616348a58b4b40a::ibattle::SimulationResultEvent",
]

try:
    existing_raids = json.loads(open(RAIDS_FILE, encoding="utf-8").read())
except Exception:
    existing_raids = []

# Migration: discard any entry where cash or weapons > 1,000,000
# (these are pre-scaling sentinel values from a previous incorrect run)
existing_raids = [r for r in existing_raids if r.get("cash", 0) <= 1_000_000 and r.get("weapons", 0) <= 1_000_000]
# Strip existing failed-raid entries (no defender)
existing_raids = [r for r in existing_raids if r.get("defender_name") or r.get("defender_pid")]

known_digests = {r["digest"] for r in existing_raids if r.get("digest")}

# ── XP BACKFILL ──────────────────────────────────────────────────────────────
# For existing entries where xp=0, fetch the TX events directly to retrieve XP
# from SimulationResultEvent (which has raided_resources.xp).
RAID_SEARCH_TYPE = "0x63081c5dd824a49289b6557d9f9bcf8613fe801e89dbad728616348a58b4b40a::ibattle::SimulationResultEvent"
SCALE = 18446744073709551616  # 2^64

needs_xp = [r for r in existing_raids if r.get("xp", 0) == 0 and r.get("digest")]
if needs_xp:
    print(f"  Backfilling XP for {len(needs_xp)} entries...")
    backfilled = 0
    for r in needs_xp:
        try:
            tx = rpc("sui_getTransactionBlock", [r["digest"], {"showEvents": True}])
            for ev in (tx.get("events") or []):
                if ev.get("type") == RAID_SEARCH_TYPE:
                    parsed = ev.get("parsedJson") or {}
                    res    = parsed.get("raided_resources") or {}
                    raw_xp = int(res.get("xp", 0) or 0)
                    if raw_xp > 0:
                        r["xp"] = raw_xp / SCALE
                        backfilled += 1
                    break
            time.sleep(DELAY)
        except Exception as e:
            print(f"    Warning: backfill failed for {r['digest'][:16]}: {e}")
            continue
    print(f"  XP backfilled for {backfilled} entries")

def parse_raid_event(ev):
    """Extract raid fields from a raw SUI event dict."""
    parsed = ev.get("parsedJson") or ev.get("parsed_json") or {}
    tx     = ev.get("id", {}).get("txDigest") or ev.get("txDigest") or ""
    ts_ms  = ev.get("timestampMs") or ev.get("timestamp_ms") or parsed.get("timestamp")
    if ts_ms:
        ts = datetime.fromtimestamp(int(ts_ms)/1000, tz=timezone.utc).isoformat()
    else:
        ts = now_utc.isoformat()

    # Values are stored as fixed-point integers scaled by 2^64
    res = parsed.get("raided_resources") or {}
    raw_cash   = int(parsed.get("raided_cash",   res.get("cash",   0)) or 0)
    raw_weapon = int(parsed.get("raided_weapon", res.get("weapon", 0)) or 0)
    raw_xp     = int(res.get("xp", 0) or 0)

    cash    = raw_cash   / SCALE
    weapons = raw_weapon / SCALE
    xp      = raw_xp     / SCALE

    # Name fields differ between event types
    attacker_name = parsed.get("attacker_name") or parsed.get("attacker_player_name") or ""
    defender_name = parsed.get("defender_name") or parsed.get("defender_player_name") or ""

    return {
        "digest":         tx,
        "attacker_pid":   parsed.get("attacker_id")  or "",
        "attacker_name":  attacker_name,
        "defender_pid":   parsed.get("defender_id")  or "",
        "defender_name":  defender_name,
        "cash":           cash,
        "weapons":        weapons,
        "xp":             xp,
        "timestamp":      ts,
    }

new_raids = []

# Fetch all event types and merge results.
# RaidEvent has cash/weapon; SimulationResultEvent has the same tx but also XP.
# We merge by tx digest so the final entry has all three values.
new_raids_by_digest = {}

for event_type in RAID_EVENT_TYPES:
    cursor = None
    pages  = 0
    found  = 0
    try:
        while pages < 10:  # max 10 pages × 50 = 500 events
            params = [
                {"MoveEventType": event_type},
                cursor,
                50,
                True,  # descending — newest first
            ]
            result = rpc("suix_queryEvents", params)
            events = result.get("data", [])
            if not events and pages == 0:
                break  # event type not found, skip

            for ev in events:
                r = parse_raid_event(ev)
                if not r["digest"]:
                    continue
                # Skip failed raids / free turf attacks (no defender)
                if not r.get("defender_name") and not r.get("defender_pid"):
                    continue
                if r["digest"] in known_digests:
                    # Already stored — but merge XP if we have it now
                    if r["xp"] > 0:
                        for existing in existing_raids:
                            if existing["digest"] == r["digest"] and existing.get("xp", 0) == 0:
                                existing["xp"] = r["xp"]
                    continue
                if r["digest"] in new_raids_by_digest:
                    # Merge: keep highest xp/cash/weapon across event types
                    ex = new_raids_by_digest[r["digest"]]
                    ex["cash"]    = max(ex["cash"],    r["cash"])
                    ex["weapons"] = max(ex["weapons"], r["weapons"])
                    ex["xp"]      = max(ex["xp"],      r["xp"])
                else:
                    new_raids_by_digest[r["digest"]] = r
                    found += 1

            pages += 1
            if not result.get("hasNextPage"):
                break
            cursor = result.get("nextCursor")
            time.sleep(DELAY)

        print(f"  {event_type.split('::')[-1]}: {pages} page(s), {found} new")

    except Exception as e:
        print(f"  Warning: {event_type.split('::')[-1]} failed: {e}")
        continue

new_raids = list(new_raids_by_digest.values())

if not new_raids and not any(r.get("xp", 0) > 0 for r in existing_raids):
    print("  No new raid events found")
else:
    all_raids = existing_raids + new_raids
    all_raids.sort(key=lambda r: r["timestamp"])
    all_raids = all_raids[-MAX_RAIDS:]
    with open(RAIDS_FILE, "w", encoding="utf-8") as f:
        json.dump(all_raids, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  raids.json updated ({len(all_raids)} total, {len(new_raids)} new)")
print(f"  Players:   {len(player_list)}")
print(f"  Tiles:     {len(compact_tiles)}")
print(f"  Size:      {size_kb:.0f} KB")
print(f"  Snapshots: {len(history_entries)} stored (max {MAX_SNAPSHOTS})")

# ── PLAYER ACTIVITY TRACKING ──────────────────────────────────────────────────
# Fetches FeedPeopleEvent and ClaimResourcesEvent to detect active players
# who haven't changed turf count but are still playing.
# Writes player_activity.json: {pid: days_since_last_active}
print("Fetching player activity events...")

ACTIVITY_FILE = "player_activity.json"
ACTIVITY_EVENT_TYPES = [
    "0xe660c11d5cddf961e2f153e2e9c89517bdbb2dfa64b9d3aae711672aeb7f240d::game_events::FeedPeopleEvent",
    "0xe660c11d5cddf961e2f153e2e9c89517bdbb2dfa64b9d3aae711672aeb7f240d::game_events::ClaimResourcesEvent",
]

from datetime import timedelta

try:
    existing_activity = json.loads(open(ACTIVITY_FILE, encoding="utf-8").read()).get("raw", {})
except Exception:
    existing_activity = {}

# Scan events from last 30 days (newest first), track latest activity per player
ACTIVITY_CUTOFF = now_utc - timedelta(days=30)
latest_activity = dict(existing_activity)

for event_type in ACTIVITY_EVENT_TYPES:
    etype_short = event_type.split("::")[-1]
    cursor = None
    pages  = 0
    found  = 0
    stop   = False
    try:
        while pages < 20 and not stop:
            params = [{"MoveEventType": event_type}, cursor, 50, True]
            result = rpc("suix_queryEvents", params)
            events = result.get("data", [])
            if not events and pages == 0:
                print(f"  {etype_short}: no events found")
                break
            for ev in events:
                ts_ms = ev.get("timestampMs") or ev.get("timestamp_ms")
                if not ts_ms:
                    continue
                ev_dt = datetime.fromtimestamp(int(ts_ms)/1000, tz=timezone.utc)
                if ev_dt < ACTIVITY_CUTOFF:
                    stop = True
                    break
                parsed = ev.get("parsedJson") or {}
                pid = parsed.get("player_id") or ""
                if not pid:
                    continue
                ts_iso = ev_dt.isoformat()
                if pid not in latest_activity or ts_iso > latest_activity[pid]:
                    latest_activity[pid] = ts_iso
                    found += 1
            pages += 1
            if not result.get("hasNextPage"):
                break
            cursor = result.get("nextCursor")
            time.sleep(DELAY)
        print(f"  {etype_short}: {pages} page(s), {found} updates")
    except Exception as e:
        print(f"  Warning: {etype_short} failed: {e}")
        continue

# Convert to days_since_last_active for current players only
activity_days = {}
for p in player_list:
    pid = p["pid"]
    ts = latest_activity.get(pid)
    if ts:
        try:
            dt = datetime.fromisoformat(ts)
            activity_days[pid] = round((now_utc - dt).total_seconds() / 86400, 1)
        except Exception:
            pass

with open(ACTIVITY_FILE, "w", encoding="utf-8") as f:
    json.dump({
        "updated": now_utc.isoformat(),
        "raw":     latest_activity,
        "days":    activity_days,
    }, f, separators=(",", ":"), ensure_ascii=False)

print(f"  player_activity.json updated ({len(activity_days)} players with activity data)")

print(f"\nDone!")
