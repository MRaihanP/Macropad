// ==================== WATCHDOG PAINT JENDELA UTAMA ====================
//
// Setelah aplikasi ditutup/dibunuh lalu langsung dijalankan lagi, jendela
// utama kadang muncul PUTIH: JavaScript di dalamnya berjalan normal (serial
// connect, log, preset switching) tapi renderer WebView2 tidak pernah
// menghasilkan satu frame pun. Penyebabnya biasanya webview lama belum
// sepenuhnya keluar saat instance baru mulai.
//
// Sinyal "apakah JS hidup" tidak bisa dipakai untuk mendeteksi ini, karena
// JS-nya memang hidup - yang mati adalah melukisnya. Yang bisa dipakai
// adalah requestAnimationFrame: callback-nya hanya jalan kalau browser benar
// benar menghasilkan frame. Kalau jendela putih, sinyal ini tidak pernah
// datang, dan Rust bisa memuat ulang jendela sendiri.
//
// Dua laporan terpisah supaya Rust tahu masalahnya di mana:
//  - paint_script_ran  : modul ini dieksekusi (halaman termuat, JS hidup)
//  - paint_first_frame : frame pertama benar-benar ter-composite
//
// Kalau yang pertama datang tapi yang kedua tidak, berarti renderer macet.
// Kalau dua-duanya tidak datang, berarti halaman gagal dimuat sama sekali.

import { invoke } from '@tauri-apps/api/core';

const report = (cmd) => { invoke(cmd).catch(() => {}); };

// Dieksekusi begitu modul ini dimuat: halaman sudah termuat & JS hidup.
report('paint_script_ran');

// Callback pertama bisa jalan sebelum frame benar-benar digambar, jadi lewati
// satu frame lalu daftarkan di frame berikutnya - itu yang benar-benar ter-paint.
requestAnimationFrame(() => {
  requestAnimationFrame(() => report('paint_first_frame'));
});