// ── MODULE: battle-hist.js ── Vendetta World Map v4.00 ──────────────────────────

// ── SHARED UTILS ─────────────────────────────────────────────────────────────
function tileOwnerMap(d){
  const m=new Map();
  for(const t of (d.tiles||[])){
    const p=d.players[t.p];
    if(p) m.set(`${t.x},${t.y}`,{pid:p.pid,name:p.name,color:p.color});
  }
  return m;
}

// ── BATTLE HISTORY (24h) ──────────────────────────────────────────────────────
async function loadBattleHistory(){
  if(snapshots.length<2) return;
  const now=Date.now();
  const cutoff=now-24*60*60*1000;

  // snapshots[] is newest-first. Build oldest-first working list with timestamps.
  const withTs = snapshots.map(s=>({
    ...s,
    ms: s.timestamp ? new Date(s.timestamp).getTime() : new Date(s.label).getTime()
  })).filter(s=>!isNaN(s.ms));

  if(withTs.length<2) return;

  // Find the snapshot closest to exactly 24h ago (may be just outside the window).
  // This is the anchor — same bestIdx approach as the leaderboard.
  const newestMs = withTs[0].ms;
  let anchorIdx = withTs.length-1; // fallback: oldest available
  let bestDiff = Infinity;
  for(let i=1; i<withTs.length; i++){
    const diff = Math.abs(withTs[i].ms - cutoff);
    if(diff < bestDiff){ bestDiff=diff; anchorIdx=i; }
  }

  // Collect all snapshots from anchor up to and including newest (oldest-first for pairs).
  // withTs is newest-first, so slice from 0..anchorIdx inclusive, then reverse.
  const window = withTs.slice(0, anchorIdx+1).reverse(); // now oldest-first

  // Fetch all snapshots in the window in parallel.
  const fetched = await Promise.all(
    window.map(s => fetch(s.file+'?t='+Date.now()).then(r=>r.json()).catch(()=>null))
  );

  // Build per-snapshot owner maps.
  const ownerMaps = fetched.map(d => d ? tileOwnerMap(d) : new Map());

  // Collect pidInfo from all fetched snapshots.
  const pidInfo = new Map();
  for(const d of fetched){
    if(!d) continue;
    for(const p of (d.players||[])){
      if(!pidInfo.has(p.pid)) pidInfo.set(p.pid,{name:p.name||'',color:p.color});
    }
  }

  // Compare consecutive pairs, last-write-wins per turf key.
  // turfState tracks the current known state: key → {fromPid, toPid, type}
  const turfState = new Map();

  for(let i=0; i<ownerMaps.length-1; i++){
    const mapA = ownerMaps[i];
    const mapB = ownerMaps[i+1];
    const allKeys = new Set([...mapA.keys(),...mapB.keys()]);
    for(const key of allKeys){
      const a = mapA.get(key);
      const b = mapB.get(key);
      const fromPid = a?.pid||null;
      const toPid   = b?.pid||null;
      if(fromPid===toPid) continue; // no change in this pair
      const [x,y] = key.split(',').map(Number);
      const type = !fromPid?'new':!toPid?'abandoned':'captured';
      // Overwrite any earlier state for this turf — last change wins.
      turfState.set(key,{x,y,fromPid,toPid,type});
    }
  }

  // Build changedTiles and playerChanges from final turfState.
  const changedTiles = [];
  const playerChanges = new Map();
  for(const ch of turfState.values()){
    changedTiles.push(ch);
    if(ch.toPid){
      if(!playerChanges.has(ch.toPid)){const i=pidInfo.get(ch.toPid)||{};playerChanges.set(ch.toPid,{gained:0,lost:0,name:i.name||'',color:i.color||'#888'});}
      playerChanges.get(ch.toPid).gained++;
    }
    if(ch.fromPid){
      if(!playerChanges.has(ch.fromPid)){const i=pidInfo.get(ch.fromPid)||{};playerChanges.set(ch.fromPid,{gained:0,lost:0,name:i.name||'',color:i.color||'#888'});}
      playerChanges.get(ch.fromPid).lost++;
    }
  }

  const oldest = window[0];
  const newest = window[window.length-1];
  battleHistoryData={changedTiles,playerChanges,pidInfo,fromLabel:oldest.label,toLabel:newest.label,fromMs:oldest.ms,toMs:newest.ms};
  // Load HQ captures
  try{
    const hqr=await fetch('hq_captures.json?t='+Date.now());
    if(hqr.ok) battleHistoryData.hqCaptures=await hqr.json();
  }catch(e){}
  // Load raids
  try{
    const rdr=await fetch('raids.json?t='+Date.now());
    if(rdr.ok) battleHistoryData.raids=await rdr.json();
  }catch(e){}
  // Load free turf attacks (attack_free_turf transactions with exact timestamps)
  try{
    const ftar=await fetch('free_turf_attacks.json?t='+Date.now());
    if(ftar.ok) battleHistoryData.freeTurfAttacks=await ftar.json();
  }catch(e){}
  // Load HQ destroyed events
  try{
    const hqdr=await fetch('hq_destroyed.json?t='+Date.now());
    if(hqdr.ok) battleHistoryData.hqDestroyed=await hqdr.json();
  }catch(e){}
  renderTopMovers();
}

function toggleBattleHistory(){
  battleHistoryActive=!battleHistoryActive;
  const btn=document.getElementById('battle-btn');
  btn.classList.toggle('active',battleHistoryActive);
  drawMap();
}

// ── TOP MOVERS BANNER ─────────────────────────────────────────────────────────
// ── TICKER (CSS animation — runs on compositor thread, no main-thread cost) ──

function closeTicker(){
  document.getElementById('ticker-bar').classList.remove('visible');
}

function startTicker(){
  const track=document.getElementById('ticker-track');
  const inner=document.getElementById('ticker-inner');
  if(!track||!inner||!inner.innerHTML) return;

  // Duplicate content for seamless loop
  inner.innerHTML=inner.innerHTML+inner.innerHTML;

  // Compute animation duration: full content width at 50px/sec
  const contentW=inner.scrollWidth/2;
  const speed=50; // pixels per second
  const dur=contentW/speed;
  inner.style.setProperty('--ticker-dur', dur+'s');

  // Restart animation cleanly
  inner.style.animation='none';
  inner.offsetHeight; // force reflow
  inner.style.animation='';
}

function renderTopMovers(){
  if(!battleHistoryData) return;
  const {playerChanges, changedTiles}=battleHistoryData;
  const rows=[...playerChanges.entries()].map(([pid,c])=>({pid,...c,net:c.gained-c.lost}));
  const gainers=rows.filter(r=>r.net>0).sort((a,b)=>b.net-a.net).slice(0,3);
  const losers=rows.filter(r=>r.net<0).sort((a,b)=>a.net-b.net).slice(0,3);
  const topPlayer=players[0];
  const top10tiles=players.slice(0,10).reduce((s,p)=>s+p.tiles,0);
  const top10pct=totalTiles?(top10tiles/totalTiles*100).toFixed(1):0;
  const battles=changedTiles.filter(c=>c.type==='captured').length;
  const myPlayer=players.find(p=>MY_IDS.has(p.pid));
  const myRank=myPlayer?players.indexOf(myPlayer)+1:null;

  // Most garrisoned player
  const garMap=new Map();
  for(const t of tiles){
    const gc=(t.gH||0)+(t.gB||0)+(t.gE||0);
    if(gc>0) garMap.set(t.pid,(garMap.get(t.pid)||0)+gc);
  }
  let mostGarPid=null,mostGarCount=0;
  for(const [pid,cnt] of garMap){if(cnt>mostGarCount){mostGarCount=cnt;mostGarPid=pid;}}
  const mostGarPlayer=mostGarPid?players.find(p=>p.pid===mostGarPid):null;

  // Active players in 24h
  const activePids=new Set([...playerChanges.keys()]);

  // HQ captures
  const hqCaptures=battleHistoryData.hqCaptures||[];
  // Top capturer (most HQs taken all-time)
  const hqCapCount=new Map();
  for(const c of hqCaptures) hqCapCount.set(c.new_pid,(hqCapCount.get(c.new_pid)||0)+1);
  let topHqPid=null,topHqCount=0;
  for(const [pid,cnt] of hqCapCount){if(cnt>topHqCount){topHqCount=cnt;topHqPid=pid;}}
  const topHqPlayer=topHqPid?players.find(p=>p.pid===topHqPid):null;
  // Most victimized (most HQs lost all-time)
  const hqLostCount=new Map();
  for(const c of hqCaptures) hqLostCount.set(c.prev_pid,(hqLostCount.get(c.prev_pid)||0)+1);
  let topVictimPid=null,topVictimCount=0;
  for(const [pid,cnt] of hqLostCount){if(cnt>topVictimCount){topVictimCount=cnt;topVictimPid=pid;}}
  const topVictimName=topVictimPid?(players.find(p=>p.pid===topVictimPid)?.name||hqCaptures.find(c=>c.prev_pid===topVictimPid)?.prev_name||'Unknown'):'';
  // HQ captures in last 24h
  const now24=Date.now()-86400000;
  const hqRecent24=hqCaptures.filter(c=>new Date(c.timestamp).getTime()>=now24);
  // Last 3 captures for feed — only show if within 7 days
  const now7d = Date.now() - 7*86400000;
  const recentHqFeed = hqCaptures.filter(c=>new Date(c.timestamp).getTime()>=now7d).slice(-3).reverse();
  function hqAge(ts){
    const ms=Date.now()-new Date(ts);
    const h=Math.round(ms/3600000);
    if(h<1) return 'just now';
    if(h<24) return h+'h ago';
    return Math.floor(h/24)+'d ago';
  }

  // HQ destroyed (attacked but not captured)
  const hqDestroyed=battleHistoryData?.hqDestroyed||[];
  const hqdRecent24=hqDestroyed.filter(d=>new Date(d.timestamp).getTime()>=now24);
  const recentHqdFeed=hqDestroyed.filter(d=>new Date(d.timestamp).getTime()>=now7d).slice(-3).reverse();

  // Raids
  const raids=battleHistoryData.raids||[];
  const raidCount24=raids.filter(r=>new Date(r.timestamp).getTime()>=now24).length;
  const raidCapCount=new Map();
  for(const r of raids) raidCapCount.set(r.attacker_name||r.attacker_pid,(raidCapCount.get(r.attacker_name||r.attacker_pid)||0)+1);
  let topRaiderName=null,topRaiderCount=0;
  for(const [name,cnt] of raidCapCount){if(cnt>topRaiderCount){topRaiderCount=cnt;topRaiderName=name;}}
  const recentRaidFeed=raids.slice(-3).reverse();
  function raidAge(ts){const h=Math.round((Date.now()-new Date(ts))/3600000);return h<1?'just now':h<24?h+'h ago':Math.floor(h/24)+'d ago';}

  const sep='<span class="tk-sep">◆</span>';

  const items=[
    // Map stats
    `🗺 <span class="tk-blue">${totalTiles.toLocaleString('en')}</span> turfs claimed · <span class="tk-blue">${players.length.toLocaleString('en')}</span> players on the map`,
    // Battle intensity
    battles>50?`🔫 <span class="tk-red">${battles} turfs</span> changed hands in 24h — the streets are hot`:
    battles>10?`⚔ <span class="tk-gold">${battles} turf battles</span> fought in the last 24h`:
    `😴 Only <span class="tk-gold">${battles} skirmishes</span> in 24h — quiet night`,
    // Top player
    topPlayer?`👑 <span class="tk-gold">${esc(topPlayer.name||'Unknown')}</span> leads the city with <span class="tk-green">${topPlayer.tiles.toLocaleString('en')}</span> turfs`:null,
    // Top 10 dominance
    top10pct?`💰 Top 10 players control <span class="tk-gold">${top10pct}%</span> of all territory`:null,
    // Active players
    activePids.size?`📊 <span class="tk-green">${activePids.size}</span> players made moves in the last 24h`:null,
    // Most garrisoned
    mostGarPlayer&&mostGarCount>0?`🛡 <span class="tk-gold">${esc(mostGarPlayer.name||'Unknown')}</span> has the heaviest garrison — <span class="tk-blue">${mostGarCount}</span> total defenders deployed`:null,
    // Own stats
    myPlayer&&myRank?`🏠 <span class="tk-gold">${esc(myPlayer.name)}</span> — rank <span class="tk-green">#${myRank}</span> · ${myPlayer.tiles.toLocaleString('en')} turfs`:null,
    // Most HQ captures all-time
    topHqPlayer&&topHqCount>0?`💀 <span class="tk-gold">${esc(topHqPlayer.name||'Unknown')}</span> has captured the most HQs — <span class="tk-red">${topHqCount}</span> total`:null,
    // Most victimized player
    topVictimName&&topVictimCount>1?`🎯 <span class="tk-red">${esc(topVictimName)}</span> has had their HQ stormed <span class="tk-red">${topVictimCount}×</span> — a marked target`:null,
    // HQ capture activity last 24h
    hqRecent24.length>0?`⚡ <span class="tk-red">${hqRecent24.length}</span> HQ${hqRecent24.length===1?'':'s'} ${hqRecent24.length===1?'has':'have'} fallen in the last 24h`:null,
    // Recent HQ captures feed (last 3, newest first)
    ...recentHqFeed.map(c=>`🏴 <span class="tk-red">${esc(c.prev_name||'Unknown')}</span>'s HQ stormed by <span class="tk-gold">${esc(c.new_name||'Unknown')}</span> — ${hqAge(c.timestamp)}`),
    // HQ destroyed (attacked but not captured) last 24h
    hqdRecent24.length>0?`💥 <span class="tk-gold">${hqdRecent24.length}</span> HQ attack${hqdRecent24.length===1?'':'s'} repelled in the last 24h — defender${hqdRecent24.length===1?' held':'s held'} their ground`:null,
    // Recent HQ destroyed feed (last 3, newest first)
    ...recentHqdFeed.map(d=>`💥 <span class="tk-red">${esc(d.defender_name||'Unknown')}</span> repelled <span class="tk-gold">${esc(d.attacker_name||'Unknown')}</span>'s HQ raid — still standing — ${hqAge(d.timestamp)}`),
    // Gainers
    gainers.length?`📈 24h gainers: `+gainers.map(r=>`<span class="tk-green">▲ ${esc(r.name||'?')} +${r.net}</span>`).join(' · '):null,
    // Losers
    losers.length?`📉 24h losers: `+losers.map(r=>`<span class="tk-red">▼ ${esc(r.name||'?')} ${r.net}</span>`).join(' · '):null,
    // Raid activity 24h
    raidCount24>0?`🔫 <span class="tk-red">${raidCount24}</span> raid${raidCount24===1?'':'s'} carried out in the last 24h`:null,
    // Top raider all-time
    topRaiderName&&topRaiderCount>1?`🗡 <span class="tk-gold">${esc(topRaiderName)}</span> is the most feared raider — <span class="tk-red">${topRaiderCount}</span> raids total`:null,
    // Recent raids feed (last 3)
    ...recentRaidFeed.map(r=>{
      const fmt=v=>v.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2});
      const cash=r.cash>0?`<span class="tk-gold">$${fmt(r.cash)}</span> `:'';
      const wpn=r.weapons>0?`<span class="tk-red">${fmt(r.weapons)} arms</span> `:'';
      const xp=r.xp>0?`<span class="tk-blue">${fmt(r.xp)} XP</span>`:'';
      return `🗡 <span class="tk-gold">${esc(r.attacker_name||'Unknown')}</span> raided <span class="tk-red">${esc(r.defender_name||'Unknown')}</span> — took ${cash}${wpn}${xp} · ${raidAge(r.timestamp)}`;
    }),
  ].filter(Boolean);

  const inner=document.getElementById('ticker-inner');
  inner.innerHTML=items.join(sep)+sep;
  document.getElementById('ticker-bar').classList.add('visible');

  // Reset and start CSS ticker
  setTimeout(startTicker, 50); // wait for DOM paint
}
