// ── MODULE: leaderboard.js ── Vendetta World Map v4.00 ──────────────────────────

// ── LEADERBOARD WITH TRENDS ────────────────────────────────────────────────────
let _lbPeriod = '24h';

function lbSetPeriod(p){
  _lbPeriod = p;
  ['24h','7d','cw'].forEach(id=>{
    const btn=document.getElementById('lb-period-'+id);
    if(!btn) return;
    btn.style.borderColor = p===id ? 'var(--v-gold)' : (_isDay()?'#c4924a':'#333');
    btn.style.color       = p===id ? 'var(--v-gold)' : (_isDay()?'#a08050':'#666');
  });
  renderLeaderboard();
}

async function openLeaderboard(){
  document.getElementById('leaderboard-modal').style.display='flex';
  if(!playerHistoryLoaded) await loadPlayerHistory();
  renderLeaderboard();
}

function closeLeaderboard(){
  document.getElementById('leaderboard-modal').style.display='none';
}

function renderLeaderboard(){
  const el=document.getElementById('lb-list');
  el.innerHTML=`<div style="padding:1rem;color:${_isDay()?'#806030':'#666'};font-size:11px">Loading...</div>`;
  const header=document.getElementById('lb-header');

  // ── Cash/Weapons tab ────────────────────────────────────────────────────────
  if(_lbPeriod==='cw'){
    document.getElementById('lb-subtitle').textContent='Top 50 players by cash balance · snapshot data';
    if(header){
      header.style.gridTemplateColumns='32px 1fr 80px 80px';
      header.innerHTML='<span>#</span><span>Player</span><span style="text-align:right">💰 Cash</span><span style="text-align:right">⚔️ Weapons</span>';
    }
    const sorted=[...players].sort((a,b)=>(b.cash||0)-(a.cash||0)).slice(0,50);
    const fmtNum=v=>Math.round(v||0).toLocaleString('en');
    el.innerHTML=sorted.map((p,i)=>{
      const rank=i+1;
      const isMe=MY_IDS.has(p.pid);
      const dotCol=markColor(p.pid,p.color||'#666');
      const rankCol=rank<=3?'#FAC775':rank<=10?'#aaa':(_isDay()?'#a08050':'#555');
      const inactive=p.inactive?`<span style="color:${_isDay()?'#a08050':'#555'};font-size:8px"> INACT</span>`:'';
      return `<div class="lb-row" onclick="closeLeaderboard();showMiniProfile(event,'${p.pid}')" style="display:grid;grid-template-columns:32px 1fr 80px 80px;padding:6px 14px;border-bottom:1px solid ${_isDay()?'#e0ccaa':'#111'};cursor:pointer;${isMe?(_isDay()?'background:#dceef8':'background:#0a0a1a'):''}">
        <span style="color:${rankCol};font-size:10px">${rank}</span>
        <span style="display:flex;align-items:center;gap:6px">
          <span style="width:8px;height:8px;border-radius:1px;background:${dotCol};flex-shrink:0;display:inline-block"></span>
          <span style="font-size:11px;color:${isMe?'#FAC775':(_isDay()?'#2a1808':'#ccc')}">${esc(p.name||'[unknown]')}${inactive}</span>
        </span>
        <span style="text-align:right;font-size:11px;color:#FAC775">${fmtNum(p.cash)}</span>
        <span style="text-align:right;font-size:11px;color:#e07050">${fmtNum(p.weapons)}</span>
      </div>`;
    }).join('');
    return;
  }

  // ── Tile trend tabs (24h / 7d) — restore default header ────────────────────
  if(header){
    header.style.gridTemplateColumns='32px 1fr 52px 52px 52px';
    header.innerHTML='<span>#</span><span>Player</span><span style="text-align:right">Turfs</span><span style="text-align:right">Change</span><span style="text-align:right">Trend</span>';
  }

  // Build previous tile counts using correct data structures:
  // playerHistory: {snapshots: [label,...], players: {pid: [count per snapshot]}}
  //   snapshots[0] = newest, snapshots[N-1] = oldest
  // playerHistoryDaily: {days: [{date, players: {pid: count}}]}
  //   days[0] = oldest, days[N-1] = newest

  let prevCounts = null;

  if(_lbPeriod==='24h' && playerHistory?.players){
    // timestamps[] is oldest-first ISO strings, same order as players[][idx]
    const timestamps = playerHistory.timestamps || [];
    const target = Date.now() - 86400000; // 24h ago
    let bestIdx = timestamps.length - 2; // fallback: second-newest
    let bestDiff = Infinity;
    for(let i=0; i<timestamps.length-1; i++){
      const ms = new Date(timestamps[i]).getTime();
      const diff = Math.abs(ms - target);
      if(diff < bestDiff){ bestDiff=diff; bestIdx=i; }
    }
    const prev = {};
    for(const [pid, counts] of Object.entries(playerHistory.players)){
      if(counts[bestIdx] != null) prev[pid] = counts[bestIdx];
    }
    if(Object.keys(prev).length) prevCounts = prev;
  } else if(_lbPeriod==='7d' && playerHistoryDaily?.days?.length > 1){
    // days are oldest first — find entry closest to 7 days ago
    const days = playerHistoryDaily.days;
    const target = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
    let best = days[0];
    for(const d of days){
      if(d.date <= target) best = d;
      else break;
    }
    if(best?.players) prevCounts = best.players;
  }

  // Build current snapshot from players array (already loaded)
  const top50 = players.slice(0, 50);

  // Find previous rank for trend arrow
  let prevRanked = [];
  if(prevCounts){
    prevRanked = Object.entries(prevCounts)
      .sort((a,b)=>b[1]-a[1])
      .map(([pid],i)=>({pid,rank:i+1}));
  }
  const prevRankMap = new Map(prevRanked.map(r=>[r.pid,r.rank]));

  document.getElementById('lb-subtitle').textContent =
    `Rank & tile trend vs ${_lbPeriod==='24h'?'24 hours':'7 days'} ago · top 50`;

  el.innerHTML = top50.map((p,i)=>{
    const rank = i+1;
    const prevRank = prevRankMap.get(p.pid);
    const prevTiles = prevCounts?.[p.pid] ?? null;
    const tileDiff = prevTiles!=null ? p.tiles - prevTiles : null;

    const _nd = _isDay();
    const _neu = _nd?'#a08050':'#555'; // neutral/dim color

    // Rank trend
    let trendHtml = `<span style="color:${_neu}">—</span>`;
    if(prevRank!=null){
      const rd = prevRank - rank; // positive = moved up
      if(rd>0)       trendHtml=`<span style="color:#6fffa9">▲${rd}</span>`;
      else if(rd<0)  trendHtml=`<span style="color:#E24B4A">▼${Math.abs(rd)}</span>`;
      else           trendHtml=`<span style="color:${_neu}">═</span>`;
    }

    // Tile change
    let changeHtml = `<span style="color:${_neu}">—</span>`;
    if(tileDiff!=null){
      if(tileDiff>0)      changeHtml=`<span style="color:#6fffa9">+${tileDiff}</span>`;
      else if(tileDiff<0) changeHtml=`<span style="color:#E24B4A">${tileDiff}</span>`;
      else                changeHtml=`<span style="color:${_neu}">0</span>`;
    }

    const isMe = MY_IDS.has(p.pid);
    const dotCol = markColor(p.pid, p.color||'#666');
    const rankCol = rank<=3?'#FAC775':rank<=10?'#aaa':_neu;
    const inactive = p.inactive?`<span style="color:${_neu};font-size:8px"> INACT</span>`:'';

    return `<div class="lb-row" onclick="closeLeaderboard();showMiniProfile(event,'${p.pid}')" style="display:grid;grid-template-columns:32px 1fr 52px 52px 52px;padding:6px 14px;border-bottom:1px solid ${_nd?'#e0ccaa':'#111'};cursor:pointer;${isMe?(_nd?'background:#dceef8':'background:#0a0a1a'):''}">
      <span style="color:${rankCol};font-size:10px">${rank}</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span style="width:8px;height:8px;border-radius:1px;background:${dotCol};flex-shrink:0;display:inline-block"></span>
        <span style="font-size:11px;color:${isMe?'#FAC775':(_nd?'#2a1808':'#ccc')}">${esc(p.name||'[unknown]')}${inactive}</span>
      </span>
      <span style="text-align:right;font-size:11px;color:#aaa">${p.tiles}</span>
      <span style="text-align:right;font-size:11px">${changeHtml}</span>
      <span style="text-align:right;font-size:11px">${trendHtml}</span>
    </div>`;
  }).join('');
}

// ── MINI-PROFILE ───────────────────────────────────────────────────────────────
async function showMiniProfile(e, pid){
  const p = players.find(pl=>pl.pid===pid);
  if(!p) return;

  const modal = document.getElementById('miniprofile-modal');
  const box   = document.getElementById('miniprofile-box');

  // Show loading state immediately
  modal.style.display='block';
  box.style.left='50%';
  box.style.top='50%';
  box.style.transform='translate(-50%,-50%)';
  document.getElementById('mp-name').textContent = p.name||'[unknown]';
  document.getElementById('mp-body').innerHTML='<div style="padding:8px 0;color:#555;font-size:10px">Loading…</div>';

  // Ensure activity + history data is loaded
  if(!playerHistoryLoaded) await loadPlayerHistory();

  // Garrison totals for this player
  const playerTiles = tiles.filter(t=>t.pid===pid);
  const totalGar = playerTiles.reduce((s,t)=>s+(t.gH||0)+(t.gB||0)+(t.gE||0),0);
  const totalH   = playerTiles.reduce((s,t)=>s+(t.gH||0),0);
  const totalB   = playerTiles.reduce((s,t)=>s+(t.gB||0),0);
  const totalE   = playerTiles.reduce((s,t)=>s+(t.gE||0),0);

  // Rank
  const rank = players.findIndex(pl=>pl.pid===pid)+1;

  // Activity — use raw ISO timestamp (includes raids + feed/claim events)
  // playerActivity.raw[pid] is the most recent known activity timestamp
  const rawTs = (playerActivity && typeof playerActivity === 'object' && playerActivity.raw)
    ? playerActivity.raw[pid] : null;
  let actStr = '—';
  if(rawTs){
    const diffMs = Date.now() - new Date(rawTs).getTime();
    const diffH  = diffMs / 3600000;
    if(diffH < 1)        actStr = 'just now';
    else if(diffH < 24)  actStr = Math.floor(diffH) + 'h ago';
    else                 actStr = Math.floor(diffH/24) + 'd ago';
  }

  // Raids (if loaded)
  const raids = (battleHistoryData?.raids)||[];
  const raidsAsAtk = raids.filter(r=>r.attacker_pid===pid).length;
  const raidsAsDef = raids.filter(r=>r.defender_pid===pid).length;

  const mark = loadMarks()[pid]||null;
  const markHtml = mark==='friend'?'<span style="color:#6fffa9">♥ Friend</span>':
                   mark==='enemy' ?'<span style="color:#E24B4A">✕ Enemy</span>':'';

  // Tile change vs 24h ago — use timestamps array (oldest-first)
  let tileChangeHtml = '';
  if(playerHistory?.players?.[pid] && playerHistory?.timestamps?.length){
    const timestamps = playerHistory.timestamps;
    const target = Date.now() - 86400000;
    let bestIdx = timestamps.length - 2;
    let bestDiff = Infinity;
    for(let i=0; i<timestamps.length-1; i++){
      const ms = new Date(timestamps[i]).getTime();
      const diff = Math.abs(ms - target);
      if(diff < bestDiff){ bestDiff=diff; bestIdx=i; }
    }
    const counts = playerHistory.players[pid];
    const prev = counts?.[bestIdx];
    if(prev!=null){
      const diff = p.tiles - prev;
      tileChangeHtml = diff>0?`<span style="color:#6fffa9">+${diff}</span>`:
                       diff<0?`<span style="color:#E24B4A">${diff}</span>`:
                       '<span style="color:#888">0</span>';
    }
  }

  document.getElementById('mp-body').innerHTML=`
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#888;padding:2px 0">Rank</td><td style="text-align:right;color:#FAC775">#${rank}</td></tr>
      <tr><td style="color:#888;padding:2px 0">Turfs</td><td style="text-align:right;color:#aaa">${p.tiles}${tileChangeHtml?' ('+tileChangeHtml+' 24h)':''}</td></tr>
      <tr><td style="color:#888;padding:2px 0">Garrison</td><td style="text-align:right">
        <span style="color:#aaa">${totalH}H</span>
        <span style="color:#6fffa9;margin-left:4px">${totalB}B</span>
        <span style="color:#ff8483;margin-left:4px">${totalE}E</span>
        <span style="color:#888;margin-left:4px">(${totalGar})</span>
      </td></tr>
      <tr><td style="color:#888;padding:2px 0">Last active</td><td style="text-align:right;color:#aaa">${actStr}</td></tr>
      <tr><td style="color:#888;padding:2px 0">Raids (atk/def)</td><td style="text-align:right;color:#aaa">${raidsAsAtk} / ${raidsAsDef}</td></tr>
      ${markHtml?`<tr><td colspan="2" style="padding-top:4px">${markHtml}</td></tr>`:''}
      ${p.inactive?'<tr><td colspan="2" style="color:#888;font-size:9px;padding-top:2px">INACTIVE</td></tr>':''}
    </table>
    <div style="display:flex;gap:6px;margin-top:10px">
      <button onclick="closeMiniProfile();jumpToPlayer('${pid}')" style="font-size:9px;padding:3px 8px;flex:1">🗺 Go to</button>
      <button onclick="closeMiniProfile();openGarrison('${pid}',event)" style="font-size:9px;padding:3px 8px;flex:1">🛡 Garrison</button>
    </div>`;
}

function closeMiniProfile(){
  document.getElementById('miniprofile-modal').style.display='none';
}

// ── ZOOM INDICATOR ────────────────────────────────────────────────────────────
function updateZoomIndicator(){
  const el=document.getElementById('zoom-indicator');
  if(el) el.textContent=`zoom ×${zoom.toFixed(1)}`;
}



// ── PLAYER HISTORY ────────────────────────────────────────────────────────────
let playerHistory = null;
let playerHistoryLoaded = false;
let playerHistoryDaily = null; // long-term daily data
let playerActivity = null; // {pid: days_since_last_active}

async function loadPlayerHistory(){
  try{
    const r = await fetch('player_history.json?t='+Date.now());
    if(r.ok) playerHistory = await r.json();
  }catch(e){ /* no history data available */ }
  try{
    const r2 = await fetch('player_history_daily.json?t='+Date.now());
    if(r2.ok) playerHistoryDaily = await r2.json();
  }catch(e){}
  try{
    const r3 = await fetch('player_activity.json?t='+Date.now());
    if(r3.ok) playerActivity = await r3.json();
  }catch(e){}
  playerHistoryLoaded = true;
}
