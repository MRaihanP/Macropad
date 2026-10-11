// Uji negatif untuk konsistensi versi: ubah package.json ke versi yang
// berbeda dari Cargo.toml, pastikan test menangkapnya.
import fs from 'fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const TEST = suite('version-test.js');
const target = `${REPO}/package.json`;
const orig = fs.readFileSync(target, 'utf8');

// JANGAN hardcode nomor versi di sini. Versi pernah 0.2.0 lalu 0.5.0; skrip
// ini lama-lama diam-diam tidak mengubah apa pun karena pola yang dicari
// sudah tidak ada - lalu tetap mencetak "OK" padahal tidak ada yang diuji.
//
// Yang diuji adalah sifatnya: buat package.json BERBEDA dari Cargo.toml.
const pkg = JSON.parse(orig);
pkg.version = '0.0.1-j deliberate';
fs.writeFileSync(target, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
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
