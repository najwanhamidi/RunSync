// Usage: node test/sample.test.js <watch-file> [treadmill-file] [targetKm] [outDir]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { parseActivity, toTCX, toGPX, toCSV, lapsToCSV } from '../js/formats.js';
import { sourceFromActivity, autoAlign, syncRun, detectRun, buildLaps, kmBounds, summarize, alignmentCheck, fmtDur, fmtPace, planFromDetection } from '../js/engine.js';
import { buildFit, resolveDevice } from '../js/export.js';
import { decodeFit } from '../js/fit.js';

const [watchPath, qzPath, targetKm = '12.2', outDir = 'test/out'] = process.argv.slice(2);
if (!watchPath) { console.log('usage: node test/sample.test.js watch.fit [qz.fit] [km] [outDir]'); process.exit(0); }
const load = p => parseActivity(new Uint8Array(readFileSync(p)), basename(p));
const watch = load(watchPath);
console.log('watch', watch.records.length, 'records', watch.laps.length, 'laps', watch.device);
const qz = load(qzPath);
const src = sourceFromActivity(qz);
const al = autoAlign(watch, src);
console.log('align', al, alignmentCheck(watch, src, al.offsetSec));
const res = syncRun({ watch, source: src, offsetSec: al.offsetSec, targetKm: +targetKm });
console.log('info', res.info);
const det = detectRun(res.records);
console.log('detected', det.type, det.label, det.segments.length, 'segments');
const cal = watch.session.calories;
res.laps = buildLaps(res.records, det.bounds.length ? det.bounds : kmBounds(res.records), { calories: cal });
res.lapMode = 'auto';
res.summary = summarize(res.records, cal);
for (const l of res.laps) console.log(l.name.padEnd(12), fmtDur(l.duration).padStart(6), (l.distance).toFixed(1).padStart(8), fmtPace(l.avgSpeed), l.avgHr, l.avgCad?.toFixed(1), l.avgSl?.toFixed(0));
console.log('summary', fmtDur(res.summary.duration), res.summary.distance, fmtPace(res.summary.avgSpeed));
console.log('plan', JSON.stringify(planFromDetection(det)));
mkdirSync(outDir, { recursive: true });
const fit = buildFit(res, watch, resolveDevice('trex3', watch));
writeFileSync(`${outDir}/merged.fit`, fit);
writeFileSync(`${outDir}/merged.tcx`, toTCX(res, { deviceName: 'Amazfit T-Rex 3' }));
writeFileSync(`${outDir}/merged.gpx`, toGPX(res));
writeFileSync(`${outDir}/merged.csv`, toCSV(res));
writeFileSync(`${outDir}/laps.csv`, lapsToCSV(res));
// re-read our own FIT
const back = load(`${outDir}/merged.fit`);
console.log('roundtrip', back.records.length, 'records', back.laps.length, 'laps', 'dist', back.records.at(-1).dist, back.session);
// lossless check: decode → encode unchanged
import('../js/fit.js').then(({ encodeFit }) => {
  const raw = new Uint8Array(readFileSync(watchPath));
  const dec = decodeFit(raw);
  const re = encodeFit(dec.messages, { protocol: dec.protocol, profile: dec.profile });
  const dec2 = decodeFit(re);
  const same = dec.messages.length === dec2.messages.length && dec.messages.every((m, i) => m.num === dec2.messages[i].num && m.fields.length === dec2.messages[i].fields.length && m.fields.every((f, j) => f.bytes.every((b, k) => b === dec2.messages[i].fields[j].bytes[k])));
  console.log('lossless re-encode of watch file:', same ? 'OK' : 'MISMATCH', raw.length, '→', re.length, 'bytes');
});
