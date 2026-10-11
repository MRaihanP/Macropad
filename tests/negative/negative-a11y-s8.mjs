// Negative test untuk section 8 a11y-test.js.
//
// Section 8 ini assertion-nya saya tulis sendiri, jadi belum terbukti apa pun.
// Aturan proyek: "Test yang tidak pernah gagal tidak membuktikan apa pun."
//
// Dua tahap:
//   TAHAP 1 - proving: setiap properti yang diuji dicabut dari aturan DASAR
//             .nav-item, test harus jadi merah.
//   TAHAP 2 - kontrol: mutasi yang TIDAK boleh berpengaruh (menambah properti
//             di .nav-item:hover) harus tetap hijau. Tanpa kontrol, test bisa
//             hijau karena alasan yang salah.
import fs from 'node:fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'node:child_process';

const CSS = `${REPO}/src/styles.css`;
const TEST = suite('a11y-test.js');

const asli = fs.readFileSync(CSS, 'utf8');
const jalankan = () => {
  try {
    const out = execFileSync('node', [TEST], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') };
  }
};

let gagal = 0;
const cek = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) gagal++; };

// Cari isi blok aturan DASAR .nav-item (selector persis ".nav-item", tanpa
// :hover / :active / .nav-icon). Return null kalau tidak ada.
const blokDasar = (src) => {
  const m = src.match(/(^|[},;\s])\.nav-item\s*\{([^}]*)\}/);
  return m ? m[2] : null;
};
const cabutDiDasar = (src, prop) =>
  src.replace(/(^|[},;\s])(\.nav-item\s*\{)([^}]*)\}/, (all, pre, sel, body) => {
    const baru = body.replace(new RegExp(`\\b${prop}\\s*:\\s*[^;}]+;?`), '');
    return `${pre}${sel}${baru}}`;
  });

// --- baseline ---
const base = jalankan();
cek(base.code === 0, `baseline hijau (exit=${base.code})`);
if (base.code !== 0) { console.log(base.out); process.exit(1); }
cek(blokDasar(asli) !== null, 'blok .nav-item dasar ditemukan di styles.css');

// --- TAHAP 1 ---
console.log('\n--- TAHAP 1: cabut properti dari aturan dasar -> test harus GAGAL ---');
const mutations = [
  ['background', 'background: none dicabut dari .nav-item'],
  ['border', 'border: 0 dicabut dari .nav-item'],
  ['font-family', 'font-family: inherit dicabut dari .nav-item'],
  ['text-align', 'text-align: left dicabut dari .nav-item'],
];
for (const [prop, ket] of mutations) {
  const dimodifikasi = cabutDiDasar(asli, prop);
  cek(dimodifikasi !== asli, `mutasi diterapkan: ${ket}`);
  // pastikan properti benar-benar hilang dari blok DASAR (bukan dari :hover)
  cek(!new RegExp(`\\b${prop}\\s*:`).test(blokDasar(dimodifikasi) || ''),
    `  -> "${prop}" benar hilang dari blok .nav-item dasar`);
  fs.writeFileSync(CSS, dimodifikasi, 'utf8');
  const r = jalankan();
  cek(r.code !== 0, `  -> test MERAH (exit=${r.code})`);
  cek(/FAIL/.test(r.out), '  -> output memuat assertion FAIL');
  cek(/nav-item/.test(r.out), '  -> pesan gagal menyebut .nav-item');
}

// --- TAHAP 2: kontrol ---
console.log('\n--- TAHAP 2: kontrol -> test harus tetap HIJAU ---');
{
  const denganHover = asli.replace('.nav-item:hover { background: var(--panel-hi); }',
    '.nav-item:hover { background: var(--panel-hi); border: 3px solid red; }');
  cek(denganHover !== asli, 'kontrol: properti ditambah ke .nav-item:hover');
  cek(blokDasar(denganHover) === blokDasar(asli), 'kontrol: blok .nav-item dasar tidak tersentuh');
  fs.writeFileSync(CSS, denganHover, 'utf8');
  cek(jalankan().code === 0, 'kontrol: test tetap hijau (aturan :hover tidak ikut dihitung)');
}

// --- pulihkan ---
fs.writeFileSync(CSS, asli, 'utf8');
cek(fs.readFileSync(CSS, 'utf8') === asli, 'styles.css pulih byte-per-byte');
cek(jalankan().code === 0, 'test hijau lagi setelah dipulihkan');

console.log(`\nHASIL: ${gagal} gagal`);
process.exit(gagal ? 1 : 0);
