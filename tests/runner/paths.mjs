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

/** Path absolut ke file lain di dalam repo, dari root. */
export function FILE(...parts) {
  return path.join(REPO, ...parts);
}
