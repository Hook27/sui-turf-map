// ── MODULE: daily-history.js ── Vendetta World Map v4.22 ──────────────────────────
// Reads the long-term DAILY tile history in either of its two formats, so the
// leaderboard (7d trend) and the garrison history chart do not care which one the
// pipeline currently publishes. No DOM, no globals besides the dh* functions.
//
//   legacy  player_history_daily.json     {days: [{date, players: {pid: count}}]}
//           one full {pid: count} map per day: ~350 KB/day, 72 MB by Oct 2026.
//   v2      player_history_daily_v2.json  {format: 2, updated,
//             base:    {date, players: {pid: count}},
//             changes: [{date, p: {pid: count | null}}]}
//           the first day in full, then one entry per day holding ONLY the players
//           whose count changed (null = player absent that day). Every day has an
//           entry, even an empty one, so the day count and the dates survive.
//
// Both are oldest-first. Semantics are identical: "the count of each player that
// existed on that day".

function dhIsV2(h){
  return !!h && h.format===2 && !!h.base && Array.isArray(h.changes);
}

/** Number of days the history covers (0 for anything unreadable). */
function dhDayCount(h){
  if(dhIsV2(h)) return h.changes.length;
  return Array.isArray(h?.days) ? h.days.length : 0;
}

/**
 * {pid: count} on the latest day that is not after `date` ('YYYY-MM-DD'); before
 * the first day it returns the first day. null when there is no readable data.
 * The result is the caller's to keep (v2 builds a fresh object; legacy returns the
 * stored one — treat it as read-only either way).
 */
function dhCountsAt(h, date){
  if(dhIsV2(h)){
    const state = Object.assign({}, h.base.players || {});
    for(const c of h.changes){
      if(c.date > date) break;
      const p = c.p || {};
      for(const pid in p){
        if(p[pid]==null) delete state[pid]; else state[pid] = p[pid];
      }
    }
    return state;
  }
  const days = h?.days;
  if(!Array.isArray(days) || !days.length) return null;
  let best = days[0];
  for(const d of days){
    if(d.date <= date) best = d; else break;
  }
  return best?.players || null;
}

/** One player's history: {labels: [date, ...], counts: [n, ...]}, only the days on
 *  which the player existed. */
function dhSeries(h, pid){
  const labels = [], counts = [];
  if(dhIsV2(h)){
    let v = h.base.players?.[pid] ?? null;
    if(v!=null){ labels.push(h.base.date); counts.push(v); }
    for(const c of h.changes){
      const p = c.p || {};
      if(Object.prototype.hasOwnProperty.call(p, pid)) v = p[pid];   // null = absent from this day on
      if(v!=null){ labels.push(c.date); counts.push(v); }
    }
    return {labels, counts};
  }
  for(const d of (h?.days || [])){
    const v = d.players?.[pid];
    if(v!=null){ labels.push(d.date); counts.push(v); }
  }
  return {labels, counts};
}

/**
 * Rank of every player in a {pid: count} map: most tiles first. TIES are broken by the
 * players' CURRENT order (`curIndex`: pid -> index in the live ranking), then by pid, so
 * the result never depends on the key order of the JSON object. That order differs
 * between the legacy and the v2 file, and it used to leak into the trend arrows: two
 * players on 71 tiles with no change showed ▲1 / ▼1 instead of ═. A tie is no movement.
 * Players that are no longer in the live ranking sort after the ones that are.
 */
function dhRankMap(counts, curIndex){
  const at = (pid) => curIndex && curIndex.has(pid) ? curIndex.get(pid) : Infinity;
  const entries = Object.entries(counts || {});
  entries.sort((a, b) => {
    if(b[1] !== a[1]) return b[1] - a[1];
    const x = at(a[0]), y = at(b[0]);
    if(x !== y) return x < y ? -1 : 1;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return new Map(entries.map(([pid], i) => [pid, i + 1]));
}

/**
 * Load the daily history: the v2 file first, the legacy file as the fallback while
 * the pipeline still publishes it (or if v2 is missing/unreadable). Never throws;
 * null when neither can be read. The ?t= buster keeps it from being cached for 10
 * minutes by the host, as the other history files do.
 */
async function loadDailyHistory(){
  for(const f of ['player_history_daily_v2.json', 'player_history_daily.json']){
    try{
      const r = await fetch(f + '?t=' + Date.now());
      if(!r.ok) continue;
      const j = await r.json();
      if(dhDayCount(j) > 0) return j;
    }catch(e){ /* unreadable: try the next source */ }
  }
  return null;
}
