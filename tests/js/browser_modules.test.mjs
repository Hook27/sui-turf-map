// Offline tests for the browser modules' GraphQL layer (modules/realtime.js, modules/analyzer.js),
// served by a fake `fetch` over tests/fixtures/world.json.   Run: node --test tests/js/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadModules, evalIn, REPO } from './load_modules.mjs';

const world = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'world.json'), 'utf8'));
const NULL_ID = '0x' + '0'.repeat(64);
const SCALE = 2n ** 64n;
const TURF_SYSTEM = '0x372e8fd0e12d2051860553b9e61065729dcddec11970b295bbcf19d7261cc502';
const SIM = '0x63081c5dd824a49289b6557d9f9bcf8613fe801e89dbad728616348a58b4b40a::ibattle::SimulationResultEvent';

// ── fake fetch ────────────────────────────────────────────────────────────────
const tableId = world.objects[TURF_SYSTEM].json.coordinates_turfs.id;
function decodeName(n) {
  const b = Buffer.from(n.bcs, 'base64');
  if (n.type.endsWith('::string::String')) return { str: b.subarray(1, 1 + b[0]).toString('utf8') };
  assert.equal(b.length, 18, 'Coordinates are 18 bytes of BCS');
  const x = Number(b.readBigUInt64LE(0)), y = Number(b.readBigUInt64LE(9));
  return { x: b[8] ? -x : x, y: b[17] ? -y : y };
}
const fieldJson = (id) => world.objects[id] ? world.objects[id].json : null;

function answer(query, v, log) {
  if (query.includes('cash:dynamicField')) {
    const ids = world.field_lookup[v.p] || {};
    assert.equal(decodeName(v.c).str, 'cash');
    assert.equal(decodeName(v.w).str, 'weapon');
    const one = (k) => (ids[k] && fieldJson(ids[k]) ? { value: { json: fieldJson(ids[k]).value } } : null);
    return { address: { cash: one('cash'), weapon: one('weapon') } };
  }
  if (query.includes('dynamicField(name:$n)')) {
    assert.equal(v.p, tableId, 'coordinate lookups go to the coordinates_turfs table');
    const want = decodeName(v.n);
    const hit = world.fields[tableId].find((e) => {
      const sx = e.name.x_neg ? -Number(e.name.x) : Number(e.name.x);
      const sy = e.name.y_neg ? -Number(e.name.y) : Number(e.name.y);
      return sx === want.x && sy === want.y;
    });
    return { address: { dynamicField: hit ? { value: { json: hit.value } } : null } };
  }
  if (query.includes('object(address:$a)')) {
    const o = world.objects[v.a];
    return { object: o ? { asMoveObject: { contents: { json: o.json } } } : null };
  }
  if (query.includes('transaction(digest:$d)')) {
    const evs = world.tx_events[v.d];
    return { transaction: evs ? { effects: { timestamp: '2026-10-22T19:40:35.235Z', events: { nodes:
      evs.map((e) => ({ contents: { type: { repr: e.type }, json: e.parsedJson } })) } } } : null };
  }
  if (query.includes('events(last:1')) {
    assert.equal(v.t, SIM);
    return { events: { nodes: v.s === '0xsender' ? [{ transaction: { digest: 'DIGEST1' } }] : [] } };
  }
  throw new Error('fake: unknown query ' + query.slice(0, 60));
}

function makeFetch(log = []) {
  return async (url, opts) => {
    assert.equal(url, 'https://graphql.mainnet.sui.io/graphql');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    log.push(body);
    try {
      return { ok: true, status: 200, json: async () => ({ data: answer(body.query, body.variables, log) }) };
    } catch (e) {
      if (e.name === 'AssertionError') throw e;
      return { ok: true, status: 200, json: async () => ({ errors: [{ message: e.message }] }) };
    }
  };
}

const tiles = Object.entries(world.objects).filter(([, o]) => o.json && 'owner_id' in o.json && 'garrison' in o.json);
const owned = tiles.filter(([, o]) => o.json.owner_id !== NULL_ID && o.json.owner_id);
const players = Object.entries(world.objects).filter(([, o]) => o.type.endsWith('::iplayer::Player'));
const vm = (raw) => Object.fromEntries((raw.contents || []).map((e) => [e.key, parseInt(e.value, 10) || 0]));
// objects built inside the vm context have another Object.prototype; compare them as plain JSON
const plain = (x) => JSON.parse(JSON.stringify(x));
const sgn = (v, neg) => (neg ? -Number(v) : Number(v));

// ── BCS keys ──────────────────────────────────────────────────────────────────
test('BCS encoders match the bytes the chain accepted', () => {
  const ctx = loadModules(makeFetch());
  assert.deepEqual([...evalIn(ctx, "rtBcsString('cash')")], [4, 99, 97, 115, 104]);
  assert.deepEqual([...evalIn(ctx, "rtBcsString('x'.repeat(130))").subarray(0, 3)], [0x82, 0x01, 120]);
  assert.equal(Buffer.from(evalIn(ctx, 'rtBcsCoord(299, -133)')).toString('hex'),
    '2b01000000000000' + '00' + '8500000000000000' + '01');
  assert.equal(evalIn(ctx, "rtB64(rtBcsString('cash'))"), Buffer.from('\x04cash').toString('base64'));
});

// ── realtime.js ───────────────────────────────────────────────────────────────
test('fetchTurfLive reads garrison, owner and cooldown from the flat json', async () => {
  const ctx = loadModules(makeFetch());
  let checked = 0;
  for (const [oid, o] of owned) {
    const live = await ctx.fetchTurfLive(oid);
    const g = Object.fromEntries((o.json.garrison.contents).map((e) => [e.key, parseInt(e.value, 10)]));
    assert.deepEqual([live.hm, live.bc, live.ef], [g.henchman || 0, g.bouncer || 0, g.enforcer || 0]);
    assert.equal(live.total, live.hm + live.bc + live.ef);
    assert.equal(live.ownerId, o.json.owner_id);
    assert.equal(live.cooldown, parseInt(o.json.cooldown, 10) || 0);
    assert.equal(live.live, true);
    checked++;
  }
  assert.ok(checked > 10);
  assert.ok(owned.some(([, o]) => o.json.garrison.contents.some((e) => parseInt(e.value, 10) > 0)),
    'fixture must contain a non-empty garrison, or this test proves nothing');
});

test('fetchTurfLive rejects a missing object and a GraphQL error', async () => {
  const ctx = loadModules(makeFetch());
  await assert.rejects(ctx.fetchTurfLive('0x' + 'ab'.repeat(32)), /fetchTurfLive/);
  const broken = loadModules(async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'boom' }] }) }));
  await assert.rejects(broken.fetchTurfLive('0x1'), /boom/);
  const down = loadModules(async () => ({ ok: false, status: 429, json: async () => ({}) }));
  await assert.rejects(down.fetchTurfLive('0x1'), /HTTP 429/);
});

test('lookupTurfByCoord: claimed tile, free coordinate, unowned tile', async () => {
  const ctx = loadModules(makeFetch());
  const [oid, o] = owned.find(([, t]) => t.json.garrison.contents.some((e) => parseInt(e.value, 10) > 0)) || owned[0];
  const x = sgn(o.json.x, o.json.x_neg), y = sgn(o.json.y, o.json.y_neg);
  const r = await ctx.lookupTurfByCoord(x, y);
  assert.equal(r.status, 'claimed');
  assert.equal(r.oid, oid);
  assert.equal(r.pid, o.json.owner_id);
  const g = vm(o.json.garrison);
  assert.deepEqual([r.gH, r.gB, r.gE], [g.henchman || 0, g.bouncer || 0, g.enforcer || 0]);
  assert.deepEqual(plain(await ctx.lookupTurfByCoord(999999, -999999)), { status: 'free' });
});

test('lookupTurfByCoord treats an owner-less turf object as free', async () => {
  const unowned = tiles.find(([, o]) => !o.json.owner_id || o.json.owner_id === NULL_ID);
  if (!unowned) return;                                    // none in this slice of the chain
  const ctx = loadModules(makeFetch());
  const j = unowned[1].json;
  assert.deepEqual(plain(await ctx.lookupTurfByCoord(sgn(j.x, j.x_neg), sgn(j.y, j.y_neg))), { status: 'free' });
});

test('fetchPlayerResources scales cash and weapons by 2^64 with two decimals', async () => {
  const ctx = loadModules(makeFetch());
  let nonzero = 0;
  for (const [pid] of players.slice(0, 20)) {
    const ids = world.field_lookup[pid];
    const want = (k) => (ids[k] && fieldJson(ids[k])
      ? Number(BigInt(fieldJson(ids[k]).value.amount) * 100n / SCALE) / 100 : 0);
    const r = await ctx.fetchPlayerResources(pid);
    assert.equal(r.cash, want('cash'));
    assert.equal(r.weapons, want('weapon'));
    if (r.cash > 0) nonzero++;
  }
  assert.ok(nonzero > 0);
});

test('fetchPlayerResources: an unknown player yields zeros, a failing endpoint does not throw', async () => {
  const ctx = loadModules(makeFetch());
  const r = await ctx.fetchPlayerResources('0x' + 'cd'.repeat(32));
  assert.deepEqual([r.cash, r.weapons], [0, 0]);
  const down = loadModules(async () => { throw new Error('offline'); });
  const r2 = await down.fetchPlayerResources('0x1');
  assert.deepEqual([r2.cash, r2.weapons], [0, 0]);
});

test('fetchPlayerLive maps the flat player json', async () => {
  const ctx = loadModules(makeFetch());
  for (const [pid, o] of players.slice(0, 30)) {
    const live = await ctx.fetchPlayerLive(pid);
    const j = o.json, g = vm(j.gangsters.gangster_types);
    assert.equal(live.name, j.player_name);
    assert.deepEqual([live.gangsters.hm, live.gangsters.bc, live.gangsters.ef],
      [g.henchman || 0, g.bouncer || 0, g.enforcer || 0]);
    assert.equal(live.gangsters.total, parseInt(j.gangsters.current_gangster_count, 10) || 0);
    assert.equal(live.gangsters.recruits, parseInt(j.gangsters.recruit_count, 10) || 0);
    assert.equal(live.gangsters.capacity, parseInt(j.gangsters.total_capacity, 10) || 0);
    assert.deepEqual(plain(live.timers), vm(j.timers));
    assert.deepEqual(plain(live.perks), vm(j.perks));
    assert.equal(live.turfCount, (j.owned_location || []).length);
    assert.equal(live.isInactive, !!j.is_inactive);
    assert.equal(live.dvdId, j.dvd_id || null);
  }
});

// ── analyzer.js ───────────────────────────────────────────────────────────────
test('baGetTx returns {type, parsedJson} events and the transaction time', async () => {
  const ctx = loadModules(makeFetch());
  const [digest, evs] = Object.entries(world.tx_events).find(([, e]) => e.some((x) => x.type === SIM));
  const tx = await ctx.baGetTx(digest);
  assert.deepEqual(tx.events.map((e) => e.type), evs.map((e) => e.type));
  const sim = tx.events.find((e) => e.type === SIM);
  assert.equal(sim.type, evalIn(ctx, 'BA_SIM_EVENT'));      // the analyzer matches on this exact string
  assert.ok(Array.isArray(sim.parsedJson.defender_units || []) && sim.parsedJson.attacker_name);
  assert.equal(tx.timestampMs, Date.parse('2026-10-22T19:40:35.235Z'));
  await assert.rejects(ctx.baGetTx('nope'), /Transaction not found/);
});

test('baLastBattleDigest asks for the sender\'s newest SimulationResultEvent', async () => {
  const log = [];
  const ctx = loadModules(makeFetch(log));
  assert.equal(await ctx.baLastBattleDigest('0xsender'), 'DIGEST1');
  assert.equal(await ctx.baLastBattleDigest('0xother'), null);
  assert.deepEqual(log[0].variables, { t: SIM, s: '0xsender' });
});
