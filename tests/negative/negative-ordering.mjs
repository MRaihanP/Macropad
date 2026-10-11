// Uji negatif: kembalikan URUTAN di DUMP_END (terapkan layer tertunda SEBELUM
// resolve waiter) - ini bug yang ditemukan test perilaku, dan harus tetap
// terdeteksi.
import fs from 'fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const TEST = suite('layer-hold-behaviour-test.js');
const target = 'src/protocol-parser.js';
const orig = fs.readFileSync(target, 'utf8');

const resolveLine = '    resolveDumpWaiters(done);\n';
const applyBlock = `
    if (hasPendingLayerAfterDump()) {
      const pending = takePendingLayerAfterDump();
      if (pending !== currentLayer && applyLayerEvent(pending)) {
        hooks.renderTabs();
        hooks.loadLayer(pending);
      }
    }
`;

// Versi salah: apply duluan, baru resolve.
const broken = orig.replace(resolveLine, applyBlock + resolveLine + '    return;\n');
if (broken === orig) { console.log('GAGAL: pola tidak ditemukan'); process.exit(2); }

fs.writeFileSync(target, broken, 'utf8');
let caught = false;
try { execFileSync('node', [TEST], { stdio: 'pipe' }); }
catch (e) {
  caught = true;
  const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  const line = out.split('\n').find(l => l.includes('FAIL'));
  console.log('OK: urutan salah terdeteksi ->', (line || '').replace(/\u001b\[[0-9;]*m/g, '').trim());
}
fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? 'OK: protocol-parser.js pulih utuh' : 'MASALAH: tidak pulih');
if (!caught) process.exit(2);
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
