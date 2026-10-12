// Uji negatif untuk jeda auto-switch / tundaan dump (step 4).
import fs from 'fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const TEST = suite('layer-hold-test.js');
const adaptive = 'src/adaptive.js';
const parser = 'src/protocol-parser.js';
const origA = fs.readFileSync(adaptive, 'utf8');
const origP = fs.readFileSync(parser, 'utf8');

// Kasus "urutan apply vs resolve" ada di negative-ordering.mjs.
const cases = [
  {
    name: 'helper tidak dipakai lagi (kembali ke write-only)',
    file: adaptive,
    from: '    if (autoSwitchBlockedByLayerChoice()) return;',
    to: '',
  },
  {
    name: 'jeda dibuang total - preset langsung menimpa pilihan user',
    file: adaptive,
    from: 'if (Date.now() - lastDeviceLayerEventAt < LAYER_CHOICE_HOLD_MS) return true;',
    to: 'if (false) return true;',
  },
  {
    name: 'nilai 0 ikut memblokir - auto-switch mati selamanya',
    file: adaptive,
    from: 'if (lastDeviceLayerEventAt === 0) return false;',
    to: '',
  },
  {
    name: 'blokir saat dump dihapus - dump & auto-switch saling menimpa',
    file: adaptive,
    from: 'return dumpInProgress();',
    to: 'return false;',
  },
  {
    name: 'EVT:LAYER: langsung diterapkan walau dump berjalan (waiter salah)',
    file: parser,
    from: '      pendingLayerAfterDump = n;',
    to: '      applyLayerEvent(n);',
  },
  {
    name: 'adaptive mengimpor parser lagi (siklus import)',
    file: adaptive,
    from: "import { t } from './i18n.js';",
    to: "import { t } from './i18n.js';\nimport { getLastDeviceLayerEventAt } from './protocol-parser.js';",
  },
];

let caught = 0;
for (const c of cases) {
  const path = c.file;
  const orig = path === adaptive ? origA : origP;
  if (!orig.includes(c.from)) { console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`); process.exit(2); }
  fs.writeFileSync(path, orig.replace(c.from, c.to), 'utf8');
  let hit = false;
  try { execFileSync('node', [TEST], { stdio: 'pipe' }); }
  catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim()}`);
  }
  fs.writeFileSync(path, orig, 'utf8');
  if (!hit) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  caught += hit ? 1 : 0;
}

fs.writeFileSync(adaptive, origA, 'utf8');
fs.writeFileSync(parser, origP, 'utf8');
console.log(fs.readFileSync(adaptive, 'utf8') === origA && fs.readFileSync(parser, 'utf8') === origP
  ? '\nOK: kedua berkas pulih utuh' : '\nMASALAH: tidak pulih');
if (caught !== cases.length) process.exit(2);
console.log(`OK: ${caught}/${cases.length} regresi terdeteksi`);
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
