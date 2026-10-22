// Manual smoke test of the browser modules against the REAL GraphQL endpoint (needs network).
//   node tests/js/live_check.mjs
// Not part of the offline suite. Exits non-zero when a check fails.
import { loadModules } from './load_modules.mjs';

const ctx = loadModules(globalThis.fetch);
const SIR_CAPRICE = '0x857e8e7fc94d43f327bb24388439d0fdcc112a9e5e25264969b27011a233d2f0';
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

try {
  const claimed = await ctx.lookupTurfByCoord(299, -133);
  check('lookupTurfByCoord(299,-133) is claimed', claimed.status === 'claimed' && /^0x[0-9a-f]{64}$/.test(claimed.oid),
    `owner ${claimed.pid && claimed.pid.slice(0, 10)} garrison ${claimed.gH}/${claimed.gB}/${claimed.gE}`);
  const free = await ctx.lookupTurfByCoord(99999, 99999);
  check('lookupTurfByCoord(99999,99999) is free', free.status === 'free');
  const live = await ctx.fetchTurfLive(claimed.oid);
  check('fetchTurfLive', live.ownerId === claimed.pid && live.live === true, `total ${live.total}`);
  const p = await ctx.fetchPlayerLive(SIR_CAPRICE);
  check('fetchPlayerLive(Sir Caprice)', p.name === 'Sir Caprice' && p.turfCount > 0 && p.gangsters.capacity > 0,
    `${p.turfCount} turfs, ${p.gangsters.total} gangsters, ${Object.keys(p.timers).length} timers`);
  const r = await ctx.fetchPlayerResources(SIR_CAPRICE);
  check('fetchPlayerResources(Sir Caprice)', r.cash > 0 && r.weapons > 0, `cash ${r.cash} weapons ${r.weapons}`);
  const digest = await ctx.baLastBattleDigest('0x9ccd9bbdafbe9ce5c5157580974f207230972f67c9c78cffc7b721052f24ce95');
  check('baLastBattleDigest(known sender)', !!digest, digest);
  const tx = await ctx.baGetTx(digest);
  const sim = tx.events.find((e) => e.type === '0x63081c5dd824a49289b6557d9f9bcf8613fe801e89dbad728616348a58b4b40a::ibattle::SimulationResultEvent');
  check('baGetTx has the SimulationResultEvent and a time', !!sim && tx.timestampMs > 1.7e12,
    sim && `${sim.parsedJson.attacker_name} vs ${sim.parsedJson.defender_name}, ${new Date(tx.timestampMs).toISOString()}`);
  check('baLastBattleDigest(no battles) is null', (await ctx.baLastBattleDigest('0x' + '0'.repeat(63) + '1')) === null);
} catch (e) {
  console.log('FAIL exception', e);
  failed++;
}
process.exit(failed ? 1 : 0);
