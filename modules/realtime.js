// ── MODULE: realtime.js ── Vendetta World Map v4.12 ── (GraphQL transport) ───

// ── CACHE ─────────────────────────────────────────────────────────────────────
var _rtCache = {}; // key: objectId, value: {data, ts}
var RT_CACHE_TTL = 60000; // 60 seconds
// Sui JSON-RPC is gone from the full nodes (mid-October 2026); everything here goes
// through Mysten's public GraphQL endpoint (keyless, CORS *, no library needed).
// Object json is FLAT: a VecMap is {contents: [{key, value}]}, no {type, fields} wrappers.
var RT_GQL = 'https://graphql.mainnet.sui.io/graphql';

// POST one GraphQL query; returns `data`. Throws on HTTP errors and on `errors`
// (GraphQL reports failures inside a 200 response).
async function rtGql(query, variables) {
  var resp = await fetch(RT_GQL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query: query, variables: variables || {}})
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  var d = await resp.json();
  if (d.errors && d.errors.length) throw new Error(d.errors[0].message || 'GraphQL error');
  if (!d.data) throw new Error('GraphQL: no data');
  return d.data;
}

// ── BCS KEYS ──────────────────────────────────────────────────────────────────
// A dynamic field is looked up by the BCS bytes of its key (base64). Both key
// shapes used here are trivial to encode by hand.
function rtB64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// 0x1::string::String = ULEB128(length) + utf8 bytes
function rtBcsString(str) {
  var b = new TextEncoder().encode(str), len = [], n = b.length;
  do { var byte = n & 0x7f; n >>>= 7; len.push(byte | (n ? 0x80 : 0)); } while (n);
  var out = new Uint8Array(len.length + b.length);
  out.set(len, 0); out.set(b, len.length);
  return out;
}

// iturf::Coordinates { x: u64, x_neg: bool, y: u64, y_neg: bool } = 18 bytes
function rtBcsCoord(x, y) {
  x = Math.round(x); y = Math.round(y);
  var dv = new DataView(new ArrayBuffer(18));
  dv.setBigUint64(0, BigInt(Math.abs(x)), true);
  dv.setUint8(8, x < 0 ? 1 : 0);
  dv.setBigUint64(9, BigInt(Math.abs(y)), true);
  dv.setUint8(17, y < 0 ? 1 : 0);
  return new Uint8Array(dv.buffer);
}

// The json of one object, or null when it does not exist.
var RT_Q_OBJECT = 'query($a:SuiAddress!){object(address:$a){asMoveObject{contents{json}}}}';
async function rtObjectJson(address) {
  var d = await rtGql(RT_Q_OBJECT, {a: address});
  var c = d.object && d.object.asMoveObject && d.object.asMoveObject.contents;
  return (c && c.json) || null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Parse a VecMap contents array (garrison or gangster_types) to {hm, bc, ef}
function rtParsGarrison(contents) {
  var hm = 0, bc = 0, ef = 0;
  if (!contents) return {hm: hm, bc: bc, ef: ef};
  for (var i = 0; i < contents.length; i++) {
    var f = contents[i] || {};
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
  var fields;
  try { fields = await rtObjectJson(turfId); }
  catch (e) { throw new Error('fetchTurfLive: ' + e.message); }
  if (!fields) throw new Error('fetchTurfLive: unexpected response shape');

  var garContents = (fields.garrison && fields.garrison.contents) || [];
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
var RT_Q_FIELD = 'query($p:SuiAddress!,$n:DynamicFieldName!){address(address:$p){' +
                 'dynamicField(name:$n){value{... on MoveValue{json}}}}}';

// Resolve & cache the coordinates_turfs Table id from the fixed TurfSystem object.
async function rtGetTurfTableId() {
  if (_rtTurfTableId) return _rtTurfTableId;
  var f = await rtObjectJson(RT_TURF_SYSTEM);
  var id = f && f.coordinates_turfs && f.coordinates_turfs.id;
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
  var d = await rtGql(RT_Q_FIELD, {p: table, n: {type: RT_COORD_TYPE, bcs: rtB64(rtBcsCoord(x, y))}});
  // A coordinate that was never claimed has no table entry: dynamicField is null.
  var field = d.address && d.address.dynamicField;
  if (!field) return {status: 'free'};

  var turfId = field.value && field.value.json;
  if (!turfId || typeof turfId !== 'string') throw new Error('lookupTurfByCoord: unexpected response shape');

  var info = await fetchTurfLive(turfId); // reuse cached garrison/owner fetch
  if (!info.ownerId || info.ownerId === RT_NULL_ID) return {status: 'free'};
  return {status: 'claimed', pid: info.ownerId, gH: info.hm, gB: info.bc, gE: info.ef, oid: turfId};
}

// ── FETCH PLAYER RESOURCES LIVE ──────────────────────────────────────────────
// Fetches live cash and weapons balances from the player profile's dynamic fields.
// Returns: {cash: number, weapons: number, cachedAt: number}
// Uses BigInt to safely divide u128 values by 2^64.
var _rtResCache = {};
var RT_Q_RES = 'query($p:SuiAddress!,$c:DynamicFieldName!,$w:DynamicFieldName!){address(address:$p){' +
               'cash:dynamicField(name:$c){value{... on MoveValue{json}}} ' +
               'weapon:dynamicField(name:$w){value{... on MoveValue{json}}}}}';

async function fetchPlayerResources(profileId) {
  if (!profileId) throw new Error('fetchPlayerResources: no profileId');
  var now = Date.now();
  var key = profileId + '_res';
  if (_rtResCache[key] && (now - _rtResCache[key].ts) < RT_CACHE_TTL) {
    return _rtResCache[key].data;
  }
  var SCALE = BigInt('18446744073709551616'); // 2^64

  // Both balances in one query; a field that does not exist comes back null.
  function scaled(field) {
    var amountStr = field && field.value && field.value.json && field.value.json.amount;
    if (!amountStr) return 0;
    try {
      var raw = BigInt(amountStr);
      // Multiply by 100 before dividing to preserve 2 decimal places
      return Number(raw * 100n / SCALE) / 100;
    } catch(e) { return 0; }
  }

  var cash = 0, weapons = 0;
  try {
    var d = await rtGql(RT_Q_RES, {
      p: profileId,
      c: {type: '0x1::string::String', bcs: rtB64(rtBcsString('cash'))},
      w: {type: '0x1::string::String', bcs: rtB64(rtBcsString('weapon'))}
    });
    cash = scaled(d.address && d.address.cash);
    weapons = scaled(d.address && d.address.weapon);
  } catch(e) {}

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
  var fields;
  try { fields = await rtObjectJson(profileId); }
  catch (e) { throw new Error('fetchPlayerLive: ' + e.message); }
  if (!fields) throw new Error('fetchPlayerLive: unexpected response shape');

  // Gangsters
  var gf = fields.gangsters || {};
  var gtypes = (gf.gangster_types && gf.gangster_types.contents) || [];
  var gt = rtParsGarrison(gtypes);
  var gangsters = {
    hm: gt.hm, bc: gt.bc, ef: gt.ef,
    total: parseInt(gf.current_gangster_count, 10) || 0,
    recruits: parseInt(gf.recruit_count, 10) || 0,
    capacity: parseInt(gf.total_capacity, 10) || 0
  };

  // Timers
  var timers = {};
  var timerContents = (fields.timers && fields.timers.contents) || [];
  for (var i = 0; i < timerContents.length; i++) {
    var tf = timerContents[i] || {};
    if (tf.key) timers[tf.key] = parseInt(tf.value, 10) || 0;
  }

  // Perks
  var perks = {};
  var perkContents = (fields.perks && fields.perks.contents) || [];
  for (var j = 0; j < perkContents.length; j++) {
    var pf = perkContents[j] || {};
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
