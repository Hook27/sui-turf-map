"""
Tests for daily_history.py: the compact (delta) long-term daily tile history.

The conversion from the legacy player_history_daily.json must be provably lossless, a
failed or interrupted run must never lose the old data, and the writer must stay tiny when
nothing changes (the whole point: the legacy file grew ~346 KB/day for ~20 changed values).
Run: python -m unittest discover -s tests
"""

import copy, json, os, random, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))

import daily_history as dh


def date(n):
    """Day n as 'YYYY-MM-DD' (2026-03-22 + n); sortable as a string."""
    from datetime import date as d, timedelta
    return (d(2026, 3, 22) + timedelta(days=n)).isoformat()


def make_days(seed=7, n_days=60, n_pids=40):
    """A deterministic legacy history with changes, joins, leaves and returns."""
    r = random.Random(seed)
    pids = [f"0xp{i}" for i in range(n_pids)]
    live = {p: 1 + r.randrange(5) for p in pids[:25]}
    days = []
    for d in range(n_days):
        for p in pids:
            x = r.random()
            if p in live:
                if x < 0.04:
                    del live[p]
                elif x < 0.15:
                    live[p] = max(1, live[p] + r.choice((-1, 1)))
            elif x < 0.1:
                live[p] = 1 + r.randrange(3)                 # a new or returning player
        days.append({"date": date(d), "players": dict(live)})
    return days


def legacy_of(days):
    return {"updated": "x", "days": copy.deepcopy(days)}


class Dir(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="vwm_dh_")
        self.v2 = os.path.join(self.tmp, "player_history_daily_v2.json")
        self.legacy = os.path.join(self.tmp, "player_history_daily.json")

    def put(self, path, obj):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)

    def get(self, path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)


class TestConversion(unittest.TestCase):
    def test_lossless_on_seeded_histories_with_joins_leaves_and_returns(self):
        for seed in (1, 7, 42, 2026):
            days = make_days(seed)
            h = dh.from_legacy(legacy_of(days))
            self.assertTrue(dh.is_v2(h))
            self.assertEqual(dh.to_days(h), days)
            self.assertEqual(dh.replay(h), days[-1]["players"])

    def test_the_history_really_contains_joins_leaves_and_returns(self):       # the test above is not vacuous
        h = dh.from_legacy(legacy_of(make_days(7)))
        nulls = sum(1 for c in h["changes"] for v in c["p"].values() if v is None)
        changes = sum(len(c["p"]) for c in h["changes"])
        self.assertGreater(nulls, 5)
        self.assertGreater(changes, 100)

    def test_every_day_has_an_entry_even_when_nothing_changed(self):
        day = {"a": 1, "b": 2}
        h = dh.from_legacy(legacy_of([{"date": date(i), "players": day} for i in range(5)]))
        self.assertEqual(len(h["changes"]), 4)
        self.assertTrue(all(c["p"] == {} for c in h["changes"]))
        self.assertEqual(len(dh.to_days(h)), 5)

    def test_duplicate_dates_keep_the_last_entry(self):
        days = [{"date": date(0), "players": {"a": 1}}, {"date": date(1), "players": {"a": 2}}, {"date": date(1), "players": {"a": 3}}]
        h = dh.from_legacy(legacy_of(days))
        self.assertEqual([d["players"] for d in dh.to_days(h)], [{"a": 1}, {"a": 3}])

    def test_a_conversion_that_loses_data_is_refused(self):
        # The self-check is a safety net: with a deliberately broken delta (it forgets players that
        # leave) the round trip no longer reproduces the input, and from_legacy must say None
        # rather than hand back a v2 file that silently differs. Without that, update() would
        # delete the legacy file on the strength of a wrong conversion.
        days = make_days(7, 30)
        real = dh._delta
        try:
            dh._delta = lambda prev, counts: {k: v for k, v in real(prev, counts).items() if v is not None}
            self.assertIsNone(dh.from_legacy(legacy_of(days)))
        finally:
            dh._delta = real
        self.assertIsNotNone(dh.from_legacy(legacy_of(days)))

    def test_unusable_input_is_refused_not_guessed(self):
        bad = [None, {}, [], "x", {"days": []}, {"days": "no"}, {"days": [{"date": date(0)}]},
               {"days": [{"date": date(0), "players": []}]},
               {"days": [{"date": date(0), "players": {"a": "1"}}]},             # a count that is not an integer
               {"days": [{"date": date(0), "players": {"a": True}}]},            # bool is not a count
               {"days": [{"date": date(2), "players": {"a": 1}}, {"date": date(1), "players": {"a": 1}}]}]   # unordered
        for b in bad:
            self.assertIsNone(dh.from_legacy(b), b)

    def test_is_v2_rejects_malformed_files(self):
        ok = {"format": 2, "base": {"date": date(0), "players": {"a": 1}}, "changes": [{"date": date(1), "p": {"a": None}}]}
        self.assertTrue(dh.is_v2(ok))
        broken = [
            lambda h: h.update(format=1),
            lambda h: h.pop("base"),
            lambda h: h.update(changes="no"),
            lambda h: h["base"].update(players=[]),
            lambda h: h["base"]["players"].update(a="1"),
            lambda h: h["changes"].append({"date": date(1), "p": {}}),             # date not increasing
            lambda h: h["changes"].append({"date": date(0), "p": {}}),             # goes back in time
            lambda h: h["changes"][0].update(p={"a": "2"}),
            lambda h: h["changes"][0].update(p={"a": True}),
            lambda h: h["changes"][0].pop("date"),
        ]
        for f in broken:
            h = copy.deepcopy(ok)
            f(h)
            self.assertFalse(dh.is_v2(h))
        for notdict in (None, [], "x", 5):
            self.assertFalse(dh.is_v2(notdict))


class TestAppend(unittest.TestCase):
    def fresh(self):
        return {"format": 2, "base": {"date": date(0), "players": {"a": 1, "b": 2}}, "changes": []}

    def test_unchanged_day_adds_an_empty_entry(self):
        h = self.fresh()
        self.assertEqual(dh.append_day(h, date(1), {"a": 1, "b": 2}), "appended")
        self.assertEqual(h["changes"], [{"date": date(1), "p": {}}])

    def test_change_new_player_and_leaving_player(self):
        h = self.fresh()
        dh.append_day(h, date(1), {"a": 5, "c": 1})
        self.assertEqual(h["changes"][0]["p"], {"a": 5, "c": 1, "b": None})

    def test_the_same_day_again_replaces_it_and_equals_a_single_run(self):
        once, twice = self.fresh(), self.fresh()
        dh.append_day(once, date(1), {"a": 9, "b": 2})
        dh.append_day(twice, date(1), {"a": 3, "b": 2, "z": 1})
        self.assertEqual(dh.append_day(twice, date(1), {"a": 9, "b": 2}), "replaced")
        self.assertEqual(twice, once)

    def test_the_same_day_on_a_base_only_history_replaces_the_base(self):
        h = self.fresh()
        self.assertEqual(dh.append_day(h, date(0), {"a": 7}), "replaced")
        self.assertEqual(h["base"], {"date": date(0), "players": {"a": 7}})
        self.assertEqual(h["changes"], [])

    def test_a_date_before_the_last_one_is_ignored(self):
        h = self.fresh()
        dh.append_day(h, date(3), {"a": 4})
        before = copy.deepcopy(h)
        self.assertEqual(dh.append_day(h, date(2), {"a": 99}), "stale")
        self.assertEqual(h, before)

    def test_a_long_sequence_always_reproduces_the_input(self):
        r = random.Random(5)
        h, expected = None, []
        state = {f"p{i}": 1 for i in range(50)}
        for d in range(120):
            for k in list(state):
                x = r.random()
                if x < 0.03:
                    del state[k]
                elif x < 0.08:
                    state[k] += 1
            if r.random() < 0.3:
                state[f"n{d}"] = 1
            counts = dict(state)
            if h is None:
                h = {"format": 2, "base": {"date": date(d), "players": dict(counts)}, "changes": []}
            else:
                dh.append_day(h, date(d), counts)
            expected.append({"date": date(d), "players": counts})
        self.assertEqual(dh.to_days(h), expected)
        self.assertTrue(dh.is_v2(h))

    def test_counts_are_stored_as_integers(self):
        h = self.fresh()
        dh.append_day(h, date(1), {"a": 3.0})
        self.assertEqual(h["changes"][0]["p"]["a"], 3)
        self.assertIsInstance(h["changes"][0]["p"]["a"], int)


class TestUpdate(Dir):
    def counts(self, **kw):
        return dict(kw)

    def test_first_ever_run_creates_the_file(self):
        r = dh.update(self.v2, self.legacy, date(0), {"a": 1}, "t0")
        self.assertEqual((r["how"], r["days"], r["converted"], r["legacy_removed"]), ("created", 1, False, False))
        h = self.get(self.v2)
        self.assertTrue(dh.is_v2(h))
        self.assertEqual(dh.replay(h), {"a": 1})

    def test_later_days_append_and_the_same_day_replaces(self):
        dh.update(self.v2, self.legacy, date(0), {"a": 1}, "t0")
        r = dh.update(self.v2, self.legacy, date(1), {"a": 2}, "t1")
        self.assertEqual((r["how"], r["days"]), ("appended", 2))
        r = dh.update(self.v2, self.legacy, date(1), {"a": 3}, "t1b")
        self.assertEqual((r["how"], r["days"]), ("replaced", 2))
        self.assertEqual(dh.replay(self.get(self.v2)), {"a": 3})
        self.assertEqual(self.get(self.v2)["updated"], "t1b")

    def test_legacy_is_converted_extended_and_removed(self):
        days = make_days(42, 60)
        self.put(self.legacy, legacy_of(days))
        today = dict(days[-1]["players"])
        today["brand_new"] = 1
        r = dh.update(self.v2, self.legacy, date(60), today, "t")
        self.assertTrue(r["converted"] and r["legacy_removed"])
        self.assertEqual(r["warnings"], [])
        self.assertFalse(os.path.exists(self.legacy))
        self.assertEqual(dh.to_days(self.get(self.v2)), days + [{"date": date(60), "players": today}])

    def test_the_conversion_is_exact_for_every_old_day(self):
        days = make_days(2026, 90)
        self.put(self.legacy, legacy_of(days))
        dh.update(self.v2, self.legacy, date(90), days[-1]["players"], "t")
        self.assertEqual(dh.to_days(self.get(self.v2))[:90], days)

    def test_no_temp_file_is_left_behind(self):
        dh.update(self.v2, self.legacy, date(0), {"a": 1}, "t")
        self.assertEqual(sorted(os.listdir(self.tmp)), ["player_history_daily_v2.json"])

    def test_corrupt_v2_is_rebuilt_from_the_legacy_file_with_a_warning(self):
        days = make_days(3, 30)
        self.put(self.legacy, legacy_of(days))
        with open(self.v2, "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        r = dh.update(self.v2, self.legacy, date(30), days[-1]["players"], "t")
        self.assertEqual(dh.to_days(self.get(self.v2))[:30], days)
        self.assertTrue(any("unreadable" in w for w in r["warnings"]))
        self.assertTrue(r["legacy_removed"])

    def test_wrongly_shaped_v2_counts_as_corrupt(self):
        self.put(self.v2, {"format": 2, "base": "oops"})
        r = dh.update(self.v2, self.legacy, date(0), {"a": 1}, "t")
        self.assertEqual(r["how"], "created")
        self.assertTrue(any("unreadable" in w for w in r["warnings"]))

    def test_corrupt_legacy_is_left_alone_and_does_not_block_the_new_file(self):
        with open(self.legacy, "w", encoding="utf-8") as fh:
            fh.write("garbage")
        r = dh.update(self.v2, self.legacy, date(0), {"a": 1}, "t")
        self.assertTrue(os.path.exists(self.legacy))
        self.assertFalse(r["legacy_removed"])
        self.assertTrue(any("untouched" in w for w in r["warnings"]))
        self.assertEqual(dh.replay(self.get(self.v2)), {"a": 1})

    def test_unordered_legacy_is_never_converted_or_deleted(self):
        bad = {"days": [{"date": date(2), "players": {"a": 1}}, {"date": date(1), "players": {"a": 2}}]}
        self.put(self.legacy, bad)
        r = dh.update(self.v2, self.legacy, date(3), {"a": 5}, "t")
        self.assertTrue(os.path.exists(self.legacy))
        self.assertEqual(self.get(self.legacy), bad)
        self.assertFalse(r["converted"])

    def test_legacy_ahead_of_v2_reseeds_from_the_legacy_file(self):
        days = make_days(11, 40)
        old_v2 = dh.from_legacy(legacy_of(days[:20]))
        self.put(self.v2, old_v2)
        self.put(self.legacy, legacy_of(days))
        r = dh.update(self.v2, self.legacy, date(40), days[-1]["players"], "t")
        self.assertTrue(r["converted"] and r["legacy_removed"])
        self.assertEqual(dh.to_days(self.get(self.v2))[:40], days)

    def test_a_legacy_file_that_disagrees_with_v2_is_kept(self):
        days = make_days(11, 20)
        v2 = dh.from_legacy(legacy_of(days))
        self.put(self.v2, v2)
        conflicting = copy.deepcopy(days)
        conflicting[5]["players"]["0xp0"] = 12345
        self.put(self.legacy, legacy_of(conflicting))
        r = dh.update(self.v2, self.legacy, date(20), days[-1]["players"], "t")
        self.assertTrue(os.path.exists(self.legacy))
        self.assertFalse(r["legacy_removed"])
        self.assertTrue(any("differs" in w for w in r["warnings"]))

    def test_a_valid_v2_with_an_old_identical_legacy_removes_the_legacy(self):
        days = make_days(4, 25)
        self.put(self.v2, dh.from_legacy(legacy_of(days)))
        self.put(self.legacy, legacy_of(days))
        r = dh.update(self.v2, self.legacy, date(25), days[-1]["players"], "t")
        self.assertTrue(r["legacy_removed"])
        self.assertFalse(os.path.exists(self.legacy))

    def test_a_failed_write_leaves_the_legacy_file_untouched(self):
        days = make_days(9, 15)
        self.put(self.legacy, legacy_of(days))
        before = self.get(self.legacy)
        missing_dir = os.path.join(self.tmp, "no_such_dir", "player_history_daily_v2.json")
        with self.assertRaises(Exception):
            dh.update(missing_dir, self.legacy, date(15), days[-1]["players"], "t")
        self.assertEqual(self.get(self.legacy), before)

    def test_a_date_in_the_past_does_not_change_history_but_still_succeeds(self):
        days = make_days(2, 10)
        self.put(self.v2, dh.from_legacy(legacy_of(days)))
        before = self.get(self.v2)["changes"]
        r = dh.update(self.v2, self.legacy, date(3), {"a": 1}, "t")
        self.assertEqual(r["how"], "stale")
        self.assertEqual(self.get(self.v2)["changes"], before)

    def test_a_quiet_game_barely_grows_the_file(self):
        # 5,000 players, nothing changes: the legacy file grew ~346 KB per day, this one must not.
        players = {f"0x{i:064x}": 1 for i in range(5000)}
        dh.update(self.v2, self.legacy, date(0), players, "t")
        base_size = os.path.getsize(self.v2)
        for d in range(1, 31):
            dh.update(self.v2, self.legacy, date(d), players, "t")
        growth = (os.path.getsize(self.v2) - base_size) / 30
        self.assertLess(growth, 100)                         # bytes per quiet day (legacy: ~346,000)
        self.assertLess(os.path.getsize(self.v2), 400_000)


if __name__ == "__main__":
    unittest.main()
