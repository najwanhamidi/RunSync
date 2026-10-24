// Set-wide lap editing checks (node test/laps.test.js)
import assert from 'node:assert/strict';
import { TEMPLATES, planRecords } from '../js/plan.js';
import { detectRun, buildLaps } from '../js/engine.js';
import { durations, lapGroups, setGroupDuration, setGroupName, setGroupType, intervalShape, setRepCount, shiftSet, snapToChanges } from '../js/laps.js';

const { recs } = planRecords(TEMPLATES[0]); // 12' WU + 10 × 3'/1' + CD
const end = recs.at(-1).t;
const det = detectRun(recs);
let b = det.bounds;
const g = lapGroups(b, end);
assert.deepEqual(g.map(x => [x.type, x.count, x.dur]), [['warmup', 1, 720], ['active', 10, 180], ['rest', 10, 60], ['cooldown', 1, 600]]);
assert.equal(g.find(x => x.type === 'active').pattern, 'Rep #');

// all reps to 2:30 → everything after shifts, cool down absorbs
let nb = setGroupDuration(b, end, 'active', 150);
let d = durations(nb, end);
assert.equal(nb.length, 22);
assert.ok(nb.filter(x => x.type === 'active').every((x, i) => d[nb.indexOf(x)] === 150));
assert.equal(d[0], 720);
assert.equal(d.at(-1), 600 + 10 * 30);

// recoveries 1:30
nb = setGroupDuration(b, end, 'rest', 90);
d = durations(nb, end);
assert.ok(nb.every((x, k) => x.type !== 'rest' || d[k] === 90));
assert.equal(d.at(-1), 600 - 300);

// rename + retype
nb = setGroupName(b, 'active', 'Interval #');
assert.equal(nb[1].name, 'Interval 1'); assert.equal(nb[19].name, 'Interval 10');
nb = setGroupType(b, 'rest', 'active');
assert.equal(lapGroups(nb, end).find(x => x.type === 'active').count, 20);

// rep count 10 → 8 and 12
const sh = intervalShape(b);
assert.equal(sh.reps.length, 10); assert.ok(sh.recAfterLast);
nb = setRepCount(b, end, 8);
assert.equal(intervalShape(nb).reps.length, 8);
assert.equal(durations(nb, end).at(-1), 600 + 2 * 240);
nb = setRepCount(b, end, 12);
assert.equal(intervalShape(nb).reps.length, 12);
assert.equal(durations(nb, end).at(-1), 600 - 2 * 240);

// shift + snap back
nb = shiftSet(b, end, 3);
assert.equal(nb[1].t - b[1].t, 3000);
const sn = snapToChanges(nb, recs);
assert.equal(sn.moved, 21);
assert.deepEqual(sn.bounds.map(x => x.t), b.map(x => x.t));

// too long → laps dropped, never past the end
nb = setGroupDuration(b, end, 'active', 600);
assert.ok(nb.at(-1).t < end);
const laps = buildLaps(recs, nb);
assert.equal(laps.at(-1).end, end);
console.log('laps.test: all good');

// jittered detection (2:59 / 1:01 / 3:01 / 0:59) → exact 3:00 / 1:00 everywhere, laps shift to follow
{
  const { setGroupDurations, groupRange } = await import('../js/laps.js');
  const jit = [0, -1, 1, 0, 1, -1, 0, 1, -1, 0];
  const t0 = 1e12, wu = 720;
  const jb = [{ t: t0, type: 'warmup', name: 'Warm up' }];
  let t = t0 + wu * 1000;
  for (let i = 0; i < 10; i++) {
    jb.push({ t, type: 'active', name: `Rep ${i + 1}` }); t += (180 + jit[i]) * 1000;
    jb.push({ t, type: 'rest', name: `Recovery ${i + 1}` }); t += (60 - jit[i]) * 1000;
  }
  jb.push({ t, type: 'cooldown', name: 'Cool down' });
  const jEnd = t + 600e3;
  assert.deepEqual(groupRange(jb, jEnd, 'active'), [179, 181]);
  const ex = setGroupDurations(jb, jEnd, { warmup: 720, active: 180, rest: 60 });
  const dd = durations(ex, jEnd);
  ex.forEach((b, k) => { if (b.type === 'active') assert.equal(dd[k], 180); if (b.type === 'rest') assert.equal(dd[k], 60); });
  ex.filter(b => b.type === 'active').forEach((b, i) => assert.equal(b.t, t0 + (720 + i * 240) * 1000));
  assert.equal(dd.at(-1), 600);
  // one box at a time gives the same result
  const one = setGroupDuration(setGroupDuration(jb, jEnd, 'active', 180), jEnd, 'rest', 60);
  assert.deepEqual(one.map(b => b.t), ex.map(b => b.t));
  console.log('laps.test: jitter → exact OK');
}
