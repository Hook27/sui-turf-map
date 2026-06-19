// ── MODULE: realtime.js ── Vendetta World Map v4.12 ──────────────────────────

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
    ownerId: fields.owner_id || null,
    cachedAt: now,
    live: true
  };
  _rtCache[turfId] = {data: result, ts: now};
  return result;
}

// ── LIVE TURF BY COORDINATE ─────────────────────────────────────────────────
// Resolve an arbitrary map coordinate to its live on-chain turf status. Powers
// the right-click "has this free turf been captured yet?" feature on the map.
var RT_TURF_SYSTEM = '0x372e8fd0e12d2051860553b9e61065729dcddec11970b295bbcf19d7261cc502';
var RT_COORD_TYPE  = '0xa0c4bb412c1d6121c1b6a40954ef76c3b1f75248211209e94726496f46a59ce0::iturf::Coordinates';
var RT_NULL_ID     = '0x' + '0'.repeat(64);
var _rtTurfTableId = null; // coordinates_turfs Table id (resolved once)

async function rtSuiRpc(method, params) {
  var resp = await fetch('https://fullnode.mainnet.sui.io', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: method, params: params})
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

// Resolve & cache the coordinates_turfs Table id from the fixed TurfSystem object.
async function rtGetTurfTableId() {
  if (_rtTurfTableId) return _rtTurfTableId;
  var d = await rtSuiRpc('sui_getObject', [RT_TURF_SYSTEM, {showContent: true}]);
  var ct = d && d.result && d.result.data && d.result.data.content &&
           d.result.data.content.fields && d.result.data.content.fields.coordinates_turfs;
  var id = ct && ct.fields && ct.fields.id && ct.fields.id.id;
  if (!id) throw new Error('rtGetTurfTableId: unexpected response shape');
  _rtTurfTableId = id;
  return id;
}

// Look up the live status of the turf at map coordinate (x, y).
// Returns one of:
//   {status: 'free'}                                — no turf object, or unowned
//   {status: 'claimed', pid, gH, gB, gE, oid}       — currently owned
async function lookupTurfByCoord(x, y) {
  var table = await rtGetTurfTableId();
  var key = {
    type: RT_COORD_TYPE,
    value: {
      x: String(Math.abs(x)), x_neg: x < 0,
      y: String(Math.abs(y)), y_neg: y < 0
    }
  };
  var d = await rtSuiRpc('suix_getDynamicFieldObject', [table, key]);
  // "Not found" can arrive top-level or nested under result.error.
  var err = d.error || (d.result && d.result.error);
  if (err && err.code === 'dynamicFieldNotFound') return {status: 'free'};
  if (err) throw new Error(err.message || 'lookup RPC error');

  var turfId = d.result && d.result.data && d.result.data.content &&
               d.result.data.content.fields && d.result.data.content.fields.value;
  if (!turfId) throw new Error('lookupTurfByCoord: unexpected response shape');

  var info = await fetchTurfLive(turfId); // reuse cached garrison/owner fetch
  if (!info.ownerId || info.ownerId === RT_NULL_ID) return {status: 'free'};
  return {status: 'claimed', pid: info.ownerId, gH: info.hm, gB: info.bc, gE: info.ef, oid: turfId};
}

// ── FETCH PLAYER RESOURCES LIVE ──────────────────────────────────────────────
// Fetches live cash and weapons balances from the player profile's dynamic fields.
// Returns: {cash: number, weapons: number, cachedAt: number}
// Uses BigInt to safely divide u128 values by 2^64.
var _rtResCache = {};

async function fetchPlayerResources(profileId) {
  if (!profileId) throw new Error('fetchPlayerResources: no profileId');
  var now = Date.now();
  var key = profileId + '_res';
  if (_rtResCache[key] && (now - _rtResCache[key].ts) < RT_CACHE_TTL) {
    return _rtResCache[key].data;
  }
  var SCALE = BigInt('18446744073709551616'); // 2^64

  async function fetchField(fieldValue) {
    var resp = await fetch('https://fullnode.mainnet.sui.io', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'suix_getDynamicFieldObject',
        params: [profileId, {type: '0x1::string::String', value: fieldValue}]
      })
    });
    if (!resp.ok) return 0;
    var d = await resp.json();
    if (d.error || !d.result) return 0;
    var fields = d.result.data && d.result.data.content && d.result.data.content.fields;
    if (!fields) return 0;
    var inner = fields.value;
    var amountStr = inner && inner.fields && inner.fields.amount;
    if (!amountStr) return 0;
    try {
      var raw = BigInt(amountStr);
      // Multiply by 100 before dividing to preserve 2 decimal places
      return Number(raw * 100n / SCALE) / 100;
    } catch(e) { return 0; }
  }

  var cash = 0, weapons = 0;
  try { cash    = await fetchField('cash');   } catch(e) {}
  try { weapons = await fetchField('weapon'); } catch(e) {}

  var result = {cash: cash, weapons: weapons, cachedAt: now};
  _rtResCache[key] = {data: result, ts: now};
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
