// RunSync — minimal, lossless FIT decoder / encoder.
// Messages are kept as raw field bytes so anything we don't touch
// (developer fields, vendor messages, running dynamics…) round-trips byte-exact.

export const FIT_EPOCH_MS = 631065600000; // 1989-12-31T00:00:00Z

const BASE = [
  { name: 'enum', size: 1 },     // 0x00
  { name: 'sint8', size: 1 },    // 0x01
  { name: 'uint8', size: 1 },    // 0x02
  { name: 'sint16', size: 2 },   // 0x83
  { name: 'uint16', size: 2 },   // 0x84
  { name: 'sint32', size: 4 },   // 0x85
  { name: 'uint32', size: 4 },   // 0x86
  { name: 'string', size: 1 },   // 0x07
  { name: 'float32', size: 4 },  // 0x88
  { name: 'float64', size: 8 },  // 0x89
  { name: 'uint8z', size: 1 },   // 0x0A
  { name: 'uint16z', size: 2 },  // 0x8B
  { name: 'uint32z', size: 4 },  // 0x8C
  { name: 'byte', size: 1 },     // 0x0D
  { name: 'sint64', size: 8 },   // 0x8E
  { name: 'uint64', size: 8 },   // 0x8F
  { name: 'uint64z', size: 8 },  // 0x90
];
const INVALID = [0xFF, 0x7F, 0xFF, 0x7FFF, 0xFFFF, 0x7FFFFFFF, 0xFFFFFFFF, 0, null, null, 0, 0, 0, 0xFF, null, null, null];
const RANGE = [[0, 254], [-127, 126], [0, 254], [-32767, 32766], [0, 65534], [-2147483647, 2147483646], [0, 4294967294]];

export const BT = {
  enum: 0x00, sint8: 0x01, uint8: 0x02, sint16: 0x83, uint16: 0x84, sint32: 0x85, uint32: 0x86,
  string: 0x07, float32: 0x88, float64: 0x89, uint8z: 0x0A, uint16z: 0x8B, uint32z: 0x8C, byte: 0x0D,
};

// Subset of the FIT profile that RunSync reads or writes: [baseType, scale, offset]
export const PROFILE = {
  0: { 0: [BT.enum], 1: [BT.uint16], 2: [BT.uint16], 3: [BT.uint32z], 4: [BT.uint32], 5: [BT.uint16], 8: [BT.string] }, // file_id
  12: { 0: [BT.enum], 1: [BT.enum], 3: [BT.string] }, // sport
  18: { // session
    254: [BT.uint16], 253: [BT.uint32], 0: [BT.enum], 1: [BT.enum], 2: [BT.uint32], 5: [BT.enum], 6: [BT.enum],
    7: [BT.uint32, 1000], 8: [BT.uint32, 1000], 9: [BT.uint32, 100], 10: [BT.uint32], 11: [BT.uint16],
    14: [BT.uint16, 1000], 15: [BT.uint16, 1000], 16: [BT.uint8], 17: [BT.uint8], 18: [BT.uint8], 19: [BT.uint8],
    25: [BT.uint16], 26: [BT.uint16], 28: [BT.enum], 59: [BT.uint32, 1000], 64: [BT.uint8],
    89: [BT.uint16, 10], 91: [BT.uint16, 10], 92: [BT.uint8, 128], 124: [BT.uint32, 1000], 125: [BT.uint32, 1000],
    132: [BT.uint16, 100], 134: [BT.uint16, 10],
  },
  19: { // lap
    254: [BT.uint16], 253: [BT.uint32], 0: [BT.enum], 1: [BT.enum], 2: [BT.uint32], 7: [BT.uint32, 1000],
    8: [BT.uint32, 1000], 9: [BT.uint32, 100], 10: [BT.uint32], 11: [BT.uint16], 13: [BT.uint16, 1000],
    14: [BT.uint16, 1000], 15: [BT.uint8], 16: [BT.uint8], 17: [BT.uint8], 18: [BT.uint8], 23: [BT.enum],
    24: [BT.enum], 25: [BT.enum], 39: [BT.enum], 63: [BT.uint8], 71: [BT.uint16], 77: [BT.uint16, 10],
    79: [BT.uint16, 10], 80: [BT.uint8, 128], 110: [BT.uint32, 1000], 111: [BT.uint32, 1000],
    118: [BT.uint16, 100], 120: [BT.uint16, 10],
  },
  20: { // record
    253: [BT.uint32], 0: [BT.sint32], 1: [BT.sint32], 2: [BT.uint16, 5, 500], 3: [BT.uint8], 4: [BT.uint8],
    5: [BT.uint32, 100], 6: [BT.uint16, 1000], 7: [BT.uint16], 13: [BT.sint8], 39: [BT.uint16, 10],
    41: [BT.uint16, 10], 53: [BT.uint8, 128], 73: [BT.uint32, 1000], 78: [BT.uint32, 5, 500],
    83: [BT.uint16, 100], 85: [BT.uint16, 10],
  },
  21: { 253: [BT.uint32], 0: [BT.enum], 1: [BT.enum], 3: [BT.uint32], 4: [BT.uint8] }, // event
  23: { 253: [BT.uint32], 0: [BT.uint8], 1: [BT.uint8], 2: [BT.uint16], 3: [BT.uint32z], 4: [BT.uint16], 5: [BT.uint16, 100], 27: [BT.string] }, // device_info
  34: { 253: [BT.uint32], 0: [BT.uint32, 1000], 1: [BT.uint16], 2: [BT.enum], 3: [BT.enum], 4: [BT.enum], 5: [BT.uint32] }, // activity
};

export const MSG = { FILE_ID: 0, SPORT: 12, SESSION: 18, LAP: 19, RECORD: 20, EVENT: 21, DEVICE_INFO: 23, ACTIVITY: 34 };

// ---------- CRC ----------
const CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
export function crc16(bytes, start = 0, end = bytes.length, crc = 0) {
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    let tmp = CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xF];
    tmp = CRC_TABLE[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xF];
  }
  return crc;
}

// ---------- value helpers ----------
const utf8d = new TextDecoder('utf-8');
const utf8e = new TextEncoder();

function readOne(dv, off, bt, le) {
  switch (bt & 0x1F) {
    case 0: case 2: case 10: case 13: case 7: return dv.getUint8(off);
    case 1: return dv.getInt8(off);
    case 3: return dv.getInt16(off, le);
    case 4: case 11: return dv.getUint16(off, le);
    case 5: return dv.getInt32(off, le);
    case 6: case 12: return dv.getUint32(off, le);
    case 8: { const v = dv.getFloat32(off, le); return Number.isFinite(v) ? v : null; }
    case 9: { const v = dv.getFloat64(off, le); return Number.isFinite(v) ? v : null; }
    case 14: return Number(dv.getBigInt64(off, le));
    case 15: case 16: return Number(dv.getBigUint64(off, le));
    default: return dv.getUint8(off);
  }
}

export function fieldValue(f, arch = 0) {
  const idx = f.bt & 0x1F;
  if (idx === 7) {
    let end = f.bytes.indexOf(0);
    if (end < 0) end = f.bytes.length;
    return end ? utf8d.decode(f.bytes.subarray(0, end)) : null;
  }
  const b = BASE[idx] || BASE[13];
  const n = Math.max(1, Math.floor(f.size / b.size));
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
  const le = arch === 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    if ((i + 1) * b.size > f.bytes.length) break;
    let v = readOne(dv, i * b.size, f.bt, le);
    if (v === INVALID[idx]) v = null;
    out.push(v);
  }
  return n === 1 ? out[0] : out;
}

export function encodeValue(bt, value, le = true, size) {
  const idx = bt & 0x1F;
  if (idx === 7) {
    const s = utf8e.encode(String(value ?? ''));
    const len = Math.max(size || 0, s.length + 1);
    const out = new Uint8Array(len);
    out.set(s.subarray(0, len - 1));
    return out;
  }
  const b = BASE[idx] || BASE[13];
  const vals = Array.isArray(value) ? value : [value];
  const n = Math.max(vals.length, size ? Math.floor(size / b.size) : 1);
  const out = new Uint8Array(n * b.size);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    let v = i < vals.length ? vals[i] : null;
    const off = i * b.size;
    if (v == null || Number.isNaN(v)) {
      if (idx === 8) dv.setUint32(off, 0xFFFFFFFF, le);
      else if (idx === 9 || idx >= 14) { dv.setUint32(off, 0xFFFFFFFF, le); dv.setUint32(off + 4, 0xFFFFFFFF, le); }
      else writeInt(dv, off, idx, INVALID[idx], le);
      continue;
    }
    if (idx === 8) { dv.setFloat32(off, v, le); continue; }
    if (idx === 9) { dv.setFloat64(off, v, le); continue; }
    if (idx >= 14) { idx === 14 ? dv.setBigInt64(off, BigInt(Math.round(v)), le) : dv.setBigUint64(off, BigInt(Math.max(0, Math.round(v))), le); continue; }
    v = Math.round(v);
    const r = RANGE[idx];
    if (r) v = Math.min(r[1], Math.max(r[0], v));
    writeInt(dv, off, idx, v, le);
  }
  return out;
}
function writeInt(dv, off, idx, v, le) {
  switch (idx) {
    case 0: case 2: case 10: case 13: dv.setUint8(off, v & 0xFF); break;
    case 1: dv.setInt8(off, v); break;
    case 3: dv.setInt16(off, v, le); break;
    case 4: case 11: dv.setUint16(off, v & 0xFFFF, le); break;
    case 5: dv.setInt32(off, v, le); break;
    case 6: case 12: dv.setUint32(off, v >>> 0, le); break;
  }
}

// ---------- message helpers ----------
export function newMsg(num) { return { num, arch: 0, fields: [], dev: [] }; }

export function cloneMsg(m) {
  return {
    num: m.num, arch: m.arch,
    fields: m.fields.map(f => ({ num: f.num, bt: f.bt, size: f.size, bytes: f.bytes.slice() })),
    dev: m.dev.map(f => ({ num: f.num, devIdx: f.devIdx, size: f.size, bytes: f.bytes.slice() })),
  };
}

export function has(m, num) { return m.fields.some(f => f.num === num); }

export function getRaw(m, num) {
  const f = m.fields.find(x => x.num === num);
  return f ? fieldValue(f, m.arch) : null;
}

/** scaled value using the profile (or explicit scale/offset). */
export function get(m, num, scale, offset) {
  const v = getRaw(m, num);
  if (v == null) return null;
  const spec = PROFILE[m.num]?.[num] || [];
  const s = scale ?? spec[1] ?? 1, o = offset ?? spec[2] ?? 0;
  if (Array.isArray(v)) return v.map(x => (x == null ? null : x / s - o));
  if (typeof v === 'string') return v;
  return v / s - o;
}

export function set(m, num, value, spec) {
  spec = spec || PROFILE[m.num]?.[num];
  const i = m.fields.findIndex(x => x.num === num);
  if (value == null) { if (i >= 0) m.fields.splice(i, 1); return; }
  if (!spec && i < 0) throw new Error(`No profile entry for msg ${m.num} field ${num}`);
  const f = i >= 0 ? m.fields[i] : null;
  const bt = f ? f.bt : spec[0];
  const scale = spec?.[1] ?? 1, offset = spec?.[2] ?? 0;
  const raw = typeof value === 'string' ? value : (value + offset) * scale;
  const keepSize = f && (bt & 0x1F) !== 7 ? f.size : undefined;
  const bytes = encodeValue(bt, raw, m.arch === 0, keepSize);
  if (f) { f.bytes = bytes; f.size = bytes.length; }
  else m.fields.push({ num, bt, size: bytes.length, bytes });
}

export const fitTime = ms => Math.round((ms - FIT_EPOCH_MS) / 1000);
export const unixMs = fitTs => fitTs * 1000 + FIT_EPOCH_MS;

// ---------- decoder ----------
export function decodeFit(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length < 12) throw new Error('File too small to be a FIT file');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerSize = u8[0];
  const sig = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  if (sig !== '.FIT') throw new Error('Not a FIT file (missing .FIT signature)');
  const protocol = u8[1];
  const profile = dv.getUint16(2, true);
  const dataSize = dv.getUint32(4, true);
  let pos = headerSize;
  const end = Math.min(u8.length - 2, headerSize + dataSize);
  const defs = new Array(16);
  const messages = [];
  let lastTs = 0;

  while (pos < end) {
    const h = u8[pos++];
    if ((h & 0x80) === 0 && (h & 0x40)) {
      // definition
      const hasDev = (h & 0x20) !== 0;
      const local = h & 0x0F;
      const arch = u8[pos + 1];
      const le = arch === 0;
      const num = dv.getUint16(pos + 2, le);
      const nf = u8[pos + 4];
      pos += 5;
      const fields = [];
      for (let i = 0; i < nf; i++) { fields.push({ num: u8[pos], size: u8[pos + 1], bt: u8[pos + 2] }); pos += 3; }
      const dev = [];
      if (hasDev) {
        const nd = u8[pos++];
        for (let i = 0; i < nd; i++) { dev.push({ num: u8[pos], size: u8[pos + 1], devIdx: u8[pos + 2] }); pos += 3; }
      }
      defs[local] = { num, arch, fields, dev };
      continue;
    }
    let local, compressedTs = null;
    if (h & 0x80) {
      local = (h >> 5) & 0x03;
      const off = h & 0x1F;
      compressedTs = lastTs + ((off - (lastTs & 0x1F)) & 0x1F);
      lastTs = compressedTs;
    } else local = h & 0x0F;
    const def = defs[local];
    if (!def) throw new Error(`Corrupt FIT: data message for undefined local type ${local} at byte ${pos - 1}`);
    const m = { num: def.num, arch: def.arch, fields: [], dev: [] };
    for (const fd of def.fields) {
      const bytes = u8.slice(pos, pos + fd.size);
      pos += fd.size;
      m.fields.push({ num: fd.num, bt: fd.bt, size: fd.size, bytes });
    }
    for (const dd of def.dev) {
      const bytes = u8.slice(pos, pos + dd.size);
      pos += dd.size;
      m.dev.push({ num: dd.num, devIdx: dd.devIdx, size: dd.size, bytes });
    }
    if (compressedTs != null && !has(m, 253)) set(m, 253, compressedTs, [BT.uint32]);
    else {
      const ts = getRaw(m, 253);
      if (typeof ts === 'number') lastTs = ts;
    }
    messages.push(m);
  }
  return { protocol, profile, messages };
}

// ---------- encoder ----------
export function encodeFit(messages, { protocol = 0x20, profile = 2171 } = {}) {
  const chunks = [];
  let size = 0;
  const push = arr => { chunks.push(arr); size += arr.length; };
  const sigToLocal = new Map();
  const localSig = new Array(16);
  let next = 0;

  for (const m of messages) {
    const sig = `${m.num}|${m.arch}|${m.fields.map(f => `${f.num}:${f.size}:${f.bt}`).join(',')}|${m.dev.map(f => `${f.num}:${f.size}:${f.devIdx}`).join(',')}`;
    let local = sigToLocal.get(sig);
    if (local === undefined) {
      local = next; next = (next + 1) % 16;
      if (localSig[local]) sigToLocal.delete(localSig[local]);
      localSig[local] = sig; sigToLocal.set(sig, local);
      const hasDev = m.dev.length > 0;
      const def = new Uint8Array(6 + m.fields.length * 3 + (hasDev ? 1 + m.dev.length * 3 : 0));
      def[0] = 0x40 | (hasDev ? 0x20 : 0) | local;
      def[1] = 0; def[2] = m.arch;
      if (m.arch === 0) { def[3] = m.num & 0xFF; def[4] = m.num >> 8; } else { def[3] = m.num >> 8; def[4] = m.num & 0xFF; }
      def[5] = m.fields.length;
      let p = 6;
      for (const f of m.fields) { def[p++] = f.num; def[p++] = f.size; def[p++] = f.bt; }
      if (hasDev) {
        def[p++] = m.dev.length;
        for (const f of m.dev) { def[p++] = f.num; def[p++] = f.size; def[p++] = f.devIdx; }
      }
      push(def);
    }
    let len = 1;
    for (const f of m.fields) len += f.size;
    for (const f of m.dev) len += f.size;
    const data = new Uint8Array(len);
    data[0] = local;
    let p = 1;
    for (const f of m.fields) { data.set(f.bytes.subarray(0, f.size), p); p += f.size; }
    for (const f of m.dev) { data.set(f.bytes.subarray(0, f.size), p); p += f.size; }
    push(data);
  }

  const out = new Uint8Array(14 + size + 2);
  const dv = new DataView(out.buffer);
  out[0] = 14; out[1] = protocol;
  dv.setUint16(2, profile, true);
  dv.setUint32(4, size, true);
  out[8] = 0x2E; out[9] = 0x46; out[10] = 0x49; out[11] = 0x54;
  dv.setUint16(12, crc16(out, 0, 12), true);
  let p = 14;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  dv.setUint16(p, crc16(out, 0, p), true);
  return out;
}
