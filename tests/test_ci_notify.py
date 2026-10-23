"""
Tests for tools/ci_notify.py, the logic behind "open an issue when the daily data run fails".
The live workflow cannot be run locally, so `gh` is replaced by a fake that records every call
and answers like the real tool would.   Run: python -m unittest discover -s tests
"""

import io, json, os, sys, unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))

import ci_notify as cn

ENV = {
    "GITHUB_SERVER_URL": "https://github.com",
    "GITHUB_REPOSITORY": "Hook27/sui-turf-map",
    "GITHUB_RUN_ID": "12345",
    "GATE_RESULT": "success",
    "FETCH_RESULT": "failure",
    "EVENT_NAME": "workflow_dispatch",
    "SRC": "pi-cron",
}
RUN_URL = "https://github.com/Hook27/sui-turf-map/actions/runs/12345"
NOW = datetime(2026, 10, 24, 4, 50, tzinfo=timezone.utc)


class FakeGh:
    """A stand-in for the gh command line. `issues` is what `gh issue list` reports as open;
    `fail` maps a subcommand ("list" / "create" / "comment") to an (exit code, message) failure."""

    def __init__(self, issues=(), fail=None, list_output=None):
        self.issues = list(issues)
        self.fail = fail or {}
        self.list_output = list_output
        self.calls = []

    def __call__(self, args):
        self.calls.append(list(args))
        sub = args[1]
        if sub in self.fail:
            return self.fail[sub]
        if sub == "list":
            return 0, self.list_output if self.list_output is not None else json.dumps(self.issues)
        if sub == "create":
            return 0, "https://github.com/Hook27/sui-turf-map/issues/99\n"
        if sub == "comment":
            return 0, "https://github.com/Hook27/sui-turf-map/issues/7#issuecomment-1\n"
        raise AssertionError(f"unexpected gh call {args}")

    def subs(self):
        return [c[1] for c in self.calls]

    def arg(self, call, flag):
        return call[call.index(flag) + 1]


class TestReportFailure(unittest.TestCase):
    def test_no_open_issue_creates_one_with_the_run_link(self):
        gh = FakeGh(issues=[])
        what, detail = cn.report_failure(gh, ENV, NOW)
        self.assertEqual(what, "created")
        self.assertIn("/issues/99", detail)
        self.assertEqual(gh.subs(), ["list", "create"])
        create = gh.calls[1]
        self.assertEqual(gh.arg(create, "--title"), "Daily map update failed")
        body = gh.arg(create, "--body")
        self.assertIn(RUN_URL, body)
        self.assertIn("`fetch` (the data run)", body)
        self.assertIn("workflow_dispatch (pi-cron)", body)
        self.assertIn("2026-10-24 04:50 UTC", body)

    def test_an_open_issue_gets_a_comment_and_no_second_issue(self):
        gh = FakeGh(issues=[{"number": 7, "title": "Daily map update failed"}])
        what, detail = cn.report_failure(gh, ENV, NOW)
        self.assertEqual((what, detail), ("commented", "#7"))
        self.assertEqual(gh.subs(), ["list", "comment"])           # no create
        self.assertEqual(gh.calls[1][2], "7")
        self.assertIn(RUN_URL, gh.arg(gh.calls[1], "--body"))

    def test_only_an_exact_title_counts(self):
        gh = FakeGh(issues=[{"number": 3, "title": "Daily map update failed (old)"},
                            {"number": 4, "title": "daily map update failed"},
                            {"number": 5, "title": "Something else"}])
        what, _ = cn.report_failure(gh, ENV, NOW)
        self.assertEqual(what, "created")                         # none of those is OUR issue

    def test_surrounding_whitespace_in_the_title_is_tolerated(self):
        gh = FakeGh(issues=[{"number": 8, "title": "  Daily map update failed "}])
        self.assertEqual(cn.report_failure(gh, ENV, NOW)[0], "commented")

    def test_with_several_open_duplicates_the_oldest_gets_the_comment(self):
        gh = FakeGh(issues=[{"number": 12, "title": cn.TITLE}, {"number": 9, "title": cn.TITLE}])
        self.assertEqual(cn.report_failure(gh, ENV, NOW), ("commented", "#9"))

    def test_the_listing_asks_for_open_issues_only(self):
        gh = FakeGh()
        cn.report_failure(gh, ENV, NOW)
        self.assertEqual(gh.calls[0][:4], ["issue", "list", "--state", "open"])

    def test_a_failing_listing_still_creates_an_issue(self):
        gh = FakeGh(fail={"list": (1, "HTTP 502")})
        out = io.StringIO()
        with redirect_stdout(out):
            what, _ = cn.report_failure(gh, ENV, NOW)
        self.assertEqual(what, "created")
        self.assertIn("::warning title=ci_notify::gh issue list failed", out.getvalue())

    def test_unreadable_listing_is_treated_as_a_failed_listing(self):
        for bad in ("not json", "{}", "[1, 2]", ""):
            with self.subTest(bad=bad):
                gh = FakeGh(list_output=bad)
                with redirect_stdout(io.StringIO()):
                    what, _ = cn.report_failure(gh, ENV, NOW)
                self.assertEqual(what, "created")

    def test_failures_to_create_or_comment_are_reported_not_raised(self):
        what, detail = cn.report_failure(FakeGh(fail={"create": (1, "Issues are disabled")}), ENV, NOW)
        self.assertEqual(what, "failed")
        self.assertIn("Issues are disabled", detail)
        what, detail = cn.report_failure(
            FakeGh(issues=[{"number": 7, "title": cn.TITLE}], fail={"comment": (1, "forbidden")}), ENV, NOW)
        self.assertEqual(what, "failed")
        self.assertIn("forbidden", detail)

    def test_a_failed_gate_is_named_as_such(self):
        body = cn.build_body({**ENV, "GATE_RESULT": "failure", "FETCH_RESULT": "skipped"}, NOW)
        self.assertIn("`gate` (the freshness check; the data fetch never started)", body)
        self.assertNotIn("`fetch`", body)

    def test_no_failed_job_reported_says_unknown(self):
        self.assertIn("unknown", cn.build_body({"GATE_RESULT": "success", "FETCH_RESULT": "success"}, NOW))

    def test_a_schedule_trigger_without_src(self):
        body = cn.build_body({**ENV, "EVENT_NAME": "schedule", "SRC": ""}, NOW)
        self.assertIn("Trigger: schedule\n", body)


class TestMain(unittest.TestCase):
    def run_main(self, gh, env=ENV):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cn.main(env=env, gh=gh)
        return code, out.getvalue()

    def test_success_prints_what_happened(self):
        code, out = self.run_main(FakeGh())
        self.assertEqual(code, 0)
        self.assertIn("issue created:", out)

    def test_exit_code_is_zero_even_when_everything_fails(self):
        code, out = self.run_main(FakeGh(fail={"list": (1, "x"), "create": (1, "no permission")}))
        self.assertEqual(code, 0)                                   # must not turn a failed run into a worse one
        self.assertIn("::warning title=ci_notify::could not report the failed run", out)
        self.assertIn("no permission", out)

    def test_exit_code_is_zero_when_gh_itself_blows_up(self):
        def boom(args):
            raise OSError("pipe closed")
        code, out = self.run_main(boom)
        self.assertEqual(code, 0)
        self.assertIn("::warning", out)


class TestRunGh(unittest.TestCase):
    def test_a_missing_gh_is_a_nonzero_code_not_an_exception(self):
        with mock.patch("subprocess.run", side_effect=FileNotFoundError):
            self.assertEqual(cn.run_gh(["issue", "list"])[0], 127)

    def test_a_hanging_gh_is_a_nonzero_code_not_an_exception(self):
        import subprocess
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("gh", 60)):
            self.assertEqual(cn.run_gh(["issue", "list"])[0], 124)

    def test_stdout_on_success_stderr_on_failure(self):
        ok = mock.Mock(returncode=0, stdout="out", stderr="noise")
        bad = mock.Mock(returncode=1, stdout="", stderr="the reason")
        with mock.patch("subprocess.run", return_value=ok):
            self.assertEqual(cn.run_gh(["x"]), (0, "out"))
        with mock.patch("subprocess.run", return_value=bad):
            self.assertEqual(cn.run_gh(["x"]), (1, "the reason"))


if __name__ == "__main__":
    unittest.main()
