// ==================== STATE TRANSFER KONFIGURASI ====================
//
// Status "apakah device sedang sibuk mengolah perintah dari kita".
//
// Versi pertama menjawab itu dengan satu angka: markBatchSettling(4000) menulis
// `settleUntil = Date.now() + 4000`, dan batchUploadInFlight() mengembalikan
// `Date.now() < settleUntil`. Itu tebakan waktu, dan tebakan itu berbohong
// dalam dua arah:
//
//  - Batch kecil selesai dalam 50 ms. App tetap menganggap device sibuk 3,95
//    detik berikutnya - dan selama itu watchdog dump tidak boleh menyala.
//  - Batch besar butuh lebih dari 4 detik pada link BLE yang lambat. Jendelanya
//    habis, watchdog menyala, dan dump yang sebenarnya masih sehat dilaporkan
//    hilang. Persis gejala "preset gagal switch setelah alt+tab".
//
// 4000 juga dipilih tanpa alasan yang bisa dipertanggungjawabkan: bukan
// diukur, bukan diturunkan dari pekerjaan apa pun.
//
// YANG DIGANTI DI SINI: flag eksplisit yang mengikuti transfer yang sedang
// berjalan, plus jendela jawaban yang panjangnya DITURUNKAN dari pekerjaan nyata
// (jumlah perintah yang dikirim), bukan dari konstanta.
//
// Yang BELUM bisa diketahui: app tidak tahu device sudah selesai mengolah semua
// perintah. Jalur teks tidak punya penanda selesai - device membalas [OK] per
// perintah tanpa memberi tahu kapan antrean habis. Jawaban biner CFG_RESULT yang
// memberi penanda itu baru ada di Fase 4. Sampai itu ada, jendela jawaban tetap
// perlu, tapi sekarang panjangnya berasal dari data, bukan dari tebakan.
//
// Modul ini tidak mengimpor apa pun, jadi aman diimpor dari sisi mana pun -
// termasuk dari backend transport, yang butuh ini untuk menahan watchdog dump
// tanpa mengimpor adaptive.js (adaptive -> transport <- backend = siklus).

// Berapa command yang diasumsikan bisa diproses device per milidetik.
//
// Angka ini hasil pengamatan, bukan hasil pengukuran laboratorium: pada USB CDC
// device memproses jauh lebih cepat dari yang app bisa kirim, sedangkan di BLE
// antrean NUS ikut membatasi laju GATT. Yang penting arahnya benar - lebih banyak
// perintah berarti jendela lebih panjang - dan tidak meledak untuk preset besar.
const CMD_PER_MS = 0.05;      // 50 perintah/detik
const WINDOW_BASE_MS = 150;   // jeda tetap: bolak-balik terakhir + pemrosesan
const WINDOW_MIN_MS = 250;
const WINDOW_MAX_MS = 20000;  // batas atas, supaya preset besar tidak membuat
                              // watchdog mati lama tanpa bukti

let transferActive = false;
let lastWorkAt = 0;
let pendingCommands = 0;

// true selama transfer konfigurasi benar-benar berjalan.
export function cfgTransferActive() { return transferActive; }

// Berapa jendela jawaban yang dihitung dari pekerjaan yang sudah dikirim.
export function answerWindowMs() {
  if (pendingCommands <= 0) return 0;
  const byWork = WINDOW_BASE_MS + Math.ceil(pendingCommands / CMD_PER_MS);
  return Math.min(WINDOW_MAX_MS, Math.max(WINDOW_MIN_MS, byWork));
}

/**
 * Apakah device mungkin masih mengolah perintah dari kita?
 *
 * Dipakai backend untuk menahan watchdog dump: selama ini benar, "DUMP_END belum
 * keluar" itu wajar dan bukan tanda frame hilang.
 */
export function batchUploadInFlight() {
  if (transferActive) return true;
  return pendingCommands > 0 && Date.now() - lastWorkAt < answerWindowMs();
}

// Dipanggil backend saat watchdog yang sudah ter-arm perlu dibatalkan karena
// transfer baru dimulai. Callback di-register sekali lewat
// registerOnBatchStart(), bukan dikirim sebagai argumen dari adaptive.js -
// karena adaptive.js tidak boleh tahu apa pun tentang watchdog internal
// transport, dan transport tidak boleh mengimpor adaptive.
let onBatchStart = null;
export function registerOnBatchStart(fn) { onBatchStart = fn; }
export function notifyBatchStarted() { if (onBatchStart) onBatchStart(); }

/**
 * Tandai dimulainya transfer konfigurasi.
 *
 * Dipanggil SEBELUM perintah pertama dikirim, bukan sesudah. Kalau baru ditandai
 * setelah, ada celah di mana device sudah menjalankan ratusan SET sementara app
 * masih menganggapnya idle - dan watchdog yang sedang ter-arm akan menyala di
 * tengah pekerjaan yang sehat.
 *
 * @param {number} commands perkiraan jumlah perintah yang akan dikirim. Nilai ini
 *   hanya dipakai menghitung jendela jawaban, bukan membatasi apa pun - kalau
 *   dikira nol, jendela jadi WINDOW_MIN_MS dan bisa terlalu pendek untuk batch
 *   besar.
 */
export function beginCfgTransfer(commands = 0) {
  transferActive = true;
  pendingCommands = Math.max(0, commands | 0);
  lastWorkAt = Date.now();
  notifyBatchStarted();
}

/**
 * Tandai transfer selesai dari sisi app.
 *
 * PENTING: ini BUKAN berarti device sudah mengolah semua perintah. Device
 * masih punya antrean, dan jendela jawaban tetap berjalan di sini - itu
 * bedanya dengan flag eksplisit.
 *
 * Penutupnya di try/finally oleh pemanggil. Kalau tidak, satu kesalahan saat
 * menghitung baris preset akan meninggalkan transferActive = true selamanya,
 * dan watchdog dump tidak akan pernah menyala lagi selama sesi itu - termasuk
 * saat ada dump yang benar-benar hilang.
 */
export function endCfgTransfer() {
  transferActive = false;
  lastWorkAt = Date.now();
}

/**
 * Catat bahwa beberapa perintah baru saja dikirim.
 *
 * Dipanggil per potongan batch, bukan sekali. Ini yang membuat jendela jawaban
 * mengikuti pekerjaan yang benar-benar terjadi: batch 600 perintah dipecah jadi
 * beberapa write, dan setiap write memperpanjang jendela dari titik dikirimnya,
 * bukan dari awal transfer.
 *
 * @param {number} n jumlah perintah pada potongan ini
 */
export function noteCfgCommands(n) {
  if (!(n > 0)) return;
  pendingCommands += n | 0;
  lastWorkAt = Date.now();
}

/** Device sudah selesai mengolah semua yang dikirim - jendela ditutup. */
export function cfgAnswersSettled() {
  pendingCommands = 0;
}

/**
 * Reset penuh. Dipanggil saat disconnect, di mana memang tidak ada lagi yang
 * sedang diunggah dan device yang tersambung berikutnya adalah device lain.
 */
export function resetBatchUploadState() {
  transferActive = false;
  pendingCommands = 0;
  lastWorkAt = 0;
}