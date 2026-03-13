#!/usr/bin/env python3
"""
SUI Turf Map — data fetcher
Reads all tiles and player profiles from the SUI blockchain
and writes a compact data.json for the map HTML to load.
"""

import json, time, sys, urllib.request, urllib.error
from datetime import datetime, timezone

# ── CONSTANTS ──────────────────────────────────────────────────────────────────
TURF_SYSTEM      = "0x372e8fd0e12d2051860553b9e61065729dcddec11970b295bbcf19d7261cc502"
PLAYERS_REGISTRY = "0x84a4a83842e92d8091563ae7a033797ad5182baca84de9f89573cb5b3722b494"
NULL_ID          = "0x" + "0" * 64

RPC_ENDPOINTS = [
    "https://fullnode.mainnet.sui.io:443",
    "https://mainnet.suiet.app",
    "https://sui-rpc.publicnode.com",
    "https://sui-mainnet.blockvision.org/v1/",
]

BATCH = 50
DELAY = 0.06   # seconds between batches
DELAY_PAGE = 0.15  # seconds between pagination pages

# ── RPC HELPER ─────────────────────────────────────────────────────────────────
rpc_index = 0

def rpc(method, params, retries=3):
    global rpc_index
    for attempt in range(retries):
        url = RPC_ENDPOINTS[rpc_index % len(RPC_ENDPOINTS)]
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
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
            if attempt == retries - 1:
                raise
            time.sleep(1)
        except Exception as e:
            rpc_index += 1
            if attempt == retries - 1:
                raise
            time.sleep(1)

def signed(v, neg):
    v = int(v)
    if neg is True or neg == "true":
        return -abs(v)
    return v

def find_id(obj):
    """Recursively find a 0x... address in a nested dict."""
    if isinstance(obj, str) and obj.startswith("0x") and len(obj) == 66:
        return obj
    if isinstance(obj, dict):
        if "id" in obj:
            result = find_id(obj["id"])
            if result:
                return result
        for v in obj.values():
            result = find_id(v)
            if result:
                return result
    return None

# ── STEP 1: PlayersRegistry → profile IDs ─────────────────────────────────────
print("Step 1/4: Loading PlayersRegistry...")
reg = rpc("sui_getObject", [PLAYERS_REGISTRY, {"showContent": True}])
reg_fields = reg["data"]["content"]["fields"]
tv = reg_fields["players"]
tv_id = find_id(tv)
if not tv_id:
    print("ERROR: TableVec ID not found")
    sys.exit(1)
print(f"  TableVec ID: {tv_id}")

wrap_ids = []
cursor = None
page = 0
while True:
    res = rpc("suix_getDynamicFields", [tv_id, cursor, 50])
    for item in res["data"]:
        if item.get("objectId"):
            wrap_ids.append(item["objectId"])
    page += 1
    if page % 20 == 0:
        print(f"  Page {page}: {len(wrap_ids)} wrappers")
    if not res["hasNextPage"]:
        break
    cursor = res["nextCursor"]
    time.sleep(DELAY_PAGE)

print(f"  Registry done: {len(wrap_ids)} wrappers")

# Resolve wrapper objects → real profile IDs
real_pids = []
for i in range(0, len(wrap_ids), BATCH):
    batch = wrap_ids[i:i+BATCH]
    objs = rpc("sui_multiGetObjects", [batch, {"showContent": True, "showType": True}])
    if not isinstance(objs, list):
        continue
    for obj in objs:
        if not obj or obj.get("error"):
            continue
        obj_type = (obj.get("data") or {}).get("type", "")
        if "Player" in obj_type:
            real_pids.append(obj["data"]["objectId"])
            continue
        val = ((obj.get("data") or {}).get("content") or {}).get("fields", {}).get("value")
        if isinstance(val, str) and val.startswith("0x"):
            real_pids.append(val)
        elif isinstance(val, dict):
            pid = find_id(val)
            if pid:
                real_pids.append(pid)
    if i % 2000 == 0 and i > 0:
        print(f"  {i}/{len(wrap_ids)} wrappers resolved → {len(real_pids)} profile IDs")
    time.sleep(DELAY)

if not real_pids:
    print("  Fallback: using wrapper IDs directly as profile IDs")
    real_pids = wrap_ids

print(f"  Profile IDs: {len(real_pids)}")

# ── STEP 2: Player objects → name + wallet ─────────────────────────────────────
print("Step 2/4: Loading player profiles...")
profiles = {}  # pid → {name, wallet, isInactive, hqTile}

for i in range(0, len(real_pids), BATCH):
    batch = real_pids[i:i+BATCH]
    objs = rpc("sui_multiGetObjects", [batch, {"showContent": True, "showType": True}])
    if not isinstance(objs, list):
        continue
    for obj in objs:
        if not obj or obj.get("error"):
            continue
        obj_type = (obj.get("data") or {}).get("type", "")
        if "Player" not in obj_type:
            continue
        f = ((obj.get("data") or {}).get("content") or {}).get("fields")
        if not f:
            continue
        pid = obj["data"]["objectId"]
        profiles[pid] = {
            "name":       f.get("player_name", ""),
            "wallet":     f.get("player_address", ""),
            "isInactive": f.get("is_inactive") in (True, "true"),
            "hqTile":     f.get("headquarter_tile"),
        }
    if i % 2000 == 0 and i > 0:
        print(f"  {i}/{len(real_pids)} profiles loaded")
    time.sleep(DELAY)

named = sum(1 for p in profiles.values() if p["name"])
print(f"  Profiles: {len(profiles)} ({named} with name)")

hq_set = {p["hqTile"] for p in profiles.values() if p.get("hqTile")}

# ── STEP 3: TurfSystem → tile IDs ─────────────────────────────────────────────
print("Step 3/4: Loading TurfSystem...")
ts = rpc("sui_getObject", [TURF_SYSTEM, {"showContent": True}])
ts_fields = ts["data"]["content"]["fields"]
cf = ts_fields.get("coordinates_turfs", {})
turf_table_id = find_id(cf)
if not turf_table_id:
    print("ERROR: TurfSystem Table ID not found")
    sys.exit(1)
print(f"  Table ID: {turf_table_id}")

dyn_ids = []
cursor = None
page = 0
while True:
    res = rpc("suix_getDynamicFields", [turf_table_id, cursor, 50])
    for item in res["data"]:
        if item.get("objectId"):
            dyn_ids.append(item["objectId"])
    page += 1
    if page % 20 == 0:
        print(f"  Page {page}: {len(dyn_ids)} tile entries")
    if not res["hasNextPage"]:
        break
    cursor = res["nextCursor"]
    time.sleep(DELAY_PAGE)

print(f"  TurfSystem done: {len(dyn_ids)} entries")

# Resolve wrapper objects → real tile IDs
tile_ids = []
for i in range(0, len(dyn_ids), BATCH):
    batch = dyn_ids[i:i+BATCH]
    objs = rpc("sui_multiGetObjects", [batch, {"showContent": True}])
    if not isinstance(objs, list):
        continue
    for obj in objs:
        if not obj or obj.get("error"):
            continue
        val = ((obj.get("data") or {}).get("content") or {}).get("fields", {}).get("value")
        if isinstance(val, str) and val.startswith("0x"):
            tile_ids.append(val)
        elif isinstance(val, dict):
            tid = find_id(val)
            if tid:
                tile_ids.append(tid)
    if i % 2000 == 0 and i > 0:
        print(f"  {i}/{len(dyn_ids)} entries resolved → {len(tile_ids)} tile IDs")
    time.sleep(DELAY)

print(f"  Tile IDs: {len(tile_ids)}")

# ── STEP 4: Tile objects → coordinates + owner ─────────────────────────────────
print("Step 4/4: Loading tile data...")
owner_count = {}  # pid → tile count
raw_tiles = []    # [{x, y, pid, isHQ}]
unclaimed = 0

for i in range(0, len(tile_ids), BATCH):
    batch = tile_ids[i:i+BATCH]
    objs = rpc("sui_multiGetObjects", [batch, {"showContent": True}])
    if not isinstance(objs, list):
        time.sleep(0.5)
        continue
    for obj in objs:
        if not obj or obj.get("error"):
            continue
        f = ((obj.get("data") or {}).get("content") or {}).get("fields")
        if not f:
            continue
        x = signed(f.get("x", 0), f.get("x_neg", False))
        y = signed(f.get("y", 0), f.get("y_neg", False))
        pid = f.get("owner_id")
        tile_id = obj["data"]["objectId"]
        if not pid or pid == NULL_ID:
            unclaimed += 1
            continue
        is_hq = tile_id in hq_set
        raw_tiles.append({"x": x, "y": y, "pid": pid, "hq": is_hq})
        owner_count[pid] = owner_count.get(pid, 0) + 1
    if i % 2000 == 0 and i > 0:
        print(f"  {i}/{len(tile_ids)} tiles → {len(owner_count)} players")
    time.sleep(DELAY)

print(f"  Tiles: {len(raw_tiles)} occupied, {unclaimed} unclaimed")

# ── BUILD OUTPUT ───────────────────────────────────────────────────────────────
print("Building output...")

# Assign color per player
def pid_color(pid):
    h = 0
    for c in pid:
        h = (h * 31 + ord(c)) & 0xFFFFFFFF
    hue = (h % 300) + 30
    return f"hsl({hue},60%,45%)"

MY_IDS = {
    "0x857e8e7fc94d43f327bb24388439d0fdcc112a9e5e25264969b27011a233d2f0",
    "0xdb2b57ea07dae7acd91d56f4c5e20a077313abb50a9924f84529ef67030ab273",
}

# Build player list sorted by tile count
player_list = []
pid_to_index = {}
for pid, count in sorted(owner_count.items(), key=lambda x: -x[1]):
    p = profiles.get(pid, {})
    is_me = pid in MY_IDS
    color = "#7F77DD" if is_me else pid_color(pid)
    idx = len(player_list)
    pid_to_index[pid] = idx
    player_list.append({
        "pid":        pid,
        "name":       p.get("name", ""),
        "wallet":     p.get("wallet", ""),
        "inactive":   p.get("isInactive", False),
        "tiles":      count,
        "me":         is_me,
        "color":      color,
    })

# Compact tile format: use player index instead of full pid
compact_tiles = []
for t in raw_tiles:
    idx = pid_to_index.get(t["pid"])
    if idx is None:
        continue
    entry = {"x": t["x"], "y": t["y"], "p": idx}
    if t["hq"]:
        entry["hq"] = True
    compact_tiles.append(entry)

output = {
    "generated":   datetime.now(timezone.utc).isoformat(),
    "total_tiles": len(tile_ids),
    "unclaimed":   unclaimed,
    "players":     player_list,
    "tiles":       compact_tiles,
}

with open("data.json", "w", encoding="utf-8") as f:
    json.dump(output, f, separators=(",", ":"), ensure_ascii=False)

size_kb = len(json.dumps(output, separators=(",", ":"))) / 1024
print(f"\nDone!")
print(f"  Players: {len(player_list)}")
print(f"  Tiles:   {len(compact_tiles)}")
print(f"  Size:    {size_kb:.0f} KB")
print(f"  Written: data.json")
