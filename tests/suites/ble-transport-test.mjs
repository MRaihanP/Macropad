// Menguji src/ble-transport.js dan src/transport.js TANPA hardware BLE.
//
// Kenapa file ini perlu ada: versi pertama backend BLE-rotor pernah rusak total
// (identifier fIsConnected yang tidak pernah dideklarasikan, connect() yang
// hilang, sendBatch() yang memanggil writeRaw() yang tidak ada) tapi semua suite
// tetap hijau - karena tidak ada satu pun test yang mengeksekusi file itu.
// Test ini menutup celah itu: backend BLE benar-benar dipanggil, dengan stub
// invoke() yang mencatat setiap perintah Rust yang dikirim.
//
// Jalankan: node ble-transport-test.mjs
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { SRC, SRC_URL } from '../runner/paths.mjs';
import { pathToFileURL } from 'node:url';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (ditemukan ${JSON.stringify(a)}, diharapkan ${JSON.stringify(b)})`);

// ---- Stub DOM ----
const mkEl = () => ({
  value: '', textContent: '', innerHTML: '', checked: false, title: '', disabled: false,
  style: {}, dataset: {}, className: '',
  classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
  appendChild() { }, querySelector() { return mkEl(); }, querySelectorAll() { return []; },
  addEventListener() { }, setAttribute() { }, remove() { },
});
globalThis.document = { getElementById: () => mkEl(), createElement: () => mkEl() };
globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; } };

// ---- Stub @tauri-apps/api/core ----
// bledevices: pakai snake_case persis seperti struct BleDeviceInfo di Rust.
// Kalau test ini memakai camelCase, backend akan salah baca dan bug is_paired
// tidak akan pernah terdeteksi.
globalThis.__Invoke = { calls: [], failOn: new Set(), connected: true, devices: [], readQueue: [] };
const CORE_STUB = pathToFileURL(`${process.cwd()}/tests/suites/.ble-core-stub.mjs`).href;
fs.writeFileSync(
  `${process.cwd()}/tests/suites/.ble-core-stub.mjs`,
  `export function invoke(cmd, args) {
  const S = globalThis.__Invoke;
  S.calls.push({ cmd, args });
  if (S.failOn.has(cmd)) throw new Error('stub: ' + cmd + ' gagal');
  if (cmd === 'ble_scan') return S.devices;
  if (cmd === 'ble_is_connected') return S.connected;
  // Meniru rx_buffer di ble.rs: notify menumpuk byte, ble_read mengambilnya.
  if (cmd === 'ble_read') {
    const next = S.readQueue.shift();
    if (!next) return [];
    return Array.from(new TextEncoder().encode(next.join('\\n') + '\\n'));
  }
  return null;
}
`,
  'utf8',
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@tauri-apps/api/core') return { url: CORE_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const BLE = await import(`${SRC_URL}/ble-transport.js`);
const { markBatchSettling, batchUploadInFlight } = await import(`${SRC_URL}/upload-state.js`);
const F = await import(`${SRC_URL}/transport.js`);
const I = globalThis.__Invoke;

console.log('\n--- 1. Kontrak backend terpenuhi (dicek sebagai fungsi, bukan teks) ---');
// Ini yang paling penting: verifier versi pertama HANYA cocokkan string di
// main.js, sehingga identifier fiktif lolos. Di sini yang dipanggil beneran.
const required = [
  'initTransport', 'sendLine', 'sendBatch', 'connect', 'disconnect',
  'isConnected', 'isAutoBusy', 'enableAutoReconnect', 'autoDetect', 'poll',
  'updateConnectButton', 'handleDeviceLost', 'resetParserState',
  'setDumpInProgress', 'setDumpEncInProgress', 'setNamesInProgress',
  'eventsSuppressed', 'scheduleRetry', 'tryAutoConnect',
];
for (const sym of required) {
  ok(typeof BLE[sym] === 'function', `backend BLE mengekspor ${sym}()`);
}
// Semua state framing harus bisa dipanggil tanpa ReferenceError - ini akan
// langsung meledak kalau ada nama yang diketik salah.
ok(BLE.dumpInProgress === false && BLE.dumpEncInProgress === false && BLE.namesInProgress === false,
  'state framing diekspor sebagai nilai');
ok(BLE.portPath === null, 'portPath null (BLE tidak punya path)');

console.log('\n--- 2. scan() membaca key snake_case dari Rust ---');
I.calls = [];
I.devices = [{ id: 'aa:bb', name: 'MacroPad', is_paired: true }, { id: 'cc:dd', name: null, is_paired: false }];
const devices = await BLE.scan();
eq(devices.length, 2, 'scan mengembalikan 2 device');
eq(devices[0].isPaired, true, 'is_paired (snake_case) terbaca jadi isPaired');
eq(devices[1].name, 'MacroPad', 'name null jatuh ke default');
I.devices = 'bukan array';
eq(await BLE.scan(), [], 'scan tolerate respons bukan array');

console.log('\n--- 3. Framing baris: hook onLine menerima baris utuh ---');
let lines = [];
let ev = { connected: 0, disconnected: 0, deviceLost: 0, clearDirty: 0 };
// HOOKS selalu membaca objek `ev` yang sedang aktif, jadi test boleh mengganti
// isinya di tengah jalan tanpa memasang ulang initTransport(). Kalau hook-nya
// menangkap nilai lamanya, penghitungan di section 7/8 akan selalu 0.
const HOOKS = {
  onLine: (l) => lines.push(l),
  onConnected: () => { ev.connected++; },
  onDisconnected: () => { ev.disconnected++; },
  onDeviceLost: () => { ev.deviceLost++; },
  clearDirty: () => { ev.clearDirty++; },
  notify: () => { },
};
BLE.initTransport(HOOKS);
BLE.handleIncomingChunk('INFO:3x3\nDUM');
eq(lines, ['INFO:3x3'], 'baris lengkap diteruskan');
eq(lines.length, 1, 'baris parsial belum diteruskan');
BLE.handleIncomingChunk('PEND\nEVT:BATT:88\n');
eq(lines, ['INFO:3x3', 'DUMPEND', 'EVT:BATT:88'], 'sisa baris tersambung ke buffer');

console.log('\n--- 4. Batas buffer: sisa setelah newline terakhir tetap diparse ---');
lines = [];
// Kalau device mengirim satu baris raksasa tanpa newline, buffer tidak boleh
// tumbuh tanpa batas dan parser harus bisa pulih dari titik potong. Yang selamat
// adalah sisa setelah newline TERAKHIR - bagian yang masih bisa diparse.
// Regresi yang diuji: resetParserState() mengosongkan lineBuffer, jadi WAJIB
// dipanggil SETELAH lastIndexOf. Kalau urutannya dibalik, nl selalu -1 dan
// sisa ikut terbuang, parser desinkron sampai device berikutnya.
const big = 'X'.repeat(70 * 1024);
// Overflow di TENGAH baris: device mengirim data rusak tanpa newline. Yang
// selamat hanyalah sisa setelah newline terakhir; karena tidak ada newline
// sama sekali, sisanya kosong dan buffer dibuang bersih - bukan sisa rusak
// yang akan menempel ke baris device berikutnya.
BLE.handleIncomingChunk('JUNK:' + big);
ok(lines.length === 0, 'baris rusak tanpa newline tidak diteruskan');
ok(BLE.dumpInProgress === false, 'overflow reset penanda dump di backend BLE');
// Chunk berikutnya harus langsung diparse utuh: tidak ada sisa rusak yang
// menempel di depannya. Inilah yang akan meledak kalau resetParserState()
// dipanggil SEBELUM lastIndexOf dan sisa tidak dikembalikan.
lines = [];
BLE.handleIncomingChunk('\nINFO:3x3\nDUMPEND:1\n');
// Baris kosong ikut muncul karena newline pertama menutup sisa buffer kosong.
// Itu perilaku yang sama dengan serial-transport.js, dan aman: handleLine()
// di protocol-parser.js menolaknya di baris kedua (trim + return).
eq(lines, ['', 'INFO:3x3', 'DUMPEND:1'], 'baris setelah pemulihan diparse utuh, tidak tercemar sisa rusak');
ok(lines.slice(1).join('|') === 'INFO:3x3|DUMPEND:1', 'baris berguna tetap persis, tanpa prefix rusak');
ok(BLE.dumpInProgress === false, 'state framing di-reset saat overflow');
lines = [];
// Kasus tanpa newline sama sekali: buffer harus dibuang, tidak boleh nempel ke
// device berikutnya sebagai baris rusak.
BLE.handleIncomingChunk('JUNK:' + big);
BLE.handleIncomingChunk('\nINFO:3x3\n');
ok(lines.includes('INFO:3x3'), 'baris berikutnya tidak tercemar sisa rusak');
BLE.resetParserState();

console.log('\n--- 5. sendBatch tidak memanggil fungsi yang tidak ada ---');
// writeRaw() tidak pernah didefinisikan di versi pertama - ReferenceError saat dipanggil.
I.calls = [];
I.devices = [];
BLE.initTransport(HOOKS);
await BLE.connect('zz:11');
BLE.stopPing();               // connect() menyalakan interval ping
I.calls = [];
await BLE.sendBatch(['SET:0:0:0:1', 'SET:0:0:1:1', 'LAYER:0']);
ok(I.calls.every(c => c.cmd === 'ble_write'), 'semua write lewat ble_write');
ok(I.calls.length > 0, 'sendBatch benar-benar menulis');
const written = I.calls.map(c => Buffer.from(c.args.data).toString()).join('');
ok(written.includes('SET:0:0:0:1'), 'isi baris utuh sampai ke device');
ok(written.endsWith('\n'), 'batch diakhiri newline');

console.log('\n--- 6. Batas write BLE (NUS ~512 byte) ---');
I.calls = [];
const long = 'A'.repeat(300);
await BLE.sendBatch([long, long, long]);
for (const c of I.calls) {
  ok(c.args.data.length <= 512, `write ${c.args.data.length} byte <= 512 (batas NUS)`);
}

console.log('\n--- 7. Tulis gagal diperlakukan sebagai device hilang ---');
I.calls = [];
// Tulis hanya dicoba kalau sedang tersambung - kalau tidak, sendLine() keluar
// lebih dulu dan write gagal-nya tidak pernah diuji.
BLE.initTransport(HOOKS);
eq(await BLE.connect('zz:11'), true, 'connect untuk uji write gagal');
BLE.stopPing();
ev = { connected: 0, disconnected: 0, deviceLost: 0, clearDirty: 0 };
I.failOn = new Set(['ble_write']);
await BLE.sendLine('INFO');
eq(ev.deviceLost, 1, 'deviceLost hook dipanggil saat write gagal');
eq(ev.clearDirty, 1, 'clearDirty dipanggil (RAM device hilang)');
eq(BLE.isConnected(), false, 'status jadi tidak tersambung');
I.failOn = new Set();

console.log('\n--- 8. poll() menangkap perangkat yang hilang diam-diam ---');
BLE.initTransport(HOOKS);
eq(await BLE.connect('zz:11'), true, 'connect() berhasil');
BLE.stopPing();
I.connected = false;          // device mati tanpa memberi tahu
ev = { connected: 0, disconnected: 0, deviceLost: 0, clearDirty: 0 };
await BLE.poll();
eq(ev.deviceLost, 1, 'poll melaporkan device lost saat GATT sudah turun');
I.connected = true;
BLE.stopPing();               // matikan interval ping, kalau tidak proses tidak akan keluar

console.log('\n--- 8b. Jalur PENARIKAN DATA dari buffer Rust (regresi "tidak menerima apa-apa") ---');
// Regresi yang paling fatal: notify masuk ke rx_buffer Rust, tapi TIDAK ADA
// frontend yang memanggil ble_read. Buffer tidak pernah dikosongkan, handleLine()
// tidak pernah dipanggil, companion app diam saja padahal GATT tersambung.
// Test ini MENARIK DATA sungguhan lewat stub invoke() untuk memastikan jalurnya ada.
I.calls = [];
I.readQueue = [];                       // antrean yang akan dikembalikan ble_read
BLE.initTransport(HOOKS);
eq(await BLE.connect('zz:11'), true, 'connect untuk uji tarik data');
BLE.stopPing(); BLE.stopAllBleTimers();
lines = [];
I.readQueue.push(['INFO:3x3', 'DUMPNAMES', 'NAMES_END']);
const pulled = await BLE.readIncoming();
ok(pulled > 0, `readIncoming() menarik ${pulled} byte dari buffer`);
eq(lines, ['INFO:3x3', 'DUMPNAMES', 'NAMES_END'],
  'baris dari buffer Rust sampai ke hook onLine (ini yang hilang di regresi)');
// Buffer kosong harus berhenti dan tidak memanggil handleLine dengan junk.
lines = [];
I.readQueue = [];
await BLE.readIncoming();
eq(lines, [], 'buffer kosong tidak menghasilkan baris apa pun');
// Decoding harus aman untuk byte non-ASCII (nama layer/preset bisa UTF-8).
lines = [];
I.readQueue.push(['EVT:APP:aplikasi.exe']);
await BLE.readIncoming();
eq(lines, ['EVT:APP:aplikasi.exe'], 'byte UTF-8 multi-byte didekode utuh, tidak jadi rusak');
I.readQueue = [];
eq(F.transportId(), 'usb', 'backend default adalah USB');
ok(typeof F.isConnected === 'function', 'facade mengekspor isConnected()');
ok(typeof F.dumpInProgress === 'function', 'facade mengekspor dumpInProgress() sbg getter');
eq(typeof F.dumpInProgress(), 'boolean', 'getter mengembalikan boolean');
// Setter dari facade harus benar-benar mengubah state backend - kalau tidak,
// dump dari device tidak akan pernah selesai dan UI tersangkut.
F.setDumpInProgress(true);
eq(F.dumpInProgress(), true, 'setter facade mengubah state backend');
F.setDumpInProgress(false);
eq(F.dumpInProgress(), false, 'setter facade bisa mengosongkan lagi');

console.log('\n--- 9b. Memilih transport BLE harus langsung scan device ---');
// Dari log user: device BERHASIL ditemukan (scan menemukan 1 device), tapi
// dropdown device tidak pernah terisi. Sebabnya memilih transport BLE hanya
// mengganti backend - tidak ada yang memicu scan, jadi user tidak pernah
// punya device untuk dipilih dan tidak bisa menekan Sambung.
const mainSrc = fs.readFileSync(`${SRC}/main.js`, 'utf8');
ok(/bleBackend\(\)/.test(mainSrc),
  'main.js mengambil backend BLE lewat facade (bukan import langsung)');
ok(!/await import\('\.\/ble-transport\.js'\)/.test(mainSrc),
  'tidak ada import langsung ble-transport.js di main.js (bisa dapat modul berbeda)');
const switchBody = mainSrc.match(/transportSel\.onchange = async \(\) => \{([\s\S]*?)\n  \};/);
ok(!!switchBody, 'badan onchange handler terambil');
if (switchBody) {
  ok(/setTransportBackend\(/.test(switchBody[1]), 'onchange mengganti backend');
  ok(/scanAndUpdateSelect\(\)/.test(switchBody[1]),
    'onchange LANGSUNG scan setelah backend terpasang (dropdown tidak boleh kosong)');
  // Urutan: ganti backend DULU, baru scan. Kalau scan dulu, yang dipanggil
  // scan() dari instance modul yang belum jadi backend aktif.
  ok(switchBody[1].indexOf('setTransportBackend')
      < switchBody[1].indexOf('scanAndUpdateSelect'),
    'setTransportBackend() dijalankan SEBELUM scanAndUpdateSelect()');
}
ok(/export function bleBackend/.test(
    fs.readFileSync(`${SRC}/transport.js`, 'utf8')),
  'facade mengekspor bleBackend()');

console.log('\n--- 10. Tidak ada modul yang menembak serial-transport.js langsung ---');
// Inilah regresi yang membuat BLE tidak pernah jalan: main.js diarahkan ke facade,
// tapi empat modul lain tetap menulis ke port COM.
for (const f of ['adaptive.js', 'home-page.js', 'tray.js', 'protocol-parser.js', 'main.js']) {
  const src = fs.readFileSync(`${SRC}/${f}`, 'utf8');
  ok(!/from ['"]\.\/serial-transport\.js['"]/.test(src), `${f} tidak import serial-transport.js langsung`);
}
// Guard tambahan: backend BLE harus punya sendiri setiap simbol yang dipakai
// facade, bukan diimpor dari serial (itu akan menggabungkan dua state).
const bleSrc = fs.readFileSync(`${SRC}/ble-transport.js`, 'utf8');
ok(!/from ['"]\.\/serial-transport\.js['"]/.test(bleSrc), 'backend BLE tidak bergantung pada serial-transport.js');
for (const sym of ['dumpInProgress', 'isConnected', 'autoBusy', 'lineBuffer']) {
  ok(new RegExp(`(let|const|export let)\\s+${sym}\\b`).test(bleSrc), `backend BLE punya state sendiri: ${sym}`);
}

console.log('\n--- 8c. disconnect() saat BELUM pernah tersambung tidak boleh merusak state ---');
// Regresi dari log user: saat memilih transport BLE, facade memanggil
// disconnect(true) pada backend yang belum pernah tersambung. Tanpa guard,
// disconnect() tetap mematikan autoReconnect, mengirim notifikasi "terputus"
// yang tidak benar, dan memunculkan error "BLE tidak terhubung" - yang
// menutupi masalah sebenarnya dan membuat user mengira BLE rusak total.
BLE.initTransport(HOOKS);
I.readQueue = [];
// Section sebelumnya meninggalkan device tersambung. Tutup dulu supaya test
// ini benar-benar menguji disconnect() pada kondisi "tidak pernah tersambung"
// - kondisi yang memicu bug di dunia nyata.
await BLE.disconnect(true);
BLE.stopAllBleTimers();
I.calls = [];
ev = { connected: 0, disconnected: 0, deviceLost: 0, clearDirty: 0 };
eq(BLE.isConnected(), false, 'kondisi awal: belum tersambung');
await BLE.disconnect(true);
eq(ev.deviceLost, 0, 'tidak memicu onDeviceLost saat memang tidak ada koneksi');
eq(ev.disconnected, 0, 'tidak memicu onDisconnected saat memang tidak ada koneksi');
ok(!I.calls.some(c => c.cmd === 'ble_disconnect'),
  'tidak memanggil ble_disconnect ke Rust saat tidak ada koneksi (hindari "BLE tidak terhubung")');
// Yang penting: setelah disconnect() lalu connect(), autoReconnect TIDAK boleh
// tersangkut false - kalau iya, retry otomatis tidak akan pernah berjalan.
I.devices = [];
eq(await BLE.connect('zz:22'), true, 'connect setelah disconnect berhasil');
BLE.stopPing(); BLE.stopAllBleTimers();

console.log('\n--- 9c. UI harus terlihat di mode BLE ---');
const bleSrc2 = fs.readFileSync(`${SRC}/ble-transport.js`, 'utf8');
// Dari log user: tidak bisa melihat panel log di mode BLE dan harus balik ke
// USB. Penyebabnya DUA hal, keduanya tersembunyi di balik ini.
//
// #app (seluruh halaman aplikasi + panel log) disembunyikan lewat
// style.display dan HANYA serial-transport.js yang pernah mengubahnya.
// Backend BLE tidak punya setConnected sama sekali.
//
// Dan tombol Sambung pernah diletakkan DI DALAM #usbRow, yang
// disembunyikan saat mode BLE - jadi di mode BLE tidak ada tombol untuk
// menyambung sama sekali.
const html = fs.readFileSync(`${SRC}/index.html`, 'utf8');
ok(/export function setConnected/.test(bleSrc2),
  'backend BLE punya setConnected() seperti serial');
ok(/app\.style\.display/.test(bleSrc2),
  'setConnected() backend BLE menampilkan #app (UI + panel log)');
// Tombol connect HARUS di luar usbRow maupun bleRow.
const connectBtnAt = html.indexOf('id="btnConnect"');
const usbRowAt = html.indexOf('id="usbRow"');
const bleRowAt = html.indexOf('id="bleRow"');
ok(connectBtnAt > 0 && usbRowAt > 0 && bleRowAt > 0, 'ketiga elemen ada di index.html');
const usbRowEnd = html.indexOf('</div>\n        <!-- Baris device BLE', usbRowAt);
ok(connectBtnAt > usbRowEnd, 'btnConnect DI LUAR #usbRow (tidak ikut hilang di mode BLE)');
ok(connectBtnAt > bleRowAt, 'btnConnect DI LUAR #bleRow');
// setConnected(true) harus dipanggil di connect() supaya #app muncul.
const cBody = fs.readFileSync(`${SRC}/ble-transport.js`, 'utf8')
  .match(/export async function connect[\s\S]*?\n\}/);
ok(cBody && /setConnected\(true\)/.test(cBody[0]),
  'connect() memanggil setConnected(true) - UI muncul setelah tersambung');
// onchange harus赋值 nilai awal SEBELUM dipasang, kalau tidak scan dobel.
ok(switchBody && switchBody[1].indexOf('scanAndUpdateSelect') > -1, 'onchange tetap scan');
const mainCode = fs.readFileSync(`${SRC}/main.js`, 'utf8');
const valueAt = mainCode.indexOf('transportSel.value = transportId()');
const onchangeAt = mainCode.indexOf('transportSel.onchange');
ok(valueAt > 0 && onchangeAt > valueAt,
  'nilai awal di-set SEBELUM onchange dipasang (scan tidak dobel)');

console.log('\n--- 9d. Dump yang menggantung harus terdeteksi, tidak menelan semua baris ---');
// Dari log user: HWINFO dan LAYER diterima, lalu SETIAP baris berikutnya
// ditolak "Invalid DUMP line". Artinya DUMP_BEGIN sampai tapi DUMP_END tidak
// pernah datang, flag dumpInProgress tidak pernah turun, dan HWINFO/BATT/
// EVT:* berikutnya dianggap "isi dump".
//
// Akarnya di firmware: println() menulis string dan "\n" sebagai DUA write.
// Di serial tidak masalah; lewat BLE notify bisa gagal, dan kalau yang gagal
// write newline, baris tidak pernah diakhiri - parser yang hanya memproses
// setelah '\n' akan menunggunya selamanya.
const fwTransport = fs.readFileSync(`${SRC}/../firmware/common/transport.h`, 'utf8');
const printlnBody = fwTransport.match(/void println\(const char\* str\) override \{([\s\S]*?)\n  \}/);
ok(!!printlnBody, 'println() override di transport.h ditemukan');
if (printlnBody) {
  const body = printlnBody[1];
  // WAJIB satu write: string + newline digabung sebelum dikirim.
  ok(/memcpy\(line, str, len\)/.test(body) && /line\[len\]\s*=\s*'\\n'/.test(body),
    'println() menyalin newline ke buffer, bukan write terpisah');
  ok(/write\(\(const uint8_t\*\)line,\s*len \+ 1\)/.test(body),
    'println() menulis string + newline dalam SATU write() (notify tidak bisa gagal di tengah)');
  ok(!/write\(\(const uint8_t\*\)&nl, 1\)/.test(body),
    'tidak ada lagi write terpisah untuk newline');
}
// Sisi app: watchdog harus membukanya lagi supaya tidak terkunci selamanya.
ok(/armDumpWatchdog/.test(bleSrc2), 'backend BLE punya watchdog dump menggantung');
ok(/ble\.dumpStuck/.test(bleSrc2), 'ada pesan yang menjelaskan penyebabnya ke user');
ok(/resetParserState\(\);\s*\n\s*lineBuffer = ''/.test(bleSrc2) || /cancelDumpWatchdog/.test(bleSrc2),
  'watchdog membatalkan dirinya agar parser tidak terkunci selamanya');
ok(/DUMP_STUCK_MS\s*=\s*2000/.test(bleSrc2), 'batas tunggu 2 detik (cukup panjang, cukup cepat)');
ok(/onDumpStuck/.test(bleSrc2), 'backend memberi tahu app lewat hook onDumpStuck');
ok(/onDumpStuck/.test(mainSrc), 'main.js memasang hook onDumpStuck');

console.log('\n--- 9e. Frame NAMES juga terlindungi (bug lanjutan dari log user) ---');
// Setelah DUMP_END diperbaiki, frame berikutnya rusak: NAMES_BEGIN sampai tapi
// NAMES_END hilang -> namesInProgress tidak pernah turun -> SETIAP baris
// berikutnya (INFO, [KEY], EVT:*) ditolak "Invalid NAMES line".
//
// Akar yang sebenernya: handler INFO mengirim DUMPNAMES tanpa syarat. INFO
// datang BERUNTUN dalam satu sesi - handshake mengirimnya, lalu tiap
// activatePresetRuntime() mengirim lagi. Tiap INFO memicu DUMPNAMES tambahan
// yang menumpuk di ylab yang sama, dan NAMES_END dari dump pertama menutupi
// dump kedua.
const parserSrc = fs.readFileSync(`${SRC}/protocol-parser.js`, 'utf8');
const infoBlock = parserSrc.match(/if \(line\.startsWith\('INFO:'\)\) \{([\s\S]*?)\n  \}/);
ok(!!infoBlock, 'blok handler INFO ditemukan');
if (infoBlock) {
  ok(/if \(!namesInProgress\(\) && !dumpInProgress\(\)\) sendLine\('DUMPNAMES'\)/.test(infoBlock[1]),
    'DUMPNAMES hanya dikirim kalau tidak ada dump/nama yang sedang berjalan');
}
// Watchdog di backend BLE harus menutup frame NAMES juga, bukan hanya DUMP.
ok(/namesInProgress && line\.indexOf\(','\) > 0/.test(bleSrc2),
  'watchdog juga armed saat DUMPNAMES menggantung (bukan cuma DUMP)');
ok(/kind: namesInProgress \? 'DUMPNAMES' : 'DUMP'/.test(bleSrc2),
  'pesan watchdog menyebut frame mana yang menggantung');
// Baris DUMPNAMES ("<idx>,<name>") tidak cocok pola \d,\d,\d, jadi jalur NAMES
// tidak bisa pakai predicate yang sama dengan DUMP.
ok(/\(namesInProgress && line\.indexOf\(','\) > 0\)/.test(bleSrc2),
  'NAMES punya predicate sendiri (baris "<idx>,<name>" tidak cocok \d,\d,\d)');

console.log('\n--- 9f. Event real-time harus menang atas frame dump ---');
// Dari log user: device masuk mode BLE, DUMP_BEGIN/DUMPNAMES datang, lalu
// setiap EVT:BATT dan [KEY] yang datang DI TENGAH dump dianggap "isi dump"
// dan ditolak ("Invalid DUMP line"). Akibatnya notifikasi overlay hilang
// tepat saat user menekan tombol, meter baterai berhenti, dan log dibanjiri
// ratusan error yang menutupi masalah sebenarnya.
//
// Device tidak tahu sedang di-dump dan tidak menunggu - EVT:BATT dikirim tiap
// ~1 detik, [KEY] setiap tombol ditekan. Keduanya sah dan harus selalu diparse.
const psrc = fs.readFileSync(`${SRC}/protocol-parser.js`, 'utf8');
ok(/function handleRealtimeLine/.test(psrc), 'ada jalur terpisah untuk event real-time');
ok(/function handleFrameLine/.test(psrc), 'ada jalur terpisah untuk frame');
// handleLine harus mengalihkan SEBELUM memanggil frame handler.
const hl = psrc.match(/export function handleLine[\s\S]*?\n\}/);
ok(!!hl, 'badan handleLine() terambil');
if (hl) {
  const body = hl[0];
  ok(/line\.startsWith\('EVT:'\) \|\| line\.startsWith\('\['\)/.test(body),
    'handleLine mengalihkan EVT: dan [ ke jalur realtime');
  ok(body.indexOf('handleRealtimeLine(line)')
      < body.indexOf('handleFrameLine(line)'),
    'realtime dijalankan SEBELUM frame (event tidak pernah tertelan dump)');
}
// EVT:LAYER: harus tetap menunda saat dump, tapi ceknya pindah ke realtime.
const rt = psrc.match(/function handleRealtimeLine[\s\S]*?\n\}/);
ok(rt && /EVT:LAYER:/.test(rt[0]), 'EVT:LAYER: ditangani di jalur realtime');
ok(rt && /pendingLayerAfterDump = n/.test(rt[0]),
  'EVT:LAYER: masih menunda saat dump berjalan (currentLayer tidak berubah di tengah dump)');
// EVT:BATT / EVT:CHG harus di realtime, bukan di frame (kalau di frame, tak
// terjangkau karena handleLine sudah menyaring "EVT:").
for (const k of ['EVT:BATT:', 'EVT:CHG:']) {
  ok(rt && rt[0].includes(k), `${k} ditangani di jalur realtime`);
  const fr = psrc.match(/function handleFrameLine[\s\S]*?\n\}\s*$/);
  ok(!fr || !fr[0].includes(k), `${k} tidak lagi di jalur frame (jadi tidak dead code)`);
}

console.log('\n--- 9g. Watchdog tidak salah melapor pada frame yang SEHAT ---');
// Dari log user: "DUMPNAMES never closed (terminator lost)" muncul padahal
// NAMES_END-nya jelas sampai - parser sempat memproses frame itu dengan benar.
//
// Penyebabnya urutan cek, bukan data yang hilang. Penutup dicek SEBELUM loop
// while memproses baris, jadi dalam satu chunk yang memuat frame utuh:
//
//   NAMES_BEGIN  -> setNamesInProgress(true)   (di hooks.onLine, SETELAH cek)
//   0,Layer 0     -> isi frame
//   NAMES_END     -> setNamesInProgress(false)
//
// Cek penutup dijalankan sebelum semua itu, jadi NAMES_END yang ada di chunk
// sama BELUM terlihat, dan setelah loop flag namesInProgress menyala ->
// watchdog ter-arm untuk frame yang sudah selesai rapi.
BLE.initTransport(HOOKS);
lines = [];
let stuckWarned = false;
// Hook harus dipasang ulang SETELAH connect(): connect() memanggil
// setConnected() yang memicu onDisconnected, dan kita butuh onDumpStuck yang
// menandai apa pun di section ini.
BLE.initTransport({
  onLine: (l) => lines.push(l),
  onDeviceLost() { }, onDisconnected() { }, onDumpStuck() { stuckWarned = true; },
  clearDirty() { }, notify() { },
});
I.devices = [];
// Section sebelumnya (9b/9c) memanggil setTransportBackend() yang menutup
// koneksi. Pastikan kita mulai bersih - kalau tidak, connect() di sini
// mungkin melihat flag masih nyala dan perilakunya tidak seperti dunia nyata.
await BLE.disconnect(true);
BLE.stopAllBleTimers();
eq(BLE.isConnected(), false, 'kondisi awal bersih untuk uji watchdog');
eq(await BLE.connect('zz:33'), true, 'connect untuk uji watchdog');
BLE.stopPing(); BLE.stopAllBleTimers();
BLE.initTransport({
  onLine: (l) => lines.push(l),
  onDeviceLost() { }, onDisconnected() { }, onDumpStuck() { stuckWarned = true; },
  clearDirty() { }, notify() { },
});

// Frame NAMES utuh dalam SATU chunk - kasus yang dulu salah dilaporkan.
I.readQueue = [['NAMES_BEGIN', '0,Layer 0', '1,Layer 1', 'NAMES_END']];
await BLE.readIncoming();
eq(lines, ['NAMES_BEGIN', '0,Layer 0', '1,Layer 1', 'NAMES_END'],
  'frame NAMES utuh terbaca semua');
eq(stuckWarned, false, 'frame NAMES yang SEHAT tidak memicu watchdog');

// Tunggu sedikit lebih dari batas watchdog: kalau penutup tidak membatalkan
// timer, ini akan tembak.
await new Promise(r => setTimeout(r, 2400));
eq(stuckWarned, false, 'watchdog TIDAK tembak setelah 2,4 detik untuk frame yang sehat');

// Frame yang benar-benar menggantung HARUS tetap terdeteksi - jaring pengaman
// tidak boleh mati karena perbaikannya di atas.
//
// namesInProgress di-set oleh protocol-parser saat NAMES_END hilang. Di test
// ini parser tidak ikut jalan (backend diuji terpisah), jadi flag-nya diset
// manual: yang diuji di sini adalah KEPUTUSAN watchdog, bukan parser.
BLE.setNamesInProgress(true);
I.readQueue = [['0,Layer 0']];
await BLE.readIncoming();
await new Promise(r => setTimeout(r, 2400));
eq(stuckWarned, true, 'frame yang benar-benar menggantung tetap terdeteksi');
BLE.setNamesInProgress(false);
// Tutup timer yang SISA di-arm dari kasus menggantung di atas. Kalau dibiarkan,
// dia akan jatuh tempo di tengah section 9h dan test itu tidak menguji apa pun.
BLE.setDumpInProgress(false);
await BLE.disconnect(true);
BLE.stopAllBleTimers();

console.log('\n--- 9h. Watchdog tahan saat batch upload preset sedang jalan ---');
// Dari log user: saat alt+tab cepat antara app dan companion app,
// "DUMP never closed (terminator lost)" muncul padahal device sehat.
//
//activatePresetRuntime() mengirim ratusan perintah SET. Device memprosesnya
// satu per satu dan membalas [OK] untuk tiap baris - jadi jawaban DUMP:0
// yang menyusul BENAR-BENAR tertahan di antrean dan baru keluar belasan
// detik kemudian pada preset besar. Watchdog yang tidak tahu soal ini
// menyimpulkan dump-nya hilang.
const uploadSrc = fs.readFileSync(`${SRC}/upload-state.js`, 'utf8');
ok(/export function batchUploadInFlight/.test(uploadSrc),
  'upload-state.js mengekspor batchUploadInFlight()');
ok(/export function markBatchSettling/.test(uploadSrc),
  'upload-state.js mengekspor markBatchSettling()');
// PENTING: tidak boleh menaruh flag ini di adaptive.js. adaptive mengimpor
// transport, dan backend BLE mengimpor adaptive = siklus import runtime.
ok(/from '\.\/upload-state\.js'/.test(bleSrc2),
  'backend BLE membaca flag dari upload-state.js, bukan adaptive.js');
ok(!/from '\.\/adaptive\.js'/.test(bleSrc2),
  'backend BLE TIDAK mengimpor adaptive.js (hindari siklus import)');
ok(/import \{ markBatchSettling \} from '\.\/upload-state\.js'/.test(
    fs.readFileSync(`${SRC}/adaptive.js`, 'utf8')),
  'adaptive.js menandai batch lewat upload-state.js');
ok(/batchUploadInFlight\(\)\) continue;/.test(bleSrc2),
  'watchdog DITAHAN saat batch upload sedang jalan');
// resetParserState() SENGAJA tidak mereset flag batch. Watchdog memanggilnya
// dari dalam callback-nya sendiri saat memaksa membuka dump yang macet - dan
// pada saat itu device mungkin sedang dikejar antrean upload. Kalau flag di
// sana ikut terhapus, bukti "device sedang sibuk" hilang, watchdog melapor
// frame sehat sebagai hilang, dan karena ia me-arm ulang dirinya sendiri,
// itu berulang terus.
ok(!/resetParserState\(\)[\s\S]{0,900}resetBatchUploadState\(\)/.test(
    bleSrc2.slice(bleSrc2.indexOf('export function resetParserState'),
                  bleSrc2.indexOf('export function resetParserState') + 900)),
  'resetParserState() TIDAK mereset flag batch (kalau iya watchdog loop tanpa henti)');
// Flag batch harus direset DI disconnect (device tidak lagi menerima apa pun),
// dan TIDAK di resetParserState (dipakai watchdog saat memaksa membuka dump).
const resetStateBody = bleSrc2.slice(
  bleSrc2.indexOf('export function resetParserState'),
  bleSrc2.indexOf('export function resetParserState') + 600);
ok(!/resetBatchUploadState/.test(resetStateBody),
  'resetParserState() tidak mereset flag batch');
ok(/disconnect[\s\S]{0,900}resetBatchUploadState\(\)/.test(bleSrc2),
  'flag batch direset di jalur disconnect (tempatnya satu-satunya)');

// Uji perilaku: dengan batch aktif, dump yang menggantung tidak boleh
// dilaporkan hilang - device memang sedang sibuk.
BLE.initTransport({ onLine() { }, onDumpStuck() { stuckWarned = true; },
  onDeviceLost() { }, onDisconnected() { }, clearDirty() { }, notify() { } });
// Section sebelumnya meninggalkan watchdog ter-arm DAN flag batch aktif.
// Bersihkan keduanya dulu lewat disconnect (satu-satunya jalur yang mereset
// flag batch), kalau tidak test ini menguji sisa state section lain.
await BLE.disconnect(true);
BLE.stopAllBleTimers();
I.devices = [];
eq(await BLE.connect('zz:44'), true, 'connect untuk uji batch');
BLE.stopPing(); BLE.stopAllBleTimers();
BLE.initTransport({ onLine() { }, onDumpStuck() { stuckWarned = true; },
  onDeviceLost() { }, onDisconnected() { }, clearDirty() { }, notify() { } });

// Section 9g berakhir dengan stuckWarned = true (kasus "menggantung" yang
// memang harus terdeteksi). Reset di sini, kalau tidak assertion di bawah
// selalu gagal bukan karena bug, tapi karena sisa section sebelumnya.
stuckWarned = false;
markBatchSettling(6000);
ok(batchUploadInFlight(), 'flag batch aktif sebelum test');
BLE.setDumpInProgress(true);
I.readQueue = [['0,0,0,1,1', '0,0,1,1,2']];
const pulledH = await BLE.readIncoming();
ok(pulledH > 0, `readIncoming menarik ${pulledH} byte (batch aktif)`);
await new Promise(r => setTimeout(r, 2400));
ok(batchUploadInFlight(), 'flag batch masih aktif selama tunggu (dasar test)');
eq(stuckWarned, false, 'batch upload aktif -> watchdog tidak salah melapor');

// Setelah jeda settling habis, deteksi harus hidup kembali.
BLE.setDumpInProgress(false);
markBatchSettling(0);
BLE.setDumpInProgress(true);
I.readQueue = [['0,0,0,1,1']];
await BLE.readIncoming();
await new Promise(r => setTimeout(r, 2400));
eq(stuckWarned, true, 'setelah batch selesai, deteksi kembali normal');
BLE.setDumpInProgress(false);

console.log('\n--- 9i. Baris status tidak dibuang saat frame NAMES berjalan ---');
// Dari log user: "Invalid NAMES line, skipped: INFO:layerCount=1,..."
// berulang, dan grid tidak pernah berubah saat preset berganti.
//
// INFO mengandung koma (INFO:layerCount=1,rows=3,...), jadi tanpa
// pembeda ia diperlakukan sebagai "<idx>,<nama>" dan applyName() menolaknya -
// lalu DIBUANG. Padahal INFO-lah yang memicu loadLayer(); membuangnya berarti
// grid tidak pernah dimuat ulang setelah preset berganti.
const psrc2 = fs.readFileSync(`${SRC}/protocol-parser.js`, 'utf8');
ok(/function isNamesRow/.test(psrc2), 'ada isNamesRow() untuk membedakan isi frame dari baris status');
ok(/function processDeferredLines/.test(psrc2), 'ada processDeferredLines() untuk memproses antrean tertunda');
ok(/deferredLines\.push\(line\)/.test(psrc2),
  'baris non-frame DITUNDA (bukan dibuang) saat frame NAMES berjalan');
ok(/processDeferredLines\(\)/.test(psrc2),
  'antrean diproses begitu NAMES_END datang');
ok(/DEFERRED_MAX/.test(psrc2), 'antrean dibatasi (NAMES_END hilang tidak boleh menumpuk selamanya)');
// Isi frame NAMES = "<idx>,<nama>"; head sebelum koma harus angka.
const isNamesRowBody = psrc2.match(/function isNamesRow[\s\S]*?\n\}/);
ok(isNamesRowBody && /\^\\d\+\$/.test(isNamesRowBody[0]),
  'isNamesRow() memeriksa head "<idx>" adalah angka');

// Preset switch harus minta dump ulang layer.
const adaptiveSrc = fs.readFileSync(`${SRC}/adaptive.js`, 'utf8');
ok(/hooks\.loadLayer\(currentLayer\)/.test(adaptiveSrc),
  'activatePresetRuntime meminta dump layer lewat hooks.loadLayer (grid ikut berubah)');
ok(!/from '\.\/home-page\.js'/.test(adaptiveSrc),
  'adaptive.js tetap tidak mengimpor home-page.js (aturan kontrak)');
// Cooldown: companion app sendiri yang sedang fokus memicu "Back to Default",
// lalu target memicu switch balik - dua-duanya upload penuh.
ok(/SWITCH_COOLDOWN_MS/.test(adaptiveSrc), 'ada cooldown antar perpindahan preset');
ok(/Date\.now\(\) - lastSwitchAt < SWITCH_COOLDOWN_MS/.test(adaptiveSrc),
  'cooldown dicek sebelum switch baru');
ok(/lastSwitchAt = Date\.now\(\)/.test(adaptiveSrc),
  'lastSwitchAt diperbarui saat switch terjadi');

console.log('\n--- 9j. Connect gagal tidak boleh meracuni percobaan berikutnya ---');
// Dari log user (firmware terbaru, flash berhasil):
//   BLE write failed: The operation was canceled by the user. (0x800704C7)
//   BLE connect failed: Gagal ambil TX characteristic: ... (0x8000000B)  x20
//
// 0x800704C7 = operasi dibatalkan karena link sebelumnya belum bersih.
// 0x8000000B = E_BOUNDS: GetAt(0) pada koleksi characteristic yang KOSONG.
//
// Urutannya: connect pertama berhasil sebagian (BluetoothLEDevice dibuat),
// lalu gagal di langkah berikutnya. Handle-nya tertinggal di sisi Rust ->
// Windows membatalkan operasi pada link tertinggal itu -> percobaan
// berikutnya membaca cache GATT yang belum lengkap -> koleksi kosong ->
// E_BOUNDS. Dan karena setiap kegagalan meninggalkan handle baru, satu
// kegagalan awal jadi cause SEMUA kegagalan berikutnya.
const bleRs = fs.readFileSync(`${SRC}/../src-tauri/src/ble.rs`, 'utf8');
ok(/if tx_list\.Size\(\)/.test(bleRs),
  'TX characteristic dicek koleksi kosongnya secara eksplisit');
ok(/if rx_list\.Size\(\)/.test(bleRs),
  'RX characteristic juga dicek (kalau hanya TX, RX akan jadi error berikutnya)');
ok(/belum terdaftar/.test(bleRs),
  'pesan error menjelaskan penyebabnya, bukan sekadar "index di luar jangkauan"');
// Sisi app: connect yang gagal WAJIB melepas link.
const connectBody = bleSrc2.match(/export async function connect[\s\S]*?\n\}/);
ok(connectBody, 'badan connect() terambil');
if (connectBody) {
  const body = connectBody[0];
  const catchBlock = body.slice(body.indexOf('} catch'));
  ok(/invoke\('ble_disconnect'\)/.test(catchBlock),
    'connect() yang gagal memanggil ble_disconnect (handle tidak tertinggal)');
}
// Jeda retry harus cukup untuk Windows melepas link GATT.
ok(/await sleep\(1500\)/.test(bleSrc2),
  'jeda retry dinaikkan ke 1500 ms (400 ms tidak cukup untuk Windows)');

// ---- Single-flight connect ----
//
// Tanpa guard ini, klik Connect + scheduleRetry() + tryAutoConnect() bisa
// membuka link BLE bersamaan.TIAP link memasang callback notifikasi sendiri
// yang menulis ke buffer bersama, jadi notify bercampur dan link yang
// paling dulu hilang menghasilkan supervision timeout (0x208).
console.log('\n--- 9. Single-flight: hanya boleh ada SATU connect hidup ---');
ok(/let connectBusy = false/.test(bleSrc2),
  'ada flag connectBusy yang menandai connect sedang berjalan');
ok(/if \(connectBusy\)\s*\{[\s\S]{0,400}?return false;/.test(bleSrc2),
  'connect() menolak (bukan menunggu) kalau ada connect lain yang jalan');
ok(/connectBusy = true/.test(bleSrc2),
  'connectBusy di-set sebelum menunggu Windows');
ok(/connectBusy = false/.test(bleSrc2),
  'connectBusy selalu dilepas supaya retry berikutnya tidak terkunci selamanya');
// Timeout wajib: tanpa itu FromIdAsync yang menggantung menahan guard
// selamanya dan tidak ada yang bisa mencoba lagi.
ok(/setTimeout\(\(\) => r\(false\), 10000\)/.test(bleSrc2),
  'connect() punya batas waktu 10 detik (FromIdAsync kadang tidak resolve)');

// ---- Handshake gate ----
//
// `isConnected()` sudah true SEBELUM afterConnectHandshake() selesai. Tanpa
// flag terpisah, poll auto-switch preset di adaptive.js langsung mengirim
// upload preset lengkap (ratusan perintah SET) di atas 7 perintah handshake
// yang masih diproses device - dua aliran perintah tumpang tindih, dan link
// putus tepat setelah connect.
console.log('\n--- 11. Handshake gate: auto-switch menunggu handshake selesai ---');
ok(/let handshakeInProgress = false/.test(bleSrc2),
  'ada flag handshakeInProgress di backend BLE');
ok(/export function handshakePending\(\)/.test(bleSrc2),
  'backend BLE mengekspor handshakePending()');
// Ditandai SEBELUM penundaan 400 ms, kalau tidak ada jendela di mana
// connected=true tapi flag masih false.
const hsIdx = bleSrc2.indexOf('handshakeInProgress = true');
const timeoutIdx = bleSrc2.indexOf('}, 400);');
ok(hsIdx > -1 && timeoutIdx > -1 && hsIdx < timeoutIdx,
  'handshakeInProgress di-set SEBELUM setTimeout 400 ms (tidak ada celah)');
// Harus turun di semua jalur keluar, kalau tidak auto-switch mati permanen
// setelah satu handshake yang menggantung.
const hsClears = (bleSrc2.match(/handshakeInProgress = false/g) || []).length;
ok(hsClears >= 3,
  `handshakeInProgress dilepas di semua jalur keluar (jawaban masuk, timeout, disconnect, device hilang) - ada ${hsClears}`);

// Facade harus meneruskan, dan serial harus aman (tidak punya handshake).
const facadeSrc = fs.readFileSync(`${SRC}/../src/transport.js`, 'utf8');
ok(/export function handshakePending\(\)/.test(facadeSrc),
  'facade meneruskan handshakePending() ke backend aktif');
ok(/typeof backend\.handshakePending === 'function'/.test(facadeSrc),
  'facade aman kalau backend tidak punya handshakePending (serial)');

// Sisi adaptive: guard HARUS ada di autoSwitchBlockedByLayerChoice().
const adaptiveHsSrc = fs.readFileSync(`${SRC}/../src/adaptive.js`, 'utf8');
const blockedBodyHs = adaptiveHsSrc.slice(adaptiveHsSrc.indexOf('function autoSwitchBlockedByLayerChoice'));
ok(/if \(handshakePending\(\)\) return true;/.test(blockedBodyHs),
  'autoSwitchBlockedByLayerChoice() memblokir selama handshake berjalan');
ok(/import \{[^}]*handshakePending[^}]*\} from '\.\/transport\.js'/.test(adaptiveHsSrc),
  'adaptive.js mengimpor handshakePending dari facade (bukan backend langsung)');

// ---- Auto-connect berkala ----
//
// VERSI LAMA poll() punya `if (!connected) return;` di baris pertama, jadi
// saat device tidak tersambung, TIDAK ADA apa pun yang mencari. Scan hanya
// pernah jalan dari autoDetect() (sekali saat app start, saat transport masih
// USB) dan dari scanAndUpdateSelect() (sekali saat user pilih BLE).
//
// Akibatnya: instal baru (localStorage kosong -> lastGoodDeviceId null) tidak
// pernah_scheduleRetry(), dan tidak pernah ada yang scan lagi. User HARUS
// Refresh -> Connect dulu - persis keluhan aslinya.
console.log('\n--- 12. Auto-connect berkala: scan jalan walau belum connect ---');
ok(!/export async function poll\(\)\s*\{\s*if \(!connected\) return;/.test(bleSrc2),
  'poll() TIDAK lagi berhenti total saat !connected');
ok(/if \(userStopped\) return;/.test(bleSrc2),
  'poll() menghormati userStopped (user tekan Disconnect)');
ok(/if \(autoBusy\) return;/.test(bleSrc2),
  'poll() tidak menumpuk scan (autoBusy)');
ok(/const IDLE_SCAN_MS = \d+/.test(bleSrc2),
  'ada jeda minimum antar scan (IDLE_SCAN_MS) - scan BLE itu mahal');
ok(/now - lastIdleScanAt < IDLE_SCAN_MS/.test(bleSrc2),
  'jeda IDLE_SCAN_MS benar-benar dipakai');
ok(/await tryAutoConnect\(false\)/.test(bleSrc2),
  'poll() memanggil tryAutoConnect dengan verbose=false (log tenang)');
// Flag harus diset di connect() DAN disconnect().
ok(/userStopped = false/.test(bleSrc2), 'connect() melepas userStopped');
ok(/userStopped = true/.test(bleSrc2), 'disconnect(manual) menyetel userStopped');
ok(/export function isUserStopped\(\)/.test(bleSrc2),
  'backend BLE mengekspor isUserStopped()');
ok(/export function clearUserStopped\(\)/.test(bleSrc2),
  'backend BLE mengekspor clearUserStopped() (dipakai resume dari tray)');

// Serial harus punya kontrak yang SAMA - kalau tidak, koordinator di
// main.js tidak bisa melepas "user sengaja memutus" di kedua backend.
const serSrcAutoconn = fs.readFileSync(`${SRC}/../src/serial-transport.js`, 'utf8');
ok(/let userStopped = false/.test(serSrcAutoconn),
  'serial punya flag userStopped juga');
ok(/export function isUserStopped\(\)/.test(serSrcAutoconn),
  'serial mengekspor isUserStopped()');
ok(/export function clearUserStopped\(\)/.test(serSrcAutoconn),
  'serial mengekspor clearUserStopped()');

// Facade: clearUserStoppedBoth() wajib ada supaya main.js tidak menyentuh
// backend langsung.
ok(/export function clearUserStoppedBoth\(\)/.test(facadeSrc),
  'facade mengekspor clearUserStoppedBoth() untuk kedua backend');
ok(/serialBackend\.clearUserStopped\(\)/.test(facadeSrc),
  'clearUserStoppedBoth() menyentuh backend serial');

console.log(fail === 0
  ? '\nHASIL: backend BLE + facade berperilaku benar'
  : `\nHASIL: ${fail} masalah`);
try { fs.unlinkSync(`${process.cwd()}/tests/suites/.ble-core-stub.mjs`); } catch (e) { }
process.exit(fail === 0 ? 0 : 1);
