// Menguji "reconnect selalu mulai dari layer 0".
//
// Bug: firmware menyimpan currentLayer di struct cfg yang sama dengan isi
// flash. SAVE di layer 4 -> device boot di layer 4 -> INFO: melaporkan
// currentLayer=4 -> app menerimanya apa adanya -> user terjebak di layer 4
// setiap kali reconnect, bukan layer 0.
const fs = require('fs');
const path = require('path');

const serial = fs.readFileSync(path.join(process.cwd(), 'src/serial-transport.js'), 'utf8');
const parser = fs.readFileSync(path.join(process.cwd(), 'src/protocol-parser.js'), 'utf8');
const core = fs.readFileSync(path.join(process.cwd(), 'firmware/common/macropad_core.h'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Urutan perintah di connect() ---');
const conn = serial.match(/export async function connect\(pathArg\) \{([\s\S]*?)\n\}/);
ok(!!conn, 'connect() ditemukan');
const body = conn ? conn[1] : '';
// Urutan WAJIB: LAYER:0 sebelum INFO. Kalau INFO dulu, app memuat layer 4 ke
// grid lalu berganti ke layer 0 - user melihat isi yang salah berkedip.
const iLayer = body.indexOf("sendLine('LAYER:0')");
const iInfo = body.indexOf("sendLine('INFO')");
ok(iLayer >= 0, "connect() mengirim LAYER:0");
ok(iInfo >= 0, "connect() mengirim INFO");
ok(iLayer >= 0 && iInfo >= 0 && iLayer < iInfo,
  'LAYER:0 dikirim SEBELUM INFO (tidak ada kedipan layer yang salah)');
// Layer 0 harus dikirim di connect(), bukan di tempat lain yang mungkin tidak
// terpakai (mis. hanya di auto-connect).
ok(body.includes("sendLine('LAYER:0')"), 'perintah ada tepat di dalam connect()');

console.log('\n--- B. Kenapa LAYER:0 pasti aman tanpa tahu jumlah layer ---');
ok(/if \(cfg\.layerCount < 1\) cfg\.layerCount = 1;/.test(core),
  'firmware menjamin layerCount >= 1, jadi layer 0 selalu valid');
ok(/cmd\.startsWith\("LAYER:"\)/.test(core), 'firmware menangani perintah LAYER:');
ok(/parseIntRange\(cmd\.substring\(6\), 0, activeCfg->layerCount - 1/.test(core),
  'LAYER: divalidasi terhadap rentang layer di firmware');

console.log('\n--- C. Akar masalah di firmware terdokumentasi & tidak diubah ---');
// currentLayer ikut tersimpan karena ada di struct cfg yang sama dengan flash.
ok(/if \(cmd == "SAVE"\) \{ saveConfigToFlash\(\); return; \}/.test(core),
  'firmware SAVE menuliskan seluruh struct cfg (berisi currentLayer) ke flash');
// Kita TIDAK mengubah firmware: pixel/byte yang sama, hanya app yang meminta
// layer 0 saat connect. Test ini mengunci keputusan itu.
ok(!/LAYER:0/.test(core.replace(/\/\/.*$/gm, '')),
  'firmware TIDAK dipaksa ke layer 0 saat boot (keputusan:handled di sisi app)');

console.log('\n--- D. Jalur pemuatan layer di app ---');
// INFO: memuat layer yang dilaporkan. Karena device sudah di LAYER:0 sebelum
// INFO, currentLayer yang dilaporkan = 0.
ok(/hooks\.renderTabs\(\); hooks\.loadLayer\(currentLayer\);/.test(parser),
  'INFO: memuat layer yang device lapor (jadi 0, karena LAYER:0 dikirim dulu)');
ok(/applyInfo\(kv, \{ log \}\)/.test(parser), 'INFO: tetap divalidasi lewat applyInfo()');
ok(/if \(kv\.currentLayer !== undefined\) setCurrentLayer\(num\(kv\.currentLayer, 0, layerCount - 1, currentLayer\)\)/.test(
  fs.readFileSync(path.join(process.cwd(), 'src/device-state.js'), 'utf8')),
  'currentLayer dari INFO tetap dijaga rentangnya (tidak dipercaya buta)');

console.log('\n--- E. Tidak merusak fix layer-terakhir per preset ---');
// openPresetEditor mengirim LAYER:<target> sendiri; itu terpisah dari connect()
// dan harus tetap utuh.
const adaptive = fs.readFileSync(path.join(process.cwd(), 'src/adaptive.js'), 'utf8');
ok(/await sendLine\('LAYER:' \+ targetLayer\)/.test(adaptive),
  'openPresetEditor tetap mengirim LAYER:targetLayer (fix sebelumnya tidak rusak)');
ok(!/sendLine\('LAYER:0'\)/.test(adaptive.match(/export async function openPresetEditor[\s\S]*?\n\}/)[0]),
  'openPresetEditor tidak dipaksa LAYER:0 - menghormati "layer terakhir"');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
