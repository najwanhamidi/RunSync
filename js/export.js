// RunSync — build the merged FIT file (lossless edit of the watch FIT when available).
import { newMsg, cloneMsg, set, get, getRaw, has, encodeFit, fitTime, unixMs, MSG } from './fit.js';

export const DEVICES = [
  { id: 'trex3', name: 'Amazfit T-Rex 3', manufacturer: 339, product: 133, productName: 'Amazfit T-Rex 3' },
  { id: 'original', name: 'Keep device from watch file' },
  { id: 'fr165', name: 'Garmin Forerunner 165', manufacturer: 1, product: 4432 },
  { id: 'fr255', name: 'Garmin Forerunner 255', manufacturer: 1, product: 3992 },
  { id: 'fr265', name: 'Garmin Forerunner 265', manufacturer: 1, product: 4257 },
  { id: 'fr955', name: 'Garmin Forerunner 955', manufacturer: 1, product: 4024 },
  { id: 'fr965', name: 'Garmin Forerunner 965', manufacturer: 1, product: 4315 },
  { id: 'fenix7', name: 'Garmin fēnix 7', manufacturer: 1, product: 3906 },
  { id: 'fenix8', name: 'Garmin fēnix 8', manufacturer: 1, product: 4536 },
  { id: 'epix2', name: 'Garmin epix (Gen 2)', manufacturer: 1, product: 3943 },
  { id: 'venu3', name: 'Garmin Venu 3', manufacturer: 1, product: 4260 },
  { id: 'coros', name: 'COROS (generic)', manufacturer: 294, product: null, productName: 'COROS' },
  { id: 'polar', name: 'Polar (generic)', manufacturer: 123, product: null, productName: 'Polar' },
  { id: 'suunto', name: 'Suunto (generic)', manufacturer: 23, product: null, productName: 'Suunto' },
  { id: 'generic', name: 'Generic / development', manufacturer: 255, product: 0, productName: 'RunSync' },
];

export function resolveDevice(id, watch) {
  const d = DEVICES.find(x => x.id === id) || DEVICES[0];
  if (d.id !== 'original') return d;
  const w = watch?.device || {};
  return { id: 'original', name: w.productName || 'Original device', manufacturer: w.manufacturer ?? 255, product: w.product ?? 0, productName: w.productName || null, keep: true };
}

const INTENSITY = { active: 0, rest: 1, warmup: 2, cooldown: 3 };
const capU16 = v => Math.min(v, 65.534);

function recordMsg(r, recalc) {
  const fresh = !r.msg;
  const m = fresh ? newMsg(MSG.RECORD) : cloneMsg(r.msg);
  set(m, 253, fitTime(r.t));
  const hasS = has(m, 6), hasE = has(m, 73);
  if (hasS || !hasE) set(m, 6, capU16(r.speed));
  if (hasE || !hasS) set(m, 73, r.speed);
  set(m, 5, r.dist);
  if (fresh) {
    if (r.hr != null) set(m, 3, r.hr);
    if (r.cad != null) set(m, 4, Math.floor(r.cad));
    if (r.cad != null) set(m, 53, r.fcad != null ? r.fcad : r.cad - Math.floor(r.cad));
    if (r.power != null) set(m, 7, r.power);
    if (r.alt != null) set(m, 78, r.alt);
    if (r.vo != null) set(m, 39, r.vo);
    if (r.st != null) set(m, 41, r.st);
    if (r.vr != null) set(m, 83, r.vr);
    if (r.sl != null) set(m, 85, r.sl);
  } else if (recalc && r.slChanged) {
    set(m, 85, r.sl);
    if (r.vr != null && (has(m, 83) || has(m, 39))) set(m, 83, r.vr);
  }
  return m;
}

function lapMsg(l, k, subSport, workoutLaps) {
  const m = newMsg(MSG.LAP);
  set(m, 254, k);
  set(m, 253, fitTime(l.end));
  set(m, 0, 9); set(m, 1, 1);
  set(m, 2, fitTime(l.start));
  set(m, 7, l.duration); set(m, 8, l.duration);
  set(m, 9, l.distance);
  if (l.strides) set(m, 10, l.strides);
  if (l.calories != null) set(m, 11, l.calories);
  set(m, 13, capU16(l.avgSpeed)); set(m, 14, capU16(l.maxSpeed));
  set(m, 110, l.avgSpeed); set(m, 111, l.maxSpeed);
  if (l.avgHr) { set(m, 15, l.avgHr); set(m, 16, l.maxHr); set(m, 63, l.minHr); }
  if (l.avgCad) { set(m, 17, Math.floor(l.avgCad)); set(m, 80, l.avgCad - Math.floor(l.avgCad)); set(m, 18, l.maxCad); }
  set(m, 23, INTENSITY[l.type] ?? 0);
  set(m, 24, l.trigger === 'distance' ? 2 : 0);
  set(m, 25, 1); set(m, 39, subSport ?? 1);
  if (workoutLaps) set(m, 71, k);
  if (l.avgVo) set(m, 77, l.avgVo);
  if (l.avgSt) set(m, 79, l.avgSt);
  if (l.avgVr) set(m, 118, l.avgVr);
  if (l.avgSl) set(m, 120, l.avgSl);
  return m;
}

function updateSession(m, res) {
  const s = res.summary, recs = res.records;
  const tStart = recs[0].t, tEnd = recs[recs.length - 1].t;
  set(m, 253, fitTime(tEnd));
  set(m, 2, fitTime(tStart));
  set(m, 7, s.duration); set(m, 8, s.duration);
  if (has(m, 59)) set(m, 59, s.duration);
  set(m, 9, s.distance);
  set(m, 14, capU16(s.avgSpeed)); set(m, 124, s.avgSpeed);
  set(m, 15, capU16(s.maxSpeed)); set(m, 125, s.maxSpeed);
  if (s.avgHr) { set(m, 16, s.avgHr); set(m, 17, s.maxHr); if (has(m, 64)) set(m, 64, s.minHr); }
  if (s.avgCad) { set(m, 18, Math.floor(s.avgCad)); set(m, 19, s.maxCad); if (has(m, 92)) set(m, 92, s.avgCad - Math.floor(s.avgCad)); }
  if (s.avgVo) set(m, 89, s.avgVo);
  if (s.avgSt) set(m, 91, s.avgSt);
  if (s.avgVr) set(m, 132, s.avgVr);
  if (s.avgSl) set(m, 134, s.avgSl);
  set(m, 25, 0);
  set(m, 26, res.laps.length);
  return m;
}

function applyDevice(m, dev, isFileId) {
  if (!dev || dev.keep) return;
  const fMan = isFileId ? 1 : 2, fProd = isFileId ? 2 : 4, fName = isFileId ? 8 : 27;
  set(m, fMan, dev.manufacturer);
  if (dev.product != null) set(m, fProd, dev.product); else set(m, fProd, null);
  if (dev.productName) set(m, fName, dev.productName, isFileId ? [0x07] : [0x07]); else set(m, fName, null);
}

/** res = { records, laps, summary, opts }, watch = activity */
export function buildFit(res, watch, dev) {
  const recs = res.records;
  const tStart = recs[0].t, tEnd = recs[recs.length - 1].t;
  const subSport = watch.subSport ?? 1;
  const recalc = !!res.opts?.recalcStep;
  const recMsgs = recs.map(r => recordMsg(r, recalc));
  const lapMsgs = res.laps.map((l, k) => lapMsg(l, k, subSport, res.lapMode === 'auto'));
  const out = [];

  if (watch.fit) {
    let recDone = false, lapDone = false;
    let firstStart = true;
    const msgs = watch.fit.messages;
    const lastTimerStopIdx = msgs.reduce((acc, m, i) => (m.num === MSG.EVENT && getRaw(m, 0) === 0 && [1, 4].includes(getRaw(m, 1)) ? i : acc), -1);
    msgs.forEach((orig, i) => {
      switch (orig.num) {
        case MSG.RECORD:
          if (!recDone) { out.push(...recMsgs); recDone = true; }
          return;
        case MSG.LAP:
          if (!lapDone) { out.push(...lapMsgs); lapDone = true; }
          return;
        case MSG.SESSION: {
          if (!lapDone) { out.push(...lapMsgs); lapDone = true; }
          out.push(updateSession(cloneMsg(orig), res));
          return;
        }
        case MSG.EVENT: {
          const m = cloneMsg(orig);
          const ev = getRaw(m, 0), et = getRaw(m, 1), ts = getRaw(m, 253);
          if (ev === 0 && et === 0 && firstStart) { set(m, 253, fitTime(tStart)); firstStart = false; }
          else if (i === lastTimerStopIdx) set(m, 253, fitTime(tEnd));
          else if (ts != null) {
            const t = unixMs(ts);
            if (t < tStart || t > tEnd) return; // event now outside the activity
          }
          out.push(m);
          return;
        }
        case MSG.ACTIVITY: {
          const m = cloneMsg(orig);
          const oldTs = getRaw(m, 253), oldLocal = getRaw(m, 5);
          set(m, 253, fitTime(tEnd));
          set(m, 0, (tEnd - tStart) / 1000);
          if (oldTs != null && oldLocal != null) set(m, 5, oldLocal + (fitTime(tEnd) - oldTs));
          if (!lapDone) { out.push(...lapMsgs); lapDone = true; }
          out.push(m);
          return;
        }
        case MSG.FILE_ID: { const m = cloneMsg(orig); applyDevice(m, dev, true); out.push(m); return; }
        case MSG.DEVICE_INFO: {
          const m = cloneMsg(orig);
          if (getRaw(m, 0) === 0) applyDevice(m, dev, false);
          out.push(m);
          return;
        }
        default: out.push(orig);
      }
    });
    if (!recDone) out.push(...recMsgs);
    if (!lapDone) out.push(...lapMsgs);
  } else {
    const d = dev || { manufacturer: 255, product: 0, productName: 'RunSync' };
    const fid = newMsg(MSG.FILE_ID);
    set(fid, 0, 4); set(fid, 1, d.manufacturer); if (d.product != null) set(fid, 2, d.product);
    set(fid, 3, 1); set(fid, 4, fitTime(tStart)); if (d.productName) set(fid, 8, d.productName);
    out.push(fid);
    const di = newMsg(MSG.DEVICE_INFO);
    set(di, 253, fitTime(tStart)); set(di, 0, 0); set(di, 2, d.manufacturer); if (d.product != null) set(di, 4, d.product);
    set(di, 5, 1); if (d.productName) set(di, 27, d.productName);
    out.push(di);
    const sp = newMsg(MSG.SPORT); set(sp, 0, 1); set(sp, 1, subSport); set(sp, 3, 'Treadmill'); out.push(sp);
    const ev0 = newMsg(MSG.EVENT); set(ev0, 253, fitTime(tStart)); set(ev0, 0, 0); set(ev0, 1, 0); out.push(ev0);
    out.push(...recMsgs);
    const ev1 = newMsg(MSG.EVENT); set(ev1, 253, fitTime(tEnd)); set(ev1, 0, 0); set(ev1, 1, 4); out.push(ev1);
    out.push(...lapMsgs);
    const ss = newMsg(MSG.SESSION);
    set(ss, 254, 0); set(ss, 0, 8); set(ss, 1, 1); set(ss, 5, 1); set(ss, 6, subSport); set(ss, 28, 0);
    if (res.summary.calories != null) set(ss, 11, res.summary.calories);
    updateSession(ss, res);
    out.push(ss);
    const ac = newMsg(MSG.ACTIVITY);
    set(ac, 253, fitTime(tEnd)); set(ac, 0, (tEnd - tStart) / 1000); set(ac, 1, 1); set(ac, 2, 0); set(ac, 3, 26); set(ac, 4, 1);
    set(ac, 5, fitTime(tEnd) - new Date(tEnd).getTimezoneOffset() * 60);
    out.push(ac);
  }
  const hasDev = out.some(m => m.dev.length);
  return encodeFit(out, { protocol: hasDev ? 0x20 : (watch.fit?.protocol || 0x20), profile: 2171 });
}
