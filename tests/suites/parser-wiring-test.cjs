// Setelah refactor Phase 8, validasi baris DUMP tidak lagi inline di main.js tapi
// berada di device-state.js (applyDumpRow). Test ini memeriksa WIRING-nya: parser
// di main.js harus meneruskan ke mutator tervalidasi dan TIDAK boleh ada lagi
// penulisan langsung ke mapping dari output device - itulah yang dulu melempar
// TypeError di dalam callback serial dan mematikan parser.
const fs = require('fs');
const app = fs.readFileSync('src/main.js', 'utf8');
// handleLine pindah ke src/protocol-parser.js (Phase 8 tahap 5), jadi baris device
// dari device dibaca dari sana.
const parser = fs.readFileSync('src/protocol-parser.js', 'utf8');
const ds = fs.readFileSync('src/device-state.js', 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- 1. main.js meneruskan baris DUMP ke applyDumpRow ---');
const dumpBranch = parser.slice(
  parser.indexOf('if (dumpInProgress) {'),
  parser.indexOf("if (line.startsWith('ENC_BEGIN'))")
);
ok(dumpBranch.length > 0, 'blok parser DUMP ditemukan');
ok(/applyDumpRow\(/.test(dumpBranch), 'memakai applyDumpRow()');
ok(/Number\.isInteger\((r|c)\)/.test(dumpBranch) === false, 'validasi indeks tidak lagi diulang inline di main.js');
ok(/mapping\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\s*=\s*\{/.test(dumpBranch) === false,
   'TIDAK ada lagi penulisan langsung mapping[r][c] = {...} dari output device');
ok(/log\(t\('parser\.dumpInvalid', \{ line \}\), 'err'\)/.test(dumpBranch), 'baris buruk tetap dicatat lewat kunci i18n');

console.log('\n--- 2. main.js meneruskan DUMPENC ke applyEncRow (allowlist) ---');
const encBranch = parser.slice(
  parser.indexOf("if (line.startsWith('ENC_BEGIN'))"),
  parser.indexOf("if (line.startsWith('HWINFO:'))")
);
ok(/applyEncCount\(/.test(encBranch), 'ENC_BEGIN memakai applyEncCount()');
ok(/applyEncIdx\(/.test(encBranch), 'IDX: memakai applyEncIdx()');
ok(/applyEncRow\(/.test(encBranch), 'baris knob memakai applyEncRow()');
ok(/ENC_KEYS\s*=\s*\[/.test(encBranch) === false, 'allowlist ENC_KEYS dipindah ke device-state, tidak diduplikasi');
ok(/encConfig\[encParseIdx\]\[/.test(encBranch) === false, 'TIDAK ada lagi penulisan langsung ke encConfig dari device');

console.log('\n--- 3. DUMPNAMES & EVT:LAYER lewat mutator ---');
ok(/applyName\(/.test(parser), 'DUMPNAMES memakai applyName()');
ok(/applyLayerEvent\(/.test(parser), 'EVT:LAYER memakai applyLayerEvent()');

console.log('\n--- 4. INFO lewat applyInfo ---');
const infoBranch = parser.slice(parser.indexOf("if (line.startsWith('INFO:'))"), parser.indexOf("if (line.startsWith('WHOAMI:'))"));
ok(/applyInfo\(/.test(infoBranch), 'INFO memakai applyInfo()');
ok(/const num = \(v, lo, hi, cur\)/.test(infoBranch) === false, 'helper num() lokal dihapus, sekarang milik device-state');
ok(/layerCount = num\(/.test(infoBranch) === false, 'TIDAK ada lagi penulisan langsung ke state dari INFO');

console.log('\n--- 5. Allowlist & validasi benar-benar ada di device-state ---');
ok(/const ENC_KEYS = \['CW', 'CCW', 'BTN'\]/.test(ds), 'allowlist kunci knob ada di device-state');
ok(/const isInt = \(v\) => Number\.isInteger\(v\)/.test(ds), 'helper isInt() ada');
ok(/row < ROWS && col < COLS/.test(ds.replace(/\n\s*/g, ' ')) || /row >= ROWS/.test(ds), 'batas ROWS/COLS diperiksa');
ok(/type > 5/.test(ds), 'rentang tipe 0..5 diperiksa');

console.log('\n--- 6. Tidak ada penulisan state langsung di main.js maupun protocol-parser.js ---');
// handleLine sudah pindah ke protocol-parser.js, jadi output serial bisa masuk dari
// dua berkas. Keduanya harus diperiksa, kalau tidak pemindahan kode bisa membuka
// jalur tulis-langsung yang lolos dari pemeriksaan.
const directWrites = [];
const WRITE_RE = /(^|[^\.\w])(ROWS|COLS|NUM_ENCODERS|currentLayer|layerCount|maxLayers|encConfig|encParseIdx)\s*=[^=>]/gm;
for (const [name, src] of [['protocol-parser.js', parser], ['main.js', app]]) {
  for (const m of src.matchAll(WRITE_RE)) {
    const lineNo = src.slice(0, m.index).split('\n').length;
    const text = src.split('\n')[lineNo - 1].trim();
    if (!text.startsWith('//')) directWrites.push(name + ' L' + lineNo + ': ' + text.substring(0, 80));
  }
}
ok(directWrites.length === 0, directWrites.length ? 'masih ada:\n      ' + directWrites.join('\n      ') : 'semua lewat setter');

console.log(`\n${fail === 0 ? 'HASIL: wiring parser -> device-state benar' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);