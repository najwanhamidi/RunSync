// RunSync — file readers (FIT / TCX / GPX / CSV) into one normalised activity model,
// plus TCX / GPX / CSV writers.
import { decodeFit, get, getRaw, unixMs, MSG } from './fit.js';

const SEMI = 180 / 2 ** 31;

/**
 * Activity = {
 *   kind, name, fit, relativeTime,
 *   records: [{ t(ms), speed(m/s), dist(m), hr, cad(strides/min), fcad, power, alt, lat, lon, vo(mm), st(ms), vr(%), sl(mm), temp, msg }],
 *   laps: [{ start(ms), end(ms), dist }], session: {...}, device: {manufacturer, product, productName}, sport, subSport
 * }
 */
export async function readActivityFile(file) {
  const name = file.name || 'file';
  const ext = name.split('.').pop().toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  return parseActivity(buf, name, ext);
}

export function parseActivity(buf, name, ext) {
  ext = (ext || name.split('.').pop() || '').toLowerCase();
  const head = String.fromCharCode(...buf.subarray(8, 12));
  if (ext === 'fit' || head === '.FIT') return fitToActivity(decodeFit(buf), name);
  const text = new TextDecoder('utf-8').decode(buf);
  if (ext === 'tcx' || /<TrainingCenterDatabase/i.test(text.slice(0, 2000))) return tcxToActivity(text, name);
  if (ext === 'gpx' || /<gpx[\s>]/i.test(text.slice(0, 2000))) return gpxToActivity(text, name);
  if (ext === 'csv' || ext === 'txt') return csvToActivity(text, name);
  throw new Error(`Unsupported file type: ${name}`);
}

// ---------------- FIT ----------------
export function fitToActivity(fit, name) {
  const records = [];
  const laps = [];
  let session = null, sport = null, subSport = null;
  const device = {};
  let lastT = -Infinity;
  for (const m of fit.messages) {
    if (m.num === MSG.RECORD) {
      const ts = getRaw(m, 253);
      if (typeof ts !== 'number') continue;
      const t = unixMs(ts);
      if (t <= lastT) continue; // keep first record per timestamp, ignore out-of-order
      lastT = t;
      const lat = getRaw(m, 0), lon = getRaw(m, 1);
      records.push({
        t,
        speed: get(m, 73) ?? get(m, 6),
        dist: get(m, 5),
        hr: getRaw(m, 3),
        cad: getRaw(m, 4),
        fcad: get(m, 53),
        power: getRaw(m, 7),
        alt: get(m, 78) ?? get(m, 2),
        lat: lat != null ? lat * SEMI : null,
        lon: lon != null ? lon * SEMI : null,
        vo: get(m, 39), st: get(m, 41), vr: get(m, 83), sl: get(m, 85), temp: getRaw(m, 13),
        msg: m,
      });
    } else if (m.num === MSG.LAP) {
      const st = getRaw(m, 2), el = get(m, 7) ?? get(m, 8);
      if (st != null) laps.push({ start: unixMs(st), end: unixMs(st) + (el || 0) * 1000, dist: get(m, 9) });
    } else if (m.num === MSG.SESSION && !session) {
      session = {
        distance: get(m, 9), elapsed: get(m, 7), timer: get(m, 8), calories: getRaw(m, 11),
        avgHr: getRaw(m, 16), maxHr: getRaw(m, 17), start: getRaw(m, 2) != null ? unixMs(getRaw(m, 2)) : null,
      };
      sport = getRaw(m, 5); subSport = getRaw(m, 6);
    } else if (m.num === MSG.FILE_ID) {
      device.manufacturer = getRaw(m, 1); device.product = getRaw(m, 2); device.productName = getRaw(m, 8);
    } else if (m.num === MSG.DEVICE_INFO && getRaw(m, 0) === 0 && !device.productName) {
      device.productName = getRaw(m, 27) || device.productName;
    } else if (m.num === MSG.SPORT && sport == null) {
      sport = getRaw(m, 0); subSport = getRaw(m, 1);
    }
  }
  fillSpeed(records);
  return { kind: 'fit', name, fit, records, laps, session: session || {}, device, sport, subSport };
}

// ---------------- XML helpers (regex based, works in browser + node) ----------------
const reTag = name => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
function tag(block, name) { const m = block && block.match(reTag(name)); return m ? m[1].trim() : null; }
function num(v) { if (v == null || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function blocks(text, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'gi');
  const out = []; let m;
  while ((m = re.exec(text))) out.push({ attrs: m[1] || '', body: m[2] || '' });
  return out;
}
const attr = (attrs, n) => { const m = attrs.match(new RegExp(`\\b${n}\\s*=\\s*"([^"]*)"`, 'i')); return m ? m[1] : null; };

// ---------------- TCX ----------------
export function tcxToActivity(text, name) {
  const records = [];
  for (const b of blocks(text, 'Trackpoint')) {
    const time = tag(b.body, 'Time');
    if (!time) continue;
    const t = Date.parse(time);
    if (!Number.isFinite(t) || (records.length && t <= records[records.length - 1].t)) continue;
    const pos = tag(b.body, 'Position');
    records.push({
      t,
      dist: num(tag(b.body, 'DistanceMeters')),
      hr: num(tag(tag(b.body, 'HeartRateBpm'), 'Value')),
      cad: num(tag(b.body, 'RunCadence')) ?? num(tag(b.body, 'Cadence')),
      speed: num(tag(b.body, 'Speed')),
      power: num(tag(b.body, 'Watts')),
      alt: num(tag(b.body, 'AltitudeMeters')),
      lat: pos ? num(tag(pos, 'LatitudeDegrees')) : null,
      lon: pos ? num(tag(pos, 'LongitudeDegrees')) : null,
    });
  }
  const laps = [];
  for (const b of blocks(text, 'Lap')) {
    const st = Date.parse(attr(b.attrs, 'StartTime'));
    const dur = num(tag(b.body, 'TotalTimeSeconds'));
    if (Number.isFinite(st)) laps.push({ start: st, end: st + (dur || 0) * 1000, dist: num(tag(b.body.replace(/<Track>[\s\S]*<\/Track>/i, ''), 'DistanceMeters')) });
  }
  const sportM = text.match(/<Activity\b[^>]*Sport="([^"]+)"/i);
  const creator = tag(text, 'Creator');
  fillSpeed(records);
  const totalDist = laps.reduce((a, l) => a + (l.dist || 0), 0);
  return {
    kind: 'tcx', name, fit: null, records, laps,
    session: { distance: totalDist || records.at(-1)?.dist || null },
    device: { productName: creator ? tag(creator, 'Name') : null },
    sport: sportM && /run/i.test(sportM[1]) ? 1 : null, subSport: null,
  };
}

// ---------------- GPX ----------------
export function gpxToActivity(text, name) {
  const records = [];
  let d = 0, prev = null;
  for (const b of blocks(text, 'trkpt')) {
    const time = tag(b.body, 'time');
    if (!time) continue;
    const t = Date.parse(time);
    if (!Number.isFinite(t) || (records.length && t <= records[records.length - 1].t)) continue;
    const lat = num(attr(b.attrs, 'lat')), lon = num(attr(b.attrs, 'lon'));
    if (prev && lat != null && prev.lat != null) d += haversine(prev.lat, prev.lon, lat, lon);
    const r = {
      t, lat, lon, alt: num(tag(b.body, 'ele')),
      hr: num(tag(b.body, 'hr')), cad: num(tag(b.body, 'cad')),
      speed: num(tag(b.body, 'speed')), power: num(tag(b.body, 'power')),
      dist: lat != null ? d : null,
    };
    records.push(r); prev = r;
  }
  fillSpeed(records);
  return { kind: 'gpx', name, fit: null, records, laps: [], session: { distance: records.at(-1)?.dist ?? null }, device: { productName: attr(text.match(/<gpx\b([^>]*)>/i)?.[1] || '', 'creator') }, sport: 1, subSport: null };
}

function haversine(la1, lo1, la2, lo2) {
  const R = 6371008.8, r = Math.PI / 180;
  const a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------- CSV ----------------
export function csvToActivity(text, name) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV has no data rows');
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const head = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const find = re => head.findIndex(h => re.test(h));
  const iTime = find(/^(timestamp|time|date|datetime|time_iso|timestamp_iso)$/);
  const iEl = find(/elapsed|^sec|seconds|^t$|duration/);
  const iSpeed = find(/speed|km\/?h|kph/);
  const iPace = find(/pace/);
  const iDist = find(/dist/);
  const iHr = find(/heart|^hr$|bpm/);
  const iCad = find(/cad/);
  if (iTime < 0 && iEl < 0) throw new Error('CSV needs a time/timestamp or elapsed-seconds column');
  let relative = iTime < 0;
  const raw = [];
  for (const line of lines.slice(1)) {
    const c = line.split(sep).map(x => x.trim().replace(/^"|"$/g, ''));
    let t;
    if (!relative) {
      t = Date.parse(c[iTime]);
      if (!Number.isFinite(t)) { const n = num(c[iTime]); t = n != null ? (n > 1e11 ? n : n * 1000) : NaN; }
      if (!Number.isFinite(t)) continue;
    } else {
      const v = c[iEl];
      t = v && v.includes(':') ? parseClock(v) * 1000 : (num(v) ?? NaN) * 1000;
      if (!Number.isFinite(t)) continue;
    }
    let speed = iSpeed >= 0 ? num(c[iSpeed]) : null;
    if (speed == null && iPace >= 0) { const p = parseClock(c[iPace]); speed = p > 0 ? 1000 / p : null; }
    raw.push({ t, speed, dist: iDist >= 0 ? num(c[iDist]) : null, hr: iHr >= 0 ? num(c[iHr]) : null, cad: iCad >= 0 ? num(c[iCad]) : null });
  }
  if (iSpeed >= 0) {
    const h = head[iSpeed];
    let kmh = /km|kph/.test(h);
    if (!/m\/s|mps/.test(h) && !kmh) {
      const vals = raw.map(r => r.speed).filter(v => v > 0).sort((a, b) => a - b);
      kmh = vals.length && vals[Math.floor(vals.length / 2)] > 7.5;
    }
    if (kmh) raw.forEach(r => { if (r.speed != null) r.speed /= 3.6; });
  }
  if (iCad >= 0 && /spm|step/.test(head[iCad])) raw.forEach(r => { if (r.cad != null) r.cad /= 2; });
  raw.sort((a, b) => a.t - b.t);
  fillSpeed(raw);
  return { kind: 'csv', name, fit: null, records: raw, laps: [], session: {}, device: {}, sport: 1, subSport: null, relativeTime: relative };
}

export function parseClock(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  if (!s) return NaN;
  if (!s.includes(':')) return parseFloat(s);
  const p = s.split(':').map(Number);
  if (p.some(x => !Number.isFinite(x))) return NaN;
  return p.reduce((a, x) => a * 60 + x, 0);
}

/** derive speed from distance where speed is missing */
function fillSpeed(records) {
  const n = records.length;
  if (!n || records.every(r => r.speed != null)) return;
  for (let i = 0; i < n; i++) {
    if (records[i].speed != null) continue;
    const a = records[Math.max(0, i - 2)], b = records[Math.min(n - 1, i + 2)];
    if (a.dist != null && b.dist != null && b.t > a.t) records[i].speed = Math.max(0, (b.dist - a.dist) / ((b.t - a.t) / 1000));
  }
}

// ---------------- writers ----------------
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const f1 = v => (Math.round(v * 10) / 10).toString();
const f3 = v => (Math.round(v * 1000) / 1000).toString();

export function toTCX(result, { deviceName = 'RunSync', productId = 0, notes = '' } = {}) {
  const { records, laps } = result;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">');
  out.push(' <Activities>\n  <Activity Sport="Running">');
  out.push(`   <Id>${iso(records[0].t)}</Id>`);
  for (const lap of laps) {
    out.push(`   <Lap StartTime="${iso(lap.start)}">`);
    out.push(`    <TotalTimeSeconds>${f1(lap.duration)}</TotalTimeSeconds>`);
    out.push(`    <DistanceMeters>${f1(lap.distance)}</DistanceMeters>`);
    out.push(`    <MaximumSpeed>${f3(lap.maxSpeed || 0)}</MaximumSpeed>`);
    out.push(`    <Calories>${Math.round(lap.calories || 0)}</Calories>`);
    if (lap.avgHr) out.push(`    <AverageHeartRateBpm><Value>${Math.round(lap.avgHr)}</Value></AverageHeartRateBpm>`);
    if (lap.maxHr) out.push(`    <MaximumHeartRateBpm><Value>${Math.round(lap.maxHr)}</Value></MaximumHeartRateBpm>`);
    out.push(`    <Intensity>${lap.type === 'rest' ? 'Resting' : 'Active'}</Intensity>`);
    out.push(`    <TriggerMethod>${lap.trigger === 'distance' ? 'Distance' : 'Manual'}</TriggerMethod>`);
    out.push('    <Track>');
    for (let i = lap.i0; i < lap.i1; i++) {
      const r = records[i];
      out.push('     <Trackpoint>');
      out.push(`      <Time>${iso(r.t)}</Time>`);
      out.push(`      <DistanceMeters>${f1(r.dist)}</DistanceMeters>`);
      if (r.hr) out.push(`      <HeartRateBpm><Value>${Math.round(r.hr)}</Value></HeartRateBpm>`);
      out.push('      <Extensions><ns3:TPX>');
      out.push(`       <ns3:Speed>${f3(r.speed)}</ns3:Speed>`);
      if (r.cad != null) out.push(`       <ns3:RunCadence>${Math.round(r.cad)}</ns3:RunCadence>`);
      if (r.power != null) out.push(`       <ns3:Watts>${Math.round(r.power)}</ns3:Watts>`);
      out.push('      </ns3:TPX></Extensions>');
      out.push('     </Trackpoint>');
    }
    out.push('    </Track>');
    if (lap.name) out.push(`    <Notes>${esc(lap.name)}</Notes>`);
    out.push('    <Extensions><ns3:LX>');
    out.push(`     <ns3:AvgSpeed>${f3(lap.avgSpeed)}</ns3:AvgSpeed>`);
    if (lap.avgCad) out.push(`     <ns3:AvgRunCadence>${Math.round(lap.avgCad)}</ns3:AvgRunCadence>`);
    if (lap.maxCad) out.push(`     <ns3:MaxRunCadence>${Math.round(lap.maxCad)}</ns3:MaxRunCadence>`);
    out.push('    </ns3:LX></Extensions>');
    out.push('   </Lap>');
  }
  if (notes) out.push(`   <Notes>${esc(notes)}</Notes>`);
  out.push('   <Creator xsi:type="Device_t">');
  out.push(`    <Name>${esc(deviceName)}</Name><UnitId>0</UnitId><ProductID>${productId || 0}</ProductID>`);
  out.push('    <Version><VersionMajor>1</VersionMajor><VersionMinor>0</VersionMinor><BuildMajor>0</BuildMajor><BuildMinor>0</BuildMinor></Version>');
  out.push('   </Creator>');
  out.push('  </Activity>\n </Activities>\n</TrainingCenterDatabase>\n');
  return out.join('\n');
}

/** GPX has no way to store distance without coordinates, so treadmill runs get a
 *  virtual straight-line track (along the equator from 0°,0°) whose length equals the treadmill distance. */
export function toGPX(result, { deviceName = 'RunSync', name = 'Treadmill run' } = {}) {
  const { records } = result;
  const M_PER_DEG = 111194.93; // mean-radius metres per degree, matches haversine distance in Strava & co.
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<gpx version="1.1" creator="${esc(deviceName)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`);
  out.push(` <metadata><name>${esc(name)}</name><time>${iso(records[0].t)}</time></metadata>`);
  out.push(` <trk><name>${esc(name)}</name><type>running</type><trkseg>`);
  for (const r of records) {
    const lon = (r.dist / M_PER_DEG).toFixed(7);
    let ext = '';
    if (r.hr) ext += `<gpxtpx:hr>${Math.round(r.hr)}</gpxtpx:hr>`;
    if (r.cad != null) ext += `<gpxtpx:cad>${Math.round(r.cad)}</gpxtpx:cad>`;
    ext += `<gpxtpx:speed>${f3(r.speed)}</gpxtpx:speed>`;
    out.push(`  <trkpt lat="0.0000000" lon="${lon}"><time>${iso(r.t)}</time><extensions><gpxtpx:TrackPointExtension>${ext}</gpxtpx:TrackPointExtension></extensions></trkpt>`);
  }
  out.push(' </trkseg></trk>\n</gpx>\n');
  return out.join('\n');
}

export function toCSV(result) {
  const { records, laps } = result;
  const lapOf = new Array(records.length);
  laps.forEach((l, k) => { for (let i = l.i0; i < l.i1; i++) lapOf[i] = k; });
  const rows = ['timestamp,elapsed_s,distance_m,speed_kmh,pace_min_per_km,heart_rate,cadence_spm,step_length_mm,vertical_oscillation_mm,stance_time_ms,vertical_ratio_pct,power_w,lap,lap_type,lap_name,synthetic'];
  const t0 = records[0].t;
  records.forEach((r, i) => {
    const k = lapOf[i] ?? laps.length - 1;
    const pace = r.speed > 0.1 ? fmtPace(r.speed) : '';
    const spm = r.cad != null ? Math.round((r.cad + (r.fcad || 0)) * 2) : '';
    rows.push([iso(r.t), (r.t - t0) / 1000, r.dist.toFixed(2), (r.speed * 3.6).toFixed(2), pace, r.hr ?? '', spm, r.sl != null ? Math.round(r.sl) : '', r.vo ?? '', r.st ?? '', r.vr ?? '', r.power ?? '', k + 1, laps[k]?.type ?? '', `"${(laps[k]?.name ?? '').replace(/"/g, '')}"`, r.synthetic ? 1 : 0].join(','));
  });
  return rows.join('\n') + '\n';
}

export function lapsToCSV(result) {
  const rows = ['lap,name,type,start,duration_s,distance_m,avg_pace_min_per_km,avg_speed_kmh,max_speed_kmh,avg_hr,max_hr,avg_cadence_spm,avg_step_length_mm,calories'];
  result.laps.forEach((l, k) => rows.push([k + 1, `"${l.name}"`, l.type, iso(l.start), l.duration.toFixed(1), l.distance.toFixed(1), fmtPace(l.avgSpeed), (l.avgSpeed * 3.6).toFixed(2), ((l.maxSpeed || 0) * 3.6).toFixed(2), l.avgHr ?? '', l.maxHr ?? '', l.avgCad ? Math.round(l.avgCad * 2) : '', l.avgSl ? Math.round(l.avgSl) : '', l.calories ?? ''].join(',')));
  return rows.join('\n') + '\n';
}

export function fmtPace(speed) {
  if (!speed || speed <= 0.05) return '--:--';
  let s = Math.round(1000 / speed);
  const m = Math.floor(s / 60); s -= m * 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
