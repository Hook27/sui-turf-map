// ── MODULE: ui-helpers.js ── Vendetta World Map v4.13 ──────────────────────────

// ── COORDINATE RULER ─────────────────────────────────────────────────────────
function updateRuler(){
  if(!tiles.length) return;
  const cv=_mapCv||document.getElementById('map');
  const W=cv.width, H=cv.height;
  const cs=CELL*zoom;

  // Skip if view hasn't changed (innerHTML assignment forces layout)
  const _sig=`${W}|${H}|${cs.toFixed(1)}|${panX|0}|${panY|0}`;
  if(_sig===updateRuler._last) return;
  updateRuler._last=_sig;

  // Decide tick spacing based on zoom
  const minPx=40; // minimum pixels between ticks
  const candidates=[1,2,5,10,20,50,100,200];
  let step=candidates.find(s=>s*cs>=minPx)||200;

  // X ruler
  const rx=document.getElementById('ruler-x');
  const wx0=Math.ceil((0-panX)/cs+minX);
  const wx1=Math.floor((W-panX)/cs+minX);
  const xStart=Math.ceil((Math.floor((0-panX)/cs)+minX)/step)*step;
  let xHtml='';
  for(let wx=xStart;wx<=(Math.floor((W-panX)/cs)+minX);wx+=step){
    const sx=(wx-minX)*cs+panX;
    if(sx<0||sx>W) continue;
    xHtml+=`<span class="ruler-tick" style="left:${sx}px">${wx}</span>`;
  }
  rx.innerHTML=xHtml;

  // Y ruler
  const ry=document.getElementById('ruler-y');
  const yStart=Math.ceil((Math.floor(maxY-(H-panY)/cs))/step)*step;
  const yEnd=Math.floor(maxY-(-panY)/cs);
  let yHtml='';
  for(let wy=yStart;wy<=yEnd;wy+=step){
    const sy=(maxY-wy)*cs+panY;
    if(sy<0||sy>H) continue;
    yHtml+=`<span class="ruler-tick" style="top:${sy}px">${wy}</span>`;
  }
  ry.innerHTML=yHtml;
}
function _openToolbarDD(btnId, ddId){
  // Close all other dropdowns first
  const pairs = {['intel-dropdown']:'intel-btn', ['more-dropdown']:'more-btn', ['nav-dropdown']:'nav-btn'};
  ['intel-dropdown','more-dropdown','nav-dropdown'].forEach(id=>{
    if(id!==ddId){
      document.getElementById(id).classList.remove('open');
      document.getElementById(pairs[id])?.setAttribute('aria-expanded','false');
    }
  });
  const btn = document.getElementById(btnId);
  const dd  = document.getElementById(ddId);
  if(dd.classList.contains('open')){
    dd.classList.remove('open');
    btn.setAttribute('aria-expanded','false');
    return;
  }
  const r = btn.getBoundingClientRect();
  dd.style.top  = (r.bottom + 2) + 'px';
  // On mobile: align right edge of dropdown to right edge of button
  if(window.innerWidth <= 768){
    dd.style.left  = '';
    dd.style.right = (window.innerWidth - r.right) + 'px';
  } else {
    dd.style.right = '';
    dd.style.left  = r.left + 'px';
  }
  dd.classList.add('open');
  btn.setAttribute('aria-expanded','true');
}
function toggleIntelMenu(){ _openToolbarDD('intel-btn','intel-dropdown'); }
function closeIntelMenu(){
  document.getElementById('intel-dropdown').classList.remove('open');
  document.getElementById('intel-btn')?.setAttribute('aria-expanded','false');
}
function toggleMoreMenu(){ _openToolbarDD('more-btn','more-dropdown'); }
function closeMoreMenu(){
  document.getElementById('more-dropdown').classList.remove('open');
  document.getElementById('more-btn')?.setAttribute('aria-expanded','false');
}
function toggleNavMenu(){ _openToolbarDD('nav-btn','nav-dropdown'); }
function closeNavMenu(){
  document.getElementById('nav-dropdown').classList.remove('open');
  document.getElementById('nav-btn')?.setAttribute('aria-expanded','false');
}

// ── NAV MODAL ────────────────────────────────────────────────────────────────
function openNavModal(){
  var res=buildNavText();
  if(!res) return;
  var body=document.getElementById('nav-body');
  var nameA=esc(navA.name), nameB=esc(navB.name);
  body.innerHTML=
    '<div class="nav-route-line"><strong>'+nameA+'</strong> ('+navA.x+', '+navA.y+
    ') &rarr; <strong>'+nameB+'</strong> ('+navB.x+', '+navB.y+')</div>'+
    '<div class="nav-data-row"><span class="nav-data-label">Distance</span>'+
    '<span class="nav-data-val">'+res.distLine+'</span></div>'+
    '<div class="nav-data-row" style="border-bottom:none"><span class="nav-data-label">Direction</span>'+
    '<span class="nav-data-val">'+res.longDir+' ('+res.shortDir+')</span></div>'+
    '<div class="nav-ingame"><strong>In-game:</strong> '+res.inGame+'.</div>';
  document.getElementById('nav-modal').classList.add('open');
}
function closeNavModal(){
  document.getElementById('nav-modal').classList.remove('open');
  // Keep nav state: arrow stays on canvas until explicitly cleared.
  // Update indicator to show the active route with an inline clear button.
  if(navA && navB){
    var ind=document.getElementById('route-indicator');
    if(ind){
      ind.innerHTML=
        'Navigate: <b style="color:#ddd">'+esc(navA.name)+'</b> &rarr; <b style="color:#ddd">'+esc(navB.name)+'</b>' +
        '&ensp;<button onclick="resetNav()" style="padding:0 5px;font-size:9px;background:transparent;border:1px solid #666;color:#888;box-shadow:none;vertical-align:middle;line-height:1.4;cursor:pointer" aria-label="Clear navigation">✕ clear</button>';
    }
  }
}

// ── COMPACT MODE ──────────────────────────────────────────────────────────────
function toggleCompact(btn){
  compactMode=!compactMode;
  document.getElementById('player-list').classList.toggle('compact',compactMode);
  document.getElementById('right-panel').classList.toggle('compact',compactMode);
  btn.classList.toggle('on',compactMode);
  btn.dataset.tip=compactMode?'Normal view':'Compact view';
  // Shorten filter labels in compact mode to save space
  const fBtn=document.querySelector('.fb[onclick*="friends"]');
  const eBtn=document.querySelector('.fb[onclick*="enemies"]');
  if(fBtn) fBtn.textContent = compactMode ? '♥' : '♥ Friends';
  if(eBtn) eBtn.textContent = compactMode ? '✕' : '✕ Enemies';
  // Resize canvas after transition completes
  setTimeout(()=>{ resizeCanvas(); drawMap(); drawMinimap(); }, 220);
}

// ── DAY / NIGHT THEME ────────────────────────────────────────────────────────
var _THEME_KEY = 'vwm_theme';

function _applyTheme(day){
  document.documentElement.classList.toggle('day', day);
  var btn = document.getElementById('theme-btn');
  if(btn) btn.textContent = day ? '🌙' : '☀️';
  // Defer canvas redraws so the CSS repaint can happen first
  requestAnimationFrame(function(){
    if(typeof drawMap     === 'function') drawMap();
    if(typeof drawMinimap === 'function') drawMinimap();
  });
}

function toggleTheme(){
  var next = !document.documentElement.classList.contains('day');
  localStorage.setItem(_THEME_KEY, next ? 'day' : 'night');
  _applyTheme(next);
}

function initTheme(){
  // Sync button icon with the class already applied by the inline FOUC script
  var day = document.documentElement.classList.contains('day');
  var btn = document.getElementById('theme-btn');
  if(btn) btn.textContent = day ? '🌙' : '☀️';
}

initTheme();

// ── TOP 10 MODE ───────────────────────────────────────────────────────────────
function toggleTop10(){
  top10Mode=!top10Mode;
  const btn=document.getElementById('top10-btn');
  btn.classList.toggle('top10-active',top10Mode);
  if(top10Mode){
    top10Pids=new Set(players.slice(0,10).map(p=>p.pid));
    MY_IDS.forEach(id=>top10Pids.add(id));
  }
  drawMap();
}

// ── FOCUS MANAGEMENT (WCAG 2.1) ──────────────────────────────────────────────
(function(){
  var _stack = []; // [{id, trigger}]

  function _focusable(el){
    return Array.prototype.slice.call(
      el.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')
    ).filter(function(e){ return e.offsetParent !== null; });
  }

  function _push(id){
    var trigger = document.activeElement;
    _stack.push({id:id, trigger:trigger});
    var modal = document.getElementById(id);
    if(!modal) return;
    setTimeout(function(){
      var first = _focusable(modal)[0];
      if(first) first.focus();
      else { modal.tabIndex = -1; modal.focus(); }
    }, 60);
  }

  function _pop(id){
    var idx = -1;
    for(var i=_stack.length-1;i>=0;i--){ if(_stack[i].id===id){ idx=i; break; } }
    if(idx<0) return;
    var trigger = _stack.splice(idx,1)[0].trigger;
    setTimeout(function(){
      if(trigger && document.contains(trigger)) trigger.focus();
    }, 30);
  }

  // MutationObserver: watch class and style changes on all [role="dialog"] elements
  var observer = new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      var el = m.target;
      if(el.getAttribute('role') !== 'dialog') return;
      var id = el.id;
      if(!id) return;
      var isOpen = el.classList.contains('open') ||
                   el.style.display === 'flex' ||
                   el.style.display === 'block';
      var wasOpen;
      if(m.attributeName === 'class'){
        wasOpen = (m.oldValue || '').indexOf('open') > -1;
      } else { // style
        var prev = m.oldValue || '';
        wasOpen = prev.indexOf('flex') > -1 || prev.indexOf('block') > -1;
      }
      if(isOpen && !wasOpen) _push(id);
      if(!isOpen && wasOpen) _pop(id);
    });
  });

  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('[role="dialog"]').forEach(function(el){
      observer.observe(el, {attributes:true, attributeOldValue:true, attributeFilter:['class','style']});
    });
  });

  // ESC: close topmost dialog or dropdowns
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Escape') return;
    if(_stack.length){
      var top = _stack[_stack.length-1];
      var modal = document.getElementById(top.id);
      if(!modal) return;
      // Click the first close button in the dialog
      var closeBtn = modal.querySelector('button[aria-label^="Close"]') ||
                     modal.querySelector('[id$="-close"]');
      if(closeBtn) closeBtn.click();
    } else {
      if(typeof closeIntelMenu === 'function') closeIntelMenu();
      if(typeof closeMoreMenu  === 'function') closeMoreMenu();
      if(typeof closeNavMenu   === 'function') closeNavMenu();
    }
  });

  // Tab: focus trap inside topmost dialog
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Tab' || !_stack.length) return;
    var top = _stack[_stack.length-1];
    var modal = document.getElementById(top.id);
    if(!modal) return;
    var focusable = _focusable(modal);
    if(focusable.length < 2) return;
    var first = focusable[0], last = focusable[focusable.length-1];
    if(e.shiftKey){
      if(document.activeElement === first){ last.focus(); e.preventDefault(); }
    } else {
      if(document.activeElement === last){ first.focus(); e.preventDefault(); }
    }
  });

  // Arrow keys: navigate between tabs in a tablist
  document.addEventListener('keydown', function(e){
    if(e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var focused = document.activeElement;
    if(!focused || focused.getAttribute('role') !== 'tab') return;
    var tablist = focused.closest('[role="tablist"]');
    if(!tablist) return;
    var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
    var idx = tabs.indexOf(focused);
    var next = e.key === 'ArrowRight'
      ? tabs[(idx + 1) % tabs.length]
      : tabs[(idx - 1 + tabs.length) % tabs.length];
    next.focus();
    next.click();
    e.preventDefault();
  });
})();
