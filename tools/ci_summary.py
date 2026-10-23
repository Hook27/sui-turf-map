#!/usr/bin/env python3
"""
Turns the test logs of the Tests workflow into a markdown summary for the run page.

GitHub shows whatever a step appends to the file named by $GITHUB_STEP_SUMMARY at the top
of the run page, rendered as markdown. Without this, a red check means scrolling through a
long log to find the one failing assertion. This script reads the logs the test steps wrote
(through `tee`) and writes: one table row per suite with the counts, the outcome of the
smaller checks, and for every failed test its name plus the expected/actual text.

    python tools/ci_summary.py --label "<matrix label>" --python-log python-tests.log \
        --js-log js-tests.log --python-outcome failure --js-outcome skipped \
        --step "Syntax check=success"

Stdlib only, no network. Without $GITHUB_STEP_SUMMARY (a local run) the markdown goes to
stdout. It never raises on a strange log: a summary that cannot be built is worse than a
summary that says "I could not read this".
"""

import argparse
import os
import re
import sys

MAX_FAILURES = 20      # per suite; more would bury the page (the full log stays in the step)
MAX_LINES = 15         # per failure
TAIL_LINES = 15        # what to show of a log we cannot make sense of

# Python's unittest prints its own result line, e.g. "FAILED (failures=1, errors=2, skipped=1)".
_PY_RAN = re.compile(r"^Ran (\d+) tests? in ")
_PY_RESULT = re.compile(r"^(OK|FAILED)\b(?:\s*\((.*)\))?\s*$")
_PY_HEADER = re.compile(r"^(FAIL|ERROR): (.+)$")
_PY_TEST_ID = re.compile(r"^(?:FAIL|ERROR): \S+ \([^)]*\)")      # "FAIL: test_x (mod.Class.test_x)"
_PY_FRAME = re.compile(r'^  File "')

# Node's test runner prints "# tests 5" (TAP reporter) or "ℹ tests 5" (spec reporter).
_JS_COUNT = re.compile(r"^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$")
_JS_NOT_OK = re.compile(r"^(\s*)not ok \d+ - (.*)$")
_JS_KEYS = ("error", "expected", "actual")


# ── Python (unittest) ─────────────────────────────────────────────────────────

def parse_python(text):
    """{"total", "failed", "skipped", "passed", "failures": [(title, detail)]} or None when
    the log has no result line (the run crashed before unittest could report)."""
    lines = text.splitlines()          # splitlines copes with \r\n (Windows) and \n (Linux)
    total = None
    status = None
    flags = {}
    for line in lines:
        m = _PY_RAN.match(line)
        if m:
            total = int(m.group(1))
        m = _PY_RESULT.match(line)
        if m:
            status = m.group(1)
            for part in (m.group(2) or "").split(","):
                k, _, v = part.strip().partition("=")
                if v.isdigit():
                    flags[k] = int(v)
    if total is None or status is None:
        return None
    failures = _python_failures(lines)
    # unittest counts a failing subTest per failure, but it is still ONE test in "Ran N tests".
    # The headers name the test first and the subTest parameters after it, so count distinct tests.
    failed = len({_PY_TEST_ID.match(t).group(0) if _PY_TEST_ID.match(t) else t for t, _ in failures})
    if not failures:
        failed = flags.get("failures", 0) + flags.get("errors", 0)
    skipped = flags.get("skipped", 0)
    return {
        "total": total,
        "failed": failed,
        "skipped": skipped,
        "passed": max(total - failed - skipped, 0),
        "failures": failures,
    }


def _python_failures(lines):
    found = []
    i = 0
    while i < len(lines):
        m = _PY_HEADER.match(lines[i])
        if not m:
            i += 1
            continue
        title = f"{m.group(1)}: {m.group(2)}"
        i += 1
        block = []
        # A block runs to the next ==== line (next failure) or ---- line (the "Ran N tests" footer);
        # the ---- line right under the header belongs to the header.
        if i < len(lines) and lines[i].startswith("-" * 10):
            i += 1
        while i < len(lines) and not lines[i].startswith(("=" * 10, "-" * 10)):
            block.append(lines[i])
            i += 1
        found.append((title, _python_message(block)))
    return found


def _python_message(block):
    """The exception line plus everything after it (for assertEqual that includes the diff).
    That is where `expected`/`actual` live in unittest output. The traceback frames above it
    are skipped: a frame is a `  File "..."` line followed by indented source lines."""
    last_frame = None
    for n, line in enumerate(block):
        if _PY_FRAME.match(line):
            last_frame = n
    start = 0 if last_frame is None else last_frame + 1
    while start < len(block) and (block[start].startswith("    ") or not block[start].strip()):
        start += 1
    message = block[start:]
    while message and not message[-1].strip():
        message.pop()
    return message


# ── JavaScript (node --test, TAP) ─────────────────────────────────────────────

def parse_js(text):
    """Same shape as parse_python, or None when the log has no "# tests N" counters."""
    lines = text.splitlines()
    counts = {}
    for line in lines:
        m = _JS_COUNT.match(line)
        if m:
            counts[m.group(1)] = int(m.group(2))
    if "tests" not in counts:
        return None
    return {
        "total": counts["tests"],
        "failed": counts.get("fail", 0),
        "skipped": counts.get("skipped", 0) + counts.get("todo", 0),
        "passed": counts.get("pass", 0),
        "failures": _js_failures(lines),
    }


def _js_failures(lines):
    found = []
    for i, line in enumerate(lines):
        m = _JS_NOT_OK.match(line)
        if not m or re.search(r"#\s*(SKIP|TODO)\b", m.group(2)):
            continue
        indent = len(m.group(1))
        sections = _yaml_block(lines, i + 1, indent + 2)
        if sections is None or "subtestsFailed" in "".join(sections.get("failureType", [""])):
            continue            # a suite whose children failed: the children are listed themselves
        detail = []
        loc = "".join(sections.get("location", [])).strip().strip("'\"")
        if loc:
            detail.append("location: " + re.split(r"[\\/]", loc)[-1])
        for key in _JS_KEYS:
            if key in sections:
                detail.extend(sections[key])
        found.append((f"not ok - {m.group(2)}", detail))
    return found


def _yaml_block(lines, start, indent):
    """Reads the `---` ... `...` block under a `not ok` line into {key: [lines]}, where the
    first line carries the inline value (or nothing for `|-` / nested blocks) and the rest
    are the continuation lines with their indentation reduced. None if there is no block.
    Only top-level keys are split; `stack:` is simply never asked for."""
    pad = " " * indent
    if start >= len(lines) or lines[start] != pad + "---":
        return None
    sections = {}
    key = None
    for line in lines[start + 1:]:
        if line == pad + "...":
            return sections
        m = re.match(re.escape(pad) + r"([A-Za-z_]\w*):(.*)$", line)
        if m:
            key = m.group(1)
            inline = m.group(2).strip()
            sections[key] = [] if inline in ("", "|", "|-", "|+") else [f"{key}: {inline}"]
            if not sections[key]:
                sections[key] = [f"{key}:"]
        elif key is not None and line.startswith(pad + "  "):
            sections[key].append(line[len(pad) + 2:])
        elif key is not None and not line.strip():
            sections[key].append("")
    return sections           # unterminated block: use what we have


# ── Markdown ──────────────────────────────────────────────────────────────────

def _fence(body_lines):
    """A code fence longer than any backtick run in the text, so a log line cannot close it early."""
    longest = max((len(r) for line in body_lines for r in re.findall(r"`+", line)), default=0)
    return "`" * max(3, longest + 1)


def _code_block(body_lines):
    fence = _fence(body_lines)
    return [fence] + body_lines + [fence]


def _cap(lines):
    lines = list(lines)
    while lines and not lines[-1].strip():
        lines.pop()
    if len(lines) > MAX_LINES:
        lines = lines[:MAX_LINES] + [f"... ({len(lines) - MAX_LINES} more lines, see the step log)"]
    return lines


def _status(parsed, outcome):
    """Combines what we parsed with GitHub's own verdict for the step. The step outcome wins on
    disagreement towards red: a step that failed without the log saying so (an import error, a
    killed process) must not show as green."""
    if outcome in ("skipped", "failure", "cancelled"):
        return _step_status(outcome)
    if parsed is None:
        return "❓ no result found"
    return "❌ failed" if parsed["failed"] else "✅ passed"


def _step_status(outcome):
    return {"success": "✅ passed", "failure": "❌ failed", "skipped": "⏭️ not run",
            "cancelled": "⚪ cancelled"}.get(outcome, "❓ unknown")


def suite_section(name, text, outcome, log_label):
    """(table row, [detail lines]) for one test suite."""
    if text is None and outcome in (None, "skipped"):
        return f"| {name} | ⏭️ not run | | | | |", []
    parsed = parse_python_or_js(name, text) if text is not None else None
    status = _status(parsed, outcome)
    if parsed is None:
        row = f"| {name} | {status} | | | | |"
        detail = []
        if text is None:
            detail = [f"No `{log_label}` was written, so there is nothing to show; open the step log."]
        else:
            tail = [l for l in text.splitlines() if l.strip()][-TAIL_LINES:]
            detail = [f"The {name} log has no result line (it probably crashed before the tests ran)."
                      + (" Last lines:" if tail else " The log is empty."), ""]
            if tail:
                detail += _code_block(tail)
        return row, [f"#### {name}", ""] + detail + [""]
    row = (f"| {name} | {status} | {parsed['total']} | {parsed['passed']} | "
           f"{parsed['failed']} | {parsed['skipped']} |")
    detail = []
    if parsed["failures"]:
        detail += [f"#### {name}: failed tests", ""]
        for title, message in parsed["failures"][:MAX_FAILURES]:
            detail += [f"**{title}**", ""] + (_code_block(_cap(message)) if message else ["_(no details in the log)_"]) + [""]
        extra = len(parsed["failures"]) - MAX_FAILURES
        if extra > 0:
            detail += [f"... and {extra} more failed tests; see the step log.", ""]
    elif status.startswith("❌"):
        detail = [f"#### {name}", "",
                  "The step failed but the log lists no failed test (a crash or import error); open the step log.", ""]
    return row, detail


def parse_python_or_js(name, text):
    return parse_python(text) if name == "Python" else parse_js(text)


def build_summary(label, python_log, js_log, python_outcome=None, js_outcome=None, steps=()):
    """The whole markdown document. `steps` is [(name, outcome)] for the smaller checks."""
    lines = [f"### Tests: {label}", "",
             "| Suite | Result | Tests | Passed | Failed | Skipped |",
             "|---|---|---:|---:|---:|---:|"]
    details = []
    for name, text, outcome, log_label in (("Python", python_log, python_outcome, "python-tests.log"),
                                           ("JS", js_log, js_outcome, "js-tests.log")):
        row, detail = suite_section(name, text, outcome, log_label)
        lines.append(row)
        details += detail
    for name, outcome in steps:
        lines.append(f"| {name} | {_step_status(outcome)} | | | | |")
    return "\n".join(lines + [""] + details).rstrip() + "\n"


def _read(path):
    if not path:
        return None
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


def _split_step(arg):
    name, _, outcome = arg.rpartition("=")
    return (name or arg), (outcome or None)


def main(argv=None, env=None, out=None):
    env = os.environ if env is None else env
    out = sys.stdout if out is None else out
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--label", default="")
    ap.add_argument("--python-log")
    ap.add_argument("--js-log")
    ap.add_argument("--python-outcome")
    ap.add_argument("--js-outcome")
    ap.add_argument("--step", action="append", default=[], help="NAME=outcome of a smaller check")
    args = ap.parse_args(argv)
    try:
        md = build_summary(args.label, _read(args.python_log), _read(args.js_log),
                           args.python_outcome, args.js_outcome, [_split_step(s) for s in args.step])
    except Exception as e:            # never lose the summary (or the job) to a parsing surprise
        md = f"### Tests: {args.label}\n\nThe summary could not be built: `{e!r}`. Open the step logs.\n"
    target = env.get("GITHUB_STEP_SUMMARY")
    if target:
        # Append: other steps may write to the same file, and so may a re-run of this one.
        with open(target, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(md)
    else:
        # The markdown holds emoji; a Windows console defaults to a codepage that cannot print them.
        if hasattr(out, "reconfigure"):
            out.reconfigure(encoding="utf-8")
        out.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
