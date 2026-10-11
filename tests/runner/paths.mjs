// Helper path untuk seluruh skrip uji.
//
// SEBELUM file ini ada, setiap skrip uji meng-hardcode path absolut repo
// (mis. 'file:///E:/05_Finish_projects/macropad-configurator/src') dan path
// absolut folder temp. Dua akibat:
//   1. skrip hanya jalan di mesin + lokasi folder yang sama
//   2. begitu folder temp dibersihkan, seluruh jaringan uji hilang tanpa jejak
//
// File ini membuat path dihitung dari POSISI file-nya sendiri, jadi:
//   - dipindah ke drive atau folder lain -> tetap jalan
//   - repo di-clone di mana saja -> tetap jalan
//
// Uso en los tests:
//   import { SRC, SRC_URL, FILE } from '../runner/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// tests/runner/paths.mjs  ->  naik 2 tingkat = root repo
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Folder src/ sebagai path filesystem biasa (untuk fs.readFileSync). */
export const SRC = path.join(REPO, 'src');

/** Folder src/ sebagai file:// URL (WAJIB untuk import() dinamis di Node). */
export const SRC_URL = pathToFileURL(SRC).href;

/** Root repo sebagai file:// URL. */
export const REPO_URL = pathToFileURL(REPO).href;

/** Folder tests/runner/ - tempat stub Tauri dan runner. */
export const STUB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Folder tests/suites/ - seluruh skrip uji utama. */
export const SUITES_DIR = path.join(REPO, 'tests', 'suites');

/** Folder tests/negative/ - uji negatif, dijalankan TERPISAH (mengacak repo). */
export const NEGATIVE_DIR = path.join(REPO, 'tests', 'negative');

/**
 * Terapkan mutasi pada file sumber, tahan terhadap perbedaan line ending.
 *
 * Git mengonversi LF <-> CRLF saat checkout di Windows. Pola yang ditulis di
 * skrip uji negatif pakai "\n" (LF), sedangkan file hasil checkout di disk
 * berisi "\r\n" (CRLF) - sehingga pola tidak ketemu dan skrip keluar dengan
 * "pola tidak ditemukan" padahal file-nya sebenarnya tidak berubah.
 *
 * Cara ini menormalkan isi ke LF saat membaca, menerapkan mutasi, lalu
 * menulis kembali dengan line ending asli file tersebut.
 *
 * @param {string} file    path absolut ke file
 * @param {string} from    pola yang dicari (pakai \n)
 * @param {string} to      pengganti
 * @returns {boolean}      true kalau pola ditemukan dan file ditulis
 */
export function mutate(file, from, to) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const lf = crlf ? raw.replace(/\r\n/g, '\n') : raw;

  if (!lf.includes(from)) return false;

  const changed = lf.replace(from, to);
  fs.writeFileSync(file, crlf ? changed.replace(/\n/g, '\r\n') : changed, 'utf8');
  return true;
}

/**
 * Baca file sumber dengan line ending dinormalkan ke LF.
 *
 * Dipakai saat hanya perlu MEMBACA dan mencari pola, tanpa menulis - misalnya
 * saat memeriksa "apakah mutasi benar-benar diterapkan".
 */
export function readLf(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Cari file suite berdasarkan nama, dengan atau tanpa ekstensi.
 *
 * Dipakai oleh tests/negative/, yang menunjuk suite berdasarkan nama logis
 * (mis. 'a11y-test') sementara file aslinya bisa .js, .cjs, atau .mjs.
 * .cjs wajib untuk CommonJS karena package.json punya "type": "module".
 *
 * Tanpa ini, setiap kali ada suite yang di-rename, semua skrip negative
 * ikut rusak diam-diam dan tidak ada yang memberi tahu.
 */
export function suite(name) {
  const stem = name.replace(/\.(js|cjs|mjs)$/, '');
  for (const ext of ['.js', '.cjs', '.mjs']) {
    const p = path.join(SUITES_DIR, stem + ext);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `suite tidak ditemukan: ${name} (dicari ${stem}.js/.cjs/.mjs di ${SUITES_DIR})`
  );
}

/** Path absolut ke file lain di dalam repo, dari root. */
export function FILE(...parts) {
  return path.join(REPO, ...parts);
}
