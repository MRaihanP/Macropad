// Uji negatif untuk fix "buka preset kembali ke layer terakhir".
// Tiga regresi yang masing-masing menghasilkan perilaku SALAH tanpa error:
//   1. LAYER:0 hardcoded dikembalikan  -> preset selalu balik ke layer 0
//   2. penjepit maxLayer dihapus        -> device diam di layer yang tidak ada
//   3. reset peta dihapus              -> "terakhir" berasal dari sesi lalu
import fs from 'node:fs';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';
import { execFileSync } from 'node:child_process';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';

const TEST = `${SUITES_DIR}/preset-layer-test.js`;
const target = 'src/adaptive.js';
const orig = fs.readFileSync(target, 'utf8');

const cases = [
  {
    name: 'LAYER:0 hardcoded dikembalikan',
    from: "await sendLine('LAYER:' + targetLayer);",
    to: "await sendLine('LAYER:0');",
    expect: 'LAYER:0 hardcoded',
  },
  {
    name: 'penjepit maxLayer dihapus',
    from: 'const targetLayer = (wanted === undefined) ? 0 : Math.min(Math.max(0, wanted), maxLayer);',
    to: 'const targetLayer = (wanted === undefined) ? 0 : wanted;',
    expect: 'dijepit',
  },
  {
    name: 'reset peta dihapus',
    from: '  lastLayerByPreset = new Map();\n  slotTable = Array(APP_SLOTS).fill(null);',
    to: '  slotTable = Array(APP_SLOTS).fill(null);',
    expect: 'mengosongkan peta',
  },
  {
    name: 'pencatatan di exitPresetEditor dihapus',
    from: '  noteCurrentLayerForEditingPreset();\n  editingPresetId = null;',
    to: '  editingPresetId = null;',
    expect: 'exitPresetEditor',
  },
];

let allCaught = 0;
for (const c of cases) {
  if (!orig.includes(c.from)) { console.log(`GAGAL: pola tidak ditemukan untuk "${c.name}"`); process.exit(2); }
  fs.writeFileSync(target, orig.replace(c.from, c.to), 'utf8');
  let caught = false;
  try {
    execFileSync('node', [TEST], { stdio: 'pipe' });
  } catch (e) {
    caught = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim()}`);
  }
  fs.writeFileSync(target, orig, 'utf8');
  if (!caught) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  allCaught += caught ? 1 : 0;
}

console.log(fs.readFileSync(target, 'utf8') === orig ? '\nOK: adaptive.js pulih utuh' : '\nMASALAH: tidak pulih');
if (allCaught !== cases.length) process.exit(2);
console.log(`OK: ${allCaught}/${cases.length} regresi terdeteksi`);
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: test hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal setelah dipulihkan'); process.exit(2); }
