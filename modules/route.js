// ── MODULE: route.js ── Vendetta World Map v4.16 ──────────────────────────

// ── NAV GLOBALS ───────────────────────────────────────────────────────────────
var navMode = false;
var navA = null; // {x, y, name}
var navB = null; // {x, y, name}

// ── SHORTEST ROUTE ────────────────────────────────────────────────────────────
// Every tile is passable and every step costs the same, so the shortest route
// between two territories is fully determined: the Chebyshev distance between
// their nearest pair of turfs, walked in a straight line. No search needed.
//
// This was an A* until v4.20. It returned the right LENGTH but the wrong path
// twice over. With 8-way movement, movement in the axis that has slack is free,
// so among the thousands of equally short paths the heap picked an arbitrary one
// and routes zig-zagged. Worse, it anchored the start on the A-tile nearest the
// CENTRE of B's bounding box — for a sprawling empire that centre sits in empty
// space, so Wu-Tang → Sir Caprice started 30 tiles off and came out at 64 steps
// where 34 suffice.

function findRoute(pidA,pidB){
  const tilesA=tiles.filter(t=>t.pid===pidA);
  const tilesB=tiles.filter(t=>t.pid===pidB);
  if(!tilesA.length||!tilesB.length) return null;

  // Nearest pair. Comparing every A-tile with every B-tile is 3M operations for
  // two large empires, so B is bucketed into coarse cells first: an A-tile only
  // descends into a cell whose tightest bounding box could still beat the best
  // pair found so far. Turns |A|×|B| into roughly |A|×|cells|.
  const CELL=16,cells=new Map();
  for(const t of tilesB){
    const k=`${Math.floor(t.x/CELL)},${Math.floor(t.y/CELL)}`;
    let c=cells.get(k);
    if(!c){c={x0:Infinity,x1:-Infinity,y0:Infinity,y1:-Infinity,list:[]};cells.set(k,c);}
    c.list.push(t);
    if(t.x<c.x0)c.x0=t.x;if(t.x>c.x1)c.x1=t.x;if(t.y<c.y0)c.y0=t.y;if(t.y>c.y1)c.y1=t.y;
  }
  const cellList=[...cells.values()];
  let best=Infinity,from=null,to=null;
  for(const a of tilesA){
    for(const c of cellList){
      const lower=Math.max(Math.max(0,c.x0-a.x,a.x-c.x1),Math.max(0,c.y0-a.y,a.y-c.y1));
      if(lower>=best) continue;
      for(const b of c.list){
        const d=Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));
        if(d<best){best=d;from=a;to=b;}
      }
    }
  }
  if(!from) return null;

  // Straight line from `from` to `to`. With D the Chebyshev distance the major
  // axis advances by exactly 1 per step and the minor axis by 0 or 1, so every
  // step is a legal 8-way move and the path is both minimal and dead straight.
  const targetSet=new Set(tilesB.map(t=>`${t.x},${t.y}`));
  const dx=to.x-from.x,dy=to.y-from.y,D=best;
  const path=[];
  for(let i=0;i<=D;i++){
    const x=D?from.x+Math.round(dx*i/D):from.x;
    const y=D?from.y+Math.round(dy*i/D):from.y;
    const key=`${x},${y}`;
    const tidx=tileMap.get(key);
    let type='empty';
    if(targetSet.has(key)) type='target';
    else if(tidx!==undefined) type=tiles[tidx].pid===pidA?'own':'conquer';
    path.push({x,y,type});
  }
  return path;
}

// ── ROUTE MODE ────────────────────────────────────────────────────────────────
function toggleRouteMode(){
  routeMode=!routeMode;
  const btn=document.getElementById('route-btn'); // legacy ref — may be null
  const navBtn=document.getElementById('nav-btn');
  const ind=document.getElementById('route-indicator');
  const mw=document.getElementById('map-wrap');
  const pl=document.getElementById('player-list');
  if(routeMode){
    if(navMode){navMode=false;navA=null;navB=null;}
    if(btn) btn.classList.add('active');
    if(navBtn) navBtn.classList.add('active');
    ind.style.display='';mw.classList.add('route-mode');pl.classList.add('route-mode-active');
    updateRouteIndicator();
  } else {
    if(btn) btn.classList.remove('active');
    if(navBtn) navBtn.classList.remove('active');
    ind.style.display='none';mw.classList.remove('route-mode');pl.classList.remove('route-mode-active');
    clearRoute();
  }
}

function updateRouteIndicator(){
  const ind=document.getElementById('route-indicator');
  if(!routeMode){ind.style.display='none';return;}
  if(!routePidA) ind.textContent='Click turf or player → select A (start)';
  else if(!routePidB) ind.textContent='Select B (destination) — A selected';
  else ind.textContent='Route shown below';
}

function selectRoutePlayer(pid){
  if(!routeMode) return;
  if(!routePidA||routePidA===pid){routePidA=pid;routePidB=null;routePath=null;}
  else{routePidB=pid;computeAndShowRoute();}
  updateRouteIndicator();renderPlayerList();drawMap();
}

function computeAndShowRoute(){
  if(!routePidA||!routePidB) return;
  setTimeout(()=>{
    routePath=findRoute(routePidA,routePidB);
    routePathMap=routePath?new Map(routePath.map(s=>[`${s.x},${s.y}`,s.type])):null;
    showRoutePanel();drawMap();
    if(routePath) zoomToRoute();
  },50);
}

function showRoutePanel(){
  document.getElementById('route-panel').style.display='block';
  const pA=players.find(p=>p.pid===routePidA)||{};
  const pB=players.find(p=>p.pid===routePidB)||{};
  document.getElementById('rp-name-a').textContent=pA.name||'[unknown]';
  document.getElementById('rp-name-b').textContent=pB.name||'[unknown]';
  document.getElementById('rp-dot-a').style.background=pA.color||'#1D9E75';
  document.getElementById('rp-dot-b').style.background=pB.color||'#E24B4A';
  const noPath=document.getElementById('route-no-path');
  const stats=document.getElementById('route-stats');
  if(!routePath){noPath.style.display='block';stats.style.display='none';return;}
  noPath.style.display='none';stats.style.display='block';
  document.getElementById('rs-total').textContent=routePath.length;
  document.getElementById('rs-own').textContent=routePath.filter(s=>s.type==='own').length;
  document.getElementById('rs-empty').textContent=routePath.filter(s=>s.type==='empty').length;
  document.getElementById('rs-conquer').textContent=routePath.filter(s=>s.type==='conquer').length;
}

function clearRoute(){
  routePidA=null;routePidB=null;routePath=null;routePathMap=null;
  document.getElementById('route-panel').style.display='none';
  document.getElementById('route-stats').style.display='none';
  document.getElementById('route-no-path').style.display='none';
  document.getElementById('rp-name-a').textContent='—';
  document.getElementById('rp-name-b').textContent='—';
  updateRouteIndicator();renderPlayerList();drawMap();
}

function zoomToRoute(){
  if(!routePath||!routePath.length) return;
  let rx0=Infinity,rx1=-Infinity,ry0=Infinity,ry1=-Infinity;
  for(const s of routePath){if(s.x<rx0)rx0=s.x;if(s.x>rx1)rx1=s.x;if(s.y<ry0)ry0=s.y;if(s.y>ry1)ry1=s.y;}
  const cv=document.getElementById('map');
  zoom=Math.max(0.5,Math.min(20,Math.min(cv.width/((rx1-rx0+10)*CELL),cv.height/((ry1-ry0+10)*CELL))));
  panX=cv.width/2-((rx0+rx1)/2-minX)*CELL*zoom;
  panY=cv.height/2-(maxY-(ry0+ry1)/2)*CELL*zoom;
  drawMap();drawMinimap();
}

// ── NAV FEATURE ───────────────────────────────────────────────────────────────
function openNavMode(){
  if(navMode){resetNav();return;}
  if(routeMode) toggleRouteMode();
  navMode=true;
  if(typeof closeNavMenu==='function') closeNavMenu();
  const ind=document.getElementById('route-indicator');
  const mw=document.getElementById('map-wrap');
  ind.style.display='inline-block';
  ind.textContent='Navigate: click origin turf';
  mw.classList.add('route-mode');
  const btn=document.getElementById('nav-btn');
  if(btn) btn.classList.add('active');
}

function resetNav(){
  navMode=false;navA=null;navB=null;
  const btn=document.getElementById('nav-btn');
  if(btn) btn.classList.remove('active');
  if(!routeMode){
    const ind=document.getElementById('route-indicator');
    const mw=document.getElementById('map-wrap');
    if(ind) ind.style.display='none';
    if(mw) mw.classList.remove('route-mode');
  }
  drawMap();
}

function selectNavTile(tile){
  const p=players[tile.pidIdx]||{};
  const name=p.name||'[unknown]';
  const ind=document.getElementById('route-indicator');
  if(!navA){
    navA={x:tile.x,y:tile.y,name:name};
    ind.textContent='Navigate: '+name+' ('+tile.x+', '+tile.y+') → click destination turf';
    drawMap();
  } else {
    navB={x:tile.x,y:tile.y,name:name};
    if(typeof openNavModal==='function') openNavModal();
    drawMap();
  }
}

function buildNavText(){
  if(!navA||!navB) return null;
  var dx=navB.x-navA.x, dy=navB.y-navA.y;
  var absDx=Math.abs(dx), absDy=Math.abs(dy);
  var dist=Math.sqrt(dx*dx+dy*dy);
  // Distance line
  var parts=[];
  if(absDx>0) parts.push(absDx+' tiles '+(dx>0?'east':'west'));
  if(absDy>0) parts.push(absDy+' tiles '+(dy>0?'north':'south'));
  var distLine=parts.length?parts.join(' · '):'0 tiles (same position)';
  // 16-point compass via bearing from north
  var compassNames=[
    ['N','North'],['NNE','North-northeast'],['NE','Northeast'],['ENE','East-northeast'],
    ['E','East'],['ESE','East-southeast'],['SE','Southeast'],['SSE','South-southeast'],
    ['S','South'],['SSW','South-southwest'],['SW','Southwest'],['WSW','West-southwest'],
    ['W','West'],['WNW','West-northwest'],['NW','Northwest'],['NNW','North-northwest']
  ];
  var shortDir='—',longDir='—';
  if(dx!==0||dy!==0){
    // dy positive = north in game; compass bearing = (90 - atan2_deg + 360) % 360
    var bearingDeg=(90-Math.atan2(dy,dx)*180/Math.PI+360)%360;
    var ci=Math.round(bearingDeg/22.5)%16;
    shortDir=compassNames[ci][0];longDir=compassNames[ci][1];
  }
  // In-game scroll description
  var threshold=dist*0.10;
  var vertDir=dy<0?'downward':'upward';
  var horizDir=dx<0?'to the left':'to the right';
  var inGame;
  if(dx===0&&dy===0){
    inGame='same position';
  } else if(absDy<threshold){
    inGame='scroll straight '+(dx>0?'to the right':'to the left');
  } else if(absDx<threshold){
    inGame='scroll straight '+vertDir;
  } else if(absDx/absDy>=0.75&&absDx/absDy<=1.33){
    inGame='scroll diagonally '+(dy<0?'down':'up')+'-'+(dx<0?'left':'right');
  } else if(absDy>absDx){
    inGame='scroll predominantly '+vertDir+', slightly '+horizDir;
  } else {
    inGame='scroll predominantly '+horizDir+', slightly '+(dy<0?'downward':'upward');
  }
  return {distLine:distLine,longDir:longDir,shortDir:shortDir,inGame:inGame};
}
