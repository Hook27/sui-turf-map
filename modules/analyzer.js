// ── MODULE: analyzer.js ── Vendetta World Map v4.00 ──────────────────────────

// ── BATTLE ANALYZER ───────────────────────────────────────────────────────────
const BA_RPC = 'https://sui-rpc.publicnode.com'; // fullnode.mainnet.sui.io shut down July 2026
const BA_SIM_EVENT = '0x63081c5dd824a49289b6557d9f9bcf8613fe801e89dbad728616348a58b4b40a::ibattle::SimulationResultEvent';
let _baCountdownInterval = null;

async function baRpc(method, params) {
  const r = await fetch(BA_RPC, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method,params})
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

function baUnitClass(name) {
  const n=(name||'').toLowerCase();
  if(n.includes('enforcer')) return 'ef';
  if(n.includes('bouncer')||n.includes('bodyguard')) return 'bc';
  return 'hm';
}

function baCountUnits(units) {
  let H=0,B=0,E=0;
  for(const u of units){const c=baUnitClass(u.gangster_name||u.name||'');if(c==='hm')H++;else if(c==='bc')B++;else E++;}
  return {H,B,E};
}

function baColoredComp(H,B,E) {
  const parts=[];
  if(H>0) parts.push(`<span style="color:#aaa">${H}H</span>`);
  if(B>0) parts.push(`<span style="color:#6fffa9">${B}B</span>`);
  if(E>0) parts.push(`<span style="color:#ff8483">${E}E</span>`);
  return parts.join('<span style="color:#555">, </span>')||'none';
}

function baCalcSurvivors(defenderUnits, logs) {
  const hp={};
  for(const u of defenderUnits) hp[u.unit_id]={hp:parseInt(u.read_health),name:u.gangster_name};
  for(const log of logs){const du=log.defender_unit;if(du&&du.unit_id in hp)hp[du.unit_id].hp=parseInt(du.health);}
  return Object.values(hp).filter(u=>u.hp>0).map(u=>({gangster_name:u.name}));
}

function baBestAttack(H,B,E) {
  const defObj={EF:E,BC:B,HM:H};
  const defArray=_armyArray(defObj);
  const total=H+B+E;
  if(total===0) return [];
  // Use existing _ATK_CACHE if available
  const cacheKey=`ba_${_compKey(defObj)}`;
  if(_ATK_CACHE.has(cacheKey)) return _ATK_CACHE.get(cacheKey);
  const scored=_ALL_COMPS.map(comp=>{const r=_atkSim(_armyArray(comp),defArray,300);return{...comp,...r};})
    .sort((a,b)=>b.winPct-a.winPct||(a.total-b.total)||(a.avgRounds-b.avgRounds));
  const refined=scored.slice(0,9).map(comp=>{const r=_atkSim(_armyArray(comp),defArray,2000);return{...comp,...r};})
    .sort((a,b)=>b.winPct-a.winPct||(a.total-b.total)||(a.avgRounds-b.avgRounds)).slice(0,7);
  _ATK_CACHE.set(cacheKey,refined);
  return refined;
}

function baStartCountdown(deadlineMs) {
  if(_baCountdownInterval) clearInterval(_baCountdownInterval);
  function tick(){
    const el=document.getElementById('ba-countdown');
    if(!el){clearInterval(_baCountdownInterval);return;}
    const rem=deadlineMs-Date.now();
    if(rem<=0){
      el.textContent='TIME OVER';el.style.color='#ff6b6b';
      el.style.animation='ba-timeover 1.5s ease-in-out infinite';
      clearInterval(_baCountdownInterval);return;
    }
    const mins=Math.floor(rem/60000),secs=Math.floor((rem%60000)/1000);
    el.textContent=`${mins}:${secs.toString().padStart(2,'0')}`;
    if(rem>2*60*1000){el.style.color='#6fffa9';}
    else{const f=1-rem/(2*60*1000);el.style.color=`rgb(${Math.round(111+(255-111)*f)},${Math.round(255-255*f)},${Math.round(169-169*f)})`;}
  }
  tick();_baCountdownInterval=setInterval(tick,1000);
}

async function baAnalyzeDigest(digest) {
  const inner=document.getElementById('ba-result');
  inner.innerHTML=`<div style="padding:16px;text-align:center;font-size:11px;color:${_isDay()?'#806030':'#555'};font-family:var(--font-mono)">Fetching transaction…</div>`;
  try {
    const tx=await baRpc('sui_getTransactionBlock',[digest,{showEvents:true}]);
    const events=tx.events||[];
    const simEv=events.find(e=>e.type===BA_SIM_EVENT);
    if(!simEv){
      const found=events.map(e=>e.type.split('::').pop()).join(', ')||'none';
      inner.innerHTML=`<div style="padding:10px;color:#ff8483;font-size:11px;font-family:var(--font-mono)">Wrong event — SimulationResultEvent not found.<br><span style="color:#555">Found: ${found}</span></div>`;
      return;
    }
    const p=simEv.parsedJson;
    const defStart=p.defender_units||[];
    const logs=p.logs||[];
    const attackerName=p.attacker_name||'?';
    const defenderName=p.defender_name||null;
    const isFree=!defenderName;
    const orig=baCountUnits(defStart);
    const survivors=baCalcSurvivors(defStart,logs);
    const surv=baCountUnits(survivors);
    const total=surv.H+surv.B+surv.E;
    const defLabel=isFree?`Free turf (${baColoredComp(orig.H,orig.B,orig.E)})`:defenderName;
    const tsMs=tx.timestampMs?parseInt(tx.timestampMs):null;
    const timeLabel=tsMs?new Date(tsMs).toLocaleString(undefined,{dateStyle:'short',timeStyle:'medium'}):'—';
    const deadlineMs=tsMs?tsMs+6*60*1000:null;

    inner.innerHTML=`
      <div class="ba-grid">
        <div class="ba-def-panel">
          <div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;border-bottom:1px solid ${_isDay()?'#d0b880':'#1a1a1a'};padding-bottom:4px">Defenders remaining</div>
          <div style="font-size:10px;color:#888;margin-bottom:8px"><span style="font-family:var(--font-bangers);font-size:20px;color:var(--v-gold)">${total}</span> on ${isFree?'free turf':esc(defenderName)+"'s turf"}</div>
          <div class="ba-unit-row"><span class="ba-unit-label">Henchman</span><span class="ba-unit-count hm ${surv.H===0?'zero':''}">${surv.H}</span></div>
          <div class="ba-unit-row"><span class="ba-unit-label">Bouncer</span><span class="ba-unit-count bc ${surv.B===0?'zero':''}">${surv.B}</span></div>
          <div class="ba-unit-row"><span class="ba-unit-label">Enforcer</span><span class="ba-unit-count ef ${surv.E===0?'zero':''}">${surv.E}</span></div>
          <div class="ba-meta">
            <div>Attacker: <span style="color:#aaa">${esc(attackerName)}</span></div>
            <div>Defender: <span style="color:#aaa">${defLabel}</span></div>
            <div>Time: <span style="color:#aaa">${timeLabel}</span></div>
            <div>Window: <span id="ba-countdown" style="font-weight:bold">—</span></div>
          </div>
        </div>
        <div class="ba-right">
          <div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;border-bottom:1px solid ${_isDay()?'#d0b880':'#1a1a1a'};padding-bottom:4px">Attack suggestions</div>
          <div id="ba-atk-result" style="font-size:10px;color:${_isDay()?'#806030':'#555'}">Calculating…</div>
          ${total===0?`<div style="padding:8px;background:${_isDay()?'#d4f0e4':'#0a1a0a'};border:1px solid ${_isDay()?'#1a7a4a':'#1a3a1a'};color:${_isDay()?'#1a7a4a':'#6fffa9'};font-size:10px;text-align:center;margin-top:8px">No defenders — tile is capturable</div>`:''}
        </div>
      </div>`;

    if(deadlineMs) baStartCountdown(deadlineMs);

    if(total>0){
      setTimeout(()=>{
        const el=document.getElementById('ba-atk-result');
        if(!el) return;
        const top7=baBestAttack(surv.H,surv.B,surv.E);
        if(!top7.length){el.textContent='—';return;}
        const medals=['①','②','③','④','⑤','⑥','⑦'];
        const atkRows=top7.map((best,i)=>{
          const winCol=best.winPct>=80?'#6fffa9':best.winPct>=50?'#FAC775':'#ff8483';
          const gasWarn=best.avgRounds>16?' ⚠':'';
          return `<tr ${i>0?'class="ba-sep"':''}>
            <td>${medals[i]||i+1} ${best.HM}H ${best.BC}B ${best.EF}E</td>
            <td style="color:#aaa">${best.HM}</td><td style="color:#6fffa9">${best.BC}</td><td style="color:#ff8483">${best.EF}</td>
            <td style="color:${winCol}">${best.winPct.toFixed(1)}%</td>
            <td style="color:${winCol}">~${best.avgRounds.toFixed(0)}${gasWarn}</td>
          </tr>`;
        }).join('');
        el.innerHTML=`<table class="ba-atk-table">
          <thead><tr><th>Composition</th><th style="color:#aaa">H</th><th style="color:#6fffa9">B</th><th style="color:#ff8483">E</th><th>Chance</th><th>Rnd</th></tr></thead>
          <tbody>${atkRows}
          <tr class="ba-def-row ba-sep"><td>Defenders</td><td style="color:#aaa">${surv.H}</td><td style="color:#6fffa9">${surv.B}</td><td style="color:#ff8483">${surv.E}</td><td>—</td><td>—</td></tr>
          </tbody></table>`;
      },20);
    }
  } catch(e) {
    document.getElementById('ba-result').innerHTML=`<div style="padding:10px;color:#ff8483;font-size:11px;font-family:var(--font-mono)">Error: ${e.message}</div>`;
  }
}

function openBattleAnalyzer(){
  document.getElementById('battle-analyzer-modal').style.display='flex';
  // Restore wallet label
  const wallet=localStorage.getItem(PROFILE_WALLET_KEY)||'';
  const lbl=document.getElementById('ba-wallet-label');
  const btn=document.getElementById('ba-last-btn');
  if(wallet){
    lbl.textContent=wallet.slice(0,8)+'…'+wallet.slice(-4);
    lbl.style.color='#888';
    btn.disabled=false;
  } else {
    lbl.textContent='No wallet saved — add in My Profile';
    lbl.style.color='#555';
    btn.disabled=true;
  }
}

function closeBattleAnalyzer(){
  document.getElementById('battle-analyzer-modal').style.display='none';
  if(_baCountdownInterval){clearInterval(_baCountdownInterval);_baCountdownInterval=null;}
}

document.getElementById('battle-analyzer-modal').addEventListener('click',e=>{
  if(e.target===document.getElementById('battle-analyzer-modal')) closeBattleAnalyzer();
});

async function baAnalyze(){
  const input=document.getElementById('ba-url-input').value;
  const m=input.trim().match(/txblock\/([A-Za-z0-9]+)/);
  const digest=m?m[1]:null;
  const btn=document.getElementById('ba-analyze-btn');
  btn.disabled=true;
  if(!digest){
    document.getElementById('ba-result').innerHTML='<div style="padding:10px;color:#ff8483;font-size:11px;font-family:var(--font-mono)">Could not extract TX digest — paste a SuiVision URL.</div>';
  } else {
    await baAnalyzeDigest(digest);
  }
  btn.disabled=false;
}

async function baAnalyzeLastBattle(){
  const addr=localStorage.getItem(PROFILE_WALLET_KEY);
  if(!addr) return;
  const btn=document.getElementById('ba-last-btn');
  btn.disabled=true;
  document.getElementById('ba-result').innerHTML=`<div style="padding:16px;text-align:center;font-size:11px;color:${_isDay()?'#806030':'#555'};font-family:var(--font-mono)">Fetching last battle…</div>`;
  try {
    let cursor=null,digest=null;
    for(let page=0;page<5&&!digest;page++){
      const result=await baRpc('suix_queryEvents',[{Sender:addr},cursor,20,true]);
      for(const ev of (result.data||[])){if(ev.type===BA_SIM_EVENT){digest=ev.id?.txDigest;break;}}
      if(!result.hasNextPage) break;
      cursor=result.nextCursor;
    }
    if(!digest){
      document.getElementById('ba-result').innerHTML='<div style="padding:10px;color:#ff8483;font-size:11px;font-family:var(--font-mono)">No SimulationResultEvent found for this wallet.</div>';
    } else {
      await baAnalyzeDigest(digest);
    }
  } catch(e) {
    document.getElementById('ba-result').innerHTML=`<div style="padding:10px;color:#ff8483;font-size:11px;font-family:var(--font-mono)">Error: ${e.message}</div>`;
  }
  btn.disabled=false;
}

document.addEventListener('DOMContentLoaded',()=>{
  const urlInput=document.getElementById('ba-url-input');
  if(urlInput) urlInput.addEventListener('keydown',e=>{if(e.key==='Enter') baAnalyze();});
});

