// ── MODULE: intel.js ── Vendetta World Map v4.00 ──────────────────────────
// Expose drawGhostTiles to be called from drawMap

// ── SOFT TARGETS ──────────────────────────────────────────────────────────────
function openSoftTargets(){
  if(!selectedPid) return;
  renderSoftTargets();
  document.getElementById('softtarget-modal').classList.add('open');
}
function closeSoftTargets(){
  document.getElementById('softtarget-modal').classList.remove('open');
}
document.getElementById('softtarget-modal').addEventListener('click',e=>{
  if(e.target===document.getElementById('softtarget-modal')) closeSoftTargets();
});

function renderSoftTargets(){
  const el = document.getElementById('softtarget-list');
  const myTiles = tiles.filter(t => t.pid === selectedPid);
  if(!myTiles.length){ el.innerHTML='<div style="padding:16px;color:#888;font-size:11px;font-family:var(--font-mono)">No turfs found for selected player.</div>'; return; }

  // True inactivity = both lcd (turf changes) AND activity events (feed/claim) are old.
  // If activity data available: use min(lcd, activity_days) as the real inactivity metric.
  // A player with lcd=10 but activity=1 is still playing (just not expanding).
  function realInactivity(p){
    const lcdDays = p.lcd ?? 0;
    if(!playerActivity) return lcdDays; // fallback if no activity data yet
    const actDays = playerActivity?.days?.[p.pid];
    if(actDays == null) return Math.max(lcdDays, 30); // no record in 30 days = inactive
    return Math.max(lcdDays, actDays); // both must be old to be truly inactive
  }

  // Candidates: truly inactive (>= 3 days on BOTH metrics), > 1 tile, not own
  const candidates = players.filter(p =>
    p.tiles > 1 &&
    !MY_IDS.has(p.pid) &&
    p.pid !== selectedPid &&
    realInactivity(p) >= 3
  );

  if(!candidates.length){
    el.innerHTML='<div style="padding:16px;color:#888;font-size:11px;font-family:var(--font-mono)">No inactive players found with multiple turfs.</div>';
    return;
  }

  // For each candidate compute Chebyshev distance to nearest own tile
  const pidToTiles = new Map();
  for(const t of tiles){
    if(!pidToTiles.has(t.pid)) pidToTiles.set(t.pid,[]);
    pidToTiles.get(t.pid).push(t);
  }

  const scored = candidates.map(p => {
    const theirTiles = pidToTiles.get(p.pid) || [];
    let minDist = Infinity;
    for(const m of myTiles){
      for(const t of theirTiles){
        const d = Math.max(Math.abs(t.x - m.x), Math.abs(t.y - m.y));
        if(d < minDist) minDist = d;
      }
    }
    const inact = realInactivity(p);
    const score = (p.tiles * inact) / (minDist + 1);
    return {p, dist: minDist, score, inact};
  });

  scored.sort((a,b) => b.score - a.score);
  const top = scored.slice(0, 30);

  document.getElementById('softtarget-subtitle').textContent =
    `${candidates.length} inactive targets found — showing top ${top.length}` +
    (playerActivity ? '' : ' (activity data loading...)');

  el.innerHTML = top.map(({p, dist, inact}) => {
    const lcdCls = inact >= 14 ? 'old' : inact >= 7 ? 'warn' : '';
    const distTxt = dist === Infinity ? '—' : dist <= 1 ? 'adjacent' : dist + ' tiles';
    const actDays = playerActivity?.days?.[p.pid];
    const tipTxt = actDays != null
      ? `Turf change: ${p.lcd??'?'}d ago · Last active: ${actDays}d ago`
      : playerActivity?.days
        ? `Turf change: ${p.lcd??'?'}d ago · No activity in 30d`
        : `Turf change: ${p.lcd??'?'}d ago`;
    return `<div class="st-row" onclick="closeSoftTargets();jumpToPlayer('${p.pid}')" title="${tipTxt}">
      <span class="st-name">${esc(p.name||'[unknown]')}</span>
      <span class="st-tiles">${p.tiles}</span>
      <span class="st-lcd ${lcdCls}">${inact}d</span>
      <span class="st-dist">${distTxt}</span>
      <span class="st-btn"><button class="st-route-btn" onclick="event.stopPropagation();closeSoftTargets();onNeighborRoute('${selectedPid}','${p.pid}',event)">🗺 Route</button></span>
    </div>`;
  }).join('');
}

// ── WEEKLY REPORT ─────────────────────────────────────────────────────────────
let weeklyReport = null;

async function loadWeeklyReport(){
  try{
    const r = await fetch('weekly_report.json?t='+Date.now());
    if(!r.ok) return;
    weeklyReport = await r.json();
    const btn = document.getElementById('report-dd-btn');
    if(btn) btn.style.display = '';
  }catch(e){ /* no report yet */ }
}

function openReport(){
  if(!weeklyReport){ return; }
  const content = document.getElementById('report-content');
  const meta    = document.getElementById('report-head-meta');
  const start   = new Date(weeklyReport.period_start);
  const end     = new Date(weeklyReport.period_end);
  const fmt     = d => d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  meta.textContent = `${fmt(start)} – ${fmt(end)} · ${weeklyReport.stats?.hq_captures??0} HQ raids · Generated ${new Date(weeklyReport.generated).toLocaleDateString('en-GB')} · Final edition`;
  // The weekly report was suspended on 24-09-2026: the game has come to a standstill,
  // so weekly_report.json no longer updates. Say so, rather than let the last issue
  // pass for this week's. Remove this notice if weekly_report.yml is ever resumed.
  const notice = '<div style="border:1px dashed currentColor;padding:6px 10px;margin:0 0 12px;'
    + 'font-size:11px;opacity:.85">This is the final edition. <em>The Vendetta Gazette</em> '
    + 'was suspended on 24 September 2026 — the game has come to a standstill, so there is '
    + 'no longer a week to report on.</div>';
  content.innerHTML = notice + sanitizeReportHTML(weeklyReport.html || '<p>No content.</p>');
  document.getElementById('report-modal').classList.add('open');
}

// Strip scripts, iframes, event handlers, and dangerous attributes from report HTML
function sanitizeReportHTML(html){
  const div=document.createElement('div');
  div.innerHTML=html;
  // Remove dangerous elements
  div.querySelectorAll('script,iframe,object,embed,form,link,style,base,meta').forEach(el=>el.remove());
  // Remove event handler attributes and javascript: URLs
  div.querySelectorAll('*').forEach(el=>{
    for(const attr of [...el.attributes]){
      if(attr.name.startsWith('on')||
         (attr.name==='href'&&attr.value.trim().toLowerCase().startsWith('javascript:'))||
         (attr.name==='src'&&attr.value.trim().toLowerCase().startsWith('javascript:'))){
        el.removeAttribute(attr.name);
      }
    }
  });
  return div.innerHTML;
}

function printReport(){
  if(!weeklyReport) return;
  // Inject a temporary print frame with the report content
  let frame = document.getElementById('report-print-frame');
  if(!frame){
    frame = document.createElement('div');
    frame.id = 'report-print-frame';
    frame.style.display = 'none';
    document.body.appendChild(frame);
  }
  frame.innerHTML = sanitizeReportHTML(weeklyReport.html || '');
  window.print();
}

function closeReport(){
  document.getElementById('report-modal').classList.remove('open');
}

document.getElementById('report-modal').addEventListener('click', e=>{
  if(e.target === document.getElementById('report-modal')) closeReport();
});
