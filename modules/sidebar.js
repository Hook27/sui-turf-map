// ── MODULE: sidebar.js ── Vendetta World Map v4.00 ──────────────────────────
// ── PLAYER LIST ───────────────────────────────────────────────────────────────
function updateStats(){
  document.getElementById('s-players').textContent=players.length.toLocaleString('en');
  document.getElementById('s-tiles').textContent=totalTiles.toLocaleString('en');
}
let filterTimer=null;
function filterPlayers(){clearTimeout(filterTimer);filterTimer=setTimeout(_fp,250);}
function setFilter(f,btn){activeFilter=f;document.querySelectorAll('.fb').forEach(b=>b.classList.remove('on'));btn.classList.add('on');filterPlayers();}
function _fp(){
  const q=document.getElementById('search').value.toLowerCase();
  const marks=loadMarks();
  const inactDays=parseInt(document.getElementById('inactivity-select')?.value||'0');
  filteredPlayers=players.filter(p=>{
    if(activeFilter==='inactive'&&!p.inactive) return false;
    if(activeFilter==='friends'&&marks[p.pid]!=='friend') return false;
    if(activeFilter==='enemies'&&marks[p.pid]!=='enemy') return false;
    if(inactDays>0&&p.lcd!=null&&p.lcd>=inactDays) return false;
    if(q&&!p.name.toLowerCase().includes(q)&&!p.pid.includes(q)&&!(p.wallet||'').includes(q)) return false;
    return true;
  });
  renderPlayerList();
}
// ── MARKS (friend / enemy) ────────────────────────────────────────────────────
const MARKS_KEY = 'sui_turf_marks';
let _marksCache = null; // in-memory cache

function loadMarks(){
  if(_marksCache) return _marksCache;
  try{ _marksCache=JSON.parse(localStorage.getItem(MARKS_KEY)||'{}'); }
  catch(e){ _marksCache={}; }
  return _marksCache;
}
function saveMarks(m){ _marksCache=m; localStorage.setItem(MARKS_KEY, JSON.stringify(m)); }
function getMark(pid){ return loadMarks()[pid]||null; }

// Pre-computed set of pids that have any garrison — rebuilt after each data load
let garrisonedPids = new Set();
function buildGarrisonIndex(){
  garrisonedPids.clear();
  for(const t of tiles){
    if(t.gH||t.gB||t.gE) garrisonedPids.add(t.pid);
  }
}


function toggleMark(pid, type, e){
  if(e){ e.stopPropagation(); }
  const marks = loadMarks();
  if(marks[pid]===type) delete marks[pid];
  else marks[pid] = type;
  saveMarks(marks);
  renderPlayerList();
  drawMap();
  // Refresh neighbor popup marks if open
  const popup = document.getElementById('neighbor-popup');
  if(popup.style.display!=='none'){
    popup.querySelectorAll('.nmark').forEach(btn=>{
      const npid = btn.dataset.pid;
      const mtype = btn.dataset.mtype;
      const cur = marks[npid];
      btn.textContent = mtype==='friend' ? '♥' : '✕';
      btn.className = 'nmark' + (cur===mtype ? (mtype==='friend'?' mark-friend':' mark-enemy') : '');
    });
  }
}

function markColor(pid, defaultColor){
  const m = getMark(pid);
  if(m==='friend') return '#1D9E75';
  if(m==='enemy')  return '#E24B4A';
  return defaultColor;
}

function renderPlayerList(){
  const maxT=filteredPlayers.length?filteredPlayers[0].tiles:1;
  const marks=loadMarks();
  const el=document.getElementById('player-list');

  if(!filteredPlayers.length){
    el.innerHTML='<div style="color:#888;padding:1rem;font-size:12px">No results</div>';
    return;
  }

  // Build all HTML in one pass then set innerHTML once
  const parts=new Array(filteredPlayers.length);
  for(let i=0;i<filteredPlayers.length;i++){
    const p=filteredPlayers[i];
    const me=MY_IDS.has(p.pid);
    const isA=p.pid===routePidA,isB=p.pid===routePidB;
    const mark=marks[p.pid]||null;
    const rowCls=`prow${me?' me':''}${isA?' route-a':''}${isB?' route-b':''}${mark==='friend'?' friend':''}${mark==='enemy'?' enemy':''}`;
    const nm=p.name?`<span class="pname${me?' me':''}">${esc(p.name)}</span>`:`<span class="pname unnamed">[unknown]</span>`;
    const rl=isA?'A':isB?'B':'→';
    const friendCls=mark==='friend'?'mark-friend':'';
    const enemyCls=mark==='enemy'?'mark-enemy':'';
    const dotCol=markColor(p.pid,p.color);
    const hasGar=garrisonedPids.has(p.pid);
    const lcdTxt=p.lcd!=null?`${p.lcd}d`:'';
    const lcdCls=p.lcd>=70?'old':p.lcd>=35?'warn':'';
    const feedDaysOverdue=p.feed?((Date.now()-p.feed)/(24*60*60*1000)):0;
    const feedDotCls=feedDaysOverdue>=7?'old':feedDaysOverdue>=3?'warn':'';
    const feedTip=feedDaysOverdue>=7?`No feed: ${Math.floor(feedDaysOverdue)} days overdue`:
                  feedDaysOverdue>=3?`Feed overdue: ${Math.floor(feedDaysOverdue)} days`:'';
    const feedDot=feedDotCls
      ?`<span class="feed-dot ${feedDotCls}" data-tip="${feedTip}"></span>`
      :`<span class="feed-dot"></span>`;
    parts[i]=`<div class="${rowCls}${hasGar?' has-garrison':''}" onclick="onPClick('${p.pid}',event)">` +
      `<span class="prank">${i+1}</span>` +
      `<span class="pdot" style="background:${dotCol}"></span>` +
      nm +
      `<span class="ptiles">${p.tiles.toLocaleString('en')}</span>` +
      `<span class="plcd ${lcdCls}">${lcdTxt}</span>` +
      feedDot +
      `<button class="p-gar-btn" onclick="openGarrison('${p.pid}',event)" title="Garrison overview">🛡</button>` +
      `<button class="p-mark-btn ${friendCls}" onclick="toggleMark('${p.pid}','friend',event)" title="Mark as friend">♥</button>` +
      `<button class="p-mark-btn ${enemyCls}" onclick="toggleMark('${p.pid}','enemy',event)" title="Mark as enemy">✕</button>` +
      `<button class="p-mark-btn" onclick="copyPid('${p.pid}',event)" title="Copy profile ID">⧉</button>` +
      `<button class="p-route-btn" onclick="onRouteBtn('${p.pid}',event)">${rl}</button>` +
      `</div>`;
  }
  el.innerHTML=parts.join('');
}
function copyPid(pid, e){
  if(e) e.stopPropagation();
  navigator.clipboard.writeText(pid).then(()=>{
    // Show brief toast
    let toast = document.getElementById('copy-toast');
    if(!toast){
      toast = document.createElement('div');
      toast.id = 'copy-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;border:1px solid #444;color:#aaa;font-family:var(--font-mono);font-size:10px;padding:5px 14px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s';
      document.body.appendChild(toast);
    }
    toast.textContent = 'Profile ID copied';
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>{ toast.style.opacity='0'; }, 1500);
  }).catch(()=>{});
}

function onSearchInput(el){
  document.getElementById('search-clear').style.display=el.value?'block':'none';
  filterPlayers();
}
function clearSearch(){
  const el=document.getElementById('search');
  el.value='';
  document.getElementById('search-clear').style.display='none';
  filterPlayers();
}
function onPClick(pid,e){
  if(e.target.classList.contains('p-route-btn')) return;
  if(routeMode){selectRoutePlayer(pid);return;}
  jumpToPlayer(pid);
  document.querySelectorAll('.prow').forEach(r=>r.classList.remove('active'));
  e.currentTarget.classList.add('active');
}
function onRouteBtn(pid,e){e.stopPropagation();if(!routeMode)toggleRouteMode();selectRoutePlayer(pid);}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

