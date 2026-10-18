// ==================== FRAME RX (decoder persisten) ====================
//
// Satu-satunya tempat di app yang memahami byte MASUKAN biner frame.
//
// DESAIN INI MENJALANKAN DUA-SISI PADA WAKTU YANG SAMA, dan itu disengaja.
//
// Versi pertama memakai model "ganti": begitu ada yang sedang menunggu jawaban
// frame, seluruh byte masuk dialihkan ke frame decoder dan parser baris DILEWATI.
// Itu salah, dan buktinya datang dari pengujian di perangkat:
//
//   [FRAME] CFG_ACTIVATE (8 byte): a5 02 14 01 00 01 87 72
//     -> kode=0 sig=292C0F05 slot=1
//   EVT:LAYER:0
//
// EVT:LAYER:0 itu TEKS, dan tetap keluar saat device sedang mode frame. Dengan
// model "ganti", event itu hilang - user menekan knob di device dan tidak ada
// apa-apa yang terjadi di app. Lebih buruk: kalau device sedang mengirim DUMP
// (isinya baris teks seperti "0,1,2,7,notepad.exe"), semua itu jadi byte acak
// bagi frame decoder dan baris yang sehat ikut hilang.
//
// Jadi sekarang byte masuk dialirkan ke KEDUA jalur sekaligus:
//
//   byte baru -> feedFrameBytes() -> FrameDecoder persisten -> waiter/listener
//              -> parser baris (lineBuffer) -> handleLine()  -> UI
//
// Frame decoder hanya bereaksi pada 0xA5 (SOF), jadi byte ASCII lain tertahan
// di luar dan tidak mengganggu. Satu pengecualian nyata: 0xA5 adalah
// continuation byte yang sah di UTF-8 (U+00A5, lambang yen), jadi teks yang
// memuat lambang itu bisa memicu percobaan SOF yang gagal dan menambah satu
// ke penghitung err_ver. Gejalanya hanya satu counter yang naik - TIDAK merusak
// frame, karena perakit resync lalu mencari SOF lagi. Firmware punya sifat yang
// sama persis, jadi ini simetris, bukan ketidaksesuaian satu sisi.
//
// Kenapa modul terpisah: frame-transport.js mengimpor sendRaw() dari
// transport.js facade, sementara facade itu mengimpor backend (serial / BLE).
// Kalau backend juga mengimpor dari frame-transport.js, terbentuk siklus:
//
//   transport.js -> serial-transport.js -> frame-transport.js -> transport.js
//
// Modul tanpa dependensi ke facade memutus siklus itu. Modul ini juga tidak
// mengimpor transport.js sama sekali - dia murni menerima byte dan meneruskannya
// ke waiter.
//
// Percakapan dengan device yang belum mendukung frame akan terlihat sebagai
// timeout, bukan sebagai frame rusak - dan itu memang jujur: tidak ada byte
// yang bisa membedakan "device lama" dari "device yang bisu".

import { FrameDecoder } from './frame-codec.js';

// Decoder persisten. Satu instance untuk seluruh sesi: state harus bertahan antar
// chunk karena satu frame sering datang terbelah beberapa chunk. Notifikasi BLE
// Maximum 20 sampai 244 byte, sementara jawaban CFG_META 38 byte dan frame bulk
// nanti bisa lebih besar lagi. Decoder baru per permintaan akan kehilangan
// setengah frame setiap kali chunk membelah di tengah payload.
const decoder = new FrameDecoder();

// Antrean penunggu per tipe frame. FIFO per tipe: dua permintaan CFG_QUERY
// berurutan dijawab berurutan, jadi yang lebih dulu menunggu harus yang lebih
// dulu menerima - bukan yang kebetulan lebih cepat membandingkan payload.
const waiters = new Map();   // type -> [{ resolve, timer }]

// Listener permanen per tipe, untuk telemetry dan hal yang tidak butuh jawaban.
const listeners = new Map(); // type -> Set<fn>

// Frame yang selesai tapi tidak ada yang menunggu dan tidak ada listener-nya.
// Dihitung karena angka ini membedakan "device diam" dari "app tidak pernah
// menunggu jawaban" - dua kondisi yang gejalanya sama persis di UI.
let orphans = 0;

/**
 * Masukkan byte masuk ke perakit frame. Dipanggil transport backend untuk
 * SETIAP chunk, tanpa syarat.
 *
 * @param {Uint8Array|number[]} bytes
 * @returns {number} jumlah frame yang selesai pada pemanggilan ini
 */
export function feedFrameBytes(bytes) {
  if (!bytes || !bytes.length) return 0;
  let done = 0;
  for (const ev of decoder.push(bytes)) {
    // Error struktur (BAD_VER / BAD_CRC / LEN_OVERFLOW) sudah dihitung di
    // decoder.stats. Tidak ada yang menunggu error itu, jadi tidak perlu
    // diteruskan ke mana pun.
    if (!ev.ok) continue;
    done++;
    handOff(ev.type, ev.payload);
  }
  return done;
}

function handOff(type, payload) {
  const q = waiters.get(type);
  if (q && q.length) {
    const w = q.shift();
    if (!q.length) waiters.delete(type);
    if (w.timer) clearTimeout(w.timer);
    w.resolve(payload);
    return;                 // satu frame jatuh ke tepat satu penerima
  }
  const ls = listeners.get(type);
  if (ls) {
    for (const fn of ls) {
      // Listener yang melempar tidak boleh mematikan RX. Tanpa try/catch di
      // sini, satu bug di satu listener membuat seluruh stream byte berikutnya
      // berhenti diproses - dan gejalanya "device diam" yang tidak bisa
      // ditelusuri ke mana pun.
      try { fn(payload); } catch (e) { /* dicatat oleh pemanggil listener */ }
    }
    return;
  }
  orphans++;
}

/**
 * Tunggu frame bertipe tertentu.Qkpedia ini antrean: dua pemanggil untuk tipe
 * yang sama dilayani berurutan.
 *
 * Timeout mengembalikan null - bukan melempar. Pemanggil yang memutuskan apa
 * yang dilakukan dengan kegagalan, dan sebagian besar jalurnya adalah "coba
 * jalur teks", bukan "berhenti".
 *
 * @param {number} type tipe frame yang ditunggu
 * @param {number} timeoutMs
 * @returns {Promise<Uint8Array|null>} payload, atau null saat timeout
 */
export function waitForFrame(type, timeoutMs) {
  let w = null;
  const p = new Promise((resolve) => {
    w = { resolve, timer: null, cancelled: false };
    w.timer = setTimeout(() => {
      if (w.cancelled) return;
      const q = waiters.get(type);
      if (q) {
        const i = q.indexOf(w);
        if (i >= 0) q.splice(i, 1);
        if (!q.length) waiters.delete(type);
      }
      resolve(null);
    }, timeoutMs);
    if (!waiters.has(type)) waiters.set(type, []);
    waiters.get(type).push(w);
  });
  // Pemanggil yang kalah Promise.race harus bisa membatalkan waiter-nya.
  // Kalau tidak, waiter yang tidak dipakai tetap menggantung di antrean dan
  // akan "mencuri" frame berikutnya yang tipe-nya sama (ERR, CFG_META, dll).
  // Bukan melempar - resolve(null) supaya caller yang memanggil .then()
  // tetap mendapat null yang jujur.
  p.cancel = () => {
    if (w.cancelled) return;
    w.cancelled = true;
    if (w.timer) clearTimeout(w.timer);
    const q = waiters.get(type);
    if (q) {
      const i = q.indexOf(w);
      if (i >= 0) q.splice(i, 1);
      if (!q.length) waiters.delete(type);
    }
    w.resolve(null);
  };
  return p;
}

/**
 * Daftarkan listener permanen untuk satu tipe frame.
 * @returns {function} pencoppel untuk melepas listener
 */
export function onFrame(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => {
    const s = listeners.get(type);
    if (s) { s.delete(fn); if (!s.size) listeners.delete(type); }
  };
}

/** Buang semua state RX. Dipanggil saat disconnect. */
export function resetFrameRx() {
  decoder.resync();
  // Penunggu yang sedang menggantung dibatalkan di sini juga. Kalau tidak,
  // setiap permintaan yang gagal akan menggantung sampai batas waktu penuh -
  // dan auto-switch preset yang memanggilnya akan ikut tertahan.
  for (const q of waiters.values()) {
    for (const w of q) { if (w.timer) clearTimeout(w.timer); w.resolve(null); }
  }
  waiters.clear();
  listeners.clear();
  orphans = 0;
}

/** Angka untuk DIAG: apa yang terjadi di lapis frame. */
export function frameRxStats() {
  return {
    ...decoder.stats,
    waiting: waiters.size,
    listeners: listeners.size,
    orphans,
  };
}