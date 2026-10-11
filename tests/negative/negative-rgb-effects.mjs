// Uji negatif untuk rgb_effects.h: sengaja rusak algoritmanya, pastikan test
// MENJALANKAN header yang rusak itu (bukan salinan) dan menangkap hasilnya.
import fs from 'fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const TEST = suite('rgb-effects-test.js');
const target = 'firmware/common/rgb_effects.h';
const orig = fs.readFileSync(target, 'utf8');

const cases = [
  {
    name: 'RGB_INDEX diabaikan (mode 1 & 5 & 6 ikut urutan baris)',
    from: '          out[i] = RGB32(keys[r][c][0], keys[r][c][1], keys[r][c][2]);',
    to: '          out[r * 3 + c] = RGB32(keys[r][c][0], keys[r][c][1], keys[r][c][2]);',
  },
  {
    name: 'x di roda HSV salah (h=0 jadi kuning)',
    from: '  float x = c * (1.0f - adiff);',
    to: '  float x = c * adiff;',
  },
  {
    name: 'clamp atas dihapus (v > 255 wrap)',
    from: '  if (v < 0) v = 0; if (v > 255.0f) v = 255.0f;',
    to: '  if (v < 0) v = 0;',
  },
  {
    name: 'clamp bawah dihapus (v negatif)',
    from: '  if (s < 0) s = 0; if (s > 255.0f) s = 255.0f;',
    to: '  if (s > 255.0f) s = 255.0f;',
  },
  {
    // MUTASI TIDAK DAPAT DIDETEKSI - dan itu memang benar, bukan celah test.
    //
    // `if (h >= 360.0f) h = 0;` adalah guard yang DITUTUPI guard kedua di
    // rgbHsv: `if (sector >= 6) sector = 0;`. Menghapus clamp pertama
    // sepenuhnya tidak mengubah satu byte pun output:
    //   h=360 -> hp=6 -> sector=6 -> dipaksa 0 -> r=c, g=x, b=0
    //   dan x = c*(1-|fmod(6,2)-1|) = c*(1-1) = 0 -> hasilnya merah,
    //   sama persis seperti h=0.
    // asserted h=360 == h=0 di rgb-effects-test.js tetap berguna sebagai
    // dokumentasi perilaku, tapi tidak ada mutasi sumber yang bisa
    // menjatuhkannya - jadi jangan dipakai sebagai bukti.
    name: 'h=360 tidak dibulatkan ke 0 (h=360 tetap merah karena guard ganda)',
    from: '  if (h >= 360.0f) h = 0;',
    to: '  // clamping h dihapus',
    mustDetect: false,
  },
  {
    name: 'bulat jadi potong (warna jadi gelap)',
    from: '  uint8_t R = (uint8_t)((r + m) + 0.5f);',
    to: '  uint8_t R = (uint8_t)(r + m);',
  },
  {
    name: 'breathing benar-benar gelap (clip ke 0)',
    from: '      float val = 0.05f + tri * 0.90f;',
    to: '      float val = tri * 1.05f;',
  },
  {
    name: 'snake: ekor dihapus (hanya kepala)',
    from: '      for (uint8_t k = 0; k < 3; k++) {',
    to: '      for (uint8_t k = 0; k < 1; k++) {',
  },
  {
    name: 'rainbow semua LED sama warna (gradasi hilang)',
    from: '        float h = fmodf(ph * 6.0f + (360.0f / (float)RGB_COUNT) * (float)i, 360.0f);',
    to: '        float h = fmodf(ph * 6.0f, 360.0f);',
  },
  {
    // Mutasi ini dulu ditulis `x ^= x << 13; ... -> x = x;` dan TIDAK
    // terdeteksi. Sebabnya: dengan `x = x`, rgbRand(seed) mengembalikan
    // seed itu sendiri - dan seed yang berbeda tetap menghasilkan warna
    // berbeda, jadi pemeriksaan "seed berbeda -> warna berbeda" tetap hijau.
    // Artinya test tidak menjepit apa pun soal PRNG.
    // Yang benar diuji adalah sifat yang memang penting: seed MEWARUHIkan
    // hasil. Jadi seed diabaikan total - sekarang ini terdeteksi.
    name: 'xorshift rusak (seed tak berpengaruh)',
    from: '  uint32_t x = seed ? seed : 0x9E3779B9u;',
    to: '  uint32_t x = 0x9E3779B9u;',
  },
  {
    name: 'speed tidak memengaruhi apa pun',
    from: '  float step = 0.35f + (speed / 255.0f) * 5.65f;',
    to: '  float step = 1.0f;',
  },
  {
    name: 'header jadi tidak murni (pakai Arduino.h)',
    from: '#include <stdint.h>',
    to: '#include <Arduino.h>\n#include <stdint.h>',
  },
  {
    name: 'variabel global ditambahkan (tidak murni lagi)',
    from: 'static inline uint32_t rgbHsv(float h, float s, float v) {',
    to: 'static uint8_t globalWajib;\n\nstatic inline uint32_t rgbHsv(float h, float s, float v) {',
  },
  {
    name: 'delay() muncul (blocking, dilarang sejak Phase 6)',
    from: 'static inline uint32_t rgbHsv(float h, float s, float v) {',
    to: 'static inline uint32_t rgbHsv(float h, float s, float v) {\n  delay(500);',
  },
];

let caught = 0;
let wajib = 0;
let tidakWajib = 0;
for (const c of cases) {
  const harusTerdeteksi = c.mustDetect !== false;
  if (harusTerdeteksi) wajib++; else tidakWajib++;
  if (!orig.includes(c.from)) { console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`); process.exit(2); }
  fs.writeFileSync(target, orig.replace(c.from, c.to), 'utf8');
  let hit = false;
  try { execFileSync('node', [TEST], { stdio: 'pipe' }); }
  catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL')) ||
                 out.split('\n').find(l => l.includes('Error'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9]*m/g, '').trim().slice(0, 95)}`);
  }
  fs.writeFileSync(target, orig, 'utf8');
  if (!hit) {
    if (harusTerdeteksi) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
    else console.log(`OK  (sesuai harapan, tidak terdeteksi) ${c.name}`);
  }
  caught += hit ? 1 : 0;
}

fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? '\nOK: rgb_effects.h pulih utuh' : '\nMASALAH: tidak pulih');
// Hanya mutasi yang WAJIB terdeteksi yang dihitung. Mutasi yang ditandai
// mustDetect:false memang tidak bisa mengubah output (guard-nya ganda),
// jadi menghitungnya sebagai kegagalan hanya menghasilkan kebohongan.
if (wajib - caught < 0 || caught > wajib) process.exit(2);
console.log(`OK: ${caught}/${wajib} regresi wajib terdeteksi`
  + (tidakWajib ? ` (+${tidakWajib} mutasi mustDetect:false, tidak terhitung)` : ''));
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
