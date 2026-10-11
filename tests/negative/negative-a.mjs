// Uji negatif untuk Phase 10.4A: pindahkan panel manual ke DALAM <div id="app">
// dan pastikan test mendeteksinya. Kalau test ini tetap hijau, ia tidak
// berguna sebagai jaring pengaman.
import fs from 'node:fs';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';
import { execFileSync } from 'node:child_process';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';

const TEST = `${SUITES_DIR}/manual-connect-test.js`;
const target = 'src/index.html';
const orig = fs.readFileSync(target, 'utf8');

const panelStart = orig.indexOf('<!-- ============ KONEKSI MANUAL');
const panelEnd = orig.indexOf('</details>') + '</details>'.length;
if (panelStart < 0 || panelEnd < panelStart) { console.log('GAGAL: panel tidak ditemukan'); process.exit(2); }

const panel = orig.slice(panelStart, panelEnd);
const rest = orig.slice(0, panelStart) + orig.slice(panelEnd);

// Sisipkan panel tepat setelah <div id="app" ...> -> kini DI DALAM #app.
const appAt = rest.indexOf('<div id="app"');
if (appAt < 0) { console.log('GAGAL: #app tidak ditemukan'); process.exit(2); }
const lineEnd = rest.indexOf('>', appAt) + 1;
const broken = rest.slice(0, lineEnd) + '\n' + panel + '\n' + rest.slice(lineEnd);

fs.writeFileSync(target, broken, 'utf8');
let caught = 0;
try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('MASALAH: test TIDAK gagal - posisi panel tidak diawasi sama sekali');
} catch (e) {
  caught = 1;
  const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  const line = out.split('\n').find(l => l.includes('SEBELUM'));
  console.log('OK: test gagal seperti seharusnya ->', (line || '').trim());
}
fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? 'OK: index.html pulih utuh' : 'MASALAH: tidak pulih');
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal setelah dipulihkan'); process.exit(2); }
process.exit(caught ? 0 : 2);
