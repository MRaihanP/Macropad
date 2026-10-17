// =================== CFG BINARY BUILDER ===================
//
// Encode preset → binary payload untuk CFG_WRITE.
// Layout persis sama dengan parser firmware di frame_proto.h, sehingga
// tidak ada perbedaan format yang bisa "silently" menyebabkan CRC mismatch.
//
// FORMAT (LE, no padding, all bytes literal):
//   u8  version      (harus == CONFIG_VERSION)
//   u8  layerCount   (1..MAX_LAYERS)
//   per layer (layerCount x):
//     char  name[16]              (NAME_LEN, zero-padded)
//     for each key (ROWS*COLS):
//       u8 type
//       char value[48]            (VALUE_LEN, zero-padded)
//     for each encoder (NUM_ENCODERS):
//       u8 type          (encCW)
//       char value[48]
//     for each encoder (NUM_ENCODERS):
//       u8 type          (encCCW)
//       char value[48]
//     for each encoder (NUM_ENCODERS):
//       u8 type          (encBtn)
//       char value[48]
//   u32 crc32            (CRC32/ISO-HDLC over everything above)
//
// Total size untuk prototype (1 encoder, 8 layer):
//   2 + 8*(16 + 9*49 + 3*49) + 4 = 2 + 8*604 + 4 = 4838 byte
//
import { CONFIG_VERSION, MAX_LAYERS, NAME_LEN, VALUE_LEN, ENC_PER_KNOB } from './cfg-layout.js';

// CRC32/ISO-HDLC (zlib), pure JS — sama persis dengan crc32.h.
// Dipindah ke sini dari crc32-browser.js untuk kecepatan, atau impor dari sana
// bila sudah ada. Di sini didefinisikan ulang agar modul mandiri dan testable
// di Node tanpa dependensi.
const CRC32_INIT = 0xffffffff;

function crc32_byte(crc, b) {
  let c = (crc ^ b) >>> 0;
  for (let i = 0; i < 8; i++) {
    c = (c & 1) ? ((c >>> 1) ^ 0xedb88320) >>> 0 : (c >>> 1) >>> 0;
  }
  return c >>> 0;
}

function crc32_bytes(data) {
  let crc = CRC32_INIT;
  for (let i = 0; i < data.length; i++) {
    crc = crc32_byte(crc, data[i]);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode satu action (type + value) ke byte array.
 * value dipotong ke VALUE_LEN - 1 karakter, lalu zero-padded hingga VALUE_LEN.
 *
 * @param {number} type   ActionType (0 = kosong/no-op)
 * @param {string} value  String nilai (bisa kosong)
 * @returns {number[]} 1 + VALUE_LEN byte
 */
function encodeAction(type, value) {
  const bytes = new Array(1 + VALUE_LEN);
  bytes[0] = type & 0xff;
  const v = String(value || '').slice(0, VALUE_LEN - 1);
  for (let i = 0; i < VALUE_LEN; i++) {
    bytes[1 + i] = (i < v.length) ? (v.charCodeAt(i) & 0xff) : 0;
  }
  return bytes;
}

/**
 * Encode satu layer nama (16 byte, zero-padded).
 */
function encodeName(name) {
  const bytes = new Array(NAME_LEN);
  const n = String(name || '').slice(0, NAME_LEN - 1);
  for (let i = 0; i < NAME_LEN; i++) {
    bytes[i] = (i < n.length) ? (n.charCodeAt(i) & 0xff) : 0;
  }
  return bytes;
}

/**
 * Encode preset datar ke binary payload (tanpa CRC32 — ditambahkan di akhir).
 *
 * Bentuk input `flat` harus sama persis dengan yang pakai cfgSigOfPreset():
 *   flat.version, flat.layerCount
 *   flat.names:  string[], panjang maxLayers
 *   flat.layers: [{ keys: [{type, value}, ...] (panjang rows*cols) }]
 *   flat.enc:     [{type, value}, ...] panjang numEncoders*3, urutan CW, CCW, BTN
 *
 * @param {object} flat   preset datar
 * @param {object} dims   { maxLayers, rows, cols, numEncoders, encPerKnob }
 * @returns {number[]}    byte array (header + layer data, TANPA crc32)
 */
export function encodePresetBody(flat, dims) {
  const { maxLayers, rows, cols, numEncoders, encPerKnob } = dims;
  const nKeys = rows * cols;
  const nEnc = numEncoders * encPerKnob;
  const nLayers = Math.min(flat.layerCount ?? 0, maxLayers);

  // Pre-hitung ukuran untuk alokasi sekali.
  // Per layer: NAME_LEN + nKeys * (1 + VALUE_LEN) + nEnc * (1 + VALUE_LEN)
  const perLayer = NAME_LEN + (nKeys + nEnc) * (1 + VALUE_LEN);
  const total = 2 + perLayer * nLayers;
  const buf = new Array(total);

  let w = 0;
  buf[w++] = flat.version & 0xff;
  buf[w++] = nLayers & 0xff;

  for (let l = 0; l < nLayers; l++) {
    // Nama layer
    const nameBytes = encodeName(flat.names[l] || '');
    for (let i = 0; i < NAME_LEN; i++) buf[w++] = nameBytes[i];

    // Keys (9)
    const layer = (flat.layers && flat.layers[l]) || {};
    const keys = layer.keys || [];
    for (let k = 0; k < nKeys; k++) {
      const a = (keys[k] || { type: 0, value: '' });
      const ab = encodeAction(a.type, a.value);
      buf[w++] = ab[0];
      for (let i = 0; i < VALUE_LEN; i++) buf[w++] = ab[1 + i];
    }

    // Encoders: flat.enc adalah array datar panjang numEncoders*encPerKnob
    // Urutan: knob0_CW, knob0_CCW, knob0_BTN, knob1_CW, ...
    // Ini persis sama dengan urutan parser firmware (semua CW, CCW, BTN per knob
    // — lihat komentar di faCmdCfgCommit). Encoder di-encode sequential saja.
    const enc = flat.enc || [];
    for (let i = 0; i < nEnc; i++) {
      const a = (enc[i] || { type: 0, value: '' });
      const ab = encodeAction(a.type, a.value);
      buf[w++] = ab[0];
      for (let j = 0; j < VALUE_LEN; j++) buf[w++] = ab[1 + j];
    }
  }

  return buf;
}

/**
 * Encode preset lengkap ke binary payload termasuk CRC32.
 *
 * @param {object} flat   preset datar (lihat encodePresetBody)
 * @param {object} dims   dimensi (lihat encodePresetBody)
 * @returns {number[]}    byte array (header + layer data + 4 byte CRC32 LE)
 */
export function encodePreset(flat, dims) {
  const body = encodePresetBody(flat, dims);
  const crc = crc32_bytes(body);
  return [...body, crc & 0xff, (crc >> 8) & 0xff, (crc >> 16) & 0xff, (crc >> 24) & 0xff];
}

/**
 * Hitung berapa banyak frame CFG_WRITE yang dibutuhkan untuk payload ini,
 * dengan ukuran maksimum per frame.
 *
 * @param {number} payloadLen   panjang payload total
 * @param {number} maxPayload   batas payload per frame (default 237)
 * @returns {{nChunks: number, chunkSize: number, lastSize: number}}
 */
export function chunkPlan(payloadLen, maxPayload = 237) {
  if (payloadLen <= 0) return { nChunks: 0, chunkSize: maxPayload, lastSize: 0 };
  const nChunks = Math.ceil(payloadLen / maxPayload);
  const chunkSize = maxPayload;
  const lastSize = payloadLen - (nChunks - 1) * chunkSize;
  return { nChunks, chunkSize, lastSize };
}
