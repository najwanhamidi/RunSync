// RunSync — UI
import { readActivityFile, toTCX, toGPX, toCSV, lapsToCSV, parseClock } from './formats.js';
import {
  sourceFromActivity, sourceFromSegments, autoAlign, alignBySignals, alignmentCheck, syncRun, detectRun,
  buildLaps, kmBounds, summarize, planFromDetection, fmtDur, fmtPace,
} from './engine.js';
import { buildFit, DEVICES, resolveDevice } from './export.js';
import { TEMPLATES, STEP_TYPES, clonePlan, flattenPlan, planRecords, step, repeat, uid, withIds, stepDur, typeLabel } from './plan.js';
import { lapGroups, setGroupDuration, setGroupDurations, groupRange, setGroupName, setGroupType, intervalShape, setRepCount, shiftSet, snapToChanges, durations } from './laps.js';

export const VERSION = '3.0';
const DESK = document.body.dataset.layout === 'desktop';

// ------------------------------------------------------------------ utils
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('runsync.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('runsync.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const km = m => (Math.round(m / 10 + 1e-6) / 100).toFixed(2);
const kmh = v => (v * 3.6).toFixed(1);
const spm = c => (c ? Math.round(c * 2) : '–');
const fmtClock = t => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const parseDurInput = str => {
  str = String(str || '').trim().replace(',', '.');
  if (!str) return NaN;
  if (str.includes(':')) return parseClock(str);
  const n = parseFloat(str);
  return Number.isFinite(n) ? Math.round(n * 60) : NaN;
};
const parsePace = str => parseDurInput(str); // "4:05" or "4.1" (minutes)

const ICON = {
  watch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6l1-4h4l1 4M9 18l1 4h4l1-4M12 9.5V12l1.5 1.5"/></svg>',
  tread: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18h15a3 3 0 0 0 0-6H8"/><path d="M8 12 14 4h3"/><circle cx="6" cy="18" r="1"/><circle cx="18" cy="15" r="1"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  rep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4"/></svg>',
  merge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v6l4 4 4-4V4M12 14v6"/></svg>',
};

// ------------------------------------------------------------------ state
const settings = Object.assign({ minSpeed: 3, distMode: 'extend', recalc: true, device: 'trex3', lapKm: 1 }, store.get('settings', {}));
const S = {
  tab: 'sync',
  watch: null, watchErr: null,
  qz: null, qzErr: null,
  srcMode: 'file',
  align: null, offset: 0, planOffset: 0, alignZoom: 'start',
  targetKm: '',
  lapMode: 'auto', custom: null, editing: false, view: 'laps',
  fileBase: '',
  result: null, error: null,
  plan: store.get('plan', null) ? withIds(store.get('plan')) : clonePlan(TEMPLATES[0]),
  saved: store.get('saved', []),
  planView: 'laps',
};
const saveSettings = () => store.set('settings', settings);
const savePlan = () => store.set('plan', S.plan);

// ------------------------------------------------------------------ compute
function currentSource() {
  if (!S.watch) return null;
  const W = S.watch.records;
  if (S.srcMode === 'file') {
    if (!S.qz) return null;
    const src = sourceFromActivity(S.qz, S.qz.name);
    if (S.qz.relativeTime) src.samples = src.samples.map(s => ({ t: s.t + W[0].t, speed: s.speed }));
    return src;
  }
  if (S.srcMode === 'plan') return sourceFromSegments(flattenPlan(S.plan), W[0].t + S.planOffset * 1000, W[W.length - 1].t + 1000, 'Manual plan');
  return sourceFromActivity(S.watch, 'Watch pace');
}

function compute() {
  S.result = null; S.error = null;
  if (!S.watch) return;
  const source = currentSource();
  if (!source) return;
  const target = parseFloat(String(S.targetKm).replace(',', '.'));
  if (S.srcMode === 'watch' && !(target > 0)) { S.error = 'Enter the actual distance — watch-only mode scales the watch’s own pace to match it.'; return; }
  try {
    const res = syncRun({
      watch: S.watch, source,
      offsetSec: S.srcMode === 'file' ? S.offset : 0,
      minSpeedKmh: settings.minSpeed,
      targetKm: target > 0 ? target : null,
      distMode: S.srcMode === 'watch' ? 'scale' : settings.distMode,
      recalcStep: settings.recalc,
      trimStart: S.srcMode !== 'plan',
    });
    res.det = detectRun(res.records, { sourceKind: S.srcMode === 'watch' ? 'watch' : 'file', lapStarts: (S.watch.laps || []).map(l => l.start) });
    res.calories = S.watch.session?.calories ?? null;
    res.km = buildLaps(res.records, kmBounds(res.records, 1), { calories: res.calories });
    applyLaps(res);
    res.summary = summarize(res.records, res.calories);
    S.result = res;
  } catch (e) { console.error(e); S.error = e.message; }
}

function watchLapBounds(res) {
  const laps = S.watch.laps || [];
  if (!laps.length) return [{ t: res.records[0].t, type: 'active', name: 'Lap 1' }];
  return laps.map((l, k) => ({ t: Math.max(l.start, res.records[0].t), type: 'active', name: `Lap ${k + 1}` }));
}

function applyLaps(res) {
  let bounds;
  const r0 = res.records[0].t;
  switch (S.lapMode) {
    case 'custom': bounds = S.custom && S.custom.length ? S.custom : res.det.bounds; break;
    case 'km': bounds = kmBounds(res.records, Math.max(0.1, +settings.lapKm || 1)); break;
    case 'watch': bounds = watchLapBounds(res); break;
    case 'single': bounds = [{ t: r0, type: 'active', name: 'Run' }]; break;
    default: bounds = res.det.bounds.length ? res.det.bounds : kmBounds(res.records, 1);
  }
  res.laps = buildLaps(res.records, bounds, { calories: res.calories });
  res.lapMode = S.lapMode;
  if (S.lapMode === 'custom') S.custom = res.laps.map(l => ({ t: l.start, type: l.type, name: l.name, trigger: l.trigger }));
}

function recompute() { compute(); render(); }

// ------------------------------------------------------------------ charts
function down(arr, max = 900) { const k = Math.max(1, Math.ceil(arr.length / max)); return k === 1 ? arr : arr.filter((_, i) => i % k === 0 || i === arr.length - 1); }

let CHARTS = {}, chartSeq = 0;
function profileChart(recs, laps, { hr = true, h = DESK ? 250 : 190 } = {}) {
  if (!recs?.length) return '';
  const W = DESK ? 1100 : 720, H = h, hasHr = hr && recs.some(r => r.hr > 0);
  const pl = 30, pr = hasHr ? 32 : 10, pt = 10, pb = 22;
  const t0 = recs[0].t, t1 = recs[recs.length - 1].t || t0 + 1;
  const X = t => pl + (t - t0) / ((t1 - t0) || 1) * (W - pl - pr);
  const vmax = Math.max(...recs.map(r => r.speed * 3.6), 1);
  const stepV = vmax > 14 ? 4 : 2;
  const top = Math.ceil((vmax + 0.5) / stepV) * stepV;
  const Y = v => pt + (1 - v / top) * (H - pt - pb);
  let g = '';
  for (let v = 0; v <= top; v += stepV) g += `<line class="gridl" x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
  const durMin = (t1 - t0) / 60000;
  const tick = durMin > 150 ? 30 : durMin > 60 ? 10 : durMin > 20 ? 5 : durMin > 6 ? 2 : 1;
  for (let m = 0; m <= durMin; m += tick) g += `<text x="${X(t0 + m * 60000)}" y="${H - 6}" text-anchor="middle">${m}′</text>`;
  let areas = '';
  for (const l of laps) {
    const pts = down(recs.slice(l.i0, Math.min(recs.length, l.i1 + 1)), 400);
    if (!pts.length) continue;
    let d = `M${X(pts[0].t).toFixed(1)},${Y(0)}`;
    for (let i = 0; i < pts.length; i++) {
      const y = Y(pts[i].speed * 3.6).toFixed(1);
      d += `L${X(pts[i].t).toFixed(1)},${y}`;
      if (i + 1 < pts.length) d += `L${X(pts[i + 1].t).toFixed(1)},${y}`;
    }
    d += `L${X(pts[pts.length - 1].t).toFixed(1)},${Y(0)}Z`;
    areas += `<path class="t-${l.type}" style="fill:var(--c);opacity:.88" d="${d}"><title>${esc(l.name)} · ${fmtPace(l.avgSpeed)}/km</title></path>`;
  }
  let hrLine = '';
  if (hasHr) {
    const hrs = recs.filter(r => r.hr > 0).map(r => r.hr);
    const lo = Math.floor((Math.min(...hrs) - 5) / 10) * 10, hi = Math.ceil((Math.max(...hrs) + 3) / 10) * 10;
    const YH = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const pts = down(recs.filter(r => r.hr > 0), 700);
    hrLine = `<polyline fill="none" style="stroke:var(--ink)" stroke-opacity=".75" stroke-width="1.4" stroke-linejoin="round" points="${pts.map(r => `${X(r.t).toFixed(1)},${YH(r.hr).toFixed(1)}`).join(' ')}"/>`;
    for (let v = lo; v <= hi; v += (hi - lo > 60 ? 20 : 10)) hrLine += `<text x="${W - pr + 5}" y="${YH(v) + 4}">${v}</text>`;
  }
  const cid = `c${++chartSeq}`;
  CHARTS[cid] = { recs, laps, t0, t1, pl, pr, W, X };
  return `<div class="chartwrap" data-cid="${cid}"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Speed profile${hasHr ? ' with heart rate' : ''}">${g}${areas}${hrLine}<line class="cur hide" x1="0" x2="0" y1="${pt}" y2="${H - pb}"/></svg><div class="tip hide"></div></div>`;
}

function alignChart(watch, source, offsetMs, zoom) {
  const recs = watch.records;
  if (!recs.length || !source?.samples.length) return '';
  const W = DESK ? 1000 : 720, H = DESK ? 170 : 140, pl = 8, pr = 8, pt = 8, pb = 20;
  let x0 = recs[0].t, x1 = recs[recs.length - 1].t;
  if (zoom === 'start') x1 = Math.min(x1, x0 + 16 * 60e3);
  if (zoom === 'end') x0 = Math.max(x0, x1 - 16 * 60e3);
  const X = t => pl + (t - x0) / ((x1 - x0) || 1) * (W - pl - pr);
  const useCad = recs.filter(r => r.cad > 0).length > recs.length * 0.5;
  const wv = recs.filter(r => r.t >= x0 && r.t <= x1).map(r => ({ t: r.t, v: useCad ? r.cad : r.speed })).filter(p => p.v != null);
  const sv = source.samples.map(s => ({ t: s.t + offsetMs, v: s.speed })).filter(p => p.t >= x0 && p.t <= x1);
  const line = (pts, color, w, stepped) => {
    if (pts.length < 2) return '';
    const vs = pts.map(p => p.v); const lo = Math.min(...vs), hi = Math.max(...vs) || 1;
    const Y = v => pt + (1 - (v - lo) / ((hi - lo) || 1)) * (H - pt - pb);
    const ds = down(pts, 900);
    let d = '';
    ds.forEach((p, i) => { d += `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`; if (stepped && i + 1 < ds.length) d += `L${X(ds[i + 1].t).toFixed(1)},${Y(p.v).toFixed(1)}`; });
    return `<path d="${d}" fill="none" style="stroke:${color}" stroke-width="${w}" stroke-linejoin="round"/>`;
  };
  let marks = '';
  for (const l of watch.laps || []) if (l.start > x0 && l.start < x1) marks += `<line x1="${X(l.start)}" x2="${X(l.start)}" y1="${pt}" y2="${H - pb}" style="stroke:var(--ink-3)" stroke-dasharray="3 3" stroke-width="1"/>`;
  let ticks = '';
  const durMin = (x1 - x0) / 60000, tick = durMin > 60 ? 10 : durMin > 20 ? 5 : 2;
  const base = recs[0].t;
  for (let m = Math.ceil((x0 - base) / 60000 / tick) * tick; base + m * 60000 <= x1; m += tick) ticks += `<text x="${X(base + m * 60000)}" y="${H - 5}" text-anchor="middle">${m}′</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Alignment check">${marks}${line(wv, 'var(--ink-3)', 1.3, false)}${line(sv, 'var(--accent)', 2.2, true)}${ticks}</svg>
  <div class="legend"><span><i style="background:var(--accent)"></i>${S.srcMode === 'plan' ? 'Plan speed' : 'Treadmill speed'} (shifted)</span><span><i style="background:var(--ink-3)"></i>Watch ${useCad ? 'cadence' : 'speed'}</span><span><i style="background:repeating-linear-gradient(90deg,var(--ink-3) 0 3px,transparent 3px 6px)"></i>Watch laps</span></div>`;
}

// ------------------------------------------------------------------ lap table
function lapTable(laps, { hr = true, edit = false, total = null, kind = 'run' } = {}) {
  if (!laps.length) return '<p class="muted">No laps.</p>';
  const maxSp = Math.max(...laps.map(l => l.avgSpeed), 0.1);
  const typeOpts = t => STEP_TYPES.map(o => `<option value="${o.id}"${o.id === t ? ' selected' : ''}>${o.label}</option>`).join('');
  const head = `<tr><th>#</th><th>${edit ? 'Type / name' : 'Lap'}</th><th>Time</th><th>Km</th><th>Pace</th>${hr ? '<th>HR</th><th>Cad</th>' : '<th>km/h</th>'}${edit ? '<th></th>' : ''}</tr>`;
  const rows = laps.map((l, k) => {
    const w = Math.max(24, (l.avgSpeed / maxSp) * 100).toFixed(1);
    const name = edit
      ? `<div class="editname"><select class="inp sm" data-ch="lap-type" data-k="${k}">${typeOpts(l.type)}</select><input class="inp sm" id="lapn-${k}" data-ch="lap-name" data-k="${k}" value="${esc(l.name)}"></div>`
      : `<div class="lapname"><span class="dot"></span><span class="ln">${esc(l.name || `Lap ${k + 1}`)}</span></div>`;
    const time = edit && k < laps.length - 1
      ? `<input class="inp sm num" id="lapd-${k}" data-ch="lap-dur" data-k="${k}" value="${fmtDur(l.duration)}" style="width:76px">`
      : fmtDur(l.duration);
    return `<tr class="t-${l.type}"><td class="idx">${k + 1}</td><td>${name}</td><td class="n">${time}</td><td class="n">${km(l.distance)}</td>
      <td class="pacebar"><div class="bar" style="width:${w}%"><span>${fmtPace(l.avgSpeed)}</span></div></td>
      ${hr ? `<td class="n">${l.avgHr ?? '–'}</td><td class="n">${spm(l.avgCad)}</td>` : `<td class="n">${kmh(l.avgSpeed)}</td>`}
      ${edit ? `<td><div class="lapactions"><button class="btn sm icon" title="Split lap in two" data-act="lap-split" data-k="${k}">${ICON.split}</button>${k < laps.length - 1 ? `<button class="btn sm icon" title="Merge with next lap" data-act="lap-merge" data-k="${k}">${ICON.merge}</button>` : ''}</div></td>` : ''}</tr>`;
  }).join('');
  const tot = total ? `<tr class="total"><td></td><td>Total</td><td class="n">${fmtDur(total.duration)}</td><td class="n">${km(total.distance)}</td><td class="n">${fmtPace(total.avgSpeed)}</td>${hr ? `<td class="n">${total.avgHr ?? '–'}</td><td class="n">${spm(total.avgCad)}</td>` : `<td class="n">${kmh(total.avgSpeed)}</td>`}${edit ? '<td></td>' : ''}</tr>` : '';
  return `<div class="tablewrap"><table class="laps"><thead>${head}</thead><tbody>${rows}${tot}</tbody></table></div>`;
}

// ------------------------------------------------------------------ views
function tile(which) {
  const isW = which === 'watch';
  const a = isW ? S.watch : S.qz, err = isW ? S.watchErr : S.qzErr;
  const title = isW ? 'Watch file' : 'Treadmill file (QZ)';
  const hint = isW ? 'Heart rate, cadence, running dynamics · .fit .tcx .gpx' : 'qdomyos-zwift speed log · .fit .tcx .gpx .csv';
  let facts = '';
  if (a) {
    const r = a.records, dur = r.length ? (r[r.length - 1].t - r[0].t) / 1000 : 0;
    if (isW) {
      const recDist = r.length ? r[r.length - 1].dist : null;
      facts = `<div class="facts"><span><b>${r.length ? fmtClock(r[0].t) : '–'}</b></span><span><b>${fmtDur(dur)}</b> long</span>
        ${recDist != null ? `<span>watch-measured <b>${km(recDist)}</b> km</span>` : ''}${a.session?.distance ? `<span>summary <b>${km(a.session.distance)}</b> km</span>` : ''}
        <span><b>${a.laps.length}</b> laps</span>${a.device?.productName ? `<span>${esc(a.device.productName)}</span>` : ''}</div>`;
    } else {
      const sp = r.map(x => x.speed).filter(v => v != null);
      const last = r[r.length - 1];
      facts = `<div class="facts"><span><b>${r.length ? (a.relativeTime ? 'elapsed time only' : fmtTime(r[0].t)) : '–'}</b></span><span><b>${fmtDur(dur)}</b></span>
        ${last?.dist ? `<span><b>${km(last.dist)}</b> km</span>` : ''}<span><b>${kmh(Math.min(...sp))}–${kmh(Math.max(...sp))}</b> km/h</span></div>`;
    }
  }
  return `<div class="tile ${a ? 'loaded' : ''}" data-drop="${which}" data-act="pick" data-which="${which}" role="button" tabindex="0" aria-label="Choose ${title}">
    <div class="ico">${isW ? ICON.watch : ICON.tread}</div>
    <div class="body"><div class="title">${a ? esc(a.name) : title}</div><div class="sub">${a ? title : `Tap to choose or drop a file · ${hint}`}</div>${facts}${err ? `<div class="err">${esc(err)}</div>` : ''}</div>
    ${a ? `<button class="btn sm icon ghost" data-act="clear" data-which="${which}" title="Remove">${ICON.x}</button>` : ''}
  </div>`;
}

function cardFiles() {
  let h = `<section class="card"><h2><span class="step">1</span>Your run</h2><div class="stack">${tile('watch')}
    <div><div class="small muted" style="margin-bottom:6px;font-weight:600">Where should the speed come from?</div>
    <div class="seg full" role="group">${[['file', 'Treadmill file'], ['plan', 'Manual / plan'], ['watch', 'Watch only']].map(([v, l]) => `<button data-act="srcmode" data-v="${v}" aria-pressed="${S.srcMode === v}">${l}</button>`).join('')}</div></div>`;
  if (S.srcMode === 'file') h += tile('qz');
  else if (S.srcMode === 'plan') {
    const segs = flattenPlan(S.plan), fixed = segs.filter(s => !s.open).reduce((a, s) => a + s.dur, 0);
    h += `<div class="note"><b>${esc(S.plan.name || 'Untitled plan')}</b> · ${segs.length} steps · ${fmtDur(fixed)} fixed${segs.some(s => s.open) ? ' + “until end”' : ''}
      <div class="row" style="margin-top:8px"><select class="inp sm" data-ch="tpl-pick" style="width:auto;max-width:100%"><option value="">Load a template…</option>${TEMPLATES.map((t, i) => `<option value="t${i}">${esc(t.name)}</option>`).join('')}${S.saved.map((t, i) => `<option value="s${i}">★ ${esc(t.name)}</option>`).join('')}</select>
      <button class="btn sm" data-act="tab" data-tab="plan">Edit plan</button></div></div>`;
  } else h += `<div class="note">Uses the watch’s own pace pattern, scaled so the total matches the actual distance you enter below. Best when you have no treadmill log and no plan.</div>`;
  return h + `</div></section>`;
}

function cardEmpty() {
  return DESK
    ? `<section class="card empty bigdrop" data-drop="watch"><div class="ico">${ICON.watch}${ICON.tread}</div><p><b>Drop your watch file and treadmill file here — both at once is fine.</b><br>RunSync recognises which is which. Or use the boxes on the left.</p><p class="small muted">Shortcuts: ← / → nudge alignment (Shift = 10 s) · E edit laps · Ctrl/⌘ + S save FIT · 1 / 2 / 3 switch tabs</p></section>`
    : `<section class="card empty"><p><b>Start with your watch file.</b><br>Then add the QZ treadmill file, or enter the speeds by hand. Nothing is uploaded — files are processed on this device.</p><p class="small muted">Tip: choose both files at once and RunSync will sort them out.</p></section>`;
}

function cardAlign(src) {
  const isPlan = S.srcMode === 'plan';
  const off = isPlan ? 0 : S.offset;
  const chk = alignmentCheck(S.watch, src, isPlan ? 0 : S.offset);
  const val = isPlan ? S.planOffset : S.offset;
  return `<section class="card"><h2><span class="step">2</span>Line up the two</h2><div class="stack">
    <div class="offset">
      <button class="btn sm" data-act="nudge" data-v="-10">−10</button><button class="btn sm" data-act="nudge" data-v="-1">−1</button>
      <div class="val">${val > 0 ? '+' : ''}${val}<small class="muted" style="font-size:14px"> s</small></div>
      <button class="btn sm" data-act="nudge" data-v="1">+1</button><button class="btn sm" data-act="nudge" data-v="10">+10</button>
      <button class="btn sm dark" data-act="auto-align">Auto</button>
    </div>
    <div class="small muted">${isPlan ? 'Seconds after the watch started that the plan’s first step began.' : 'Seconds added to the treadmill clock so its speed changes line up with the watch.'}${DESK ? ' Keyboard: ← / → (Shift = 10 s).' : ''}</div>
    ${!isPlan && S.align ? `<div class="note ${S.align.method === 'timestamps' || S.align.method === 'laps' ? 'ok' : 'warn'}">${esc(S.align.note)}${chk ? ` Watch laps sit <b>${chk.median > 0 ? '+' : ''}${chk.median.toFixed(0)} s</b> from the nearest speed change (${chk.matched}/${chk.laps} matched).` : ''}</div>` : ''}
    ${isPlan && chk ? `<div class="note">Watch laps sit <b>${chk.median > 0 ? '+' : ''}${chk.median.toFixed(0)} s</b> from the nearest plan step change (${chk.matched}/${chk.laps} matched).</div>` : ''}
    <div class="row between"><span class="small muted">Check where the orange line steps against the watch trace.</span>
      <div class="seg">${[['start', 'Start'], ['full', 'Full'], ['end', 'End']].map(([v, l]) => `<button data-act="zoom" data-v="${v}" aria-pressed="${S.alignZoom === v}">${l}</button>`).join('')}</div></div>
    ${alignChart(S.watch, src, off * 1000, S.alignZoom)}
    <div class="small muted">The watch’s own cadence and pace react 10–20 s late, so a small lag on the grey line is normal.</div>
  </div></section>`;
}

function cardSettings() {
  const qzDist = S.qz?.records?.at(-1)?.dist;
  const chips = [];
  if (S.watch.session?.distance) chips.push([S.watch.session.distance, 'watch summary']);
  if (S.srcMode === 'file' && qzDist) chips.push([qzDist, 'treadmill']);
  return `<section class="card"><h2><span class="step">3</span>Distance &amp; clean-up</h2><div class="grid2">
    <div><label class="field"><span>Actual distance</span><div class="unit"><input class="inp num" id="target" data-ch="target" placeholder="e.g. 12.20" value="${esc(S.targetKm)}" autocomplete="off"><em>km</em></div></label>
      ${chips.length ? `<div class="chips">${chips.map(([d, l]) => `<button class="chip" data-act="settarget" data-v="${(d / 1000).toFixed(2)}">${(d / 1000).toFixed(2)} · ${l}</button>`).join('')}${S.targetKm ? '<button class="chip" data-act="settarget" data-v="">clear</button>' : ''}</div>` : ''}
      <div class="small muted" style="margin-top:6px">${S.srcMode === 'watch' ? 'Required in watch-only mode.' : 'Optional. The last lap is extended or cut so the run ends exactly here — nothing else changes.'}</div></div>
    <div class="stack">
      ${S.srcMode !== 'plan' ? `<label class="field"><span>Ignore startup speed below</span><div class="unit"><input class="inp num" id="minsp" data-ch="minspeed" value="${settings.minSpeed}" autocomplete="off"><em>km/h</em></div></label>` : ''}
      ${S.srcMode !== 'watch' ? `<label class="field"><span>How to reach the actual distance</span><select class="inp" data-ch="distmode"><option value="extend"${settings.distMode === 'extend' ? ' selected' : ''}>Extend / trim the end (recommended)</option><option value="scale"${settings.distMode === 'scale' ? ' selected' : ''}>Scale every speed proportionally</option></select></label>` : ''}
      <label class="switch"><input type="checkbox" data-ch="recalc"${settings.recalc ? ' checked' : ''}><span><span class="t">Recalculate step length</span><br><span class="d">Step length &amp; vertical ratio from treadmill speed ÷ cadence.</span></span></label>
    </div></div></section>`;
}

const GROUP_LABEL = { warmup: 'Warm up', active: 'Reps / runs', rest: 'Recoveries', cooldown: 'Cool down' };

function setEditor(r) {
  const bounds = S.custom && S.lapMode === 'custom' ? S.custom : r.laps.map(l => ({ t: l.start, type: l.type, name: l.name }));
  const end = r.records[r.records.length - 1].t;
  const groups = lapGroups(bounds, end);
  const shape = intervalShape(bounds);
  const durs = durations(bounds, end);
  const typeOpts = t => STEP_TYPES.map(o => `<option value="${o.id}"${o.id === t ? ' selected' : ''}>${o.label}</option>`).join('');
  const uneven = groups.filter(g => g.editable && !g.uniform);
  const rows = groups.map(g => {
    const rg = groupRange(bounds, end, g.type);
    const n = g.idx.filter(k => k !== bounds.length - 1).length;
    const status = g.lastOnly ? 'runs to the end of the recording'
      : g.uniform ? `<span class="ok">✓ ${n > 1 ? `all ${n} exactly` : 'exactly'} ${fmtDur(rg[0])}</span>`
      : `<span class="warn">now ${fmtDur(rg[0])}–${fmtDur(rg[1])} — Apply makes all ${n} the same</span>`;
    return `<div class="se-row t-${g.type}">
      <div class="se-name"><span class="dot"></span><b>${GROUP_LABEL[g.type] || typeLabel(g.type)}</b><span class="muted"> × ${g.count}</span></div>
      <div class="se-f se-len"><span>Each lasts</span>${g.lastOnly
        ? `<input class="inp sm num" value="to the end" disabled>`
        : `<div class="se-lenrow"><input class="inp sm num" id="se-dur-${g.type}" data-ch="se-dur" data-type="${g.type}" value="${fmtDur(g.dur)}" autocomplete="off" aria-label="Length of every ${esc(GROUP_LABEL[g.type] || g.type)} lap"><button class="btn sm ${g.uniform ? '' : 'primary'}" data-act="se-apply" data-type="${g.type}">Apply</button></div>`}
        <div class="se-status">${status}</div></div>
      <label class="se-f"><span>Name</span><input class="inp sm" id="se-name-${g.type}" data-ch="se-name" data-type="${g.type}" value="${esc(g.pattern)}" placeholder="${g.count > 1 ? 'e.g. Rep #' : 'Name'}" autocomplete="off"></label>
      <label class="se-f"><span>Type</span><select class="inp sm" data-ch="se-type" data-type="${g.type}">${typeOpts(g.type)}</select></label>
    </div>`;
  }).join('');
  const med = ks => { const v = ks.map(k => durs[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const repTxt = shape ? `${shape.reps.length} × ${fmtDur(med(shape.reps))}${shape.recs.length ? ` / ${fmtDur(med(shape.recs))}` : ''}` : '';
  const exactLbl = groups.filter(g => g.editable).map(g => fmtDur(g.dur)).join(' / ');
  return `<div class="seteditor">
    <div class="se-head"><div><b>Edit as a set</b> <span class="small muted">— one box changes every lap of that kind</span></div>
      ${shape ? `<label class="se-count">Reps <input class="inp sm num" id="se-count" data-ch="se-count" value="${shape.reps.length}" autocomplete="off"><span class="small muted">${repTxt}</span></label>` : ''}</div>
    ${uneven.length ? `<div class="se-exact"><div><b>Some laps are a second or two off</b> (${uneven.map(g => (GROUP_LABEL[g.type] || g.type).toLowerCase()).join(', ')}). Make every lap exactly the length in its box — later laps shift to follow.</div>
      <button class="btn primary" data-act="se-exact">Make all exact · ${exactLbl}</button></div>` : ''}
    ${rows}
    <div class="row se-tools">
      <span class="small muted">Move all boundaries</span>
      <button class="btn sm" data-act="se-shift" data-v="-1">−1 s</button><button class="btn sm" data-act="se-shift" data-v="1">+1 s</button>
      <button class="btn sm" data-act="se-snap" title="Move each lap boundary onto the nearest speed change (±12 s)">Snap to speed changes</button>
      <button class="btn sm ghost" data-act="lap-reset">Reset to auto-detected</button>
    </div>
    <div class="small muted">Laps are laid end to end from the start of the warm up, so every rep and recovery gets exactly its length and the ones after it shift along; the last lap (usually the cool down) takes up the difference. Type a length and press Enter or Apply. Use “#” in a name for the lap number, e.g. “Rep #”. Fine-tune single laps in the table below.</div>
  </div>`;
}

function resultNotes(r) {
  const info = r.info, notes = [];
  if (info.trimmedStartSec > 0) notes.push(`Starts at ${fmtTime(r.records[0].t)} — removed the first ${fmtDur(info.trimmedStartSec)} ${S.srcMode === 'plan' ? 'before the plan begins' : `(watch running before the intended ${info.startSpeed ? kmh(info.startSpeed) + ' km/h' : 'speed'} was set)`}.`);
  if (info.droppedEnd > 0) notes.push(`Dropped ${fmtDur(info.droppedEnd)} of watch data after the ${S.srcMode === 'plan' ? 'plan' : 'treadmill'} stopped.`);
  if (info.held > 0) notes.push(`${S.srcMode === 'plan' ? 'Plan' : 'Treadmill file'} ended early — held the last speed for ${fmtDur(info.held)} of watch data.`);
  if (info.appended > 0) notes.push(`Added ${fmtDur(info.appended)} at the end at ${kmh(r.records[r.records.length - 1].speed)} km/h (HR/cadence carried from the last seconds) to reach ${km(info.finalDist)} km.`);
  if (info.truncated > 0) notes.push(`Cut the last ${fmtDur(info.truncated)} — the run reached ${km(info.finalDist)} km before the recording ended.`);
  if (info.scale !== 1) notes.push(`Scaled every speed by ×${info.scale.toFixed(4)} (${km(info.rawDist)} → ${km(info.finalDist)} km).`);
  if (!notes.length) notes.push(`Distance from ${S.srcMode === 'plan' ? 'the plan' : 'treadmill speed'}: ${km(info.finalDist)} km.`);
  return notes;
}

function lapControls() {
  return `<div class="row" style="gap:6px">
    <select class="inp sm" data-ch="lapmode" style="width:auto">${[['auto', 'Auto-detected'], ['km', 'Every N km'], ['watch', 'Watch’s laps'], ['single', 'One lap'], ['custom', 'Custom (edited)']].map(([v, l]) => `<option value="${v}"${S.lapMode === v ? ' selected' : ''}${v === 'custom' && !S.custom ? ' disabled' : ''}>${l}</option>`).join('')}</select>
    ${S.lapMode === 'km' ? `<div class="unit" style="width:96px"><input class="inp sm num" id="lapkm" data-ch="lapkm" value="${settings.lapKm}" autocomplete="off"><em>km</em></div>` : ''}
    <button class="btn sm ${S.editing ? 'primary' : ''}" data-act="edit">${S.editing ? 'Done' : 'Edit laps'}</button>
  </div>`;
}

function cardResult() {
  const r = S.result, sm = r.summary;
  const view = DESK && !S.editing ? 'laps' : S.view;
  const lapsShown = view === 'km' ? r.km : r.laps;
  const editing = S.editing && view === 'laps';
  const stats = `<div class="stats">
      <div class="stat"><div class="l">Distance</div><div class="v">${km(sm.distance)}<small>km</small></div></div>
      <div class="stat"><div class="l">Time</div><div class="v">${fmtDur(sm.duration)}</div></div>
      <div class="stat"><div class="l">Avg pace</div><div class="v">${fmtPace(sm.avgSpeed)}<small>/km</small></div></div>
      <div class="stat"><div class="l">Avg HR</div><div class="v">${sm.avgHr ?? '–'}<small>bpm</small></div></div>
      <div class="stat"><div class="l">Cadence</div><div class="v">${spm(sm.avgCad)}<small>spm</small></div></div>
      <div class="stat"><div class="l">${sm.calories != null ? 'Calories' : 'Max HR'}</div><div class="v">${sm.calories ?? sm.maxHr ?? '–'}<small>${sm.calories != null ? 'kcal' : 'bpm'}</small></div></div>
    </div>`;
  const legend = `<div class="legend"><span><i style="background:var(--wu)"></i>Warm up</span><span><i style="background:var(--work)"></i>Run / rep</span><span><i style="background:var(--rest)"></i>Recovery</span><span><i style="background:var(--cd)"></i>Cool down</span><span><i style="background:var(--ink)"></i>Heart rate</span><span class="muted">${DESK ? 'Hover' : 'Touch'} the chart for details</span></div>`;
  let tables;
  if (DESK && !S.editing) {
    tables = `<div class="tables2">
      <div><div class="row between tbl-h"><h3>Laps <span class="muted">(${r.laps.length})</span></h3>${lapControls()}</div>${lapTable(r.laps, { hr: true, total: sm })}</div>
      <div><div class="row between tbl-h"><h3>Km splits <span class="muted">(${r.km.length})</span></h3></div>${lapTable(r.km, { hr: true, total: sm })}</div>
    </div>`;
  } else {
    tables = `<div class="row between">
      ${DESK ? `<h3 style="margin:0">Laps <span class="muted">(${r.laps.length})</span></h3>` : `<div class="seg">${[['laps', `Laps (${r.laps.length})`], ['km', `Km splits (${r.km.length})`]].map(([v, l]) => `<button data-act="view" data-v="${v}" aria-pressed="${view === v}">${l}</button>`).join('')}</div>`}
      ${view === 'laps' ? lapControls() : ''}
    </div>
    ${editing ? setEditor(r) : ''}
    ${editing ? '<div class="small muted" style="font-weight:600">One lap at a time</div>' : ''}
    ${lapTable(lapsShown, { hr: true, edit: editing, total: sm })}
    ${editing ? `<div class="small muted">Change a lap’s time to move its end. Split halves a lap; merge joins it with the next.</div>` : ''}`;
  }
  return `<section class="card"><h2><span class="step">4</span>Result<span class="grow"></span></h2><div class="stack">
    <div class="row between"><span class="badge"><span class="k">Detected</span>${esc(r.det.label)}</span>${DESK ? '' : ''}</div>
    ${stats}
    <ul class="notes">${resultNotes(r).map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    ${profileChart(r.records, view === 'km' ? r.km : r.laps)}
    ${legend}
    ${tables}
    <div class="row"><button class="btn sm" data-act="to-plan">Save this workout as a plan</button></div>
  </div></section>`;
}

function cardExport() {
  const dev = resolveDevice(settings.device, S.watch);
  const canShare = typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.fit', { type: 'application/octet-stream' })] });
  return `<section class="card"><h2><span class="step">5</span>Export</h2><div class="stack">
    <div class="grid2">
      <label class="field"><span>Device to show in the file</span><select class="inp" data-ch="device">${DEVICES.map(d => `<option value="${d.id}"${d.id === settings.device ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
      <label class="field"><span>File name</span><input class="inp" id="fname" data-ch="fname" value="${esc(S.fileBase)}" autocomplete="off"></label>
    </div>
    <div class="row">
      <button class="btn primary" data-act="export" data-fmt="fit">${ICON.dl} FIT</button>
      <button class="btn" data-act="export" data-fmt="tcx">${ICON.dl} TCX</button>
      <button class="btn" data-act="export" data-fmt="gpx">${ICON.dl} GPX</button>
      <button class="btn" data-act="export" data-fmt="csv">${ICON.dl} CSV</button>
      <button class="btn" data-act="export" data-fmt="lapcsv">${ICON.dl} Laps CSV</button>
      ${canShare ? `<button class="btn dark" data-act="share">${ICON.share} Share FIT</button>` : ''}
    </div>
    <div class="small muted">FIT keeps everything from the watch file (HR, running dynamics, training effect, developer fields) with treadmill speed, distance and new laps. Device: <b>${esc(dev.name)}</b>.${DESK ? ' Ctrl/⌘ + S saves the FIT.' : ''} GPX has no field for distance without GPS, so it uses a virtual straight track as long as the run.</div>
  </div></section>`;
}

function viewSync() {
  const wideHint = !DESK && window.innerWidth >= 1100 ? `<div class="note deskhint">On a computer? <a href="desktop.html">Open the desktop version</a> — side-by-side layout, both tables at once, keyboard shortcuts.</div>` : '';
  const files = cardFiles();
  if (!S.watch) return DESK ? `<div class="dsk"><aside class="side">${files}</aside><section class="mainpane">${cardEmpty()}</section></div>` : wideHint + files + cardEmpty();
  const src = currentSource();
  const align = src && S.srcMode !== 'watch' ? cardAlign(src) : '';
  const sets = src ? cardSettings() : '';
  const err = S.error ? `<section class="card note warn">${esc(S.error)}</section>` : '';
  const res = S.result ? cardResult() : '';
  const exp = S.result ? cardExport() : '';
  if (DESK) {
    const waiting = !S.result && !S.error ? `<section class="card empty bigdrop" data-drop="qz"><p><b>${S.srcMode === 'file' ? 'Now add the treadmill (QZ) file.' : 'Set the plan or distance on the left.'}</b></p></section>` : '';
    return `<div class="dsk"><aside class="side">${files}${align}${sets}${exp}</aside><section class="mainpane">${err}${res}${waiting}</section></div>`;
  }
  return wideHint + files + align + sets + err + res + exp;
}

// ------------------------------------------------------------------ planner view
function stepCard(s, inRepeat) {
  const typeOpts = STEP_TYPES.map(o => `<option value="${o.id}"${o.id === s.type ? ' selected' : ''}>${o.label}</option>`).join('');
  const dur = stepDur(s);
  const durVal = s.durType === 'distance' ? (s.dist / 1000).toString() : fmtDur(s.dur || 0);
  const pace = s.kmh > 0 ? fmtPace(s.kmh / 3.6) : '';
  const dist = s.kmh / 3.6 * dur;
  return `<div class="stepc t-${s.type}">
    <div class="head"><select class="inp sm" data-ch="st-type" data-id="${s.id}">${typeOpts}</select>
      <div class="acts">
        <button class="btn sm icon ghost" title="Move up" data-act="mv" data-d="-1" data-id="${s.id}">${ICON.up}</button>
        <button class="btn sm icon ghost" title="Move down" data-act="mv" data-d="1" data-id="${s.id}">${ICON.down}</button>
        <button class="btn sm icon ghost" title="Duplicate" data-act="dup" data-id="${s.id}">${ICON.copy}</button>
        ${!inRepeat ? `<button class="btn sm icon ghost" title="Repeat this step with the next one" data-act="wrap" data-id="${s.id}">${ICON.rep}</button>` : ''}
        <button class="btn sm icon ghost" title="Remove" data-act="del" data-id="${s.id}">${ICON.x}</button>
      </div></div>
    <div class="fields">
      <label><span>Length by</span><select class="inp sm" data-ch="st-durtype" data-id="${s.id}"><option value="time"${s.durType === 'time' ? ' selected' : ''}>Time</option><option value="distance"${s.durType === 'distance' ? ' selected' : ''}>Distance</option>${!inRepeat ? `<option value="open"${s.durType === 'open' ? ' selected' : ''}>Until end</option>` : ''}</select></label>
      <label><span>${s.durType === 'distance' ? 'Distance (km)' : s.durType === 'open' ? 'Est. time (m:ss)' : 'Time (m:ss)'}</span><input class="inp sm num" id="d-${s.id}" data-ch="st-dur" data-id="${s.id}" value="${esc(durVal)}"></label>
      <label><span>Speed (km/h)</span><input class="inp sm num" id="k-${s.id}" data-ch="st-kmh" data-id="${s.id}" value="${s.kmh}"></label>
      <label><span>Pace (/km)</span><input class="inp sm num" id="p-${s.id}" data-ch="st-pace" data-id="${s.id}" value="${pace}"></label>
    </div>
    <div class="meta">${fmtDur(dur)} · ${km(dist)} km${s.durType === 'open' ? ' · fills the rest of the run when syncing' : ''}</div>
  </div>`;
}

function viewPlan() {
  const P = S.plan;
  let items = '';
  for (const it of P.items) {
    if (it.kind === 'repeat') {
      const one = it.steps.reduce((a, s) => a + stepDur(s), 0);
      const oneD = it.steps.reduce((a, s) => a + stepDur(s) * s.kmh / 3.6, 0);
      items += `<div class="rep"><div class="head"><div class="ttl">${ICON.rep.replace('<svg', '<svg width="16" height="16"')} Repeat <input class="inp sm num" id="rc-${it.id}" data-ch="rep-count" data-id="${it.id}" value="${it.count}"> ×</div>
        <div class="row" style="gap:4px">
          <button class="btn sm icon ghost" title="Move up" data-act="mv" data-d="-1" data-id="${it.id}">${ICON.up}</button>
          <button class="btn sm icon ghost" title="Move down" data-act="mv" data-d="1" data-id="${it.id}">${ICON.down}</button>
          <button class="btn sm icon ghost" title="Duplicate" data-act="dup" data-id="${it.id}">${ICON.copy}</button>
          <button class="btn sm ghost" data-act="ungroup" data-id="${it.id}">Ungroup</button>
          <button class="btn sm icon ghost" title="Remove" data-act="del" data-id="${it.id}">${ICON.x}</button></div></div>
        <div class="steps">${it.steps.map(s => stepCard(s, true)).join('')}</div>
        <div class="row between" style="margin-top:8px"><button class="btn sm" data-act="rep-add" data-id="${it.id}">+ Step in repeat</button><span class="small muted">${it.count} × ${fmtDur(one)} = ${fmtDur(one * it.count)} · ${km(oneD * it.count)} km</span></div></div>`;
    } else items += stepCard(it, false);
  }
  const { recs, bounds } = planRecords(P);
  let summary = '';
  if (recs.length > 1) {
    const laps = buildLaps(recs, bounds), kms = buildLaps(recs, kmBounds(recs, 1)), sm = summarize(recs);
    summary = `<section class="card"><h2>Plan overview</h2><div class="stack">
      <div class="stats" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat"><div class="l">Distance</div><div class="v">${km(sm.distance)}<small>km</small></div></div>
        <div class="stat"><div class="l">Time</div><div class="v">${fmtDur(sm.duration)}</div></div>
        <div class="stat"><div class="l">Avg pace</div><div class="v">${fmtPace(sm.avgSpeed)}<small>/km</small></div></div>
      </div>
      ${profileChart(recs, S.planView === 'km' ? kms : laps, { hr: false, h: DESK ? 300 : 160 })}
      <div class="seg">${[['laps', `Steps (${laps.length})`], ['km', `Km splits (${kms.length})`]].map(([v, l]) => `<button data-act="planview" data-v="${v}" aria-pressed="${S.planView === v}">${l}</button>`).join('')}</div>
      ${lapTable(S.planView === 'km' ? kms : laps, { hr: false, total: sm })}
      ${P.items.some(i => i.durType === 'open') ? '<div class="small muted">“Until end” steps use their estimated time here; when syncing they fill the rest of the watch recording.</div>' : ''}
    </div></section>`;
  }
  const editor = `<section class="card"><h2>Templates</h2><div class="templates">${TEMPLATES.map((t, i) => `<button class="tpl" data-act="tpl" data-i="${i}">${esc(t.name)}</button>`).join('')}<button class="tpl" data-act="new-plan">+ Blank plan</button></div>
    ${S.saved.length ? `<div class="row" style="margin-top:12px"><select class="inp sm" id="savedsel" style="width:auto;flex:1;min-width:160px">${S.saved.map((p, i) => `<option value="${i}">★ ${esc(p.name)}</option>`).join('')}</select><button class="btn sm" data-act="load-saved">Load</button><button class="btn sm ghost" data-act="del-saved">Delete</button></div>` : ''}
  </section>
  <section class="card"><h2>Workout</h2><div class="stack">
    <label class="field"><span>Plan name</span><input class="inp" id="pname" data-ch="plan-name" value="${esc(P.name)}" placeholder="e.g. 10 × 3′ / 1′"></label>
    <div class="steps">${items || '<div class="empty">No steps yet.</div>'}</div>
    <div class="row"><button class="btn" data-act="add-step">+ Step</button><button class="btn" data-act="add-rep">+ Repeat block</button></div>
    <div class="row" style="border-top:1px solid var(--line-2);padding-top:12px">
      <button class="btn primary" data-act="use-plan">Use for sync</button>
      <button class="btn" data-act="save-plan">★ Save plan</button>
      <button class="btn ghost" data-act="export-plan">Export JSON</button>
      <button class="btn ghost" data-act="import-plan">Import JSON</button>
    </div>
  </div></section>`;
  if (DESK) return `<div class="dsk dsk-plan"><div>${editor}</div><div class="sticky">${summary || '<section class="card empty">Add steps to see the plan overview.</section>'}</div></div>`;
  return editor + summary;
}

function viewHelp() {
  return `<section class="card help">
    <h2>How RunSync works</h2>
    <p>RunSync merges two recordings of one treadmill run. The <b>watch file</b> keeps heart rate, cadence, running dynamics and training effect. The <b>QZ file</b> (qdomyos-zwift) has the treadmill’s real speed. You get one file with all of it.</p>
    <h3>1 · Load</h3>
    <ul><li>Export the run from Zepp (or Strava etc.) as <code>.fit</code> — FIT keeps the most data. TCX / GPX / CSV also work.</li>
    <li>In QZ, take the <code>.fit</code> it saves for each session.</li>
    <li>No QZ file? Pick <b>Manual / plan</b> and enter the speeds in the <b>Plan</b> tab, or <b>Watch only</b> to scale the watch’s pace to your actual distance.</li></ul>
    <h3>2 · Line up</h3>
    <p>Both files carry clock time, so they usually line up on their own, even when QZ and the watch were started a few seconds apart. If one clock was off (time-zone mismatch), RunSync tries your watch laps, then the cadence pattern. Nudge with ±1 / ±10 s and check that the orange steps match the watch trace.</p>
    <h3>3 · Clean-up</h3>
    <ul><li><b>Startup speed:</b> QZ often sits at ~0.8 km/h for a couple of seconds before your speed is set. Everything below the threshold (default 3 km/h), and any ramp-up, is cut. The file starts the moment the intended speed is set.</li>
    <li><b>Actual distance:</b> if the treadmill total is short, seconds are added at the end at the last speed. HR and cadence for those seconds are copied from the last few seconds; nothing earlier changes. If it is long, the end is cut where the distance is reached.</li>
    <li><b>Step length:</b> the watch guesses step length from its own (wrong) pace. With this on, step length and vertical ratio are recalculated from treadmill speed ÷ cadence.</li></ul>
    <h3>4 · Laps</h3>
    <p>RunSync reads the speed profile to work out the session: <b>intervals</b> (warm up · reps · recoveries · cool down), <b>pyramid</b>, <b>fartlek</b>, <b>progression</b>, <b>tempo</b> or an <b>easy / long run</b> (1 km splits). You can switch to N km splits, the watch’s own laps or one lap.</p>
    <p>Tap <b>Edit laps</b> to change them. <b>Edit as a set</b> changes every lap of one kind at once: type one length for the reps and all 10 reps get it, and later laps move along. If detection gave some laps 2:59 / 1:01 or 3:01 / 0:59, tap <b>Make all exact</b> (or Apply / Enter on a box) and every rep and recovery gets exactly its length, with the laps after it shifting to follow. You can also change the number of reps, rename them all (“Rep #” numbers them), change their type, shift every boundary by ±1 s, or <b>snap</b> boundaries onto the treadmill’s speed changes. The table underneath still edits one lap at a time.</p>
    <h3>5 · Export</h3>
    <p>FIT is the best option for Strava, Garmin Connect, Intervals.icu, Runalyze and TrainingPeaks. Choose which device the file says it came from (default Amazfit T-Rex 3). On a phone, <b>Share FIT</b> sends it straight to another app.</p>
    <h3>Desktop version</h3>
    <p>On a computer, open <a href="desktop.html">desktop.html</a>. Settings sit on the left, results on the right, and laps and km splits show side by side. You can drop both files anywhere at once. Shortcuts: ← / → nudge the alignment (Shift = 10 s), <b>E</b> edits laps, <b>Ctrl/⌘ + S</b> saves the FIT, <b>1 / 2 / 3</b> switch tabs. It installs as a desktop app from Chrome or Edge (install icon in the address bar).</p>
    <h3>Install on your phone</h3>
    <p>Open this page in Chrome (Android) or Safari (iPhone) → menu → <b>Add to Home screen</b>. After the first visit it works offline.</p>
    <p class="small muted">Your files never leave this device. Plans and settings are saved in this browser only. RunSync v${VERSION} · <a href="${DESK ? './' : 'desktop.html'}">${DESK ? 'Mobile' : 'Desktop'} version</a></p>
  </section>`;
}

// ------------------------------------------------------------------ render
function render() {
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  const ae = document.activeElement;
  const focusId = ae && ae.id && $('#app').contains(ae) ? ae.id : null;
  const sel = focusId && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
  CHARTS = {};
  $('#app').innerHTML = S.tab === 'plan' ? viewPlan() : S.tab === 'help' ? viewHelp() : viewSync();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch { /* not a text input */ } }
  }
}

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

// ------------------------------------------------------------------ files
function setLoaded(which, act, file) {
  if (which === 'watch') {
    S.watch = act; S.watchErr = null;
    S.fileBase = file.name.replace(/\.[^.]+$/, '') + '_synced';
  } else {
    if (!act.records.some(r => r.speed > 0)) throw new Error('No speed data in this file.');
    S.qz = act; S.qzErr = null; S.srcMode = 'file';
  }
  S.custom = null; S.editing = false; if (S.lapMode === 'custom') S.lapMode = 'auto';
}

function afterLoad() {
  if (S.watch && S.qz) {
    S.align = S.qz.relativeTime ? { offsetSec: 0, method: 'start', note: 'Treadmill file has elapsed time only — aligned to the watch start.' } : autoAlign(S.watch, currentSource());
    S.offset = S.align.offsetSec;
  }
  recompute();
}

async function parseFile(file) {
  const act = await readActivityFile(file);
  if (!act.records.length) throw new Error('No data records found in this file.');
  return act;
}

async function loadFile(which, file) {
  if (!file) return;
  try { setLoaded(which, await parseFile(file), file); } catch (e) {
    console.error(e);
    if (which === 'watch') S.watchErr = `Couldn’t read ${file.name}: ${e.message}`; else S.qzErr = `Couldn’t read ${file.name}: ${e.message}`;
  }
  afterLoad();
}

/** which file is the watch and which the treadmill log? */
function watchScore(act) {
  const n = act.records.length || 1;
  let s = act.records.filter(r => r.hr > 0).length / n * 2 + act.records.filter(r => r.vo > 0 || r.st > 0).length / n;
  const tag = `${act.name} ${act.device?.productName || ''}`;
  if (act.device?.manufacturer === 255 || /\bqz\b|qdomyos|zwift|treadmill/i.test(tag)) s -= 3;
  if (/watch|amazfit|garmin|coros|polar|suunto|zepp|forerunner|fenix/i.test(tag)) s += 1;
  return s;
}

async function loadAuto(files) {
  const parsed = [];
  for (const f of files.slice(0, 2)) {
    try { parsed.push({ f, act: await parseFile(f) }); } catch (e) { toast(`Couldn’t read ${f.name}: ${e.message}`); }
  }
  if (!parsed.length) return;
  if (parsed.length === 1) {
    const { f, act } = parsed[0];
    const role = !S.watch ? 'watch' : watchScore(act) >= 1 ? 'watch' : 'qz';
    try { setLoaded(role, act, f); toast(`${f.name} → ${role === 'watch' ? 'watch file' : 'treadmill file'}`); } catch (e) { toast(e.message); }
  } else {
    parsed.sort((a, b) => watchScore(b.act) - watchScore(a.act));
    try {
      setLoaded('watch', parsed[0].act, parsed[0].f);
      setLoaded('qz', parsed[1].act, parsed[1].f);
      toast(`Watch: ${parsed[0].f.name} · Treadmill: ${parsed[1].f.name}`);
    } catch (e) { toast(e.message); }
  }
  afterLoad();
}

function download(name, data, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function exportData(fmt) {
  const r = S.result; if (!r) return null;
  const dev = resolveDevice(settings.device, S.watch);
  const base = (S.fileBase || 'run_synced').replace(/[\\/:*?"<>|]+/g, '_');
  const notes = `RunSync · ${r.det.label}`;
  switch (fmt) {
    case 'fit': return { name: `${base}.fit`, data: buildFit(r, S.watch, dev.keep ? null : dev), mime: 'application/octet-stream' };
    case 'tcx': return { name: `${base}.tcx`, data: toTCX(r, { deviceName: dev.productName || dev.name, productId: dev.product || 0, notes }), mime: 'application/vnd.garmin.tcx+xml' };
    case 'gpx': return { name: `${base}.gpx`, data: toGPX(r, { deviceName: dev.productName || dev.name, name: r.det.label }), mime: 'application/gpx+xml' };
    case 'csv': return { name: `${base}.csv`, data: toCSV(r), mime: 'text/csv' };
    case 'lapcsv': return { name: `${base}_laps.csv`, data: lapsToCSV(r), mime: 'text/csv' };
  }
  return null;
}

// ------------------------------------------------------------------ plan helpers
function locate(id, items = S.plan.items) {
  for (let i = 0; i < items.length; i++) {
    if (items[i].id === id) return { arr: items, i, item: items[i] };
    if (items[i].kind === 'repeat') { const f = locate(id, items[i].steps); if (f) return { ...f, parent: items[i] }; }
  }
  return null;
}
const deepNew = it => (it.kind === 'repeat' ? { ...it, id: uid(), steps: it.steps.map(deepNew) } : { ...it, id: uid() });
function planChanged() { savePlan(); if (S.srcMode === 'plan' && S.watch) compute(); render(); }

// ------------------------------------------------------------------ events
function ensureCustom() {
  if (!S.custom || S.lapMode !== 'custom') { S.custom = S.result.laps.map(l => ({ t: l.start, type: l.type, name: l.name, trigger: l.trigger })); S.lapMode = 'custom'; }
}
const endT = () => S.result.records[S.result.records.length - 1].t;
function applyGroupDur(type, value) {
  const sec = parseDurInput(value);
  if (!(sec > 0)) { toast('Type a length like 3:00 (or 3 for three minutes)'); return render(); }
  ensureCustom();
  setCustom(setGroupDuration(S.custom, endT(), type, sec));
}
function setCustom(nb, what) {
  const before = S.custom.length;
  S.custom = nb; recompute();
  if (S.result && S.result.laps.length < before && what !== 'count') toast(`${before - S.result.laps.length} lap(s) no longer fit and were dropped — the run ends sooner.`);
}

const clickHandlers = {
  'se-apply': el => { const inp = document.getElementById(`se-dur-${el.dataset.type}`); if (inp) applyGroupDur(el.dataset.type, inp.value); },
  'se-exact': () => {
    ensureCustom();
    const map = {};
    for (const g of lapGroups(S.custom, endT())) {
      if (!g.editable) continue;
      const inp = document.getElementById(`se-dur-${g.type}`);
      const v = inp ? parseDurInput(inp.value) : g.dur;
      map[g.type] = v > 0 ? v : g.dur;
    }
    setCustom(setGroupDurations(S.custom, endT(), map));
    toast(`Every lap set exactly: ${Object.entries(map).map(([t, v]) => `${(GROUP_LABEL[t] || t).toLowerCase()} ${fmtDur(v)}`).join(', ')}`);
  },
  'se-shift': el => { ensureCustom(); setCustom(shiftSet(S.custom, endT(), +el.dataset.v)); },
  'se-snap': () => { ensureCustom(); const r = snapToChanges(S.custom, S.result.records); setCustom(r.bounds); toast(r.moved ? `Moved ${r.moved} lap boundar${r.moved === 1 ? 'y' : 'ies'} onto speed changes` : 'Laps already sit on the speed changes'); },
  'open-desktop': () => { location.href = 'desktop.html'; },
  tab: el => { S.tab = el.dataset.tab; render(); window.scrollTo({ top: 0 }); },
  pick: (el, e) => { if (e.target.closest('[data-act="clear"]')) return; $(`#pick-${el.dataset.which === 'watch' ? 'watch' : 'qz'}`).click(); },
  clear: (el, e) => { e.stopPropagation(); if (el.dataset.which === 'watch') { S.watch = null; S.watchErr = null; } else { S.qz = null; S.qzErr = null; S.align = null; } S.custom = null; S.editing = false; recompute(); },
  srcmode: el => { S.srcMode = el.dataset.v; S.custom = null; S.editing = false; if (S.lapMode === 'custom') S.lapMode = 'auto'; recompute(); },
  nudge: el => { const v = +el.dataset.v; if (S.srcMode === 'plan') S.planOffset += v; else S.offset += v; S.custom = null; if (S.lapMode === 'custom') S.lapMode = 'auto'; recompute(); },
  'auto-align': () => {
    if (S.srcMode === 'plan') {
      const src = sourceFromSegments(flattenPlan(S.plan), S.watch.records[0].t, S.watch.records.at(-1).t + 1000);
      const a = alignBySignals(S.watch, src);
      if (a) { S.planOffset = a.offsetSec; toast(`Plan offset ${a.offsetSec} s — ${a.note}`); } else toast('Couldn’t match the plan to the watch data — set the offset by hand.');
    } else if (S.qz) { S.align = autoAlign(S.watch, currentSource()); S.offset = S.align.offsetSec; toast(S.align.note); }
    recompute();
  },
  zoom: el => { S.alignZoom = el.dataset.v; render(); },
  settarget: el => { S.targetKm = el.dataset.v; recompute(); },
  view: el => { S.view = el.dataset.v; render(); },
  edit: () => {
    if (!S.editing && S.result) {
      S.custom = S.result.laps.map(l => ({ t: l.start, type: l.type, name: l.name, trigger: l.trigger }));
      S.lapMode = 'custom';
    }
    S.editing = !S.editing; recompute();
  },
  'lap-split': el => {
    const k = +el.dataset.k, l = S.result.laps[k];
    const mid = l.start + Math.round((l.end - l.start) / 2000) * 1000;
    if (mid - l.start < 2000) return toast('Lap too short to split');
    S.custom.splice(k + 1, 0, { t: mid, type: l.type, name: `${l.name} (2)` });
    recompute();
  },
  'lap-merge': el => { const k = +el.dataset.k; S.custom.splice(k + 1, 1); recompute(); },
  'lap-reset': () => { S.custom = null; S.lapMode = 'auto'; S.editing = false; recompute(); },
  'to-plan': () => { S.plan = withIds(planFromDetection(S.result.det)); savePlan(); S.tab = 'plan'; render(); window.scrollTo({ top: 0 }); toast('Workout copied to the planner'); },
  export: el => { const x = exportData(el.dataset.fmt); if (x) { download(x.name, x.data, x.mime); toast(`Saved ${x.name}`); } },
  share: async () => {
    const x = exportData('fit'); if (!x) return;
    const file = new File([x.data], x.name, { type: 'application/octet-stream' });
    try { await navigator.share({ files: [file], title: x.name }); } catch (e) { if (e.name !== 'AbortError') { download(x.name, x.data, x.mime); } }
  },
  // planner
  tpl: el => { S.plan = clonePlan(TEMPLATES[+el.dataset.i]); planChanged(); toast(`Loaded “${S.plan.name}”`); },
  'new-plan': () => { S.plan = { name: 'New plan', items: [step('warmup', 600, 10.5)] }; planChanged(); },
  'load-saved': () => { const i = +$('#savedsel').value; S.plan = clonePlan(S.saved[i]); planChanged(); },
  'del-saved': () => { const i = +$('#savedsel').value; const n = S.saved[i]?.name; S.saved.splice(i, 1); store.set('saved', S.saved); render(); toast(`Deleted “${n}”`); },
  'save-plan': () => {
    const name = S.plan.name?.trim() || 'Untitled plan';
    S.plan.name = name;
    const i = S.saved.findIndex(p => p.name === name);
    const copy = JSON.parse(JSON.stringify(S.plan));
    if (i >= 0) S.saved[i] = copy; else S.saved.push(copy);
    store.set('saved', S.saved); savePlan(); render(); toast(`Saved “${name}”`);
  },
  'use-plan': () => { S.srcMode = 'plan'; S.tab = 'sync'; S.custom = null; if (S.lapMode === 'custom') S.lapMode = 'auto'; recompute(); window.scrollTo({ top: 0 }); },
  'export-plan': () => download(`${(S.plan.name || 'plan').replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify({ runsyncPlan: 1, ...S.plan }, null, 2), 'application/json'),
  'import-plan': () => $('#pick-plan').click(),
  planview: el => { S.planView = el.dataset.v; render(); },
  'add-step': () => { S.plan.items.push(step('active', 300, 12)); planChanged(); },
  'add-rep': () => { S.plan.items.push(repeat(4, [step('active', 180, 14), step('rest', 60, 6)])); planChanged(); },
  'rep-add': el => { const f = locate(el.dataset.id); f.item.steps.push(step('active', 60, 12)); planChanged(); },
  mv: el => {
    const f = locate(el.dataset.id); const j = f.i + +el.dataset.d;
    if (j < 0 || j >= f.arr.length) return;
    [f.arr[f.i], f.arr[j]] = [f.arr[j], f.arr[f.i]]; planChanged();
  },
  dup: el => { const f = locate(el.dataset.id); f.arr.splice(f.i + 1, 0, deepNew(JSON.parse(JSON.stringify(f.item)))); planChanged(); },
  del: el => { const f = locate(el.dataset.id); f.arr.splice(f.i, 1); if (f.parent && !f.parent.steps.length) { const p = locate(f.parent.id); p.arr.splice(p.i, 1); } planChanged(); },
  wrap: el => {
    const f = locate(el.dataset.id);
    const next = f.arr[f.i + 1];
    const take = next && next.kind === 'step' && next.durType !== 'open' ? 2 : 1;
    const steps = f.arr.splice(f.i, take).map(s => ({ ...s, durType: s.durType === 'open' ? 'time' : s.durType }));
    f.arr.splice(f.i, 0, repeat(2, steps)); planChanged();
  },
  ungroup: el => { const f = locate(el.dataset.id); f.arr.splice(f.i, 1, ...f.item.steps.map(s => ({ ...s, id: uid() }))); planChanged(); },
};

const changeHandlers = {
  'se-dur': el => applyGroupDur(el.dataset.type, el.value),
  'se-name': el => { ensureCustom(); setCustom(setGroupName(S.custom, el.dataset.type, el.value.trim())); },
  'se-type': el => { ensureCustom(); setCustom(setGroupType(S.custom, el.dataset.type, el.value)); },
  'se-count': el => { const n = parseInt(el.value, 10); if (!(n >= 1 && n <= 60)) return render(); ensureCustom(); setCustom(setRepCount(S.custom, endT(), n), 'count'); },
  target: el => { S.targetKm = el.value.trim(); recompute(); },
  minspeed: el => { const v = parseFloat(el.value.replace(',', '.')); if (v >= 0 && v < 20) { settings.minSpeed = v; saveSettings(); } recompute(); },
  distmode: el => { settings.distMode = el.value; saveSettings(); recompute(); },
  recalc: el => { settings.recalc = el.checked; saveSettings(); recompute(); },
  lapmode: el => { S.lapMode = el.value; S.editing = false; recompute(); },
  lapkm: el => { const v = parseFloat(el.value.replace(',', '.')); if (v > 0) { settings.lapKm = v; saveSettings(); } recompute(); },
  device: el => { settings.device = el.value; saveSettings(); render(); },
  fname: el => { S.fileBase = el.value.trim(); },
  'tpl-pick': el => {
    const v = el.value; if (!v) return;
    S.plan = clonePlan(v[0] === 't' ? TEMPLATES[+v.slice(1)] : S.saved[+v.slice(1)]);
    planChanged();
  },
  'lap-type': el => { S.custom[+el.dataset.k].type = el.value; recompute(); },
  'lap-name': el => { S.custom[+el.dataset.k].name = el.value; recompute(); },
  'lap-dur': el => {
    const k = +el.dataset.k, sec = parseDurInput(el.value);
    if (!(sec > 0)) return render();
    const recs = S.result.records, endT = recs[recs.length - 1].t;
    const lo = S.custom[k].t + 1000, hi = (k + 2 < S.custom.length ? S.custom[k + 2].t : endT) - 1000;
    S.custom[k + 1].t = Math.min(hi, Math.max(lo, S.custom[k].t + Math.round(sec) * 1000));
    recompute();
  },
  // planner
  'plan-name': el => { S.plan.name = el.value; savePlan(); },
  'st-type': el => { locate(el.dataset.id).item.type = el.value; planChanged(); },
  'st-durtype': el => {
    const s = locate(el.dataset.id).item, cur = stepDur(s);
    s.durType = el.value;
    if (el.value === 'distance') s.dist = Math.max(100, Math.round(cur * s.kmh / 3.6 / 10) * 10 || 1000);
    else s.dur = Math.round(cur) || 300;
    planChanged();
  },
  'st-dur': el => {
    const s = locate(el.dataset.id).item;
    if (s.durType === 'distance') { const v = parseFloat(el.value.replace(',', '.')); if (v > 0) s.dist = Math.round(v * 1000); }
    else { const v = parseDurInput(el.value); if (v > 0) s.dur = v; }
    planChanged();
  },
  'st-kmh': el => { const v = parseFloat(el.value.replace(',', '.')); if (v > 0 && v < 40) locate(el.dataset.id).item.kmh = Math.round(v * 100) / 100; planChanged(); },
  'st-pace': el => { const p = parsePace(el.value); if (p > 60) locate(el.dataset.id).item.kmh = Math.round(3600 / p * 100) / 100; planChanged(); },
  'rep-count': el => { const v = parseInt(el.value, 10); if (v >= 1 && v <= 99) locate(el.dataset.id).item.count = v; planChanged(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const h = clickHandlers[el.dataset.act];
  if (h) h(el, e);
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.tile[data-act="pick"]')) { e.preventDefault(); e.target.click(); return; }
  if (e.key === 'Enter' && e.target.matches?.('input[data-ch="se-dur"]')) { e.preventDefault(); const t = e.target; applyGroupDur(t.dataset.type, t.value); return; }
  if (e.key === 'Enter' && e.target.matches?.('input[data-ch="se-count"]')) { e.preventDefault(); changeHandlers['se-count'](e.target); return; }
  if (e.key === 'Enter' && e.target.matches?.('input[data-ch]')) { e.target.blur(); return; }
  if (e.target.matches?.('input, select, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { if (S.result) { e.preventDefault(); clickHandlers.export({ dataset: { fmt: 'fit' } }); } return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (DESK && S.tab === 'sync' && S.watch && S.srcMode !== 'watch' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    clickHandlers.nudge({ dataset: { v: (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1) } });
  } else if (e.key === 'e' && S.tab === 'sync' && S.result) clickHandlers.edit();
  else if (DESK && ['1', '2', '3'].includes(e.key)) clickHandlers.tab({ dataset: { tab: ['sync', 'plan', 'help'][+e.key - 1] } });
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-ch]');
  if (!el) return;
  const h = changeHandlers[el.dataset.ch];
  if (h) h(el, e);
});
$('#pick-watch').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length > 1) loadAuto(f); else loadFile('watch', f[0]); });
$('#pick-qz').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length > 1) loadAuto(f); else loadFile('qz', f[0]); });
$('#pick-plan').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!Array.isArray(j.items)) throw new Error('not a RunSync plan');
    S.plan = withIds({ name: j.name || f.name.replace(/\.json$/i, ''), items: j.items });
    planChanged(); toast(`Imported “${S.plan.name}”`);
  } catch (err) { toast(`Couldn’t import: ${err.message}`); }
});
// drag & drop — on a tile, or anywhere (files are recognised automatically)
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', e => {
  const t = e.target.closest?.('[data-drop]'); if (t) t.classList.remove('drag');
  if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
document.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); const t = e.target.closest?.('[data-drop]'); if (t) t.classList.add('drag'); });
document.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const t = e.target.closest?.('[data-drop]');
  if (t) t.classList.remove('drag');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  if (files.length >= 2 || !t) { loadAuto(files); return; }
  loadFile(t.dataset.drop, files[0]);
});

// chart hover / touch read-out
function hideTips() { document.querySelectorAll('.chartwrap .tip, .chartwrap .cur').forEach(x => x.classList.add('hide')); }
document.addEventListener('pointermove', e => {
  const w = e.target.closest?.('.chartwrap');
  if (!w) { hideTips(); return; }
  const c = CHARTS[w.dataset.cid];
  if (!c) return;
  const svg = w.querySelector('svg'), rc = svg.getBoundingClientRect();
  const x = (e.clientX - rc.left) / rc.width * c.W;
  if (x < c.pl || x > c.W - c.pr) { hideTips(); return; }
  const t = c.t0 + (x - c.pl) / (c.W - c.pl - c.pr) * (c.t1 - c.t0);
  let lo = 0, hi = c.recs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c.recs[m].t < t) lo = m + 1; else hi = m; }
  const r = c.recs[lo];
  const lap = c.laps.find(l => lo >= l.i0 && lo < l.i1);
  const cur = svg.querySelector('.cur');
  cur.setAttribute('x1', c.X(r.t)); cur.setAttribute('x2', c.X(r.t)); cur.classList.remove('hide');
  const tip = w.querySelector('.tip');
  tip.innerHTML = `<b>${fmtDur((r.t - c.t0) / 1000)}</b>${lap ? ` · ${esc(lap.name)}` : ''}<br>${fmtPace(r.speed)}/km · ${kmh(r.speed)} km/h · ${km(r.dist)} km${r.hr ? `<br>HR ${r.hr}` : ''}${r.cad ? ` · ${spm(r.cad + (r.fcad || 0))} spm` : ''}${r.synthetic ? '<br><i>added to reach distance</i>' : ''}`;
  tip.classList.remove('hide');
  const wr = w.getBoundingClientRect();
  const px = e.clientX - wr.left;
  tip.style.left = `${Math.min(wr.width - tip.offsetWidth - 4, Math.max(4, px + 12 + tip.offsetWidth > wr.width ? px - tip.offsetWidth - 12 : px + 12))}px`;
});
document.addEventListener('pointerleave', hideTips);

render();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// expose for debugging / tests
window.RunSync = { S, loadFile, loadAuto, recompute };
