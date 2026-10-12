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

console.log(fail === 0
  ? '\nHASIL: backend BLE + facade berperilaku benar'
  : `\nHASIL: ${fail} masalah`);
try { fs.unlinkSync(`${process.cwd()}/tests/suites/.ble-core-stub.mjs`); } catch (e) { }
process.exit(fail === 0 ? 0 : 1);
