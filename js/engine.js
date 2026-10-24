// RunSync — sync engine: alignment, start-trim, speed transfer, distance fix,
// segment detection, run-type classification, lap building and summaries.

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sum = a => a.reduce((x, y) => x + y, 0);
const cv = a => { const m = mean(a); if (!m) return 0; return Math.sqrt(mean(a.map(x => (x - m) ** 2))) / m; };

export function fmtDur(sec, forceH = false) {
  if (sec == null || !Number.isFinite(sec)) return '--';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h || forceH ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtPace(speed) {
  if (!speed || speed <= 0.05) return '--:--';
  let s = Math.round(1000 / speed);
  const m = Math.floor(s / 60); s -= m * 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- sources
export function sourceFromActivity(act, label) {
  const samples = act.records.filter(r => r.speed != null).map(r => ({ t: r.t, speed: r.speed }));
  return { kind: 'file', label: label || act.name, samples, dt: sampleDt(samples) };
}
function sampleDt(samples) {
  const d = [];
  for (let i = 1; i < Math.min(samples.length, 400); i++) d.push(samples[i].t - samples[i - 1].t);
  return Math.max(200, Math.min(10000, median(d) || 1000));
}

/** plan segments [{dur, open, speed(m/s), type, name}] → 1 Hz samples starting at startMs; open steps fill up to endMs */
export function sourceFromSegments(segs, startMs, endMs, label = 'Manual plan') {
  const fixed = sum(segs.filter(s => !s.open).map(s => s.dur));
  const avail = Math.max(0, (endMs - startMs) / 1000 - fixed);
  const nOpen = segs.filter(s => s.open).length;
  const samples = [];
  let el = 0;
  for (const s of segs) {
    const dur = s.open ? Math.round(avail / nOpen) : Math.round(s.dur);
    for (let k = 0; k < dur; k++) samples.push({ t: startMs + (el + k) * 1000, speed: s.speed });
    el += dur;
  }
  return { kind: 'plan', label, samples, dt: 1000 };
}

function makeLookup(S, dt) {
  const n = S.length;
  const ts = S.map(s => s.t);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + S[i].speed * ((i + 1 < n ? S[i + 1].t - S[i].t : dt) / 1000);
  const end = ts[n - 1] + dt;
  const idx = t => {
    if (t < ts[0]) return -1;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const F = t => {
    t = Math.max(ts[0], Math.min(end, t));
    const i = idx(t);
    return cum[i] + S[i].speed * (t - ts[i]) / 1000;
  };
  return {
    start: ts[0], end, dt,
    speedAt: t => { const i = idx(t); return i < 0 || t >= end ? null : S[i].speed; },
    integ: (a, b) => F(b) - F(a),
  };
}

/** first moment the intended speed is set: first sample ≥ minSpeed, then skip any ramp-up still climbing */
export function findIntendedStart(S, minSp) {
  const i = S.findIndex(s => s.speed >= minSp);
  if (i < 0) return null;
  let j = i;
  while (j + 1 < S.length && S[j + 1].t - S[i].t <= 15000 && S[j + 1].speed > S[j].speed + 0.03) j++;
  return { index: j, t: S[j].t, speed: S[j].speed, skippedSamples: j };
}

// ---------------------------------------------------------------- alignment
function overlapFrac(a0, a1, b0, b1) {
  const ov = Math.min(a1, b1) - Math.max(a0, b0);
  const d = Math.min(a1 - a0, b1 - b0);
  return d > 0 ? Math.max(0, ov) / d : 0;
}

/** change points (ms) where the source speed steps by > 0.5 km/h and holds */
function changePoints(S) {
  const out = [];
  for (let i = 1; i < S.length; i++) {
    if (Math.abs(S[i].speed - S[i - 1].speed) * 3.6 > 0.5) {
      const hold = S.slice(i, i + 5).every(s => Math.abs(s.speed - S[i].speed) * 3.6 < 0.5);
      if (hold && (!out.length || S[i].t - out[out.length - 1] > 15000)) out.push(S[i].t);
    }
  }
  return out;
}

function lapAlign(watch, S) {
  const laps = (watch.laps || []).slice(1).map(l => l.start);
  const ch = changePoints(S);
  if (laps.length < 3 || ch.length < 3) return null;
  let best = null;
  for (const a of laps) for (const c of ch) {
    const lag = a - c;
    if (Math.abs(lag) > 6 * 3600e3) continue;
    const diffs = [];
    for (const l of laps) {
      let bd = Infinity;
      for (const x of ch) { const d = l - (x + lag); if (Math.abs(d) < Math.abs(bd)) bd = d; }
      if (Math.abs(bd) <= 2500) diffs.push(lag + bd);
    }
    if (!best || diffs.length > best.n) best = { n: diffs.length, off: median(diffs) };
  }
  if (best && best.n >= Math.max(3, laps.length * 0.5)) return { offsetSec: Math.round(best.off / 1000), matches: best.n, of: laps.length };
  return null;
}

const WATCH_CAD_LAG = 11, WATCH_SPD_LAG = 18; // seconds the watch's own signals trail a treadmill change

function signalAlign(watch, S) {
  const W = watch.records;
  const useCad = W.filter(r => r.cad > 0).length > W.length * 0.5;
  const w0 = W[0].t, wN = Math.round((W[W.length - 1].t - w0) / 1000) + 1;
  const wsig = new Float64Array(wN).fill(NaN);
  for (const r of W) { const k = Math.round((r.t - w0) / 1000); const v = useCad ? r.cad : r.speed; if (k >= 0 && k < wN && v != null) wsig[k] = v; }
  const s0 = S[0].t, sN = Math.round((S[S.length - 1].t - s0) / 1000) + 1;
  const ssig = new Float64Array(sN).fill(NaN);
  for (const s of S) { const k = Math.round((s.t - s0) / 1000); if (k >= 0 && k < sN) ssig[k] = s.speed; }
  const minOv = Math.min(wN, sN) * 0.3;
  const corrAt = lagS => { // source index j ↔ watch index j + lagS + (s0-w0)/1000
    const base = Math.round((s0 - w0) / 1000) + lagS;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const j0 = Math.max(0, -base), j1 = Math.min(sN, wN - base);
    for (let j = j0; j < j1; j += 1) {
      const a = wsig[j + base], b = ssig[j];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (n < minOv) return -2;
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    return va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : -2;
  };
  const span = Math.round((wN + sN) / 1);
  let best = { c: -3, lag: 0 };
  for (let lag = -span; lag <= span; lag += 5) { const c = corrAt(lag); if (c > best.c) best = { c, lag }; }
  for (let lag = best.lag - 5; lag <= best.lag + 5; lag++) { const c = corrAt(lag); if (c > best.c) best = { c, lag }; }
  if (best.c < 0.2) return null;
  const lagFix = useCad ? WATCH_CAD_LAG : WATCH_SPD_LAG;
  return { offsetSec: best.lag - lagFix, corr: best.c, signal: useCad ? 'cadence' : 'speed' };
}

/** best guess offset (seconds) to add to source times so they line up with the watch */
export function autoAlign(watch, source) {
  const W = watch.records, S = source.samples;
  if (!W.length || !S.length) return { offsetSec: 0, method: 'none', note: 'No data' };
  const wS = W[0].t, wE = W[W.length - 1].t, sS = S[0].t, sE = S[S.length - 1].t;
  const ov0 = overlapFrac(wS, wE, sS, sE);
  if (ov0 >= 0.5) {
    const diff = Math.round((sS - wS) / 1000);
    return { offsetSec: 0, method: 'timestamps', note: `Matched by clock time (treadmill file started ${Math.abs(diff)} s ${diff >= 0 ? 'after' : 'before'} the watch).` };
  }
  let best = { f: 0, k: 0 };
  for (let k = -56; k <= 56; k++) { const f = overlapFrac(wS, wE, sS + k * 900e3, sE + k * 900e3); if (f > best.f + 1e-9) best = { f, k }; }
  if (best.f >= 0.8 && best.k !== 0) {
    const off = best.k * 900;
    const lap = lapAlign(watch, S.map(s => ({ t: s.t + off * 1000, speed: s.speed })));
    const fine = lap && Math.abs(lap.offsetSec) <= 60 ? lap.offsetSec : 0;
    return { offsetSec: off + fine, method: 'timezone', note: `Clocks differ by ${fmtDur(Math.abs(off), true)} (time-zone mismatch)${fine ? `, fine-tuned ${fine} s from watch laps` : ''}.` };
  }
  const lap = lapAlign(watch, S);
  if (lap) return { offsetSec: lap.offsetSec, method: 'laps', note: `Matched ${lap.matches}/${lap.of} watch laps to treadmill speed changes.` };
  const sig = signalAlign(watch, S);
  if (sig) return { offsetSec: sig.offsetSec, method: 'signal', note: `Matched watch ${sig.signal} pattern (r = ${sig.corr.toFixed(2)}). Check and nudge if needed.` };
  return { offsetSec: Math.round((wS - sS) / 1000), method: 'start', note: 'No overlap found — aligned the two starts. Adjust manually.' };
}

/** alignment from watch laps or signal shape only (ignores clock time) — used for manual plans */
export function alignBySignals(watch, source) {
  const lap = lapAlign(watch, source.samples);
  if (lap) return { offsetSec: lap.offsetSec, method: 'laps', note: `Matched ${lap.matches}/${lap.of} watch laps to speed changes.` };
  const sig = signalAlign(watch, source.samples);
  if (sig) return { offsetSec: sig.offsetSec, method: 'signal', note: `Matched watch ${sig.signal} pattern (r = ${sig.corr.toFixed(2)}).` };
  return null;
}

/** how well current offset fits watch laps: median |lap − nearest change| (s) */
export function alignmentCheck(watch, source, offsetSec) {
  const laps = (watch.laps || []).slice(1).map(l => l.start);
  const ch = changePoints(source.samples).map(t => t + offsetSec * 1000);
  if (laps.length < 2 || ch.length < 2) return null;
  const d = [];
  for (const l of laps) { let b = Infinity; for (const c of ch) if (Math.abs(l - c) < Math.abs(b)) b = l - c; if (Math.abs(b) < 20000) d.push(b / 1000); }
  return d.length ? { matched: d.length, laps: laps.length, median: median(d) } : null;
}

// ---------------------------------------------------------------- sync
const CARRY = ['hr', 'cad', 'fcad', 'power', 'alt', 'vo', 'st', 'vr', 'sl', 'temp', 'msg', 'lagShifted'];

// ---------------------------------------------------------------- watch sensor delay
/** channels the watch may report late (heart rate is never shifted: its lag is real physiology) */
export const LAG_CHANNELS = [
  { key: 'cad', label: 'cadence', also: ['fcad'] },
  { key: 'st', label: 'stance time' },
  { key: 'vo', label: 'vertical oscillation' },
  { key: 'power', label: 'power' },
];

function makeValueAt(W) {
  const ts = W.map(r => r.t);
  return t => {
    let lo = 0, hi = ts.length - 1;
    if (t < ts[0]) return null;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= t) lo = m; else hi = m - 1; }
    return t - ts[lo] <= 2000 ? W[lo] : (lo + 1 < W.length && ts[lo + 1] - t <= 2000 ? W[lo + 1] : W[lo]);
  };
}

/** speed-ups of ≥ 2 km/h (instant or ramped over ≤ 15 s) that then hold ≥ 25 s; returns the moment each rise starts */
function upSteps(S) {
  const out = [];
  const rise = i => S[i].speed - S[i - 1].speed > 0.01;
  for (let i = 2; i < S.length; i++) {
    if (!rise(i) || rise(i - 1)) continue;
    let j = i;
    while (j + 1 < S.length && rise(j + 1) && S[j + 1].t - S[i].t <= 15000) j++;
    if ((S[j].speed - S[i - 1].speed) * 3.6 < 2) continue;
    const hold = S.slice(j, j + 26);
    if (hold.length >= 26 && hold.every(x => Math.abs(x.speed - S[j].speed) * 3.6 < 0.3) && hold[hold.length - 1].t - S[j].t <= 30000) out.push(S[i].t);
  }
  return out;
}

/** mean normalised step response of one channel after the speed rises → seconds to 50 % */
function responseT50(valueAt, steps, key) {
  const curves = [];
  for (const u of steps) {
    const win = (a, b) => { const v = []; for (let j = a; j <= b; j++) { const r = valueAt(u + j * 1000); if (r && r[key] > 0) v.push(r[key]); } return v; };
    const pre = mean(win(-25, -3)), post = mean(win(25, 45));
    if (pre == null || post == null || Math.abs(post - pre) < Math.max(1e-6, Math.abs(pre) * 0.02)) continue;
    const c = [];
    for (let j = -5; j <= 30; j++) { const r = valueAt(u + j * 1000); c.push(r && r[key] > 0 ? (r[key] - pre) / (post - pre) : null); }
    curves.push(c);
  }
  if (curves.length < 2) return null;
  const m = curves[0].map((_, j) => mean(curves.map(c => c[j]).filter(v => v != null)));
  for (let j = 0; j < m.length; j++) {
    // need the response to stay up, not a one-sample blip
    if (m[j] >= 0.5 && (m[j + 1] ?? 1) >= 0.4 && (m[j + 2] ?? 1) >= 0.4) return { t50: j - 5, n: curves.length };
  }
  return null;
}

/**
 * How late does the watch report each channel? The fastest-reacting channel (usually vertical
 * oscillation) marks when your stride really changed; slower channels are delayed by the difference.
 */
export function estimateSensorLags(W, S) {
  const steps = upSteps(S);
  if (steps.length < 2) return { lags: {}, steps: steps.length, reason: 'Not enough speed changes to measure the delay (needs 2+ clear speed-ups).' };
  const valueAt = makeValueAt(W);
  const t50 = {};
  for (const ch of LAG_CHANNELS) {
    if (W.filter(r => r[ch.key] > 0).length < W.length * 0.3) continue;
    const r = responseT50(valueAt, steps, ch.key);
    if (r) t50[ch.key] = r.t50;
  }
  const vals = Object.values(t50);
  if (!vals.length) return { lags: {}, steps: steps.length, reason: 'No cadence or running-dynamics data to check.' };
  const ref = vals.length > 1 ? Math.max(0, Math.min(...vals)) : 3; // ~3 s for the belt to get halfway to a new speed
  const lags = {};
  for (const [k, v] of Object.entries(t50)) { const lag = Math.round(v - ref); lags[k] = lag >= 2 ? Math.min(lag, 20) : 0; }
  return { lags, t50, ref, steps: steps.length };
}

export function syncRun({ watch, source, offsetSec = 0, minSpeedKmh = 3, targetKm = null, distMode = 'extend', recalcStep = true, trimStart = true, sensorLag = 'auto', lagSource = null }) {
  const W = watch.records;
  if (!W.length) throw new Error('The watch file has no data records.');
  if (!source.samples.length) throw new Error('The speed source has no speed data.');
  const minSp = minSpeedKmh / 3.6;
  const S = source.samples.map(s => ({ t: s.t + offsetSec * 1000, speed: s.speed }));
  const L = makeLookup(S, source.dt || 1000);
  const target = targetKm > 0 ? targetKm * 1000 : null;

  let tStart = W[0].t;
  let startInfo = null;
  if (trimStart) {
    startInfo = findIntendedStart(S, minSp);
    if (!startInfo) throw new Error(`The speed source never reaches ${minSpeedKmh} km/h.`);
    if (startInfo.t > tStart) tStart = startInfo.t;
  } else if (S[0].t > tStart) tStart = S[0].t;

  let li = S.length - 1;
  while (li > 0 && S[li].speed < minSp) li--;
  const srcEnd = Math.min(L.end, S[li].t + L.dt);
  const lastIntended = S[li].speed;

  const firstIdx = W.findIndex(r => r.t >= tStart);
  if (firstIdx < 0 || W[firstIdx].t >= srcEnd) throw new Error('The watch recording and the speed data don’t overlap — check the time alignment.');

  // watch sensor delay: measure (or take the given value) and read those channels that many seconds later
  let lagInfo = { lags: {}, mode: 'off' };
  if (sensorLag === 'auto') {
    // measure against the speed as commanded (before any belt-ramp model), shifted like the source
    const LS = lagSource ? lagSource.samples.map(x => ({ t: x.t + offsetSec * 1000, speed: x.speed })) : S;
    lagInfo = { ...estimateSensorLags(W, LS), mode: 'auto' };
  }
  else if (typeof sensorLag === 'number' && sensorLag > 0) lagInfo = { lags: { cad: sensorLag, st: sensorLag }, mode: 'manual' };
  const lagKeys = Object.entries(lagInfo.lags || {}).filter(([, v]) => v > 0);
  const valueAt = lagKeys.length ? makeValueAt(W) : null;

  const out = [];
  let d = 0, prev = null, held = 0;
  for (let i = firstIdx; i < W.length; i++) {
    const r = W[i];
    const inSrc = r.t < srcEnd;
    let v;
    if (inSrc) { v = L.speedAt(r.t); if (v == null) v = prev ? prev.speed : 0; }
    else {
      if (!(target && distMode === 'extend') || d >= target) break;
      v = lastIntended; held++;
    }
    if (prev) d += prev.inSrc && inSrc ? L.integ(prev.t, r.t) : prev.speed * (r.t - prev.t) / 1000;
    const o = { t: r.t, speed: v, dist: d, inSrc, held: !inSrc, synthetic: false, srcIndex: i };
    for (const k of CARRY) o[k] = r[k] ?? null;
    if (lagKeys.length) {
      for (const [k, lag] of lagKeys) {
        const later = valueAt(r.t + lag * 1000) || W[W.length - 1];
        o[k] = later[k] ?? null;
        if (k === 'cad') o.fcad = later.fcad ?? null;
      }
      o.lagShifted = true;
    }
    out.push(o);
    prev = o;
  }
  const lastReal = firstIdx + out.length - 1;
  const rawDist = out[out.length - 1].dist;
  let appended = 0, truncated = 0, scale = 1;

  if (target) {
    if (distMode === 'scale') {
      scale = rawDist > 0 ? target / rawDist : 1;
      for (const o of out) { o.speed *= scale; o.dist *= scale; }
      out[out.length - 1].dist = target;
    } else if (rawDist > target) {
      const k = out.findIndex(o => o.dist >= target);
      truncated = out.length - k - 1;
      out.length = k + 1;
      out[k].dist = target;
    } else if (rawDist < target) {
      const last = out[out.length - 1];
      let vFill = last.speed >= minSp ? last.speed : lastIntended;
      if (!(vFill > 0.5)) vFill = mean(out.slice(-60).map(o => o.speed).filter(v => v > 0.5)) || 2.5;
      const pool = out.slice(-120).filter(o => Math.abs(o.speed - vFill) < 0.15 && !o.synthetic);
      const tpl = pool.length ? pool.slice(-60) : out.slice(-30);
      let p = out[out.length - 1];
      let guard = 0;
      while (p.dist < target - 1e-6 && guard++ < 6 * 3600) {
        const t = p.t + 1000;
        let v = t < srcEnd ? L.speedAt(t) : null;
        if (v == null || v < minSp) v = vFill;
        const nd = Math.min(target, p.dist + p.speed * 1);
        const src = tpl[tpl.length - 1 - (appended % tpl.length)]; // mirror back from the last real second
        const o = { t, speed: v, dist: nd, inSrc: false, held: false, synthetic: true, srcIndex: null, copyOf: src.t };
        for (const k of CARRY) o[k] = src[k] ?? null;
        out.push(o); p = o; appended++;
      }
    }
  }

  if (recalcStep) {
    for (const o of out) {
      if (o.cad > 0 && o.speed > 0.3) {
        const spm = 2 * (o.cad + (o.fcad || 0));
        o.sl = (o.speed / (spm / 60)) * 1000;
        if (o.vo != null && o.vo > 0) o.vr = (o.vo / o.sl) * 100;
        o.slChanged = true;
      }
    }
  }

  return {
    records: out,
    info: {
      tStart, watchStart: W[0].t, watchEnd: W[W.length - 1].t,
      trimmedStartSec: (W[firstIdx].t - W[0].t) / 1000,
      sourceStartSkipSec: startInfo ? (startInfo.t - S[0].t) / 1000 : 0,
      startSpeed: startInfo ? startInfo.speed : null,
      droppedEnd: W.length - 1 - lastReal,
      held, appended, truncated, scale, rawDist, finalDist: out[out.length - 1].dist,
      sourceEndedEarly: srcEnd < W[W.length - 1].t,
      sensor: lagInfo,
    },
    opts: { offsetSec, minSpeedKmh, targetKm, distMode, recalcStep, sensorLag },
  };
}

/** the watch's own records as output (no external speed) — used for planning previews and fallback */
export function recordsFromSource(source) {
  const out = [];
  let d = 0;
  source.samples.forEach((s, i) => {
    if (i) d += source.samples[i - 1].speed * (s.t - source.samples[i - 1].t) / 1000;
    out.push({ t: s.t, speed: s.speed, dist: d });
  });
  return out;
}

// ---------------------------------------------------------------- segments
function rollingMedian(a, w) {
  const h = Math.floor(w / 2), out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = median(a.slice(Math.max(0, i - h), i + h + 1));
  return out;
}

export function detectSegments(recs, { tolKmh = 0.3, minSec = 10, smoothSec = 0 } = {}) {
  const n = recs.length;
  if (!n) return [];
  let sp = recs.map(r => r.speed * 3.6);
  if (smoothSec) sp = rollingMedian(sp, smoothSec);
  const cuts = [0];
  let ref = sp[0];
  for (let i = 1; i < n; i++) {
    if (Math.abs(sp[i] - ref) > tolKmh && [1, 2].every(k => i + k >= n || Math.abs(sp[i + k] - ref) > tolKmh)) { cuts.push(i); ref = sp[i]; }
  }
  const mk = (i0, i1) => {
    const t0 = recs[i0].t, end = i1 < n ? recs[i1] : recs[n - 1];
    const dur = (end.t - t0) / 1000, dist = end.dist - recs[i0].dist;
    return { i0, i1, t0, dur, dist, speed: dur > 0 ? dist / dur : recs[i0].speed };
  };
  let segs = cuts.map((c, k) => mk(c, k + 1 < cuts.length ? cuts[k + 1] : n));
  const merge = (a, b) => { segs.splice(a, 2, mk(segs[a].i0, segs[b].i1)); };
  for (let guard = 0; guard < 10000 && segs.length > 1; guard++) {
    const k = segs.findIndex(s => s.dur < minSec);
    if (k < 0) break;
    if (k < segs.length - 1) merge(k, k + 1); else merge(k - 1, k);
  }
  for (let k = 0; k < segs.length - 1;) {
    if (Math.abs(segs[k].speed - segs[k + 1].speed) * 3.6 <= tolKmh * 0.7) merge(k, k + 1); else k++;
  }
  return segs;
}

/** segments from given boundary times (e.g. the watch's own laps) — used when speed itself is unreliable */
export function segmentsFromLaps(recs, starts) {
  const n = recs.length;
  const idx = [...new Set(starts.map(t => recs.findIndex(r => r.t >= t)).filter(i => i >= 0 && i < n - 1))].sort((a, b) => a - b);
  if (idx[0] !== 0) idx.unshift(0);
  const segs = idx.map((i0, k) => {
    const i1 = k + 1 < idx.length ? idx[k + 1] : n, end = i1 < n ? recs[i1] : recs[n - 1];
    const dur = (end.t - recs[i0].t) / 1000, dist = end.dist - recs[i0].dist;
    return { i0, i1, t0: recs[i0].t, dur, dist, speed: dur > 0 ? dist / dur : 0 };
  }).filter(s => s.dur > 0);
  // merge neighbours with near-identical pace
  for (let k = 0; k < segs.length - 1;) {
    const a = segs[k], b = segs[k + 1];
    if (Math.abs(a.speed - b.speed) * 3.6 <= 0.3) segs.splice(k, 2, { i0: a.i0, i1: b.i1, t0: a.t0, dur: a.dur + b.dur, dist: a.dist + b.dist, speed: (a.dist + b.dist) / (a.dur + b.dur) });
    else k++;
  }
  return segs;
}

// ---------------------------------------------------------------- classification
const TYPE_NAMES = { warmup: 'Warm up', active: 'Run', rest: 'Recovery', cooldown: 'Cool down' };

export function classifyRun(segs) {
  const n = segs.length;
  const sp = segs.map(s => s.speed * 3.6), du = segs.map(s => s.dur);
  const total = sum(du);
  const g = (from, to, type, name) => ({ from, to, type, name });
  if (!n) return { type: 'empty', label: 'No data', groups: [] };
  const sig = sp.filter((_, i) => du[i] >= 60);
  const pool = sig.length ? sig : sp;
  const range = Math.max(...pool) - Math.min(...pool);
  const avgKmh = sum(segs.map(s => s.dist)) / total * 3.6;
  if (n === 1 || range < 0.6) {
    const long = total >= 90 * 60;
    return { type: long ? 'long' : 'easy', label: `${long ? 'Long run' : 'Easy / steady run'} · ${avgKmh.toFixed(1)} km/h`, groups: [], lapsBy: 'km' };
  }
  const D = 0.3;
  let peaks = [];
  for (let i = 0; i < n; i++) {
    const l = i === 0 ? -Infinity : sp[i - 1], r = i === n - 1 ? -Infinity : sp[i + 1];
    if (sp[i] > l + D && sp[i] > r + D) peaks.push(i);
  }
  const inner = peaks.filter(i => i > 0 && i < n - 1);
  if (inner.length) {
    const mS = median(inner.map(i => sp[i])), mD = median(inner.map(i => du[i]));
    peaks = peaks.filter(i => (i > 0 && i < n - 1) || (Math.abs(sp[i] - mS) <= Math.max(0.6, mS * 0.05) && du[i] <= mD * 2));
  }
  // expand peaks to multi-part reps
  let blocks = peaks.map(p => {
    let a = p, b = p;
    while (a - 1 >= 0 && sp[a - 1] >= sp[p] - 1.0 && du[a - 1] <= du[p] * 2 && !peaks.includes(a - 1)) a--;
    while (b + 1 < n && sp[b + 1] >= sp[p] - 1.0 && du[b + 1] <= du[p] * 2 && !peaks.includes(b + 1)) b++;
    return { from: a, to: b };
  });
  blocks = blocks.reduce((acc, bl) => {
    const last = acc[acc.length - 1];
    if (last && bl.from <= last.to + 1) last.to = Math.max(last.to, bl.to); else acc.push({ ...bl });
    return acc;
  }, []);
  const bDur = bl => sum(du.slice(bl.from, bl.to + 1));
  const bDist = bl => sum(segs.slice(bl.from, bl.to + 1).map(s => s.dist));

  if (blocks.length >= 2) {
    const groups = [];
    const first = blocks[0], last = blocks[blocks.length - 1];
    if (first.from > 0) groups.push(g(0, first.from - 1, 'warmup', 'Warm up'));
    const recs = [];
    for (let k = 0; k < blocks.length; k++) {
      groups.push(g(blocks[k].from, blocks[k].to, 'active', `Rep ${k + 1}`));
      if (k < blocks.length - 1) {
        const r = g(blocks[k].to + 1, blocks[k + 1].from - 1, 'rest', `Recovery ${k + 1}`);
        recs.push(r); groups.push(r);
      }
    }
    const rDur = r => sum(du.slice(r.from, r.to + 1));
    const rSp = r => sum(segs.slice(r.from, r.to + 1).map(s => s.dist)) / rDur(r) * 3.6;
    if (last.to < n - 1) {
      const t0 = last.to + 1;
      const recSp = median(recs.map(rSp)), recDu = median(recs.map(rDur));
      const looksRec = recs.length && Math.abs(sp[t0] - recSp) <= 0.8 && du[t0] <= recDu * 1.6 + 10;
      if (looksRec) {
        groups.push(g(t0, t0, 'rest', `Recovery ${blocks.length}`));
        recs.push(groups[groups.length - 1]);
        if (t0 < n - 1) groups.push(g(t0 + 1, n - 1, 'cooldown', 'Cool down'));
      } else groups.push(g(t0, n - 1, 'cooldown', 'Cool down'));
    }
    const wd = blocks.map(bDur), wdist = blocks.map(bDist), wsp = blocks.map(b => bDist(b) / bDur(b));
    const rd = recs.map(rDur);
    const mW = median(wd), mR = rd.length ? median(rd) : 0;
    let type = 'intervals', label;
    const nRep = blocks.length;
    const recTxt = rd.length ? ` / ${fmtDur(mR)} rec` : '';
    const paceTxt = ` @ ${fmtPace(median(wsp))}/km`;
    if (cv(wd) <= 0.12) label = `Intervals · ${nRep} × ${fmtDur(mW)}${paceTxt}${recTxt}`;
    else if (cv(wdist) <= 0.06) label = `Intervals · ${nRep} × ${fmtDistShort(median(wdist))}${paceTxt}${recTxt}`;
    else {
      const up = wd.findIndex((x, i) => i && x < wd[i - 1]);
      const isPyr = nRep >= 4 && up >= 2 && wd.slice(0, up).every((x, i, a) => !i || x > a[i - 1]) && wd.slice(up).every((x, i, a) => !i || x <= a[i - 1] + 5);
      if (isPyr) { type = 'pyramid'; label = `Pyramid · ${wd.map(x => fmtDur(x)).join(' – ')}`; }
      else { type = 'fartlek'; label = `Fartlek · ${nRep} surges (${fmtDur(Math.min(...wd))}–${fmtDur(Math.max(...wd))})`; }
    }
    return { type, label, groups, reps: nRep };
  }

  // progression: longest run of rising segments (each ≥ 60 s)
  let best = { a: 0, b: 0 };
  for (let a = 0; a < n; a++) {
    let b = a;
    while (b + 1 < n && sp[b + 1] > sp[b] + D && du[b + 1] >= 60) b++;
    if (b - a > best.b - best.a) best = { a, b };
  }
  if (best.b - best.a + 1 >= 3) {
    const groups = [];
    if (best.a > 0) groups.push(g(0, best.a - 1, 'warmup', 'Warm up'));
    for (let i = best.a, k = 1; i <= best.b; i++, k++) groups.push(g(i, i, 'active', `Stage ${k}`));
    if (best.b < n - 1) groups.push(g(best.b + 1, n - 1, 'cooldown', 'Cool down'));
    return { type: 'progression', label: `Progression · ${sp[best.a].toFixed(1)} → ${sp[best.b].toFixed(1)} km/h (${best.b - best.a + 1} stages)`, groups };
  }

  if (blocks.length === 1 && bDur(blocks[0]) >= 300) {
    const bl = blocks[0], groups = [];
    if (bl.from > 0) groups.push(g(0, bl.from - 1, 'warmup', 'Warm up'));
    groups.push(g(bl.from, bl.to, 'active', 'Tempo'));
    if (bl.to < n - 1) groups.push(g(bl.to + 1, n - 1, 'cooldown', 'Cool down'));
    return { type: 'tempo', label: `Tempo · ${fmtDur(bDur(bl))} @ ${fmtPace(bDist(bl) / bDur(bl))}/km`, groups };
  }

  return { type: 'mixed', label: `Mixed pace · ${n} segments`, groups: segs.map((s, i) => g(i, i, 'active', `Segment ${i + 1}`)) };
}

function fmtDistShort(m) { return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 < 5 || m % 1000 > 995 ? 0 : 1)} km` : `${Math.round(m / 10) * 10} m`; }

/** detection → lap boundaries */
export function detectRun(records, { sourceKind = 'file', lapStarts = null } = {}) {
  let segs;
  if (sourceKind === 'watch' && lapStarts && lapStarts.length >= 2) segs = segmentsFromLaps(records, lapStarts);
  else segs = detectSegments(records, sourceKind === 'watch' ? { tolKmh: 0.6, minSec: 45, smoothSec: 31 } : { tolKmh: 0.3, minSec: 10 });
  const cls = classifyRun(segs);
  const bounds = cls.groups.map(gr => ({ t: segs[gr.from].t0, type: gr.type, name: gr.name }));
  return { ...cls, segments: segs, bounds };
}

// ---------------------------------------------------------------- laps
export function kmBounds(records, stepKm = 1) {
  const step = stepKm * 1000;
  const b = [{ t: records[0].t, type: 'active', name: `Km 1`, trigger: 'distance' }];
  let k = 1;
  for (let i = 1; i < records.length; i++) {
    if (records[i].dist >= k * step - 1e-6 && i < records.length - 1) {
      k++;
      b.push({ t: records[i].t, type: 'active', name: stepKm === 1 ? `Km ${k}` : `Split ${k}`, trigger: 'distance' });
    }
  }
  if (stepKm !== 1) b[0].name = 'Split 1';
  return b;
}

export function buildLaps(records, bounds, { calories = null } = {}) {
  const n = records.length;
  if (!n) return [];
  const bs = [...bounds].sort((a, b) => a.t - b.t);
  if (!bs.length || bs[0].t > records[0].t) bs.unshift({ t: records[0].t, type: bs[0]?.type || 'active', name: bs[0]?.name || 'Lap 1' });
  const idxOf = t => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (records[m].t < t) lo = m + 1; else hi = m; } return lo; };
  const raw = bs.map(b => ({ ...b, i0: Math.min(idxOf(b.t), n - 1) }));
  raw[0].i0 = 0;
  const laps = [];
  for (const b of raw) {
    if (laps.length && (b.i0 <= laps[laps.length - 1].i0 || b.i0 >= n - 1)) continue;
    laps.push(b);
  }
  laps.forEach((l, k) => { l.i1 = k + 1 < laps.length ? laps[k + 1].i0 : n; });
  const out = laps.map(l => lapStats(records, l.i0, l.i1, l));
  // calories split by HR-weighted time
  if (calories != null) {
    const w = out.map(l => (l.avgHr || 1) * l.duration);
    const tw = sum(w) || 1;
    let acc = 0;
    out.forEach((l, k) => { const c = k === out.length - 1 ? calories - acc : Math.round(calories * w[k] / tw); l.calories = Math.max(0, c); acc += l.calories; });
  }
  return out;
}

export function lapStats(records, i0, i1, meta = {}) {
  const n = records.length;
  const a = records[i0], end = i1 < n ? records[i1] : records[n - 1];
  const duration = Math.max(0, (end.t - a.t) / 1000);
  const distance = end.dist - a.dist;
  const slice = records.slice(i0, i1);
  const vals = k => slice.map(r => r[k]).filter(v => v != null && v > 0);
  const hr = vals('hr'), cad = vals('cad'), spd = slice.map(r => r.speed);
  let strides = 0;
  for (let i = i0; i < i1; i++) {
    const r = records[i], dt = i + 1 < n ? (records[i + 1].t - r.t) / 1000 : 1;
    if (r.cad > 0) strides += (r.cad + (r.fcad || 0)) * Math.min(dt, 5) / 60;
  }
  const avgCadFull = mean(slice.filter(r => r.cad > 0).map(r => r.cad + (r.fcad || 0)));
  return {
    name: meta.name || '', type: meta.type || 'active', trigger: meta.trigger || 'manual',
    i0, i1, start: a.t, end: end.t, duration, distance,
    avgSpeed: duration > 0 ? distance / duration : 0,
    maxSpeed: spd.length ? Math.max(...spd) : 0,
    avgHr: hr.length ? Math.round(mean(hr)) : null,
    maxHr: hr.length ? Math.max(...hr) : null,
    minHr: hr.length ? Math.min(...hr) : null,
    avgCad: avgCadFull, maxCad: cad.length ? Math.max(...cad) : null,
    avgVo: mean(vals('vo')), avgSt: mean(vals('st')), avgVr: mean(vals('vr')), avgSl: mean(vals('sl')),
    avgPower: mean(vals('power')),
    strides: Math.round(strides),
    calories: null,
  };
}

export function summarize(records, calories = null) {
  if (!records.length) return null;
  const s = lapStats(records, 0, records.length, { name: 'Total' });
  s.calories = calories;
  return s;
}

/** turn detection result into an editable plan */
export function planFromDetection(det) {
  const segs = det.segments || [];
  if (!det.groups?.length) {
    const s = segs.length ? sum(segs.map(x => x.dist)) / sum(segs.map(x => x.dur)) : 2.8;
    return { name: det.label?.split(' · ')[0] || 'Run', items: [{ kind: 'step', type: 'active', durType: 'open', dur: Math.round(sum(segs.map(x => x.dur))), dist: 1000, kmh: +(s * 3.6).toFixed(1) }] };
  }
  const grp = det.groups.map(gr => {
    const ss = segs.slice(gr.from, gr.to + 1);
    const dur = sum(ss.map(x => x.dur)), dist = sum(ss.map(x => x.dist));
    return { type: gr.type, name: gr.name, dur: Math.round(dur), kmh: +(dist / dur * 3.6).toFixed(1) };
  });
  const items = [];
  let i = 0;
  const step = (x, open = false) => ({ kind: 'step', type: x.type, durType: open ? 'open' : 'time', dur: x.dur, dist: 1000, kmh: x.kmh });
  while (i < grp.length) {
    if (grp[i].type === 'active' && grp[i + 1]?.type === 'rest') {
      let k = i, count = 0;
      while (grp[k]?.type === 'active' && grp[k + 1]?.type === 'rest') { count++; k += 2; }
      const w = grp.filter((_, j) => j >= i && j < k && (j - i) % 2 === 0), r = grp.filter((_, j) => j >= i && j < k && (j - i) % 2 === 1);
      if (count >= 2) {
        items.push({ kind: 'repeat', count, steps: [step({ type: 'active', dur: Math.round(median(w.map(x => x.dur))), kmh: median(w.map(x => x.kmh)) }), step({ type: 'rest', dur: Math.round(median(r.map(x => x.dur))), kmh: median(r.map(x => x.kmh)) })] });
        i = k; continue;
      }
    }
    items.push(step(grp[i], i === grp.length - 1 && grp[i].type === 'cooldown'));
    i++;
  }
  return { name: det.label?.split(' · ')[0] || 'Detected run', items };
}

export { TYPE_NAMES };

// ---------------------------------------------------------------- treadmill belt ramp
/** QZ logs the speed it sets; the belt takes time to get there. Limit changes to `rate` km/h per second. */
export function rampSource(source, rateKmhPerSec) {
  if (!(rateKmhPerSec > 0)) return source;
  const r = rateKmhPerSec / 3.6;
  const out = [];
  let v = null;
  for (const s of source.samples) {
    if (v == null) v = s.speed;
    else {
      const dt = (s.t - out[out.length - 1].t) / 1000;
      const max = r * Math.max(dt, 0.2);
      v = s.speed > v ? Math.min(s.speed, v + max) : Math.max(s.speed, v - max);
    }
    out.push({ t: s.t, speed: v });
  }
  return { ...source, samples: out, ramp: rateKmhPerSec };
}

// ---------------------------------------------------------------- re-analysis
/**
 * Check an (edited) lap layout against the synced data: workout type from the laps themselves,
 * lap boundaries vs treadmill speed changes, laps mixing two speeds, consistency per kind, sensor sync.
 */
export function analyzeWorkout(records, laps, { target = null, sensor = null } = {}) {
  const n = records.length;
  // speed changes (≥ 0.5 km/h) in the synced speed
  const ch = [];
  for (let i = 1; i < n; i++) if (Math.abs(records[i].speed - records[i - 1].speed) * 3.6 >= 0.5) {
    if (!ch.length || records[i].t - ch[ch.length - 1].t > 5000) ch.push({ t: records[i].t, i, from: records[i - 1].speed, to: records[i].speed });
    else ch[ch.length - 1] = { ...ch[ch.length - 1], to: records[i].speed }; // ramp: same change
  }
  const big = ch.filter(c => Math.abs(c.to - c.from) * 3.6 >= 1);
  // lap boundaries vs changes
  const boundaries = laps.slice(1).map((l, k) => {
    let best = null;
    for (const c of big) if (best == null || Math.abs(c.t - l.start) < Math.abs(best.t - l.start)) best = c;
    const off = best ? (l.start - best.t) / 1000 : null;
    return { lap: k + 1, name: l.name, t: l.start, off: best && Math.abs(off) <= 30 ? off : null };
  });
  const onChange = boundaries.filter(b => b.off != null && Math.abs(b.off) <= 1).length;
  const nearChange = boundaries.filter(b => b.off != null && Math.abs(b.off) > 1 && Math.abs(b.off) <= 15);
  const noChange = boundaries.filter(b => b.off == null || Math.abs(b.off) > 15);
  // speed changes that fall inside a lap (not near its edges)
  const inside = big.filter(c => laps.every(l => Math.abs(l.start - c.t) > 15000) && c.t > records[0].t + 15000)
    .map(c => ({ ...c, lap: laps.findIndex(l => c.t >= l.start && c.t < (l.end || Infinity)) }));
  // laps mixing speeds: share of time away from the lap's main speed
  const mixed = [];
  for (const [k, l] of laps.entries()) {
    const cnt = new Map();
    for (let i = l.i0; i < l.i1; i++) { const key = Math.round(records[i].speed * 36) / 10; cnt.set(key, (cnt.get(key) || 0) + 1); }
    const total = l.i1 - l.i0; let main = null, mc = 0;
    for (const [sp, c] of cnt) if (c > mc) { main = sp; mc = c; }
    const away = total - mc;
    // ignore steady laps that simply contain slow drift (km splits of a progression etc.)
    const spread = Math.max(...cnt.keys()) - Math.min(...cnt.keys());
    if (away >= 2 && spread >= 1 && away / total < 0.5) mixed.push({ lap: k, name: l.name, away, main });
  }
  // consistency per lap kind
  const kinds = {};
  for (const [k, l] of laps.entries()) {
    if (k === laps.length - 1 && laps.length > 1) continue;
    (kinds[l.type] ||= []).push(l);
  }
  const consistency = Object.entries(kinds).filter(([, ls]) => ls.length > 1).map(([type, ls]) => ({
    type, count: ls.length,
    dur: [Math.min(...ls.map(l => l.duration)), Math.max(...ls.map(l => l.duration))],
    dist: [Math.min(...ls.map(l => l.distance)), Math.max(...ls.map(l => l.distance))],
    pace: [Math.max(...ls.map(l => l.avgSpeed)), Math.min(...ls.map(l => l.avgSpeed))],
  }));
  // workout type from the laps as they now are
  const segs = laps.map(l => ({ i0: l.i0, i1: l.i1, t0: l.start, dur: l.duration, dist: l.distance, speed: l.avgSpeed }));
  const cls = classifyRun(segs);
  // cadence vs speed sync check after any delay correction
  let cadence = null;
  if (records.filter(r => r.cad > 0).length > n * 0.5) {
    const S = records.map(r => ({ t: r.t, speed: r.speed }));
    const steps = upSteps(S);
    const r = steps.length >= 2 ? responseT50(makeValueAt(records), steps, 'cad') : null;
    const v = steps.length >= 2 ? responseT50(makeValueAt(records), steps, 'vo') : null;
    cadence = { t50: r?.t50 ?? null, voT50: v?.t50 ?? null, steps: steps.length };
  }
  // step length that can't be right (usually the seconds around a speed change)
  let badSteps = null;
  if (records.some(r => r.sl > 0)) badSteps = records.filter(r => r.sl > 0 && r.cad > 0 && r.speed > 1.2 && (r.sl < 450 || r.sl > 1700)).length;
  const total = records[n - 1].dist;
  const issues = nearChange.length + noChange.filter(b => big.length).length + inside.length + mixed.length;
  return {
    label: cls.label, type: cls.type,
    boundaries, onChange, nearChange, noChange, inside, mixed, consistency, cadence,
    changes: big.length, distance: total, target, sensor, badSteps,
    distanceOk: target ? Math.abs(total - target) < 0.5 : null,
    issues,
  };
}
