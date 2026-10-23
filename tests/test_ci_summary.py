"""
Tests for tools/ci_summary.py, the parser behind the markdown summary on the Tests run page.
The sample logs below are real unittest / node --test output (trimmed), including the
Windows variant with \\r\\n line endings.   Run: python -m unittest discover -s tests
"""

import io, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))

import ci_summary as cs

PY_GREEN = """\
...........................................................................................
----------------------------------------------------------------------
Ran 91 tests in 3.970s

OK
"""

PY_GREEN_SKIPPED = """\
.s.
----------------------------------------------------------------------
Ran 3 tests in 0.010s

OK (skipped=1)
"""

PY_RED = """\
FE.sFFF
======================================================================
ERROR: test_err (test_demo.T.test_err)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/runner/work/x/tests/test_demo.py", line 6, in test_err
    def test_err(self): raise ValueError("boom")
                        ^^^^^^^^^^^^^^^^^^^^^^^^
ValueError: boom

======================================================================
FAIL: test_eq (test_demo.T.test_eq)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/runner/work/x/tests/test_demo.py", line 4, in test_eq
    def test_eq(self): self.assertEqual({"a": 1, "b": [1, 2]}, {"a": 1, "b": [1, 3]})
                       ~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
AssertionError: {'a': 1, 'b': [1, 2]} != {'a': 1, 'b': [1, 3]}
- {'a': 1, 'b': [1, 2]}
?                   ^

+ {'a': 1, 'b': [1, 3]}
?                   ^


======================================================================
FAIL: test_sub (test_demo.T.test_sub) (i=0)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/runner/work/x/tests/test_demo.py", line 12, in test_sub
    self.assertEqual(i, 5)
    ~~~~~~~~~~~~~~~~^^^^^^
AssertionError: 0 != 5

======================================================================
FAIL: test_sub (test_demo.T.test_sub) (i=1)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/runner/work/x/tests/test_demo.py", line 12, in test_sub
    self.assertEqual(i, 5)
    ~~~~~~~~~~~~~~~~^^^^^^
AssertionError: 1 != 5

----------------------------------------------------------------------
Ran 6 tests in 0.006s

FAILED (failures=3, errors=1, skipped=1)
"""

JS_GREEN = """\
TAP version 13
# Subtest: good one
ok 1 - good one
  ---
  duration_ms: 1.3833
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 213.1899
"""

JS_RED = """\
TAP version 13
# Subtest: good one
ok 1 - good one
  ---
  duration_ms: 1.3833
  type: 'test'
  ...
# Subtest: bad one
not ok 2 - bad one
  ---
  duration_ms: 1.4757
  type: 'test'
  location: 'C:\\\\Users\\\\x\\\\tests\\\\js\\\\t.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    1 !== 2

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 2
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///C:/Users/x/t.test.mjs:4:32)
    Test.run (node:internal/test_runner/test:1118:25)
  ...
# Subtest: skipme
ok 3 - skipme # SKIP
  ---
  duration_ms: 2.5533
  type: 'test'
  ...
# Subtest: suite
    # Subtest: inner
    not ok 1 - inner
      ---
      failureType: 'testCodeFailure'
      error: 'boom'
      ...
not ok 4 - suite
  ---
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
1..4
# tests 4
# suites 1
# pass 1
# fail 2
# cancelled 0
# skipped 1
# todo 0
# duration_ms 213.1899
"""


def crlf(text):
    return text.replace("\n", "\r\n")


class TestParsePython(unittest.TestCase):
    def test_green(self):
        r = cs.parse_python(PY_GREEN)
        self.assertEqual((r["total"], r["passed"], r["failed"], r["skipped"]), (91, 91, 0, 0))
        self.assertEqual(r["failures"], [])

    def test_skipped_tests_are_not_passed_tests(self):
        r = cs.parse_python(PY_GREEN_SKIPPED)
        self.assertEqual((r["total"], r["passed"], r["failed"], r["skipped"]), (3, 2, 0, 1))

    def test_red_lists_every_failure_with_its_message(self):
        r = cs.parse_python(PY_RED)
        # 6 tests: test_err, test_eq and test_sub failed (test_sub twice, as two subTests), 1 skipped, 2 ok
        self.assertEqual((r["total"], r["failed"], r["skipped"], r["passed"]), (6, 3, 1, 2))
        titles = [t for t, _ in r["failures"]]
        self.assertEqual(titles, ["ERROR: test_err (test_demo.T.test_err)", "FAIL: test_eq (test_demo.T.test_eq)",
                                  "FAIL: test_sub (test_demo.T.test_sub) (i=0)", "FAIL: test_sub (test_demo.T.test_sub) (i=1)"])
        msgs = dict(r["failures"])
        self.assertEqual(msgs[titles[0]], ["ValueError: boom"])
        self.assertEqual(msgs[titles[2]], ["AssertionError: 0 != 5"])

    def test_the_assertion_diff_is_kept_but_the_traceback_frames_are_not(self):
        msg = dict(cs.parse_python(PY_RED)["failures"])["FAIL: test_eq (test_demo.T.test_eq)"]
        self.assertEqual(msg[0], "AssertionError: {'a': 1, 'b': [1, 2]} != {'a': 1, 'b': [1, 3]}")
        self.assertIn("+ {'a': 1, 'b': [1, 3]}", msg)
        self.assertFalse([l for l in msg if "File " in l or "~~~" in l or "^^^" in l])

    def test_windows_line_endings_parse_identically(self):
        self.assertEqual(cs.parse_python(crlf(PY_RED)), cs.parse_python(PY_RED))
        self.assertEqual(cs.parse_python(crlf(PY_GREEN)), cs.parse_python(PY_GREEN))

    def test_no_result_line_means_none(self):
        for text in ("", "\n\n", "Traceback (most recent call last):\n  File \"x.py\"\nImportError: nope\n",
                     "Ran 5 tests in 1s\n"):                       # a cut-off run: no OK/FAILED line
            with self.subTest(text=text[:20]):
                self.assertIsNone(cs.parse_python(text))

    def test_import_error_is_a_failure(self):
        log = ("E\n======================================================================\n"
               "ERROR: test_x (unittest.loader._FailedTest.test_x)\n"
               "----------------------------------------------------------------------\n"
               "Traceback (most recent call last):\n  File \"a.py\", line 1, in <module>\n    import nope\n"
               "ModuleNotFoundError: No module named 'nope'\n\n"
               "----------------------------------------------------------------------\n"
               "Ran 1 test in 0.000s\n\nFAILED (errors=1)\n")
        r = cs.parse_python(log)
        self.assertEqual((r["total"], r["failed"]), (1, 1))
        self.assertEqual(r["failures"][0][1], ["ModuleNotFoundError: No module named 'nope'"])


class TestParseJs(unittest.TestCase):
    def test_green(self):
        r = cs.parse_js(JS_GREEN)
        self.assertEqual((r["total"], r["passed"], r["failed"], r["skipped"]), (1, 1, 0, 0))
        self.assertEqual(r["failures"], [])

    def test_red_has_expected_and_actual(self):
        r = cs.parse_js(JS_RED)
        self.assertEqual((r["total"], r["passed"], r["failed"], r["skipped"]), (4, 1, 2, 1))
        title, detail = r["failures"][0]
        self.assertEqual(title, "not ok - bad one")
        self.assertIn("location: t.test.mjs:4:1", detail)       # only the file name, not the runner's path
        self.assertIn("1 !== 2", detail)
        self.assertIn("expected: 2", detail)
        self.assertIn("actual: 1", detail)
        self.assertFalse([l for l in detail if "node:internal" in l or "TestContext" in l])   # no stack

    def test_skipped_and_parent_suites_are_not_listed_as_failures(self):
        titles = [t for t, _ in cs.parse_js(JS_RED)["failures"]]
        self.assertEqual(titles, ["not ok - bad one", "not ok - inner"])      # not 'skipme', not 'suite'

    def test_windows_line_endings_parse_identically(self):
        self.assertEqual(cs.parse_js(crlf(JS_RED)), cs.parse_js(JS_RED))
        self.assertEqual(cs.parse_js(crlf(JS_GREEN)), cs.parse_js(JS_GREEN))

    def test_spec_reporter_counters_are_understood(self):
        r = cs.parse_js("✔ a (1ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n")
        self.assertEqual((r["total"], r["passed"], r["failed"]), (3, 3, 0))

    def test_no_counters_means_none(self):
        for text in ("", "TAP version 13\n", "node: bad option: --nope\n"):
            self.assertIsNone(cs.parse_js(text))


class TestBuildSummary(unittest.TestCase):
    def test_all_green(self):
        md = cs.build_summary("Linux", PY_GREEN, JS_GREEN, "success", "success", [("Syntax check", "success")])
        self.assertIn("### Tests: Linux", md)
        self.assertIn("| Python | ✅ passed | 91 | 91 | 0 | 0 |", md)
        self.assertIn("| JS | ✅ passed | 1 | 1 | 0 | 0 |", md)
        self.assertIn("| Syntax check | ✅ passed |", md)
        self.assertNotIn("failed tests", md)

    def test_red_shows_the_failures_in_code_blocks(self):
        md = cs.build_summary("Windows", PY_RED, JS_RED, "failure", "failure")
        self.assertIn("| Python | ❌ failed | 6 | 2 | 3 | 1 |", md)
        self.assertIn("#### Python: failed tests", md)
        self.assertIn("**FAIL: test_eq (test_demo.T.test_eq)**", md)
        self.assertIn("AssertionError: 0 != 5", md)
        self.assertIn("#### JS: failed tests", md)
        self.assertIn("expected: 2", md)
        self.assertEqual(md.count("```") % 2, 0)               # every fence is closed

    def test_a_failed_step_is_red_even_when_the_log_looks_green(self):
        # e.g. the process was killed after printing "OK" for an earlier phase, or tee ate the status
        md = cs.build_summary("x", PY_GREEN, JS_GREEN, "failure", "success")
        self.assertIn("| Python | ❌ failed |", md)
        self.assertIn("The step failed but the log lists no failed test", md)

    def test_a_step_that_did_not_run_says_so(self):
        md = cs.build_summary("x", None, None, "skipped", "skipped")
        self.assertIn("| Python | ⏭️ not run |", md)
        self.assertIn("| JS | ⏭️ not run |", md)

    def test_a_missing_log_after_a_failed_step_points_to_the_step_log(self):
        md = cs.build_summary("x", None, JS_GREEN, "failure", "success")
        self.assertIn("| Python | ❌ failed |", md)
        self.assertIn("No `python-tests.log` was written", md)

    def test_empty_or_unexpected_output_shows_the_tail_not_a_crash(self):
        log = "\n".join(f"line {i}" for i in range(40)) + "\nImportError: boom\n"
        md = cs.build_summary("x", log, "", "failure", "failure")
        self.assertIn("has no result line", md)
        self.assertIn("ImportError: boom", md)
        self.assertNotIn("line 3\n", md)                       # only the last lines
        self.assertIn("The JS log has no result line (it probably crashed before the tests ran). The log is empty.", md)

    def test_unknown_outcome_with_unparseable_log_is_not_called_green(self):
        md = cs.build_summary("x", "garbage", "garbage", None, None)
        self.assertIn("| Python | ❓ no result found |", md)

    def test_long_failure_lists_and_messages_are_capped(self):
        many = "".join(f"======================================================================\nFAIL: t{i} (m.C.t{i})\n"
                       f"----------------------------------------------------------------------\n"
                       f"Traceback (most recent call last):\n  File \"a.py\", line 1, in t\n    x\nAssertionError: {i}\n\n"
                       for i in range(cs.MAX_FAILURES + 5))
        md = cs.build_summary("x", many + "----------------------------------------------------------------------\n"
                              f"Ran 99 tests in 1s\n\nFAILED (failures={cs.MAX_FAILURES + 5})\n", None, "failure", None)
        self.assertIn(f"{cs.MAX_FAILURES - 1} (m.C.t{cs.MAX_FAILURES - 1})", md)
        self.assertNotIn(f"FAIL: t{cs.MAX_FAILURES} ", md)
        self.assertIn("... and 5 more failed tests", md)

    def test_backticks_in_a_message_cannot_break_the_page(self):
        log = ("======================================================================\nFAIL: t (m.C.t)\n"
               "----------------------------------------------------------------------\nTraceback (most recent call last):\n"
               "  File \"a.py\", line 1, in t\n    x\nAssertionError: ```code``` != y\n\n"
               "----------------------------------------------------------------------\nRan 1 test in 1s\n\nFAILED (failures=1)\n")
        md = cs.build_summary("x", log, None, "failure", None)
        self.assertIn("````\nAssertionError: ```code``` != y\n````", md)


class TestMain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="vwm_summary_")

    def path(self, name, text=None):
        p = os.path.join(self.tmp, name)
        if text is not None:
            with open(p, "w", encoding="utf-8", newline="") as fh:     # newline="": keep \r\n as given
                fh.write(text)
        return p

    def test_appends_to_the_step_summary_file(self):
        summary = self.path("summary.md", "earlier step\n")
        rc = cs.main(["--label", "L", "--python-log", self.path("p.log", PY_GREEN),
                      "--js-log", self.path("j.log", crlf(JS_GREEN)), "--python-outcome", "success",
                      "--js-outcome", "success", "--step", "Syntax check=success", "--step", "Compile=failure"],
                     env={"GITHUB_STEP_SUMMARY": summary})
        self.assertEqual(rc, 0)
        with open(summary, encoding="utf-8") as fh:
            text = fh.read()
        self.assertTrue(text.startswith("earlier step\n### Tests: L"))     # appended, not overwritten
        self.assertIn("| Compile | ❌ failed |", text)

    def test_prints_to_stdout_without_the_variable(self):
        out = io.StringIO()
        cs.main(["--label", "L", "--python-log", self.path("p.log", PY_GREEN)], env={}, out=out)
        self.assertIn("| Python | ✅ passed | 91 |", out.getvalue())

    def test_missing_log_files_do_not_crash(self):
        out = io.StringIO()
        rc = cs.main(["--label", "L", "--python-log", self.path("nope.log"), "--python-outcome", "failure"], env={}, out=out)
        self.assertEqual(rc, 0)
        self.assertIn("No `python-tests.log` was written", out.getvalue())

    def test_a_parser_bug_still_exits_zero_with_a_note(self):
        from unittest import mock
        out = io.StringIO()
        with mock.patch.object(cs, "build_summary", side_effect=RuntimeError("oops")):
            rc = cs.main(["--label", "L"], env={}, out=out)
        self.assertEqual(rc, 0)
        self.assertIn("could not be built", out.getvalue())


if __name__ == "__main__":
    unittest.main()
