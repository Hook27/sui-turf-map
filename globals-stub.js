// ── GLOBALS STUB v4.00 ────────────────────────────────────────────────────────
// Meesturen bij elke losse module — GEEN implementaties, alleen signaturen + state
// Gebruik: stuur dit bestand + alleen de relevante sectie uit index.html aan Claude.
// De index.html zelf blijft ongewijzigd; dit bestand is puur voor context-optimalisatie.

// ── Constanten ────────────────────────────────────────────────────────────────
const CELL = 12;
const DIRS8 = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const GAME_PKG      = '0x54a96d233f754afe62ad0e8b600b977d3f819be8b8c125391d135c3a4419332e';
const GAME_CONFIG   = '0xa32707eecb49cded77c0e9b8041a7a24fe930bd76407802115d290bba70a3a4e';
const TURF_REG      = '0x6e6910507846c5480fa5e7a271f7049dbe986178766982962329c176884b5777';
const ITEM_REG      = '0xe1cc20e7cb37aa5fa76a77322750e30a86c946e40cc9b139a393b5ea357a8586';
const GANG_CONFIG   = '0xc9c4e112571d9ef34fd229972a9080747a76771bb7be4170920f8664e588cd90';
const SCORE_REG     = '0x972b37a34632c49bbc734cc29b621270a33b74c378def52a32354ff1db43e693';
const CLOCK         = '0x0000000000000000000000000000000000000000000000000000000000000006';
const MAX_CALLS_PER_TX   = 900;
const MY_IDS_KEY         = 'vwm_my_profiles';
const PROFILE_WALLET_KEY = 'vwm_wallet_address';

// ── Kerndata (geladen via loadData) ───────────────────────────────────────────
let tiles = [];           // [{x,y,pid,isHQ,isMe,color,bcolor,pidIdx,gH,gB,gE,oid}]
let tileMap = new Map();  // "x,y" → index in tiles[]
let players = [];         // [{pid,name,color,bcolor,tiles,wallet,inactive,lcd}]
let filteredPlayers = [];
let neighborMap = new Map(); // pid → Map(pid → borderCount)
let totalTiles = 0, unclaimedTiles = 0;
let minX=0, maxX=0, minY=0, maxY=0;

// ── Viewport ──────────────────────────────────────────────────────────────────
let panX=0, panY=0, zoom=1;
let _mapCv=null, _mapCtx=null, _mmCv=null;

// ── UI state ──────────────────────────────────────────────────────────────────
let MY_IDS = new Set();        // profile PIDs van de gebruiker
let selectedPid = null;
let highlightPid = null;
let activeFilter = 'all';
let top10Mode = false;
let top10Pids = new Set();
let compactMode = false;
let routeMode = false;
let routePidA = null, routePidB = null;
let routePath = null, routePathMap = null;

// ── Feature state ─────────────────────────────────────────────────────────────
let snapshots = [];               // history.json snapshots (newest-first)
let battleHistoryData = null;     // {changedTiles:[{x,y,fromPid,toPid,type}], raids:[…]}
let battleHistoryActive = false;
let playerHistory = null;         // {timestamps:[ISO…], snapshots:[…], players:{pid:[count…]}}
let playerHistoryDaily = null;    // {days:[{date, players:{pid:count}}]}
let playerActivity = null;        // {raw:{pid:ISO}, days:{pid:n}}
let playerHistoryLoaded = false;
let weeklyReport = null;          // parsed weekly_report.json
let garrisonPid = null;
let garrisonRows = [];            // [{tile, selected}]
let garrisonAllTiles = [];
let ghostMode = false;
let ghostTiles = [];              // [{x,y,pid,name,dist,garrison,score}]
let _lastClickedTile = null;
let walletApi = null;

// ── Battle sim (gedeeld tussen sim, analyzer, canvas) ─────────────────────────
const _ATK_DMG = {
  HM: { HM:[2,4,4,4,8,8],    BC:[1,2,2,2,4,4],     EF:[2,4,4,4,8,8]    },
  BC: { HM:[2,5,5,5,10,10],  BC:[2,5,5,5,10,10],   EF:[1,2,2,2,5,5]    },
  EF: { HM:[3,7,7,7,14,14],  BC:[4,10,10,10,21,21], EF:[3,7,7,7,14,14]  }
};
const _ATK_HP    = { HM:9, BC:12, EF:10 };
const _ATK_CACHE = new Map();  // compKey → top3/top7 results
const _ALL_COMPS = [];         // gevuld door _genCompositions(10) bij init

// ── Functie-signaturen (implementaties in index.html) ─────────────────────────

// MODULE: core (r.856–1023)
function loadMyProfiles(){}         // → {pid: name}
function saveMyProfiles(obj){}
function loadMarks(){}              // → {pid: 'friend'|'enemy'}
function getMark(pid){}             // → 'friend'|'enemy'|null
function markColor(pid, fallback){} // → CSS-kleurstring
function loadData(url){}            // async; vult tiles/players/tileMap
function loadHistory(){}            // async; vult snapshots[]
function loadLatest(){}             // async; roept loadData('data.json') + loadBattleHistory()

// MODULE: route (r.1024–1155)
function findRoute(pidA, pidB){}    // → [{x,y,type}] of null
function toggleRouteMode(){}
function clearRoute(){}
function computeAndShowRoute(){}
function zoomToRoute(){}

// MODULE: canvas (r.1156–1569)
function drawMap(){}
function drawMinimap(){}
function resizeCanvas(){}
function requestDraw(){}
function worldToScreen(wx,wy){}     // → {sx,sy}
function screenToWorld(sx,sy){}     // → {wx,wy}
function showNeighborPopup(pid,sx,sy,clickedTile){}
function closeNeighborPopup(){}

// MODULE: input (r.1570–1853)
function jumpToPlayer(pid){}
function jumpToTile(wx,wy){}
function selectPlayerNoPan(pid){}
function zoomBy(f){}
function resetView(){}
function toggleMapOnly(){}
function toggleSidebar(){}

// MODULE: sidebar (r.1892–2043)
function renderPlayerList(){}
function filterPlayers(){}
function setFilter(f, btn){}
function onPClick(pid, e){}
function copyPid(pid, e){}
function esc(s){}                   // HTML-escape helper
function toggleMark(pid, type, e){}

// MODULE: export (r.2044–2324)
function exportPNG(){}
function exportGIF(){}
function exportCSV(){}
function openRefreshModal(){}
function closeRefreshModal(){}
function triggerRefresh(){}         // async

// MODULE: battle-hist (r.2325–2596)
function loadBattleHistory(){}      // async; vult battleHistoryData
function tileOwnerMap(d){}          // → Map("x,y" → {pid,name,color})
function startTicker(){}

// MODULE: garrison (r.2597–2828)
function openGarrison(pid, e){}
function closeGarrison(){}
function renderGarrisonList(){}
function renderGarrisonNavList(){}
function toggleGarrisonRow(i){}
function garrisonSelectAll(){}
function updateRecallBar(){}
function garSortBy(col){}
function garSortReset(){}
function switchGarrisonTab(tab){}

// MODULE: wallet (r.2829–3117)
function openWalletModal(){}
function closeWalletModal(){}
function connectWallet(){}          // async
function executeRecall(){}          // async
function loadSuiSdk(){}             // async
function buildAndSignTx(calls, dvdId, profileId, hqOid){} // async

// MODULE: ui-helpers (r.3118–3212)
function updateRuler(){}
function toggleIntelMenu(){}
function closeIntelMenu(){}
function toggleMoreMenu(){}
function closeMoreMenu(){}
function toggleCompact(btn){}
function toggleTop10(){}
function updateZoomIndicator(){}

// MODULE: leaderboard (r.3213–3458)
function openLeaderboard(){}        // async
function closeLeaderboard(){}
function renderLeaderboard(){}
function lbSetPeriod(p){}
function loadPlayerHistory(){}      // async; vult playerHistory/Daily/Activity
function showMiniProfile(e, pid){}  // async
function closeMiniProfile(){}

// MODULE: gar-history (r.3459–3637)
function renderGarrisonHistory(){}  // SVG chart
function renderGarrisonAttacks(){}

// MODULE: sim (r.3638–3815)
function _atkSim(atkArmy, defArmy, N){}    // → {winPct, avgRounds, avgSurv}
function _genCompositions(maxUnits){}      // → comps array
function _armyArray(obj){}                 // {EF,BC,HM} → ['EF','EF','BC',…]
function _compKey(obj){}                   // → "2e3b1h"
function _atkLabel(c){}                    // → HTML-string met gekleurde letters
function _renderTileAdvice(el, tile){}
function renderAttackAdvisor(){}

// MODULE: ghost (r.3816–3925)
function toggleGhostMode(){}
function computeGhostTiles(){}
function drawGhostTiles(ctx){}      // aangeroepen vanuit drawMap()

// MODULE: intel (r.3926–4081)
function openSoftTargets(){}
function closeSoftTargets(){}
function renderSoftTargets(){}
function loadWeeklyReport(){}       // async
function openReport(){}
function closeReport(){}
function printReport(){}
function sanitizeReportHTML(html){} // → string

// MODULE: profile (r.4082–4185)
function openProfileModal(){}
function closeProfileModal(){}
function addProfile(pid, name){}
function removeProfile(pid){}
function onProfileSearch(val){}
function renderProfileCurrent(){}
function loadProfileWallet(){}      // → string
function saveProfileWallet(){}

// MODULE: analyzer (r.4186–4414)
// const BA_RPC = 'https://fullnode.mainnet.sui.io';
// const BA_SIM_EVENT = '0x63081c5d…::ibattle::SimulationResultEvent';
function baRpc(method, params){}    // async → RPC result
function baAnalyzeDigest(digest){}  // async
function baAnalyze(){}              // async; leest #ba-url-input
function baAnalyzeLastBattle(){}    // async
function baBestAttack(H,B,E){}      // → top7 comps array
function openBattleAnalyzer(){}
function closeBattleAnalyzer(){}

// ── Module-regelbereiken (referentie) ─────────────────────────────────────────
// css          :   12–  327  (~315 r)
// html         :  328–  856  (~528 r)
// core         :  856– 1023  (~168 r)
// route        : 1024– 1155  (~131 r)
// canvas       : 1156– 1569  (~414 r)
// input        : 1570– 1853  (~284 r)
// sidebar      : 1892– 2043  (~152 r)
// export       : 2044– 2324  (~281 r)
// battle-hist  : 2325– 2596  (~272 r)
// garrison     : 2597– 2828  (~232 r)
// wallet       : 2829– 3117  (~289 r)
// ui-helpers   : 3118– 3212  ( ~95 r)
// leaderboard  : 3213– 3458  (~246 r)
// gar-history  : 3459– 3637  (~179 r)
// sim          : 3638– 3815  (~178 r)
// ghost        : 3816– 3925  (~110 r)
// intel        : 3926– 4081  (~156 r)
// profile      : 4082– 4185  (~104 r)
// analyzer     : 4186– 4414  (~229 r)
// boot         : 4415– 4421  (  ~7 r)
