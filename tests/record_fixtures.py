#!/usr/bin/env python3
"""
Record a small, self-consistent slice of the live chain for the offline tests.

Run by hand (needs network, ~100 calls); the tests never touch the network:

    python tests/record_fixtures.py

Writes tests/fixtures/world.json: 60 players (registry order), every turf they own,
their cash/weapon field objects, the newest events of every type fetch_data.py reads
and the transactions behind the HQ-destroyed events. tests/fake_graphql.py serves it
with the same GraphQL semantics as the real endpoint.
"""

import json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import sui_graphql as sg

N_PLAYERS = 60
GAME_EV = "0xe660c11d5cddf961e2f153e2e9c89517bdbb2dfa64b9d3aae711672aeb7f240d::game_events::"
SIM_EVENT = "0x63081c5dd824a49289b6557d9f9bcf8613fe801e89dbad728616348a58b4b40a::ibattle::SimulationResultEvent"
EVENT_TYPES = {                     # type -> how many of the newest to keep
    GAME_EV + "RaidEvent": 30,
    SIM_EVENT: 8,                   # carries whole battle logs; keep it small
    GAME_EV + "CaptureEvent": 30,
    GAME_EV + "HeadquarterDestroyedEvent": 10,
    GAME_EV + "FeedPeopleEvent": 30,
    GAME_EV + "ClaimResourcesEvent": 30,
    GAME_EV + "MissionEvent": 30,
    GAME_EV + "BlackmailEvent": 30,
    GAME_EV + "CrackSafeEvent": 30,
    GAME_EV + "HireScoutsEvent": 30,
}

TURF_SYSTEM = "0x372e8fd0e12d2051860553b9e61065729dcddec11970b295bbcf19d7261cc502"
PLAYERS_REGISTRY = "0x84a4a83842e92d8091563ae7a033797ad5182baca84de9f89573cb5b3722b494"

_Q_RAW_EVENTS = ("query Ev($t:String!,$n:Int!){events(last:$n,filter:{type:$t}){nodes{timestamp "
                 "transaction{digest} contents{type{repr} json}}}}")


def main():
    world = {"objects": {}, "fields": {}, "field_lookup": {}, "events": {}, "tx_events": {}}
    objs = world["objects"]

    reg = sg.get_object(PLAYERS_REGISTRY)
    objs[PLAYERS_REGISTRY] = reg
    ts = sg.get_object(TURF_SYSTEM)
    objs[TURF_SYSTEM] = ts
    tv_id = reg["json"]["players"]["contents"]["id"]
    table_id = ts["json"]["coordinates_turfs"]["id"]

    entries, cursor = [], None
    while len(entries) < N_PLAYERS:
        items, has_next, cursor = sg.dynamic_fields_page(tv_id, cursor)
        entries += items
        if not has_next:
            break
    entries = entries[:N_PLAYERS]
    world["fields"][tv_id] = entries
    pids = [e["value"] for e in entries]

    tile_ids = []
    for i in range(0, len(pids), 50):
        for o in sg.multi_get(pids[i:i + 50]):
            objs[o["address"]] = o
            tile_ids += o["json"].get("owned_location") or []
            if o["json"].get("headquarter_tile"):
                tile_ids.append(o["json"]["headquarter_tile"])
    tile_ids = list(dict.fromkeys(tile_ids))

    turf_entries = []
    for i in range(0, len(tile_ids), 50):
        for o in sg.multi_get(tile_ids[i:i + 50], with_type=False):
            if not o or not o["json"]:
                print(f"  skipping tile without json: {o and o['address']}")
                continue
            objs[o["address"]] = {"address": o["address"], "type": "", "json": o["json"]}
            j = o["json"]
            turf_entries.append({
                "name_type": "0xa0c4bb412c1d6121c1b6a40954ef76c3b1f75248211209e94726496f46a59ce0::iturf::Coordinates",
                "name": {"x": j["x"], "x_neg": j["x_neg"], "y": j["y"], "y_neg": j["y_neg"]},
                "value": o["address"],
            })
    world["fields"][table_id] = turf_entries

    for pid in pids:
        ids = sg.resource_field_ids(pid)
        world["field_lookup"][pid] = ids
        for fid in ids.values():
            o = sg.multi_get([fid], with_type=False)[0]
            if o:
                objs[o["address"]] = {"address": o["address"], "type": "", "json": o["json"]}

    for etype, keep in EVENT_TYPES.items():
        data = sg.gql(_Q_RAW_EVENTS, {"t": etype, "n": keep}).get("events") or {"nodes": []}
        world["events"][etype] = [{
            "timestamp": n["timestamp"], "digest": n["transaction"]["digest"],
            "type": n["contents"]["type"]["repr"], "json": n["contents"]["json"],
        } for n in data["nodes"]]            # oldest first, as GraphQL returns a `last` page
        print(f"  {etype.split('::')[-1]}: {len(world['events'][etype])} events")

    # Transactions needed by the HQ-destroyed capture check, plus the newest raids
    # (the XP/capture backfill reads those).
    digests = [e["digest"] for e in world["events"][GAME_EV + "HeadquarterDestroyedEvent"]]
    digests += [e["digest"] for e in world["events"][GAME_EV + "RaidEvent"][-6:]]
    for d in dict.fromkeys(digests):
        world["tx_events"][d] = [{"type": e["type"], "parsedJson": e["parsedJson"]} for e in sg.tx_events(d)]

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "world.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(world, fh, separators=(",", ":"), ensure_ascii=False)
    print(f"wrote {out} ({os.path.getsize(out) / 1024:.0f} KB): {len(pids)} players, "
          f"{len(tile_ids)} tiles, {len(world['tx_events'])} transactions")


if __name__ == "__main__":
    main()
