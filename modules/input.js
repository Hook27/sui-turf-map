// ── MODULE: input.js ── Vendetta World Map v4.00 ──────────────────────────

// ── ZOOM & PAN (mouse + wheel) ────────────────────────────────────────────────
const mapWrap=document.getElementById('map-wrap');

mapWrap.addEventListener('wheel',e=>{
  e.preventDefault();
  const f=e.deltaY<0?1.15:0.87;
  const rect=mapWrap.getBoundingClientRect();
  const mx=e.clientX-rect.left,my=e.clientY-rect.top;
  panX=mx-(mx-panX)*f;panY=my-(my-panY)*f;
  zoom=Math.max(0.05,Math.min(80,zoom*f));
  requestDraw();
},{passive:false});

mapWrap.addEventListener('mousedown',e=>{
  dragging=false;dragStartX=e.clientX;dragStartY=e.clientY;dragPanX=panX;dragPanY=panY;
  mapWrap.classList.add('dragging');
});
mapWrap.addEventListener('mousemove',e=>{
  if(e.buttons===1){
    const moved=Math.abs(e.clientX-dragStartX)+Math.abs(e.clientY-dragStartY);
    if(moved>3){dragging=true;panX=dragPanX+(e.clientX-dragStartX);panY=dragPanY+(e.clientY-dragStartY);requestDraw();}
  }
  if(!dragging&&tiles.length){
    const rect=mapWrap.getBoundingClientRect();
    const {wx,wy}=screenToWorld(e.clientX-rect.left,e.clientY-rect.top);
    const idx=tileMap.get(`${wx},${wy}`);
    const tip=document.getElementById('tip');
    if(idx!==undefined&&!routeMode){
      const t=tiles[idx];const p=players[t.pidIdx]||{};
      tip.querySelector('.tname').textContent=p.name||'[unknown]';
      tip.querySelector('.tpos').textContent=`Position: (${wx}, ${wy})`;
      tip.querySelector('.thq').textContent=t.isHQ?'⌂ Headquarters':'';
      const gar=(t.gH||t.gB||t.gE)?`👥 ${t.gH}H · ${t.gB}B · ${t.gE}E`:'';
      tip.querySelector('.tgar').textContent=gar;
      // Ghost turf info
      const ghostInfo = ghostMode ? ghostTiles.find(g=>g.x===wx&&g.y===wy) : null;
      tip.querySelector('.tghost').textContent = ghostInfo
        ? `👻 Ghost #${ghostTiles.indexOf(ghostInfo)+1} · ${ghostInfo.dist} away · ${ghostInfo.garrison} defenders`
        : '';
      tip.style.display='block';
      const r2=mapWrap.getBoundingClientRect();
      tip.style.left=(e.clientX-r2.left+14)+'px';tip.style.top=(e.clientY-r2.top-8)+'px';
    } else {tip.style.display='none';}
  }
});
mapWrap.addEventListener('mouseup',e=>{
  mapWrap.classList.remove('dragging');
  if(e.button!==0){dragging=false;return;}  // ignore right/middle click
  if(!dragging){
    const rect=mapWrap.getBoundingClientRect();
    const {wx,wy}=screenToWorld(e.clientX-rect.left,e.clientY-rect.top);
    const idx=tileMap.get(`${wx},${wy}`);
    if(idx!==undefined){
      if(navMode) selectNavTile(tiles[idx]);
      else if(routeMode) selectRoutePlayer(tiles[idx].pid);
      else { _lastClickedTile=tiles[idx]; _pulseTile(tiles[idx]); selectPlayerNoPan(tiles[idx].pid); }
    }
  }
  dragging=false;
});
mapWrap.addEventListener('contextmenu',e=>{
  e.preventDefault();
  const rect=mapWrap.getBoundingClientRect();
  const {wx,wy}=screenToWorld(e.clientX-rect.left,e.clientY-rect.top);
  const idx=tileMap.get(`${wx},${wy}`);
  if(idx!==undefined) { _lastClickedTile=tiles[idx]; showNeighborPopup(tiles[idx].pid,e.clientX,e.clientY,tiles[idx]); }
});
mapWrap.addEventListener('mouseleave',()=>{document.getElementById('tip').style.display='none';});

// ── TOUCH EVENTS (identifier-based, Android-safe) ─────────────────────────────
//
// Core fix: track each finger by touch.identifier in a Map, never by
// array index. Android Chrome may shuffle e.touches[] order between
// events, which breaks midpoint / distance calculations when using [0]/[1].
//
const activePointers = new Map(); // identifier → {x, y}

let _panStart   = null; // {panX, panY, x, y}   – saved state at 1-finger start
let _pinchStart = null; // {midX, midY, dist, panX, panY, zoom} – saved at 2-finger start
let _touchMoved = false;
let _touchRect  = null; // cached getBoundingClientRect() for touch session
let _longTimer  = null;
let _tooltipTimer = null;

const TOUCH_TAP_PX  = 12;   // max movement for tap/longpress
const TOUCH_LONG_MS = 600;  // longpress threshold

function _isBtn(el){ return el && (el.tagName==='BUTTON' || el.closest('button')); }

function _syncPointer(touch, rect){
  activePointers.set(touch.identifier, {
    x: touch.clientX - rect.left,
    y: touch.clientY - rect.top
  });
}

function _pinchGeometry(){
  // Returns midpoint + distance from the two active pointers.
  // Uses Map insertion order — stable regardless of e.touches[] shuffle.
  const [a, b] = activePointers.values();
  return {
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    dist: Math.hypot(b.x - a.x, b.y - a.y) || 1
  };
}

mapWrap.addEventListener('touchstart', e => {
  if(_isBtn(e.target)) return;
  e.preventDefault();
  _touchActive=true;

  _touchRect = mapWrap.getBoundingClientRect();
  const rect = _touchRect;
  for(const t of e.changedTouches) _syncPointer(t, rect);

  clearTimeout(_longTimer);
  clearTimeout(_tooltipTimer);
  document.getElementById('touch-tooltip').style.display = 'none';

  if(activePointers.size === 1){
    // ── First finger: prepare pan / tap / longpress ──
    _touchMoved = false;
    _pinchStart = null;
    const [,p] = [...activePointers.entries()][0];
    _panStart = { panX, panY, x: p.x, y: p.y };

    // Capture the position now for the long-press closure
    const lpx = p.x, lpy = p.y;
    _longTimer = setTimeout(() => {
      if(!_touchMoved){
        const {wx, wy} = screenToWorld(lpx, lpy);
        const idx = tileMap.get(`${wx},${wy}`);
        if(idx !== undefined) { _lastClickedTile=tiles[idx]; showNeighborPopup(tiles[idx].pid, lpx + rect.left, lpy + rect.top, tiles[idx]); }
      }
    }, TOUCH_LONG_MS);

  } else if(activePointers.size === 2){
    // ── Second finger: switch to pinch ──
    clearTimeout(_longTimer);
    _touchMoved = true;   // suppress tap after a pinch
    _panStart   = null;
    const { midX, midY, dist } = _pinchGeometry();
    _pinchStart = { midX, midY, dist, panX, panY, zoom };
  }
}, { passive: false });

mapWrap.addEventListener('touchmove', e => {
  if(_isBtn(e.target)) return;
  e.preventDefault();

  const rect = _touchRect || mapWrap.getBoundingClientRect();
  for(const t of e.changedTouches) _syncPointer(t, rect);

  if(activePointers.size === 1 && _panStart){
    // ── 1-finger pan ──
    const [,p] = [...activePointers.entries()][0];
    const dx = p.x - _panStart.x;
    const dy = p.y - _panStart.y;
    if(!_touchMoved && Math.hypot(dx, dy) > TOUCH_TAP_PX){
      _touchMoved = true;
      clearTimeout(_longTimer);
    }
    if(_touchMoved){
      panX = _panStart.panX + dx;
      panY = _panStart.panY + dy;
      requestDraw();
    }

  } else if(activePointers.size === 2 && _pinchStart){
    // ── 2-finger pinch-zoom ──
    // Always compute geometry from the SAME two identifiers (Map order),
    // compare to the FROZEN start state → no drift, no jumping.
    const { midX, midY, dist } = _pinchGeometry();

    const scale   = dist / _pinchStart.dist;
    const newZoom = Math.max(0.05, Math.min(80, _pinchStart.zoom * scale));

    // Zoom formula identical to the working wheel handler,
    // anchored on the pinch-start midpoint.
    panX = _pinchStart.midX - (_pinchStart.midX - _pinchStart.panX) * (newZoom / _pinchStart.zoom);
    panY = _pinchStart.midY - (_pinchStart.midY - _pinchStart.panY) * (newZoom / _pinchStart.zoom);

    // Also translate by how much the midpoint itself moved.
    panX += midX - _pinchStart.midX;
    panY += midY - _pinchStart.midY;

    zoom = newZoom;
    requestDraw();
  }
}, { passive: false });

function _handleTouchEnd(e){
  if(_isBtn(e.target)) return;
  e.preventDefault();
  clearTimeout(_longTimer);

  const rect = _touchRect || mapWrap.getBoundingClientRect();
  for(const t of e.changedTouches) activePointers.delete(t.identifier);

  if(activePointers.size === 0){
    // ── All fingers lifted ──
    _touchActive=false;
    _touchRect=null;
    flushMinimap();
    if(!_touchMoved && _panStart){
      // It was a tap — show tooltip or select route
      const {wx, wy} = screenToWorld(_panStart.x, _panStart.y);
      const idx = tileMap.get(`${wx},${wy}`);
      if(idx !== undefined){
        const tile = tiles[idx];
        if(navMode){
          selectNavTile(tile);
        } else if(routeMode){
          selectRoutePlayer(tile.pid);
        } else {
          const p = players[tile.pidIdx] || {};
          const tt = document.getElementById('touch-tooltip');
          tt.querySelector('.tname').textContent = p.name || '[unknown]';
          tt.querySelector('.tpos').textContent  = `Position: (${wx}, ${wy})`;
          tt.querySelector('.thq').textContent   = tile.isHQ ? '⌂ Headquarters' : '';
          tt.querySelector('.tgar').textContent  = (tile.gH||tile.gB||tile.gE)?`👥 ${tile.gH}H · ${tile.gB}B · ${tile.gE}E`:'';
          const ghostInfo = ghostMode ? ghostTiles.find(g=>g.x===wx&&g.y===wy) : null;
          tt.querySelector('.tghost').textContent = ghostInfo
            ? `👻 Ghost #${ghostTiles.indexOf(ghostInfo)+1} · ${ghostInfo.dist} away · ${ghostInfo.garrison} defenders`
            : '';
          _lastClickedTile = tile;
          tt.style.display = 'block';
          clearTimeout(_tooltipTimer);
          _tooltipTimer = setTimeout(() => { tt.style.display = 'none'; }, 3000);
        }
      }
    }
    _panStart   = null;
    _pinchStart = null;
    _touchMoved = false;

  } else if(activePointers.size === 1){
    // ── One finger remains after pinch ──
    // Resume pan from wherever that finger currently is.
    _pinchStart = null;
    _touchMoved = true;  // no tap after a pinch
    const [,p] = [...activePointers.entries()][0];
    _panStart = { panX, panY, x: p.x, y: p.y };
  }
}

mapWrap.addEventListener('touchend',    _handleTouchEnd, { passive: false });
mapWrap.addEventListener('touchcancel', _handleTouchEnd, { passive: false });

// ── MAP-ONLY MODE (mobile) ─────────────────────────────────────────────────
function toggleMapOnly(){
  const btn = document.getElementById('maponly-btn');
  const active = document.body.classList.toggle('map-only');
  btn.classList.toggle('active', active);
  btn.title = active ? 'Exit map-only' : 'Map only';
  btn.textContent = active ? '✕' : '⛶';
  setTimeout(()=>{ resizeCanvas(); drawMap(); drawMinimap(); }, 50);
}

// ── SIDEBAR TOGGLE (mobile) ───────────────────────────────────────────────────
function toggleSidebar(){
  const sb=document.getElementById('right-panel');
  const btn=document.getElementById('sidebar-toggle');
  const isOpen=sb.classList.toggle('open');
  btn.classList.toggle('open',isOpen);
  btn.textContent=isOpen?'✕':'☰';
}

document.getElementById('minimap-canvas').addEventListener('click',e=>{
  if(!tiles.length) return;
  const mc=document.getElementById('minimap-canvas');
  const rect=mc.getBoundingClientRect();
  const spanX=maxX-minX+1,spanY=maxY-minY+1;
  const sc=Math.min(mc.width/spanX,mc.height/spanY);
  const offX=(mc.width-spanX*sc)/2,offY=(mc.height-spanY*sc)/2;
  const cv=document.getElementById('map');
  const cx=e.clientX-rect.left;
  const cy=e.clientY-rect.top;
  // Scale click to canvas pixels (canvas may be CSS-scaled)
  const scaleX=mc.width/rect.width;
  const scaleY=mc.height/rect.height;
  panX=cv.width/2-((cx*scaleX-offX)/sc)*CELL*zoom;
  panY=cv.height/2-((cy*scaleY-offY)/sc)*CELL*zoom;
  drawMap();drawMinimap();
});

function zoomBy(f){
  const cv=document.getElementById('map');
  panX=cv.width/2-(cv.width/2-panX)*f;panY=cv.height/2-(cv.height/2-panY)*f;
  zoom=Math.max(0.05,Math.min(80,zoom*f));drawMap();drawMinimap();
}
function resetView(){
  if(!tiles.length) return;
  const cv=document.getElementById('map');
  zoom=Math.max(0.2,Math.min(cv.width/((maxX-minX+1)*CELL),cv.height/((maxY-minY+1)*CELL))*0.9);
  panX=(cv.width-(maxX-minX+1)*CELL*zoom)/2;panY=(cv.height-(maxY-minY+1)*CELL*zoom)/2;
  drawMap();drawMinimap();
}
function jumpToPlayer(pid){
  if(!tiles.length) return;
  if(pid===selectedPid) return; // already viewing this player, do nothing
  const pt=tiles.filter(t=>t.pid===pid);if(!pt.length) return;
  let bx0=Infinity,bx1=-Infinity,by0=Infinity,by1=-Infinity;
  for(const t of pt){if(t.x<bx0)bx0=t.x;if(t.x>bx1)bx1=t.x;if(t.y<by0)by0=t.y;if(t.y>by1)by1=t.y;}
  const cv=document.getElementById('map');
  const fitZoom=Math.max(0.2,Math.min(20,Math.min(cv.width/((bx1-bx0+7)*CELL),cv.height/((by1-by0+7)*CELL))));
  zoom=Math.max(zoom,fitZoom);
  panX=cv.width/2-((bx0+bx1)/2-minX)*CELL*zoom;panY=cv.height/2-(maxY-(by0+by1)/2)*CELL*zoom;
  highlightPid=pid;
  selectedPid=pid;
  // Enable ghost + soft targets buttons and recompute if mode is active
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
function jumpToMe(){jumpToPlayer([...MY_IDS][0]);}

