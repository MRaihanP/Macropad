// Uji negatif: kembalikan #rgbSaveState ke span biasa tanpa live region.
import fs from 'fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const T1 = suite('rgb-savestate-a11y-test.js');
const T2 = suite('a11y-test.js');
const target = 'src/index.html';
const orig = fs.readFileSync(target, 'utf8');

const from = 'id="rgbSaveState" role="status" aria-live="polite"';
const to = 'id="rgbSaveState"';
if (!orig.includes(from)) { console.log('GAGAL: pola tidak ditemukan'); process.exit(2); }

fs.writeFileSync(target, orig.replace(from, to), 'utf8');
let caught = 0;
for (const [name, T] of [['rgb-savestate-a11y-test.js', T1], ['a11y-test.js', T2]]) {
  let hit = false;
  try { execFileSync('node', [T], { stdio: 'pipe' }); }
  catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL'));
    console.log(`OK  terdeteksi oleh ${name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim()}`);
  }
  if (!hit) console.log(`MASALAH: ${name} TIDAK mendeteksi`);
  caught += hit ? 1 : 0;
}
fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? 'OK: index.html pulih utuh' : 'MASALAH: tidak pulih');
if (caught !== 2) process.exit(2);
for (const T of [T1, T2]) {
  try { execFileSync('node', [T], { stdio: 'pipe' }); } catch { console.log('MASALAH: masih gagal'); process.exit(2); }
}
console.log('OK: kedua test hijau lagi setelah dipulihkan');
