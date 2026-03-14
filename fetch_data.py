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
DELAY      = 0.06
DELAY_PAGE = 0.15

# ── RPC ────────────────────────────────────────────────────────────────────────
rpc_index = 0

def rpc(method, params, retries=3):
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
            if e.code == 429:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            rpc_index += 1
            if attempt == retries - 1: raise
            time.sleep(1)
        except Exception:
            rpc_index += 1
            if attempt == retries - 1: raise
            time.sleep(1)

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
        raw_tiles.append({"x": x, "y": y, "pid": pid, "hq": tile_id in hq_set})
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
    compact_tiles.append(entry)

now_utc = datetime.now(timezone.utc)
output = {
    "generated":   now_utc.isoformat(),
    "total_tiles": len(tile_ids),
    "unclaimed":   unclaimed,
    "players":     player_list,
    "tiles":       compact_tiles,
}

output_json = json.dumps(output, separators=(",", ":"), ensure_ascii=False)
size_kb = len(output_json) / 1024

# ── SAVE VERSIONED SNAPSHOT ───────────────────────────────────────────────────
os.makedirs(SNAPSHOTS_DIR, exist_ok=True)

timestamp = now_utc.strftime("%Y-%m-%d_%H")
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
    ts_str = basename[5:-5]                  # YYYY-MM-DD_HH
    try:
        dt = datetime.strptime(ts_str, "%Y-%m-%d_%H").replace(tzinfo=timezone.utc)
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
