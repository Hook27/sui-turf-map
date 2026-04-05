// ── MODULE: gar-history.js ── Vendetta World Map v4.00 ──────────────────────────


function renderGarrisonHistory(){
  const el = document.getElementById('gar-history-chart');
  if(!garrisonPid){ el.innerHTML='<div id="gar-history-empty">No player selected.</div>'; return; }
  if(!playerHistory && !playerHistoryDaily){
    el.innerHTML=playerHistoryLoaded
      ?'<div id="gar-history-empty">No history data available for this player.<br>Will appear after next data refresh.</div>'
      :'<div id="gar-history-empty">Loading history data...</div>';
    return;
  }

  // Build counts + labels from snapshot history
  let counts = playerHistory?.players?.[garrisonPid]?.filter(v=>v!=null) || [];
  let labels  = playerHistory?.snapshots || [];

  // Try daily history — use if it covers more days
  const dailyDays = playerHistoryDaily?.days || [];
  if(dailyDays.length > counts.length){
    const dailyCounts = dailyDays.map(d => d.players?.[garrisonPid] ?? null).filter(v=>v!=null);
    const dailyLabels = dailyDays.filter(d => d.players?.[garrisonPid] != null).map(d => d.date);
    if(dailyCounts.length >= counts.length){
      counts = dailyCounts;
      labels  = dailyLabels;
    }
  }

  if(!counts||counts.length<2){
    el.innerHTML='<div id="gar-history-empty">Not enough history for this player.</div>';
    return;
  }
  const W=460, H=160, PAD={t:16,r:20,b:36,l:48};
  const cW=W-PAD.l-PAD.r, cH=H-PAD.t-PAD.b;
  const maxV=Math.max(...counts), minV=Math.min(...counts);
  const range=maxV-minV||1;
  const n=counts.length;
  const xStep=cW/(n-1);

  // Build polyline points
  const pts=counts.map((v,i)=>{
    const x=PAD.l+i*xStep;
    const y=PAD.t+cH-(v-minV)/range*cH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Y-axis ticks (3)
  const yTicks=[minV, Math.round((minV+maxV)/2), maxV];
  const yTicksSvg=yTicks.map(v=>{
    const y=PAD.t+cH-(v-minV)/range*cH;
    return `<line x1="${PAD.l-4}" y1="${y.toFixed(1)}" x2="${PAD.l}" y2="${y.toFixed(1)}" stroke="#333"/>
    <text x="${PAD.l-8}" y="${(y+4).toFixed(1)}" text-anchor="end" fill="#555" font-size="9" font-family="monospace">${v}</text>`;
  }).join('');

  // X-axis labels: show ~5 evenly spaced
  const xIdxs=[0,...[1,2,3].map(i=>Math.round(i*(n-1)/4)),n-1].filter((v,i,a)=>a.indexOf(v)===i);
  const xLabelsSvg=xIdxs.map(i=>{
    const x=PAD.l+i*xStep;
    const lbl=(labels[i]||'').replace(/UTC$/,'').trim();
    return `<text x="${x.toFixed(1)}" y="${H-4}" text-anchor="middle" fill="#444" font-size="8" font-family="monospace">${esc(lbl)}</text>`;
  }).join('');

  // Area fill
  const areaFirst=`${PAD.l},${PAD.t+cH}`;
  const areaLast=`${(PAD.l+(n-1)*xStep).toFixed(1)},${PAD.t+cH}`;
  const areaPoints=`${areaFirst} ${pts} ${areaLast}`;

  // Current value annotation
  const lastVal=counts[n-1];
  const firstVal=counts[0];
  const diff=lastVal-firstVal;
  const diffStr=(diff>=0?'+':'')+diff;
  const diffCol=diff>0?'#6fffa9':diff<0?'#ff8483':'#888';

  el.innerHTML=`
  <div style="font-size:10px;font-family:var(--font-mono);color:#666;margin-bottom:6px;display:flex;justify-content:space-between">
    <span>Turf count — last ${n} snapshots</span>
    <span style="color:${diffCol}">${diffStr} turfs vs ${labels[0]||'start'}</span>
  </div>
  <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px;height:auto;display:block">
    ${yTicks.map(v=>{const y=PAD.t+cH-(v-minV)/range*cH;return `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W-PAD.r}" y2="${y.toFixed(1)}" stroke="#1a1a1a" stroke-dasharray="3,3"/>`;}).join('')}
    <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t+cH}" stroke="#333"/>
    <line x1="${PAD.l}" y1="${PAD.t+cH}" x2="${W-PAD.r}" y2="${PAD.t+cH}" stroke="#333"/>
    ${yTicksSvg}
    ${xLabelsSvg}
    <polygon points="${areaPoints}" fill="#FAC775" opacity="0.07"/>
    <polyline points="${pts}" fill="none" stroke="#FAC775" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${(PAD.l+(n-1)*xStep).toFixed(1)}" cy="${(PAD.t+cH-(lastVal-minV)/range*cH).toFixed(1)}" r="3" fill="#FAC775"/>
  </svg>`;

  // Garrison trend — build from snapshot history using tile data per snapshot
  // Use player_history garrison data if available, else skip
  const garCounts = playerHistory?.garrison?.[garrisonPid]?.filter(v=>v!=null) || [];
  const garLabels = playerHistory?.snapshots || [];
  if(garCounts.length >= 2){
    const gn=garCounts.length;
    const gmaxV=Math.max(...garCounts), gminV=Math.min(...garCounts);
    const grange=gmaxV-gminV||1;
    const gxStep=cW/(gn-1);
    const gpts=garCounts.map((v,i)=>`${(PAD.l+i*gxStep).toFixed(1)},${(PAD.t+cH-(v-gminV)/grange*cH).toFixed(1)}`).join(' ');
    const gyTicks=[gminV,Math.round((gminV+gmaxV)/2),gmaxV];
    const gyTicksSvg=gyTicks.map(v=>{const y=PAD.t+cH-(v-gminV)/grange*cH;return `<line x1="${PAD.l-4}" y1="${y.toFixed(1)}" x2="${PAD.l}" y2="${y.toFixed(1)}" stroke="#333"/><text x="${PAD.l-8}" y="${(y+4).toFixed(1)}" text-anchor="end" fill="#555" font-size="9" font-family="monospace">${v}</text>`;}).join('');
    const gxIdxs=[0,...[1,2,3].map(i=>Math.round(i*(gn-1)/4)),gn-1].filter((v,i,a)=>a.indexOf(v)===i);
    const gxLabelsSvg=gxIdxs.map(i=>{const x=PAD.l+i*gxStep;const lbl=(garLabels[i]||'').replace(/UTC$/,'').trim();return `<text x="${x.toFixed(1)}" y="${H-4}" text-anchor="middle" fill="#444" font-size="8" font-family="monospace">${esc(lbl)}</text>`;}).join('');
    const gareaPoints=`${PAD.l},${PAD.t+cH} ${gpts} ${(PAD.l+(gn-1)*gxStep).toFixed(1)},${PAD.t+cH}`;
    const glastVal=garCounts[gn-1], gfirstVal=garCounts[0];
    const gdiff=glastVal-gfirstVal;
    const gdiffStr=(gdiff>=0?'+':'')+gdiff;
    const gdiffCol=gdiff>0?'#6fffa9':gdiff<0?'#ff8483':'#888';
    el.innerHTML+=`
    <div style="font-size:10px;font-family:var(--font-mono);color:#666;margin-top:14px;margin-bottom:6px;border-top:1px solid #1a1a1a;padding-top:12px;display:flex;justify-content:space-between">
      <span>Garrison — last ${gn} snapshots</span>
      <span style="color:${gdiffCol}">${gdiffStr} units vs ${garLabels[0]||'start'}</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px;height:auto;display:block">
      ${gyTicks.map(v=>{const y=PAD.t+cH-(v-gminV)/grange*cH;return `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W-PAD.r}" y2="${y.toFixed(1)}" stroke="#1a1a1a" stroke-dasharray="3,3"/>`;}).join('')}
      <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t+cH}" stroke="#333"/>
      <line x1="${PAD.l}" y1="${PAD.t+cH}" x2="${W-PAD.r}" y2="${PAD.t+cH}" stroke="#333"/>
      ${gyTicksSvg}
      ${gxLabelsSvg}
      <polygon points="${gareaPoints}" fill="#89c6ff" opacity="0.07"/>
      <polyline points="${gpts}" fill="none" stroke="#89c6ff" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${(PAD.l+(gn-1)*gxStep).toFixed(1)}" cy="${(PAD.t+cH-(glastVal-gminV)/grange*cH).toFixed(1)}" r="3" fill="#89c6ff"/>
    </svg>`;
  }
}

function renderGarrisonAttacks(){
  const el = document.getElementById('gar-attacks-list');
  if(!garrisonPid){ el.innerHTML='<div style="padding:16px;color:#888;font-size:11px;font-family:var(--font-mono)">No player selected.</div>'; return; }
  const raids          = (battleHistoryData&&battleHistoryData.raids)||[];
  const hqd            = (battleHistoryData&&battleHistoryData.hqDestroyed)||[];
  const hqCaptures     = (battleHistoryData&&battleHistoryData.hqCaptures)||[];
  const freeTurfAtks   = (battleHistoryData&&battleHistoryData.freeTurfAttacks)||[];

  const playerRaids = raids.filter(r=>r.attacker_pid===garrisonPid||r.defender_pid===garrisonPid);

  // HQ destroyed events (attacker was repelled)
  const playerHqd = hqd.filter(d=>d.attacker_pid===garrisonPid||d.defender_pid===garrisonPid)
    .map(d=>({...d, _type:'hqd'}));

  // HQ capture events — stored in hq_captures.json, not in raids.json
  const playerHqCap = hqCaptures
    .filter(c=>c.new_pid===garrisonPid||c.prev_pid===garrisonPid)
    .map(c=>({...c, _type:'hqcap', attacker_pid:c.new_pid, attacker_name:c.new_name||'Unknown', defender_pid:c.prev_pid, defender_name:c.prev_name||'Unknown'}));

  // Free turf attacks — exact timestamps from free_turf_attacks.json (blockchain events).
  // Only show attacks by this player (as attacker); free turfs have no defender.
  const playerFta = freeTurfAtks
    .filter(f=>f.attacker_pid===garrisonPid)
    .map(f=>({...f, _type:'fta'}));

  // Digest set of free turf attacks already covered by exact blockchain data,
  // used to suppress the snapshot fallback for the same tile change.
  const ftaDigests = new Set(playerFta.map(f=>f.digest));

  // Snapshot fallback — covers plain attacks on occupied turfs (no raid loot) that
  // don't appear in any JSON file, and free turf claims not yet in free_turf_attacks.json.
  // type:'new'      = free turf claimed (no prior owner)
  // type:'captured' = turf taken from another player without a raid transaction
  const changedTiles = (battleHistoryData&&battleHistoryData.changedTiles)||[];
  const pidInfo      = (battleHistoryData&&battleHistoryData.pidInfo)||new Map();
  const timeRange    = battleHistoryData ? `${battleHistoryData.fromLabel} → ${battleHistoryData.toLabel}` : 'last 24h';
  const snapTs       = battleHistoryData?.toMs || Date.now();

  // Dedup: skip snapshot 'captured' entries already covered by a raid+capture pair,
  // and skip snapshot 'new' entries already covered by an exact free turf attack entry.
  const raidCapturePairs = new Set(
    playerRaids.filter(r=>r.is_capture).map(r=>`${r.attacker_pid}|${r.defender_pid}`)
  );

  const snapshotEvents = changedTiles
    .filter(c=>(c.type==='captured'||c.type==='new')&&(c.toPid===garrisonPid||c.fromPid===garrisonPid))
    .filter(c=>{
      if(c.type==='captured') return !raidCapturePairs.has(`${c.toPid}|${c.fromPid}`);
      // type==='new': only show if we have no exact blockchain record for this player's free turf attacks
      if(c.type==='new') return playerFta.length===0;
      return true;
    })
    .map(c=>{
      const atkInfo=pidInfo.get(c.toPid)||{};
      const defInfo=pidInfo.get(c.fromPid)||{};
      return {
        _type:'snapshot_capture',
        _ts: snapTs,
        attacker_pid:c.toPid, attacker_name:atkInfo.name||'Unknown',
        defender_pid:c.fromPid||null, defender_name:defInfo.name||null,
        isClaim:c.type==='new',
        x:c.x, y:c.y, _timeRange:timeRange
      };
    });

  // Merge all event types and sort chronologically (newest first).
  const allEvents=[...playerRaids,...playerHqd,...playerHqCap,...playerFta,...snapshotEvents]
    .sort((a,b)=>(b._ts||new Date(b.timestamp).getTime())-(a._ts||new Date(a.timestamp).getTime()));

  if(!allEvents.length){
    el.innerHTML='<div style="padding:16px;color:#888;font-size:11px;font-family:var(--font-mono)">No attacks found for this player.<br><span style="color:#777">Attack data is collected from the next run onwards.</span></div>';
    return;
  }
  function fmtAge(ts){const h=Math.round((Date.now()-new Date(ts))/3600000);return h<1?'just now':h<24?h+'h ago':Math.floor(h/24)+'d ago';}
  function fmtLoot(r){
    const parts=[];
    if(r.cash>0)    parts.push(`<span style="color:#FAC775">$${r.cash.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>`);
    if(r.weapons>0) parts.push(`<span style="color:#ff8483">${r.weapons.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})} arms</span>`);
    if(r.xp>0)      parts.push(`<span style="color:#89c6ff">${r.xp.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})} XP</span>`);
    return parts.join(' · ');
  }
  function hasLoot(r){ return (r.cash||0)>0||(r.weapons||0)>0||(r.xp||0)>0; }

  el.innerHTML = allEvents.map(r=>{
    const isAtk = r.attacker_pid===garrisonPid;
    if(r._type==='fta'){
      // Free turf attack — exact timestamp from blockchain
      const armyParts=Object.entries(r.army||{}).map(([n,c])=>`${c}× ${n}`).join(', ');
      const result=r.won
        ?`<span style="color:#6fffa9">Turf claimed</span>`
        :`<span style="color:#ff8483">Attack failed</span>`;
      return `<div class="gar-raid-row as-attacker">
        <div><span style="color:#6fffa9">📍 Attacked free turf</span></div>
        <div class="gar-raid-loot">${result}${armyParts?` · ${esc(armyParts)}`:''}</div>
        <div class="gar-raid-meta">${fmtAge(r.timestamp)}</div>
      </div>`;
    }
    if(r._type==='snapshot_capture'){
      // Turf capture from snapshot comparison — no exact timestamp available
      const rowCls = isAtk?'gar-raid-row as-attacker':'gar-raid-row as-defender';
      let dir;
      if(r.isClaim && isAtk){
        dir=`<span style="color:#6fffa9">📍 Claimed free turf</span> <span style="color:#999;font-size:9px">(${r.x},${r.y})</span>`;
      } else if(r.isClaim){
        dir=`<span style="color:#FAC775">📍 Free turf claimed by</span> <span style="color:#aaa">${esc(r.attacker_name||'Unknown')}</span> <span style="color:#999;font-size:9px">(${r.x},${r.y})</span>`;
      } else if(isAtk){
        dir=`<span style="color:#ff8483">⚔ Captured turf</span> from <span style="color:#aaa">${esc(r.defender_name||'Unknown')}</span> <span style="color:#999;font-size:9px">(${r.x},${r.y})</span>`;
      } else {
        dir=`<span style="color:#FAC775">⚔ Turf captured by</span> <span style="color:#aaa">${esc(r.attacker_name||'Unknown')}</span> <span style="color:#999;font-size:9px">(${r.x},${r.y})</span>`;
      }
      return `<div class="${rowCls}">
        <div>${dir}</div>
        <div class="gar-raid-meta" style="color:#555">within ${esc(r._timeRange)}</div>
      </div>`;
    }
    if(r._type==='hqcap'){
      // HQ capture event
      const rowCls = isAtk?'gar-raid-row as-attacker':'gar-raid-row as-defender';
      const dir = isAtk
        ? `<span style="color:#ff8483">🏴 Captured HQ</span> of <span style="color:#aaa">${esc(r.defender_name)}</span>`
        : `<span style="color:#FAC775">🏴 HQ captured by</span> <span style="color:#aaa">${esc(r.attacker_name)}</span>`;
      return `<div class="${rowCls}">
        <div>${dir}</div>
        <div class="gar-raid-meta">${fmtAge(r.timestamp)}</div>
      </div>`;
    }
    if(r._type==='hqd'){
      // HQ destroyed event
      const rowCls = isAtk?'gar-raid-row as-attacker':'gar-raid-row as-defender';
      const dir = isAtk
        ? `<span style="color:#ff8483">💥 HQ destroyed</span> <span style="color:#aaa">${esc(r.defender_name||'Unknown')}</span> <span style="color:#999;font-size:9px">(held ground)</span>`
        : `<span style="color:#FAC775">💥 HQ destroyed by</span> <span style="color:#aaa">${esc(r.attacker_name||'Unknown')}</span> <span style="color:#999;font-size:9px">(still standing)</span>`;
      const loot = fmtLoot(r);
      return `<div class="${rowCls}">
        <div>${dir}</div>
        ${loot?`<div class="gar-raid-loot">${isAtk?'Looted: ':'Lost: '}${loot}</div>`:''}
        <div class="gar-raid-meta">${fmtAge(r.timestamp)}</div>
      </div>`;
    }

    const captured = !!r.is_capture;
    const looted   = hasLoot(r);
    const rowCls   = isAtk?'gar-raid-row as-attacker':'gar-raid-row as-defender';
    let dir, resultLine;

    if(isAtk){
      if(captured && !looted){
        dir        = `<span style="color:#ff8483">⚔ Attacked</span> <span style="color:#aaa">${esc(r.defender_name||'Unknown')}</span>`;
        resultLine = `<div class="gar-raid-loot"><span style="color:#6fffa9">Captured turf</span></div>`;
      } else if(captured && looted){
        dir        = `<span style="color:#ff8483">⚔ Raided + Captured</span> <span style="color:#aaa">${esc(r.defender_name||'Unknown')}</span>`;
        resultLine = `<div class="gar-raid-loot">Looted: ${fmtLoot(r)} · <span style="color:#6fffa9">captured turf</span></div>`;
      } else {
        dir        = `<span style="color:#ff8483">⚔ Raided</span> <span style="color:#aaa">${esc(r.defender_name||'Unknown')}</span>`;
        resultLine = `<div class="gar-raid-loot">Looted: ${looted?fmtLoot(r):'<span style="color:#777">nothing</span>'}</div>`;
      }
    } else {
      if(captured && !looted){
        dir        = `<span style="color:#FAC775">⚔ Turf captured by</span> <span style="color:#aaa">${esc(r.attacker_name||'Unknown')}</span>`;
        resultLine = `<div class="gar-raid-loot"><span style="color:#ff8483">Lost turf</span></div>`;
      } else if(captured && looted){
        dir        = `<span style="color:#FAC775">⚔ Raided + captured by</span> <span style="color:#aaa">${esc(r.attacker_name||'Unknown')}</span>`;
        resultLine = `<div class="gar-raid-loot">Lost: ${fmtLoot(r)} · <span style="color:#ff8483">lost turf</span></div>`;
      } else {
        dir        = `<span style="color:#89c6ff">🛡 Raided by</span> <span style="color:#aaa">${esc(r.attacker_name||'Unknown')}</span>`;
        resultLine = `<div class="gar-raid-loot">Lost: ${looted?fmtLoot(r):'<span style="color:#777">nothing</span>'}</div>`;
      }
    }

    return `<div class="${rowCls}">
      <div>${dir}</div>
      ${resultLine}
      <div class="gar-raid-meta">${fmtAge(r.timestamp)}</div>
    </div>`;
  }).join('');
}
