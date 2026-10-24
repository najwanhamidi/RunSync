// Sensor-delay estimation and distance editing on synthetic data (node test/sync.test.js)
import assert from 'node:assert/strict';
import { syncRun, estimateSensorLags, rampSource, analyzeWorkout, buildLaps, detectRun } from '../js/engine.js';
import { relayoutDist, lapDistances, setGroupDistances, parseDistInput } from '../js/laps.js';

// 12' at 10.8, then 6 × (3' 14.7 / 1' 5.7), then 5' at 10.8 — the watch reports cadence 6 s late, VO on time
const t0 = Date.UTC(2026, 9, 1, 6, 0, 0);
const plan = [[720, 10.8]];
for (let i = 0; i < 6; i++) plan.push([180, 14.7], [60, 5.7]);
plan.push([300, 10.8]);
const speedAt = [];
for (const [d, k] of plan) for (let i = 0; i < d; i++) speedAt.push(k / 3.6);
const N = speedAt.length;
const cadFor = v => (v > 3.5 ? 95 : v > 2.5 ? 88 : 66);
const S = speedAt.map((v, i) => ({ t: t0 + i * 1000, speed: v }));
const W = speedAt.map((v, i) => ({
  t: t0 + i * 1000, hr: 140, speed: v * 0.9, dist: null,
  cad: cadFor(speedAt[Math.max(0, i - 6 - 2)]), // 2 s body reaction + 6 s watch delay
  vo: v > 3.5 ? 90 : v > 2.5 ? 82 : 60 + (i % 2), st: 230,
}));
W.forEach((r, i) => { r.vo = speedAt[Math.max(0, i - 2)] > 3.5 ? 90 : speedAt[Math.max(0, i - 2)] > 2.5 ? 82 : 60; });
const lag = estimateSensorLags(W, S);
assert.equal(lag.lags.cad, 6, `cadence delay ${JSON.stringify(lag)}`);
assert.equal(lag.lags.vo, 0);

const watch = { records: W, laps: [] };
const res = syncRun({ watch, source: { samples: S, dt: 1000 }, targetKm: null });
assert.equal(res.info.sensor.lags.cad, 6);
// at a rep start + 3 s the corrected cadence is already the rep cadence
const repStart = 720;
assert.equal(res.records[repStart + 3].cad, 95);
assert.ok(res.records[repStart + 3].lagShifted);
// heart rate untouched
assert.ok(res.records.every(r => r.hr === 140));
// ramp keeps lag measurable
const resR = syncRun({ watch, source: rampSource({ samples: S, dt: 1000 }, 1), lagSource: { samples: S, dt: 1000 } });
assert.equal(resR.info.sensor.lags.cad, 6);
assert.ok(Math.abs(resR.records[repStart + 2].speed * 3.6 - 13.8) < 0.01, 'ramps 1 km/h each second (3 steps by +2 s)');

// distance editing: all reps 0.75 km, recoveries 100 m
const recs = res.records;
const det = detectRun(recs);
const nb = setGroupDistances(det.bounds, recs, { active: 750, rest: 100 });
const ld = lapDistances(nb, recs);
nb.forEach((b, k) => {
  if (k === nb.length - 1) return;
  if (b.type === 'active') assert.ok(Math.abs(ld[k] - 750) <= 2.1, `rep ${ld[k]}`);
  if (b.type === 'rest') assert.ok(Math.abs(ld[k] - 100) <= 2.1, `rec ${ld[k]}`);
});
assert.equal(parseDistInput('0.75'), 750); assert.equal(parseDistInput('730 m'), 730); assert.equal(parseDistInput('730'), 730); assert.equal(parseDistInput('1.2 km'), 1200);

// re-analysis of the detected layout: clean
const laps = buildLaps(recs, det.bounds);
const a = analyzeWorkout(recs, laps, {});
assert.equal(a.onChange, a.boundaries.length);
assert.equal(a.inside.length, 0);
assert.equal(a.mixed.length, 0);
assert.match(a.label, /Intervals · 6 × 3:00/);
assert.equal(a.cadence.t50 <= 3, true);
// after moving reps to 750 m the check notices boundaries leaving the speed changes
const a2 = analyzeWorkout(recs, buildLaps(recs, nb), {});
assert.ok(a2.inside.length > 0 && a2.onChange < a2.boundaries.length);
console.log('sync.test: all good', JSON.stringify(lag.lags));
