// RunSync — workout planner model (steps + repeat blocks), templates and flattening.

let _id = 1;
export const uid = () => `i${Date.now().toString(36)}${(_id++).toString(36)}`;

export const STEP_TYPES = [
  { id: 'warmup', label: 'Warm up' },
  { id: 'active', label: 'Run / Interval' },
  { id: 'rest', label: 'Recovery' },
  { id: 'cooldown', label: 'Cool down' },
];
export const typeLabel = t => STEP_TYPES.find(x => x.id === t)?.label || 'Run';

export function step(type, durSec, kmh, durType = 'time', dist = 1000) {
  return { id: uid(), kind: 'step', type, durType, dur: durSec, dist, kmh };
}
export function repeat(count, steps) { return { id: uid(), kind: 'repeat', count, steps }; }

export function withIds(plan) {
  const fix = it => (it.kind === 'repeat' ? { ...it, id: it.id || uid(), steps: it.steps.map(fix) } : { ...it, id: it.id || uid() });
  return { ...plan, items: (plan.items || []).map(fix) };
}

export const TEMPLATES = [
  { name: '12′ WU · 10 × 3′ / 1′ · CD', items: [step('warmup', 720, 10.8), repeat(10, [step('active', 180, 14.7), step('rest', 60, 5.7)]), step('cooldown', 600, 10.8, 'open')] },
  { name: '13′ WU · 5 × 6′ / 1.5′ · CD', items: [step('warmup', 780, 10.8), repeat(5, [step('active', 360, 13.8), step('rest', 90, 5.7)]), step('cooldown', 600, 10.8, 'open')] },
  { name: '14′ WU · 3 × 10′ / 2′ · CD', items: [step('warmup', 840, 10.8), repeat(3, [step('active', 600, 13.2), step('rest', 120, 5.7)]), step('cooldown', 600, 10.8, 'open')] },
  { name: 'Easy run 45′', items: [step('active', 2700, 10.5)] },
  { name: 'Progression 4 × 10′', items: [step('active', 600, 10.5), step('active', 600, 11.5), step('active', 600, 12.5), step('active', 600, 13.5), step('cooldown', 300, 10.0, 'open')] },
  { name: 'Tempo 20′', items: [step('warmup', 600, 10.5), step('active', 1200, 13.0), step('cooldown', 600, 10.0, 'open')] },
  { name: '6 × 1 km / 2′', items: [step('warmup', 900, 10.8), repeat(6, [step('active', 0, 15.0, 'distance', 1000), step('rest', 120, 6.0)]), step('cooldown', 600, 10.5, 'open')] },
];

export const clonePlan = p => withIds(JSON.parse(JSON.stringify(p)));

/** duration of a step in seconds (distance steps derived from speed) */
export function stepDur(s) {
  if (s.durType === 'distance') return s.kmh > 0 ? s.dist / (s.kmh / 3.6) : 0;
  return s.dur || 0;
}

/** flatten → [{type, name, dur, open, speed(m/s), kmh, path}] */
export function flattenPlan(plan) {
  const out = [];
  const counters = {};
  const nameFor = (type, inRepeat) => {
    counters[type] = (counters[type] || 0) + 1;
    if (type === 'active' && inRepeat) return `Rep ${counters[type]}`;
    if (type === 'rest') return `Recovery ${counters[type]}`;
    if (type === 'active') return `Run ${counters[type]}`;
    return typeLabel(type);
  };
  for (const it of plan.items) {
    if (it.kind === 'repeat') {
      for (let c = 0; c < Math.max(0, it.count | 0); c++) {
        for (const s of it.steps) out.push({ type: s.type, name: nameFor(s.type, true), dur: stepDur(s), open: false, speed: s.kmh / 3.6, kmh: s.kmh, ref: s.id });
      }
    } else {
      out.push({ type: it.type, name: nameFor(it.type, false), dur: stepDur(it), open: it.durType === 'open', speed: it.kmh / 3.6, kmh: it.kmh, ref: it.id });
    }
  }
  return out;
}

/** virtual 1 Hz records for a plan (planning view) */
export function planRecords(plan, startMs = Date.UTC(2026, 0, 1, 6, 0, 0)) {
  const segs = flattenPlan(plan);
  const recs = [];
  const bounds = [];
  let t = startMs, d = 0;
  for (const s of segs) {
    const dur = Math.max(0, Math.round(s.dur));
    if (!dur) continue;
    bounds.push({ t, type: s.type, name: s.name });
    for (let k = 0; k < dur; k++) {
      recs.push({ t, speed: s.speed, dist: d });
      d += s.speed;
      t += 1000;
    }
  }
  if (recs.length) recs.push({ t, speed: recs[recs.length - 1].speed, dist: d });
  return { recs, bounds, segs };
}
