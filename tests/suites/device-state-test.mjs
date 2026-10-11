// Test untuk src/device-state.js - sekarang bisa di-import langsung sebagai modul ES,
// tidak perlu menyalin potongan kode keluar dari main.js seperti sebelumnya.
// Jalankan: node device-state-test.mjs
import {
  CAP_LAYERS, applyInfo, applyDumpRow, applyEncRow, applyName,
  applyLayerEvent, applyEncCount, applyEncIdx, reorderLayer,
  setDims, setCurrentLayer, emptyLayer, setNumEncoders,
  getDims, getLayer, getEnc, getEncList, getNames, getNumEnc, getCurrentLayer, resetForTest,
} from '../../src/device-state.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const logs = [];
const log = (m) => logs.push(m);

console.log('--- 1. applyDumpRow: hanya indeks valid yang diterima ---');
resetForTest();
const cases = [
  { a: [0, 0, 0, 1, 'x'], want: true,  why: 'baris sah' },
  { a: [0, 2, 2, 3, 'halo, dunia'], want: true, why: 'nilai ber-koma tetap utuh' },
  { a: [0, 99, 0, 1, 'x'], want: false, why: 'row di luar jangkauan' },
  { a: [0, 0, 99, 1, 'x'], want: false, why: 'col di luar jangkauan' },
  { a: [-1, 0, 0, 1, 'x'], want: false, why: 'indeks negatif' },
  { a: [99, 0, 0, 1, 'x'], want: false, why: 'layer di luar CAP_LAYERS' },
  { a: [0, 0, 0, 99, 'x'], want: false, why: 'type di luar 0..5' },
  { a: [0, NaN, 0, 1, 'x'], want: false, why: 'row NaN' },
  { a: [0, 0, 0, NaN, 'x'], want: false, why: 'type NaN' },
];
for (const c of cases) {
  const r = applyDumpRow(...c.a, log);
  ok(r === c.want, `${c.why}: [${c.a.join(',')}] -> ${r} (harap ${c.want})`);
}
ok(JSON.stringify(getLayer(0)[0][0]) === JSON.stringify({ type: 1, value: 'x' }), 'baris sah pertama tersimpan');
ok(getLayer(0)[2][2].value === 'halo, dunia', 'nilai ber-koma tidak terpotong');

console.log('\n--- 2. applyDumpRow: tidak melempar untuk input rusak ---');
const wild = [
  [0, 1e10, 0, 1, 'x'], [0, -1e10, 0, 1, 'x'], [0, 0, 0, 1.5, 'x'],
  [1e21, 0, 0, 1, 'x'], [0, 0, 0, 'abc', 'x'], [0, 0, 0, null, 'x'],
];
let threw = 0;
for (const w of wild) { try { applyDumpRow(...w, log); } catch (e) { threw++; } }
ok(threw === 0, `tidak ada yang melempar (${threw} error)`);

console.log('\n--- 3. applyEncRow: allowlist kunci menutup prototype pollution ---');
resetForTest();
setNumEncoders(2);
ok(applyEncRow(0, 'CW', 1, 'a', log), 'kunci sah CW diterima');
ok(applyEncRow(0, 'CCW', 1, 'b', log), 'kunci sah CCW diterima');
ok(applyEncRow(0, 'BTN', 1, 'c', log), 'kunci sah BTN diterima');
ok(applyEncRow(0, '__proto__', 1, 'x', log) === false, 'kunci "__proto__" ditolak');
ok(applyEncRow(0, 'constructor', 1, 'x', log) === false, 'kunci "constructor" ditolak');
ok(applyEncRow(9, 'CW', 1, 'x', log) === false, 'idx knob di luar jangkauan ditolak');
ok({}.polluted === undefined, 'Object.prototype tidak tercemar');
ok(getEnc(0).CW.value === 'a' && getEnc(1).CW === null, 'hanya knob yang dituju yang berubah');

console.log('\n--- 4. applyInfo: nilai rusak tidak merusak state ---');
resetForTest();
applyInfo({ layerCount: '5', currentLayer: '2', maxLayers: '8', rows: '4', cols: '4', encoders: '2' }, { log });
const d = getDims();
ok(d.ROWS === 4 && d.COLS === 4, `dimensi terpasang 4x4 (ditemukan ${d.ROWS}x${d.COLS})`);
ok(getCurrentLayer() === 2, 'layer terpasang');
applyInfo({ rows: 'abc', cols: 'NaN', layerCount: 'zzz' }, { log });
ok(getDims().ROWS === 4, 'ROWS tetap 4 setelah dapat "abc"');
ok(getDims().COLS === 4, 'COLS tetap 4 setelah dapat "NaN"');
ok(logs.some(l => l.includes('di luar rentang')), 'nilai buruk dilaporkan, bukan ditelan');

console.log('\n--- 5. applyInfo: perubahan dimensi mengalokasikan mapping ulang ---');
resetForTest();
applyInfo({ rows: '2', cols: '2' }, { log });
applyDumpRow(0, 1, 1, 1, 'y', log);
ok(getLayer(0)[1][1].value === 'y', 'layer 2x2 bisa diisi');
applyInfo({ rows: '3', cols: '3' }, { log });
ok(getDims().ROWS === 3 && getLayer(0).length === 3, 'mapping dialokasikan ulang untuk 3x3');

console.log('\n--- 6. applyLayerEvent & applyName ---');
resetForTest();
ok(applyLayerEvent(3), 'layer 3 diterima');
ok(getCurrentLayer() === 3, 'layer aktif = 3');
ok(applyLayerEvent(99) === false, 'layer 99 ditolak');
ok(getCurrentLayer() === 3, 'layer aktif tidak berubah setelah ditolak');
ok(applyName(2, 'Layer Dua', log), 'nama layer 2 disimpan');
ok(applyName(99, 'X', log) === false, 'nama layer 99 ditolak');
ok(getNames()[2] === 'Layer Dua', 'nama layer 2 benar');

console.log('\n--- 7. applyEncCount & applyEncIdx ---');
resetForTest();
ok(applyEncCount(2, log), 'count 2 diterima');
ok(getNumEnc() === 2, 'jumlah knob = 2');
ok(applyEncIdx(1), 'IDX 1 diterima');
ok(applyEncIdx(9) === false, 'IDX 9 ditolak');
applyEncCount(99, log);
ok(getEncList()[0] !== undefined && getNumEnc() === 2, 'count 99 ditolak tanpa merusak state');

console.log('\n--- 8. reorderLayer tidak boleh merusak susunan ---');
resetForTest();
applyInfo({ layerCount: '4' }, { log });
applyName(0, 'L0', log); applyName(1, 'L1', log); applyName(2, 'L2', log);
applyDumpRow(0, 0, 0, 1, 'a', log);
applyDumpRow(1, 0, 0, 1, 'b', log);
applyDumpRow(2, 0, 0, 1, 'c', log);
ok(reorderLayer(0, 2), 'pindah layer 0 -> 2 berhasil');
ok(getNames()[2] === 'L0' && getNames()[0] === 'L1' && getNames()[1] === 'L2', 'nama layer terurut: ' + getNames().slice(0,3).join(','));
ok(getLayer(2)[0][0].value === 'a' && getLayer(0)[0][0].value === 'b' && getLayer(1)[0][0].value === 'c',
   'keymap ikut terbawa bersama namanya (tidak terpisah)');
ok(reorderLayer(0, 99) === false, 'pindah ke luar jangkauan ditolak');
ok(getNames()[0] === 'L1', 'susunan tidak berubah setelah permintaan ditolak');

console.log('\n--- 9. emptyLayer mengikuti dimensi saat ini ---');
resetForTest();
applyInfo({ rows: '5', cols: '2' }, { log });
const el5 = emptyLayer();
ok(el5.length === 5 && el5[0].length === 2, `emptyLayer 5x2 (ditemukan ${el5.length}x${el5[0].length})`);

console.log(`\n${fail === 0 ? 'HASIL: semua lolos' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);


