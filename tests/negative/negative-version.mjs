// Uji negatif untuk konsistensi versi: kembalikan package.json ke 0.1.0,
// pastikan test menangkapnya.
import fs from 'fs';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';

const TEST = `${SUITES_DIR}/version-test.js`;
const target = 'package.json';
const orig = fs.readFileSync(target, 'utf8');

fs.writeFileSync(target, orig.replace('"version": "0.2.0"', '"version": "0.1.0"'), 'utf8');
let caught = false;
try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('MASALAH: test TIDAK gagal - versi tidak diawasi');
} catch (e) {
  caught = true;
  const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  const line = out.split('\n').find(l => l.includes('FAIL'));
  console.log('OK: test gagal seperti seharusnya ->', (line || '').replace(/\u001b\[[0-9;]*m/g, '').trim());
}
fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? 'OK: package.json pulih utuh' : 'MASALAH: tidak pulih');
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
process.exit(caught ? 0 : 2);
