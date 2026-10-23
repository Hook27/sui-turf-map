"""
End-to-end tests: run the real fetch_data.py against the offline fake chain and check
every output against values computed independently from the recorded fixtures.
This is what guards the flat-GraphQL-json parsers (VecMap contents, garrison, cash and
weapon amounts, profiles, event fields).   Run: python -m unittest discover -s tests
"""

import contextlib, copy, io, json, os, runpy, sys, tempfile, unittest, urllib.error, warnings
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, REPO)
sys.path.insert(0, HERE)

import sui_graphql as sg
from fake_graphql import FakeChain, load_world

SCALE = 2 ** 64
NULL_ID = "0x" + "0" * 64
GAME_EV = "0xe660c11d5cddf961e2f153e2e9c89517bdbb2dfa64b9d3aae711672aeb7f240d::game_events::"
SIM_EV = "0x63081c5dd824a49289b6557d9f9bcf8613fe801e89dbad728616348a58b4b40a::ibattle::SimulationResultEvent"
CAPTURE = GAME_EV + "CaptureEvent"
HQD = GAME_EV + "HeadquarterDestroyedEvent"


def run_fetch(world, files=None, fail=None):
    """Run fetch_data.py in a fresh temp dir. Returns (dir, stdout, exit_code, chain)."""
    sg.rpc_index = 0
    sg._call_no = 0
    sg._ep_pause_until.clear()
    sg._ep_pause_len.clear()
    chain = FakeChain(world, fail=fail)
    d = tempfile.mkdtemp(prefix="vwm_e2e_")
    for name, content in (files or {}).items():
        with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
            json.dump(content, fh)
    out, code, cwd = io.StringIO(), 0, os.getcwd()
    warnings.simplefilter("ignore", ResourceWarning)    # fetch_data.py reads a few files with bare open()
    os.chdir(d)
    try:
        with mock.patch.object(sg, "_http_post", chain.post), mock.patch.object(sg, "sleep", lambda s: None), \
                mock.patch("time.sleep", lambda s: None), contextlib.redirect_stdout(out):
            try:
                runpy.run_path(os.path.join(REPO, "fetch_data.py"), run_name="__main__")
            except SystemExit as e:
                code = e.code or 0
    finally:
        os.chdir(cwd)
    return d, out.getvalue(), code, chain


def load(d, name):
    with open(os.path.join(d, name), encoding="utf-8") as fh:
        return json.load(fh)


def vm(raw):
    return {e["key"]: int(e["value"]) for e in (raw or {}).get("contents", [])}


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class Expected:
    """Expected output computed straight from the fixture, independently of fetch_data.py."""

    def __init__(self, world):
        self.w = world
        objs = world["objects"]
        self.profiles = {a: o["json"] for a, o in objs.items() if o["type"].endswith("::iplayer::Player")}
        self.tiles = {a: o["json"] for a, o in objs.items()
                      if o["json"] and "owner_id" in o["json"] and "garrison" in o["json"]}
        self.owned = {a: j for a, j in self.tiles.items() if j["owner_id"] not in (None, NULL_ID)}

    def amount(self, pid, which):
        fid = self.w["field_lookup"][pid].get(which)
        if not fid or fid not in self.w["objects"]:
            return None
        return round(int(self.w["objects"][fid]["json"]["value"]["amount"]) / SCALE, 2)


class FetchBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.world0 = load_world()
        cls.exp = Expected(cls.world0)

    def world(self):
        return copy.deepcopy(self.world0)


class TestFreshRun(FetchBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.dir, cls.stdout, cls.code, cls.chain = run_fetch(cls.world0)
        cls.data = load(cls.dir, "data.json")

    def test_exits_cleanly_without_warnings(self):
        self.assertEqual(self.code, 0)
        self.assertIn("Done!", self.stdout)
        self.assertNotIn("::warning", self.stdout)

    def test_tiles_match_the_chain(self):
        tiles = self.data["tiles"]
        self.assertEqual(self.data["total_tiles"], len(self.exp.owned))
        self.assertEqual(len(tiles), len(self.exp.owned))
        by_oid = {t["oid"]: t for t in tiles}
        self.assertEqual(set(by_oid), set(self.exp.owned))
        pids = [p["pid"] for p in self.data["players"]]
        for oid, j in self.exp.owned.items():
            t = by_oid[oid]
            sign = lambda v, neg: -int(v) if neg else int(v)
            self.assertEqual((t["x"], t["y"]), (sign(j["x"], j["x_neg"]), sign(j["y"], j["y_neg"])))
            self.assertEqual(pids[t["p"]], j["owner_id"])
            g = {k.lower(): int(v) for k, v in vm(j["garrison"]).items()}
            self.assertEqual(t.get("g_h", 0), g.get("henchman", 0))
            self.assertEqual(t.get("g_b", 0), g.get("bouncer", 0))
            self.assertEqual(t.get("g_e", 0), g.get("enforcer", 0))
            hq = self.exp.profiles.get(j["owner_id"], {}).get("headquarter_tile") == oid
            self.assertEqual(bool(t.get("hq")), hq)

    def test_garrisons_are_not_all_empty(self):          # guards "flat parse silently gives 0"
        self.assertTrue(any(t.get("g_h") or t.get("g_b") or t.get("g_e") for t in self.data["tiles"]))

    def test_players_match_profiles_and_balances(self):
        owner_tiles = {}
        for j in self.exp.owned.values():
            owner_tiles[j["owner_id"]] = owner_tiles.get(j["owner_id"], 0) + 1
        got = {p["pid"]: p for p in self.data["players"]}
        self.assertEqual(set(got), set(owner_tiles))
        self.assertTrue(any(p["cash"] > 0 for p in got.values()))
        for pid, p in got.items():
            prof = self.exp.profiles[pid]
            self.assertEqual(p["name"], prof["player_name"])
            self.assertEqual(p["wallet"], prof["player_address"])
            self.assertEqual(p["inactive"], bool(prof["is_inactive"]))
            self.assertEqual(p["tiles"], owner_tiles[pid])
            self.assertEqual(p["feed"], vm(prof["timers"]).get("feed_people", 0))
            self.assertEqual(p["boost"], vm(prof["perks"]).get("boost_production", 0))
            self.assertEqual(p["cash"], self.exp.amount(pid, "cash") or 0)
            self.assertEqual(p["weapons"], self.exp.amount(pid, "weapon") or 0)

    def test_field_cache_holds_the_derived_field_ids(self):
        cache = load(self.dir, "field_cache.json")["resource_fields"]
        self.assertEqual(cache, {p: v for p, v in self.world0["field_lookup"].items() if p in self.exp.profiles})

    def test_raids_cross_checked_against_events(self):
        raids = {r["digest"]: r for r in load(self.dir, "raids.json")}
        raid_events = [e for e in self.world0["events"][GAME_EV + "RaidEvent"]
                       if e["json"].get("defender_id") or e["json"].get("defender_name")]
        self.assertTrue(raid_events)
        for e in raid_events:
            r = raids[e["digest"]]
            self.assertEqual(r["attacker_pid"], e["json"]["attacker_id"])
            self.assertEqual(r["defender_name"], e["json"]["defender_name"])
            self.assertEqual(r["cash"], int(e["json"]["raided_cash"]) / SCALE)
            self.assertEqual(r["weapons"], int(e["json"]["raided_weapon"]) / SCALE)
            self.assertEqual(parse_ts(r["timestamp"]), parse_ts(e["timestamp"]))
        captures = {e["digest"] for e in self.world0["events"][CAPTURE]}
        for dg, r in raids.items():
            self.assertEqual(r["is_capture"], dg in captures)

    def test_raid_xp_comes_from_simulation_events(self):
        raids = {r["digest"]: r for r in load(self.dir, "raids.json")}
        with_xp = [e for e in self.world0["events"][SIM_EV]
                   if int((e["json"].get("raided_resources") or {}).get("xp", 0) or 0) > 0 and e["digest"] in raids]
        for e in with_xp:
            self.assertEqual(raids[e["digest"]]["xp"], int(e["json"]["raided_resources"]["xp"]) / SCALE)

    def test_plain_captures_are_stored_separately(self):
        raid_digests = {r["digest"] for r in load(self.dir, "raids.json")}
        ota = {r["digest"]: r for r in load(self.dir, "owned_turf_attacks.json")}
        for e in self.world0["events"][CAPTURE]:
            if e["digest"] in raid_digests:
                self.assertNotIn(e["digest"], ota)
            else:
                self.assertEqual(ota[e["digest"]]["turf_id"], e["json"].get("turf_id") or "")
                self.assertEqual(ota[e["digest"]]["attacker_pid"], e["json"].get("attacker_id") or "")

    def test_activity_matches_latest_events(self):
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        pid_field = {"BlackmailEvent": "blackmailer"}
        want = {}
        for et in ("FeedPeopleEvent", "ClaimResourcesEvent", "MissionEvent", "BlackmailEvent",
                   "CrackSafeEvent", "HireScoutsEvent"):
            for e in self.world0["events"][GAME_EV + et]:
                ts = parse_ts(e["timestamp"])
                pid = e["json"].get(pid_field.get(et, "player_id"))
                if ts >= cutoff and pid and (pid not in want or ts > want[pid]):
                    want[pid] = ts
        for r in load(self.dir, "raids.json"):
            ts = parse_ts(r["timestamp"])
            if r["attacker_pid"] and (r["attacker_pid"] not in want or ts > want[r["attacker_pid"]]):
                want[r["attacker_pid"]] = ts
        raw = load(self.dir, "player_activity.json")["raw"]
        self.assertTrue(want)
        self.assertEqual({k: parse_ts(v) for k, v in raw.items()}, want)

    def test_hq_captures_are_remembered(self):
        hq = {e["digest"] for e in self.world0["events"][HQD]}
        cached = load(self.dir, "hq_checked.json")
        self.assertEqual(cached["version"], 1)
        self.assertEqual(set(cached["captures"]), hq)           # all fixture HQ events are real captures
        self.assertEqual(cached["captures"], sorted(cached["captures"]))
        self.assertEqual(self.chain.count("Tx"), len(hq))       # looked up exactly once each

    def test_call_budget_is_small(self):
        # 60 players: registry (3 pages) + profiles (2) + 60 field lookups + ... no wrapper-resolve round
        self.assertEqual(self.chain.count("Res"), 60)
        self.assertLess(len(self.chain.calls), 200)


class TestSeededRun(FetchBase):
    """Second run on top of existing files: backfills, repelled HQ attacks, free-turf attacks,
    an unreadable cached field, and the field cache being reused."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        w = copy.deepcopy(cls.world0)
        hq = w["events"][HQD]
        cls.hq_events = hq
        # events 0 and 1 become genuine repelled attacks (no CaptureEvent in their transaction)
        for e in hq[:2]:
            w["tx_events"][e["digest"]] = [x for x in w["tx_events"][e["digest"]] if "CaptureEvent" not in x["type"]]
        cls.repelled = [e["digest"] for e in hq[:2]]
        # one simulation event becomes a free-turf attack won by the attacker, with a known army
        sim = w["events"][SIM_EV][-1]
        sim["json"] = dict(sim["json"])
        sim["json"].pop("defender_id", None)
        sim["json"].pop("defender_name", None)
        sim["json"]["battle_status"] = 1
        sim["json"]["attacker_units"] = [{"gangster_name": "Henchman"}, {"gangster_name": "Henchman"},
                                         {"gangster_name": "Enforcer"}]
        cls.free_digest = sim["digest"]
        # one player's cash field is unreadable -> must be dropped from the cache, not crash
        cls.broken_pid = next(p for p, ids in w["field_lookup"].items() if ids.get("cash") and p in cls.exp.profiles)
        w["objects"].pop(w["field_lookup"][cls.broken_pid]["cash"])
        # seeded files
        cap_digest = next(e["digest"] for e in hq if e not in hq[:2])      # still has its CaptureEvent
        cls.cap_digest = cap_digest
        # the transaction is also listed among the newest CaptureEvents, so the cross-reference keeps the flag
        cap_ev = next(e for e in w["events"][CAPTURE] if e is w["events"][CAPTURE][-1])
        w["events"][CAPTURE].append({"timestamp": "2026-10-22T20:00:00.000Z", "digest": cap_digest,
                                     "type": CAPTURE, "json": dict(cap_ev["json"])})
        seed_raid = {"digest": cap_digest, "attacker_pid": "0xaa", "attacker_name": "A", "defender_pid": "0xbb",
                     "defender_name": "B", "cash": 1.0, "weapons": 1.0, "xp": 0, "timestamp": "2026-08-01T00:00:00+00:00"}
        cls.seed_raid = seed_raid
        seed_hqd = [
            {"digest": cls.repelled[0], "attacker_pid": "0x1", "attacker_name": "x", "defender_pid": "0x2",
             "defender_name": "y", "timestamp": "2026-08-01T00:00:00+00:00"},          # no is_repelled -> re-checked, kept
            {"digest": cap_digest, "attacker_pid": "0x1", "attacker_name": "x", "defender_pid": "0x2",
             "defender_name": "y", "timestamp": "2026-08-02T00:00:00+00:00"},          # really a capture -> removed
        ]
        cls.dir, cls.stdout, cls.code, cls.chain = run_fetch(
            w, files={"raids.json": [seed_raid], "hq_destroyed.json": seed_hqd,
                      "field_cache.json": {"version": 1, "resource_fields": {
                          p: v for p, v in w["field_lookup"].items() if p != "skip"}}})
        cls.w = w

    def test_ran_clean(self):
        self.assertEqual(self.code, 0, self.stdout[-2000:])
        self.assertNotIn("::warning", self.stdout)

    def test_field_cache_was_reused_not_rediscovered(self):
        self.assertEqual(self.chain.count("Res"), 0)
        self.assertIn("0 to discover", self.stdout)

    def test_unreadable_cached_field_is_dropped(self):
        cache = load(self.dir, "field_cache.json")["resource_fields"]
        self.assertNotIn(self.broken_pid, cache)
        self.assertIn(f"Cash: {len(self.exp.owned and self.exp.profiles) - 1} players", self.stdout)

    def test_hq_destroyed_keeps_only_repelled(self):
        got = {h["digest"]: h for h in load(self.dir, "hq_destroyed.json")}
        self.assertNotIn(self.cap_digest, got)                 # the capture was purged
        for dg in self.repelled:
            self.assertIn(dg, got)
        # the seeded entry was re-checked against its transaction and got the flag; entries found
        # by the event scan are stored without it (existing behaviour: they are re-checked next run)
        self.assertTrue(got[self.repelled[0]]["is_repelled"])
        # the other events carry a CaptureEvent -> not stored
        self.assertEqual(set(got), set(self.repelled))
        ev0 = next(e for e in self.hq_events if e["digest"] == self.repelled[1])
        self.assertEqual(got[self.repelled[1]]["attacker_pid"], ev0["json"].get("attacker", ""))
        self.assertEqual(got[self.repelled[1]]["defender_name"], ev0["json"].get("defender_name", ""))
        self.assertEqual(parse_ts(got[self.repelled[1]]["timestamp"]), parse_ts(ev0["timestamp"]))

    def test_raid_backfill_reads_the_transaction(self):
        raids = {r["digest"]: r for r in load(self.dir, "raids.json")}
        r = raids[self.cap_digest]
        self.assertIn("Backfilling XP/capture flag for 1 entries", self.stdout)
        self.assertTrue(r["is_capture"])
        sim = [e for e in self.w["tx_events"][self.cap_digest] if e["type"] == SIM_EV]
        xp = int(((sim[0]["parsedJson"].get("raided_resources")) or {}).get("xp", 0) or 0) if sim else 0
        self.assertEqual(r["xp"], xp / SCALE)

    def test_cache_holds_captures_only(self):
        cached = set(load(self.dir, "hq_checked.json")["captures"])
        self.assertIn(self.cap_digest, cached)                  # re-checked seed entry: a capture
        self.assertFalse(cached & set(self.repelled))           # repelled attacks live in hq_destroyed.json
        others = {e["digest"] for e in self.hq_events} - set(self.repelled)
        self.assertEqual(cached, others)

    def test_free_turf_attack_recorded(self):
        fta = {r["digest"]: r for r in load(self.dir, "free_turf_attacks.json")}
        r = fta[self.free_digest]
        self.assertTrue(r["won"])
        self.assertEqual(r["army"], {"Henchman": 2, "Enforcer": 1})


class TestHqCaptureCache(FetchBase):
    def hq_digests(self):
        return [e["digest"] for e in self.world0["events"][HQD]]

    def test_second_run_makes_no_hq_lookups(self):
        first_dir, _, _, first = run_fetch(self.world())
        cache = load(first_dir, "hq_checked.json")
        hqd = load(first_dir, "hq_destroyed.json") if os.path.exists(os.path.join(first_dir, "hq_destroyed.json")) else []
        files = {"hq_checked.json": cache}
        if hqd:
            files["hq_destroyed.json"] = hqd
        d, out, code, chain = run_fetch(self.world(), files=files)
        self.assertEqual(code, 0)
        self.assertEqual(chain.count("Tx"), 0)
        self.assertIn(f"{len(self.hq_digests())} known captures skipped", out)
        self.assertEqual(load(d, "hq_checked.json"), cache)     # unchanged: not rewritten

    def test_a_missing_or_corrupt_cache_only_costs_the_lookups_again(self):
        for name, content in (("missing", None), ("corrupt", "{broken"), ("wrong shape", '{"captures": 5}')):
            with self.subTest(name):
                d = tempfile.mkdtemp(prefix="vwm_e2e_")
                if content is not None:
                    with open(os.path.join(d, "hq_checked.json"), "w") as fh:
                        fh.write(content)
                chain = FakeChain(self.world())
                cwd = os.getcwd()
                os.chdir(d)
                try:
                    with mock.patch.object(sg, "_http_post", chain.post), mock.patch.object(sg, "sleep", lambda s: None),                             mock.patch("time.sleep", lambda s: None), contextlib.redirect_stdout(io.StringIO()):
                        runpy.run_path(os.path.join(REPO, "fetch_data.py"), run_name="__main__")
                finally:
                    os.chdir(cwd)
                self.assertEqual(chain.count("Tx"), len(self.hq_digests()))
                self.assertEqual(set(load(d, "hq_checked.json")["captures"]), set(self.hq_digests()))

    def test_failed_lookups_are_not_remembered(self):
        err = urllib.error.HTTPError("u", 500, "down", {}, None)
        d, out, code, chain = run_fetch(self.world(), fail={"Tx": err})
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(os.path.join(d, "hq_checked.json")))   # nothing learned, nothing written

    def test_cache_is_trimmed_to_the_scan_window(self):
        stale = "0x" + "9" * 64
        keep = self.hq_digests()[0]
        d, out, code, chain = run_fetch(self.world(), files={"hq_checked.json": {"version": 1, "captures": [stale, keep]}})
        got = set(load(d, "hq_checked.json")["captures"])
        self.assertNotIn(stale, got)                            # outside the window: never asked again
        self.assertEqual(got, set(self.hq_digests()))
        self.assertEqual(chain.count("Tx"), len(self.hq_digests()) - 1)   # only the uncached ones were looked up

    def test_cached_capture_is_not_mistaken_for_a_repelled_attack(self):
        w = self.world()
        victim = self.hq_digests()[0]
        w["tx_events"][victim] = [x for x in w["tx_events"][victim] if "CaptureEvent" not in x["type"]]
        # as long as the cache says "capture", it is skipped (a transaction never changes, so the
        # cache is authoritative) ...
        d, out, code, chain = run_fetch(w, files={"hq_checked.json": {"version": 1, "captures": [victim]}})
        self.assertNotIn(victim, {h["digest"] for h in load(d, "hq_destroyed.json")} if os.path.exists(os.path.join(d, "hq_destroyed.json")) else set())
        # ... and without the cache the same transaction is found to be repelled and stored
        d2, out2, code2, chain2 = run_fetch(w)
        self.assertIn(victim, {h["digest"] for h in load(d2, "hq_destroyed.json")})
        self.assertNotIn(victim, load(d2, "hq_checked.json")["captures"])

    def test_seeded_entry_known_as_capture_is_dropped_without_a_lookup(self):
        victim = self.hq_digests()[0]
        kept = {"digest": "keepme", "attacker_pid": "0x1", "attacker_name": "x", "defender_pid": "0x2",
                "defender_name": "y", "timestamp": "2026-07-01T00:00:00+00:00", "is_repelled": True}
        seed = [kept, {"digest": victim, "attacker_pid": "0x1", "attacker_name": "x", "defender_pid": "0x2",
                       "defender_name": "y", "timestamp": "2026-08-01T00:00:00+00:00"}]  # no is_repelled → normally re-checked
        d, out, code, chain = run_fetch(self.world(), files={
            "hq_destroyed.json": seed, "hq_checked.json": {"version": 1, "captures": self.hq_digests()}})
        self.assertEqual(chain.count("Tx"), 0)
        self.assertEqual(load(d, "hq_destroyed.json"), [kept])   # the capture is gone, the repelled entry stays


class TestFailureModes(FetchBase):
    def test_event_outage_is_loud_but_does_not_kill_the_run(self):
        err = urllib.error.HTTPError("u", 500, "down", {}, None)
        d, out, code, chain = run_fetch(self.world(), fail={"Ev": err})
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(os.path.join(d, "data.json")))     # the world still got written
        self.assertGreaterEqual(out.count("::warning"), 5)
        self.assertIn("warning(s)", out)
        self.assertNotIn("Done!\n", out.replace("Done, with", ""))

    def test_partial_table_is_refused(self):
        previous = {"tiles": [{}] * 10_000, "players": [{}] * 5_000}
        d, out, code, chain = run_fetch(self.world(), files={"data.json": previous})
        self.assertEqual(code, 1)
        self.assertIn("WALK INCOMPLETE", out)
        with open(os.path.join(d, "data.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), previous)                       # nothing overwritten

    def test_unreadable_registry_stops_the_run(self):
        w = self.world()
        w["objects"].pop("0x84a4a83842e92d8091563ae7a033797ad5182baca84de9f89573cb5b3722b494")
        d, out, code, chain = run_fetch(w)
        self.assertEqual(code, 1)
        self.assertIn("PlayersRegistry not readable", out)


if __name__ == "__main__":
    unittest.main()
