// ==================== PROBE PONG ====================
//
// Registry satu-slot untuk "apakah device masih menjawab sebagai teks?".
//
// Kenapa modul sendiri: pemanggilnya frame-transport.js (untuk memastikan device
// sudah kembali ke mode baris), sedangkan yang menerima baris PONG dari device
// adalah protocol-parser.js. Dua-duanya sudah punya import ke arah yang lain kalau
// disambung langsung: protocol-parser.js mengimpor adaptive.js, dan adaptive.js
// mengimpor frame-transport.js. Menaruh registry di salah satu dari keduanya
// membentuk siklus.
//
// Modul ini tidak mengimpor apa pun.
//
// Bentuk "satu-slot" itu disengaja: yang diprobe adalah "apakah PONG datang",
// bukan "siapa yang menunggu". Dua pemanggil yang bersamaan akan saling
// menimpa, dan yang kalah akan menunggu sampai timeout-nya habis. Itu lebih baik
// daripada dua probe yang keduanya menerima PONG yang sama dan sama-sama
// mengira device hidup padahal hanya satu yang benar-benar mengalaminya.

let handler = null;
let lastRtt = 100;  // default: 100ms (nilai conservatis untuk pacing)
let rttSamples = []; // rolling window untuk rata-rata
const RTT_WINDOW = 5; // simpan 5 sample terbaru

/**
 * Daftarkan pemeriksa PONG. Bernilai benar kalau ada slot kosong.
 *
 * @param {function(boolean): void} fn dipanggil dengan hasil probe
 * @param {boolean} trackRtt jika true, ukur RTT dari PONG yang diterima
 * @returns {boolean} false kalau slot sudah dipakai
 */
export function registerPongProbe(fn, trackRtt = false) {
  if (handler) return false;
  handler = fn;
  if (trackRtt) {
    rttPending = true;
    rttStart = Date.now();
  }
  return true;
}

// State untuk RTT measurement
let rttStart = 0;
let rttPending = false;

/**
 * Laporkan PONG yang diterima ke probe yang menunggu.
 * Juga update RTT measurement jika registerPongProbe dipanggil dengan trackRtt=true.
 *
 * @returns {boolean} true kalau ada probe yang menerima
 */
export function reportPong() {
  if (!handler) {
    // Tetap update RTT meskipun tidak ada probe aktif — PONG keepalive juga berguna
    if (rttPending) {
      rttPending = false;
      const delta = Date.now() - rttStart;
      if (delta > 0 && delta < 5000) { // ignore outlier
        rttSamples.push(delta);
        if (rttSamples.length > RTT_WINDOW) rttSamples.shift();
        lastRtt = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
      }
    }
    return false;
  }
  const fn = handler;
  handler = null;
  fn(true);
  return true;
}

/**
 * Dapatkan RTT rata-rata terukur (ms).
 * @returns {number} RTT dalam ms, atau nilai default 100 jika belum ada sample
 */
export function getLastRtt() {
  return lastRtt;
}

/**
 * Set RTT secara manual (untuk test/mock).
 * @param {number} ms RTT dalam ms
 */
export function setLastRtt(ms) {
  lastRtt = ms;
}

/** Reset RTT measurement (dipanggil di disconnect). */
export function resetRtt() {
  lastRtt = 100;
  rttSamples = [];
  rttPending = false;
}

/** Lepas probe. Aman dipanggil walau slot sudah kosong. */
export function clearPongProbe() {
  handler = null;
  rttPending = false;
}