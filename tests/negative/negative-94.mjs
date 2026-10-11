// Uji negatif untuk 9.4: kembalikan slider ke <span> tanpa nama, pastikan test gagal.
import fs from 'node:fs';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';
import { execFileSync } from 'node:child_process';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';

const TEST = `${SUITES_DIR}/a11y-test.js`;
const target = 'src/index.html';
const orig = fs.readFileSync(target, 'utf8');

const GOOD = '<label for="rgbBri" data-i18n="rgb.brightness">Kecerahan</label>';
const BAD = '<span data-i18n="rgb.brightness">Kecerahan</span>';
if (!orig.includes(GOOD)) { console.log('GAGAL: tidak menemukan <label for> untuk dibalik'); process.exit(2); }

fs.writeFileSync(target, orig.replace(GOOD, BAD), 'utf8');
let caught = 0;
try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('MASALAH: test TIDAK gagal -ASSERTIONS ini tidak punya gigi');
} catch {
  caught = 1;
  console.log('OK: test gagal seperti seharusnya saat label dikembalikan jadi span');
}
fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? 'OK: index.html pulih utuh' : 'MASALAH: tidak pulih');
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal setelah dipulihkan'); process.exit(2); }
process.exit(caught ? 0 : 2);
