// ── MODULE: sim.js ── Vendetta World Map v4.00 ──────────────────────────
// ── ATTACK ADVISOR ─────────────────────────────────────────────────────────────
// Monte Carlo battle simulator based on confirmed on-chain damage tables
let _lastClickedTile = null;

const _ATK_DMG = {
  HM: { HM:[2,4,4,4,8,8],  BC:[1,2,2,2,4,4],   EF:[2,4,4,4,8,8]  },
  BC: { HM:[2,5,5,5,10,10], BC:[2,5,5,5,10,10], EF:[1,2,2,2,5,5]  },
  EF: { HM:[3,7,7,7,14,14], BC:[4,10,10,10,21,21], EF:[3,7,7,7,14,14] }
};
const _ATK_HP = { HM:9, BC:12, EF:10 };
const _ATK_CACHE = new Map();

function _atkSim(atkArmy, defArmy, N=2000){
  let wins=0, totalRounds=0, totalSurv=0;
  const defLen=defArmy.length, atkLen=atkArmy.length;
  for(let n=0;n<N;n++){
    const atk=atkArmy.slice(); for(let i=atk.length-1;i>0;i--){const j=Math.random()*i+1|0;[atk[i],atk[j]]=[atk[j],atk[i]];}
    const df=defArmy.slice();  for(let i=df.length-1;i>0;i--){const j=Math.random()*i+1|0;[df[i],df[j]]=[df[j],df[i]];}
    const ahp=atk.map(t=>_ATK_HP[t]);
    const dhp=df.map(t=>_ATK_HP[t]);
    let ai=0,di=0,rounds=0;
    while(ai<atkLen&&di<defLen){
      rounds++;
      const ar=Math.random()*6|0, dr=Math.random()*6|0;
      ahp[ai]-=_ATK_DMG[df[di]][atk[ai]][dr];
      dhp[di]-=_ATK_DMG[atk[ai]][df[di]][ar];
      if(dhp[di]<=0)di++;
      if(ahp[ai]<=0)ai++;
    }
    totalRounds+=rounds;
    if(di>=defLen&&ai<atkLen){ wins++; totalSurv+=(atkLen-ai); }
  }
  return { winPct:wins/N*100, avgRounds:totalRounds/N, avgSurv:wins>0?totalSurv/wins:0 };
}

function _genCompositions(maxUnits=10){
  const comps=[];
  for(let total=1;total<=maxUnits;total++){
    for(let e=0;e<=total;e++){
      for(let b=0;b<=total-e;b++){
        const h=total-e-b;
        comps.push({EF:e,BC:b,HM:h,total});
      }
    }
  }
  return comps;
}
const _ALL_COMPS = _genCompositions(10);

function _armyArray(obj){
  return [].concat(
    Array(obj.EF||0).fill('EF'),
    Array(obj.BC||0).fill('BC'),
    Array(obj.HM||0).fill('HM')
  );
}

function _compKey(obj){ return `${obj.EF}e${obj.BC}b${obj.HM}h`; }

function _atkLabel(c){
  return [c.EF?`<span style="color:#ff8483">${c.EF}E</span>`:'',
          c.BC?`<span style="color:#6fffa9">${c.BC}B</span>`:'',
          c.HM?`<span style="color:#aaa">${c.HM}H</span>`:''].filter(Boolean).join(' ');
}

function _renderTileAdvice(el, tile){
  const defObj={EF:tile.gE||0,BC:tile.gB||0,HM:tile.gH||0};
  const defTotal=defObj.EF+defObj.BC+defObj.HM;

  const defLabel=[defObj.EF?`<span style="color:#ff8483">${defObj.EF}E</span>`:'',
                  defObj.BC?`<span style="color:#6fffa9">${defObj.BC}B</span>`:'',
                  defObj.HM?`<span style="color:#aaa">${defObj.HM}H</span>`:''].filter(Boolean).join(' · ');

  const hqBadge=tile.isHQ?` <span style="background:#6B1A1A;color:#FAC775;font-size:8px;padding:1px 4px;border-radius:2px">HQ</span>`:'';

  if(defTotal===0){
    el.innerHTML=`<div style="padding:14px 18px">
      <div style="font-size:11px;color:#999;font-family:var(--font-mono);margin-bottom:8px">(${tile.x}, ${tile.y})${hqBadge}</div>
      <div style="color:#6fffa9;font-size:12px">No garrison — any army wins instantly.</div>
    </div>`;
    return;
  }

  if(tile.isHQ && defTotal > 10){
    el.innerHTML=`<div style="padding:14px 18px">
      <div style="font-size:11px;color:#999;font-family:var(--font-mono);margin-bottom:4px">(${tile.x}, ${tile.y})${hqBadge}</div>
      <div style="font-size:12px;margin-bottom:10px">Defending: ${defLabel} <span style="color:#999">(${defTotal} total)</span></div>
      <div style="color:#FAC775;font-size:11px;font-family:var(--font-mono);line-height:1.7">⚠ HQ has ${defTotal} defenders.<br>
      <span style="color:#888;font-size:10px">The game randomly picks 10 defenders, attacking and winning will not destroy the HQ and you will not gain the turf.</span></div>
    </div>`;
    return;
  }

  el.innerHTML=`<div style="padding:14px 18px">
    <div style="font-size:11px;color:#999;font-family:var(--font-mono);margin-bottom:4px">(${tile.x}, ${tile.y})${hqBadge}</div>
    <div style="font-size:12px;margin-bottom:12px">Defending: ${defLabel} <span style="color:#999">(${defTotal} total)</span></div>
    <div style="color:#888;font-size:10px;font-family:var(--font-mono)">Calculating best attack…</div>
  </div>`;

  setTimeout(()=>{
    const defArray=_armyArray(defObj);
    const cacheKey=_compKey(defObj);
    let top3;

    if(_ATK_CACHE.has(cacheKey)){
      top3=_ATK_CACHE.get(cacheKey);
    } else {
      // Quick sweep 500 sims
      const scored=_ALL_COMPS.map(comp=>{
        const r=_atkSim(_armyArray(comp),defArray,500);
        return {...comp,...r};
      }).sort((a,b)=>b.winPct-a.winPct||(a.total-b.total)||(a.avgRounds-b.avgRounds));
      // Refine top 5 with 3000 sims
      top3=scored.slice(0,5).map(comp=>{
        const r=_atkSim(_armyArray(comp),defArray,3000);
        return {...comp,...r};
      }).sort((a,b)=>b.winPct-a.winPct||(a.total-b.total)||(a.avgRounds-b.avgRounds)).slice(0,3);
      _ATK_CACHE.set(cacheKey,top3);
    }

    const best=top3[0];
    const gasWarn=best.avgRounds>16;

    const rowsHtml=top3.map((c,i)=>{
      const roundsColor=c.avgRounds>16?'#E24B4A':c.avgRounds>12?'#FAC775':'#6fffa9';
      const winColor=c.winPct>=80?'#6fffa9':c.winPct>=50?'#FAC775':'#E24B4A';
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid ${_isDay()?'#e0ccaa':'#111'}">
        <div style="font-size:12px">${i===0?'<span style="color:#FAC775">★</span> ':''}${_atkLabel(c)} <span style="color:#888;font-size:10px">(${c.total})</span></div>
        <div style="text-align:right;font-size:11px;font-family:var(--font-mono)">
          <span style="color:${winColor}">${c.winPct.toFixed(0)}%</span>
          <span style="color:${roundsColor};margin-left:10px">${c.avgRounds>16?'⚠ ':''}~${c.avgRounds.toFixed(0)} rnd</span>
        </div>
      </div>`;
    }).join('');

    el.innerHTML=`<div style="padding:14px 18px">
      <div style="font-size:11px;color:#999;font-family:var(--font-mono);margin-bottom:4px">(${tile.x}, ${tile.y})${hqBadge}</div>
      <div style="font-size:12px;margin-bottom:14px">Defending: ${defLabel} <span style="color:#999">(${defTotal} total)</span></div>
      <div style="font-size:9px;color:#888;font-family:var(--font-mono);margin-bottom:8px">TOP 3 ATTACKS · ★ best · ⚠ gas risk (&gt;16 rnd)</div>
      ${rowsHtml}
      <div style="margin-top:12px;font-size:9px;color:#888;font-family:var(--font-mono)">
        Best: ${_atkLabel(best)} · avg ${best.avgSurv.toFixed(1)} survivors
        ${gasWarn?`<div style="color:#E24B4A;margin-top:4px">⚠ High round count — risk of on-chain gas failure</div>`:''}
      </div>
    </div>`;
  }, 30);
}

function renderAttackAdvisor(){
  const el=document.getElementById('gar-attack-content');

  // Use last clicked tile if it belongs to the current garrison player
  const tile = _lastClickedTile && _lastClickedTile.pid===garrisonPid
    ? _lastClickedTile
    : tiles.filter(t=>t.pid===garrisonPid).sort((a,b)=>(b.gE+b.gB+b.gH)-(a.gE+a.gB+a.gH))[0];

  if(!tile){
    el.innerHTML='<div style="padding:14px 18px;color:#888;font-size:11px;font-family:var(--font-mono)">No turf selected.</div>';
    return;
  }

  _renderTileAdvice(el, tile);

  // Show tile selector if player has multiple garrisoned tiles
  const otherTiles=tiles.filter(t=>t.pid===garrisonPid&&(t.gE||t.gB||t.gH)&&(t.x!==tile.x||t.y!==tile.y))
    .sort((a,b)=>(b.gE+b.gB+b.gH)-(a.gE+a.gB+a.gH)).slice(0,8);

  if(otherTiles.length){
    const btnHtml=otherTiles.map(t=>{
      const tot=t.gE+t.gB+t.gH;
      return `<button onclick="_lastClickedTile=tiles[tileMap.get('${t.x},${t.y}')];renderAttackAdvisor()" style="font-size:9px;padding:3px 8px;margin:2px;font-family:var(--font-mono);background:${_isDay()?'#ecddb8':'#111'};border:1px solid ${_isDay()?'#c4924a':'#222'};color:${_isDay()?'#806030':'#888'};cursor:pointer;border-radius:2px">(${t.x},${t.y}) ${tot}u</button>`;
    }).join('');
    el.innerHTML+=`<div style="padding:0 18px 14px;border-top:1px solid ${_isDay()?'#d0b880':'#111'};margin-top:4px">
      <div style="font-size:9px;color:${_isDay()?'#806030':'#777'};font-family:var(--font-mono);margin:8px 0 4px">OTHER GARRISONED TURFS:</div>
      ${btnHtml}
    </div>`;
  }
}
