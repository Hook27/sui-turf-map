"""
Compact long-term daily tile history, stdlib only.

player_history_daily.json (the legacy file) stores the full {pid: tiles} map of every
player for every day. At ~4,900 players that is ~346 KB per day (72 MB by October 2026,
GitHub rejects files over 100 MB) although only ~20 values change per day, and every page
load downloaded it. This module keeps the same information as a delta file:

    player_history_daily_v2.json
    {"format": 2, "updated": iso,
     "base":    {"date": "YYYY-MM-DD", "players": {pid: tiles}},          # the first day, in full
     "changes": [{"date": "YYYY-MM-DD", "p": {pid: tiles | null}}, ...]}  # one entry PER DAY

Each change entry holds only the players whose count differs from the day before; null
means the player does not exist that day. Every day has an entry, even an empty one, so
the number of days and their dates survive. The legacy file is converted once (verified
lossless) and then removed by update(). The reader in the browser is
modules/daily-history.js, which also understands the legacy format.
"""

import json
import os

FORMAT = 2


def _is_count(v):
    return isinstance(v, int) and not isinstance(v, bool)


def is_v2(h):
    """True for a structurally valid v2 history: dates strictly increasing, integer counts."""
    if not isinstance(h, dict) or h.get("format") != FORMAT:
        return False
    base, changes = h.get("base"), h.get("changes")
    if not (isinstance(base, dict) and isinstance(base.get("date"), str) and isinstance(base.get("players"), dict)):
        return False
    if not all(_is_count(v) for v in base["players"].values()):
        return False
    if not isinstance(changes, list):
        return False
    last = base["date"]
    for c in changes:
        if not (isinstance(c, dict) and isinstance(c.get("date"), str) and isinstance(c.get("p"), dict)):
            return False
        if c["date"] <= last:
            return False
        if not all(v is None or _is_count(v) for v in c["p"].values()):
            return False
        last = c["date"]
    return True


def last_date(h):
    return h["changes"][-1]["date"] if h["changes"] else h["base"]["date"]


def _delta(prev, counts):
    """The entry for a day: what differs from the previous day's {pid: tiles}."""
    p = {k: v for k, v in counts.items() if prev.get(k) != v}
    for k in prev:
        if k not in counts:
            p[k] = None
    return p


def _apply(state, p):
    for k, v in p.items():
        if v is None:
            state.pop(k, None)
        else:
            state[k] = v


def replay(h):
    """The {pid: tiles} map of the latest day."""
    state = dict(h["base"]["players"])
    for c in h["changes"]:
        _apply(state, c["p"])
    return state


def to_days(h):
    """Back to the legacy shape [{date, players}] — used to verify the conversion."""
    state = dict(h["base"]["players"])
    days = [{"date": h["base"]["date"], "players": dict(state)}]
    for c in h["changes"]:
        _apply(state, c["p"])
        days.append({"date": c["date"], "players": dict(state)})
    return days


def from_legacy(legacy):
    """Convert a legacy {days: [{date, players}]} to v2. None if the input is unusable
    (not a dict, no days, a malformed or unordered day) or if the result does not reproduce
    every day exactly — a conversion is only ever trusted when it is provably lossless."""
    days = legacy.get("days") if isinstance(legacy, dict) else None
    if not isinstance(days, list) or not days:
        return None
    clean = []
    for d in days:
        if not (isinstance(d, dict) and isinstance(d.get("date"), str) and isinstance(d.get("players"), dict)):
            return None
        if not all(_is_count(v) for v in d["players"].values()):
            return None
        if clean and d["date"] == clean[-1]["date"]:
            clean[-1] = d                                   # a duplicated date: the last one wins
        elif clean and d["date"] < clean[-1]["date"]:
            return None                                     # unordered: refuse rather than guess
        else:
            clean.append(d)
    changes, prev = [], clean[0]["players"]
    for d in clean[1:]:
        changes.append({"date": d["date"], "p": _delta(prev, d["players"])})
        prev = d["players"]
    h = {"format": FORMAT, "updated": legacy.get("updated"),
         "base": {"date": clean[0]["date"], "players": dict(clean[0]["players"])}, "changes": changes}
    back = to_days(h)
    if len(back) != len(clean) or any(b["date"] != c["date"] or b["players"] != c["players"] for b, c in zip(back, clean)):
        return None
    return h


def append_day(h, date, counts):
    """Record `date`'s {pid: tiles}. Returns "appended", "replaced" (the same date again: the
    last run of the day wins, as before) or "stale" (a date before the last one: history is
    never rewritten, nothing changes)."""
    counts = {k: int(v) for k, v in counts.items()}
    last = last_date(h)
    if date < last:
        return "stale"
    if date == last:
        if h["changes"]:
            h["changes"].pop()
            h["changes"].append({"date": date, "p": _delta(replay(h), counts)})
        else:
            h["base"] = {"date": date, "players": counts}
        return "replaced"
    h["changes"].append({"date": date, "p": _delta(replay(h), counts)})
    return "appended"


def _read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)


def update(v2_path, legacy_path, date, counts, updated):
    """Add today's counts to the v2 file, seeding it from the legacy file when needed, and
    remove the legacy file once the v2 file provably contains all of it.

    Returns {"days", "bytes", "how", "converted", "legacy_removed", "warnings"}.
    Raises on a failed write; the legacy file is only ever deleted AFTER the new file has
    been written, re-read and checked, so an exception leaves the old data untouched.
    """
    warnings = []
    v2 = _read(v2_path) if os.path.exists(v2_path) else None
    if os.path.exists(v2_path) and not is_v2(v2):          # present but corrupt or of another shape
        warnings.append(f"{os.path.basename(v2_path)} is unreadable, rebuilding it from the legacy file")
        v2 = None
    legacy = _read(legacy_path) if os.path.exists(legacy_path) else None
    seed = from_legacy(legacy) if legacy is not None else None
    if os.path.exists(legacy_path) and seed is None:
        warnings.append(f"{os.path.basename(legacy_path)} could not be converted losslessly, left untouched")

    converted = False
    if v2 is None or (seed is not None and last_date(seed) > last_date(v2)):
        v2, converted = seed, seed is not None
    if v2 is None:                                          # nothing to continue from: day one
        v2 = {"format": FORMAT, "base": {"date": date, "players": {k: int(c) for k, c in counts.items()}}, "changes": []}
        how = "created"
    else:
        how = append_day(v2, date, counts)
    v2["updated"] = updated

    _write(v2_path, v2)
    check = _read(v2_path)                                  # trust the disk, not memory
    if not is_v2(check) or (how != "stale" and replay(check) != {k: int(c) for k, c in counts.items()}):
        raise RuntimeError(f"{os.path.basename(v2_path)} did not read back correctly")

    legacy_removed = False
    if seed is not None and os.path.exists(legacy_path):
        have = {d["date"]: d["players"] for d in to_days(check)}
        if all(have.get(d["date"]) == d["players"] for d in legacy["days"] if isinstance(d, dict)):
            os.remove(legacy_path)
            legacy_removed = True
        else:
            warnings.append(f"{os.path.basename(legacy_path)} differs from {os.path.basename(v2_path)}, kept")
    return {"days": 1 + len(check["changes"]), "bytes": os.path.getsize(v2_path), "how": how,
            "converted": converted, "legacy_removed": legacy_removed, "warnings": warnings}
