"""Unit tests for sui_graphql.py against the offline fake chain.  Run: python -m unittest discover -s tests"""

import base64, contextlib, io, os, sys, unittest, urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

import sui_graphql as sg
from fake_graphql import FakeChain, load_world

GAME_EV = "0xe660c11d5cddf961e2f153e2e9c89517bdbb2dfa64b9d3aae711672aeb7f240d::game_events::"
KEY = "SECRETKEY1234567890abcdef"


def reset_transport():
    sg.rpc_index = 0
    sg._call_no = 0
    sg._ep_pause_until.clear()
    sg._ep_pause_len.clear()


class Base(unittest.TestCase):
    world = None

    @classmethod
    def setUpClass(cls):
        cls.world = load_world()

    def setUp(self):
        reset_transport()
        self.chain = FakeChain(self.world)
        self._patches = [mock.patch.object(sg, "_http_post", self.chain.post),
                         mock.patch.object(sg, "sleep", lambda s: None)]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)


class TestBcs(unittest.TestCase):
    def test_string_short(self):
        self.assertEqual(sg.bcs_string("cash"), b"\x04cash")

    def test_string_long_uses_two_byte_uleb(self):
        b = sg.bcs_string("x" * 130)
        self.assertEqual(b[:2], bytes([130 & 0x7F | 0x80, 1]))
        self.assertEqual(len(b), 2 + 130)

    def test_coordinates_positive_and_negative(self):
        # (299, -133) resolved to a real turf on mainnet with exactly these bytes
        b = sg.bcs_coordinates(299, -133)
        self.assertEqual(b.hex(), "2b01000000000000" "00" "8500000000000000" "01")
        self.assertEqual(len(b), 18)
        self.assertEqual(sg.bcs_coordinates(-1, 0)[8], 1)
        self.assertEqual(sg.bcs_coordinates(0, 0), bytes(18))


class TestEndpoints(unittest.TestCase):
    def test_keyless_default(self):
        self.assertEqual(sg.build_endpoints({}), [sg.MYSTEN_GRAPHQL])

    def test_ankr_derived_from_rpc_secret_and_ordered_second(self):
        eps = sg.build_endpoints({"SUI_RPC_URL": f"https://rpc.ankr.com/sui/{KEY}"})
        self.assertEqual(eps, [sg.MYSTEN_GRAPHQL, sg.ANKR_GRAPHQL + KEY])

    def test_keyed_first_and_override(self):
        eps = sg.build_endpoints({"SUI_RPC_URL": f"https://rpc.ankr.com/sui/{KEY}", "SUI_GRAPHQL_KEYED_FIRST": "1"})
        self.assertEqual(eps[0], sg.ANKR_GRAPHQL + KEY)
        eps = sg.build_endpoints({"SUI_GRAPHQL_URL": "https://example.test/graphql"})
        self.assertEqual(eps, [sg.MYSTEN_GRAPHQL, "https://example.test/graphql"])

    def test_junk_secret_is_ignored(self):
        self.assertEqual(sg.build_endpoints({"SUI_RPC_URL": "   "}), [sg.MYSTEN_GRAPHQL])
        self.assertEqual(sg.build_endpoints({"SUI_RPC_URL": "https://x.test/short"}), [sg.MYSTEN_GRAPHQL])


class TestTransport(unittest.TestCase):
    def setUp(self):
        reset_transport()
        p = mock.patch.object(sg, "sleep", lambda s: None)
        p.start()
        self.addCleanup(p.stop)
        e = mock.patch.object(sg, "ENDPOINTS", [sg.MYSTEN_GRAPHQL, sg.ANKR_GRAPHQL + KEY])
        e.start()
        self.addCleanup(e.stop)

    def test_errors_entry_fails_over_to_second_endpoint_and_never_logs_the_key(self):
        seen = []

        def post(url, body):
            seen.append(url)
            if url == sg.MYSTEN_GRAPHQL:
                return {"errors": [{"message": "boom"}], "data": None}
            return {"data": {"ok": 1}}

        out = io.StringIO()
        with mock.patch.object(sg, "_http_post", post), contextlib.redirect_stdout(out):
            self.assertEqual(sg.gql("query A{x}"), {"ok": 1})
        # one retry on the same endpoint first, then it is parked and the second endpoint takes over
        self.assertEqual(seen, [sg.MYSTEN_GRAPHQL, sg.MYSTEN_GRAPHQL, sg.ANKR_GRAPHQL + KEY])
        self.assertNotIn(KEY, out.getvalue())
        self.assertIn("graphql.mainnet.sui.io", out.getvalue())   # host only

    def test_429_waits_once_then_parks_the_endpoint(self):
        waits = []
        calls = []

        def post(url, body):
            calls.append(url)
            if url == sg.MYSTEN_GRAPHQL:
                raise urllib.error.HTTPError(url, 429, "slow down", {}, None)
            return {"data": {"ok": 1}}

        with mock.patch.object(sg, "_http_post", post), mock.patch.object(sg, "sleep", waits.append), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sg.gql("query A{x}"), {"ok": 1})
            self.assertEqual(waits, [2])
            self.assertEqual(calls[:3], [sg.MYSTEN_GRAPHQL] * 2 + [sg.ANKR_GRAPHQL + KEY])
            # the parked endpoint is skipped for the next calls
            calls.clear()
            sg.gql("query A{x}")
            self.assertEqual(calls, [sg.ANKR_GRAPHQL + KEY])

    def test_a_one_off_graphql_error_is_retried_on_the_same_endpoint(self):
        seen = []

        def post(url, body):
            seen.append(url)
            if len(seen) == 1:
                return {"errors": [{"message": "Failed to fetch object contents"}], "data": None}
            return {"data": {"ok": 1}}

        waits = []
        with mock.patch.object(sg, "_http_post", post), mock.patch.object(sg, "sleep", waits.append),                 contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sg.gql("query A{x}"), {"ok": 1})
        self.assertEqual(seen, [sg.MYSTEN_GRAPHQL] * 2)       # no failover, no penalty
        self.assertEqual(waits, [2])
        self.assertEqual(sg._ep_pause_until, {})

    def test_auth_errors_park_the_endpoint_at_once(self):
        seen = []

        def post(url, body):
            seen.append(url)
            if url == sg.MYSTEN_GRAPHQL:
                raise urllib.error.HTTPError(url, 403, "forbidden", {}, None)
            return {"data": {"ok": 1}}

        with mock.patch.object(sg, "_http_post", post), contextlib.redirect_stdout(io.StringIO()):
            sg.gql("query A{x}")
        self.assertEqual(seen, [sg.MYSTEN_GRAPHQL, sg.ANKR_GRAPHQL + KEY])

    def test_a_single_endpoint_is_never_parked(self):
        calls, waits = [], []

        def post(url, body):
            calls.append(url)
            raise urllib.error.HTTPError(url, 503, "down", {}, None)

        with mock.patch.object(sg, "ENDPOINTS", [sg.MYSTEN_GRAPHQL]), mock.patch.object(sg, "_http_post", post),                 mock.patch.object(sg, "sleep", waits.append), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                sg.gql("query A{x}")
        self.assertEqual(len(calls), 8)
        self.assertEqual(sg._ep_pause_until, {})
        self.assertTrue(all(w == 2 for w in waits))             # short fixed waits, no 2 s "waiting room" per call

    def test_gives_up_loudly_after_all_attempts(self):
        def post(url, body):
            raise urllib.error.HTTPError(url, 503, "down", {}, None)

        with mock.patch.object(sg, "_http_post", post), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError) as cm:
                sg.gql("query A{x}")
        self.assertIsInstance(cm.exception.__cause__, urllib.error.HTTPError)

    def test_response_without_data_counts_as_failure(self):
        with mock.patch.object(sg, "_http_post", lambda u, b: {}), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                sg.gql("query A{x}", retries=2)


class TestReads(Base):
    def test_get_object_flat_json(self):
        reg = sg.get_object("0x84a4a83842e92d8091563ae7a033797ad5182baca84de9f89573cb5b3722b494")
        self.assertIn("players", reg["json"])
        self.assertNotIn("fields", reg["json"])
        self.assertTrue(reg["address"].startswith("0x"))

    def test_multi_get_aligned_with_missing_as_none(self):
        pid = next(a for a, o in self.world["objects"].items() if o["type"].endswith("::iplayer::Player"))
        res = sg.multi_get([pid, "0x" + "ab" * 32])
        self.assertEqual(res[0]["address"], pid)
        self.assertTrue(res[0]["type"].endswith("::iplayer::Player"))
        self.assertIsNone(res[1])

    def test_multi_get_without_type_has_empty_type(self):
        pid = next(a for a, o in self.world["objects"].items() if o["type"].endswith("::iplayer::Player"))
        self.assertEqual(sg.multi_get([pid], with_type=False)[0]["type"], "")

    def test_multi_get_rejects_more_than_50_ids(self):
        with self.assertRaises(ValueError):
            sg.multi_get(["0x1"] * 51)

    def test_fifty_real_ids_fit_the_5000_byte_payload_limit(self):
        ids = [e["value"] for e in self.world["fields"][self.world["objects"][
            "0x84a4a83842e92d8091563ae7a033797ad5182baca84de9f89573cb5b3722b494"]["json"]["players"]["contents"]["id"]]][:50]
        self.assertEqual(len(ids), 50)
        self.assertEqual(len(sg.multi_get(ids)), 50)      # the fake rejects bodies > 5000 B

    def test_multi_get_count_mismatch_is_an_error(self):
        with mock.patch.object(sg, "gql", lambda q, v=None, **k: {"multiGetObjects": []}):
            with self.assertRaises(ValueError):
                sg.multi_get(["0x1"])

    def test_dynamic_fields_pages_cover_everything_exactly_once(self):
        tv = self.world["objects"]["0x84a4a83842e92d8091563ae7a033797ad5182baca84de9f89573cb5b3722b494"]["json"]["players"]["contents"]["id"]
        got, cursor, pages = [], None, 0
        while True:
            items, more, cursor = sg.dynamic_fields_page(tv, cursor)
            got += [i["value"] for i in items]
            pages += 1
            if not more:
                break
        self.assertEqual(got, [e["value"] for e in self.world["fields"][tv]])
        self.assertGreater(pages, 1)

    def test_dynamic_field_object_value_returns_the_address(self):
        fake = {"address": {"dynamicFields": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [
            {"name": {"type": {"repr": "u64"}, "json": "1"}, "value": {"__typename": "MoveObject", "address": "0xabc"}}]}}}
        with mock.patch.object(sg, "gql", lambda q, v=None, **k: fake):
            items, more, _ = sg.dynamic_fields_page("0x1")
        self.assertEqual(items[0]["value"], "0xabc")
        self.assertFalse(more)

    def test_resource_field_ids(self):
        pid = next(iter(self.world["field_lookup"]))
        self.assertEqual(sg.resource_field_ids(pid), self.world["field_lookup"][pid])

    def test_dynamic_field_absent_is_none_and_name_is_base64_bcs(self):
        sent = {}

        def fake(q, v=None, **k):
            sent.update(v)
            return {"address": {"dynamicField": None}}

        with mock.patch.object(sg, "gql", fake):
            self.assertIsNone(sg.dynamic_field("0x1", sg.STRING_TYPE, sg.bcs_string("cash")))
        self.assertEqual(base64.b64decode(sent["n"]["bcs"]), b"\x04cash")
        self.assertEqual(sent["n"]["type"], "0x1::string::String")


class TestEvents(Base):
    def test_all_pages_newest_first_and_old_shape(self):
        etype = GAME_EV + "FeedPeopleEvent"
        expected = list(reversed(self.world["events"][etype]))
        got, cursor, pages = [], None, 0
        while True:
            res = sg.query_events(etype, cursor)
            got += res["data"]
            pages += 1
            if not res["hasNextPage"]:
                break
            cursor = res["nextCursor"]
        self.assertGreater(pages, 1)
        self.assertEqual([e["id"]["txDigest"] for e in got], [e["digest"] for e in expected])
        self.assertEqual(got[0]["parsedJson"], expected[0]["json"])
        self.assertEqual(got[0]["type"], etype)
        ts = [int(e["timestampMs"]) for e in got]
        self.assertEqual(ts, sorted(ts, reverse=True))

    def test_timestamp_conversion(self):
        self.assertEqual(sg.iso_to_ms("2026-10-22T16:30:07.040Z"), 1792686607040)
        self.assertIsNone(sg.iso_to_ms(None))

    def test_unknown_event_type_is_an_empty_page(self):
        res = sg.query_events(GAME_EV + "NoSuchEvent")
        self.assertEqual((res["data"], res["hasNextPage"]), ([], False))

    def test_tx_events(self):
        digest, evs = next(iter(self.world["tx_events"].items()))
        got = sg.tx_events(digest)
        self.assertEqual([e["type"] for e in got], [e["type"] for e in evs])
        self.assertEqual(got[0]["parsedJson"], evs[0]["parsedJson"])

    def test_unknown_transaction_raises(self):
        with self.assertRaises(ValueError):
            sg.tx_events("nope")


class TestFlatHelpers(unittest.TestCase):
    def test_vecmap(self):
        raw = {"contents": [{"key": "feed_people", "value": "123"}, {"key": "x", "value": None}]}
        self.assertEqual(sg.vecmap(raw), {"feed_people": 123, "x": 0})
        self.assertEqual(sg.vecmap(None), {})
        self.assertEqual(sg.vecmap({"contents": []}), {})

    def test_resource_amount(self):
        self.assertEqual(sg.resource_amount({"value": {"amount": "2214882114186232152982"}}), 2214882114186232152982)
        self.assertEqual(sg.resource_amount({"value": "weird"}), 0)
        self.assertEqual(sg.resource_amount(None), 0)


if __name__ == "__main__":
    unittest.main()
