# Vendetta World Map (VWM)

Unofficial companion tool for **Vendetta**, an on-chain strategy game on SUI. It renders a
real-time map of player territories, garrisons, leaderboards and battle data. Live at
**vwm.cryptofolio.nl**, served as a static site via GitHub Pages.

There is no build step. `index.html` + `modules/*.js` are loaded directly. Data is pre-fetched
into JSON files by a scheduled GitHub Actions workflow and read at runtime.

Additional local maintainer notes (on-chain identifiers, hard rules, current focus) live in
`@CLAUDE.local.md` — a gitignored, machine-local file that is not committed.

## Architecture

- **`index.html`** — the whole app shell: all CSS and all HTML markup, plus the `<script>` tags
  that load the modules (in dependency order). It is divided into **anchored blocks** marked with
  `── BLOCK: <name> ──` / `── END: <name> ──` comments:
  - CSS blocks: `css-base`, `css-popups`, `css-mobile`, `css-garrison`, `css-misc`, `css-day-theme`
  - HTML blocks: `html-toolbar`, `html-map`, `html-neighbor`, `html-garrison`, `html-modals`

  To find a block, grep for `BLOCK: <name>`. When you change a module's markup/columns, the
  matching HTML/CSS block in `index.html` usually needs to change too (see couplings below).
- **`modules/*.js`** — plain global-scope scripts (no bundler, no modules system). They share
  state through globals; functions call each other directly by name.

### Module reference (load order from `index.html`)

| Module | Responsibility |
|---|---|
| `core.js` | Data loading, global state, friend/enemy marks (`loadData`, `tiles`, `players`, `markColor`) |
| `route.js` | A* shortest-path routing **and** the Navigate feature (origin→destination distance/compass/in-game hint) |
| `canvas.js` | Map rendering, minimap, tooltips, neighbor popup, animations (`drawMap`, `drawMinimap`) |
| `input.js` | Mouse / scroll / drag / touch / pinch / zoom |
| `sidebar.js` | Player list, search (name/ID/wallet), filters, compact view |
| `export.js` | PNG / GIF / CSV export |
| `battle-hist.js` | 24h turf-change overlay + news ticker |
| `garrison.js` | Garrison modal: tabs Navigate, History, Attacks, Attack, Recall; sorting & selection |
| `wallet.js` | Wallet connect (Slush/Suiet) + recall execution |
| `ui-helpers.js` | Ruler, toolbar dropdowns (Navigate/Intel/More), compact/Top 10, zoom indicator, Nav modal |
| `daily-history.js` | Reader of the long-term daily tile history, legacy and v2 delta file (`dhCountsAt`, `dhSeries`, `dhRankMap`, `loadDailyHistory`); loaded before `leaderboard.js` |
| `leaderboard.js` | Leaderboard (24h / 7d / cash periods) + mini-profile popup |
| `gar-history.js` | Garrison History tab (chart) + Attacks tab |
| `sim.js` | Monte Carlo battle simulator / attack adviser (`_atkSim`, `_armyArray`) |
| `ghost.js` | Ghost Turfs overlay (`drawGhostTiles`) |
| `intel.js` | Soft Targets modal + The Vendetta Gazette (weekly report) |
| `profile.js` | "My Profile" modal (own players, wallet address) |
| `analyzer.js` | Battle Analyzer — decode a fight from a SuiVision URL or last battle (Sui GraphQL) |
| `realtime.js` | Live on-chain reads over Sui GraphQL (turf/player objects, 60s cache, free-turf lookup by coordinate) |
| `boot.js` | Init entry point: `resizeCanvas`, `loadHistory`, `loadLatest`, `loadWeeklyReport`, `loadPlayerHistory` |

### Key cross-module couplings

These are easy to break because everything is global-scope and calls by name:

- **`sim.js` is shared** — `_atkSim` / `_armyArray` are used by `canvas.js` (attack advice in the
  neighbor popup), `gar-history.js`, `analyzer.js` and `intel.js`.
- **`canvas.js` `drawMap()` is the central draw call** — the 24h overlay (`battle-hist.js`) and the
  Ghost Turfs overlay (`ghost.js` `drawGhostTiles`) are rendered from inside it.
- **`garrison.js` ↔ `html-garrison` block** — the garrison table's column order/headers live in
  both the JS render functions and the `html-garrison` block in `index.html`. Change them together.
- **`wallet.js` ↔ `garrison.js`** — the recall flow spans both. (Note: in practice the Recall
  feature does not work reliably and is intentionally documented as "Currently unavailable" in
  `guide.html`.)

## Versioning convention

Bump the app version on **every** change to the map. The version lives in `index.html`
(`#ver` badge, around line 825). *(Current: v4.22.)*

- **Minor change** (the common case): increment the patch after the dot, e.g. `v4.16` → `v4.17`.
- **Major change** (rare — not really expected anymore): increment before the dot and reset the
  patch, e.g. `v4.17` → `v5.00`.

`guide.html` has its own `#hero-version` badge; keep it roughly in step when the guide is
meaningfully updated, but it is tracked loosely and need not match exactly.

Module header comments (`// ── MODULE: x.js ── Vendetta World Map vX.YZ`) carry their **own**
version numbers. These do **not** need to follow `index.html` — leave them as they are unless you
have a specific reason to touch them.

## Data & workflows

- `fetch_data.py` pulls on-chain data → `data.json`, `history.json`, `snapshots/`, and other JSON
  files read by the app. **Transport: Sui GraphQL**, through the stdlib-only `sui_graphql.py`
  (Sui JSON-RPC left the full nodes in mid-October 2026). Endpoints: Mysten's public
  `graphql.mainnet.sui.io` first (keyless), then Ankr's premium GraphQL, which `sui_graphql.py`
  derives from the `SUI_RPC_URL` secret (the key is the last path segment; override with
  `SUI_GRAPHQL_URL`, swap the order with `SUI_GRAPHQL_KEYED_FIRST=1`). The Ankr URL carries the
  key, so only hosts are ever logged. GraphQL object `json` is *flat* — a VecMap is
  `{"contents": [{"key", "value"}]}`, no `{type, fields}` wrappers — and its limits are 50 per
  page and a 5000-byte request payload (so 50 ids per `multiGetObjects`, no more). A transient
  failure is retried once on the same endpoint before that endpoint is parked; with one endpoint
  nothing is parked. A failed event walk no longer disappears into a log line: it becomes a
  `::warning` annotation plus an end-of-run summary (the run still succeeds, so the rest of the
  data is committed).
  It also writes **`field_cache.json`**, which the frontend does *not* read: it remembers the
  dynamic-field object ids for each player's cash/weapon balance. Those ids never change, so only
  new players cost a lookup. The cache is self-healing: an id that fails to read is dropped and
  re-discovered. The turf-table walk now returns the turf ids inline, so the old reuse of the
  coordinate→turf-id mapping from the previous `data.json` is gone.
  **`hq_checked.json`** (also not read by the frontend) lists the HQ-destroyed transactions that
  were checked and turned out to be real captures (they carry a `CaptureEvent` and never enter
  `hq_destroyed.json`). A transaction never changes, so each is looked up once; without this the
  ~480 captures in the scan window cost a call each, every run. Failed lookups are never
  remembered, a missing or corrupt file only costs those calls again, and after a complete scan
  the file is trimmed to the scan window.
  **`player_history_daily_v2.json`** is the long-term daily tile history (read by the 7d leaderboard and
  the garrison chart through `modules/daily-history.js`). It is a delta file, written by the stdlib-only
  `daily_history.py`: the first day in full as `base`, then one `changes` entry per day holding only the players whose
  tile count changed (`null` = player absent that day); every day has an entry, even an empty one. It replaced
  `player_history_daily.json`, which stored every player every day (~346 KB/day, 72 MB by Oct 2026, over GitHub's
  100 MB file limit by Jan 2027, and downloaded in full on every page load). The first run after the switch converts the
  legacy file (verified lossless on all 216 days), writes the v2 file and deletes the legacy file; `update.yml` stages
  that deletion with `git rm --ignore-unmatch`. If anything fails the run still succeeds with a `::warning` and the legacy
  file is untouched. The frontend falls back to the legacy file while it still exists. A quiet day costs ~30 bytes.
- `.github/workflows/update.yml` — **once a day** since 24-09-2026, because the game has come to
  a standstill. The run is driven by a cron on the maintainer's Pi that fires a `workflow_dispatch`
  at **04:22 UTC**; the workflow's own `schedule` (`22 16 * * *`) is only a safety net for a missed
  Pi run. A freshness gate in the workflow skips a run whose `data.json` is still fresh — 1 hour
  for the Pi trigger, 20 hours for the schedule — so the net does not turn into a second daily
  fetch. Change the Pi cron, the schedule and that gate together; the comments in the workflow
  carry the arithmetic. A run costs ~2,000 GraphQL calls and takes ~10 min on GitHub's runner
  (22-10-2026; the final log line prints both). The first run after `hq_checked.json` was
  introduced still pays the ~480 HQ lookups once; later runs are ~1,500 calls; it reads from Mysten's public endpoint first and
  falls back to the paid Ankr key (`SUI_RPC_URL`) only when that endpoint fails or keeps
  throttling. Ankr's credit cost per GraphQL call is not measured yet — check the Ankr dashboard
  after the first days.
  It commits the refreshed data with messages titled `Update map data …`. Frequent data-only
  commits on `main` are normal and automated — not hand edits.
  **Run page summary:** at the end of `fetch_data.py` (after the "GraphQL calls in … min" line) it appends a short
  markdown table to `$GITHUB_STEP_SUMMARY`, which GitHub shows at the top of the run page: GraphQL calls, duration,
  players, owned tiles, days in `player_history_daily_v2.json`, and the `WARNINGS` list. It does nothing without
  that variable (local runs) and is wrapped so that it can never fail a run; `update.yml` needs no step for it.
  **Failure notice:** the `notify` job (`needs: [gate, fetch]`, `if: always() && (gate or fetch result == 'failure')`)
  runs `tools/ci_notify.py`, which opens a GitHub issue titled "Daily map update failed" with the run URL, or
  comments on the one that is already open (matched on the exact title, no labels: a missing label makes
  `gh issue create --label` fail). It is skipped when `fetch` was merely skipped by the freshness gate or the run
  was cancelled. Job-level `permissions` REPLACE the top-level `contents: write`, so `notify` has only
  `contents: read` + `issues: write` and `fetch` keeps `contents: write`. The job is `continue-on-error` and the script
  always exits 0, so the notice can never mask or worsen the failure it reports. It needs Issues enabled on the repo.
  Close the issue when the map is fresh again; the next failure opens a new one. The workflow cannot be run locally:
  the logic is tested offline against a fake `gh` (`tests/test_ci_notify.py`), the wiring only shows on a real failure.
- `.github/workflows/tests.yml` — runs the offline tests on every pull request (and by hand from the Actions tab):
  the Python suite, the JS suite, a `node --check` of every `modules/*.js` and a `py_compile` of every Python file.
  It runs in two environments (a matrix): Linux / Python 3.12 / Node 22, like the daily data run, and Windows /
  Python 3.13 / Node 24, like the maintainer's PC; the check names on a PR are `tests (<label>)`.
  Read-only (`contents: read`), no secrets, no network. It deliberately does not run on pushes to `main`: the daily
  data run pushes there itself. The bot in `bot/` is not in the repo, so its tests are not covered.
  **Run page summary:** the Python and JS test commands pipe their output through `tee` into `python-tests.log` /
  `js-tests.log` (JS with `--test-reporter=tap`, so the format is the same on Node 22 and 24), and a last step with
  `if: always()` runs `tools/ci_summary.py` to write counts and, for each failure, the `FAIL:`/`ERROR:` or `not ok`
  block with expected/actual to `$GITHUB_STEP_SUMMARY`. The `| tee` only works because the job's
  `defaults.run.shell: bash` gives `bash -eo pipefail`; without an explicit `shell: bash` GitHub uses plain
  `bash -e` and `tee` would hide a failing test, so keep that line. The summary step is `continue-on-error`.
- `.github/workflows/weekly_report.yml` — **suspended since 24-09-2026** (schedule commented out,
  manual dispatch still works). It generated The Vendetta Gazette (`generate_report.py`, uses the
  `ANTHROPIC_API_KEY` secret). The last edition is 21-09-2026 and `modules/intel.js` labels it as
  the final one; remove that notice if the report is ever resumed.

Both workflows push with the built-in `GITHUB_TOKEN` (`permissions: contents: write`); no personal
access token is involved in the automatic pipeline.

**Branch protection on `main`** (since 23-10-2026): a repository ruleset named "VWM rules" (Settings → Rules →
Rulesets) with exactly two rules, *Restrict deletions* and *Block force pushes*, an empty bypass list, enforcement
Active. Nothing more: the daily data run pushes straight to `main` (`git pull --rebase && git push`, a plain
fast-forward push), so a pull-request requirement, required checks or *Restrict updates* (which blocks every push)
would stop the map from updating. Whether `GITHUB_TOKEN` can be given a bypass on a personal repository is untested.
The repo is on the Free plan, so protection only exists because this repo is public. If the data run's push step ever
fails, check the log for a "protected branch" rejection; setting the ruleset to Disabled rules it out.

## Local development

Tests (offline: a fake GraphQL chain serves recorded fixtures; Python needs only the stdlib):

```
python -m unittest discover -s tests
node --test tests/js/browser_modules.test.mjs tests/js/daily_history.test.mjs
```

`tools/` holds the small stdlib-only scripts the workflows call (`ci_summary.py` for the Tests run page,
`ci_notify.py` for the failure issue); each has its own unit tests in `tests/`, covered by the Python command
above. `tests/test_fetch_data.py` clears `GITHUB_STEP_SUMMARY` for its e2e runs (on Actions it points at the real
run page); tests that want a summary pass `summary=<tmp file>` to `run_fetch`.

`python tests/record_fixtures.py` re-records `tests/fixtures/world.json` from the live chain;
`node tests/js/live_check.mjs` smoke-tests the browser modules against the real endpoint.
On a Windows console set `PYTHONUTF8=1` before `python fetch_data.py` (its log lines contain `→`).

Static site — serve the folder and open in a browser:

```
python -m http.server 8000
```

The app fetches `data.json` and friends with relative paths, so any static server works.

## Working conventions

- **Commit messages in English.**
- If a request is ambiguous or has multiple plausible interpretations, ask a clarifying question
  before implementing.
- When changing a module's UI, check whether the matching `index.html` block (and `guide.html`)
  needs a parallel update.
