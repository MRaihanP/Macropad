// Uji negatif untuk import-cycle-check: sengaja buat siklus
// adaptive -> protocol-parser (adaptive sudah diimpor parser), lalu pastikan
// checker menangkapnya.
import fs from 'fs';
import { execFileSync } from 'child_process';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';

const CHECK = suite('import-cycle-check.mjs');
const target = `${REPO}/src/adaptive.js`;
const orig = fs.readFileSync(target, 'utf8');

// Sisipkan import siklus di baris import YANG ADA, bukan mencocokkan
// isi baris itu persis. Matching teks rapuh: daftar import di adaptive.js
// berubah berkali-kali (transportId, CAP_LAYERS, setter device-state),
// dan setiap perubahan seperti itu membuat uji ini gagal tanpa_reason -
// padahal tidak ada yang rusak. Yang diuji adalah kemampuan CHECKER
// menangkap siklus, bukan ejaan baris import.
const importRe = /^import \{[^}]*\} from '\.\/transport\.js';$/m;
const m = orig.match(importRe);
if (!m) { console.log('GAGAL: baris import transport.js tidak ditemukan'); process.exit(2); }
const broken = orig.replace(importRe,
  `${m[0]}\nimport { handleLine } from './protocol-parser.js';`);
if (broken === orig) { console.log('GAGAL: pola tidak ditemukan'); process.exit(2); }

fs.writeFileSync(target, broken, 'utf8');
let caught = false;
try { execFileSync('node', [CHECK], { stdio: 'pipe' }); }
catch (e) {
  caught = true;
  const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  const line = out.split('\n').find(l => l.includes('Siklus ditemukan: 1') || l.includes('->'));
  console.log('OK: siklus buatan terdeteksi ->', (line || '').trim());
}
fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? 'OK: adaptive.js pulih utuh' : 'MASALAH: tidak pulih');
try { execFileSync('node', [CHECK], { stdio: 'pipe' }); console.log('OK: bebas siklus lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih bersiklus'); process.exit(2); }
process.exit(caught ? 0 : 2);
