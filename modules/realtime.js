// ── MODULE: realtime.js ── Vendetta World Map v4.06 ──────────────────────────

// ── CACHE ─────────────────────────────────────────────────────────────────────
var _rtCache = {}; // key: objectId, value: {data, ts}
var RT_CACHE_TTL = 60000; // 60 seconds

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Parse a VecMap contents array (garrison or gangster_types) to {hm, bc, ef}
function rtParsGarrison(contents) {
  var hm = 0, bc = 0, ef = 0;
  if (!contents) return {hm: hm, bc: bc, ef: ef};
  for (var i = 0; i < contents.length; i++) {
    var f = contents[i].fields || {};
    var v = parseInt(f.value, 10) || 0;
    if (f.key === 'henchman') hm = v;
    else if (f.key === 'bouncer') bc = v;
    else if (f.key === 'enforcer') ef = v;
  }
  return {hm: hm, bc: bc, ef: ef};
}

// Calculate remaining time from a Sui timestamp (ms since epoch)
// ts = 0 → {ms: 0, label: "—"}
function rtCooldownRemaining(tsMs) {
  if (!tsMs || tsMs === 0) return {ms: 0, label: '—'};
  var remaining = tsMs - Date.now();
  if (remaining <= 0) return {ms: 0, label: '—'};
  var totalMin = Math.floor(remaining / 60000);
  var h = Math.floor(totalMin / 60);
  var m = totalMin % 60;
  var label = h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
  return {ms: remaining, label: label};
}

// ── FETCH TURF LIVE ───────────────────────────────────────────────────────────
// Fetches live TurfInformation for a given turf object ID.
// Returns: {hm, bc, ef, total, cooldown, cachedAt, live: true}
async function fetchTurfLive(turfId) {
  if (!turfId) throw new Error('fetchTurfLive: no turfId');
  var now = Date.now();
  if (_rtCache[turfId] && (now - _rtCache[turfId].ts) < RT_CACHE_TTL) {
    return _rtCache[turfId].data;
  }
  var resp = await fetch('https://fullnode.mainnet.sui.io', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'sui_getObject',
      params: [turfId, {showType: true, showOwner: true, showContent: true}]
    })
  });
  if (!resp.ok) throw new Error('fetchTurfLive: HTTP ' + resp.status);
  var d = await resp.json();
  if (d.error) throw new Error('fetchTurfLive: ' + (d.error.message || 'RPC error'));
  var fields = d.result && d.result.data && d.result.data.content && d.result.data.content.fields;
  if (!fields) throw new Error('fetchTurfLive: unexpected response shape');

  var garContents = (fields.garrison && fields.garrison.fields && fields.garrison.fields.contents) || [];
  var g = rtParsGarrison(garContents);
  var cooldownRaw = parseInt(fields.cooldown, 10) || 0;

  var result = {
    hm: g.hm, bc: g.bc, ef: g.ef,
    total: g.hm + g.bc + g.ef,
    cooldown: cooldownRaw,
    cachedAt: now,
    live: true
  };
  _rtCache[turfId] = {data: result, ts: now};
  return result;
}

// ── FETCH PLAYER LIVE ─────────────────────────────────────────────────────────
// Fetches live Player object for a given profile object ID.
// Returns: {name, gangsters, timers, perks, turfCount, isInactive, dvdId, cachedAt, live: true}
async function fetchPlayerLive(profileId) {
  if (!profileId) throw new Error('fetchPlayerLive: no profileId');
  var now = Date.now();
  if (_rtCache[profileId] && (now - _rtCache[profileId].ts) < RT_CACHE_TTL) {
    return _rtCache[profileId].data;
  }
  var resp = await fetch('https://fullnode.mainnet.sui.io', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'sui_getObject',
      params: [profileId, {showType: true, showOwner: true, showContent: true}]
    })
  });
  if (!resp.ok) throw new Error('fetchPlayerLive: HTTP ' + resp.status);
  var d = await resp.json();
  if (d.error) throw new Error('fetchPlayerLive: ' + (d.error.message || 'RPC error'));
  var fields = d.result && d.result.data && d.result.data.content && d.result.data.content.fields;
  if (!fields) throw new Error('fetchPlayerLive: unexpected response shape');

  // Gangsters
  var gf = (fields.gangsters && fields.gangsters.fields) || {};
  var gtypes = (gf.gangster_types && gf.gangster_types.fields && gf.gangster_types.fields.contents) || [];
  var gt = rtParsGarrison(gtypes);
  var gangsters = {
    hm: gt.hm, bc: gt.bc, ef: gt.ef,
    total: parseInt(gf.current_gangster_count, 10) || 0,
    recruits: parseInt(gf.recruit_count, 10) || 0,
    capacity: parseInt(gf.total_capacity, 10) || 0
  };

  // Timers
  var timers = {};
  var timerContents = (fields.timers && fields.timers.fields && fields.timers.fields.contents) || [];
  for (var i = 0; i < timerContents.length; i++) {
    var tf = timerContents[i].fields || {};
    if (tf.key) timers[tf.key] = parseInt(tf.value, 10) || 0;
  }

  // Perks
  var perks = {};
  var perkContents = (fields.perks && fields.perks.fields && fields.perks.fields.contents) || [];
  for (var j = 0; j < perkContents.length; j++) {
    var pf = perkContents[j].fields || {};
    if (pf.key) perks[pf.key] = parseInt(pf.value, 10) || 0;
  }

  var result = {
    name: fields.player_name || '',
    gangsters: gangsters,
    timers: timers,
    perks: perks,
    turfCount: (fields.owned_location || []).length,
    isInactive: !!fields.is_inactive,
    dvdId: fields.dvd_id || null,
    cachedAt: now,
    live: true
  };
  _rtCache[profileId] = {data: result, ts: now};
  return result;
}
