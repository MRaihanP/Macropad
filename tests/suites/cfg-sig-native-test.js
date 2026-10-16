// Test runner KETIGA untuk CFG_SIG: firmware/common/crc32.h + cfg_sig.h
// diuji dengan gcc, dari berkas vektor yang sama dengan runner JavaScript.
//
// Kenapa perlu dua runner untuk satu header:
//
//   tests/native/cfg_test.c -> crc32.h + cfg_sig.h apa adanya (C)
//   tests/suites/cfg-sig-test.mjs -> src/cfg-sig.js (JS)
//
// Kalau hanya JS yang diuji, tidak ada satu pun bukti bahwa firmware dan app
// menghitung sidik jari yang sama. Dan "sama" itu bukan istilah teknis di sini:
// kalau berbeda, app akan menyimpulkan preset sudah berubah setiap kali, lalu
// mengunggah ulang config yang sebenarnya sudah identik - setiap kali.
//
// Test ini juga menguji hal yang tidak terlihat dari luar: cfg_sig.h dipakai
// firmware dengan stride sizeof(KeyAction), dan dipakai runner ini dengan
// array datar yang stride-nya BEDA. Kalau kontrak stride-nya salah, kedua
// pemakaian itu menghitung hal berbeda tanpa error sama sekali.
//
// Kalau gcc tidak ada, test ini DILEWATI dengan pesan jelas - bukan dianggap
// lulus. Suite yang diam-diam hilang lebih berbahaya daripada yang gagal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const VEC = path.join(REPO, 'tests', 'vectors', 'cfg.vec');
const SUMBER = path.join(REPO, 'tests', 'native', 'cfg_test.c');
const HEADER = ['crc32.h', 'cfg_sig.h'].map((f) => path.join(REPO, 'firmware', 'common', f));

let fail = 0;
let lewati = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };
const warn = (msg) => console.log(`  WARN ${msg}`);
const skip = (msg) => { console.log(`  LEWAT ${msg}`); lewati++; };

function jalankan(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', ...opts });
}

// ---- Cek gcc ----
let gcc = null;
for (const cand of ['gcc', 'clang', 'cc']) {
  try { jalankan(cand, ['--version'], { stdio: 'pipe' }); gcc = cand; break; } catch { /* coba berikutnya */ }
}

console.log('=== Test CFG_SIG runner C (gcc) ===\n');

if (!gcc) {
  console.log('--- compiler C tidak tersedia ---');
  skip('compiler C tidak ditemukan di PATH - test ini DILEWATI, bukan dianggap lulus');
  console.log(`\n${lewati} test dilewati: compiler C tidak ada di PATH`);
  process.exit(0);
}
console.log(`compiler: ${gcc}`);

// ---- Berkas vektor harus ada ----
console.log('\n--- 1. Berkas vektor ---');
if (!fs.existsSync(VEC)) {
  ok(false, `berkas vektor tidak ditemukan: ${VEC} - jalankan node tools/gen-cfg-vectors.mjs`);
  console.log(`\n${fail} ASSERTION GAGAL`);
  process.exit(1);
}
const isiVektor = fs.readFileSync(VEC, 'utf8');
const nCrc = (isiVektor.match(/^CRC32 /gm) || []).length;
const nSig = (isiVektor.match(/^SIG /gm) || []).length;
ok(nCrc >= 8, `vektor CRC32: ${nCrc}`);
ok(nSig >= 10, `vektor CFG_SIG: ${nSig}`);

// ---- Kompilasi ----
// Header disalin ke direktori sementara, bukan dipakai lewat -I, karena
// firmware/common/limits.h akan ME-REPLACE <limits.h> milik standar C dan
// membuat kompilasi gagal dengan error enum class yang tidak berhubungan
// dengan penyebabnya. Efek sampingnya bagus: header-nya terbukti mandiri.
console.log('\n--- 2. Kompilasi di host ---');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-sig-'));
for (const h of HEADER) fs.copyFileSync(h, path.join(dir, path.basename(h)));
fs.copyFileSync(SUMBER, path.join(dir, 'cfg_test.c'));

const cSrc = path.join(dir, 'cfg_test.c');
const exe = path.join(dir, 'cfg_test' + (process.platform === 'win32' ? '.exe' : ''));
const DASAR = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-g', '-O1'];

// -Wall -Wextra -Werror : warning diperlakukan sebagai error. Compiler yang
// toleran terhadap warning membuat test ini jauh lebih lemah dari yang
// terlihat - bug pointer/format kerap muncul sebagai warning dulu.
let sanitizerAktif = false;
try {
  jalankan(gcc, [...DASAR, '-fsanitize=address,undefined', cSrc, '-o', exe], { stdio: 'pipe' });
  sanitizerAktif = true;
  ok(true, `kompilasi bersih tanpa warning, dengan ASan/UBSan (${gcc})`);
} catch (err) {
  const pesan = `${err.stderr || ''}${err.stdout || ''}`;
  const sanitizerHilang = /cannot find -l(asan|ubsan)/.test(pesan);
  if (!sanitizerHilang) {
    ok(false, 'kompilasi gagal - lihat output gcc di bawah');
    console.log(pesan.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'));
    console.log(`\n${fail} ASSERTION GAGAL`);
    process.exit(1);
  }
  jalankan(gcc, [...DASAR, cSrc, '-o', exe], { stdio: 'pipe' });
  ok(true, `kompilasi bersih tanpa warning (${gcc})`);
  // Dilaporkan, bukan disembunyikan di dalam "SEMUA OK": tanpa sanitizer,
  // perilaku tak terdefinisi di runner ini tidak terpantau sama sekali.
  warn('ASan/UBSan tidak ada di toolchain ini, jadi perilaku tak terdefinisi tidak terpantau di runner ini');
}

// ---- Vektor ----
console.log('\n--- 3. crc32.h + cfg_sig.h cocok dengan golden vectors ---');
let keluar = 0;
try {
  keluar = jalankan(exe, [VEC], { stdio: 'pipe' });
} catch (err) {
  //Keluar dengan kode bukan nol = ada vektor yang gagal; keluarannya tetap
  //berguna untuk dilihat, jadi tidak dibuang.
  keluar = `${err.stdout || ''}${err.stderr || ''}`;
  console.log(keluar.trim().split('\n').map((l) => `      ${l}`).join('\n'));
  ok(false, 'implementasi C tidak cocok dengan golden vectors');
  console.log(`\n${fail} ASSERTION GAGAL`);
  process.exit(1);
}

const baris = keluar.trim().split('\n');
const ringkasan = baris.find((l) => l.startsWith('CFG '));
ok(/^CFG crc=\d+\/\d+ sig=\d+\/\d+$/.test(ringkasan || ''), `ringkasan terbaca: ${ringkasan}`);
if (ringkasan) {
  const m = ringkasan.match(/crc=(\d+)\/(\d+) sig=(\d+)\/(\d+)/);
  ok(m[1] === m[2], `vektor CRC32 lulus: ${m[2]}/${m[2]}`);
  ok(m[3] === m[4], `vektor CFG_SIG lulus: ${m[4]}/${m[4]}`);
  ok(+m[4] === nSig, `semua ${nSig} vektor di berkas diproses (tidak ada yang terlewat)`);
}

// Baris "OK   crc32 check value" juga harus ada. Kalau hilang, programnya
// jalan tapi tidak menjalankan apa yang kita kira - dan angka lain jadi tak
// trustworthy tanpa kita sadari.
ok(baris.some((l) => l.includes('crc32 check value')), 'check value CRC32 dicetak (bukan dilewati)');

console.log(`\n${fail === 0 ? 'SEMUA OK' : fail + ' ASSERTION GAGAL'}: crc32.h dan cfg_sig.h cocok dengan golden vectors${lewati ? ` (${lewati} dilewati)` : ''}`);
process.exit(fail ? 1 : 0);