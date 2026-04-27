#!/usr/bin/env python3
"""
Vendetta Weekly Report Generator
Compares snapshots from the last 7 days, computes stats,
calls the Anthropic API for a Roaring Twenties newspaper article,
and writes weekly_report.json.

Requires: ANTHROPIC_API_KEY environment variable
"""

import json, os, glob, sys, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

SNAPSHOTS_DIR    = "snapshots"
HQ_CAPTURES_FILE = "hq_captures.json"
REPORT_FILE      = "weekly_report.json"
ANTHROPIC_API    = "https://api.anthropic.com/v1/messages"
MODEL            = "claude-sonnet-4-6"

# ── LOAD SNAPSHOTS FROM LAST 7 DAYS ──────────────────────────────────────────
now_utc   = datetime.now(timezone.utc)
cutoff    = now_utc - timedelta(days=7)

all_snaps = sorted(glob.glob(f"{SNAPSHOTS_DIR}/data_*.json"))
week_snaps = []
for path in all_snaps:
    ts_str = os.path.basename(path)[5:-5]
    try:
        dt = datetime.strptime(ts_str, "%Y-%m-%d_%H%M").replace(tzinfo=timezone.utc)
        if dt >= cutoff:
            week_snaps.append((dt, path))
    except ValueError:
        continue

if len(week_snaps) < 2:
    print("Not enough snapshots in the last 7 days to generate a report.")
    sys.exit(0)

week_snaps.sort(key=lambda x: x[0])  # oldest first
dt_oldest, path_oldest = week_snaps[0]
dt_newest, path_newest = week_snaps[-1]

print(f"Comparing {len(week_snaps)} snapshots: {dt_oldest.date()} → {dt_newest.date()}")

def load_snap(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

snap_old = load_snap(path_oldest)
snap_new = load_snap(path_newest)

# ── TURF STATS ────────────────────────────────────────────────────────────────
def player_map(snap):
    return {p["pid"]: p for p in snap.get("players", [])}

old_players = player_map(snap_old)
new_players = player_map(snap_new)

all_pids = set(old_players) | set(new_players)

changes = []
for pid in all_pids:
    old_p = old_players.get(pid)
    new_p = new_players.get(pid)
    old_tiles = old_p["tiles"] if old_p else 0
    new_tiles = new_p["tiles"] if new_p else 0
    net = new_tiles - old_tiles
    name = (new_p or old_p).get("name") or "[unknown]"
    changes.append({"pid": pid, "name": name, "old": old_tiles, "new": new_tiles, "net": net})

# Garrison delta per player
def build_pid_index(snap):
    return {p["pid"]: i for i, p in enumerate(snap.get("players", []))}

old_pid_idx = build_pid_index(snap_old)
new_pid_idx = build_pid_index(snap_new)

def garrison_for_pid(snap, pid_idx_map, pid):
    idx = pid_idx_map.get(pid)
    if idx is None:
        return 0
    total = 0
    for t in snap.get("tiles", []):
        if t.get("p") == idx:
            total += t.get("g_h", 0) + t.get("g_b", 0) + t.get("g_e", 0)
    return total

garrison_changes = []
for pid in all_pids:
    name = (new_players.get(pid) or old_players.get(pid) or {}).get("name") or "[unknown]"
    g_old = garrison_for_pid(snap_old, old_pid_idx, pid)
    g_new = garrison_for_pid(snap_new, new_pid_idx, pid)
    delta = g_new - g_old
    if delta != 0:
        garrison_changes.append({"name": name, "delta": delta, "g_new": g_new})

top_garrison_growers   = sorted([g for g in garrison_changes if g["delta"] > 0],
                                  key=lambda x: -x["delta"])[:5]
top_garrison_shrinkers = sorted([g for g in garrison_changes if g["delta"] < 0],
                                  key=lambda x:  x["delta"])[:5]

gainers   = sorted([c for c in changes if c["net"] > 0],  key=lambda x: -x["net"])[:10]
losers    = sorted([c for c in changes if c["net"] < 0],  key=lambda x:  x["net"])[:10]
newcomers = [c for c in changes if c["old"] == 0 and c["new"] > 0]
vanished  = [c for c in changes if c["old"] > 0 and c["new"] == 0]

total_old = snap_old.get("total_tiles", 0) - snap_old.get("unclaimed", 0)
total_new = snap_new.get("total_tiles", 0) - snap_new.get("unclaimed", 0)
player_count_old = len(old_players)
player_count_new = len(new_players)

# ── HQ CAPTURES THIS WEEK ─────────────────────────────────────────────────────
try:
    with open(HQ_CAPTURES_FILE, encoding="utf-8") as f:
        all_captures = json.load(f)
except Exception:
    all_captures = []

week_captures = [
    c for c in all_captures
    if datetime.fromisoformat(c["timestamp"]) >= cutoff
]

# Count captures per attacker
hq_cap_count = {}
for c in week_captures:
    hq_cap_count[c["new_name"] or c["new_pid"][:8]] = \
        hq_cap_count.get(c["new_name"] or c["new_pid"][:8], 0) + 1
top_hq_capturers = sorted(hq_cap_count.items(), key=lambda x: -x[1])[:5]

# Count losses per victim
hq_loss_count = {}
for c in week_captures:
    hq_loss_count[c["prev_name"] or c["prev_pid"][:8]] = \
        hq_loss_count.get(c["prev_name"] or c["prev_pid"][:8], 0) + 1
top_hq_victims = sorted(hq_loss_count.items(), key=lambda x: -x[1])[:5]

# ── RAID STATS THIS WEEK ──────────────────────────────────────────────────────
RAIDS_FILE = "raids.json"
try:
    with open(RAIDS_FILE, encoding="utf-8") as f:
        all_raids = json.load(f)
except Exception:
    all_raids = []

HQ_DESTROYED_FILE = "hq_destroyed.json"
try:
    with open(HQ_DESTROYED_FILE, encoding="utf-8") as f:
        all_hqd = json.load(f)
except Exception:
    all_hqd = []

week_raids = [
    r for r in all_raids
    if datetime.fromisoformat(r["timestamp"]) >= cutoff
    and r.get("defender_name")  # exclude failed raids / free turf attacks
]

CASH_THRESHOLD = 1.0
pure_captures     = [r for r in week_raids if r.get("is_capture") and r.get("cash", 0) <= CASH_THRESHOLD]
capture_and_raids = [r for r in week_raids if r.get("is_capture") and r.get("cash", 0) > CASH_THRESHOLD]
pure_raids        = [r for r in week_raids if not r.get("is_capture")]

# Top attackers per type
capture_count = {}
for r in pure_captures + capture_and_raids:
    name = r.get("attacker_name") or r.get("attacker_pid","")[:8]
    capture_count[name] = capture_count.get(name, 0) + 1
top_capturers = sorted(capture_count.items(), key=lambda x: -x[1])[:5]

raid_count = {}
for r in pure_raids + capture_and_raids:
    name = r.get("attacker_name") or r.get("attacker_pid","")[:8]
    raid_count[name] = raid_count.get(name, 0) + 1
top_raiders = sorted(raid_count.items(), key=lambda x: -x[1])[:5]

# Most targeted victims per type
capture_victim_count = {}
for r in pure_captures + capture_and_raids:
    name = r.get("defender_name") or r.get("defender_pid","")[:8]
    capture_victim_count[name] = capture_victim_count.get(name, 0) + 1
top_capture_victims = sorted(capture_victim_count.items(), key=lambda x: -x[1])[:5]

raid_victim_count = {}
for r in pure_raids + capture_and_raids:
    name = r.get("defender_name") or r.get("defender_pid","")[:8]
    raid_victim_count[name] = raid_victim_count.get(name, 0) + 1
top_raid_victims = sorted(raid_victim_count.items(), key=lambda x: -x[1])[:5]

week_hqd = [
    d for d in all_hqd
    if datetime.fromisoformat(d["timestamp"]) >= cutoff
]
# Top HQ destroyers
hqd_count = {}
for d in week_hqd:
    name = d.get("attacker_name") or d.get("attacker_pid","")[:8]
    hqd_count[name] = hqd_count.get(name, 0) + 1
top_hqd = sorted(hqd_count.items(), key=lambda x: -x[1])[:5]

# Loot stats — only from raids (pure_raids + capture_and_raids)
loot_raids    = pure_raids + capture_and_raids
total_cash    = sum(r.get("cash", 0)    for r in loot_raids)
total_weapons = sum(r.get("weapons", 0) for r in loot_raids)
total_xp      = sum(r.get("xp", 0)     for r in loot_raids)
biggest_raid  = max(loot_raids, key=lambda r: r.get("cash",0)+r.get("weapons",0), default=None)

# ── BUILD STATS SUMMARY ───────────────────────────────────────────────────────
def fmt_list(items, key_name="name", val_name="net", prefix="+"):
    lines = []
    for it in items:
        name = it[key_name] if isinstance(it, dict) else it[0]
        val  = it[val_name] if isinstance(it, dict) else it[1]
        sign = "+" if val > 0 else ""
        lines.append(f"  - {name}: {sign}{val} turfs")
    return "\n".join(lines) if lines else "  (none)"

raid_section = f"""
ATTACKS THIS WEEK:
- Pure captures (territory only, no loot): {len(pure_captures)}
- Raids (loot only, no capture):           {len(pure_raids)}
- Capture + Raid (territory AND loot):     {len(capture_and_raids)}

MOST ACTIVE TERRITORY ATTACKERS (captures):
{chr(10).join(f"  - {name}: {cnt} capture(s)" for name, cnt in top_capturers) or "  (none)"}

MOST TARGETED TERRITORIES:
{chr(10).join(f"  - {name}: captured from {cnt} time(s)" for name, cnt in top_capture_victims) or "  (none)"}

MOST ACTIVE RAIDERS (loot attacks only):
{chr(10).join(f"  - {name}: {cnt} raid(s)" for name, cnt in top_raiders) or "  (none)"}

MOST RAIDED PLAYERS:
{chr(10).join(f"  - {name}: raided {cnt} time(s)" for name, cnt in top_raid_victims) or "  (none)"}

TOTAL LOOT THIS WEEK (raids only):
- Cash:    {total_cash:,.2f}
- Weapons: {total_weapons:,.2f}
- XP:      {total_xp:,.2f}

HQ DESTROYED (attacked but defender held ground): {len(week_hqd)} total
{chr(10).join(f"  - {name}: destroyed {cnt} HQ(s)" for name, cnt in top_hqd) or "  (none)"}

BIGGEST SINGLE RAID:
{f"  - {biggest_raid['attacker_name'] or '[unknown]'} raided {biggest_raid['defender_name'] or '[unknown]'} — ${biggest_raid['cash']:.2f} cash, {biggest_raid['weapons']:.2f} arms, {biggest_raid['xp']:.2f} XP" if biggest_raid else "  (none)"}
""".strip()

stats_text = f"""
WEEK: {dt_oldest.strftime('%B %d')} – {dt_newest.strftime('%B %d, %Y')}

TERRITORY OVERVIEW
- Occupied turfs at start of week: {total_old:,}
- Occupied turfs at end of week:   {total_new:,}
- Net change: {total_new - total_old:+,} turfs
- Active players at start: {player_count_old}
- Active players at end:   {player_count_new}

TOP GAINERS (turfs claimed this week):
{fmt_list(gainers)}

TOP LOSERS (turfs lost this week):
{fmt_list(losers)}

GARRISON CHANGES THIS WEEK:
BIGGEST ARMY BUILDERS (garrison units added):
{chr(10).join(f"  - {g['name']}: +{g['delta']} units (now {g['g_new']})" for g in top_garrison_growers) or "  (none)"}

BIGGEST ARMY LOSSES (garrison units removed):
{chr(10).join(f"  - {g['name']}: {g['delta']} units (now {g['g_new']})" for g in top_garrison_shrinkers) or "  (none)"}

NEW PLAYERS APPEARING THIS WEEK ({len(newcomers)} total):
{chr(10).join(f"  - {c['name']} ({c['new']} turfs)" for c in newcomers[:8]) or "  (none)"}

PLAYERS WHO VANISHED THIS WEEK ({len(vanished)} total):
{chr(10).join(f"  - {c['name']} (had {c['old']} turfs)" for c in vanished[:8]) or "  (none)"}

HQ CAPTURES THIS WEEK: {len(week_captures)} total
Recent captures:
{chr(10).join(f"  - {c['new_name'] or '[unknown]'} stormed {c['prev_name'] or '[unknown]'}'s HQ ({c['timestamp'][:10]})" for c in week_captures[-10:]) or "  (none)"}

MOST FEARED ATTACKERS (HQ captures):
{chr(10).join(f"  - {name}: {cnt} HQ(s) captured" for name, cnt in top_hq_capturers) or "  (none)"}

MOST TARGETED BOSSES (HQ losses):
{chr(10).join(f"  - {name}: lost HQ {cnt} time(s)" for name, cnt in top_hq_victims) or "  (none)"}

{raid_section}
""".strip()

print("Stats computed. Calling Anthropic API...")
print(stats_text)

# ── CALL ANTHROPIC API ────────────────────────────────────────────────────────
api_key = os.environ.get("ANTHROPIC_API_KEY", "")
if not api_key:
    print("ERROR: ANTHROPIC_API_KEY not set.")
    sys.exit(1)

# Load previous report text for continuity
REPORT_FILE = "weekly_report.json"
prev_report_text = ""
try:
    with open(REPORT_FILE, encoding="utf-8") as f:
        prev_report = json.load(f)
    prev_html = prev_report.get("html", "")
    if prev_html:
        # Strip HTML tags to get plain text for the prompt
        import re as _re
        prev_report_text = _re.sub(r'<[^>]+>', ' ', prev_html)
        prev_report_text = _re.sub(r'\s+', ' ', prev_report_text).strip()
        prev_report_text = prev_report_text[:3000]  # cap at 3000 chars to control cost
        print(f"  Previous report loaded ({len(prev_report_text)} chars)")
except Exception:
    print("  No previous report found — writing first edition")

prev_context = f"""
PREVIOUS EDITION (last week's article — use this for narrative continuity, reference ongoing storylines, feuds and power shifts, but do NOT repeat the same events):
{prev_report_text}
""" if prev_report_text else ""

prompt = f"""You are the editor of THE VENDETTA GAZETTE, a sensationalist criminal underworld newspaper written in the style of the 1920s Roaring Twenties. Write a dramatic, entertaining front-page newspaper article based on the following weekly statistics from the criminal territory wars of Vendetta City.

GAME MECHANICS KNOWLEDGE (use this to write accurate, flavourful stories):
- Players build criminal empires by capturing turfs (tiles on a map) and defending them with gangsters
- Three gangster types: Henchmen (weakest), Bouncers (medium), Enforcers (strongest)
- Attacking: a player selects gangsters and chooses Raid, Capture, or both
  * Raid = steal cash, weapons and XP from the defender (~11% of stored resources, max 500 cash/weapons)
  * Capture = take ownership of the tile
- An attacker NEVER loses their own turfs by attacking, but CAN lose gangsters in the fight
- HQ (Headquarters): every player has one special tile as their base
  * 0–10 defenders: normal fight, attacker can capture the HQ tile. The previous owner gets another turf promoted to new HQ — unless it was their last turf, in which case they are eliminated. Eliminated players keep their XP and some resources for a fresh start.
  * 11+ defenders: the game randomly picks 10 to fight. Even if the attacker wins the battle, the tile is NOT captured — the HQ stands. This is a "HQ Destroyed" event.
- Cooldowns after an attack:
  * Capture Shield: 1 hour (tile cannot be captured again)
  * Raid Protection: 2 hours (tile cannot be raided again)
  * After an HQ attack: 6 hours raid protection
- Ghost turfs: abandoned tiles with little or no garrison — easy targets for expansion
- The leaderboard ranks players by number of turfs held
- Garrison = the total number of gangsters deployed across all turfs of a player
  (summed from each turf's individual garrison)
- Garrison growth means a player is training and deploying more gangsters —
  building military strength. Use this for narrative: a growing garrison = a boss
  who is fortifying, preparing for war, or expanding capacity.
- Garrison shrinkage can mean: gangsters lost in battles, units recalled to HQ,
  or strategic repositioning.
- There are THREE distinct attack types on player-owned turfs:
  * Capture = take ownership of a turf, NO resources looted (cash = 0)
  * Raid = steal resources ONLY, turf stays with defender
  * Capture+Raid = take ownership AND loot resources
- IMPORTANT: Do NOT call captures "raids" — they are territorial assaults.
  A player with many captures is a conqueror, not a raider.
  Only use the word "raids" when the attacker actually looted resources (cash > 0).
- Net turf gain (from snapshot comparison) and capture count (from attack log)
  are related but different: captures show how active a player was attacking,
  net gain shows the result after also accounting for turfs lost to others.
  Do NOT present both numbers as if they describe separate events — the captures
  are HOW the net gain was achieved (partially). Use net gain as the headline number.

Rules:
- Write in authentic 1920s newspaper prose: florid, dramatic, with colourful nicknames and underworld slang
- Use real player names from the data as criminal bosses, gang leaders and mob figures
- Invent vivid 1920s nicknames where it adds flavour (e.g. "Wu-Tang, the Iron Fist of the East Side")
- Cover the top stories: biggest territorial gains, dramatic HQ raids, rising newcomers, fallen bosses
- Include a "SPECIAL BULLETIN" sidebar for the most dramatic HQ capture of the week if one occurred
- End with a short "POLICE BLOTTER" section with 2–3 humorous one-liners about minor incidents
- If a previous edition is provided, weave in narrative continuity — reference ongoing feuds, power shifts or characters from last week where relevant. The reader should feel this is an ongoing serial.
- Output clean HTML only — no markdown, no code fences, no explanatory text outside the article
- Use these HTML elements for structure: <h1> for the newspaper name, <h2> for the date/edition line, <h3> for article headlines, <p> for body text, <blockquote> for sidebar/bulletin, <hr> for section dividers, <em> and <strong> for emphasis
- Keep the total length to roughly 600–900 words of body text
{prev_context}
WEEKLY STATISTICS:
{stats_text}
"""

payload = json.dumps({
    "model":      MODEL,
    "max_tokens": 2000,
    "messages":   [{"role": "user", "content": prompt}]
}).encode("utf-8")

req = urllib.request.Request(
    ANTHROPIC_API,
    data=payload,
    headers={
        "Content-Type":      "application/json",
        "x-api-key":         api_key,
        "anthropic-version": "2023-06-01",
    }
)

try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"API error {e.code}: {body}")
    sys.exit(1)

article_html = ""
for block in result.get("content", []):
    if block.get("type") == "text":
        article_html += block["text"]

if not article_html.strip():
    print("ERROR: Empty response from API.")
    sys.exit(1)

print("Article generated successfully.")

# ── SVG CHARTS ────────────────────────────────────────────────────────────────
def esc_svg(s):
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')

def svg_bar_chart(title, items, color_pos='#c8a84a', color_neg='#8b1a1a', width=640):
    """Horizontal bar chart for gainers/losers. items = [(name, value), ...]"""
    if not items:
        return ''
    max_val = max(abs(v) for _, v in items)
    if max_val == 0:
        return ''
    BAR_H    = 22
    GAP      = 6
    LABEL_W  = 160
    BAR_MAX  = width - LABEL_W - 80
    TITLE_H  = 32
    height   = TITLE_H + len(items) * (BAR_H + GAP) + 20

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'style="font-family:Georgia,serif;background:#0a0800;display:block;margin:18px auto">',
        # Title
        f'<text x="{width//2}" y="22" text-anchor="middle" '
        f'fill="#c8a84a" font-size="13" font-weight="bold" letter-spacing="2" '
        f'font-family="Georgia,serif">{esc_svg(title.upper())}</text>',
        # Thin gold divider
        f'<line x1="20" y1="28" x2="{width-20}" y2="28" stroke="#3a2a00" stroke-width="1"/>',
    ]

    for i, (name, val) in enumerate(items):
        y      = TITLE_H + i * (BAR_H + GAP)
        bar_w  = max(2, int(abs(val) / max_val * BAR_MAX))
        color  = color_pos if val >= 0 else color_neg
        prefix = '+' if val > 0 else ''
        # Name label
        lines.append(
            f'<text x="{LABEL_W - 6}" y="{y + BAR_H//2 + 5}" text-anchor="end" '
            f'fill="#a09060" font-size="11" font-family="Georgia,serif">{esc_svg(name[:22])}</text>'
        )
        # Bar
        lines.append(
            f'<rect x="{LABEL_W}" y="{y + 3}" width="{bar_w}" height="{BAR_H - 6}" fill="{color}" opacity="0.85"/>'
        )
        # Value label
        lines.append(
            f'<text x="{LABEL_W + bar_w + 6}" y="{y + BAR_H//2 + 5}" '
            f'fill="{color}" font-size="11" font-family="Georgia,serif">{esc_svg(prefix+str(val))}</text>'
        )

    lines.append('</svg>')
    return '\n'.join(lines)


def svg_hq_chart(title, items, width=640):
    """HQ captures per attacker — dot/bubble style row."""
    if not items:
        return ''
    max_val = max(v for _, v in items)
    if max_val == 0:
        return ''
    BAR_H   = 24
    GAP     = 5
    LABEL_W = 170
    BAR_MAX = width - LABEL_W - 60
    TITLE_H = 36
    height  = TITLE_H + len(items) * (BAR_H + GAP) + 20

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'style="font-family:Georgia,serif;background:#0a0800;display:block;margin:18px auto">',
        f'<text x="{width//2}" y="22" text-anchor="middle" '
        f'fill="#c8a84a" font-size="13" font-weight="bold" letter-spacing="2" '
        f'font-family="Georgia,serif">{esc_svg(title.upper())}</text>',
        f'<line x1="20" y1="30" x2="{width-20}" y2="30" stroke="#3a2a00" stroke-width="1"/>',
    ]

    for i, (name, val) in enumerate(items):
        y      = TITLE_H + i * (BAR_H + GAP)
        bar_w  = max(2, int(val / max_val * BAR_MAX))
        cx_dot = LABEL_W - 14
        cy_dot = y + BAR_H // 2

        lines.append(
            f'<text x="{LABEL_W - 22}" y="{cy_dot + 5}" text-anchor="end" '
            f'fill="#a09060" font-size="11" font-family="Georgia,serif">{esc_svg(name[:24])}</text>'
        )
        # Skull icon substitute — small red diamond
        lines.append(
            f'<polygon points="{cx_dot},{cy_dot-5} {cx_dot+5},{cy_dot} '
            f'{cx_dot},{cy_dot+5} {cx_dot-5},{cy_dot}" fill="#8b1a1a"/>'
        )
        # Bar
        lines.append(
            f'<rect x="{LABEL_W}" y="{y+5}" width="{bar_w}" height="{BAR_H-10}" '
            f'fill="#6b1010" opacity="0.9" rx="1"/>'
        )
        # Bright end cap
        lines.append(
            f'<rect x="{LABEL_W+bar_w-3}" y="{y+5}" width="3" height="{BAR_H-10}" fill="#c03030"/>'
        )
        # Count
        lines.append(
            f'<text x="{LABEL_W+bar_w+8}" y="{cy_dot+5}" '
            f'fill="#c04040" font-size="12" font-weight="bold" font-family="Georgia,serif">'
            f'{esc_svg(val)}✕</text>'
        )

    lines.append('</svg>')
    return '\n'.join(lines)


# Build charts
chart_gainers = svg_bar_chart(
    "Territory Gains This Week",
    [(c["name"], c["net"]) for c in gainers[:8]],
    color_pos='#c8a84a'
)
chart_losers = svg_bar_chart(
    "Heaviest Losses This Week",
    [(c["name"], c["net"]) for c in losers[:8]],
    color_neg='#8b1a1a'
)
chart_hq = svg_hq_chart(
    "HQ Raids — Top Attackers",
    top_hq_capturers[:8]
) if top_hq_capturers else ''

# Inject charts into article HTML at sensible positions:
# After the first <hr> → gainers chart
# After the second <hr> → losers chart
# Before </body> or at end → HQ chart (if captures happened)
def inject_after_nth(html, tag, n, insertion):
    pos, count = 0, 0
    while True:
        idx = html.find(tag, pos)
        if idx == -1:
            break
        count += 1
        if count == n:
            insert_at = idx + len(tag)
            return html[:insert_at] + '\n' + insertion + '\n' + html[insert_at:]
        pos = idx + 1
    # Fallback: append
    return html + '\n' + insertion

if chart_gainers:
    article_html = inject_after_nth(article_html, '<hr>', 1, chart_gainers)
if chart_losers:
    article_html = inject_after_nth(article_html, '<hr>', 2, chart_losers)
if chart_hq:
    article_html = article_html + '\n<hr>\n' + chart_hq

# ── SAVE REPORT ───────────────────────────────────────────────────────────────
report = {
    "generated":    now_utc.isoformat(),
    "period_start": dt_oldest.isoformat(),
    "period_end":   dt_newest.isoformat(),
    "snapshot_count": len(week_snaps),
    "html":         article_html,
    "stats": {
        "total_tiles_start": total_old,
        "total_tiles_end":   total_new,
        "hq_captures":       len(week_captures),
        "raids":             len(week_raids),
        "pure_captures":     len(pure_captures),
        "capture_and_raids": len(capture_and_raids),
        "pure_raids":        len(pure_raids),
        "total_cash_looted": round(total_cash, 2),
        "newcomers":         len(newcomers),
        "vanished":          len(vanished),
        "top_gainer":        gainers[0]["name"] if gainers else None,
        "top_gainer_net":    gainers[0]["net"]  if gainers else 0,
    }
}

with open(REPORT_FILE, "w", encoding="utf-8") as f:
    json.dump(report, f, separators=(",", ":"), ensure_ascii=False)

print(f"Report saved to {REPORT_FILE}")

# ── EXPORT PDF ARCHIVE ────────────────────────────────────────────────────────
# Saves a dated PDF to reports/ for permanent archive
try:
    from weasyprint import HTML as WeasyHTML

    os.makedirs("reports", exist_ok=True)
    pdf_date   = now_utc.strftime("%Y-%m-%d")
    pdf_path   = f"reports/weekly_report_{pdf_date}.pdf"

    # Wrap article_html in a full HTML page with print-friendly styling
    pdf_html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{{margin:0;padding:24px 32px;background:#fff;color:#111;
        font-family:'Georgia',serif;font-size:13px;line-height:1.7}}
  h1{{font-size:28px;text-align:center;margin-bottom:4px}}
  h2{{font-size:14px;text-align:center;color:#555;margin-top:0}}
  h3{{font-size:16px;margin-top:24px}}
  blockquote{{border-left:3px solid #999;padding:8px 16px;margin:16px 0;
              background:#f9f9f9;color:#444}}
  hr{{border:none;border-top:1px solid #ccc;margin:20px 0}}
  svg{{max-width:100%;height:auto;display:block;margin:12px auto}}
</style>
</head>
<body>
{article_html}
</body>
</html>"""

    WeasyHTML(string=pdf_html).write_pdf(pdf_path)
    pdf_size = os.path.getsize(pdf_path) / 1024
    print(f"PDF saved to {pdf_path} ({pdf_size:.0f} KB)")

except ImportError:
    print("WeasyPrint not installed — skipping PDF export")
except Exception as e:
    print(f"Warning: PDF export failed: {e}")
