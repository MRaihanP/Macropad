// Uji negatif untuk fix retry/reconnect.
import fs from 'fs';
import { REPO, SUITES_DIR, suite, mutate } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const TEST = suite('retry-test.js');
const target = `${REPO}/src/serial-transport.js`;
const orig = fs.readFileSync(target, 'utf8');

const cases = [
  {
    name: 'kembalikan batas retry ke 2x (bug asli)',
    from: 'const RETRY_MAX_ATTEMPTS = 6;',
    to: 'const RETRY_MAX_ATTEMPTS = 2;',
  },
  {
    name: 'hapus re-probe port gagal (pollPorts early-return lagi)',
    from: 'if (!added.length && !removed && !retryable.length) return;',
    to: 'if (!added.length && !removed) return;',
  },
  {
    name: 'hapus retryable dari target probe',
    from: 'const targets = added.length ? added : retryable;',
    to: 'const targets = added;',
  },
  {
    name: 'jangan tandai port yang gagal (basi = tak ter-probe lagi)',
    from: 'for (const t of targets) failedProbes.add(t);',
    to: '',
  },
  {
    name: 'jangan bersihkan failedProbes saat connect (port hantu di-probe selamanya)',
    from: '  failedProbes.delete(path);\n  clearTimeout(retryTimer);',
    to: '  clearTimeout(retryTimer);',
  },
  {
    name: 'kembalikan jeda tetap (attempt * 3000), buang backoff',
    from: '}, retryDelay(attempt));',
    to: '}, attempt * 3000);',
  },
];

let caught = 0;
for (const c of cases) {
  if (!mutate(target, c.from, c.to)) { console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`); process.exit(2); }
  let hit = false;
  try { execFileSync('node', [TEST], { stdio: 'pipe' }); }
  catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim()}`);
  }
  fs.writeFileSync(target, orig, 'utf8');
  if (!hit) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  caught += hit ? 1 : 0;
}

console.log(fs.readFileSync(target, 'utf8') === orig ? '\nOK: serial-transport.js pulih utuh' : '\nMASALAH: tidak pulih');
if (caught !== cases.length) process.exit(2);
console.log(`OK: ${caught}/${cases.length} regresi terdeteksi`);
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
