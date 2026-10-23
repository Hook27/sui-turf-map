#!/usr/bin/env python3
"""
Opens a GitHub issue when the daily map update fails (or comments on the one that is
already open), so a red run does not go unnoticed for days.

Called by the `notify` job of .github/workflows/update.yml. It talks to GitHub through the
`gh` command line tool, which is preinstalled on GitHub's runners and picks up its login
from $GH_TOKEN and the repository from $GH_REPO.

Deduplication: while an issue titled TITLE is open, every further failure only adds a
comment to it. Close the issue once the map is fresh again; the next failure opens a new
one. (Matching is on the exact title, not on a label: `gh issue create --label X` fails
outright when X does not exist in the repository.)

This script must never make things worse. The run it reports on has already failed; if
opening the issue also fails, the reason is printed as a ::warning and the exit code stays 0.

Stdlib only. `gh` is injectable (see report_failure) so the tests can use a fake.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

TITLE = "Daily map update failed"


def run_gh(args):
    """Runs `gh <args>`; returns (exit code, stdout). Never raises: a missing gh or a hang
    becomes a nonzero code so the caller handles one failure shape."""
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        return 127, "gh is not installed"
    except subprocess.TimeoutExpired:
        return 124, "gh timed out"
    return p.returncode, (p.stdout if p.returncode == 0 else (p.stderr or p.stdout))


def run_url(env):
    return f"{env.get('GITHUB_SERVER_URL', 'https://github.com')}/{env.get('GITHUB_REPOSITORY', '?')}/actions/runs/{env.get('GITHUB_RUN_ID', '?')}"


def describe_failure(env):
    """Which job broke, in words: a failed gate means the freshness check itself broke
    (the fetch never started); a failed fetch is the data run."""
    failed = []
    if env.get("GATE_RESULT") == "failure":
        failed.append("`gate` (the freshness check; the data fetch never started)")
    if env.get("FETCH_RESULT") == "failure":
        failed.append("`fetch` (the data run)")
    return " and ".join(failed) or "unknown (no failed job reported)"


def build_body(env, now=None):
    now = now or datetime.now(timezone.utc)
    src = env.get("SRC") or ""
    trigger = env.get("EVENT_NAME") or "unknown"
    if src:
        trigger += f" ({src})"
    return "\n".join([
        f"Failed job: {describe_failure(env)}",
        f"Trigger: {trigger}",
        f"Time: {now.strftime('%Y-%m-%d %H:%M UTC')}",
        f"Run: {run_url(env)}",
    ])


def find_open_issue(gh, title=TITLE):
    """Number of the open issue with exactly this title, None if there is none.
    Raises RuntimeError when the listing itself fails. We list instead of using --search:
    the search index lags a little behind, and a lagging index means a duplicate issue."""
    code, out = gh(["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title"])
    if code != 0:
        raise RuntimeError(f"gh issue list failed ({code}): {out.strip()[:300]}")
    try:
        issues = json.loads(out)
        matches = [i["number"] for i in issues if str(i.get("title", "")).strip() == title]
    except (ValueError, TypeError, KeyError, AttributeError) as e:
        raise RuntimeError(f"unreadable issue list: {e!r}")
    return min(matches) if matches else None


def report_failure(gh, env, now=None):
    """Creates the issue or comments on the open one. Returns ("created" | "commented" | "failed", detail).
    Never raises."""
    body = build_body(env, now)
    try:
        number = find_open_issue(gh)
    except RuntimeError as e:
        # Without the listing we cannot tell whether an issue is open. A duplicate issue is
        # a smaller problem than silence about a failed daily run, so go on and create one.
        print(f"::warning title=ci_notify::{e}")
        number = None
    if number is not None:
        code, out = gh(["issue", "comment", str(number), "--body", "Failed again.\n\n" + body])
        if code == 0:
            return "commented", f"#{number}"
        return "failed", f"gh issue comment #{number} failed ({code}): {out.strip()[:300]}"
    code, out = gh(["issue", "create", "--title", TITLE,
                    "--body", body + "\n\nThe map keeps showing the last data that was committed. "
                    "Re-run the failed jobs from the run page once the cause is fixed. "
                    "Close this issue when the map is fresh again; the next failure then opens a new one."])
    if code == 0:
        return "created", out.strip()
    return "failed", f"gh issue create failed ({code}): {out.strip()[:300]}"


def main(env=None, gh=run_gh):
    env = os.environ if env is None else env
    try:
        what, detail = report_failure(gh, env)
    except Exception as e:                       # belt and braces: nothing here may fail the job
        what, detail = "failed", repr(e)
    if what == "failed":
        print(f"::warning title=ci_notify::could not report the failed run: {detail}")
    else:
        print(f"issue {what}: {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
