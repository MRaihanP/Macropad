// Uji negatif: balik sementara perbaikan 9.6, pastikan test benar-benar gagal.
// Test yang selalu hijau tidak membuktikan apa pun.
import fs from 'node:fs';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';
import { execFileSync } from 'node:child_process';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';

const TEST = `${SUITES_DIR}/record-escape-test.js`;
const target = 'src/ui-modal.js';
const orig = fs.readFileSync(target, 'utf8');

const ESC = `      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }`;
if (!orig.includes(ESC)) { console.log('GAGAL: tidak menemukan baris Escape untuk dibalik'); process.exit(2); }

// Buang preventDefault() ->batas antara "sudah ditangani" dan "belum" hilang.
fs.writeFileSync(target, orig.replace(ESC, `      if (e.key === 'Escape') { close(null); return; }`), 'utf8');
let caught = 0;
try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('MASALAH: test TIDAK gagal padahal preventDefault() dihapus - test ini toothless');
} catch {
  caught = 1;
  console.log('OK: test gagal seperti seharusnya saat preventDefault() dihapus');
}
fs.writeFileSync(target, orig, 'utf8');

// Pastikan file benar-benar pulih.
const back = fs.readFileSync(target, 'utf8');
console.log(back === orig ? 'OK: ui-modal.js pulih utuh' : 'MASALAH: ui-modal.js tidak pulih');
if (back !== orig) process.exit(2);

try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('OK: test hijau lagi setelah dipulihkan');
} catch {
  console.log('MASALAH: test masih gagal setelah dipulihkan');
  process.exit(2);
}
process.exit(caught ? 0 : 2);
