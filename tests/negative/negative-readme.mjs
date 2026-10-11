// Uji negatif: buat README lipstick (pakai satu perintah yang tidak ada di
// firmware), pastikan test menangkapnya.
import fs from 'fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const TEST = suite('readme-protocol-test.js');
const target = 'README.md';
const orig = fs.readFileSync(target, 'utf8');

const cases = [
  {
    name: 'README ulang kembali ke template Tauri',
    from: '# Macro Pad Configurator',
    to: '# Tauri + Vanilla\n\nThis template should help you get started developing with Tauri.',
  },
  {
    name: 'README mendokumentasikan perintah fiktif (BLE:SCAN)',
    from: '| `PING` | - | `PONG` |',
    to: '| `PING` | - | `PONG` |\n| `BLE:SCAN` | - | `[OK] BLE on` |',
  },
  {
    name: 'README mengklaim angka [KEY] salah (50 byte)',
    from: '**`[KEY]` maksimal 62 byte.**',
    to: '**`[KEY]` maksimal 50 byte.**',
  },
  {
    name: 'README mengklaim RGB slots salah (16)',
    from: '| RGB slots | 9 |',
    to: '| RGB slots | 16 |',
  },
];

let caught = 0;
for (const c of cases) {
  if (!orig.includes(c.from)) { console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`); process.exit(2); }
  fs.writeFileSync(target, orig.replace(c.from, c.to), 'utf8');
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

console.log(fs.readFileSync(target, 'utf8') === orig ? '\nOK: README pulih utuh' : '\nMASALAH: tidak pulih');
if (caught !== cases.length) process.exit(2);
console.log(`OK: ${caught}/${cases.length} kebohongan terdeteksi`);
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
