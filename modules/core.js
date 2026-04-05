// ── MODULE: core.js ── Vendetta World Map v4.00 ──────────────────────────
// ── WALLET STANDARD REGISTRY (inline) ────────────────────────────────────────
// Slush's content script waits for this registry to exist before registering.
// We implement the minimal interface so no external library is needed.
(function(){
  if(window.getWallets) return;
  const _wallets=[],_listeners=[];
  function register(...ws){
    _wallets.push(...ws);
    _listeners.forEach(l=>{try{l({wallets:ws});}catch(e){}});
    return ()=>{ws.forEach(w=>{const i=_wallets.indexOf(w);if(i>-1)_wallets.splice(i,1);});};
  }
  window.getWallets=()=>({
    get:()=>[..._wallets],
    register,
    on:(ev,cb)=>{if(ev==='register')_listeners.push(cb);return ()=>{const i=_listeners.indexOf(cb);if(i>-1)_listeners.splice(i,1);};},
  });
  // Fire app-ready so Slush content script registers itself
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready',{detail:{register}}));
})();
// ── MY PROFILES (configurable, stored in localStorage) ────────────────────────
const MY_IDS_KEY = 'vwm_my_profiles'; // {pid: name}
function loadMyProfiles(){ try{ return JSON.parse(localStorage.getItem(MY_IDS_KEY)||'{}'); }catch(e){ return {}; } }
function saveMyProfiles(obj){ try{ localStorage.setItem(MY_IDS_KEY, JSON.stringify(obj)); }catch(e){} }
let MY_IDS = new Set(Object.keys(loadMyProfiles()));
const CELL=12;
const DIRS8=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

let tiles=[],tileMap=new Map(),players=[],filteredPlayers=[];
let neighborMap=new Map();
let activeFilter='all',highlightPid=null;
let totalTiles=0,unclaimedTiles=0;
let minX=0,maxX=0,minY=0,maxY=0;
let panX=0,panY=0,zoom=1;
let dragging=false,dragStartX=0,dragStartY=0,dragPanX=0,dragPanY=0;
let routeMode=false,routePidA=null,routePidB=null,routePath=null;
let routePathMap=null;
let selectedPid=null;
let top10Mode=false;
let top10Pids=new Set();
let compactMode=false;

// Timeline state
let snapshots=[];

// Battle history (24h overlay)
let battleHistoryData=null;
let battleHistoryActive=false;



async function loadHistory(){
  try{
    const r=await fetch('history.json?t='+Date.now());
    if(!r.ok){ console.warn('Could not load history.json (HTTP '+r.status+')'); return; }
    const h=await r.json();
    snapshots=h.snapshots||[];
    if(snapshots.length>1){
      document.getElementById('battle-btn').style.display='';
      setTimeout(()=>{ loadBattleHistory(); }, 200);
    }
  }catch(e){
    console.warn('Failed to load history: '+e.message);
  }
}




async function loadLatest(){
  await loadData('data.json');
  // Re-fetch history.json so snapshots[] is up-to-date before loadBattleHistory() runs.
  // Without this, a user-triggered reload would compute the 24h overlay against the
  // snapshot list from the initial page load instead of the current one.
  try{
    const r=await fetch('history.json?t='+Date.now());
    if(r.ok){
      const h=await r.json();
      snapshots=h.snapshots||[];
      if(snapshots.length>1) document.getElementById('battle-btn').style.display='';
    }
  }catch(e){ console.warn('loadLatest: could not refresh history.json —',e.message); }
  loadBattleHistory();
}

async function loadSnapshot(file){
  await loadData(file);
}

// ── LOAD DATA ─────────────────────────────────────────────────────────────────
async function loadData(url){
  const hadTiles=tiles.length>0;
  const savedZoom=zoom, savedPanX=panX, savedPanY=panY;

  tiles=[]; tileMap.clear(); players=[]; filteredPlayers=[]; neighborMap.clear();
  clearRoute();
  // Invalidate per-frame caches
  drawMap._labelSig=''; drawMap._labels=[];
  updateRuler._last='';

  try{
    const resp=await fetch(url+'?t='+Date.now());
    if(!resp.ok) throw new Error(`HTTP ${resp.status} — could not load ${url}`);
    const d=await resp.json();

    const gen=new Date(d.generated);
    const pad=n=>String(n).padStart(2,'0');
    const dtStr=`${pad(gen.getDate())}-${pad(gen.getMonth()+1)}-${String(gen.getFullYear()).slice(2)} ${pad(gen.getHours())}:${pad(gen.getMinutes())}`;
    function fmtAge(genMs){
      const totalMin=Math.floor((Date.now()-genMs)/60000);
      const blocks=Math.floor(totalMin/15); // round down to 15m blocks
      const roundedMin=blocks*15;
      const h=Math.floor(roundedMin/60);
      const m=roundedMin%60;
      if(h===0) return `${m||15}m ago`; // minimum 15m
      if(m===0) return `${h}h ago`;
      return `${h}h ${m}m ago`;
    }
    if(window._ageTimer) clearInterval(window._ageTimer);
    const updateAge=()=>{ document.getElementById('age').textContent=`Data: ${fmtAge(gen.getTime())} (${dtStr})`; };
    updateAge();
    window._ageTimer=setInterval(updateAge, 15*60*1000);

    totalTiles=d.total_tiles||0;
    unclaimedTiles=d.unclaimed||0;
    players=d.players||[];

    for(const t of (d.tiles||[])){
      const p=players[t.p]; if(!p) continue;
      const isMe=MY_IDS.has(p.pid);
      tiles.push({x:t.x,y:t.y,pid:p.pid,isHQ:!!t.hq,isMe,color:p.color,bcolor:p.bcolor||null,pidIdx:t.p,
        gH:t.g_h||0,gB:t.g_b||0,gE:t.g_e||0,oid:t.oid||null});
      tileMap.set(`${t.x},${t.y}`,tiles.length-1);
    }
    if(tiles.length){
      minX=Infinity; maxX=-Infinity; minY=Infinity; maxY=-Infinity;
      for(const t of tiles){
        if(t.x<minX) minX=t.x; if(t.x>maxX) maxX=t.x;
        if(t.y<minY) minY=t.y; if(t.y>maxY) maxY=t.y;
      }
    }

    computeNeighborMap();
    buildGarrisonIndex();
    updateStats();
    filterPlayers();
    resizeCanvas();
    if(hadTiles){
      zoom=savedZoom; panX=savedPanX; panY=savedPanY;
    } else {
      jumpToMe();
    }
    _ATK_CACHE.clear();
    drawMap();drawMinimap();

  }catch(e){
    console.error('loadData error: '+e.message);
    document.getElementById('age').textContent='';
    tiles=[];tileMap.clear();players=[];filteredPlayers=[];
    renderPlayerList();drawMap();drawMinimap();
  }
}

// ── NEIGHBOR MAP ──────────────────────────────────────────────────────────────
function computeNeighborMap(){
  neighborMap.clear();
  for(const t of tiles){
    for(const [dx,dy] of DIRS8){
      const nidx=tileMap.get(`${t.x+dx},${t.y+dy}`);
      if(nidx===undefined) continue;
      const nt=tiles[nidx];
      if(nt.pid===t.pid) continue;
      if(!neighborMap.has(t.pid)) neighborMap.set(t.pid,new Map());
      const m=neighborMap.get(t.pid);
      m.set(nt.pid,(m.get(nt.pid)||0)+1);
    }
  }
}

