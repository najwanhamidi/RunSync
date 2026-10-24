// RunSync — lap-boundary editing helpers (per lap and set-wide).
// A lap layout is a sorted list of bounds [{ t(ms start), type, name, trigger }]; the last lap ends at endT.

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

export function durations(bounds, endT) {
  return bounds.map((b, k) => ((k + 1 < bounds.length ? bounds[k + 1].t : endT) - b.t) / 1000);
}

/** lay laps out back-to-back from the first start using durations (null = keep); the last lap takes what's left */
export function relayout(bounds, durs, endT) {
  const cur = durations(bounds, endT);
  const out = [];
  let t = bounds[0].t;
  for (let k = 0; k < bounds.length; k++) {
    if (k > 0 && t > endT - 1000) break; // ran out of recording
    out.push({ ...bounds[k], t });
    const d = durs[k] ?? cur[k];
    t += Math.max(1, Math.round(d)) * 1000;
  }
  return out;
}

const TYPE_ORDER = ['warmup', 'active', 'rest', 'cooldown'];

/** group laps by type → [{ type, idx[], durs[], dur (median of editable), uniform, editable, pattern }] */
export function lapGroups(bounds, endT) {
  const durs = durations(bounds, endT);
  const last = bounds.length - 1;
  const map = new Map();
  bounds.forEach((b, k) => { if (!map.has(b.type)) map.set(b.type, []); map.get(b.type).push(k); });
  return [...map.entries()]
    .sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
    .map(([type, idx]) => {
      const ed = idx.filter(k => k !== last);
      const d = ed.map(k => durs[k]);
      return {
        type, idx, count: idx.length,
        editable: ed.length > 0,
        dur: d.length ? Math.round(median(d)) : Math.round(durs[last]),
        uniform: d.length ? Math.max(...d) - Math.min(...d) < 1 : true,
        lastOnly: !ed.length,
        pattern: namePattern(idx.map(k => bounds[k].name)),
      };
    });
}

export function namePattern(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  const m = names.map(n => String(n).match(/^(.*?)\s*\d+$/));
  if (m.every(x => x) && m.every(x => x[1] === m[0][1])) return `${m[0][1]} #`;
  return names.every(n => n === names[0]) ? names[0] : '';
}

/** apply one duration to every lap of a type (except the final lap, which always runs to the end) */
export function setGroupDuration(bounds, endT, type, sec) {
  const last = bounds.length - 1;
  const durs = bounds.map((b, k) => (b.type === type && k !== last ? sec : null));
  return relayout(bounds, durs, endT);
}

/** apply several kind → seconds lengths in one pass, e.g. { active: 180, rest: 60 } */
export function setGroupDurations(bounds, endT, map) {
  const last = bounds.length - 1;
  const durs = bounds.map((b, k) => (k !== last && map[b.type] > 0 ? map[b.type] : null));
  return relayout(bounds, durs, endT);
}

/** min / max length of each kind (final lap excluded) */
export function groupRange(bounds, endT, type) {
  const d = durations(bounds, endT).filter((_, k) => k !== bounds.length - 1 && bounds[k].type === type);
  return d.length ? [Math.min(...d), Math.max(...d)] : null;
}

export function setGroupName(bounds, type, pattern) {
  let i = 0;
  const n = bounds.filter(b => b.type === type).length;
  return bounds.map(b => {
    if (b.type !== type) return b;
    i++;
    const name = pattern.includes('#') ? pattern.replace(/#/g, String(i)) : n > 1 && pattern ? `${pattern} ${i}` : pattern;
    return { ...b, name };
  });
}

export function setGroupType(bounds, fromType, toType) {
  return bounds.map(b => (b.type === fromType ? { ...b, type: toType } : b));
}

/** WU? (rep rec)+ rep? CD? */
export function intervalShape(bounds) {
  let k = 0;
  const n = bounds.length;
  const wu = bounds[0]?.type === 'warmup' ? 0 : null;
  if (wu === 0) k = 1;
  const reps = [], recs = [];
  while (k < n && bounds[k].type === 'active') {
    reps.push(k++);
    if (k < n && bounds[k].type === 'rest') recs.push(k++); else break;
  }
  const cd = k < n && bounds[k].type === 'cooldown' && k === n - 1 ? k : null;
  if (cd != null) k++;
  if (k !== n || reps.length < 2) return null;
  return { wu, reps, recs, cd, recAfterLast: recs.length === reps.length };
}

/** rebuild an interval set with a new number of reps (uses median rep / recovery lengths) */
export function setRepCount(bounds, endT, count) {
  const sh = intervalShape(bounds);
  if (!sh) return bounds;
  const durs = durations(bounds, endT);
  const repSec = Math.round(median(sh.reps.filter(k => k !== bounds.length - 1).map(k => durs[k])) || durs[sh.reps[0]]);
  const recSec = sh.recs.length ? Math.round(median(sh.recs.filter(k => k !== bounds.length - 1).map(k => durs[k])) || durs[sh.recs[0]]) : 0;
  const rep0 = bounds[sh.reps[0]], rec0 = sh.recs.length ? bounds[sh.recs[0]] : null;
  const repPat = namePattern(sh.reps.map(k => bounds[k].name)) || 'Rep #';
  const recPat = rec0 ? namePattern(sh.recs.map(k => bounds[k].name)) || 'Recovery #' : '';
  const nb = [], nd = [];
  if (sh.wu != null) { nb.push(bounds[0]); nd.push(durs[0]); }
  for (let i = 1; i <= count; i++) {
    nb.push({ ...rep0, name: repPat.replace(/#/g, i) }); nd.push(repSec);
    if (rec0 && (i < count || sh.recAfterLast)) { nb.push({ ...rec0, name: recPat.replace(/#/g, i) }); nd.push(recSec); }
  }
  const cd = sh.cd != null ? bounds[sh.cd] : { t: 0, type: 'cooldown', name: 'Cool down' };
  nb.push(cd); nd.push(null);
  nb[0] = { ...nb[0], t: bounds[0].t };
  return relayout(nb, nd, endT);
}

/** move every boundary after the first by sec (whole set slides; first and last laps absorb it) */
export function shiftSet(bounds, endT, sec) {
  return bounds.map((b, k) => (k === 0 ? b : { ...b, t: Math.min(endT - 1000, Math.max(bounds[0].t + 1000, b.t + sec * 1000)) }))
    .filter((b, k, a) => k === 0 || b.t > a[k - 1].t);
}

/** snap each boundary to the nearest speed change (≥ 0.3 km/h) within ±win seconds */
export function snapToChanges(bounds, recs, win = 12) {
  const ch = [];
  const step = i => Math.abs(recs[i].speed - recs[i - 1].speed) * 3.6 >= 0.3;
  for (let i = 1; i < recs.length; i++) if (step(i) && !(i > 1 && step(i - 1))) ch.push(recs[i].t); // start of each change (a belt ramp counts once)
  if (!ch.length) return { bounds, moved: 0 };
  let moved = 0;
  const out = bounds.map((b, k) => {
    if (k === 0) return b;
    let best = null;
    for (const c of ch) if (Math.abs(c - b.t) <= win * 1000 && (best == null || Math.abs(c - b.t) < Math.abs(best - b.t))) best = c;
    if (best != null && best !== b.t) { moved++; return { ...b, t: best }; }
    return b;
  }).filter((b, k, a) => k === 0 || b.t > a[k - 1].t);
  return { bounds: out, moved };
}

// ---------------------------------------------------------------- distance-based editing
/** distance at the first record at/after t */
export function distAt(recs, t) {
  let lo = 0, hi = recs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (recs[m].t < t) lo = m + 1; else hi = m; }
  return recs[lo].dist;
}
/** time of the first record whose distance reaches d (whole seconds, as stored) */
export function timeAtDist(recs, d) {
  let lo = 0, hi = recs.length - 1;
  if (recs[hi].dist < d - 1e-6) return recs[hi].t;
  while (lo < hi) { const m = (lo + hi) >> 1; if (recs[m].dist < d - 1e-6) lo = m + 1; else hi = m; }
  // pick whichever neighbouring second is closer to the exact distance
  if (lo > 0 && Math.abs(recs[lo - 1].dist - d) < Math.abs(recs[lo].dist - d)) return recs[lo - 1].t;
  return recs[lo].t;
}
export function lapDistances(bounds, recs) {
  const end = recs[recs.length - 1];
  return bounds.map((b, k) => (k + 1 < bounds.length ? distAt(recs, bounds[k + 1].t) : end.dist) - distAt(recs, b.t));
}
/** like relayout(), but lengths are metres measured along the synced treadmill distance */
export function relayoutDist(bounds, lens, recs) {
  const end = recs[recs.length - 1].t;
  const cur = lapDistances(bounds, recs);
  const out = [];
  let t = bounds[0].t;
  for (let k = 0; k < bounds.length; k++) {
    if (k > 0 && t > end - 1000) break;
    out.push({ ...bounds[k], t });
    const len = lens[k] ?? cur[k];
    let nt = timeAtDist(recs, distAt(recs, t) + Math.max(1, len));
    if (nt <= t) nt = t + 1000;
    t = nt;
  }
  return out;
}
export function setGroupDistance(bounds, recs, type, m) {
  const last = bounds.length - 1;
  return relayoutDist(bounds, bounds.map((b, k) => (b.type === type && k !== last ? m : null)), recs);
}
export function setGroupDistances(bounds, recs, map) {
  const last = bounds.length - 1;
  return relayoutDist(bounds, bounds.map((b, k) => (k !== last && map[b.type] > 0 ? map[b.type] : null)), recs);
}
export function groupDistStats(bounds, recs, type) {
  const d = lapDistances(bounds, recs).filter((_, k) => k !== bounds.length - 1 && bounds[k].type === type);
  if (!d.length) return null;
  return { min: Math.min(...d), max: Math.max(...d), med: median(d) };
}
/** move the end of lap k so it covers m metres */
export function setLapDistance(bounds, recs, k, m) {
  if (k + 1 >= bounds.length) return bounds;
  const end = recs[recs.length - 1].t;
  const lo = bounds[k].t + 1000, hi = (k + 2 < bounds.length ? bounds[k + 2].t : end) - 1000;
  const t = Math.min(hi, Math.max(lo, timeAtDist(recs, distAt(recs, bounds[k].t) + m)));
  return bounds.map((b, j) => (j === k + 1 ? { ...b, t } : b));
}

/** "0.73", "0.73 km", "730 m", "730" → metres */
export function parseDistInput(str) {
  const s = String(str || '').trim().toLowerCase().replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (/km/.test(s)) return n * 1000;
  if (/m\b|m$/.test(s)) return n;
  return n > 50 ? n : n * 1000;
}
