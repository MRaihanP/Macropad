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

/**
 * Daftarkan pemeriksa PONG. Bernilai benar kalau ada slot kosong.
 *
 * @param {function(boolean): void} fn dipanggil dengan hasil probe
 * @returns {boolean} false kalau slot sudah dipakai
 */
export function registerPongProbe(fn) {
  if (handler) return false;
  handler = fn;
  return true;
}

/** Lepas probe. Aman dipanggil walau slot sudah kosong. */
export function clearPongProbe() {
  handler = null;
}

/**
 * Laporkan PONG yang diterima ke probe yang menunggu.
 *
 * Dipanggil protocol-parser.js setiap kali baris PONG lewat. Kalau tidak ada
 * probe, ini bukan error: keepalive PONG yang biasa harus tetap jalan seperti
 * sebelumnya.
 *
 * @returns {boolean} true kalau ada probe yang menerima
 */
export function reportPong() {
  if (!handler) return false;
  const fn = handler;
  // Slot dilepas SEBELUM pemanggil dipanggil. Kalau tidak, probe yang memanggil
  // ensureLineMode() lagi di dalam callback-nya akan ditolak, dan tidak ada
  // jalur untuk mengosongkan slot setelah selesai.
  handler = null;
  fn(true);
  return true;
}