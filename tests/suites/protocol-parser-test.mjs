// Menguji src/protocol-parser.js - handleLine() menerima satu baris dari device.
//
// Ini kontrak paling kritis di app: kalau salah baca, config di device tidak sinkron
// dengan yang tampil. Dan yang lebih buruk, salah indeks bisa melempar TypeError DI
// DALAM callback serial yang ditangkap plugin lalu ditelan - parser mati di tengah
// stream dan semua baris berikutnya dimakan sebagai payload DUMP.
//
// Format di test ini disalin PERSIS dari firmware (firmware/common/macropad_core.h):
//   INFO:layerCount=N,currentLayer=N,maxLayers=N,rows=N,cols=N,encoders=N,context=S
//   DUMP_BEGIN:<layer> ... <row>,<col>,<type>,<value> ... DUMP_END
//   ENC_BEGIN:count=N, IDX:<i>, CW|CCW|BTN,<type>,<value>, ENC_END
//   NAMES_BEGIN, <idx>,<nama>, NAMES_END
//   HWINFO:profile=S,encoders=N,...,simulated=N
//
// Jalankan: node protocol-parser-test.mjs
import { registerHooks } from 'node:module';
import { SRC_URL as SRC, STUB_DIR } from '../runner/paths.mjs';
import { pathToFileURL } from 'node:url';

const STUBS = pathToFileURL(`${STUB_DIR}/tauri-stubs.mjs`).href;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (ditemukan ${JSON.stringify(a)}, diharapkan ${JSON.stringify(b)})`);

// ---- Stub DOM ----
const mkEl = (id) => ({
  id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
  title: '', style: {}, dataset: {}, className: '',
  classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
  appendChild() { }, remove() { }, querySelector() { return mkEl('s'); }, querySelectorAll() { return []; },
  addEventListener() { }, setAttribute() { }, removeAttribute() { }, getAttribute() { return null; },
  focus() { }, blur() { }, click() { }, scrollIntoView() { },
});
const ELS = {};
globalThis.document = {
  getElementById: (id) => (ELS[id] || (ELS[id] = mkEl(id))),
  createElement: (t) => mkEl(t),
  querySelectorAll: () => [], querySelector: () => mkEl('q'),
  addEventListener() { }, removeEventListener() { }, body: mkEl('body'),
};
globalThis.window = { addEventListener() { }, removeEventListener() { } };
globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } };
globalThis.confirm = () => true;

globalThis.__TauriStub = { invokeCalls: [], availablePorts: ['COM3'], invoked: {}, serialConstructed: 0 };
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'tauri-plugin-serialplugin') return { url: STUBS, shortCircuit: true };
    if (spec.startsWith('@tauri-apps/')) return { url: STUBS, shortCircuit: true };
    return next(spec, ctx);
  },
});

const P = await import(`${SRC}/protocol-parser.js`);
const DS = await import(`${SRC}/device-state.js`);
const T = await import(`${SRC}/serial-transport.js`);

const calls = { notify: [], notifyBoundAction: [], renderTabs: 0, renderGrid: 0, renderEncoderList: 0, loadLayer: [], badge: 0 };
P.initProtocolParser({
  notify: (t, k) => calls.notify.push([k, t]),
  notifyBoundAction: (ty, v) => calls.notifyBoundAction.push([ty, v]),
  renderDeviceProfileBadge: () => { calls.badge++; },
  renderTabs: () => { calls.renderTabs++; },
  renderGrid: () => { calls.renderGrid++; },
  renderEncoderList: () => { calls.renderEncoderList++; },
  loadLayer: (n) => { calls.loadLayer.push(n); },
});

const feed = (...lines) => { for (const l of lines) P.handleLine(l); };

// Reset TOTAL: state device, state framing, rekaman hook, dan elemen DOM.
// Mengosongkan DOM penting - kalau tidak, teks dari test sebelumnya ikut terbawa
// dan assertion menyesatkan.
const reset = () => {
  DS.resetForTest();
  T.resetParserState();
  P.resetDeviceProfile();
  for (const k of Object.keys(ELS)) delete ELS[k];
  calls.notify.length = 0; calls.notifyBoundAction.length = 0; calls.loadLayer.length = 0;
  calls.renderTabs = 0; calls.renderGrid = 0; calls.renderEncoderList = 0; calls.badge = 0;
};
const INFO_3x3 = 'INFO:layerCount=6,currentLayer=0,maxLayers=8,rows=3,cols=3,encoders=1,context=DEFAULT';

reset();

console.log('--- 1. Baris kosong / whitespace diabaikan tanpa efek ---');
feed('', '   ', '\t');
eq(calls.notify.length, 0, 'tidak ada notifikasi dari baris kosong');
eq(calls.renderGrid, 0, 'tidak ada render dari baris kosong');

console.log('\n--- 2. INFO: membaca dimensi, layer, knob lalu memicu render ---');
reset();
feed('INFO:layerCount=6,currentLayer=1,maxLayers=8,rows=4,cols=5,encoders=2,context=DEFAULT');
eq([DS.ROWS, DS.COLS], [4, 5], 'dimensi matriks terbaca');
eq(DS.layerCount, 6, 'layerCount terbaca (key firmware adalah "layerCount", bukan "layers")');
eq(DS.currentLayer, 1, 'currentLayer terbaca');
eq(DS.NUM_ENCODERS, 2, 'jumlah knob terbaca');
eq(calls.renderTabs, 1, 'renderTabs dipanggil sekali');
eq(ELS.deviceMatrixLabel.textContent, '4 × 5', 'label matriks diperbarui');
ok(calls.loadLayer.includes(1), 'layer aktif (1) dimuat ulang, bukan layer 0');

console.log('\n--- 3. INFO: nilai di luar rentang ditolak, tidak jadi NaN ---');
reset();
feed(INFO_3x3);
feed('INFO:layerCount=abc,rows=99999,cols=-5,encoders=xyz');
ok(Number.isInteger(DS.ROWS) && DS.ROWS > 0, `ROWS tetap positif dan bulat (${DS.ROWS})`);
eq([DS.ROWS, DS.COLS], [3, 3], 'nilai buruk tidak menimpa nilai valid sebelumnya');
eq(DS.layerCount, 6, 'layerCount buruk diabaikan');
eq(DS.NUM_ENCODERS, 1, 'encoders buruk diabaikan');

console.log('\n--- 4. DUMP_BEGIN/DUMP_END: isi masuk ke layer yang disebut, bukan currentLayer ---');
reset();
feed(INFO_3x3);
feed('DUMP_BEGIN:2');
feed('0,0,1,KeyA');
feed('1,2,3,halo, dunia');   // type 3 = TEXT; nilainya mengandung koma
feed('DUMP_END');
eq(DS.getLayer(2)[0][0], { type: 1, value: 'KeyA' }, 'baris DUMP masuk ke layer 2');
eq(DS.getLayer(2)[1][2], { type: 3, value: 'halo, dunia' }, 'nilai ber-koma tetap utuh');
eq(DS.getLayer(0)[0][0], null, 'layer 0 (currentLayer) tidak ikut terisi');

console.log('\n--- 5. DUMP_END mengosongkan target layer untuk blok berikutnya ---');
reset();
feed(INFO_3x3);
feed('DUMP_BEGIN:3');
feed('0,0,1,KeyD');
feed('DUMP_END');
eq(DS.getLayer(3)[0][0], { type: 1, value: 'KeyD' }, 'layer 3 terisi dari blok DUMP_BEGIN:3');
// Kalau target layer tidak di-reset, blok berikutnya akan diam-diam menulis ke
// layer yang salah - symptoms-nya layer user tertimpa isi preset.
feed('DUMP_BEGIN:1');
feed('0,0,1,KeyNext');
feed('DUMP_END');
eq(DS.getLayer(1)[0][0], { type: 1, value: 'KeyNext' }, 'blok kedua masuk ke layer 1, bukan layer 3');
eq(DS.getLayer(3)[0][0], { type: 1, value: 'KeyD' }, 'layer 3 tidak ikut tertimpa');

console.log('\n--- 6. Baris DUMP dengan indeks rusak: dilewati, tidak melempar ---');
reset();
feed(INFO_3x3);
feed('DUMP_BEGIN:0');
// Inilah kasus yang dulu mematikan parser: indeks di luar jangkauan / non-numerik.
feed('99,0,1,X');
feed('0,99,1,X');
feed('0,0,99,1,X');
feed('abc,def,ghi,1,X');
feed('0,0,9,TypeDiLuarRentang');
feed('99,0,1');            // hanya 3 field
feed('');
feed('DUMP_END');
eq(DS.getLayer(0)[0][0], null, 'tidak ada data korup yang masuk ke mapping');
eq(DS.getLayer(0)[2][0], null, 'indeks kolom 99 tidak menimpa apa pun');

console.log('\n--- 7. Payload DUMP tetap jadi data walau diawali EVT:LAYER ---');
reset();
feed(INFO_3x3);
feed('DUMP_BEGIN:0');
// "EVT:LAYER:1" bukan payload DUMP yang sah (kolomnya non-numerik), tapi TIDAK boleh
// membuat parser melompat keluar dari mode dump dan menggeser layer milik user.
// Baris DUMP sesudahnya tetap harus terbaca.
feed('EVT:LAYER:1');
feed('0,0,1,KeyC');
feed('DUMP_END');
eq(DS.getLayer(0)[0][0], { type: 1, value: 'KeyC' }, 'baris DUMP setelahnya tetap terbaca');
eq(DS.getLayer(1)[0][0], null, 'baris itu tidak menulis ke layer 1');

console.log('\n--- 8. ENC_BEGIN/IDX/CW/ENC_END menggeser binding knob ---');
reset();
feed('ENC_BEGIN:count=1');
feed('IDX:0');
feed('CW,1,KeyC');
feed('CCW,1,KeyCCW');
feed('BTN,5,AudioVolumeMute');
feed('ENC_END');
eq(DS.getEnc(0).CW, { type: 1, value: 'KeyC' }, 'binding CW knob 0');
eq(DS.getEnc(0).CCW, { type: 1, value: 'KeyCCW' }, 'binding CCW knob 0');
eq(DS.getEnc(0).BTN, { type: 5, value: 'AudioVolumeMute' }, 'binding BTN knob 0');
eq(calls.renderEncoderList, 1, 'renderEncoderList dipanggil di ENC_END');

console.log('\n--- 9. Kunci encoder di luar allowlist ditolak (anti prototype pollution) ---');
reset();
feed('ENC_BEGIN:count=1');
feed('IDX:0');
feed('__proto__,1,evil');
feed('constructor,1,evil');
feed('prototype,1,evil');
feed('ENC_END');
eq(DS.getEnc(0).CW, null, 'CW tidak terisi dari kunci di luar allowlist');
ok({}.evil === undefined && {}.CW === undefined, 'objek global tidak tersusupi');

console.log('\n--- 10. NAMES_BEGIN/NAMES_END: nama ber-koma dan ber-spasi tetap utuh ---');
reset();
feed('NAMES_BEGIN');
feed('0,Kerja');
feed('1,Bermain, dan JFK');
feed('2,Ada spasi');
feed('NAMES_END');
eq(DS.getNames()[0], 'Kerja', 'nama layer 0');
eq(DS.getNames()[1], 'Bermain, dan JFK', 'nama ber-koma tetap utuh');
eq(DS.getNames()[2], 'Ada spasi', 'nama ber-spasi tetap utuh');
eq(calls.renderTabs, 1, 'renderTabs dipanggil di NAMES_END');

console.log('\n--- 11. HWINFO: mengisi profil, knob, dan flag simulasi ---');
reset();
feed('HWINFO:profile=Prototype,encoders=1,statusLed=12,rgb=0,rgbSlots=0,vdiv=0,chg=0,simulated=1');
eq(P.deviceProfile.profile, 'Prototype', 'profile terbaca');
eq(P.deviceProfile.simulated, 1, 'flag simulated terbaca');
eq(calls.badge, 1, 'badge profil dirender ulang');
reset();
feed('HWINFO:profile=Final,encoders=2,statusLed=-1,rgb=1,rgbSlots=9,vdiv=1,chg=1,simulated=0');
eq(P.deviceProfile.profile, 'Final', 'profile FINAL terbaca');
eq(DS.NUM_ENCODERS, 2, 'jumlah knob ikut diperbarui dari HWINFO');
eq(P.deviceProfile.statusLed, -1, 'nilai negatif tetap dibaca sebagai angka');

console.log('\n--- 12. resetDeviceProfile() mengosongkan profil ---');
P.resetDeviceProfile();
eq(P.deviceProfile.profile, undefined, 'profil dikosongkan');
eq(P.deviceProfile.connected, false, 'ditandai tidak terhubung');

console.log('\n--- 13. Notifikasi event hardware ---');
reset();
feed('[KEY] 0,0,0,1,KeyA');
eq(calls.notifyBoundAction, [[1, 'KeyA']], 'baris [KEY] ringkas diteruskan apa adanya');
reset();
feed(INFO_3x3);
feed('ENC_BEGIN:count=1');
feed('IDX:0');
feed('CW,1,KeyCW');
feed('ENC_END');
// Sengaja TIDAK reset di sini: EVT:ENC harus membaca binding yang baru saja di-set.
feed('EVT:ENC:0:CW');
eq(calls.notifyBoundAction, [[1, 'KeyCW']], 'EVT:ENC membaca binding dari state knob');
reset();
feed(INFO_3x3);
feed('DUMP_BEGIN:0');
feed('0,1,LayerSatu', );
feed('DUMP_END');
feed('[LAYER] Pindah ke layer 1');
eq(calls.notify.length, 1, 'perubahan layer memicu tepat 1 notifikasi');
eq(calls.notify[0] ? calls.notify[0][0] : null, 'layer', 'kind notifikasi layer');

console.log('\n--- 14. WHOAMI: mengisi nama device ---');
reset();
feed('WHOAMI:MacroPad-ESP32');
eq(ELS.deviceNameLabel.textContent, 'MacroPad-ESP32', 'nama device tampil');

console.log('\n--- 15. PONG tidak diartikan sebagai perintah lain ---');
reset();
feed('PONG');
// reset() menghapus cache ELS, jadi elemen diambil ulang lewat document (PONG tidak menyentuh DOM sama sekali).
eq(document.getElementById('deviceNameLabel').textContent, '', 'PONG tidak mengubah label device');
eq(calls.renderGrid, 0, 'PONG tidak memicu render');

console.log(`\n${fail === 0 ? 'HASIL: protocol-parser.js mengurai baris device dengan benar' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);