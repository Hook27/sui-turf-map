// Tests for modules/daily-history.js: the reader of the long-term daily tile history.
// It must give IDENTICAL answers for the legacy file ({days:[{date,players}]}) and the v2
// delta file ({format:2, base, changes}), because the leaderboard and the garrison chart
// switch between them without knowing. Run: node --test tests/js/daily_history.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './load_modules.mjs';

const FILES = ['daily-history.js'];
const load = (fetchImpl = async () => { throw new Error('no network'); }) => loadModules(fetchImpl, FILES);

// ── helpers: a deterministic history and an independent legacy → v2 converter ──────────
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function makeLegacy(seed = 7, nDays = 60, nPids = 40) {
  const r = rng(seed), pids = Array.from({ length: nPids }, (_, i) => '0xp' + i);
  const live = new Map(pids.slice(0, 25).map(p => [p, 1 + Math.floor(r() * 5)]));
  const days = [];
  for (let d = 0; d < nDays; d++) {
    for (const p of pids) {
      const x = r();
      if (live.has(p)) {
        if (x < 0.04) live.delete(p);
        else if (x < 0.15) live.set(p, Math.max(1, live.get(p) + (r() < 0.5 ? -1 : 1)));
      } else if (x < 0.1) live.set(p, 1 + Math.floor(r() * 3));          // a new or returning player
    }
    days.push({ date: new Date(Date.UTC(2026, 2, 22 + d)).toISOString().slice(0, 10), players: Object.fromEntries(live) });
  }
  return { updated: 'x', days };
}
function toV2(legacy) {
  const days = legacy.days;
  let prev = days[0].players;
  const changes = [];
  for (const d of days.slice(1)) {
    const p = {};
    for (const [k, v] of Object.entries(d.players)) if (prev[k] !== v) p[k] = v;
    for (const k of Object.keys(prev)) if (!(k in d.players)) p[k] = null;
    changes.push({ date: d.date, p });
    prev = d.players;
  }
  return { format: 2, updated: 'x', base: { date: days[0].date, players: days[0].players }, changes };
}
const plain = (v) => JSON.parse(JSON.stringify(v));      // objects from the vm have another Object prototype

// ── format semantics, spelled out ──────────────────────────────────────────────────────
const V2 = { format: 2, base: { date: '2026-03-01', players: { a: 1, b: 3 } }, changes: [
  { date: '2026-03-02', p: {} },
  { date: '2026-03-03', p: { b: 4, c: 1 } },
  { date: '2026-03-04', p: { a: null } },
  { date: '2026-03-05', p: { a: 2 } },
] };

test('v2: dayCount counts the base plus one entry per day, empty days included', () => {
  const ctx = load();
  assert.equal(ctx.dhDayCount(V2), 5);
});

test('v2: dhCountsAt replays the changes up to and including the date', () => {
  const ctx = load();
  assert.deepEqual(plain(ctx.dhCountsAt(V2, '2026-03-01')), { a: 1, b: 3 });
  assert.deepEqual(plain(ctx.dhCountsAt(V2, '2026-03-02')), { a: 1, b: 3 });
  assert.deepEqual(plain(ctx.dhCountsAt(V2, '2026-03-03')), { a: 1, b: 4, c: 1 });
  assert.deepEqual(plain(ctx.dhCountsAt(V2, '2026-03-04')), { b: 4, c: 1 });          // a left (null)
  assert.deepEqual(plain(ctx.dhCountsAt(V2, '2026-03-05')), { a: 2, b: 4, c: 1 });    // a came back
});

test('dhCountsAt: before the first day gives the first day, after the last gives the last', () => {
  const ctx = load();
  assert.deepEqual(plain(ctx.dhCountsAt(V2, '2020-01-01')), { a: 1, b: 3 });
  assert.deepEqual(plain(ctx.dhCountsAt(V2, '2099-01-01')), { a: 2, b: 4, c: 1 });
  const legacy = { days: [{ date: '2026-03-01', players: { a: 1 } }, { date: '2026-03-03', players: { a: 2 } }] };
  assert.deepEqual(plain(ctx.dhCountsAt(legacy, '2020-01-01')), { a: 1 });
  assert.deepEqual(plain(ctx.dhCountsAt(legacy, '2026-03-02')), { a: 1 });             // latest day not after the date
  assert.deepEqual(plain(ctx.dhCountsAt(legacy, '2099-01-01')), { a: 2 });
});

test('v2: calling dhCountsAt never mutates the stored history', () => {
  const ctx = load();
  const h = JSON.parse(JSON.stringify(V2));
  const first = ctx.dhCountsAt(h, '2026-03-05');
  first.zzz = 99;
  delete first.a;
  assert.deepEqual(plain(ctx.dhCountsAt(h, '2026-03-05')), { a: 2, b: 4, c: 1 });
  assert.deepEqual(plain(h), plain(V2));
});

test('v2: dhSeries carries a value forward and skips the days a player did not exist', () => {
  const ctx = load();
  assert.deepEqual(plain(ctx.dhSeries(V2, 'a')), { labels: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-05'], counts: [1, 1, 1, 2] });
  assert.deepEqual(plain(ctx.dhSeries(V2, 'b')), { labels: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'], counts: [3, 3, 4, 4, 4] });
  assert.deepEqual(plain(ctx.dhSeries(V2, 'c')), { labels: ['2026-03-03', '2026-03-04', '2026-03-05'], counts: [1, 1, 1] });   // joined on the 3rd
  assert.deepEqual(plain(ctx.dhSeries(V2, 'nobody')), { labels: [], counts: [] });
});

test('unreadable input is zero days, no data, and never throws', () => {
  const ctx = load();
  const bads = [null, undefined, {}, [], 'x', { days: 'no' }, { days: [] }, { format: 2 }, { format: 2, base: {} },
    { format: 2, base: { date: 'x' }, changes: 'no' }, { format: 3, base: { date: 'x', players: {} }, changes: [] }];
  for (const bad of bads) {
    assert.equal(ctx.dhDayCount(bad), 0, JSON.stringify(bad));
    assert.equal(ctx.dhCountsAt(bad, '2026-01-01'), null, JSON.stringify(bad));
    assert.deepEqual(plain(ctx.dhSeries(bad, 'a')), { labels: [], counts: [] }, JSON.stringify(bad));
  }
});

// ── the two formats must agree, on a history with joins, leaves and changes ─────────────
test('legacy and v2 give identical answers for every date and every player', () => {
  const ctx = load();
  for (const seed of [1, 7, 42, 2026]) {
    const legacy = makeLegacy(seed), v2 = toV2(legacy);
    assert.equal(ctx.dhDayCount(v2), ctx.dhDayCount(legacy));
    const dates = ['2020-01-01', ...legacy.days.map(d => d.date), '2099-12-31'];
    for (const date of dates) {
      assert.deepEqual(plain(ctx.dhCountsAt(v2, date)), plain(ctx.dhCountsAt(legacy, date)), `seed ${seed} ${date}`);
    }
    const pids = new Set(legacy.days.flatMap(d => Object.keys(d.players)));
    pids.add('0xnever');
    for (const pid of pids) {
      assert.deepEqual(plain(ctx.dhSeries(v2, pid)), plain(ctx.dhSeries(legacy, pid)), `seed ${seed} ${pid}`);
    }
  }
});

test('the generator really exercises joins, leaves and returns (the equivalence test is not vacuous)', () => {
  const v2 = toV2(makeLegacy(7));
  const nulls = v2.changes.reduce((n, c) => n + Object.values(c.p).filter(v => v === null).length, 0);
  const changed = v2.changes.reduce((n, c) => n + Object.keys(c.p).length, 0);
  assert.ok(nulls > 5 && changed > 100, `nulls ${nulls}, changes ${changed}`);
});

// ── loading: v2 first, legacy as the fallback ───────────────────────────────────────────
const resp = (body, ok = true, status = 200) => ({ ok, status, json: async () => (typeof body === 'function' ? body() : body) });
const router = (routes, log = []) => async (url) => {
  log.push(url);
  const name = url.split('?')[0];
  if (!(name in routes)) return resp({}, false, 404);
  const r = routes[name];
  if (r instanceof Error) throw r;
  return r;
};
const LEGACY = { days: [{ date: '2026-03-01', players: { a: 1 } }, { date: '2026-03-02', players: { a: 2 } }] };

test('loadDailyHistory prefers the v2 file and never touches the legacy one when v2 works', async () => {
  const log = [];
  const ctx = load(router({ 'player_history_daily_v2.json': resp(V2), 'player_history_daily.json': resp(LEGACY) }, log));
  const h = await ctx.loadDailyHistory();
  assert.equal(h.format, 2);
  assert.equal(log.length, 1);
  assert.match(log[0], /^player_history_daily_v2\.json\?t=\d+$/);        // cache-busted like the other history files
});

test('loadDailyHistory falls back to the legacy file when v2 is missing (404)', async () => {
  const log = [];
  const ctx = load(router({ 'player_history_daily.json': resp(LEGACY) }, log));
  const h = await ctx.loadDailyHistory();
  assert.equal(ctx.dhDayCount(h), 2);
  assert.deepEqual(log.map(u => u.split('?')[0]), ['player_history_daily_v2.json', 'player_history_daily.json']);
});

test('loadDailyHistory falls back when v2 is garbage, empty, or a network error', async () => {
  const garbage = resp(() => { throw new SyntaxError('<html>'); });
  for (const v2 of [garbage, resp({}), resp({ format: 2 }), resp({ days: [] }), new Error('offline')]) {
    const ctx = load(router({ 'player_history_daily_v2.json': v2, 'player_history_daily.json': resp(LEGACY) }));
    assert.equal(ctx.dhDayCount(await ctx.loadDailyHistory()), 2);
  }
});

test('loadDailyHistory returns null (and does not throw) when nothing is readable', async () => {
  assert.equal(await load(router({})).loadDailyHistory(), null);
  assert.equal(await load(async () => { throw new Error('offline'); }).loadDailyHistory(), null);
  const empty = router({ 'player_history_daily_v2.json': resp({ days: [] }), 'player_history_daily.json': resp({ days: [] }) });
  assert.equal(await load(empty).loadDailyHistory(), null);
});

// ── dhRankMap: the rank behind the trend arrows ─────────────────────────────────────────
const rankObj = (ctx, counts, order) => plain([...ctx.dhRankMap(counts, new Map(order.map((p, i) => [p, i]))).entries()]);

test('dhRankMap: most tiles first; a tie goes to the player who is higher in the live ranking', () => {
  const ctx = load();
  const counts = { a: 5, b: 71, c: 71, d: 3 };
  assert.deepEqual(rankObj(ctx, counts, ['c', 'b', 'a', 'd']), [['c', 1], ['b', 2], ['a', 3], ['d', 4]]);
  assert.deepEqual(rankObj(ctx, counts, ['b', 'c', 'a', 'd']), [['b', 1], ['c', 2], ['a', 3], ['d', 4]]);
});

test('dhRankMap never depends on the key order of the stored object (the legacy vs v2 difference)', () => {
  const ctx = load();
  const order = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const entries = [['p1', 9], ['p2', 71], ['p3', 71], ['p4', 71], ['p5', 2], ['p6', 2]];
  const baseline = rankObj(ctx, Object.fromEntries(entries), order);
  const r = rng(99);
  for (let n = 0; n < 50; n++) {
    const shuffled = entries.map(e => [r(), e]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    assert.deepEqual(rankObj(ctx, Object.fromEntries(shuffled), order), baseline);
  }
});

test('dhRankMap: players that left the live ranking sort after the ones that are still in it, then by pid', () => {
  const ctx = load();
  assert.deepEqual(rankObj(ctx, { gone2: 4, here: 4, gone1: 4, top: 9 }, ['top', 'here']),
    [['top', 1], ['here', 2], ['gone1', 3], ['gone2', 4]]);
});

test('dhRankMap: a tie of unchanged players gives no movement (the Meruem/Baby case)', () => {
  const ctx = load();
  // the live ranking is the order of the NEW counts; the old counts are identical (no change)
  const live = ['x', 'm', 'b', 'y'], counts = { x: 90, m: 71, b: 71, y: 50 };
  const prev = Object.fromEntries(ctx.dhRankMap(counts, new Map(live.map((p, i) => [p, i]))));
  const now = Object.fromEntries(live.map((p, i) => [p, i + 1]));
  assert.deepEqual(prev, now);                      // every player keeps his rank: no arrows
});

test('dhRankMap handles empty and missing input', () => {
  const ctx = load();
  assert.equal(ctx.dhRankMap({}, new Map()).size, 0);
  assert.equal(ctx.dhRankMap(null, null).size, 0);
  assert.deepEqual(plain([...ctx.dhRankMap({ a: 1, b: 2 }, null).entries()]), [['b', 1], ['a', 2]]);
});
