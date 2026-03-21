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

MY_IDS = {
    "0x857e8e7fc94d43f327bb24388439d0fdcc112a9e5e25264969b27011a233d2f0",
    "0xdb2b57ea07dae7acd91d56f4c5e20a077313abb50a9924f84529ef67030ab273",
}

def pid_color(pid):
    h = 0
    for c in pid: h = (h * 31 + ord(c)) & 0xFFFFFFFF
    return f"hsl({(h % 300) + 30},60%,45%)"

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
        "color":   "#7F77DD" if is_me else pid_color(pid),
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

print(f"\nDone!")
print(f"  Players:   {len(player_list)}")
print(f"  Tiles:     {len(compact_tiles)}")
print(f"  Size:      {size_kb:.0f} KB")
print(f"  Snapshots: {len(history_entries)} stored (max {MAX_SNAPSHOTS})")
