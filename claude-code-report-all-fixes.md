# Drie fixes in generate_report.py

## Lees eerst
- `generate_report.py` volledig

---

## Fix 1 — Model updaten (URGENT — huidig model is retired)

Regel 17:
```python
# FOUT — claude-sonnet-4-20250514 is retired per 20 april 2026:
MODEL = "claude-sonnet-4-20250514"

# CORRECT:
MODEL = "claude-sonnet-4-6"
```

---

## Fix 2 — Correcte raid/capture terminologie

### Context
In `raids.json` heeft elk entry een `is_capture` veld en een `cash` veld.
Er zijn drie attack types:
- **Pure capture** = is_capture=True, cash ≈ 0 → territoriumaanval, geen loot
- **Capture+Raid** = is_capture=True, cash > 1 → territorium én loot
- **Pure Raid** = is_capture=False → loot only, geen capture

Het huidige rapport noemt alles "raids" en aanvallers "raiders" — incorrect.

### Implementatie

Voeg toe na regel 144 (`capture_raids` en `pure_raids` definities),
vervang die twee regels door:

```python
CASH_THRESHOLD = 1.0
pure_captures     = [r for r in week_raids if r.get("is_capture") and r.get("cash", 0) <= CASH_THRESHOLD]
capture_and_raids = [r for r in week_raids if r.get("is_capture") and r.get("cash", 0) > CASH_THRESHOLD]
pure_raids        = [r for r in week_raids if not r.get("is_capture")]

# Top territory attackers (captures)
capture_count = {}
for r in pure_captures + capture_and_raids:
    name = r.get("attacker_name") or r.get("attacker_pid","")[:8]
    capture_count[name] = capture_count.get(name, 0) + 1
top_capturers = sorted(capture_count.items(), key=lambda x: -x[1])[:5]

capture_victim_count = {}
for r in pure_captures + capture_and_raids:
    name = r.get("defender_name") or r.get("defender_pid","")[:8]
    capture_victim_count[name] = capture_victim_count.get(name, 0) + 1
top_capture_victims = sorted(capture_victim_count.items(), key=lambda x: -x[1])[:5]

# Top raiders (loot attacks)
raid_count = {}
for r in pure_raids + capture_and_raids:
    name = r.get("attacker_name") or r.get("attacker_pid","")[:8]
    raid_count[name] = raid_count.get(name, 0) + 1
top_raiders = sorted(raid_count.items(), key=lambda x: -x[1])[:5]

raid_victim_count = {}
for r in pure_raids + capture_and_raids:
    name = r.get("defender_name") or r.get("defender_pid","")[:8]
    raid_victim_count[name] = raid_victim_count.get(name, 0) + 1
top_raid_victims = sorted(raid_victim_count.items(), key=lambda x: -x[1])[:5]

# Loot totals — only from raids
loot_raids    = pure_raids + capture_and_raids
total_cash    = sum(r.get("cash", 0)    for r in loot_raids)
total_weapons = sum(r.get("weapons", 0) for r in loot_raids)
total_xp      = sum(r.get("xp", 0)     for r in loot_raids)
biggest_raid  = max(loot_raids, key=lambda r: r.get("cash",0)+r.get("weapons",0), default=None)
```

Vervang daarna de `raid_section` string door:

```python
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

BIGGEST SINGLE RAID:
{f"  - {biggest_raid['attacker_name'] or '[unknown]'} raided {biggest_raid['defender_name'] or '[unknown]'} — ${biggest_raid['cash']:.2f} cash, {biggest_raid['weapons']:.2f} arms, {biggest_raid['xp']:.2f} XP" if biggest_raid else "  (none)"}
""".strip()
```

Verwijder ook de nu verouderde `victim_count` en `top_victims` variabelen
die eerder onder `top_raiders` stonden.

---

## Fix 3 — Garrison delta per speler toevoegen

### Context
Elke snapshot bevat tiles met `g_h`, `g_b`, `g_e` velden (garrison per turf).
Door deze op te tellen per speler in snap_old en snap_new krijgen we de garrison groei.

### Implementatie

Voeg toe na de `changes` berekening (na regel 69, vóór `gainers`/`losers`):

```python
# Garrison delta per speler (som van g_h + g_b + g_e over alle tiles)
def garrison_sum(snap, pid):
    total = 0
    for t in snap.get("tiles", []):
        # tiles zijn compact: {"x":..,"y":..,"p":idx,"g_h":..,"g_b":..,"g_e":..}
        # pid_to_index nodig — gebruik player index lookup
        pass
    return total

# Bouw pid→index maps voor beide snapshots
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

# Garrison delta voor alle spelers
garrison_changes = []
for pid in all_pids:
    name = (new_players.get(pid) or old_players.get(pid) or {}).get("name") or "[unknown]"
    g_old = garrison_for_pid(snap_old, old_pid_idx, pid)
    g_new = garrison_for_pid(snap_new, new_pid_idx, pid)
    delta = g_new - g_old
    if delta != 0:
        garrison_changes.append({"name": name, "delta": delta, "g_new": g_new})

top_garrison_growers  = sorted([g for g in garrison_changes if g["delta"] > 0],
                                key=lambda x: -x["delta"])[:5]
top_garrison_shrinkers = sorted([g for g in garrison_changes if g["delta"] < 0],
                                 key=lambda x: x["delta"])[:5]
```

### Toevoegen aan stats_text

Voeg toe aan de `stats_text` string, na de TOP LOSERS sectie:

```python
GARRISON CHANGES THIS WEEK:
BIGGEST ARMY BUILDERS (garrison units added):
{chr(10).join(f"  - {g['name']}: +{g['delta']} units (now {g['g_new']})" for g in top_garrison_growers) or "  (none)"}

BIGGEST ARMY LOSSES (garrison units removed):
{chr(10).join(f"  - {g['name']}: {g['delta']} units (now {g['g_new']})" for g in top_garrison_shrinkers) or "  (none)"}
```

### Toevoegen aan Claude prompt game mechanics

Voeg toe aan de GAME MECHANICS KNOWLEDGE sectie in de prompt:

```
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
```

---

## Vereisten
- Alleen `generate_report.py` aanpassen
- Commit message en changelog in het Engels
- Fix 1 is urgent — zet die als eerste
