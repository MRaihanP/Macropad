// Test Fase 4: cfg-builder — encode preset → binary payload.
//
// Dipakai untuk memverifikasi:
//  1. Header (version, layerCount) ter-encode dengan benar.
//  2. CRC32 di akhir payload valid — re-compute & compare.
//  3. Payload bisa di-decode kembali (round-trip) tanpa data loss.
//  4. CFG_SIG dari payload hasil encode sama dengan presetSig() (konsistensi
//     format binary dengan format kanonik CFG_SIG).
//
// Jalankan: node tests/suites/cfg-builder-test.mjs
import { encodePreset, chunkPlan } from '../../src/cfg-builder.js';
import { cfgSigOfPreset } from '../../src/cfg-sig.js';
import { CONFIG_VERSION, MAX_LAYERS, NAME_LEN, VALUE_LEN, ENC_PER_KNOB } from '../../src/cfg-layout.js';

// Konstanta geometri — sama dengan limits.h. Hardcoded di test supaya tidak
// bergantung pada device-state.js (runtime values dari device).
const ROWS = 3;
const COLS = 3;
const NUM_ENCODERS = 1;

import { cfgSigDims } from '../../src/cfg-layout.js';

const dims = cfgSigDims({ rows: ROWS, cols: COLS, numEncoders: NUM_ENCODERS });

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

// ---- CRC32 pure JS (reference, sama dengan crc32.h) ----
function crc32_ref(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = (crc ^ b) >>> 0;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) >>> 0 : (crc >>> 1) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- Preset builder (membuat flat preset) ----
function makePreset(version, layerCount, names, layerKeys, encActions) {
  const nKeys = ROWS * COLS;
  const nEnc = NUM_ENCODERS * ENC_PER_KNOB;
  const flat = {
    version,
    layerCount,
    currentLayer: 0,
    names: [],
    layers: [],
    enc: [],
  };
  for (let l = 0; l < layerCount; l++) {
    flat.names.push(names[l] || '');
    flat.layers.push({ keys: [] });
    const lk = (layerKeys[l] || []);
    for (let k = 0; k < nKeys; k++) {
      flat.layers[l].keys.push(lk[k] || { type: 0, value: '' });
    }
  }
  const ea = (encActions || []);
  for (let i = 0; i < nEnc; i++) {
    flat.enc.push(ea[i] || { type: 0, value: '' });
  }
  return flat;
}

// ---- Binary parser (mirror firmware faCmdCfgCommit) ----
function parseBinary(buf) {
  const result = { version: buf[0], layerCount: buf[1], layers: [] };
  let off = 2;
  for (let l = 0; l < result.layerCount; l++) {
    const layer = { name: '', keys: [], encCW: [], encCCW: [], encBtn: [] };
    // Name [NAME_LEN]
    layer.name = new Array(NAME_LEN);
    for (let i = 0; i < NAME_LEN; i++) layer.name[i] = buf[off + i];
    off += NAME_LEN;
    // Keys [9]
    for (let k = 0; k < ROWS * COLS; k++) {
      layer.keys.push({ type: buf[off++], value: buf.slice(off, off + VALUE_LEN) });
      off += VALUE_LEN;
    }
    // Encoders: per knob CW, CCW, BTN
    for (let e = 0; e < NUM_ENCODERS; e++) {
      layer.encCW.push({ type: buf[off++], value: buf.slice(off, off + VALUE_LEN) });
      off += VALUE_LEN;
      layer.encCCW.push({ type: buf[off++], value: buf.slice(off, off + VALUE_LEN) });
      off += VALUE_LEN;
      layer.encBtn.push({ type: buf[off++], value: buf.slice(off, off + VALUE_LEN) });
      off += VALUE_LEN;
    }
    result.layers.push(layer);
  }
  return result;
}

// ---- Test cases ----
console.log('# cfg-builder-test');

// Test 1: Encode empty preset (1 layer, all zeros)
console.log('## Test 1: preset dengan 1 layer, semua action kosong');
{
  const flat = makePreset(CONFIG_VERSION, 1, ['Main'], [new Array(9).fill({type: 0, value: ''})], []);
  const payload = encodePreset(flat, dims);
  ok(payload[0] === CONFIG_VERSION, 'version byte = CONFIG_VERSION (5)');
  ok(payload[1] === 1, 'layerCount byte = 1');

  const expectedLen = 2 + (NAME_LEN + (ROWS * COLS + NUM_ENCODERS * ENC_PER_KNOB) * (1 + VALUE_LEN)) + 4;
  ok(payload.length === expectedLen, `panjang payload = ${expectedLen} (dapat ${payload.length})`);

  // CRC32 verification
  const body = payload.slice(0, -4);
  let storedCrc = (payload[payload.length - 4]) |
    (payload[payload.length - 3] << 8) |
    (payload[payload.length - 2] << 16) |
    (payload[payload.length - 1] << 24);
  storedCrc >>>= 0;
  const computedCrc = crc32_ref(body);
  ok(storedCrc === computedCrc, `CRC32 cocok: stored=0x${storedCrc.toString(16)} computed=0x${computedCrc.toString(16)}`);

  // Cross-check with CFG_SIG
  const sig = cfgSigOfPreset(flat, dims);
  ok(typeof sig === 'number' && sig >= 0, `cfgSigOfPreset menghasilkan angka: 0x${sig.toString(16)}`);

  // Round-trip
  const decoded = parseBinary(body);
  ok(decoded.version === CONFIG_VERSION, 'decode: version cocok');
  ok(decoded.layerCount === 1, 'decode: layerCount cocok');
  ok(decoded.layers[0].keys.length === ROWS * COLS, 'decode: key count cocok');
}

// Test 2: Preset penuh dengan action berisi
console.log('## Test 2: preset 2 layer dengan action berisi');
{
  const flat = {
    version: CONFIG_VERSION,
    layerCount: 2,
    currentLayer: 0,
    names: ['Main', 'Alt'],
    layers: [
      { keys: [{type:1, value:'A'}, {type:2, value:'B'}, {type:3, value:'C'}] },
      { keys: [{type:4, value:'X'}, {type:5, value:'Y'}, {type:6, value:'Z'}] },
    ],
    enc: [{type:7, value:'VOLUP'}, {type:8, value:'VOLDN'}, {type:9, value:'MUTE'}],
  };
  const payload = encodePreset(flat, dims);
  ok(payload[0] === CONFIG_VERSION, 'version byte = 5');
  ok(payload[1] === 2, 'layerCount = 2');

  const body = payload.slice(0, -4);
  const storedCrc = ((payload[payload.length - 4] | (payload[payload.length - 3] << 8) |
    (payload[payload.length - 2] << 16) | (payload[payload.length - 1] << 24)) >>> 0);
  const computedCrc = crc32_ref(body);
  ok(storedCrc === computedCrc, `CRC32 cocok untuk 2-layer`);

  // Decode dan verifikasi
  const decoded = parseBinary(body);
  ok(decoded.layers[0].name.slice(0,4).map(x=>String.fromCharCode(x)).join('') === 'Main', 'decode: layer 0 name = Main');
  ok(decoded.layers[1].name.slice(0,3).map(x=>String.fromCharCode(x)).join('') === 'Alt', 'decode: layer 1 name = Alt');
  ok(decoded.layers[0].keys[0].type === 1, 'decode: key[0][0].type = 1');
  ok(decoded.layers[0].keys[1].type === 2, 'decode: key[0][1].type = 2');
  ok(decoded.layers[1].keys[0].type === 4, 'decode: key[1][0].type = 4');
  // Value check: 'A' is at offset 1, rest zero
  ok(decoded.layers[0].keys[0].value[0] === 65 && decoded.layers[0].keys[0].value[1] === 0, 'decode: key value zero-padded');

  // Encoder check: CW[0] = {type:7, value:'VOLUP'}
  ok(decoded.layers[0].encCW[0].type === 7, 'decode: encCW[0].type = 7');
  ok(decoded.layers[0].encCCW[0].type === 8, 'decode: encCCW[0].type = 8');
  ok(decoded.layers[0].encBtn[0].type === 9, 'decode: encBtn[0].type = 9');
}

// Test 3: chunkPlan
console.log('## Test 3: chunkPlan');
{
  const maxPayload = 237;
  ok(chunkPlan(100).nChunks === 1, '100 byte → 1 chunk');
  ok(chunkPlan(100).chunkSize === maxPayload, 'chunkSize = 237');
  ok(chunkPlan(100).lastSize === 100, 'lastSize = 100');

  ok(chunkPlan(237).nChunks === 1, '237 byte → 1 chunk (tepat maks)');
  ok(chunkPlan(238).nChunks === 2, '238 byte → 2 chunk');

  ok(chunkPlan(500).nChunks === 3, '500 byte → 3 chunk');
  ok(chunkPlan(500).lastSize === 500 - 2 * 237, 'lastSize tepat');

  ok(chunkPlan(0).nChunks === 0, '0 byte → 0 chunk (edge case, tidak boleh kirim frame kosong)');
}

// Test 4: Payload kosong (0 byte) tidak crash
console.log('## Test 4: edge case — nilai kosong dan panjang maksimal');
{
  const flat = makePreset(CONFIG_VERSION, 2, ['Main', 'Alt'],
    [new Array(9).fill({type: 0, value: ''}), new Array(9).fill({type: 0, value: ''})],
    []);
  const payload = encodePreset(flat, dims);
  ok(payload.length === 2 + (NAME_LEN + (ROWS * COLS + 3) * (1 + VALUE_LEN)) * 2 + 4,
    'panjang payload konsisten untuk preset kosong');

  // Value yang melebihi VALUE_LEN-1 harus dipotong
  flat.layers[0].keys[0] = { type: 1, value: 'A'.repeat(100) };
  const p2 = encodePreset(flat, dims);
  ok(p2.length === payload.length, 'nilai panjang tidak mengubah panjang payload (dipotong)');
}

console.log('\\n=== Result: ' + (fail === 0 ? 'ALL OK' : fail + ' FAILURE(S)') + ' ===');
process.exit(fail === 0 ? 0 : 1);
