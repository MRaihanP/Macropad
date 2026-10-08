// ==================== I18N ====================
//
// Terjemahan antarmuka untuk dua bahasa: Bahasa Indonesia (id) dan English (en).
//
// Prinsip yang dipegang:
//
//  1. **Tidak ada string yang boleh hilang diam-diam.** `t()` untuk kunci yang
//     tidak ada akan mencatat peringatan ke console dan mengembalikan kunci itu
//     sendiri, bukan string kosong. UI yang kosong atau menampilkan "undefined"
//     jauh lebih sulit didiagnosis daripada UI yang menampilkan nama kuncinya.
//     `i18n-test.js` gagal kalau ada kunci yang hilang di salah satu bahasa.
//
//  2. **Kegagalan satu bahasa tidak boleh membuat UI kosong.** Kalau kunci tidak
//     ada di bahasa aktif, dicoba ke bahasa dasar (id), lalu baru ke kunci itu
//     sendiri. Jadi tabel terjemahan yang belum tuntas tetap bisa dipakai.
//
//  3. **Teks yang sudah dirender harus ikut berubah saat bahasa diganti.**
//     Teks statis di index.html ditangani `applyI18n()` lewat atribut `data-i18n`.
//     Teks yang dibuat runtime (grid, daftar preset, notifikasi) harus mendaftarkan
//     fungsi render ulang lewat `registerRerender()`; kalau tidak, konten itu akan
//     tetap berbahasa lama sampai halaman di-refresh.
//
//  4. **Format pesan pakai placeholder bernama**, `{n}`, bukan penyambungan string
//     dengan operator +. Alasannya: urutan kata berbeda antara bahasa, dan
//     penyambungan manual akan menghasilkan kalimat yang salah di salah satu bahasa.

import { invoke } from '@tauri-apps/api/core';
import { id as ID } from './locales/id.js';
import { en as EN } from './locales/en.js';

// Bahasa yang bisa dipilih user, sesuai urutan di dropdown Setting.
export const LANGUAGES = [
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'en', name: 'English' },
];

// Bahasa dasar: dipakai kalau kunci hilang di bahasa aktif, dan jadi pilihan
// terakhir kalau deteksi locale sistem gagal.
export const FALLBACK = 'id';

const DICT = { id: ID, en: EN };

// Kunci localStorage untuk pilihan bahasa yang ditekan USER. Sengaja tidak
// dipakai untuk menyimpan hasil deteksi otomatis - pemisahan ini yang membuat
// "ikuti bahasa Windows" tetap bekerja setelah user mengubah bahasa di Windows.
const KEY_LANG = 'appLanguage';

// Bahasa aktif. Diinisialisasi ke FALLBACK supaya modul lain yang diimpor lebih
// awal tidak pernah melihat `undefined`.
let current = FALLBACK;

// Kunci yang tidak ditemukan, dikumpulkan supaya bisa dilaporkan sekaligus
// (berguna saat menambah bahasa baru: satu test menunjukkan semua yang kurang).
const missing = new Set();

// Fungsi render ulang yang terdaftar, dipanggil saat bahasa berubah.
const rerenderers = new Set();

/** Daftar kunci yang tidak ditemukan sejak app start. Diekspor untuk test. */
export function missingKeys() { return [...missing]; }

/** Bahasa aktif sekarang. */
export function getLanguage() { return current; }

/**
 * Terjemahkan `key` ke bahasa aktif.
 *
 * `params` mengisi placeholder `{nama}`. Nilai yang hilang dari `params` dibiarkan
 * apa adanya sebagai `{nama}` - lebih mudah terlihat daripada string kosong.
 */
export function t(key, params) {
  const tables = [DICT[current], DICT[FALLBACK]];
  let out;
  for (const table of tables) {
    if (table && Object.prototype.hasOwnProperty.call(table, key)) { out = table[key]; break; }
  }
  if (out === undefined) {
    missing.add(key);
    // `console.warn` sengaja: di produksi ini muncul di WebView2 devtools dan
    // supaya string yang lupa diterjemahkan ketahuan saat pengembangan, bukan
    // baru saat user mengeluh.
    console.warn(`[i18n] kunci "${key}" tidak ada di tabel "${current}"`);
    return key;
  }
  if (!params) return out;
  return out.replace(/\{(\w+)\}/g, (m, nama) => (
    Object.prototype.hasOwnProperty.call(params, nama) ? String(params[nama]) : m
  ));
}

/**
 * Mendaftarkan fungsi yang harus dijalankan ulang ketika bahasa berubah.
 * Mengembalikan fungsi untuk berhenti mendaftar (dipakai test).
 */
export function registerRerender(fn) {
  rerenderers.add(fn);
  return () => rerenderers.delete(fn);
}

/** Jalankan semua render ulang yang terdaftar. */
function runRerenders() {
  for (const fn of rerenderers) {
    // Satu render ulang yang melempar tidak boleh menghentikan yang lain -
    // kalau tidak, satu modul yang salah akan membuat seluruh UI tidak berubah
    // tanpa ada pesan error yang jelas.
    try { fn(current); }
    catch (e) { console.error('[i18n] render ulang gagal:', e); }
  }
}

/**
 * Terjemahkan teks statis di DOM.
 *
 * `data-i18n="kunci"` mengisi textContent.
 * `data-i18n-attr="placeholder:kunciA|title:kunciB"` mengisi atribut.
 * `data-i18n-n="30"` bersama `data-i18n="settings.sleep.minutes"` mengisi
 *   placeholder `{n}`. Perlu atribut terpisah karena HTML tidak bisa menyisipkan
 *   angka ke dalam nama atribut - nilainya harus tetap angka di satu tempat
 *   supaya bisa dipakai ulang untuk perhitungan.
 *
 * Elemen yang belum diterjemahkan akan diberi penanda `data-i18n-missing` supaya
 * `i18n-test.js` bisa melihat bagian yang terlewat.
 */
export function applyI18n(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    // `data-i18n-n` opsional: kalau ada, isikan placeholder {n} dengan angka
    // yang diubah jadi teks. String() dipakai supaya angka besar tidak muncul
    // dalam notasi eksponensial.
    const n = node.getAttribute('data-i18n-n');
    const params = (n === null) ? undefined : { n: String(parseInt(n, 10)) };
    const val = t(key, params);
    node.textContent = val;
    if (val === key) node.setAttribute('data-i18n-missing', '1');
    else node.removeAttribute('data-i18n-missing');
  }
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    const pairs = node.getAttribute('data-i18n-attr').split('|');
    for (const pair of pairs) {
      const pisah = pair.indexOf(':');
      if (pisah < 0) continue;
      const attr = pair.slice(0, pisah).trim();
      const key = pair.slice(pisah + 1).trim();
      node.setAttribute(attr, t(key));
    }
  }
}

/** Dua huruf pertama locale, mis. "id-ID" -> "id". Cermin `language_of` di Rust. */
export function languageOf(locale) {
  if (!locale) return '';
  return locale.split(/[-_]/)[0].toLowerCase();
}

/**
 * Baca bahasa dari sistem operasi lewat command Rust `system_locale`.
 * Mengembalikan kode bahasa, atau `null` kalau tidak bisa ditentukan.
 */
export async function detectSystemLanguage() {
  try {
    const locale = await invoke('system_locale');
    const code = languageOf(locale);
    return DICT[code] ? code : null;
  } catch (e) {
    // Command gagal (mis. environment tanpa locale) - bukan kondisi yang perlu
    // diperingatkan user, tapi perlu dicatat supaya bisa ditelusuri.
    console.warn('[i18n] gagal membaca locale sistem:', e);
    return null;
  }
}

/** Simpan pilihan bahasa user. */
export function storeLanguage(code) {
  try { localStorage.setItem(KEY_LANG, code); } catch (e) { /* localStorage bisa diblokir */ }
}

/**
 * Ganti bahasa aktif, terapkan ke DOM, jalankan render ulang, dan simpan.
 * `persist = false` dipakai oleh test supaya tidak mengotori localStorage.
 */
export function setLanguage(code, persist = true) {
  if (!DICT[code]) {
    console.warn(`[i18n] bahasa "${code}" tidak dikenal, tetap memakai "${current}"`);
    return current;
  }
  current = code;
  if (persist) storeLanguage(code);
  document.documentElement.lang = code;
  applyI18n();
  runRerenders();
  return current;
}

/**
 * Isi dropdown `#languageSelect` dan hubungkan ke `setLanguage()`.
 *
 * Dipisah dari `initI18n()` supaya bisa dipanggil tanpa efek samping apa pun -
 * dipakai test untuk memeriksa daftar bahasanya.
 */
export function initLanguageSelect(selectEl) {
  if (!selectEl) return;
  // Opsi dibuat ulang setiap kali dipanggil supaya labelnya ikut berubah kalau
  // nama bahasa suatu saat ikut diterjemahkan. Nilai `code` sengaja TIDAK lewat
  // t() - itu pengenal internal, bukan teks yang boleh diedit user.
  selectEl.innerHTML = '';
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name;
    selectEl.appendChild(opt);
  }
  selectEl.value = current;
  // `onchange`, bukan addEventListener: dipanggil ulang kalau halaman dimuat
  // dua kali (hot reload saat pengembangan), dan listener lama akan menumpuk
  // sehingga satu perubahan bahasa memicu setLanguage berkali-kali.
  selectEl.onchange = () => {
    setLanguage(selectEl.value);
    // Atur ulang ke bahasa yang benar-benar dipakai: kalau selectEl.value tidak
    // dikenal, setLanguage() menolaknya dan dropdown akan menampilkan pilihan
    // yang tidak sama dengan UI yang aktif.
    selectEl.value = current;
  };
}

/**
 * Inisialisasi bahasa: pakai pilihan yang tersimpan, kalau tidak ada ambil dari
 * bahasa Windows, kalau tidak ada lagi jatuh ke bahasa dasar.
 *
 * Dikembalikan sebagai Promise supaya main.js bisa menunggu sebelum render
 * pertama - kalau tidak, user akan melihat sesaat teks dalam bahasa yang salah,
 * lalu teksnya berubah sendiri beberapa milidetik kemudian.
 */
export async function initI18n() {
  let pilih = null;
  try { pilih = localStorage.getItem(KEY_LANG); } catch (e) { /* diabaikan */ }

  if (pilih && DICT[pilih]) {
    // User sudah pernah memilih sendiri. Berhenti di sini: kalau tidak, pilihan
    // itu akan ditimpa setiap kali bahasa Windows berubah.
    setLanguage(pilih, false);
    return current;
  }

  // Belum pernah memilih: ikuti bahasa Windows. Hasilnya TIDAK ditulis ke
  // KEY_LANG, karena KEY_LANG berarti "pilihan user" - kalau hasil deteksi
  // disimpan di sana, mengubah bahasa di Windows tidak akan berefek apa pun
  // pada aplikasi ini selamanya.
  const dariSistem = await detectSystemLanguage();
  setLanguage(dariSistem || FALLBACK, false);
  return current;
}
