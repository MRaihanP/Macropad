// ==================== STATE UPLOAD BATCH ====================
//
// Satu flag kecil yang lived di modul sendiri, BUKAN di adaptive.js.
//
// Kenapa tidak di adaptive.js: backend BLE (ble-transport.js) membutuhkannya
// untuk menahan watchdog dump. Kalau diletakkan di adaptive.js, transport akan
// mengimpor adaptive - dan adaptive sudah mengimpor transport. Itu siklus
// import, dan siklus import di sini berarti modul yang di-inject facade bisa
// melihat state yang belum diinisialisasi saat runtime.
//
// Modul ini tidak mengimpor apa pun, jadi aman diimpor dari sisi mana pun.

// Batas waktu sampai jawaban device selesai keluar setelah batch terakhir
// dikirim. Mengunggah preset besar = ratusan perintah SET yang device proses
// satu per satu, jadi jawabannya memang tertahan di antrean.
let settleUntil = 0;

// true selama (dan sedikit sesudah) batch upload sedang berjalan.
export function batchUploadInFlight() {
  return Date.now() < settleUntil;
}

// Dipanggil backend saat watchdog yang sudah ter-arm perlu dibatalkan karena
// batch upload baru saja dimulai. Callback ini di-register sekali lewat
// registerOnBatchStart(), bukan dikirim sebagai argumen dari adaptive.js -
// karena adaptive.js tidak boleh tahu apa pun tentang watchdog internal
// transport, dan transport tidak boleh mengimpor adaptive.
let onBatchStart = null;
export function registerOnBatchStart(fn) { onBatchStart = fn; }
export function notifyBatchStarted() { if (onBatchStart) onBatchStart(); }

// Dipanggil tepat setelah sendBatch() selesai: tandai bahwa jawaban device
// masih akan datang dalam waktu dekat.
//
// Sekaligus memberi tahu backend: watchdog yang SUDAH ter-arm sebelum batch
// dimulai harus dibatalkan. Kalau tidak, timer itu tetap berjalan dan
// menembak di tengah batch - tepat saat device sedang sibuk dan DUMP_END
// memang belum keluar.
export function markBatchSettling(ms = 4000) {
  settleUntil = Date.now() + ms;
  notifyBatchStarted();
}

// Dipanggil saat disconnect supaya batch yang menggantung tidak menyebabkan
// watchdog tertahan tanpa alasan setelah koneksi berikutnya.
export function resetBatchUploadState() {
  settleUntil = 0;
}
