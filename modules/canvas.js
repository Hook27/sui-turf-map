// ── MODULE: canvas.js ── Vendetta World Map v4.00 ──────────────────────────

// ── NEIGHBOR POPUP ────────────────────────────────────────────────────────────
function selectPlayerNoPan(pid){
  // Select a player and highlight without panning the map
  if(pid===selectedPid){
    // Same player — just update highlight, don't pan
    highlightPid=pid;
    drawMap();
    setTimeout(()=>{highlightPid=null;drawMap();},2000);
    return;
  }
  highlightPid=pid;
  selectedPid=pid;
  const ghostBtn=document.getElementById('intel-btn');
  if(ghostBtn) ghostBtn.disabled=false;
  const ghostDdBtn=document.getElementById('ghost-dd-btn');
  if(ghostDdBtn) ghostDdBtn.disabled=false;
  if(ghostMode){ computeGhostTiles(); _startGhostLoop(); }
  const stBtn=document.getElementById('softtarget-dd-btn');
  if(stBtn) stBtn.disabled=false;
  drawMap();drawMinimap();
  setTimeout(()=>{highlightPid=null;drawMap();},2000);
}

let _pulseRaf=0, _pulseTileRef=null, _pulseStart=0;
function _pulseTile(tile){
  _pulseTileRef=tile;
  _pulseStart=performance.now();
  if(_pulseRaf) cancelAnimationFrame(_pulseRaf);
  function loop(){
    const cv=document.getElementById('map');
    const ctx=cv.getContext('2d');
    const elapsed=performance.now()-_pulseStart;
    const cs=CELL*zoom;
    const sx=(tile.x-minX)*cs+panX;
    const sy=(maxY-tile.y)*cs+panY;
    if(sx>-cs&&sx<cv.width&&sy>-cs&&sy<cv.height){
      const phase=(elapsed%600)/600; // 0→1 cycle
      const alpha=0.7*(1-phase);
      const expand=cs*0.3*phase;
      ctx.strokeStyle=`rgba(255,220,80,${alpha})`;
      ctx.lineWidth=2;
      ctx.strokeRect(sx-expand/2,sy-expand/2,cs+expand,cs+expand);
    }
    if(elapsed<1800) _pulseRaf=requestAnimationFrame(loop);
    else { _pulseRaf=0; _pulseTileRef=null; drawMap(); }
  }
  _pulseRaf=requestAnimationFrame(loop);
}

function showNeighborPopup(pid,sx,sy,clickedTile){
  const popup=document.getElementById('neighbor-popup');
  const nbrs=neighborMap.get(pid);
  const p=players.find(pl=>pl.pid===pid)||{};
  document.getElementById('neighbor-title').textContent = p.name||'[unknown]';

  // ── Attack suggestion + live garrison (shared state) ──
  const atkEl=document.getElementById('neighbor-attack-suggestion');
  const nbrsHead=document.getElementById('neighbor-neighbors-head');
  if(nbrsHead){ nbrsHead.style.display='block'; nbrsHead.textContent=`Neighbors (${nbrs?nbrs.size:0})`; }
  const tile=clickedTile||null;
  let runAtkSim=null;
  if(tile&&atkEl){
    atkEl.style.cssText='display:block;padding:8px 14px 10px;background:#0d0d14;border-bottom:1px solid #1a1a1a';
    const GRID='display:grid;grid-template-columns:76px 38px 38px 38px 1fr 1fr;font-size:11px;align-items:center;padding:3px 0;border-top:1px solid #1a1a1a;font-family:var(--font-mono)';
    const HDR='display:grid;grid-template-columns:76px 38px 38px 38px 1fr 1fr;font-size:9px;text-transform:uppercase;margin-bottom:4px;align-items:center;font-family:var(--font-mono)';
    const ATK_HEAD='<div style="font-size:9px;color:#888;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Attack Suggestion</div>';
    function tableHTML(aH,aB,aE,winHtml,rndHtml){
      return `
      <div style="${HDR}">
        <span></span>
        <span style="text-align:center;color:#ccc">H</span>
        <span style="text-align:center;color:#6fffa9">B</span>
        <span style="text-align:center;color:#ff8483">E</span>
        <span style="text-align:center;color:#999">Chance</span>
        <span style="text-align:center;color:#999">Rnd</span>
      </div>
      <div style="${GRID}">
        <span style="font-size:9px;color:#999;text-transform:uppercase">Attackers</span>
        <span style="text-align:center;color:#ccc">${aH}</span>
        <span style="text-align:center;color:#6fffa9">${aB}</span>
        <span style="text-align:center;color:#ff8483">${aE}</span>
        <span style="text-align:center">${winHtml}</span>
        <span style="text-align:center">${rndHtml}</span>
      </div>`;
    }
    runAtkSim=function(defHM,defBC,defEF){
      if(defHM===0&&defBC===0&&defEF===0){
        atkEl.innerHTML=ATK_HEAD+'<div style="font-size:10px;color:#6fffa9;font-family:var(--font-mono)">No garrison — any army wins</div>';
        return;
      }
      const defObj={EF:defEF,BC:defBC,HM:defHM};
      const cacheKey=_compKey(defObj);
      let best;
      if(_ATK_CACHE.has(cacheKey)){
        best=_ATK_CACHE.get(cacheKey)[0];
      } else {
        const defArray=_armyArray(defObj);
        const scored=_ALL_COMPS.map(comp=>{
          const r=_atkSim(_armyArray(comp),defArray,300);
          return {...comp,...r};
        }).sort((a,b)=>b.winPct-a.winPct||(a.total-b.total)||(a.avgRounds-b.avgRounds));
        const refined=scored.slice(0,3).map(comp=>{
          const r=_atkSim(_armyArray(comp),defArray,2000);
          return {...comp,...r};
        }).sort((a,b)=>b.winPct-a.winPct||(a.total-b.total)||(a.avgRounds-b.avgRounds));
        _ATK_CACHE.set(cacheKey,refined);
        best=refined[0];
      }
      const winCol=best.winPct>=80?'#6fffa9':best.winPct>=50?'#FAC775':'#E24B4A';
      const gasWarn=best.avgRounds>16?' ⚠':''; const rndCol=best.avgRounds>16?'#E24B4A':winCol;
      atkEl.innerHTML=ATK_HEAD+tableHTML(best.HM,best.BC,best.EF,
        `<span style="color:${winCol}">${best.winPct.toFixed(0)}%</span>`,
        `<span style="color:${rndCol}">~${best.avgRounds.toFixed(0)}${gasWarn}</span>`
      );
    };
    // Loading state — sim runs after live data resolves
    atkEl.innerHTML=ATK_HEAD+tableHTML('…','…','…','<span style="color:#999">…</span>','<span style="color:#999">…</span>');
  } else if(atkEl){
    atkEl.style.display='none';
  }
  const list=document.getElementById('neighbor-list');
  const marks=loadMarks();
  if(!nbrs||nbrs.size===0){
    list.innerHTML='<div style="padding:1rem;color:#999;font-size:12px">No neighboring players found.</div>';
  } else {
    const sorted=[...nbrs.entries()].sort((a,b)=>b[1]-a[1]);
    list.innerHTML=sorted.map(([npid,cnt])=>{
      const np=players.find(pl=>pl.pid===npid)||{};
      const isMe=MY_IDS.has(npid);
      const mark=marks[npid]||null;
      const dotCol=markColor(npid,np.color||'#666');
      const fCls=mark==='friend'?'mark-friend':'';
      const eCls=mark==='enemy'?'mark-enemy':'';
      return `<div class="nrow" onclick="onNeighborClick('${npid}')">
        <div class="ndot" style="background:${dotCol}"></div>
        <div class="nname${np.name?'':' unnamed'}${isMe?' me':''}">${esc(np.name||'[unknown]')}</div>
        <div class="ncontact">${cnt} border${cnt>1?'s':''}</div>
        <button class="nmark ${fCls}" data-pid="${npid}" data-mtype="friend" onclick="toggleMark('${npid}','friend',event)" title="Friend">♥</button>
        <button class="nmark ${eCls}" data-pid="${npid}" data-mtype="enemy" onclick="toggleMark('${npid}','enemy',event)" title="Enemy">✕</button>
      </div>`;
    }).join('');
  }
  popup.style.display='block';
  const pw=popup.offsetWidth,ph=popup.offsetHeight;
  let lx=sx+12,ly=sy-10;
  if(lx+pw>window.innerWidth-10) lx=sx-pw-12;
  if(lx<8) lx=8; // clamp left edge
  if(ly+ph>window.innerHeight-10) ly=window.innerHeight-ph-10;
  if(ly<10) ly=10;
  popup.style.left=lx+'px';popup.style.top=ly+'px';

  // ── Live garrison fetch — drives attack sim ──
  const liveEl=document.getElementById('neighbor-live-gar');
  if(liveEl&&tile){
    if(clickedTile.oid){
      liveEl.innerHTML='<div style="padding:6px 14px;font-size:9px;color:#555;font-family:var(--font-mono)">Loading live data…</div>';
      fetchTurfLive(clickedTile.oid).then(function(live){
        if(popup.style.display==='none') return;
        const ts=new Date(live.cachedAt).toLocaleTimeString();
        const cdInfo=rtCooldownRemaining(live.cooldown);
        liveEl.innerHTML='<div style="padding:6px 14px 8px;background:#080d08;border-bottom:1px solid #1a1a1a">'+
          '<div style="font-size:9px;color:#6fffa9;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">⟳ Live garrison</div>'+
          '<div style="font-size:11px;font-family:var(--font-mono);display:flex;gap:10px;align-items:baseline">'+
          '<span style="color:#aaa">'+live.hm+'H</span>'+
          '<span style="color:#6fffa9">'+live.bc+'B</span>'+
          '<span style="color:#ff8483">'+live.ef+'E</span>'+
          '<span style="color:#555;font-size:9px">= '+live.total+'</span>'+
          (cdInfo.label!=='—'?'<span style="color:#FAC775;font-size:9px;margin-left:4px">cd '+cdInfo.label+'</span>':'')+
          '</div>'+
          '<div style="font-size:8px;color:#444;font-family:var(--font-mono);margin-top:3px">'+ts+'</div>'+
          '</div>';
        if(runAtkSim) setTimeout(()=>runAtkSim(live.hm,live.bc,live.ef),0);
      }).catch(function(){
        liveEl.innerHTML='';
        if(runAtkSim) setTimeout(()=>runAtkSim(tile.gH||0,tile.gB||0,tile.gE||0),0);
      });
    } else {
      liveEl.innerHTML='';
      if(runAtkSim) setTimeout(()=>runAtkSim(tile.gH||0,tile.gB||0,tile.gE||0),20);
    }
  } else if(tile&&runAtkSim){
    setTimeout(()=>runAtkSim(tile.gH||0,tile.gB||0,tile.gE||0),20);
  }
}
function closeNeighborPopup(){document.getElementById('neighbor-popup').style.display='none';}
function onNeighborClick(pid){closeNeighborPopup();jumpToPlayer(pid);}
function onNeighborRoute(pidA,pidB,e){
  e.stopPropagation();closeNeighborPopup();
  routePidA=pidA;routePidB=pidB;
  if(!routeMode) toggleRouteMode();
  computeAndShowRoute();renderPlayerList();
}

// ── CANVAS ────────────────────────────────────────────────────────────────────
// Cached DOM references (set once after first resize)
let _mapCv=null, _mapCtx=null, _mmCv=null;

function resizeCanvas(){
  const wrap=document.getElementById('map-wrap');
  const cv=document.getElementById('map');
  cv.width=wrap.clientWidth;cv.height=wrap.clientHeight;
  _mapCv=cv; _mapCtx=cv.getContext('2d');
  _mmCv=document.getElementById('minimap-canvas');
  // Size minimap canvas once (not every draw — assignment clears + reallocates buffer)
  const mmRect=_mmCv.getBoundingClientRect();
  if(mmRect.width>0&&mmRect.height>0){
    _mmCv.width=Math.round(mmRect.width);
    _mmCv.height=Math.round(mmRect.height);
  }
}
window.addEventListener('resize',()=>{resizeCanvas();drawMap();drawMinimap();});
function worldToScreen(wx,wy){return{sx:(wx-minX)*CELL*zoom+panX,sy:(maxY-wy)*CELL*zoom+panY};}
function screenToWorld(sx,sy){return{wx:Math.round((sx-panX)/(CELL*zoom)+minX),wy:Math.round(maxY-(sy-panY)/(CELL*zoom))};}

// ── rAF draw coalescing ──────────────────────────────────────────────────────
// During continuous interaction (touch drag, pinch), multiple move events fire
// per frame. This coalesces them into a single drawMap() per animation frame
// and defers drawMinimap() until interaction ends.
let _drawRaf=0, _touchActive=false, _mmDirty=false;

function requestDraw(){
  _mmDirty=true;
  if(_drawRaf) return; // already scheduled
  _drawRaf=requestAnimationFrame(()=>{
    _drawRaf=0;
    drawMap();
    if(!_touchActive){ drawMinimap(); _mmDirty=false; }
  });
}
function flushMinimap(){
  if(_mmDirty){ drawMinimap(); _mmDirty=false; }
}

function drawMap(){
  const cv=_mapCv||document.getElementById('map');
  const ctx=_mapCtx||cv.getContext('2d');
  const W=cv.width,H=cv.height;
  ctx.fillStyle='#080810';ctx.fillRect(0,0,W,H);
  updateZoomIndicator();
  updateRuler();
  if(!tiles.length) return;
  const cs=CELL*zoom;
  const wx0=Math.floor((0-panX)/(CELL*zoom))+minX-1;
  const wx1=Math.ceil((W-panX)/(CELL*zoom))+minX+1;
  const wy0=Math.floor(maxY-(H-panY)/(CELL*zoom))-1;
  const wy1=Math.ceil(maxY-(-panY)/(CELL*zoom))+1;
  const _hasRoute=!!routePathMap;
  for(const t of tiles){
    if(t.x<wx0||t.x>wx1||t.y<wy0||t.y>wy1) continue;
    const sx=(t.x-minX)*cs+panX,sy=(maxY-t.y)*cs+panY;
    let col;
    if(_hasRoute){
      const key=`${t.x},${t.y}`;
      if(routePathMap.has(key)){
        const type=routePathMap.get(key);
        col=type==='own'?'#7F77DD':type==='conquer'?'#E24B4A':type==='target'?'#1D9E75':t.color;
      }
      if(!col&&routePath) ctx.globalAlpha=0.35;
    }
    if(!col){
      if(highlightPid&&t.pid===highlightPid){col='#ffe066';}
      else if(t.isHQ){col=t.isMe?t.color:(getMark(t.pid)==='friend'?'#0a5f40':getMark(t.pid)==='enemy'?'#5f0a0a':'#6B1A1A');}
      else{
        const p=players[t.pidIdx];
        if(top10Mode&&!top10Pids.has(t.pid)){col='#2a2a2a';}
        else if(p&&p.inactive){col='#2a2a2a';}
        else{col=markColor(t.pid,t.color);}
      }
    }

    // 6. Zoom-dependent rendering: at very low zoom draw bounding-box fill per player
    // (handled below via aggregate pass — individual tiles still drawn here for correctness)
    ctx.fillStyle=col;ctx.fillRect(sx+0.5,sy+0.5,cs-1,cs-1);

    // Complementary border for visual distinction between nearby players
    if(zoom>1&&!t.isHQ&&t.bcolor){
      ctx.strokeStyle=t.bcolor;
      ctx.lineWidth=1.5;
      ctx.globalAlpha=0.45;
      ctx.strokeRect(sx+0.75,sy+0.75,cs-1.5,cs-1.5);
      ctx.globalAlpha=1;
    }

    // 1. HQ golden border
    if(t.isHQ){
      const bw = t.isMe ? Math.max(2, cs*0.18) : Math.max(1, cs*0.12);
      ctx.strokeStyle = t.isMe ? '#FAC775' : getMark(t.pid)==='friend' ? '#6fffa9' : getMark(t.pid)==='enemy' ? '#ff8483' : '#c8922a';
      ctx.lineWidth = bw;
      ctx.strokeRect(sx+bw/2, sy+bw/2, cs-bw, cs-bw);
    }
    // Garrison overlay — darken tile based on total defender count (max 10)
    const gc=(t.gH||0)+(t.gB||0)+(t.gE||0);
    if(gc>0){
      const alpha=0.15+(gc/10)*0.5;
      ctx.fillStyle=`rgba(0,0,0,${alpha})`;
      ctx.fillRect(sx+0.5,sy+0.5,cs-1,cs-1);
      if(zoom>11&&(t.gE||t.gB||t.gH)){
        // Show per-type breakdown: E in red, B in green, H in grey
        const fs=Math.round(cs*0.18);
        ctx.font=`bold ${fs}px monospace`;
        ctx.textAlign='center';ctx.textBaseline='middle';
        const lines=[];
        if(t.gE) lines.push({txt:`${t.gE}E`,col:'#ff8483'});
        if(t.gB) lines.push({txt:`${t.gB}B`,col:'#6fffa9'});
        if(t.gH) lines.push({txt:`${t.gH}H`,col:'#aaaaaa'});
        const lh=fs+2;
        const totalH=lines.length*lh;
        const startY=sy+cs/2-totalH/2+lh/2;
        lines.forEach((l,i)=>{
          ctx.fillStyle=l.col;
          ctx.fillText(l.txt,sx+cs/2,startY+i*lh);
        });
      } else if(zoom>2){
        // Just show total count
        ctx.fillStyle='rgba(255,255,255,0.9)';
        ctx.font=`bold ${Math.round(cs*0.35)}px monospace`;
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText(gc,sx+cs/2,sy+cs/2);
      }
    }
    ctx.globalAlpha=1;
    if(t.isHQ&&zoom>1.5){ctx.fillStyle='rgba(255,255,255,0.6)';ctx.font=`${Math.round(cs*0.6)}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('\u2302',sx+cs/2,sy+cs/2);}
  }

  // 7. Player name labels on main map at mid-zoom (2–10×), min 8 tiles
  if(zoom>=2&&zoom<=10){
    const nameFs=Math.max(9,Math.min(14,cs*0.55));
    ctx.font=`bold ${nameFs}px "Martian Mono",monospace`;
    ctx.textAlign='center';ctx.textBaseline='middle';
    // Cache label data: recompute only when viewport changes significantly
    const _lsig=`${wx0>>1}|${wx1>>1}|${wy0>>1}|${wy1>>1}|${cs.toFixed(0)}`;
    if(_lsig!==drawMap._labelSig){
      drawMap._labelSig=_lsig;
      const pidGroups=new Map();
      for(const t of tiles){
        if(t.x<wx0||t.x>wx1||t.y<wy0||t.y>wy1) continue;
        if(!pidGroups.has(t.pid)) pidGroups.set(t.pid,{wx:0,wy:0,n:0,col:t.color,me:t.isMe});
        const g=pidGroups.get(t.pid);
        g.wx+=t.x; g.wy+=t.y; g.n++;
      }
      drawMap._labels=[];
      for(const [pid,g] of pidGroups){
        if(g.n<8) continue;
        const p=players[players._pidIdx?players._pidIdx.get(pid):players.findIndex(pl=>pl.pid===pid)];
        if(!p||!p.name) continue;
        if(top10Mode&&!top10Pids.has(pid)) continue;
        const lbl=p.name.length>16?p.name.slice(0,15)+'…':p.name;
        drawMap._labels.push({wx:g.wx/g.n,wy:g.wy/g.n,lbl,me:g.me});
      }
    }
    for(const lb of drawMap._labels||[]){
      const cx=(lb.wx-minX)*cs+panX+cs/2, cy=(maxY-lb.wy)*cs+panY+cs/2;
      if(cx<0||cx>W||cy<0||cy>H) continue;
      const tw=ctx.measureText(lb.lbl).width;
      const pad=3;
      ctx.fillStyle='rgba(0,0,0,0.55)';
      ctx.fillRect(cx-tw/2-pad,cy-nameFs/2-pad,tw+pad*2,nameFs+pad*2);
      ctx.fillStyle=lb.me?'#FAC775':'rgba(255,255,255,0.85)';
      ctx.fillText(lb.lbl,cx,cy);
    }
  }
  // Grid drawn after tiles — visible on black background, zoom > 0.5
  if(zoom>0.5){
    const gridAlpha=Math.min(0.9, (zoom-0.5)*0.6);
    ctx.strokeStyle=`rgba(100,100,120,${gridAlpha})`;ctx.lineWidth=0.5;
    ctx.beginPath();
    for(let x=Math.max(minX,wx0);x<=Math.min(maxX+1,wx1);x++){const sx=(x-minX)*cs+panX;ctx.moveTo(sx,0);ctx.lineTo(sx,H);}
    for(let y=Math.max(minY,wy0);y<=Math.min(maxY+1,wy1);y++){const sy=(maxY-y)*cs+panY;ctx.moveTo(0,sy);ctx.lineTo(W,sy);}
    ctx.stroke();
  }
  if(routePath&&cs>=2){
    for(const s of routePath){
      if(s.x<wx0||s.x>wx1||s.y<wy0||s.y>wy1) continue;
      if(tileMap.has(`${s.x},${s.y}`)) continue;
      const sx=(s.x-minX)*cs+panX,sy=(maxY-s.y)*cs+panY;
      ctx.fillStyle=s.type==='target'?'#1D9E75':'rgba(200,200,255,0.4)';
      ctx.fillRect(sx+0.5,sy+0.5,cs-1,cs-1);
    }
  }
  if(routePath&&cs>=4){
    const start=routePath[0],end=routePath[routePath.length-1];
    for(const [s,col] of [[start,'#1D9E75'],[end,'#E24B4A']]){
      if(!s||s.x<wx0||s.x>wx1||s.y<wy0||s.y>wy1) continue;
      const sx=(s.x-minX)*cs+panX,sy=(maxY-s.y)*cs+panY;
      ctx.strokeStyle=col;ctx.lineWidth=2;ctx.strokeRect(sx+1,sy+1,cs-2,cs-2);
    }
  }

  // Battle history overlay (24h)
  if(battleHistoryActive&&battleHistoryData){
    for(const ch of battleHistoryData.changedTiles){
      if(ch.x<wx0||ch.x>wx1||ch.y<wy0||ch.y>wy1) continue;
      const sx=(ch.x-minX)*cs+panX,sy=(maxY-ch.y)*cs+panY;
      const col=(ch.toPid&&MY_IDS.has(ch.toPid))?'rgba(111,255,169,0.85)':
                (ch.fromPid&&MY_IDS.has(ch.fromPid))?'rgba(255,132,131,0.85)':
                ch.toPid?'rgba(111,255,169,0.5)':'rgba(255,132,131,0.5)';
      ctx.fillStyle=col;ctx.fillRect(sx+0.5,sy+0.5,cs-1,cs-1);
    }
  }

  // Ghost turf overlay
  drawGhostTiles(ctx);
}

function drawMinimap(){
  const mc=_mmCv||document.getElementById('minimap-canvas');
  const ctx=mc.getContext('2d');
  const MW=mc.width,MH=mc.height;
  ctx.fillStyle='#0a0a14';ctx.fillRect(0,0,MW,MH);
  if(!tiles.length) return;
  const spanX=maxX-minX+1,spanY=maxY-minY+1;
  const sc=Math.min(MW/spanX,MH/spanY);
  const offX=(MW-spanX*sc)/2,offY=(MH-spanY*sc)/2;
  const _mmHasRoute=!!routePathMap;
  for(const t of tiles){
    let col;
    if(t.isHQ) col=t.isMe?'#FAC775':'#c8922a';
    else col=t.color;
    if(_mmHasRoute){
      const key=`${t.x},${t.y}`;
      if(routePathMap.has(key)){
        const type=routePathMap.get(key);
        col=type==='own'?'#9d8fff':type==='conquer'?'#E24B4A':'#1D9E75';
      }
    }
    ctx.fillStyle=col;
    ctx.fillRect(offX+(t.x-minX)*sc,offY+(maxY-t.y)*sc,Math.max(1,sc-0.2),Math.max(1,sc-0.2));
  }
  const cv=document.getElementById('map');
  ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=1;
  ctx.strokeRect(offX+(-panX/(CELL*zoom))*sc,offY+(-panY/(CELL*zoom))*sc,(cv.width/(CELL*zoom))*sc,(cv.height/(CELL*zoom))*sc);
}
