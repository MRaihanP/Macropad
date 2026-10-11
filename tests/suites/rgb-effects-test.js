// Menjalankan algoritma rgbFrame() dari firmware/common/rgb_effects.h di Node.
//
// PENTING - arsitektur test ini:
// Test TIDAK menyalin algoritma secara manual. Ia MEMBACA header asli,
// menerjemahkannya dari C ke JS, lalu MENJALANKAN hasil terjemahan itu.
// Versi pertama menyalin rgbHsv/rgbFrame manual ke file test dan hanya
// membaca header sebagai teks - uji negatif membuktikan 7/7 regresi yang
// disisipkan ke header asli TIDAK TERDETEKSI. Test yang tidak menjalankan
// kode yang diuji tidak membuktikan apa pun.
//
// Yang DIVERIFIKASI (tanpa hardware):
//  - setiap mode mengisi 9 LED dengan warna valid (0..0xFFFFFF, tanpa wrap)
//  - mode statis/custom benar-benar diam
//  - mode bergerak berubah seiring phase
//  - breathing naik-turun, tidak pernah gelap total
//  - rainbow memberi 9 warna berbeda
//  - snake: tepat 3 LED menyala, kepala bergeser
//  - randomize deterministik terhadap seed
//  - header tetap murni (tanpa Arduino/millis/hardware/state global)
//
// Yang TIDAK diverifikasi: performa, warna nyata di strip, current draw.
import fs from 'fs';
import path from 'path';
import { translate } from './rgb-translate.mjs';

const root = process.cwd();
const limits = fs.readFileSync(path.join(root, 'firmware/common/limits.h'), 'utf8');
const hdr = fs.readFileSync(path.join(root, 'firmware/common/rgb_effects.h'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

// --- Eksekusi header yang benar-benar (diterjemahkan) ---------------------
let rgbHsv, rgbRand, rgbFrame, RGB32;
try {
  const fn = new Function(translate(hdr, limits) + '\nreturn { rgbHsv, rgbRand, rgbFrame, RGB32 };');
  ({ rgbHsv, rgbRand, rgbFrame, RGB32 } = fn());
} catch (e) {
  console.log('GAGAL menjalankan rgb_effects.h yang diterjemahkan:', e.message);
  process.exit(2);
}
ok(typeof rgbFrame === 'function', 'rgbFrame dari header berhasil dijalankan');
ok(typeof rgbHsv === 'function', 'rgbHsv dari header berhasil dijalankan');
ok(typeof rgbRand === 'function', 'rgbRand dari header berhasil dijalankan');

// rgbFrame punya 7 argumen; jumlah itu adalah bukti tanda tangannya utuh.
ok(rgbFrame.length === 7, `rgbFrame punya 7 parameter (ditemukan ${rgbFrame.length})`);

const COLOR = [200, 255, 255];
const KEYS = Array.from({ length: 3 }, (_, r) =>
  Array.from({ length: 3 }, (_, c) => [r * 40 + 10, c * 40 + 10, 128]));
const MODES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const luma = (c) => ((c >> 16) & 0xFF) + ((c >> 8) & 0xFF) + (c & 0xFF);
const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');

console.log('\n--- A. Setiap mode mengisi semua 9 LED dengan warna valid ---');
for (const mode of MODES) {
  const out = new Array(9).fill(null);
  rgbFrame(mode, 128, COLOR, KEYS, 0, 12345, out);
  ok(out.every(c => c !== null), `mode ${mode}: semua 9 LED terisi`);
  ok(out.every(c => Number.isInteger(c) && c >= 0 && c <= 0xFFFFFF),
    `mode ${mode}: warna dalam 0x000000..0xFFFFFF`);
}

console.log('\n--- B. Mode statis benar-benar diam ---');
for (const mode of [0, 8]) {
  const a = new Array(9), b = new Array(9);
  rgbFrame(mode, 128, COLOR, KEYS, 0, 1, a);
  rgbFrame(mode, 128, COLOR, KEYS, 200, 999, b);
  ok(a.every((v, i) => v === b[i]), `mode ${mode}: frame 0 == frame 200 (diam)`);
}
{
  const a = new Array(9);
  rgbFrame(1, 128, COLOR, KEYS, 0, 1, a);
  ok(a[0] === RGB32(KEYS[0][0][0], KEYS[0][0][1], KEYS[0][0][2]),
    'mode 1: LED 0 memakai warna tombol (0,0)');
  ok(a[3] === RGB32(KEYS[1][2][0], KEYS[1][2][1], KEYS[1][2][2]),
    'mode 1: LED 3 memakai warna tombol (1,2) - RGB_INDEX[1][2]=3');
}

console.log('\n--- C. Mode bergerak berubah seiring phase ---');
// Mode 7 dikecualikan: kodenya memang tidak memakai phase (warna dari seed).
for (const mode of [2, 3, 4, 5, 6]) {
  const a = new Array(9), b = new Array(9);
  rgbFrame(mode, 128, COLOR, KEYS, 0, 4242, a);
  rgbFrame(mode, 128, COLOR, KEYS, 60, 4242, b);
  ok(a.some((v, i) => v !== b[i]), `mode ${mode}: frame berubah antara phase 0 dan 60`);
}

console.log('\n--- D. Breathing naik-turun, tidak pernah gelap/putih total ---');
{
  let minL = 1e9, maxL = -1;
  for (let p = 0; p < 512; p += 4) {
    const out = new Array(9);
    rgbFrame(2, 128, COLOR, KEYS, p, 777, out);
    const l = luma(out[0]);
    minL = Math.min(minL, l); maxL = Math.max(maxL, l);
  }
  ok(maxL > minL, `breathing punya rentang (${minL}..${maxL})`);
  ok(minL > 0, `tidak pernah gelap total (min ${minL} > 0)`);
  ok(maxL < 765, `tidak pernah putih total (max ${maxL} < 765)`);
}

console.log('\n--- E. Rainbow: 9 warna berbeda ---');
{
  const out = new Array(9);
  rgbFrame(4, 128, COLOR, KEYS, 0, 1, out);
  ok(new Set(out).size === 9, `9 warna berbeda (ditemukan ${new Set(out).size})`);
}

console.log('\n--- F. Snake: 3 LED menyala, kepala bergeser ---');
{
  const a = new Array(9), b = new Array(9);
  rgbFrame(6, 128, COLOR, KEYS, 0, 1, a);
  rgbFrame(6, 128, COLOR, KEYS, 5, 1, b);
  const la = a.map(luma), lb = b.map(luma);
  ok(la.filter(v => v > 0).length === 3, `tepat 3 LED menyala (${la.filter(v => v > 0).length})`);
  ok(lb.filter(v => v > 0).length === 3, `tetap 3 di phase lain (${lb.filter(v => v > 0).length})`);
  const headOf = (l) => l.indexOf(Math.max(...l));
  ok(headOf(la) !== headOf(lb), `kepala bergeser (LED ${headOf(la)} -> ${headOf(lb)})`);
  ok(Math.max(...la) > Math.min(...la.filter(v => v > 0)), 'ekor lebih redup dari kepala');
}

console.log('\n--- G. Randomize deterministik terhadap seed ---');
{
  const a = new Array(9), b = new Array(9), c = new Array(9), d = new Array(9);
  rgbFrame(7, 128, COLOR, KEYS, 10, 555, a);
  rgbFrame(7, 128, COLOR, KEYS, 10, 555, b);
  rgbFrame(7, 128, COLOR, KEYS, 10, 556, c);
  rgbFrame(7, 128, COLOR, KEYS, 999, 555, d);
  ok(a.every((v, i) => v === b[i]), 'seed sama -> frame sama (reproduksi)');
  ok(c.some((v, i) => v !== a[i]), 'seed beda -> frame beda');
  ok(a.every((v, i) => v === d[i]), 'phase TIDAK dipakai mode 7 (acak per siklus, bukan per frame)');
}

console.log('\n--- H. Tidak ada wrap di phase besar ---');
{
  let good = true;
  for (const mode of MODES)
    for (const p of [0, 100, 5000, 30000, 65535]) {
      const out = new Array(9);
      rgbFrame(mode, 255, COLOR, KEYS, p, 999, out);
      if (!out.every(c => Number.isInteger(c) && c >= 0 && c <= 0xFFFFFF)) good = false;
    }
  ok(good, 'phase 0..65535 di semua mode: warna tetap valid');
}

console.log('\n--- I. Kecepatan memengaruhi perubahan ---');
{
  const slow = new Array(9), fast = new Array(9);
  rgbFrame(4, 0, COLOR, KEYS, 10, 1, slow);
  rgbFrame(4, 255, COLOR, KEYS, 10, 1, fast);
  ok(slow[0] !== fast[0], 'speed 0 dan 255 menghasilkan frame berbeda');
}

console.log('\n--- I2. rgbHsv: hue membungkus dengan benar di batas 360 ---');
// Mutasi "h >= 360 -> h = 360" menghasilkan hue yang salah HANYA di tepat
// batasnya, jadi test harus memeriksa titik itu secara langsung - tidak
// cukup hanya memeriksa frame yang tidak kebetulan jatuh di h=360.
{
  // h=360 harus equivalen h=0 (merah), bukan magenta (yang keluar kalau
  // clamping hilang dan hp=6 masuk ke case default).
  const at360 = rgbHsv(360, 255, 255);
  const atZero = rgbHsv(0, 255, 255);
  ok(at360 === atZero, `h=360 setara h=0 (${hex(at360)} vs ${hex(atZero)})`);
  ok((at360 & 0xFF) === 0x00, 'h=360 komponen biru = 0 (bukan magenta)');
  // h=720 juga harus balik ke merah - pengulangan beyond 360.
  ok(rgbHsv(720, 255, 255) === atZero, `h=720 setara h=0 (${hex(rgbHsv(720, 255, 255))})`);
  // h=60 tepat harus kuning, h=180 sian, h=300 magenta - titik batas sektor.
  // Kalau tabel sektor salah geser satu, titik-titik inilah yang gagal.
  for (const [h, want, name] of [[60, 0xFFFF00, 'kuning'], [180, 0x00FFFF, 'sian'], [300, 0xFF00FF, 'magenta']]) {
    ok(rgbHsv(h, 255, 255) === want,
      `h=${h} tepat -> ${name} (${hex(rgbHsv(h, 255, 255))}, harap ${hex(want)})`);
  }

  // Saturasi 0 harus menghasilkan abu-abu, bukan warna apa pun.
  const grey = rgbHsv(200, 0, 200);
  ok(((grey >> 16) & 0xFF) === ((grey >> 8) & 0xFF) && ((grey >> 8) & 0xFF) === (grey & 0xFF),
    `s=0 menghasilkan abu-abu (${hex(grey)})`);

  // Nilai di luar 0..255 harus dijepit, bukan wrap.
  const over = rgbHsv(200, 255, 999);
  const atMax = rgbHsv(200, 255, 255);
  ok(over === atMax, `v=999 dijepit ke v=255 (${hex(over)} vs ${hex(atMax)})`);
  const under = rgbHsv(200, 255, -50);
  const atMin = rgbHsv(200, 255, 0);
  ok(under === atMin, `v=-50 dijepit ke v=0 (${hex(under)} vs ${hex(atMin)})`);
}

console.log('\n--- I3. Bulatan benar, bukan pemotongan ---');
// Memotong (trunc) vs membulatkan (round) berbeda 1 unit pada nilai
// pecahan. Yang diuji: komponen hasil rgbHsv harus sesuai pembulatan
// yang diharapkan.
//
// CATATAN HSV: s=255 berarti SATURASI PENUH, jadi h=0/v=255 menghasilkan
// MERAH (0xFF0000), bukan putih. Putih butuh s=0. Versi pertama test ini
// salah karena mengira s=255 = putih, dan "memperbaiki" rgbHsv ke arah
// yang salah - jadi assertion-nya yang perlu dibetulkan, bukan kodenya.
{
  ok(rgbHsv(0, 255, 255) === 0xFF0000,
    `s=255 h=0 -> merah penuh (${hex(rgbHsv(0, 255, 255))})`);
  ok(rgbHsv(0, 0, 255) === 0xFFFFFF,
    `s=0 h=0 -> putih penuh (${hex(rgbHsv(0, 0, 255))})`);
  // v mengikat nilai di semua kasus - pada s=255 komponen merah = v persis.
  // Versi pertama assertion ini salah ("v tidak berpengaruh") dan hampir
  // "memperbaiki" kodenya ke arah yang keliru.
  ok(rgbHsv(0, 255, 128) === 0x800000,
    `s=255 h=0 v=128 -> merah gelap 0x800000 (${hex(rgbHsv(0, 255, 128))})`);
  // Roda HSV: enam titik utama harus menghasilkan warna primer/sekunder.
  for (const [h, name, want] of [
    [0, 'merah', 0xFF0000], [60, 'kuning', 0xFFFF00], [120, 'hijau', 0x00FF00],
    [180, 'sian', 0x00FFFF], [240, 'biru', 0x0000FF], [300, 'magenta', 0xFF00FF],
  ]) {
    ok(rgbHsv(h, 255, 255) === want,
      `roda HSV h=${h} -> ${name} ${hex(want)} (ditemukan ${hex(rgbHsv(h, 255, 255))})`);
  }
  // Titik tengah tiap sektor: komponen ketiga = 255, dua lainnya 128-ish.
  // SEMUA assertion lama di sini memakai nilai ekstrem (0 atau 255), dan di
  // nilai ekstrem pembulatan tidak terlihat sama sekali - (255.5)->255 dan
  // (0.5)->0 sama dengan pemotongan. Akibatnya mutasi "bulat jadi potong"
  // Lolos tanpa terdeteksi. Titik tengah sektor menghasilkan 127.5, dan
  // di sinilah round (128) berbeda dari trunc (127).
  ok(rgbHsv(30, 255, 255) === 0xFF8000,
    `h=30 (tengah sektor merah-kuning) tepat 0xFF8000, bukan 0xFF7F00 hasil potong (${hex(rgbHsv(30, 255, 255))})`);
  // Titik tengah sektor MENJEPIT kanal R ke pecahan 127.5, dan inilah yang
  // membedakan round dari trunc pada kanal R. h=30 saja tidak cukup:
  // di sana r = c = 255 (bulat), jadi mutasi pada baris R tidak terlihat.
  // h=90 (r = x) dan h=270 (r = x) keduanya punya R = 127.5 -> 0x80.
  // Nilai 0x80 diturunkan dari matematika, bukan disalin dari implementasi:
  // tengah sektor persis di tengah jalan 0..255, yaitu 127.5, dan pembulatan
  // terdekatnya 128.
  ok(rgbHsv(90, 255, 255) === 0x80FF00,
    `h=90 (tengah kuning-hijau) R dibulatkan ke 0x80 (${hex(rgbHsv(90, 255, 255))})`);
  ok(rgbHsv(270, 255, 255) === 0x8000FF,
    `h=270 (tengah biru-magenta) R dibulatkan ke 0x80 (${hex(rgbHsv(270, 255, 255))})`);
  ok(((rgbHsv(30, 255, 255) >> 8) & 0xFF) > 0x7F,
    `h=30 (tengah sektor merah-kuning) punya hijau naik (${hex(rgbHsv(30, 255, 255))})`);
  // v mengikat nilai: v=128 dengan s=255 harus tepat 128, bukan 127 (trunc)
  // atau 129. Ini yang membedakan round dari trunc.
  ok(rgbHsv(0, 0, 128) === 0x808080,
    `v=128 s=0 -> abu-abu tepat 0x808080 (${hex(rgbHsv(0, 0, 128))})`);
  ok(rgbHsv(0, 0, 100) === 0x646464,
    `v=100 s=0 -> tepat 0x646464 (100=0x64) (${hex(rgbHsv(0, 0, 100))})`);
  // v=0 harus hitam persis.
  ok(rgbHsv(120, 255, 0) === 0x000000,
    `v=0 -> hitam penuh tepat 0x000000 (${hex(rgbHsv(120, 255, 0))})`);
  // s=0 berarti TANPA saturasi -> putihAbu, bukan hitam. Versi pertama test
  // ini mengharapkan hitam dan hampir "memperbaiki" kodenya ke arah yang
  // salah: di HSV, s=0 menghasilkan abu (putih saat v=255).
  ok(rgbHsv(240, 0, 255) === 0xFFFFFF,
    `s=0 v=255 -> putih (${hex(rgbHsv(240, 0, 255))})`);
  ok(rgbHsv(240, 0, 128) === 0x808080,
    `s=0 v=128 -> abu-abu, sama untuk semua hue (${hex(rgbHsv(240, 0, 128))})`);
  // s negatif dijepit ke 0 -> sama dengan s=0 (abu), bukan warna apa pun.
  ok(rgbHsv(240, -10, 255) === rgbHsv(240, 0, 255),
    `s=-10 dijepit ke 0 -> sama dengan s=0 (${hex(rgbHsv(240, -10, 255))})`);
  // h negatif dijepit ke 0 -> merah. Header ini TIDAK membulatkan h negatif
  // ke 360-h (yang lebih benar secara matematis) karena h di sistem ini
  // selalu dihitung dari fmodf() yang hasilnya sudah >= 0. Yang diuji di
  // sini adalah perilaku yang benar-benar dipakai sistem.
  ok(rgbHsv(-120, 255, 255) === rgbHsv(0, 255, 255),
    `h=-120 dijepit ke 0 -> merah (${hex(rgbHsv(-120, 255, 255))})`);
}

console.log('\n--- I4. PRNG benar-benar berubah seed ---');
// xorshift yang rusak ("x = x") menghasilkan nilai BERBEDA tiap pemanggilan
// karena r1 dihitung ulang per iterasi, jadi "seed sama -> frame sama"
// masih bisa lolos. Yang diuji: rgbRand menghasilkan aliran yang varied
// dan BERBEDA antara seed.
{
  const a = rgbRand(12345);
  const b = rgbRand(12346);
  ok(a !== b, `seed berbeda -> nilai berbeda (${a} vs ${b})`);
  ok(rgbRand(999) === rgbRand(999), 'seed sama -> nilai sama (deterministik)');
  // 5 seed berbeda harus 5 nilai berbeda. Kalau rgbRand selalu mengembalikan
  // hal sama, mode 7 jadi satu warna diam dan tidak terlihat acak.
  const vals = [777, 778, 779, 780, 781].map(s => rgbRand(s));
  ok(new Set(vals).size === 5, `5 seed berbeda -> 5 nilai berbeda (ditemukan ${new Set(vals).size})`);
  // xorshift32 tidak pernah menghasilkan 0 dari seed != 0 (0 adalah fixed point).
  ok(vals.every(v => v !== 0), 'tidak menghasilkan 0 (sifat xorshift32)');
  // seed 0 disubstitusi golden ratio; kalau tidak, rgbRand(0) bisa macet.
  const zero = rgbRand(0);
  ok(zero !== 0, `seed 0 tetap menghasilkan nilai non-nol (${zero})`);
  // Mode 7 menambah seed per LED. Kalau PRNG mengabaikan seed, semua LED
  // akan sama warnanya dan mode ini tidak terlihat acak.
  const o7 = new Array(9);
  rgbFrame(7, 128, COLOR, KEYS, 0, 31337, o7);
  ok(new Set(o7).size > 1,
    `mode 7 menghasilkan lebih dari satu warna (${new Set(o7).size} dari 9)`);
}

console.log('\n--- J. Header tetap murni ---');
// Komentar HARUS dibuang dulu. Header ini menjelaskan sendiri bahwa ia tidak
// memakai millis()/strip./digitalWrite - jadi kata-kata itu muncul di TEKS
// PENJELASAN, bukan di kode. Tanpa dibuang, pengecekan "tidak memakai X"
// akan mencocokkan penjelasannya sendiri dan selalu gagal.
const code = hdr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/^\s*#\s*include\s*<Arduino\.h>/m.test(code), 'tidak meng-include Arduino.h');
ok(!/\bmillis\s*\(/.test(code), 'tidak memakai millis()');
ok(!/\bdigitalWrite\b|\bstrip\s*\./.test(code), 'tidak menyentuh hardware');
ok(!/delay\s*\(/.test(code), 'tidak memakai delay() (Phase 6 menghapus semua blocking)');
// Variabel global = deklarasi bertipe di LUAR badan fungsi. Deklarasi di
// dalam badan (float c = ..., uint8_t R = ...) adalah variabel LOKAL dan
// justru itu yang membuat fungsi ini murni - jadi tidak boleh ikut dihitung.
//
// Versi pertama memakai regex polos yang ikut mencocokkan semua variabel
// lokal, sehingga selalu melaporkan "ada variabel global" padahal tidak ada
// sama sekali. Perbaikannya: lacak kedalaman kurawal, hanya deklarasi di
// kedalaman 0 yang dihitung.
{
  const globalDecls = [];
  let depth = 0;
  for (const line of code.split('\n')) {
    if (depth === 0) {
      const m = /^(?:static\s+)?(?:bool|uint32_t|uint16_t|uint8_t|int8_t|float|int)\s+\w+\s*(?:=|;)/.exec(line);
      if (m) globalDecls.push(m[0].trim());
    }
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  }
  ok(globalDecls.length === 0,
    `tidak ada variabel global yang berubah antar panggilan${globalDecls.length ? ' (ditemukan: ' + globalDecls.join(', ') + ')' : ''}`);
}
ok(/static inline void rgbFrame\(/.test(code), 'rgbFrame() ada di header');
ok(/case 0:/.test(code) && /case 8:/.test(code), 'mode 0..8 ditangani');
// Brightness harus TIDAK dikalikan di sini (dihandle strip.setBrightness).
ok(!/\bbri\b/.test(code), 'tidak mengalikan brightness (ditangani sisi hardware)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
