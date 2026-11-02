#!/usr/bin/env node
// =================== VIRTUAL DEVICE (simulator BLE) ===================
//
// Simulator device BLE dalam TypeScript/JavaScript. Meniru perilaku device
// yang sudah selesai di-flash firmware, termasuk:
//
//   - Parser frame v2 (mirror firmware/common/frame_asm.h)
//   - Handler perintah frame (HELLO / CFG_QUERY / CFG_ACTIVATE / LINE)
//   - Perhitungan CFG_SIG (mirror firmware/common/cfg_sig.h)
//   - Mode dual: baris <-> frame lewat auto-detect faRoute()
//   - Fault injection untuk testing L1-L3 (CRC rusak, LEN overflow, dsb.)
//
// Digunakan oleh strategi pengujian L1-L3 untuk memverifikasi app behavior
// tanpa hardware.
//
// Jalankan: node tests/virtual-device.mjs
//
import { pathToFileURL } from 'node:url';
import { FrameDecoder, encode, SOF, VER, T_HELLO, T_CFG_QUERY, T_CFG_ACTIVATE,
         T_CFG_BEGIN, T_CFG_WRITE, T_CFG_COMMIT, T_LINE, T_EVT, T_ERR,
         T_HELLO_RSP, T_CFG_META, T_CFG_ACT_RSP, RESP_BIT } from '../src/frame-codec.js';
import { cfgSigOfPreset } from '../src/cfg-sig.js';
import { CONFIG_VERSION, APP_SLOTS, MAX_LAYERS, NAME_LEN, VALUE_LEN,
         ENC_PER_KNOB, cfgSigDims } from '../src/cfg-layout.js';

// ------------------------------------------------------------------
// Konstanta error (mirror firmware/common/frame.h)
// ------------------------------------------------------------------
const ERR_UNSUPPORTED = 0x16;

// ------------------------------------------------------------------
// State device yang disimulasikan
// ------------------------------------------------------------------

/** @type {{slots: Array<{version:number,layerCount:number,sig:uint32,valid:boolean,activeSlot:number}>>} */
const deviceState = {
  fwVersion: 5,
  rows: 3,
  cols: 3,
  numEncoders: 1,
  maxPayload: 247,  // typ. BLE MTU - 3 - overhead
  slots: Array.from({ length: APP_SLOTS }, (_, i) => ({
    version: CONFIG_VERSION,
    layerCount: 0,
    keyLayers: [],
    encoders: [],
    name: '',
  })),
  activeSlot: 0xff,  // 0xFF = Default/App preset
  mode: 'line',      // 'line' | 'frame'
  rxStats: { frames: 0, crcErr: 0, verErr: 0, lenErr: 0, unsup: 0 },
  txStats: { frames: 0, dropped: 0 },
  fault: null,       // { type: 'crc'|'ver'|'len', frameIndex?: number }
};

// ------------------------------------------------------------------
// CFG_SIG computation (mirror firmware/common/cfg_sig.h)
// ------------------------------------------------------------------

/**
 * Hitung CFG_SIG dari slot device.
 * Bentuk kanonik: version, layerCount, currentLayer, lalu per layer
 * name (nameLen byte) + tiap key (type + valueLen byte) + encoder binding.
 */
function computeSlotSig(slot, currentLayer) {
  let crc = 0xffffffff;
  const update = (b) => {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) >>> 0 : (crc >>> 1) >>> 0;
    }
  };

  // Header: version, layerCount, currentLayer
  update(slot.version & 0xff);
  update(slot.layerCount & 0xff);
  update(currentLayer & 0xff);

  // Per layer
  for (let l = 0; l < MAX_LAYERS; l++) {
    const layer = slot.keyLayers[l] || null;
    // Nama layer: nameLen byte (padding nol)
    const nameBytes = new Array(NAME_LEN).fill(0);
    if (layer?.name) {
      const s = Buffer.from(layer.name, 'latin1');
      for (let i = 0; i < Math.min(NAME_LEN, s.length); i++) nameBytes[i] = s[i];
    }
    nameBytes.forEach(update);

    // Keys per layer: rows * cols
    const nKeys = deviceState.rows * deviceState.cols;
    for (let k = 0; k < nKeys; k++) {
      const key = layer?.keys?.[k] || { type: 0, value: '' };
      update(key.type & 0xff);
      const valBytes = new Array(VALUE_LEN).fill(0);
      const v = Buffer.from(String(key.value || ''), 'latin1').slice(0, VALUE_LEN - 1);
      for (let i = 0; i < v.length; i++) valBytes[i] = v[i];
      valBytes.forEach(update);
    }
  }

  // Encoder bindings (dari layer terakhir, CW/CCW/BTN per knob)
  const nEnc = deviceState.numEncoders * ENC_PER_KNOB;
  for (let i = 0; i < nEnc; i++) {
    const enc = slot.encoders[i] || { type: 0, value: '' };
    update(enc.type & 0xff);
    const valBytes = new Array(VALUE_LEN).fill(0);
    const v = Buffer.from(String(enc.value || ''), 'latin1').slice(0, VALUE_LEN - 1);
    for (let i = 0; i < v.length; i++) valBytes[i] = v[i];
    valBytes.forEach(update);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function sigHex(sig) {
  return (sig >>> 0).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------
// Frame handler - meniru firmware/common/frame_proto.h
// ------------------------------------------------------------------

/** @param {number[]} payload  */
function handleHello(payload) {
  // Device bisa menerima HELLO kosong (probe) atau dengan payload app version
  const resp = [
    VER,                           // firmware version
    deviceState.rows,
    deviceState.cols,
    deviceState.numEncoders,
    deviceState.maxPayload & 0xff, (deviceState.maxPayload >> 8) & 0xff,
    APP_SLOTS,
    MAX_LAYERS,
    faActiveSlot(),
  ];
  return { type: T_HELLO_RSP, payload: resp };
}

function handleCfgQuery(payload) {
  const activeSlot = faActiveSlot();
  const resp = [activeSlot];
  for (let i = 0; i < APP_SLOTS; i++) {
    const slot = deviceState.slots[i];
    const sig = slot.layerCount > 0 ? computeSlotSig(slot, slot.layerCount - 1) : 0;
    resp.push(
      sig & 0xff, (sig >> 8) & 0xff, (sig >> 16) & 0xff, (sig >> 24) & 0xff,
      slot.layerCount,
      slot.layerCount > 0 ? 1 : 0,  // valid
    );
  }
  return { type: T_CFG_META, payload: resp };
}

function handleCfgActivate(payload) {
  if (payload.length < 1) {
    return { type: T_ERR, payload: [T_CFG_ACTIVATE, ERR_UNSUPPORTED] };
  }
  const slot = payload[0];
  if (slot >= APP_SLOTS) {
    return {
      type: T_CFG_ACT_RSP,
      payload: [ERR_UNSUPPORTED, 0, 0, 0, 0, faActiveSlot()],
    };
  }
  deviceState.activeSlot = slot;
  const slotObj = deviceState.slots[slot];
  const sig = slotObj.layerCount > 0
    ? computeSlotSig(slotObj, Math.min(slotObj.layerCount - 1, slotObj.layerCount))
    : 0;
  return {
    type: T_CFG_ACT_RSP,
    payload: [0, sig & 0xff, (sig >> 8) & 0xff, (sig >> 16) & 0xff, (sig >> 24) & 0xff, slot],
  };
}

function handleLine(payload) {
  // LINE adalah escape hatch: jalankan sebagai perintah teks lalu balas dengan
  // hasilnya. Simulasi sederhana: akui apapun.
  const txt = Buffer.from(payload.slice(0, 255)).toString('latin1');
  const resp = Buffer.from(`[LINE] ${txt.slice(0, 60)}`);
  return { type: T_LINE, payload: Array.from(resp) };
}

function faActiveSlot() {
  if (deviceState.activeSlot === 0xff) return 0xff;
  return deviceState.activeSlot < APP_SLOTS ? deviceState.activeSlot : 0;
}

/**
 * Proses satu frame yang sudah didecode perakit.
 * Mengembalikan frame jawaban (type + payload) atau null kalau tidak ada jawaban.
 */
function handleFrame(frame) {
  deviceState.rxStats.frames++;

  switch (frame.type) {
    case T_HELLO:
      return handleHello(frame.payload);
    case T_CFG_QUERY:
      return handleCfgQuery(frame.payload);
    case T_CFG_ACTIVATE:
      return handleCfgActivate(frame.payload);
    case T_LINE:
      return handleLine(frame.payload);
    case T_CFG_BEGIN:
    case T_CFG_WRITE:
    case T_CFG_COMMIT:
      // Belum diimplementasikan di fase ini - device menjawab UNSUPPORTED.
      deviceState.rxStats.unsup++;
      return { type: T_ERR, payload: [frame.type, ERR_UNSUPPORTED] };
    default:
      deviceState.rxStats.unsup++;
      return { type: T_ERR, payload: [frame.type, ERR_UNSUPPORTED] };
  }
}

// ------------------------------------------------------------------
// Auto-detect dual mode (mirror firmware frame_asm.h:faRoute)
// ------------------------------------------------------------------

function routeByte(b) {
  if (deviceState.mode === 'frame') {
    // 0x0A hanya berarti "balik ke mode baris" saat perakit IDLE.
    // Kita sederhanakan: karena device hanya merespon frame, perakit idle
    // saat tidak ada frame yang sedang dibangun.
    if (b === 0x0a) {
      deviceState.mode = 'line';
      return 'to_line';
    }
    return 'frame';
  }
  // Mode baris: 0xA5 di awal baris baru -> mode frame.
  if (b === SOF) {
    deviceState.mode = 'frame';
    return 'frame';
  }
  return 'line';
}

// ------------------------------------------------------------------
// Fault injection
// ------------------------------------------------------------------

/**
 * Atur injection fault untuk frame ke-N.
 * @param {number} frameIndex  indeks frame (0-based) yang harus rusakkan
 * @param {'crc'|'ver'|'len'}  jenis fault
 */
function injectFault(frameIndex, faultType) {
  deviceState.fault = { type: faultType, frameIndex };
}

function clearFault() {
  deviceState.fault = null;
}

let frameCounter = 0;
function checkAndApplyFault(frameBytes) {
  if (!deviceState.fault) return frameBytes;
  if (frameCounter !== deviceState.fault.frameIndex) return frameBytes;

  frameCounter++;
  const corrupted = [...frameBytes];
  switch (deviceState.fault.type) {
    case 'crc':
      // Balikkan bit terakhir dari byte CRC paling akhir.
      if (corrupted.length >= 2) {
        corrupted[corrupted.length - 1] ^= 0x01;
      }
      return corrupted;
    case 'ver':
      // Ganti byte VER.
      if (corrupted.length >= 2) corrupted[1] = 0xff;
      return corrupted;
    case 'len':
      // LEN > MAX_PAYLOAD: set LEN high byte = 0x02 (256+).
      if (corrupted.length >= 5) corrupted[4] = 0x02;
      return corrupted;
    default:
      return corrupted;
  }
}

// ------------------------------------------------------------------
// Public API - apa yang dipakai test suite
// ------------------------------------------------------------------

/**
 * Simulasikan device menerima stream byte dan kirimkan ke stream keluar.
 *
 * @param {number[]} bytes  byte yang dikirim ke device
 * @returns {{lines: string[], frames: Array<{type:number, payload:number[]}>}}
 */
function feedInput(bytes) {
  const lines = [];
  const frames = [];
  const decoder = new FrameDecoder();  // imported from _frame-shared.mjs

  for (const b of bytes) {
    const action = routeByte(b);

    if (action === 'frame') {
      const events = decoder.push([b]);
      for (const ev of events) {
        if (ev.ok) {
          frameCounter++;
          const rawFrame = encode(ev.type, ev.payload);
          const maybeCorrupted = checkAndApplyFault(rawFrame);
          // Device mengirim frame kembali.
          const resp = handleFrame({ type: ev.type, payload: ev.payload });
          if (resp) {
            frames.push({ type: resp.type, payload: resp.payload });
          }
        } else {
          // Error di sisi device - cattat tapi jangan kirim apa pun.
          deviceState.rxStats[
            ev.error === 'BAD_VER' ? 'verErr'
            : ev.error === 'BAD_CRC' ? 'crcErr'
            : ev.error === 'LEN_OVERFLOW' ? 'lenErr'
            : 'crcErr'
          ]++;
        }
      }
    } else if (action === 'to_line') {
      // Kembali ke mode baris - reset decoder.
      decoder.resync();
    }
    // 'line' - byte masuk ke buffer baris (untuk kasus text-mode).
  }

  return { lines, frames };
}

/**
 * Set konfigurasi slot untuk testing.
 * @param {number} slotIdx  0-based slot indeks
 * @param {object} cfg      { version, layerCount, layers: [{name, keys:[{type,value}]}] }
 */
function setSlotConfig(slotIdx, cfg) {
  if (slotIdx < 0 || slotIdx >= APP_SLOTS) return;
  const slot = deviceState.slots[slotIdx];
  slot.version = cfg.version || CONFIG_VERSION;
  slot.layerCount = cfg.layerCount || 0;
  slot.keyLayers = [];
  const nKeys = deviceState.rows * deviceState.cols;
  for (let l = 0; l < MAX_LAYERS; l++) {
    const layer = cfg.layers?.[l];
    if (!layer) { slot.keyLayers[l] = null; continue; }
    slot.keyLayers[l] = {
      name: layer.name || '',
      keys: [],
    };
    for (let k = 0; k < nKeys; k++) {
      slot.keyLayers[l].keys.push(layer.keys?.[k] || { type: 0, value: '' });
    }
  }
}

/**
 * Set konfigurasi encoder untuk slot.
 */
function setSlotEncoders(slotIdx, encoders) {
  if (slotIdx < 0 || slotIdx >= APP_SLOTS) return;
  deviceState.slots[slotIdx].encoders = encoders;
}

/**
 * Reset seluruh state device ke kondisi default.
 */
function reset() {
  deviceState.activeSlot = 0xff;
  deviceState.mode = 'line';
  deviceState.rxStats = { frames: 0, crcErr: 0, verErr: 0, lenErr: 0, unsup: 0 };
  deviceState.txStats = { frames: 0, dropped: 0 };
  deviceState.fault = null;
  frameCounter = 0;
}

// ------------------------------------------------------------------
// Export
// ------------------------------------------------------------------

export {
  deviceState as state,
  feedInput,
  setSlotConfig,
  setSlotEncoders,
  computeSlotSig,
  injectFault,
  clearFault,
  reset as resetDevice,
  sigHex,
};

// ------------------------------------------------------------------
// Self-test (jalankan: node tests/virtual-device.mjs)
// ------------------------------------------------------------------

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let fail = 0;
  function eq(a, b, msg) {
    const ok = JSON.stringify(a) === JSON.stringify(b);
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${msg}`);
    if (!ok) fail++;
  }
  function ok(cond, msg) {
    console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`);
    if (!cond) fail++;
  }

  console.log('--- Virtual Device self-test ---');

  reset();
  let { frames } = feedInput(encode(T_CFG_QUERY, []));
  eq(frames.length, 1, 'CFG_QUERY -> 1 frame jawaban');
  eq(frames[0].type, T_CFG_META, 'jawaban adalah CFG_META');
  eq(frames[0].payload[0], 0xff, 'activeSlot = 0xFF (Default Preset)');

  // Test 2: HELLO -> HELLO_RSP
  ({ frames } = feedInput(encode(T_HELLO, [])));
  eq(frames.length, 1, 'HELLO -> 1 frame jawaban');
  eq(frames[0].type, T_HELLO_RSP, 'jawaban adalah HELLO_RSP');
  eq(frames[0].payload[1], deviceState.rows, 'baris sesuai device');
  eq(frames[0].payload[2], deviceState.cols, 'kolom sesuai device');

  // Test 3: slot kosong layerCount=0
  const emptySlot = deviceState.slots[0];
  eq(emptySlot.layerCount, 0, 'slot kosong layerCount=0');

  // Test 4: CFG_ACTIVATE slot valid
  setSlotConfig(0, {
    version: CONFIG_VERSION,
    layerCount: 1,
    layers: [{ name: 'Main', keys: Array.from({ length: 9 }, () => ({ type: 1, value: 'A' })) }],
  });
  ({ frames } = feedInput(encode(T_CFG_ACTIVATE, [0])));
  eq(frames.length, 1, 'CFG_ACTIVATE -> 1 frame jawaban');
  eq(frames[0].type, T_CFG_ACT_RSP, 'jawaban adalah CFG_ACT_RSP');
  eq(frames[0].payload[0], 0, 'code = 0 (sukses)');
  eq(frames[0].payload[5], 0, 'slot yang di-activate = 0');

  // Test 5: fault injection CRC
  reset();
  setSlotConfig(0, {
    version: CONFIG_VERSION,
    layerCount: 1,
    layers: [{ name: 'T', keys: Array.from({ length: 9 }, () => ({ type: 1, value: 'X' })) }],
  });
  injectFault(0, 'crc');
  const faultyBytes = encode(T_CFG_QUERY, []);
  const corrupted = checkAndApplyFault(faultyBytes);
  ok(corrupted[corrupted.length - 1] !== faultyBytes[faultyBytes.length - 1],
    'fault CRC mengubah byte terakhir');
  clearFault();

  // Test 6: CFG_BEGIN -> UNSUPPORTED
  reset();
  ({ frames } = feedInput(encode(T_CFG_BEGIN, [])));
  eq(frames.length, 1, 'CFG_BEGIN -> 1 frame jawaban');
  eq(frames[0].type, T_ERR, 'jawaban adalah ERR (belum didukung)');

  // Test 7: statistik device terupdate
  reset();
  feedInput(encode(T_CFG_QUERY, []));
  feedInput(encode(T_CFG_WRITE, [1, 2, 3]));
  eq(deviceState.rxStats.frames, 2, 'rxStats.frames terhitung');
  eq(deviceState.rxStats.unsup, 1, 'unsup terhitung untuk CFG_WRITE');

  console.log(`\n${fail === 0 ? 'SEMUA OK' : fail + ' ASSERTION GAGAL'}: virtual device siap`);
  process.exit(fail ? 1 : 0);
}
