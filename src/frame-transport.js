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
//  - uploadPresetBinary()          CFG_BEGIN → CFG_READY{credit} → CFG_WRITE(no-ack)
//                                  → CFG_COMMIT → CFG_RESULT (Fase 5: credit flow)

import {
  encode, T_HELLO, T_CFG_QUERY, T_CFG_ACTIVATE,
  T_HELLO_RSP, T_CFG_META, T_CFG_ACT_RSP,
  T_CFG_BEGIN, T_CFG_WRITE, T_CFG_RESULT, T_CFG_COMMIT, T_CFG_READY, T_CREDIT, T_ERR, ERR_CREDIT_EXHAUSTED, ERR_STAGING_FULL, ERR_CRC32_MISMATCH, ERR_UNSUPPORTED,
} from './frame-codec.js';
import { cfgSigOfPreset } from './cfg-sig.js';
import {
  CONFIG_VERSION, APP_SLOTS, SLOT_NONE,
  CFG_META_SLOT_STRIDE, CFG_META_HEADER_LEN, CFG_ACT_RSP_LEN, cfgSigDims,
} from './cfg-layout.js';
import { encodePreset, chunkPlan } from './cfg-builder.js';
import { waitForFrame } from './frame-dispatch.js';
import { registerPongProbe, clearPongProbe } from './pong-probe.js';
import { sendRaw, sendRawNoAck, sendLine, isConnected } from './transport.js';

// Kode hasil CFG_ACT_RSP. 0 = sukses; selain itu device menolak.
// Kode hasil CFG_COMMIT. 0 = sukses; selain itu error names.
const ACT_OK = 0;
const ERR_NAMES = {
  0: 'NONE', 1: 'BAD_VER', 2: 'BAD_CRC', 3: 'LEN_OVERFLOW',
  0x10: 'SEQ_GAP', 0x11: 'SEQ_DUP', 0x12: 'NO_SESSION',
  0x13: 'CREDIT_EXHAUSTED', 0x14: 'STAGING_FULL', 0x15: 'CRC32_MISMATCH', 0x16: 'UNSUPPORTED',
};

// Batas satu write BLE, dalam byte.
//
// PENTING: payload maksimum characteristic NUS adalah MTU - 3 byte. Pada MTU 247
// (nilai yang muncul di DIAG) itu 244 byte. Satu frame CFG_WRITE dengan payload
// 237 byte memakai 237 + 5 header + 2 CRC = 244 byte, jadi SUDAH tepat di batas.
//
// Karena itu frame TIDAK boleh digabung: dua frame dalam satu write = 481 byte,
// Windows memotongnya tanpa error, dan preset yang terpotong bisa lolos
// pemeriksaan CRC di sisi app kalau tidak hati-hati. Jadi penggabungan frame
// DIBATASI oleh MAX_WRITE_BYTES di bawah, bukan dilakukan tanpa batas.
const MAX_WRITE_BYTES = 244;
// Overhead per frame di wire: header 5 byte (SOF, VER, type, len hi, len lo)
// plus trailer CRC 2 byte. Cermin encode() di frame-codec.js.
const FRAME_OVERHEAD = 7;

// Batas menunggu jawaban frame.
//
// 2 detik pertama ditulis saat diasumsikan link punya latency ~200ms. Pada link
// lambat dengan rtt p50=293ms dan p95=896ms (lihat DIAG: L0 RADIO), plus antrean
// device yang kadang sedang sibuk menjawab permintaan lain, jawaban yang SEDANG
// dalam perjalanan tapi belum sampai sering dianggap gagal - lalu fast path
// dimatikan, dan switch berikutnya turun ke jalur teks yang jauh lebih lambat.
//
// Jadi batasnya harus menutup RTT yang SEBENARNYA terjadi di link lambat, dengan
// ruang untuk device yang sedang sibuk. 6 detik menutup p99 pada rtt ~900ms
// dengan faktor 6, dan masih jauh lebih cepat dari "preset tidak pernah berganti".
const RTT_MS = 6000;
// Verifikasi mode baris lebih pendek: PING hanya bolak-balik satu baris, tidak
// ada pekerjaan device di belakangnya.
const LINE_PROBE_MS = 1200;

// Berapa kali line mode dicoba sebelum menyerah.
//
// 0x0A hanya dikenali perakit frame saat IDLE. Kalau perakit masih memegang
// setengah frame terpotong, 0x0A dimakan sebagai byte data dan device TIDAK
// berpindah mode sama sekali - bukan karena perintahnya salah, tapi karena
// perakit belum siap menerima perintah.
//
// Di link lambat satu percobaan punya peluang nyata gagal: PONG belum sempat
// tiba dalam LINE_PROBE_MS. Tiga percobaan menutup kedua kasus itu.
const LINE_MODE_ATTEMPTS = 3;
// Jeda antar percobaan. Cukup bagi perakit device menyelesaikan frame yang
// sedang dipegang, tapi cukup pendek sehingga tidak terasa oleh user.
const LINE_MODE_RETRY_MS = 120;

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

// Keputusan format untuk SESI INI.
//
// null = belum ada bukti. true = device terbukti menjawab frame. false = device
// menyatakan frame sebagai tidak didukung.
//
// Kenapa perlu: tanpa flag ini, setiap activatePresetRuntime() akan membayar
// timeout 2 detik penuh pada device yang tidak mendukung frame - dan preset
// switch yang gagal akan terasa seperti app macet setiap kali.
//
// BUKAN "sudah mencoba dan gagal". Perbedaannya menentukan apakah switch
// konsisten atau tidak, dan versi lama membuat app BERHENTI
// memakai frame terlalu cepat lalu tidak pernah kembali:
//
//   1. Timeout 2 detik saja - yang di link lambat dengan rtt p95 ~900ms dan
//      antrean device yang sibuk itu hal NORMAL, bukan bukti device tidak
//      mendukung frame - langsung men-set frameUsable = false.
//   2. False berarti PERMANEN sampai disconnect. Jadi satu timeout yang tidak
//      beruntung membuat SEMUA switch berikutnya turun ke jalur teks.
//   3. Jalur teks mengirim ratusan baris SET. Link jadi jenuh, RTT membengkak,
//      dan timeout berikutnya makin mungkin - dan frameUsable tetap false.
//
// Hasilnya spiral: switch #1 pakai frame (cepat, benar), switch #2 timeout
// sekali, lalu #3 dan seterusnya pakai jalur teks yang lambat dan membanjiri
// link. Persis gejala "tidak selalu berhasil berpindah preset".
//
// Jadi kegagalAN SEMENTARA (timeout, link kelewat) tidak lagi mematikan fast
// path. Yang mematikan fast path hanya bukti nyata: device menjawab ERR
// UNSUPPORTED, atau kegagalan beruntun berkali-kali.
let frameUsable = null;

// Kegagalan berturut-turut. Hanya menyentuh batas inilah yang benar-benar
// mematikan fast path. Satu timeout tidak cukup - itu gangguan sesaat.
let frameFailStreak = 0;
const FRAME_FAIL_STREAK_MAX = 3;

// Setelah fast path dimatikan, jangan mencoba selamanya. Device yang benar-benar
// tidak mendukung frame akan membuat app membayar timeout penuh di setiap switch
// kalau tidak ada jeda. Empat detik cukup untuk membuat device tetap bisa
// dicoba tanpa setiap switch membayar timeout.
let frameDisabledUntil = 0;
const FRAME_RETRY_AFTER_MS = 4000;

/** Status keputusan format sesi ini, untuk log dan test. */
export function frameModeStatus() { return frameUsable; }

/** Buang keputusan format. Dipanggil saat disconnect. */
export function resetFrameMode() {
  frameUsable = null;
  frameFailStreak = 0;
  frameDisabledUntil = 0;
}

/**
 * Catat hasil satu percobaan frame.
 *
 * Dipisah dari call site supaya aturan "kapan fast path boleh mati" hanya ada
 * di SATU tempat - bukan tersebar di lima fungsi yang bisa mulai berbeda.
 *
 * @param {boolean} ok percobaan berhasil
 * @param {boolean}Unsupported device secara eksplisit bilang tidak mendukung
 */
function noteFrameAttempt(ok, unsupported = false) {
  if (ok) {
    frameFailStreak = 0;
    frameUsable = true;
    return;
  }
  // Device menjawab ERR UNSUPPORTED: ini bukti nyata, bukan gangguan. Matikan
  // fast path untuk sesi ini - tapi tetap beri jeda supaya masih bisa dicoba
  // nanti, karena device yang sama bisa di-flash ulang saat app terbuka.
  if (unsupported) {
    frameUsable = false;
    frameFailStreak = FRAME_FAIL_STREAK_MAX;
    frameDisabledUntil = Date.now() + FRAME_RETRY_AFTER_MS;
    return;
  }
  // Kegagalan sesaat (timeout, link pelan, device sibuk). Hitung, tapi jangan
  // langsung mematikan fast path.
  frameFailStreak++;
  if (frameFailStreak >= FRAME_FAIL_STREAK_MAX) {
    frameUsable = false;
    frameDisabledUntil = Date.now() + FRAME_RETRY_AFTER_MS;
  }
}

/** Fast path boleh dicoba sekarang? Jeda setelah dimatikan sudah lewat? */
export function framePathAvailable() {
  if (frameUsable === false && Date.now() < frameDisabledUntil) return false;
  return true;
}

// Hook untuk test suite.
//
// Dipakai supaya test bisa membuktikan aturan "timeout tidak mematikan fast
// path" tanpa harus REALLY menunggu jeda 4 detik. Produksi tidak pernah
// memanggilnya - kalau iya, jeda itu jadi tidak berguna.
export function __noteFrameAttemptForTest(ok, unsupported) {
  noteFrameAttempt(ok, unsupported);
}
export function __advanceFrameRetryForTest(ms) {
  frameDisabledUntil -= ms;
}

/**
 * Apakah device ini MAMPU menjawab frame biner?
 *
 * Gate ini dulunya membaca `proto === 'frame'`, dan itu salah sumber daya:
 * `proto=` melaporkan mode yang SEDANG AKTIF, bukan kemampuan device
 * (lihat firmware/common/macropad_core.h di perintah WHOAMI). Akibatnya:
 *
 *   - Device yang jelas mendukung frame dilaporkan `proto=line` setiap kali
 *     WHOAMI dijawab saat handshake - yang selalu terjadi di mode baris. Fast
 *     path jadi praktis tidak pernah dipakai.
 *   - Lebih buruk, begitu device tersesat ke mode frame, WHOAMI tidak bisa
 *     dijawab sama sekali, jadi `proto` juga hilang. Satu-satunya jalan keluar
 *     dari mode frame adalah ensureLineMode() - tapi justru ensureLineMode()
 *     yang butuh gate ini. Itu deadlock, dan gejalanya persis laporan
 *     "preset stuck setelah reconnect".
 *
 * Yang benar adalah `frame=0xA5`: byte SOF yang dicetak firmware sebagai
 * tanda device-nya punya lapisan frame. Nilai itu konstan dan tidak berubah
 * saat mode berpindah, jadi inilah capability yang sebenarnya.
 *
 * `proto === 'frame'` tetap diterima sebagai bukti tambahan, karena device
 * yang sedang dalam mode frame memang sudah membuktikan kemampuannya.
 *
 * @param {object} deviceProfile hasil parse WHOAMI di protocol-parser.js
 * @returns {boolean}
 */
export function deviceSupportsFrame(deviceProfile) {
  if (!deviceProfile) return false;
  if (typeof deviceProfile.proto === 'string' && deviceProfile.proto === 'frame') return true;
  const sof = typeof deviceProfile.frame === 'string' ? deviceProfile.frame.trim().toLowerCase() : '';
  // Firmware mencetak "0xA5". Angka desimal juga diterima supaya test dan
  // perkakas diagnosa yang mengirim bentuk lain tetap bisa dipakai.
  return sof === '0xa5' || sof === '165';
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
  if (!ok) { waiter.cancel(); errWaiter.cancel(); return { ok: false, reason: 'gagal tulis' }; }

  const race = await Promise.race([
    waiter.then(p => ({ kind: 'ok', payload: p })),
    errWaiter.then(p => ({ kind: 'err', payload: p })),
  ]);
  // Pemenang sudah diterima. Pembatal yang kalah HARUS ikut dibatalkan,
  // kalau tidak waiter-nya tetap menggantung di antrean dan akan mencuri
  // frame berikutnya yang tipe-nya sama.
  if (race.kind === 'ok') errWaiter.cancel(); else waiter.cancel();
  return race.kind === 'ok'
    ? { ok: race.payload !== null, payload: race.payload, reason: race.payload === null ? 'timeout' : null }
    : { ok: false, err: parseErr(race.payload), reason: 'ditolak device', unsupported: isUnsupported(race.payload) };
}

/**
 * Apakah ERR yang baru saja diterima berarti "device tidak mendukung frame".
 *
 * Bedanya penting dan menentukan perilaku selama sisa sesi:
 *
 *   - UNSUPPORTED -> bukti nyata. Fast path layak dimatikan.
 *   - timeout / ERR lain -> gangguan sesaat. Fast path harus tetap hidup.
 *
 * Tanpa pemisahan ini, satu timeout di link yang lambat akan mematikan fast
 * path untuk seluruh sesi - dan semua switch berikutnya jatuh ke jalur teks
 * yang mengirim ratusan baris SET. Gejalanya persis "tidak selalu berhasil
 * berpindah preset", dan worsens seiring link makin jenuh.
 */
function isUnsupported(payload) {
  if (!payload || payload.length < 2) return false;
  const info = parseErr(payload);
  return info.code === ERR_UNSUPPORTED;
}

/**
 * CFG_QUERY -> CFG_META.
 * @returns {Promise<{activeSlot:number, slots:Array}|null>}
 */
export async function queryFrameSlots() {
  const r = await requestFrame(T_CFG_QUERY, T_CFG_META, []);
  noteFrameAttempt(r.ok, !!r.unsupported);
  if (!r.ok) return null;
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
  noteFrameAttempt(r.ok, !!r.unsupported);
  if (!r.ok) return null;
  const rsp = parseCfgActRsp(r.payload);
  if (!rsp) return null;
  // Device menjawab, tapi dengan kode error. Ini device yang SEHAT yang
  // menolak operasi ini - bukan device yang tidak mendukung frame. Jadi
  // fast path tetap hidup; yang gagal cuma slot yang diminta.
  if (rsp.code !== ACT_OK) return null;
  return rsp;
}

/**
 * HELLO -> HELLO_RSP. Untuk diagnostik saja: jalur frame tidak butuh handshake
 * lebih dulu karena auto-detect 0xA5 sudah menentukan mode.
 * @returns {Promise<Uint8Array|null>}
 */
export async function frameHello() {
  const r = await requestFrame(T_HELLO, T_HELLO_RSP, []);
  noteFrameAttempt(r.ok, !!r.unsupported);
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
  //
  // Satu percobaan TIDAK cukup, dan inilah alasannya. 0x0A hanya dikenali
  // perakit frame saat dalam keadaan IDLE (lihat faRoute di frame_asm.h).
  // Kalau perakit masih memegang setengah frame dari sinkronisasi yang terputus
  // di tengah jalan, 0x0A itu dimakan sebagai byte data biasa, bukan perintah -
  // dan device tetap di mode frame. PONG pun tidak pernah datang, jadi probe
  // melaporkan "gagal" padahal masalahnya "belum upbeat", bukan "tidak bisa".
  //
  // Di link lambat (rtt p50 di device yang lambat bisa 200ms+) satu percobaan
  // punya peluang nyata gagal karena PONG belum sempat tiba dalam LINE_PROBE_MS.
  // Tiga percobaan dengan jeda pendek menutup keduanya: perakit yang belum IDLE
  // akan sempat selesai, dan PONG yang terlambat akan tertangkap di percobaan
  // berikutnya.
  for (let attempt = 0; attempt < LINE_MODE_ATTEMPTS; attempt++) {
    if (!isConnected()) return false;
    const raw = await sendRaw(new Uint8Array([0x0a]));
    if (!raw) return false;              // link hilang: retry tidak ada artinya
    if (await probePong()) return true;
    // Jeda pendek sebelum mencoba lagi. Tanpa jeda, tiga percobaan bisa
    // selesai dalam waktu yang lebih pendek dari satu RTT - jadi tidak menambah
    // peluang apa pun, hanya menambah write.
    if (attempt < LINE_MODE_ATTEMPTS - 1) await sleepMs(LINE_MODE_RETRY_MS);
  }
  return false;
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
 * Parse payload CFG_COMMIT response (FA_T_CFG_RESULT).
 *
 * @param {Uint8Array|number[]} payload
 * @returns {{code:number, sig:number, slot:number}|null}
 */
export function parseCfgResult(payload) {
  if (!payload || payload.length < 1) return null;
  return {
    code: payload[0],
    sig: payload.length >= 5
      ? (payload[1] | (payload[2] << 8) | (payload[3] << 16) | (payload[4] << 24)) >>> 0
      : 0,
    slot: payload.length >= 6 ? payload[5] : 0,
  };
}

/**
 * Konversi preset app ke bentuk datar untuk encodePreset.
 *
 * Bentuk flat sama persis dengan yang pakai presetSig() di atas —
 * jadi CFG_SIG dan binary payload akan konsisten. Encoder diambil
 * dari layer TERAKHIR (sama dengan presetSig).
 *
 * @param {object} preset preset dari presetsData
 * @param {object} geom {rows, cols, numEncoders}
 * @returns {object} flat preset
 */
export function presetToFlat(preset, geom) {
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
    for (let r = 0; r < geom.rows; r++) {
      for (let c = 0; c < geom.cols; c++) {
        const k = layer.keys?.[r]?.[c];
        flat.layers[l].keys.push(
          (k && k.type) ? { type: k.type, value: k.value } : { type: 0, value: '' });
      }
    }
  }

  const lastLayer = preset.layers?.[layerCount - 1] || null;
  for (let i = 0; i < geom.numEncoders; i++) {
    for (const key of ['encCw', 'encCcw', 'encBtn']) {
      const a = lastLayer?.[key]?.[i];
      flat.enc.push(a && a.type ? { type: a.type, value: a.value } : { type: 0, value: '' });
    }
  }

  return flat;
}

/**
 * Upload preset biner via protocol frame v2.
 *
 * Alur Fase 5 (credit flow control):
 *   1. Encode preset → binary payload (termasuk CRC32)
 *   2. Kirim CFG_BEGIN dengan slot tujuan
 *   3. Tunggu CFG_READY: berisi credit (ruang staging tersedia)
 *   4. Kirim CFG_WRITE menggunakan WriteWithoutResponse, sebanyak credit yang ada
 *   5. Device mengirim CREDIT untuk menambah ruang saat dibutuhkan
 *   6. Kirim CFG_COMMIT → dapatkan CFG_RESULT (kode + sig)
 *   7. Jika sukses, aktifkan slot lewat CFG_ACTIVATE
 *
 * Fase 4 (tanpa credit): CFG_BEGIN fire-and-forget, CFG_WRITE menggunakan
 * WriteWithResponse. Fase 5 menambahkan back-pressure sehingga app tidak
 * menumpuk data lebih cepat dari device.
 *
 * @param {object} preset preset app
 * @param {object} geom {rows, cols, numEncoders}
 * @param {number} slot target slot (0..APP_SLOTS-1)
 * @param {function} onProgress callback (sent, total) untuk progress bar
 * @returns {Promise<{ok:boolean, sig?:number, reason?:string}>}
 */
export async function uploadPresetBinary(preset, geom, slot, onProgress) {
  if (slot < 0 || slot >= APP_SLOTS) {
    return { ok: false, reason: 'slot tidak valid' };
  }

  const dims = cfgSigDims(geom);
  const flat = presetToFlat(preset, geom);
  const payload = encodePreset(flat, dims);

  const maxChunk = 237; // maxPayload from frame.h, minus overhead
  const { chunkSize: defaultChunk } = chunkPlan(payload.length, maxChunk);

  // ---- 1. CFG_BEGIN → CFG_READY{credit u16} ----
  // CFG_BEGIN dikirim dengan WriteWithResponse (via sendFrame). Device sarat
  // staging buffer dan merespons CFG_READY dengan credit yang tersedia.
  const beginWaiter = waitForFrame(T_CFG_READY, RTT_MS);
  const beginErrWaiter = waitForFrame(T_ERR, RTT_MS);
  const beginOk = await sendFrame(T_CFG_BEGIN, [slot & 0xff]);
  if (!beginOk) return { ok: false, reason: 'gagal kirim CFG_BEGIN' };

  // Tunggu CFG_READY, atau ERR jika device tidak mengenali CFG_BEGIN.
  const beginRace = await Promise.race([
    beginWaiter.then(p => ({ kind: 'ready', payload: p })),
    beginErrWaiter.then(p => ({ kind: 'err', payload: p })),
  ]);
  // Batalkan waiter yang kalah supaya tidak mencuri frame berikutnya.
  if (beginRace.kind === 'ready') beginErrWaiter.cancel(); else beginWaiter.cancel();

  if (beginRace.kind === 'err' && beginRace.payload) {
    const errInfo = parseErr(beginRace.payload);
    return { ok: false, reason: `device menolak CFG_BEGIN: ${ERR_NAMES[errInfo.code] || 'UNKNOWN'}` };
  }

  if (!beginRace.payload) {
    return { ok: false, reason: 'timeout menunggu CFG_READY' };
  }

  // Parse credit dari CFG_READY (u16 LE)
  const creditField = Array.from(beginRace.payload);
  let credit = creditField.length >= 2
    ? (creditField[0] | (creditField[1] << 8)) >>> 0
    : 0;

  if (credit <= 0) {
    return { ok: false, reason: 'device memberi credit 0' };
  }

  // ---- 2. CFG_WRITE dengan credit flow control ----
  //
  // Credit = sisa ruang staging yang boleh ditulis. Payload maksimum satu preset
  // adalah 4838 byte dan staging 5120, jadi credit dari CFG_READY selalu cukup
  // untuk seluruh payload. Artinya loop di bawah tidak PERLU menunggu frame
  // CREDIT - dan itu memang disengaja.
  //
  // Versi lama menunggu T_CREDIT setiap kali credit habis. Itu terlihat aman,
  // tapi salah: firmware tidak pernah menambah credit (tidak ada siklus flush,
  // staging di-commit utuh di akhir). Begitu credit habis, app menunggu frame
  // yang tidak akan pernah datang, timeout 2 detik, upload gagal, lalu caller
  // turun ke jalur teks yang mengirim ratusan baris SET. Itulah pemicu gejala
  // "app diam beberapa menit lalu stream membanjiri".
  //
  // Frame CREDIT tetap dipantau: device mengirimnya sebagai umpan balik bahwa
  // data diterima. Kalau credit benar-benar habis sebelum payload selesai, upload
  // berhenti dengan alasan yang jelas supaya caller bisa turun ke jalur teks
  // dengan log yang jujur - bukan diam 2 detik lalu menebak.
  let sent = 0;
  let chunkStart = 0;

  while (chunkStart < payload.length) {
    const remaining = payload.length - chunkStart;
    // Credit dipotong per frame UTUH. Kalau dipotong per chunk, sisa credit bisa
    // bukan kelipatan ukuran payload frame, dan frame terakhir jadi tidak valid.
    const creditFrames = Math.floor(credit / maxChunk);
    if (creditFrames < 1) {
      return {
        ok: false,
        reason: `staging device penuh (sisa credit ${credit} byte < 1 frame ${maxChunk} byte) - turun ke jalur teks`,
      };
    }

    // Kirim frame, TANPA melanggar batas payload NUS.
    //
    // Perhitungan batas ini yang membuat penggabungan frame TIDAK dilakukan di
    // sini: payload NUS maksimal MTU-3, di MTU 247 itu 244 byte, dan satu frame
    // CFG_WRITE payload 237 byte sudah memakai 244 byte (237 + 5 header + 2 CRC).
    // Dua frame dalam satu write = 481 byte, dan Windows memotong write
    // characteristic tanpa memberi tahu - preset yang terpotong bisa lolos
    // pemeriksaan CRC di sisi app kalau tidak hati-hati.
    //
    // Jadi framesPerWrite di sini selalu 1 pada MTU 247. Kecepatan upload
    // IMDALIKAN dari pemangkasan jumlah frame yang dikirim, bukan dari
    // penggabungan. Lihat comentário maxChunk di atas.
    const framesThisWrite = Math.min(
      creditFrames,
      Math.ceil(remaining / maxChunk),
    );
    const take = Math.min(remaining, framesThisWrite * maxChunk);

    const bytes = [];
    for (let o = chunkStart; o < chunkStart + take; o += maxChunk) {
      const end = Math.min(o + maxChunk, chunkStart + take);
      bytes.push(...encode(T_CFG_WRITE, Array.from(payload.slice(o, end))));
    }
    const ok = await sendRawNoAck(new Uint8Array(bytes));
    if (!ok) return { ok: false, reason: 'gagal kirim CFG_WRITE' };

    chunkStart += take;
    // Potong sebesar PAYLOAD yang diterima device, bukan sebesar byte di wire.
    // Device hanya menghitung `len` dari payload CFG_WRITE, jadi header + CRC
    // tidak boleh ikut mengurangi credit - kalau iya, credit habis jauh lebih
    // cepat daripada yang device harapkan.
    credit -= take;
    sent += take;
    if (onProgress) onProgress(Math.min(sent, payload.length), payload.length);
  }

  // ---- 3. CFG_COMMIT → CFG_RESULT ----
  // requestFrame sudah membatalkan waiter yang kalah secara internal.
  const r = await requestFrame(T_CFG_COMMIT, T_CFG_RESULT, []);
  if (!r.ok) {
    return { ok: false, reason: r.reason || 'timeout CFG_COMMIT' };
  }
  const result = parseCfgResult(r.payload);
  if (!result || result.code !== 0) {
    const code = result ? result.code : -1;
    return { ok: false, reason: `device CONFIG_COMMIT error: code=${code} (${ERR_NAMES[code] || 'UNKNOWN'})` };
  }

  return { ok: true, sig: result.sig, slot: result.slot };
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