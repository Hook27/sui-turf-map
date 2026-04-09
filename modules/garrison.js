// ── MODULE: garrison.js ── Vendetta World Map v4.00 ──────────────────────────

// ── GARRISON MODAL ────────────────────────────────────────────────────────────
let garrisonPid = null;
let garrisonRows = []; // [{tile, selected}]
let garrisonAllTiles = []; // all tiles for navigate tab (incl HQ)

function switchGarrisonTab(tab){
  ['navigate','recall','history','attacks','attack'].forEach(t=>{
    document.getElementById(`garrison-tab-${t}`).classList.toggle('active', t===tab);
    document.getElementById(`tab-btn-${t}`).classList.toggle('active', t===tab);
  });
  if(tab==='history') renderGarrisonHistory();
  if(tab==='attacks') renderGarrisonAttacks();
  if(tab==='attack')  renderAttackAdvisor();
}

// ── GARRISON SORT ─────────────────────────────────────────────────────────────
let garSortKeys = [{col:'total', dir:'desc'}]; // default: total desc

function garSortBy(col){
  const idx = garSortKeys.findIndex(k=>k.col===col);
  if(idx===0){
    // Already primary — toggle direction
    garSortKeys[0].dir = garSortKeys[0].dir==='desc'?'asc':'desc';
  } else if(idx>0){
    // Already in list but not primary — move to front, toggle dir
    const key = garSortKeys.splice(idx,1)[0];
    key.dir = key.dir==='desc'?'asc':'desc';
    garSortKeys.unshift(key);
  } else {
    // New column — add as primary
    garSortKeys.unshift({col, dir:'desc'});
    if(garSortKeys.length>3) garSortKeys.pop(); // max 3 levels
  }
  _renderGarSortIndicators();
  renderGarrisonNavList();
  renderGarrisonList();
}

function garSortReset(){
  garSortKeys=[{col:'total', dir:'desc'}];
  _renderGarSortIndicators();
  renderGarrisonNavList();
  renderGarrisonList();
}

function _garVal(t, col){
  if(col==='EF')    return t.gE||0;
  if(col==='BC')    return t.gB||0;
  if(col==='HM')    return t.gH||0;
  if(col==='total') return (t.gE||0)+(t.gB||0)+(t.gH||0);
  return 0;
}

function applyGarSort(tilesArr){
  return [...tilesArr].sort((a,b)=>{
    // HQ always first
    if(a.isHQ!==b.isHQ) return a.isHQ?-1:1;
    for(const {col,dir} of garSortKeys){
      const diff=_garVal(b,col)-_garVal(a,col);
      if(diff!==0) return dir==='desc'?diff:-diff;
    }
    return 0;
  });
}

function _renderGarSortIndicators(){
  const isDefault = garSortKeys.length===1 && garSortKeys[0].col==='total' && garSortKeys[0].dir==='desc';
  // Show/hide reset buttons in both tabs
  const resetBtn=document.getElementById('gar-sort-reset');
  if(resetBtn) resetBtn.style.display=isDefault?'none':'';
  const navResetBtn=document.getElementById('gar-nav-sort-reset');
  if(navResetBtn) navResetBtn.style.display=isDefault?'none':'';

  // Helper: label for a col
  function colLabel(col){
    const wide=window.innerWidth>=601;
    if(col==='EF') return wide?'Enforcer':'E';
    if(col==='BC') return wide?'Bouncer':'B';
    if(col==='HM') return wide?'Henchman':'H';
    return 'Total';
  }
  function colColor(col){ return col==='EF'?'#ff8483':col==='BC'?'#6fffa9':col==='HM'?'#aaa':'#ccc'; }

  // Update nav header
  const navHead=document.getElementById('gar-nav-head');
  if(navHead){
    const spans=navHead.querySelectorAll('span');
    // spans[0]=Position, [1]=H, [2]=B, [3]=E, [4]=Total
    [['HM',1],['BC',2],['EF',3],['total',4]].forEach(([col,si])=>{
      const k=garSortKeys.findIndex(k=>k.col===col);
      const arrow=k>=0?(garSortKeys[k].dir==='desc'?'▼':'▲'):'';
      const num=k>=0&&garSortKeys.length>1?`<sup>${k+1}</sup>`:'';
      spans[si].innerHTML=`${colLabel(col)}${arrow}${num}`;
    });
  }
  // Update recall header
  const recHead=document.getElementById('gar-recall-head');
  if(recHead){
    const spans=recHead.querySelectorAll('span');
    // spans[0]=empty, [1]=Position, [2]=H, [3]=B, [4]=E, [5]=Total
    [['HM',2],['BC',3],['EF',4],['total',5]].forEach(([col,si])=>{
      const k=garSortKeys.findIndex(k=>k.col===col);
      const arrow=k>=0?(garSortKeys[k].dir==='desc'?'▼':'▲'):'';
      const num=k>=0&&garSortKeys.length>1?`<sup>${k+1}</sup>`:'';
      spans[si].innerHTML=`${colLabel(col)}${arrow}${num}`;
    });
  }
}

function openGarrison(pid, e){
  if(e) e.stopPropagation();
  garrisonPid = pid;
  garrisonRows = [];
  const p=players.find(pl=>pl.pid===pid)||{};
  document.getElementById('garrison-title').textContent=`🛡 ${p.name||'[unknown]'}`;

  const garTiles=tiles
    .filter(t=>t.pid===pid&&(t.gH||t.gB||t.gE)&&!t.isHQ)
    .sort((a,b)=>b.gE-a.gE||b.gB-a.gB||b.gH-a.gH);
  const hqTile=tiles.find(t=>t.pid===pid&&t.isHQ&&(t.gH||t.gB||t.gE));
  const allRows=[...(hqTile?[hqTile]:[]),...garTiles];

  // All tiles (garrisoned or not) for navigate tab, HQ first then by garrison size
  const allPlayerTiles=tiles
    .filter(t=>t.pid===pid)
    .sort((a,b)=>{
      if(a.isHQ!==b.isHQ) return a.isHQ?-1:1;
      return (b.gE+b.gB+b.gH)-(a.gE+a.gB+a.gH);
    });
  garrisonAllTiles=allPlayerTiles;

  garrisonRows = allRows.map(t=>({tile:t, selected:false}));

  const total=allRows.reduce((s,t)=>s+t.gE+t.gB+t.gH,0);
  document.getElementById('garrison-subtitle').textContent=
    `${allPlayerTiles.length} turfs · ${allRows.length} garrisoned · ${total} units`;

  renderGarrisonNavList();
  renderGarrisonList();
  _renderGarSortIndicators();
  document.getElementById('garrison-recall-bar').classList.remove('visible');
  switchGarrisonTab('navigate');
  document.getElementById('garrison-modal').classList.add('open');

  // ── Live player data fetch ──
  const liveSec=document.getElementById('garrison-live-section');
  if(liveSec){
    liveSec.style.display='none';
    liveSec.innerHTML='';
    fetchPlayerLive(pid).then(function(live){
      if(!document.getElementById('garrison-modal').classList.contains('open')) return;
      const g=live.gangsters;
      const ts=new Date(live.cachedAt).toLocaleTimeString();
      const cdLabels={
        feed_people:'Feed people', raid_cooldown:'Raid', mission_cooldown:'Mission',
        safe_cooldown:'Safe', hire_scouts_cooldown:'Scouts', bullet_purchase:'Bullets',
        hospitalization:'Hospital', blackmail_attack_cooldown:'Blackmail atk',
        blackmail_looted_cooldown:'Blackmail loot', attack_protection:'Atk protection',
        boost_production:'Boost prod'
      };
      const perkLabels={
        boost_production:'Boost prod', attack_protection:'Atk protection',
        blackmail_protection:'Blackmail prot', newbie_protection:'Newbie prot',
        attack_reset:'Atk reset'
      };
      let activeCd=[];
      for(const k in live.timers){
        const cd=rtCooldownRemaining(live.timers[k]);
        if(cd.ms>0) activeCd.push({key:k, label:cdLabels[k]||k, remaining:cd.label});
      }
      activeCd.sort((a,b)=>live.timers[a.key]-live.timers[b.key]);
      activeCd=activeCd.slice(0,5);
      const activePerks=[];
      for(const pk in live.perks){
        const cd=rtCooldownRemaining(live.perks[pk]);
        if(cd.ms>0) activePerks.push({label:perkLabels[pk]||pk, remaining:cd.label});
      }
      let html=
        '<div style="font-size:9px;color:#6fffa9;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px">'+
        '⟳ Live data <span style="color:#444;font-size:8px;margin-left:6px">'+ts+'</span></div>'+
        '<div style="font-size:10px;font-family:var(--font-mono);margin-bottom:6px">'+
        '<span style="color:#888;font-size:9px;text-transform:uppercase;margin-right:6px">Gangsters</span>'+
        '<span style="color:#aaa">'+g.hm+'H</span> '+
        '<span style="color:#6fffa9">'+g.bc+'B</span> '+
        '<span style="color:#ff8483">'+g.ef+'E</span> '+
        '<span style="color:#555;font-size:9px"> · '+g.total+' total · '+g.recruits+' recruits</span>'+
        '</div>';
      if(activeCd.length){
        html+='<div style="font-size:9px;color:#888;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Cooldowns</div>'+
          '<div style="font-size:10px;font-family:var(--font-mono);display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:5px">';
        for(const cd of activeCd)
          html+='<span><span style="color:#888">'+cd.label+'</span> <span style="color:#FAC775">'+cd.remaining+'</span></span>';
        html+='</div>';
      }
      if(activePerks.length){
        html+='<div style="font-size:9px;color:#888;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Perks</div>'+
          '<div style="font-size:10px;font-family:var(--font-mono);display:flex;flex-wrap:wrap;gap:4px 12px">';
        for(const pk of activePerks)
          html+='<span><span style="color:#888">'+pk.label+'</span> <span style="color:#89c6ff">'+pk.remaining+'</span></span>';
        html+='</div>';
      }
      liveSec.innerHTML=html;
      liveSec.style.display='block';
    }).catch(function(){ /* silently skip */ });
  }
}

function renderGarrisonNavList(){
  const el=document.getElementById('gar-nav-list');
  if(!garrisonAllTiles.length){
    el.innerHTML='<div style="padding:1rem;color:#888;font-size:11px;font-family:var(--font-mono)">No turfs found.</div>';
    return;
  }
  const sorted=applyGarSort(garrisonAllTiles);
  el.innerHTML=sorted.map(t=>{
    const hqBadge=t.isHQ?`<span class="gar-nav-hq">HQ</span>`:'';
    const tot=t.gE+t.gB+t.gH;
    return `<div class="gar-nav-row" onclick="garNavJump(${t.x},${t.y})" title="Jump to (${t.x}, ${t.y})">
      <span class="gar-nav-pos">(${t.x}, ${t.y})${hqBadge}</span>
      <span class="gar-nav-h">${t.gH?t.gH+'H':'-'}</span>
      <span class="gar-nav-b">${t.gB?t.gB+'B':'-'}</span>
      <span class="gar-nav-e">${t.gE?t.gE+'E':'-'}</span>
      <span class="gar-nav-tot">${tot||'-'}</span>
    </div>`;
  }).join('');
}

function garNavJump(wx,wy){
  closeGarrison();
  jumpToTile(wx,wy);
}

function renderGarrisonList(){
  const el=document.getElementById('garrison-list');
  if(!garrisonRows.length){
    el.innerHTML='<div style="padding:1rem;color:#888;font-size:11px;font-family:var(--font-mono)">No garrison data found.</div>';
    return;
  }
  // Apply sort to rows, preserving index for toggle
  const sortedRows=applyGarSort(garrisonRows.map((r,i)=>({...r.tile,_idx:i}))).map(t=>({row:garrisonRows[t._idx],i:t._idx}));
  el.innerHTML=sortedRows.map(({row,i})=>{
    const t=row.tile;
    const hqBadge=t.isHQ?'<span class="gar-hq-badge">HQ</span>':'';
    const tot=t.gE+t.gB+t.gH;
    const noOid=!t.oid&&!t.isHQ;
    const selCls=row.selected?' selected':'';
    return `<div class="gar-row${selCls}" onclick="toggleGarrisonRow(${i})">
      <input class="gar-check" type="checkbox" ${row.selected?'checked':''} ${noOid?'disabled':''} onclick="event.stopPropagation();toggleGarrisonRow(${i})">
      <span class="gar-pos">(${t.x}, ${t.y})${hqBadge}</span>
      <span class="gar-h">${t.gH}H</span>
      <span class="gar-b">${t.gB}B</span>
      <span class="gar-e">${t.gE}E</span>
      <span class="gar-total">${tot}</span>
    </div>`;
  }).join('');
  updateRecallBar();
}

function toggleGarrisonRow(i){
  const row=garrisonRows[i];
  if(!row.tile.oid&&!row.tile.isHQ) return; // no object ID available
  row.selected=!row.selected;
  renderGarrisonList();
}

function garrisonSelectAll(){
  const anyUnselected=garrisonRows.some(r=>!r.selected&&r.tile.oid);
  garrisonRows.forEach(r=>{ if(r.tile.oid||r.tile.isHQ) r.selected=anyUnselected; });
  renderGarrisonList();
}

function updateRecallBar(){
  const sel=garrisonRows.filter(r=>r.selected&&!r.tile.isHQ);
  const bar=document.getElementById('garrison-recall-bar');
  const info=document.getElementById('garrison-recall-info');
  if(sel.length>0){
    const units=sel.reduce((s,r)=>s+r.tile.gE+r.tile.gB+r.tile.gH,0);
    info.textContent=`${sel.length} turf${sel.length>1?'s':''} selected · ${units} units · ${units} tx calls`;
    bar.classList.add('visible');
  } else {
    bar.classList.remove('visible');
  }
}

function closeGarrison(){
  document.getElementById('garrison-modal').classList.remove('open');
  garrisonPid=null; garrisonRows=[];
}

function jumpToTile(wx,wy){
  const cv=document.getElementById('map');
  panX=cv.width/2-(wx-minX)*CELL*zoom;
  panY=cv.height/2-(maxY-wy)*CELL*zoom;
  drawMap();drawMinimap();
}

document.getElementById('garrison-modal').addEventListener('click',e=>{
  if(e.target===document.getElementById('garrison-modal')) closeGarrison();
});
