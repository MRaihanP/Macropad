// Uji negatif untuk fix "reconnect selalu mulai dari layer 0".
import fs from 'node:fs';
import { REPO, SUITES_DIR, suite, mutate } from '../runner/paths.mjs';
import { execFileSync } from 'node:child_process';

const TEST = suite('reconnect-layer0-test.js');
const target = `${REPO}/src/serial-transport.js`;
const orig = fs.readFileSync(target, 'utf8');

const cases = [
  {
    name: 'LAYER:0 dihapus total (balik ke perilaku lama)',
    from: "    await sendLine('LAYER:0');\n    await sendLine('INFO');",
    to: "    await sendLine('INFO');",
  },
  {
    name: 'urutan dibalik: INFO dulu, baru LAYER:0',
    from: "    await sendLine('LAYER:0');\n    await sendLine('INFO');",
    to: "    await sendLine('INFO');\n    await sendLine('LAYER:0');",
  },
];

let caught = 0;
for (const c of cases) {
  // mutate() menormalkan line ending, jadi pola dengan \n tetap ketemu
  // walau file di disk memakai CRLF (hasil checkout di Windows).
  if (!mutate(target, c.from, c.to)) { console.log(`GAGAL: pola tidak ditemukan untuk "${c.name}"`); process.exit(2); }
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
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
