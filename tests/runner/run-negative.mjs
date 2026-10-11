// Runner uji negatif.
//
// JANGAN jalankan ini bersamaan dengan edit, commit, atau `npm test`.
//
// Uji negatif SENGAJA merusak file repo, menjalankan suite untuk memastikan
// suite itu menangkap regresi, lalu memulihkan file seperti semula. Kalau
// prosesnya terbunuh di tengah (Ctrl+C, crash, laptop mati), repo bisa
// tertinggal dalam keadaan rusak. Karena itu:
//   1. pastikan working tree BERSIH sebelum mulai
//   2. jangan buka editor / jalankan perintah lain saat ini berjalan
//   3. setelah selesai, selalu cek `git status`
//
// Jalankan: node tests/runner/run-negative.mjs
//           (opsional) daftar nama file yang mau diuji:
//           node tests/runner/run-negative.mjs negative-cycle negative-readme
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, NEGATIVE_DIR } from './paths.mjs';

const hanya = process.argv.slice(2);
const semua = fs.readdirSync(NEGATIVE_DIR)
  .filter(f => /^negative-.*\.mjs$/.test(f))
  .filter(f => hanya.length === 0 || hanya.some(h => f.includes(h)))
  .sort();

if (semua.length === 0) {
  console.log('Tidak ada file yang cocok.');
  process.exit(1);
}

// Syarat: repo harus bersih. Kalau tidak, file yang rusak oleh uji negatif
// akan tercampur dengan perubahan milikmu sendiri dan hasilnya tak terbaca.
let dirty = '';
try {
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
} catch {
  console.log('PERINGATAN: tidak bisa menjalankan git status - lanjut tanpa pemeriksaan.');
}
if (dirty.trim()) {
  console.log('Repo TIDAK bersih. Commit atau stash dulu sebelum menjalankan uji negatif:\n');
  console.log(dirty.trim());
  console.log('\nAlasannya: uji negatif merusak file sementara lalu memulihkannya.');
  console.log('Kalau repo sudah ada perubahan lain, file yang kamu ubah dan file');
  console.log('yang dirusak uji akan tercampur dan hasilnya tidak bisa dipercaya.');
  process.exit(1);
}

console.log(`Menjalankan ${semua.length} uji negatif. Jangan ganggu proses ini.\n`);

let gagal = 0;
const hasil = [];

for (const f of semua) {
  const label = f.replace(/\.mjs$/, '');
  process.stdout.write(`  ${label.padEnd(30)} `);
  try {
    const out = execFileSync('node', [path.join(NEGATIVE_DIR, f)], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('OK');
    hasil.push([label, 'OK']);
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).trim().split('\n').filter(Boolean);
    console.log('GAGAL');
    for (const l of out.slice(0, 6)) console.log(`        ${l}`);
    gagal++;
    hasil.push([label, 'GAGAL']);
  }

  // Jaring pengaman: setelah tiap skrip, repo harus kembali seperti semula.
  try {
    const after = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
    if (after.trim()) {
      console.log(`        PERINGATAN: repo tidak bersih setelah ${label}:`);
      for (const l of after.trim().split('\n')) console.log(`          ${l}`);
      console.log('        Jalankan: git checkout -- .');
      gagal++;
      hasil.push([label, 'KOTOR']);
    }
  } catch { /* git tidak tersedia - abaikan */ }
}

const okCount = hasil.filter(h => h[1] === 'OK').length;
console.log(`\n${okCount}/${semua.length} uji negatif hijau`);

const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
if (status.trim()) {
  console.log('\nRepo TIDAK bersih di akhir run. Pulihkan dengan: git checkout -- .');
  process.exit(1);
}
console.log('Repo bersih di akhir run.');
process.exit(gagal ? 1 : 0);
