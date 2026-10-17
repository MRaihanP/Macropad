// ==================== FRAME TRANSPORT ====================
//
// Percakapan frame biner v2 di atas facade transport.js.
//
// Transport fisik (USB CDC / BLE NUS) tetap berupa stream byte. Modul ini
// menambahkan lapisan framing: encode() untuk menyusun frame yang dikirim lewat
// sendRaw(), dan waitForFrame() untuk jawaban yang masuk lewat frame-dispatch.js.
//
// BUKAN backend transport ketiganya. Plan Fase 3 menyebut "backend ketiga",
// tapi kenyataannya tidak ada: pilihan USB atau BLE tetap milik pengguna lewat
// pemilih transport. Yang dinegosiasi di sini adalah FORMAT - apakah device
// ini bisa menerima frame biner, atau harus lewat jalur teks.
//
// SIAP:
//  - sendFrame(type, payload)      kirim satu frame biner
//  - queryFrameSlots()             CFG_QUERY -> CFG_META
//  - activateFrameSlot(n)          CFG_ACTIVATE -> CFG_ACT_RSP
//  - presetSig(preset, geom)       CFG_SIG kanonik, sama dengan firmware
//  - findMatchingSlot / findEmptySlot
//  - ensureLineMode()              kembali ke jalur teks, DIVERIFIKASI
//
// BELUM:
//  - CFG_BEGIN / CFG_WRITE / CFG_COMMIT (Fase 4). Firmware belum punya handler,
//    hanya nama - request-nya ditolak UNSUPPORTED.
//  - CREDIT flow control (Fase 5)

import {
  encode, T_HELLO, T_CFG_QUERY, T_CFG_ACTIVATE,
  T_HELLO_RSP, T_CFG_META, T_CFG_ACT_RSP, T_ERR,
} from './frame-codec.js';
import { cfgSigOfPreset } from './cfg-sig.js';
import {
  CONFIG_VERSION, APP_SLOTS, SLOT_NONE,
  CFG_META_SLOT_STRIDE, CFG_META_HEADER_LEN, CFG_ACT_RSP_LEN, cfgSigDims,
} from './cfg-layout.js';
import { waitForFrame } from './frame-dispatch.js';
import { registerPongProbe, clearPongProbe } from './pong-probe.js';
import { sendRaw, sendLine, isConnected } from './transport.js';

// Kode hasil CFG_ACT_RSP. 0 = sukses; selain itu device menolak.
const ACT_OK = 0;

const RTT_MS = 2000;
// Verifikasi mode baris lebih pendek: PING hanya bolak-balik satu baris, tidak
// ada pekerjaan device di belakangnya.
const LINE_PROBE_MS = 1200;

// Keputusan format untuk SESI INI.
//
// null = belum ada bukti. true = device terbukti menjawab frame. false = sudah
// mencoba dan gagal, jadi jangan coba lagi sampai koneksi berikutnya.
//
// Kenapa perlu: tanpa flag ini, setiap activatePresetRuntime() akan membayar
// timeout 2 detik penuh pada device yang tidak mendukung frame - dan preset
// switch yang gagal akan terasa seperti app macet setiap kali.
let frameUsable = null;

/** Status keputusan format sesi ini, untuk log dan test. */
export function frameModeStatus() { return frameUsable; }

/** Buang keputusan format. Dipanggil saat disconnect. */
export function resetFrameMode() { frameUsable = null; }

/**
 * Apakah ada indikasi device SEDANG dalam mode frame?
 *
 * Firmware menjawab WHOAMI dengan `proto=line` atau `proto=frame`, dan itu
 * menyebut mode yang sedang AKTIF - bukan kemampuan device. Device baru pindah
 * ke mode frame setelah menerima SOF 0xA5, jadi WHOAMI pertama (yang dikirim
 * saat handshake, sebelum app mengirim frame apa pun) hampir selalu melaporkan
 * `proto=line` bahkan pada device yang mendukung frame.
 *
 * Karena itu fungsi ini TIDAK dipakai sebagai gerbang. Ia hanya petunjuk:
 * frame dicoba, dan kalau device menjawab frame maka fast path hidup. Kalau
 * timeout atau ERR, app turun ke jalur teks dan mencatatnya di frameUsable
 * supaya tidak mengulang percobaan yang sama.
 *
 * @param {object} deviceProfile hasil parse WHOAMI di protocol-parser.js
 * @returns {boolean}
 */
export function deviceSupportsFrame(deviceProfile) {
  return !!(deviceProfile && deviceProfile.proto === 'frame');
}

/**
 * Kirim satu frame biner.
 *
 * Byte 0xA5 di awal membuat firmware masuk mode frame lewat faRoute() di
 * checkSerialInput(). Setelah itu device membalas dengan frame, bukan teks.
 *
 * @param {number} type tipe frame
 * @param {Uint8Array|number[]} payload
 * @returns {Promise<boolean>} true kalau byte-nya benar-benar keluar
 */
export async function sendFrame(type, payload) {
  if (!isConnected()) return false;
  const arr = payload && payload.length ? Array.from(payload) : [];
  return await sendRaw(new Uint8Array(encode(type, arr)));
}

/**
 * Parse payload CFG_META. Bentuknya dikunci di src/cfg-layout.js:
 *   u8 activeSlot, lalu per slot { u32 sig LE, u8 layers, u8 valid }
 *
 * Slot yang tidak lengkap DIPOTONG, bukan dipad. Padding berarti sidik jari
 * palsu untuk slot yang device tidak kirim - dan slot palsu yang terbaca
 * "kosong" akan dipilih untuk unggahan baru, menimpa preset yang sebenarnya ada.
 *
 * @param {Uint8Array|number[]} payload
 * @returns {{activeSlot:number, slots:Array}|null}
 */
export function parseCfgMeta(payload) {
  if (!payload || payload.length < CFG_META_HEADER_LEN) return null;
  const p = payload;
  const slots = [];
  for (let i = 0; i < APP_SLOTS; i++) {
    const off = CFG_META_HEADER_LEN + i * CFG_META_SLOT_STRIDE;
    if (off + CFG_META_SLOT_STRIDE > p.length) break;
    const sig = (p[off] | (p[off + 1] << 8) | (p[off + 2] << 16) | (p[off + 3] << 24)) >>> 0;
    slots.push({ sig, layers: p[off + 4], valid: p[off + 5] === 1 });
  }
  return { activeSlot: p[0], slots };
}

/**
 * Parse payload CFG_ACT_RSP: u8 code, u32 appliedSig LE, u8 slot.
 * @returns {{code:number, appliedSig:number, slot:number}|null}
 */
export function parseCfgActRsp(payload) {
  if (!payload || payload.length < 1) return null;
  const p = payload;
  const full = p.length >= CFG_ACT_RSP_LEN;
  const appliedSig = full
    ? (p[1] | (p[2] << 8) | (p[3] << 16) | (p[4] << 24)) >>> 0
    : 0;
  return { code: p[0], appliedSig, slot: full ? p[5] : 0 };
}

/**
 * Parse payload ERR: u8 requestType, u8 code.
 *
 * ERR selalu berarti permintaan ini tidak diproses. Jadi kalau ERR muncul untuk
 * CFG_QUERY, pemanggil HARUS turun ke jalur teks, bukan menunggu lebih lama.
 */
export function parseErr(payload) {
  if (!payload || payload.length < 1) return { reqType: 0, code: 0 };
  return { reqType: payload[0], code: payload.length >= 2 ? payload[1] : 0 };
}

/**
 * Kirim frame dan tunggu jawabannya.
 *
 * Antrean penunggu di frame-dispatch.js yang mengurutkan ini. Versi pertama
 * menyimpan satu variabel global tunggal, jadi dua permintaan yang tumpang tindih
 * saling menimpa: yang pertama menggantung sampai timeout-nya, yang kedua
 * menerima jawaban milik yang lain.
 *
 * @param {number} type tipe frame yang dikirim
 * @param {number} expectType tipe jawaban yang diharapkan
 * @param {number[]} payload
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean, payload?:Uint8Array, err?:object, reason?:string}>}
 */
export async function requestFrame(type, expectType, payload, timeoutMs = RTT_MS) {
  if (!isConnected()) return { ok: false, reason: 'putus' };
  // Penunggu dipasang SEBELUM write. Kalau write dulu, device bisa menjawab
  // dalam hitungan milidetik pada jalur cepat, dan jawaban itu tiba saat tidak
  // ada yang menunggu - hilang.
  const waiter = waitForFrame(expectType, timeoutMs);
  const errWaiter = waitForFrame(T_ERR, timeoutMs);
  const ok = await sendFrame(type, payload);
  if (!ok) return { ok: false, reason: 'gagal tulis' };

  const race = await Promise.race([
    waiter.then(p => ({ kind: 'ok', payload: p })),
    errWaiter.then(p => ({ kind: 'err', payload: p })),
  ]);
  return race.kind === 'ok'
    ? { ok: race.payload !== null, payload: race.payload, reason: race.payload === null ? 'timeout' : null }
    : { ok: false, err: parseErr(race.payload), reason: 'ditolak device' };
}

/**
 * CFG_QUERY -> CFG_META.
 * @returns {Promise<{activeSlot:number, slots:Array}|null>}
 */
export async function queryFrameSlots() {
  const r = await requestFrame(T_CFG_QUERY, T_CFG_META, []);
  if (!r.ok) { frameUsable = false; return null; }
  frameUsable = true;
  return parseCfgMeta(r.payload);
}

/**
 * CFG_ACTIVATE -> CFG_ACT_RSP.
 * @param {number} slot 0..APP_SLOTS-1
 * @returns {Promise<{code:number, appliedSig:number, slot:number}|null>}
 *   null berarti gagal, dan pemanggil harus turun ke jalur teks
 */
export async function activateFrameSlot(slot) {
  if (!(slot >= 0 && slot < APP_SLOTS)) return null;
  const r = await requestFrame(T_CFG_ACTIVATE, T_CFG_ACT_RSP, [slot & 0xff]);
  if (!r.ok) { frameUsable = false; return null; }
  const rsp = parseCfgActRsp(r.payload);
  if (!rsp) { frameUsable = false; return null; }
  if (rsp.code !== ACT_OK) return null;
  frameUsable = true;
  return rsp;
}

/**
 * HELLO -> HELLO_RSP. Untuk diagnostik saja: jalur frame tidak butuh handshake
 * lebih dulu karena auto-detect 0xA5 sudah menentukan mode.
 * @returns {Promise<Uint8Array|null>}
 */
export async function frameHello() {
  const r = await requestFrame(T_HELLO, T_HELLO_RSP, []);
  frameUsable = r.ok ? true : frameUsable;
  return r.ok ? r.payload : null;
}

/**
 * Kembalikan device ke jalur teks, dan VERIFIKASI bahwa itu terjadi.
 *
 * Kenapa bukan sekadar `sendLine('')` seperti versi pertama:
 *
 *  - Firmware keluar dari mode frame saat menerima byte 0x0A, lewat faRoute().
 *    Jadi baris kosong memang cara yang benar - tapi app tidak TAHU device sudah
 *    beralih, hanya berharap begitu.
 *  - Kalau device sudah diputus, atau auto-detect berubah di firmware, baris
 *    kosong itu diam-diam tidak melakukan apa-apa. App lalu mengirim INFO dan
 *    DUMPENC yang device baca sebagai payload frame rusak: crcErr naik, grid
 *    tidak pernah terisi. Gejalanya "matrix tombol tidak berubah" - persis yang
 *    seharusnya diperbaiki.
 *
 * Jadi setelah newline, app MEMERIKSA dengan PING: device dalam mode baris
 * menjawab PONG sebagai teks. PONG juga yang dipakai untuk menghitung latensi,
 * jadi pemeriksaan ini tidak menambah beban.
 *
 * @returns {Promise<boolean>} true kalau device terbukti di mode baris
 */
export async function ensureLineMode() {
  if (!isConnected()) return false;
  // Newline lewat jalur RAW. sendLine menambah newline-nya sendiri, dan kita
  // justru butuh satu newline yang paling dulu sampai.
  const raw = await sendRaw(new Uint8Array([0x0a]));
  if (!raw) return false;
  return await probePong();
}

/**
 * Tunggu PONG, dicatat sebagai sampel latensi.
 *
 * Sengaja TIDAK memakai waitForFrame: PONG adalah TEKS, jadi harus lewat parser
 * baris yang sudah ada. Itu sebabnya probe ini ada di sini, bukan di
 * frame-dispatch.js.
 */
function probePong() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearPongProbe();     // slot harus dikosongkan walau tidak ada PONG
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), LINE_PROBE_MS);
    // Slot penuh = probe lain masih menunggu. Memaksakan PING kedua akan
    // membuat device menjawab dua kali dan probe pertama bisa memakai jawaban
    // milik probe kedua. Lebih baik gagal dan laporan naik ke jalur teks.
    if (registerPongProbe(finish)) sendLine('PING');
    else finish(false);
  });
}

/**
 * Hitung CFG_SIG (CRC-32/ISO-HDLC) dari preset app.
 *
 * Dihitung persis sama dengan firmware (cfg_sig.h): bentuk kanonik, bukan
 * sizeof(struct) mentah. Tiga bahasa (C, JS, Rust) diuji silang dari
 * tests/vectors/cfg.vec.
 *
 * Preset app menyimpan keys[r][c] (2D) plus encCw/encCcw/encBtn terpisah, sementara
 * cfgSigOfPreset() meminta keys[k] datar dan enc[i] datar dengan urutan
 * (CW, CCW, BTN) per knob. Fungsi ini mentransformasi bentuknya.
 *
 * @param {object} preset preset dari presetsData
 * @param {object} geom {rows, cols, numEncoders} - HARUS sama dengan device,
 *   kalau tidak sidik jarinya tidak akan pernah cocok
 * @returns {number} CRC32 unsigned 32-bit
 */
export function presetSig(preset, geom) {
  const { rows, cols, numEncoders } = geom;
  const dims = cfgSigDims(geom);
  const layerCount = Math.min(preset.layers?.length || 0, dims.maxLayers);

  const flat = {
    version: CONFIG_VERSION,
    layerCount,
    currentLayer: 0,
    names: preset.layers?.map(l => l.name || '') || [],
    layers: [],
    enc: [],
  };

  for (let l = 0; l < layerCount; l++) {
    const layer = preset.layers[l];
    flat.layers[l] = { keys: [] };
    if (!layer) continue;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = layer.keys?.[r]?.[c];
        flat.layers[l].keys.push(
          (k && k.type) ? { type: k.type, value: k.value } : { type: 0, value: '' });
      }
    }
  }

  // Encoder diambil dari layer TERAKHIR, bukan layer pertama atau setiap layer.
  //
  // Alasannya ada di firmware: SETENC menulis ke activeCfg->encCW[encIdx] yang
  // GLOBAL - tidak ada indeks layer sama sekali. buildPresetLines() mengirim
  // SETENC untuk setiap layer berurutan, jadi lapisan yang ditulis terakhir
  // menimpa semua yang sebelumnya. Setelah upload, device hanya menyimpan satu
  // set binding encoder: milik layer terakhir.
  //
  // cfgSig() di firmware juga cuma membaca c.encCW[0] satu kali, di luar loop
  // layer. Bentuk kanonik memang hanya memuat SATU set encoder.
  //
  // Versi pertama fungsi ini mengumpulkan encoder di dalam loop layer. Untuk
  // preset satu layer hasilnya kebetulan benar; untuk preset beberapa layer
  // cfgSigOfPreset() hanya membaca entri pertama (nEncoders*encPerKnob), yaitu
  // milik layer 0 - sedangkan device menyimpan milik layer terakhir. Dua angka
  // itu tidak akan pernah sama, jadi preset yang sebenarnya sudah ada di device
  // akan selalu dianggap baru dan diunggah ulang. Persis cacat yang seharusnya
  // dihilangkan oleh CFG_SIG.
  const lastLayer = preset.layers?.[layerCount - 1] || null;
  for (let i = 0; i < numEncoders; i++) {
    for (const key of ['encCw', 'encCcw', 'encBtn']) {
      const a = lastLayer?.[key]?.[i];
      flat.enc.push(a && a.type ? { type: a.type, value: a.value } : { type: 0, value: '' });
    }
  }

  return cfgSigOfPreset(flat, dims);
}

/**
 * Cari slot di device yang isinya sudah sama dengan preset.
 *
 * Hanya slot dengan valid=1 yang dianggap. Slot yang device tandai tidak sah
 * masih bisa punya sidik jari sisa config sebelumnya - mempercayakannya berarti
 * app melewati unggahan yang seharusnya dilakukan, lalu device mengaktifkan
 * keymap yang berbeda dari yang app kira.
 *
 * @returns {number} nomor slot 0-based, atau -1
 */
export function findMatchingSlot(sig, slots) {
  if (!slots) return -1;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].valid && slots[i].sig === sig) return i;
  }
  return -1;
}

/**
 * Temukan slot yang device tandai belum dipakai.
 *
 * "Kosong" TIDAK bisa disimpulkan dari sidik jari apa pun - config yang kosong
 * sah-sah saja punya sidik jari. Jadi ini bergantung pada penanda valid yang
 * dikirim firmware, bukan tebakan.
 *
 * @returns {number} nomor slot, atau -1 kalau semuanya penuh
 */
export function findEmptySlot(slots) {
  if (!slots) return -1;
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i].valid) return i;
  }
  return -1;
}

/**
 * Ringkasan CFG_META dalam teks, untuk log.
 * Dipakai supaya kegagalan fast path terbaca tanpa membuka debugger.
 */
export function describeCfgMeta(meta) {
  if (!meta) return 'CFG_META: (tidak ada)';
  const aktif = meta.activeSlot === SLOT_NONE ? 'Default Preset' : `slot ${meta.activeSlot}`;
  const isi = meta.slots
    .map(s => `${sigHex(s.sig)}${s.valid ? '' : '(kosong)'}`)
    .join(' ');
  return `CFG_META: aktif=${aktif} slot=[${isi}]`;
}

/** Format 8 digit heks huruf kecil - sama dengan format firmware. */
export function sigHex(sig) {
  return (sig >>> 0).toString(16).padStart(8, '0');
}