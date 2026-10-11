// Menguji src/serial-transport.js tanpa hardware serial.
//
// Modul diimpor dengan stub SerialPort sehingga alur connect/disconnect/reconnect,
// pelepasan listener, framing baris, dan batas buffer bisa diperiksa. Stub dipasang
// lewat registerHooks() sehingga tidak ada berkas sumber yang perlu diubah.
//
// Jalankan: node serial-transport-test.mjs
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { SRC, SRC_URL, STUB_DIR } from '../runner/paths.mjs';
import { pathToFileURL } from 'node:url';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (ditemukan ${JSON.stringify(a)}, diharapkan ${JSON.stringify(b)})`);

// Dua bentuk path, masing-masing untuk keperluan berbeda:
//   SRC_URL -> import() dinamis (WAJIB file:// URL)
//   SRC     -> fs.readFileSync (WAJIB path filesystem, tanpa prefix file:///)
const STUB = pathToFileURL(`${STUB_DIR}/tauri-serial-stub.mjs`).href;

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
globalThis.confirm = () => true;

// ---- Stub plugin serial ----
globalThis.__SerialStub = { instances: [], openShouldFail: false, availablePorts: [] };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'tauri-plugin-serialplugin') return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const T = await import(`${SRC_URL}/serial-transport.js`);
const S = globalThis.__SerialStub;

// ---- Hook rekaman ----
let lines = [];
let ev;
const resetEv = () => { ev = { connected: 0, disconnected: 0, deviceLost: 0, clearDirty: 0, notify: [] }; };
resetEv();

T.initTransport({
  onLine: (l) => lines.push(l),
  onConnected: () => { ev.connected++; },
  onDisconnected: () => { ev.disconnected++; },
  onDeviceLost: () => { ev.deviceLost++; },
  clearDirty: () => { ev.clearDirty++; },
  notify: (txt, kind) => { ev.notify.push(`${kind}:${txt}`); },
});

const connectOk = async (path = 'COM7') => { S.openShouldFail = false; return T.connect(path); };

console.log('--- 1. main.js tidak lagi menyimpan urusan transport ---');
const mainSrc = fs.readFileSync(`${SRC}/main.js`, 'utf8');
for (const sym of ['listPortPaths', 'refreshPorts', 'probeWhoAmI', 'tryAutoConnect', 'scheduleRetry', 'autoDetect', 'handleDeviceLost', 'pollPorts', 'startPing', 'stopPing', 'setConnected', 'handleIncomingChunk', 'writeRaw', 'sendLine', 'sendBatch', 'connect', 'disconnect']) {
  ok(!new RegExp(`^(async )?function ${sym}\\b`, 'm').test(mainSrc), `${sym} tidak lagi didefinisikan di main.js`);
}
ok(!/^(let|const) port\b/m.test(mainSrc), 'objek port tidak lagi dideklarasikan di main.js');
ok(!/^(let|const) deviceWasLost\b/m.test(mainSrc), 'deviceWasLost tidak lagi dideklarasikan di main.js');
ok(/from "\.\/serial-transport\.js"/.test(mainSrc), 'main.js meng-import serial-transport.js');
ok(/initTransport\(\{/.test(mainSrc), 'initTransport() dipanggil dengan hook');
ok(/onLine: \(line\) => handleLine\(line\)/.test(mainSrc), 'baris device diarahkan ke handleLine');
ok(/\bisConnected\(\)/.test(mainSrc), 'main.js memakai isConnected() alih-alih variabel port');

console.log('\n--- 2. connect() membuka port dan mengirim urutan handshake ---');
resetEv(); S.instances.length = 0; lines = [];
ok(await connectOk('COM7') === true, 'connect() mengembalikan true');
const p = S.instances[S.instances.length - 1];
ok(p.opts.path === 'COM7', `path dipakai apa adanya (${p.opts.path})`);
ok(p.opts.baudRate === 115200, `baud 115200 (${p.opts.baudRate})`);
eq(ev.connected, 1, 'hook onConnected dipanggil sekali');
await new Promise(r => setTimeout(r, 600)); // tunggu setTimeout handshake 400ms
const sent = p.written.join('');
ok(sent.includes('PING\n'), 'PING dikirim');
for (const cmd of ['WHOAMI', 'HWINFO', 'INFO', 'DUMPENC', 'BATT', 'RGB:DUMP']) ok(sent.includes(`${cmd}\n`), `${cmd} dikirim pada handshake`);
eq(p.listenerCount, 1, `port punya tepat 1 listener (${p.listenerCount})`);

console.log('\n--- 3. framing baris: potongan, baris penuh, baris kosong ---');
lines = [];
p.feed('INFO:rows=3\n');
p.feed('HWINFO:profile=Pro');
p.feed('totype\n');
p.feed('PING\n\n');
eq(lines, ['INFO:rows=3', 'HWINFO:profile=Prototype', 'PING', ''], 'baris dipisah newline, termasuk baris kosong');

console.log('\n--- 4. transport meneruskan baris mentah, tidak mengurai isi ---');
ok(lines.every(l => typeof l === 'string'), 'onLine menerima string mentah, bukan objek hasil parse');

console.log('\n--- 5. disconnect() menutup port dan melepas listener ---');
resetEv();
await T.disconnect(false);
eq(p.listenerCount, 0, 'semua listener dilepas');
ok(p.closed === true, 'port ditutup');
eq(ev.disconnected, 1, 'hook onDisconnected dipanggil sekali');
eq(ev.deviceLost, 1, 'hook onDeviceLost (adaptive + editor) dipanggil');
eq(ev.clearDirty, 0, 'disconnect manual TIDAK clearDirty (RAM device masih tersimpan di device)');

console.log('\n--- 6. handleDeviceLost() menandai device hilang dan clearDirty ---');
resetEv(); S.instances.length = 0; lines = [];
ok(await connectOk('COM3') === true, 'reconnect untuk uji device hilang');
const q = S.instances[S.instances.length - 1];
q.feed('INFO:rows=3\n');
await T.handleDeviceLost();
eq(ev.clearDirty, 1, 'device hilang: clearDirty dipanggil (isi RAM device ikut hilang)');
eq(ev.deviceLost, 1, 'device hilang: hook onDeviceLost dipanggil');
eq(ev.disconnected, 1, 'device hilang: hook onDisconnected dipanggil');
eq(T.isConnected(), false, 'isConnected() false setelah kehilangan');
eq(T.deviceWasLost, true, 'deviceWasLost true untuk notifikasi "Terhubung kembali"');
ok(q.closed === true, 'port lama ditutup');

console.log('\n--- 7. reconnect menandai device tidak hilang lagi ---');
resetEv(); S.instances.length = 0;
await connectOk();
eq(T.deviceWasLost, false, 'deviceWasLost false setelah connect sukses');

console.log('\n--- 8. connect() gagal saat port terkunci: tidak ada state setengah jadi ---');
resetEv(); S.instances.length = 0;
S.openShouldFail = true;
ok(await T.connect('COM9') === false, 'connect() mengembalikan false saat gagal');
eq(T.isConnected(), false, 'tidak ada port yang dianggap terhubung');
eq(ev.connected, 0, 'hook onConnected TIDAK dipanggil');
S.openShouldFail = false;

console.log('\n--- 9. resetParserState() membersihkan flag framing ---');
T.setDumpInProgress(true); T.setDumpEncInProgress(true); T.setNamesInProgress(true);
eq(T.dumpInProgress, true, 'flag dump aktif');
T.resetParserState();
eq([T.dumpInProgress, T.dumpEncInProgress, T.namesInProgress], [false, false, false], 'semua flag framing di-reset');

console.log('\n--- 10. eventsSuppressed() mengembalikan boolean ---');
ok(typeof T.eventsSuppressed() === 'boolean', 'eventsSuppressed() mengembalikan boolean');

console.log('\n--- 11. sendLine/sendBatch tanpa koneksi tidak melempar error ---');
await T.disconnect(true);
let threw = false;
try { await T.sendLine('PING'); await T.sendBatch(['A', 'B']); } catch (e) { threw = true; }
ok(!threw, 'pemanggil tidak perlu cek koneksi sebelum mengirim');

console.log(`\n${fail === 0 ? 'HASIL: serial-transport.js berperilaku benar' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);