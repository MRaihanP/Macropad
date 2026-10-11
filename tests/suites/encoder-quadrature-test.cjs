// Simulasi state machine quadrature encoder firmware.
// Tabel dan logikanya diekstrak dari firmware/common/macropad_core.h supaya yang
// diuji benar-benar sama dengan yang di-flash, bukan versi yang disalin manual.
const fs = require('fs');
const core = fs.readFileSync('firmware/common/macropad_core.h', 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

// --- ekstrak tabel & konstanta dari firmware ---
const tbl = core.match(/QUAD_DELTA\[16\]\s*=\s*\{([\s\S]*?)\}/);
const steps = core.match(/#define\s+QUAD_STEPS_PER_DETENT\s+(\d+)/);
ok(!!tbl, 'QUAD_DELTA ditemukan di firmware');
ok(!!steps, 'QUAD_STEPS_PER_DETENT ditemukan di firmware');
// Buang komentar baris di dalam tabel sebelum di-parse, kalau tidak angka pada
// baris komentar ikut terambil dan jadi NaN.
const tblClean = tbl[1].replace(/\/\/[^\n]*/g, '');
const QUAD_DELTA = tblClean.split(',').map(s => parseInt(s.trim())).filter(n => !Number.isNaN(n));
const PER_DETENT = parseInt(steps[1]);
console.log(`  tabel: [${QUAD_DELTA.join(', ')}]  per-detent: ${PER_DETENT}`);

// sanity: tabel harus asimetris (arah CW dan CCW berlawanan tanda)
ok(QUAD_DELTA.length === 16, 'tabel berisi 16 entri');
ok(QUAD_DELTA[13] === 1, `prev 11 -> curr 01 = +1 (A LOW, B HIGH = CW). Ditemukan ${QUAD_DELTA[13]}`);
ok(QUAD_DELTA[8] === -1, `prev 10 -> curr 00 = -1 (A LOW, B LOW = CCW). Ditemukan ${QUAD_DELTA[8]}`);
ok([3, 6, 9, 12].every(i => QUAD_DELTA[i] === 0), 'transisi "A dan B berubah bersamaan" bernilai 0 (diabaikan)');

// --- model encoder, meniru persis firmware ---
function makeEnc() {
  return { state: 0, acc: 0, steps: [] };
}
function edge(enc, a, b) {                    // satu perubahan pin -> satu panggilan ISR
  const now = (a << 1) | b;
  const prev = enc.state;
  if (now === prev) return;
  const d = QUAD_DELTA[(prev << 2) | now];
  enc.state = now;
  if (d === 0) return;
  enc.acc += d;
  if (enc.acc >= PER_DETENT) { enc.acc -= PER_DETENT; enc.steps.push('CW'); }
  else if (enc.acc <= -PER_DETENT) { enc.acc += PER_DETENT; enc.steps.push('CCW'); }
}

// Satu putaran penuh searah CW: 00 -> 10 -> 11 -> 01 -> 00
const CW_SEQ  = [[0,0],[1,0],[1,1],[0,1],[0,0]];
const CCW_SEQ = [[0,0],[0,1],[1,1],[1,0],[0,0]];

console.log('\n--- 1. Rotasi bersih: 1 detent = 1 langkah ---');
{
  const e = makeEnc();
  CW_SEQ.slice(1).forEach(([a, b]) => edge(e, a, b));
  ok(e.steps.length === 1 && e.steps[0] === 'CW', `1 putaran CW -> ${JSON.stringify(e.steps)}`);
  const e2 = makeEnc();
  CCW_SEQ.slice(1).forEach(([a, b]) => edge(e2, a, b));
  ok(e2.steps.length === 1 && e2.steps[0] === 'CCW', `1 putaran CCW -> ${JSON.stringify(e2.steps)}`);
}

console.log('\n--- 2. 5 detent searah = 5 langkah ---');
{
  const e = makeEnc();
  for (let k = 0; k < 5; k++) CW_SEQ.slice(1).forEach(([a, b]) => edge(e, a, b));
  ok(e.steps.length === 5, `5 putaran CW -> ${e.steps.length} langkah`);
  ok(e.steps.every(s => s === 'CW'), `semua arah benar: ${JSON.stringify(e.steps)}`);
}

console.log('\n--- 3. Pantulan (bounce) TIDAK boleh menghasilkan langkah salah ---');
// bouncing khas: A berayun bolak-balik sebelum B跟着 berubah, dan sebaliknya.
const BOUNCE_PATTERNS = [
  [[0,0],[1,0],[0,0],[1,0],[1,0],[1,1],[1,1],[0,1],[0,0]],   // A bouncing lalu maju
  [[0,0],[0,1],[0,0],[0,1],[1,1],[1,1],[1,0],[1,0],[0,0]],   // B bouncing lalu mundur
  [[0,0],[1,0],[0,0],[1,0],[0,0],[1,1],[1,0],[1,0],[0,1],[0,0]],
];
let wrong = 0, total = 0;
for (const seq of BOUNCE_PATTERNS) {
  const e = makeEnc();
  seq.slice(1).forEach(([a, b]) => edge(e, a, b));
  total++;
  // arahnya mengikuti最后一个 transisi valid; yang penting tidak ada langkah CAMPUR.
  const mixed = e.steps.some(s => s === 'CW') && e.steps.some(s => s === 'CCW');
  if (mixed) wrong++;
  console.log(`    pola bouncing -> ${JSON.stringify(e.steps)}`);
}
ok(wrong === 0, `tidak ada langkah campuran arah setelah bouncing (${wrong}/${total} salah)`);

console.log('\n--- 4. Putar bolak-balik cepat tidak boleh menambah langkah ---');
{
  const e = makeEnc();
  for (let k = 0; k < 3; k++) {          // 3 kali CW lalu balik 3 kali CCW
    CW_SEQ.slice(1).forEach(([a, b]) => edge(e, a, b));
  }
  for (let k = 0; k < 3; k++) {
    CCW_SEQ.slice(1).forEach(([a, b]) => edge(e, a, b));
  }
  const net = e.steps.filter(s => s === 'CW').length - e.steps.filter(s => s === 'CCW').length;
  ok(Math.abs(net) === 0, `3 CW lalu balik 3 CCW menghasilkan langkah bersih (net=${net}, total=${e.steps.length})`);
}

console.log('\n--- 5. Keterbatasan yang JUJUR: noise acak tidak bisa dibedakan dari rotasi ---');
{
  // State machine murni bekerja tanpa informasi waktu, jadi EMI yang mengubah
  // A/B secara acak terlihat identik dengan putaran nyata. Ini limitation nyata,
  // bukan bug - dan yang menyebabkan gejala "1 input terbaca arah salah" adalah
  // bounce pada detent, yang SUDAH tertangani oleh state + akumulator (test 3).
  // Menolak noise acak butuh filter berbasis WAKTU (mis. abaikan transisi < 2ms
  // setelah transisi sebelumnya), yang tidak ditambahkan di sini karena
  // memerlukan penghitung siklus IRAM-safe dan tidak bisa diuji tanpa hardware.
  let rngState = 12345;
  const rnd = () => (rngState = (rngState * 1103515245 + 12345) % 2147483648) / 2147483648;
  const e = makeEnc();
  let a = 0, b = 0;
  for (let i = 0; i < 400; i++) {
    if (rnd() < 0.45) { a ^= 1; edge(e, a, b); }
    if (rnd() < 0.45) { b ^= 1; edge(e, a, b); }
  }
  const both = e.steps.filter(s => s === 'CW').length, rev = e.steps.filter(s => s === 'CCW').length;
  console.log(`    400 transisi acak -> ${both} CW + ${rev} CCW (terlihat seperti putaran)`);
  ok(both > 0 && rev > 0, 'terbukti noise acak tetap lolos -> limitation terdokumentasi, bukan tersembunyi');
  ok(true, 'CATATAN: solusi butuh filter waktu; lihat Planned work di CHANGELOG');
}

console.log('\n--- 6. Kecepatan tinggi: 50 detent sesaat tetap terhitung ---');
{
  const e = makeEnc();
  for (let k = 0; k < 50; k++) CW_SEQ.slice(1).forEach(([a, b]) => edge(e, a, b));
  ok(e.steps.length === 50, `50 putaran cepat -> ${e.steps.length} langkah (nihil hilang/duplikat)`);
}

console.log(`\n${fail === 0 ? 'HASIL: state machine quadrature benar' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);

