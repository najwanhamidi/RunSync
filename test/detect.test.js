// Detection sanity checks on synthetic speed profiles (node test/detect.test.js)
import { TEMPLATES, planRecords, step, repeat } from '../js/plan.js';
import { detectRun } from '../js/engine.js';
const cases = [
  ...TEMPLATES.map(t => [t.name, t]),
  ['pyramid', { items: [step('warmup', 600, 10), step('active', 60, 15), step('rest', 60, 6), step('active', 120, 15), step('rest', 60, 6), step('active', 180, 15), step('rest', 60, 6), step('active', 120, 15), step('rest', 60, 6), step('active', 60, 15), step('cooldown', 400, 10)] }],
  ['fartlek', { items: [step('active', 600, 10), step('active', 45, 14), step('active', 200, 10), step('active', 150, 13.5), step('active', 300, 10), step('active', 30, 15), step('active', 400, 10)] }],
  ['2-part reps', { items: [step('warmup', 600, 10), repeat(3, [step('active', 120, 14), step('active', 120, 14.6), step('rest', 90, 6)]), step('cooldown', 300, 10)] }],
  ['no CD intervals', { items: [step('warmup', 600, 10.8), repeat(4, [step('active', 240, 14.5), step('rest', 60, 5.5)])] }],
  ['steady w drift', { items: [step('active', 1800, 11.0), step('active', 1800, 11.3)] }],
];
let fail = 0;
for (const [name, plan] of cases) {
  const { recs } = planRecords(plan);
  const d = detectRun(recs);
  console.log(name.padEnd(28), '→', d.type.padEnd(12), d.label, '| laps:', d.bounds.map(b => b.name).join(', ').slice(0, 120));
}
