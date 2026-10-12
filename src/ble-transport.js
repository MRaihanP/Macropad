// ==================== TRANSPORT BLE ====================
//
// Backend kedua untuk facade transport.js. Memenuhi kontrak yang sama dengan
// serial-transport.js, jadi protocol-parser / adaptive / home-page / tray tidak
// perlu tahu device sedang/templates=BLE atau USB.
//
// Bedanya hanya di lapisan fisik:
//
//  serial            -> plugin SerialPort (port COM)
//  BLE               -> perintah Tauri ble_* (GATT, NUS di ESP32)
//
// Sisanya - framing baris, retry, ping, state framing dump - sengaja
// DITIRU DARI PUNYAI sendirinya, bukan diekspor ulang dari serial-transport.js.
// Kalau satu diimpor dari yang lain, backend BLE tidak akan punya framing saat
// module itu di-tree-shake atau saat serial gagal import, dan duaSalinan logika
// framing bisa mulai berbeda satu sama lain - persis yang terjadi pada versi
// pertama file ini.
//
// Batasan yang harus dijaga (sama seperti serial-transport.js):
//  - Buffer baris berbatas. Device yang tidak pernah mengirim newline akan
//    menumpuk data tanpa henti selama sesi.
//  - Jangan menebak nama field dari invoke(). Perintah ble_scan mengembalikan
//    JSON dengan key snake_case (is_paired, bukan isPaired) - versi pertama
//    file ini memetakan is_paired ke isPaired sehingga pasangan selalu
//    undefined tanpa error apa pun yang terlihat.

import { invoke } from "@tauri-apps/api/core";
import { el, log } from './dom.js';
import { t } from './i18n.js';

const LAST_DEVICE_KEY = 'macropad.lastBleDevice';
const LINE_BUFFER_MAX = 64 * 1024;
const PING_MS = 1500;
// Batas per write. Characteristic NUS hanya 512 byte; menulis lebih dari itu
// di-potong diam-diam oleh stack dan menyisakan separuh baris di device.
const WRITE_CHUNK_MAX = 400;
// Tarikan per panggilan ble_read. Rust clamps ke 1..4096, jadi nilai di sini
// cukup besar untuk membaca buffer 256 KiB dalam beberapa iterasi poll.
const READ_CHUNK_MAX = 4096;

// Seberapa sering buffer BLE ditarik.
//
// PENTING: ini harus jauh lebih cepat dari poll koneksi serial (2 detik).
// Serial menerima byte lewat port.read() yang dipanggil tiap loop - data
// sampai dalam hitungan milidetik. lewat BLE, data mendarat di buffer Rust
// lalu HARUS ditarik; tidak ada yang memanggilnya otomatis. Kalau jeda 2
// detik, satu dump 9 tombol yang dikirim dalam ~100 ms baru selesai dibaca
// 2 detik kemudian, dan jawaban INFO pun telat 2 detik - aplikasi terasa
// macet padahal device sebenarnya sehat.
//
// 40 ms memberi latensi di bawah yang bisa dirasakan manusia (~25 Hz) dengan
// overhead invoke() yang masih ringan (satu round-trip IPC ke thread BLE).
const READ_POLL_MS = 40;

// Batas tunggu sebelum dianggap dump menggantung. DUMP untuk 3x3 hanya ~10 baris
// dan dikirim dalam hitungan milidetik, jadi 2 detik sudah sangat longgar - cukup
// untuk device lambat tanpa membuat user menunggu lama tanpa penjelasan.
const DUMP_STUCK_MS = 2000;

// ---- State koneksi ----
let deviceId = null;
let lastGoodDeviceId = null;
try { lastGoodDeviceId = localStorage.getItem(LAST_DEVICE_KEY); } catch (e) { }
let connected = false;
let deviceWasLost = false;
let autoReconnect = true;   // false setelah user menekan Disconnect sendiri
let autoBusy = false;
let pingTimer = null;
let retryTimer = null;

// ---- State framing (milik backend ini) ----
let lineBuffer = '';
// Penanda terakhir ada byte yang masuk dari device. Dipakai afterConnectHandshake
// untuk membedakan "write gagal" dari "write sukses tapi device diam".
let seenResponseAt = 0;
// Watchdog dump:-armed saat isi dump terlihat, dibatalkan saat DUMP_END/NAMES_END
// datang. Kalau tembak, berarti penutup dump hilang di tengah jalan - dan itu
// kondisi paling damaging karena diam-diam berlaku ke semua baris berikutnya.
let dumpWatchdogTimer = null;

function cancelDumpWatchdog() {
  if (dumpWatchdogTimer) clearTimeout(dumpWatchdogTimer);
  dumpWatchdogTimer = null;
}

function armDumpWatchdog() {
  // Jangan arm ulang berkali-kali: setiap baris isi dump akan memicu
  // handleIncomingChunk, dan timer yang di-reset terus tidak akan pernah
  //cemic tembak walau penutupnya benar-benar hilang.
  if (dumpWatchdogTimer) return;
  dumpWatchdogTimer = setTimeout(() => {
    dumpWatchdogTimer = null;
    // Kondisi ini SANGAT sulit ditandai dari log biasa: app connect, GATT
    // sehat, notify jalan - tapi tidak satu baris pun ter-render karena
    // parser menganggap semua respons sebagai isi dump.
    log(t('ble.dumpStuck'), 'err');
    // Buka diri supaya baris berikutnya bisa diparse lagi. Tanpa ini parser
    // akan menolak HWINFO/BATT/EVT selamanya sampai app ditutup.
    resetParserState();
    lineBuffer = '';
    hooks.onDumpStuck();
  }, DUMP_STUCK_MS);
}
export let dumpInProgress = false, dumpEncInProgress = false, namesInProgress = false;
// Device yang baru connect boleh mengirim event sisa (EVT:APP:) sebelum user
// sempat conscious. Waited mirror of serial-transport.js.
let suppressEventsUntil = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Hook ke main.js (dipasang lewat facade transport.js) ----
let hooks = {
  onLine: () => { },
  onConnected: () => { },
  onDisconnected: () => { },
  onDeviceLost: () => { },
  onAutoConnectOk: () => { },
  onAutoConnectFail: () => { },
  onDumpStuck: () => { },
  notify: () => { },
  clearDirty: () => { },
};

export function initTransport(h) { hooks = Object.assign({}, hooks, h); }

// ---- Buffer baris ----
export function resetParserState() {
  lineBuffer = '';
  dumpInProgress = false;
  dumpEncInProgress = false;
  namesInProgress = false;
  cancelDumpWatchdog();
}
export function setDumpInProgress(v) { dumpInProgress = v; }
export function setDumpEncInProgress(v) { dumpEncInProgress = v; }
export function setNamesInProgress(v) { namesInProgress = v; }
export function eventsSuppressed() { return Date.now() < suppressEventsUntil; }

// ---- Status ----
export const isConnected = () => connected;
export const isAutoBusy = () => autoBusy;
export const portPath = null;   // tidak ada path; device diidentifikasi lewat id
export function enableAutoReconnect() { autoReconnect = true; }

export function handleIncomingChunk(data) {
  lineBuffer += data;
  // Urutan penting: resetParserState() mengosongkan lineBuffer, jadi harus
  // dipanggil SETELAH lastIndexOf - kalau dibalik, nl selalu -1 dan baris utuh
  // terakhir ikut terbuang.
  if (lineBuffer.length > LINE_BUFFER_MAX) {
    log(t('transport.lineTooLong', { max: LINE_BUFFER_MAX }), 'err');
    const nl = lineBuffer.lastIndexOf('\n');
    const tail = nl >= 0 ? lineBuffer.slice(nl + 1) : '';
    resetParserState();
    lineBuffer = tail;
  }
  // Penutup dump yang sehat membatalkan watchdog.
  if (lineBuffer.indexOf('DUMP_END') >= 0 || lineBuffer.indexOf('ENC_END') >= 0 ||
      lineBuffer.indexOf('NAMES_END') >= 0) cancelDumpWatchdog();
  let idx;
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    hooks.onLine(lineBuffer.slice(0, idx));
    lineBuffer = lineBuffer.slice(idx + 1);
  }
  // Jaring pengaman untuk dump yang menggantung. Kalau DUMP_BEGIN sampai tapi
  // DUMP_END tidak pernah datang, flag dumpInProgress tidak pernah turun dan
  // SEMUA baris sesudahnya (HWINFO, BATT, EVT:*) dianggap "isi dump" lalu
  // ditolak satu per satu - gejalanya app connect tapi tidak pernah menampilkan
  // apa-apa, tanpa error lain. Deteksi diam-diam seperti itu hampir mustahil
  // ditebak dari log panel.
  //
  // Syaratnya sengaja longgar: DUMP_BEGIN + >=1 baris isi sudah cukup. Dipakai
  // juga untuk DUMPNAMES, yang penandanya NAMES_BEGIN/NAMES_END.
  // Perhatikan: di backend ini dumpInProgress itu VARIABEL (export let), bukan
// fungsi seperti di facade transport.js. facade mengekspornya sebagai getter
// supaya bisa/backend berganti; backend sendiri menyimpan nilainya langsung.
if (dumpInProgress && /\d,\d,\d/.test(lineBuffer)) armDumpWatchdog();
}

// ---- Pengiriman ----
async function writeRaw(str) {
  if (!connected) return;
  try {
    await invoke('ble_write', { data: Array.from(new TextEncoder().encode(str)) });
  } catch (e) {
    log(t('ble.writeError', { err: e }), 'err');
    await handleDeviceLost();
  }
}

export async function sendLine(str) {
  if (!connected) return;
  try {
    await invoke('ble_write', { data: Array.from(new TextEncoder().encode(str + '\n')) });
  } catch (e) {
    log(t('ble.writeError', { err: e }), 'err');
    // Tulis gagal = koneksi sudah putus; jangan tunggu polling 2 detik.
    await handleDeviceLost();
  }
}

// Kirim banyak baris dalam sedikit write, dipecah agar tidak melewati batas
// characteristic NUS. Versi pertama file ini memanggil writeRaw() dengan
// payload yang sudah dipotong ke 900 byte - angka itu untuk port serial dan
// melewati batas NUS.
export async function sendBatch(lines) {
  if (!connected) return;
  let chunk = '';
  const flush = async () => { if (chunk) { await writeRaw(chunk); chunk = ''; } };
  for (const ln of lines) {
    if (chunk.length + ln.length + 1 > WRITE_CHUNK_MAX) await flush();
    chunk += ln + '\n';
  }
  await flush();
}

// ---- Scan ----
export async function scan() {
  try {
    const devices = await invoke('ble_scan');
    if (!Array.isArray(devices)) return [];
    return devices.map(d => ({
      // snake_case dari Rust - jangan diubah jadi camelCase, ini yang bikin
      // pasangan selalu undefined di versi pertama.
      id: d.id,
      name: d.name || 'MacroPad',
      isPaired: !!d.is_paired,
    }));
  } catch (e) {
    log(t('ble.scanError', { err: e }), 'err');
    return [];
  }
}

export async function scanAndUpdateSelect() {
  const devices = await scan();
  // Log panel app, bukan hanya stderr Rust. User tidak pernah melihat stderr;
  // tanpa baris ini, "scan tidak menemukan apa pun" di panel log sama sekali
  // tidak bisa dibedakan dari "app belum pernah memanggil scan".
  log(devices.length === 0
    ? t('ble.traceNone')
    : t('ble.traceFound', { count: devices.length, names: devices.map(d => d.name).join(', ') }));
  const sel = el('bleDeviceSelect');
  if (!sel) return devices;
  const keep = sel.value;
  sel.innerHTML = '';
  devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name + (d.isPaired ? ' (paired)' : '');
    sel.appendChild(opt);
  });
  if (keep && devices.some(d => d.id === keep)) sel.value = keep;
  return devices;
}

// ---- Connect / disconnect ----
// Urutan init setelah connect sengaja MENYAMAI serial-transport.js persis:
// WHOAMI/HWINFO dulu (profile + knob + penanda simulasi), LAYER:0 sebelum INFO
// (firmware menyimpan currentLayer di flash, jadi device bisa boot di layer 4 -
// INFO dulu akan sempat memuat layer yang salah), lalu dump encoder, baterai, RGB.
async function afterConnectHandshake() {
  setTimeout(async () => {
    log(t('ble.traceHandshake'));
    await sendLine('WHOAMI');
    await sendLine('HWINFO');
    await sendLine('LAYER:0');
    await sendLine('INFO');
    await sendLine('DUMPENC');
    await sendLine('BATT');
    await sendLine('RGB:DUMP');
    // Batas waktu. Kalau device tidak menjawab dalam 6 detik, tunjukkan di log
    // bahwa write BERHASIL tapi jawabannya tidak pernah datang - itu bukti
    // masalah ada di sisi device/subscribe, bukan di pengiriman perintah.
    const deadline = Date.now() + 6000;
    const before = seenResponseAt;
    const watch = setInterval(() => {
      if (seenResponseAt !== before) { clearInterval(watch); return; }
      if (Date.now() < deadline) return;
      clearInterval(watch);
      log(t('ble.traceSilent'), 'err');
    }, 250);
  }, 400);
}

export async function connect(deviceIdArg) {
  const sel = el('bleDeviceSelect');
  const id = deviceIdArg || (sel ? sel.value : null);
  if (!id) { log(t('ble.pickDevice'), 'err'); return false; }
  try {
    await invoke('ble_connect', { id });
  } catch (e) {
    log(t('ble.connectError', { err: e }), 'err');
    return false;
  }
  log(t('ble.traceConnected', { id }));
  connected = true;
  deviceId = id;
  lastGoodDeviceId = id;
  clearTimeout(retryTimer);
  try { localStorage.setItem(LAST_DEVICE_KEY, id); } catch (e) { }
  hooks.onConnected();
  deviceWasLost = false;
  startPing();
  // Loop pembacaan harus hidup SEBELUM handshake, bukan sesudahnya. Handshake
  // mengirim WHOAMI dalam 400 ms, dan jawabannya perlu langsung ditarik -
  // kalau loop belum jalan, jawaban itu menunggu sampai poll 2 detik berikutnya.
  startReadLoop();
  // Tampilkan UI utama. Tanpa ini, #app (dan panel log di dalamnya) tetap
  // tersembunyi di mode BLE walau GATT sudah tersambung - user melihat
  // aplikasi yang masih kosong padahal sebenarnya sudah connect.
  setConnected(true);
  suppressEventsUntil = Date.now() + 800;
  await sendLine('PING');
  await afterConnectHandshake();
  return true;
}

export async function disconnect(manual) {
  // Tanpa guard ini, disconnect() yang dipanggil saat device BELUM pernah
  // tersambung tetap menjalankan seluruh ekor: mematikan autoReconnect,
  // mengirim notifikasi "terputus" yang tidak benar, dan memunculkan error
  // "BLE tidak terhubung" yang menyesatkan.
  //
  // Yang memancingnya adalah setTransportBackend() di facade, yang memutus
  // backend LAMA setiap kali selector transport berubah - termasuk saat
  // berubah dari USB ke BLE, di mana BLE memang belum pernah tersambung.
  if (!connected) {
    if (manual) autoReconnect = false;
    return;
  }
  if (manual) {
    autoReconnect = false;
    deviceWasLost = false;
    hooks.notify(t('ble.notifDisconnected'), 'disconnect');
    log(t('ble.autoPausedLog'));
  }
  stopPing();
  // Loop pembacaan WAJIB ikut dimatikan di setiap jalur keluar. Kalau tidak,
  // interval tetap berjalan dan menarik buffer dari koneksi yang sudah tutup -
  // memunculkan "GATT tidak terhubung" berulang padahal user sudah disconnect.
  stopReadLoop();
  // Parser ikut dibersihkan di jalur manual juga: tanpa ini baris parsial dari
  // sesi lama menempel pada byte pertama device berikutnya.
  resetParserState();
  try { await invoke('ble_disconnect'); } catch (e) { log(t('ble.disconnectError', { err: e }), 'err'); }
  connected = false;
  deviceId = null;
  hooks.onDeviceLost();
  setConnected(false);
}

// Device hilang tanpa userDisconnect: bersihkan total lalu coba lagi kalau
// auto-reconnect masih nyala.
export async function handleDeviceLost() {
  if (!connected) return;
  log(t('transport.deviceLostLog'), 'err');
  deviceWasLost = true;
  const wasId = deviceId || lastGoodDeviceId;
  connected = false;
  deviceId = null;
  hooks.notify(t('transport.notifDeviceLost'), 'disconnect');
  hooks.clearDirty();   // RAM device hilang; tidak ada yang tertunda untuk di-save
  resetParserState();
  hooks.onDeviceLost();
  stopPing();
  stopReadLoop();
  setConnected(false);
  if (autoReconnect && wasId) scheduleRetry([wasId]);
}

// ---- Auto-connect / retry ----
const RETRY_MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 2500;
const RETRY_MAX_MS = 20000;
const retryDelay = (n) => Math.min(RETRY_BASE_MS * n, RETRY_MAX_MS);

export function scheduleRetry(only, attempt = 1) {
  clearTimeout(retryTimer);
  if (attempt > RETRY_MAX_ATTEMPTS) return;
  retryTimer = setTimeout(async () => {
    if (connected || !autoReconnect) return;
    const targets = only && only.length ? only : (lastGoodDeviceId ? [lastGoodDeviceId] : null);
    const ok = await tryAutoConnect(false, targets);
    if (!ok) scheduleRetry(only, attempt + 1);
  }, retryDelay(attempt));
}

export async function tryAutoConnect(verbose, only) {
  if (autoBusy || connected) return false;
  autoBusy = true;
  try {
    const devices = await scan();
    if (devices.length === 0) { if (verbose) log(t('ble.noDevices'), 'err'); return false; }
    let targets = devices;
    if (only && only.length) targets = devices.filter(d => only.includes(d.id));
    if (targets.length === 0) return false;
    // Device terakhir yang berhasil selalu dicoba lebih dulu.
    targets = [...targets].sort((a, b) => (b.id === lastGoodDeviceId) - (a.id === lastGoodDeviceId));

    for (const d of targets) {
      if (await connect(d.id)) {
        log(t('ble.autoConnectOk', { name: d.name }), 'ok');
        hooks.onAutoConnectOk(d.id);
        return true;
      }
      // Jeda: Windows perlu melepas handle GATT sebelum connect ulang ke id yang sama.
      await sleep(400);
      if (await connect(d.id)) {
        log(t('transport.autoConnectOk2', { path: d.name }), 'ok');
        hooks.onAutoConnectOk(d.id);
        return true;
      }
    }
    if (verbose) { log(t('ble.autoNotFound'), 'err'); hooks.onAutoConnectFail(); }
    return false;
  } finally { autoBusy = false; }
}

export async function autoDetect() {
  autoReconnect = true;
  clearTimeout(retryTimer);
  if (connected) return;
  const ok = await tryAutoConnect(true);
  if (!ok && lastGoodDeviceId) scheduleRetry([lastGoodDeviceId]);
}

// Tarik data dari device. INI WAJIB ADA, bukan opsional.
//
// Data masuk lewat GATT notify: firmware memanggil bleNusRx->notify() ->
// handler di ble.rs menaruhnya di rx_buffer -> frontend WAJIB mengambilnya
// lewat ble_read. Kalau poll() hanya mengecek `ble_is_connected` tanpa menarik
// buffer, notify tetap masuk ke Rust tapi TIDAK PERNAH sampai ke handleLine(),
// dan companion app diam saja: tidak ada INFO, tidak ada preset, tidak ada
// apa pun. Gejalanya persis seperti "tidak menerima apa-apa dari device".
export async function readIncoming() {
  if (!connected) return 0;
  let got = 0;
  try {
    // Baca ulang sampai buffer kosong. Satu panggilan saja akan tertinggal
    // data kalau device mengirim lebih cepat dari satu iterasi poll.
    for (let i = 0; i < 4; i++) {
      const chunk = await invoke('ble_read', { maxLen: READ_CHUNK_MAX });
      if (!chunk || chunk.length === 0) break;
      // Tandai bahwa device MEMANG menjawab. afterConnectHandshake memakai
      // penanda ini untuk membedakan "write gagal" dari "write sukses tapi
      // device diam" - dua masalah yang sama sekali punya tindakan berbeda.
      seenResponseAt = Date.now();
      handleIncomingChunk(new TextDecoder().decode(Uint8Array.from(chunk)));
      got += chunk.length;
    }
  } catch (e) {
    // invoke gagal = GATT sudah turun. Perlakukan sebagai putus supaya
    // poll berikutnya tidak mencoba menarik data dari koneksi mati.
    log(t('ble.readError', { err: e }), 'err');
    await handleDeviceLost();
  }
  return got;
}

// Pantau status koneksi dari sisi Rust. Device bisa hilang tanpa memberi tahu
// (jarak, device mati), jadi harus dicek berkala seperti port serial.
export async function poll() {
  if (!connected) return;
  try {
    const stillUp = await invoke('ble_is_connected');
    if (!stillUp) { await handleDeviceLost(); return; }
    await readIncoming();
  } catch (e) {
    log(t('ble.pollError', { err: e }), 'err');
    await handleDeviceLost();
  }
}

// ---- Ping ----
export function startPing() {
  stopPing();
  pingTimer = setInterval(() => { if (connected) sendLine('PING'); }, PING_MS);
}

// ---- Loop pembacaan ----
// Terpisah dari poll() yang hanya dicek tiap 2 detik: poll itu untuk
// MEMANTAUK koneksi, sedangkan ini untuk MENARIK DATA. Menitipkan pembacaan
// ke poll() membuat seluruh UI berjalan dalam kelipatan 2 detik.
let readTimer = null;
let readBusy = false;

function startReadLoop() {
  stopReadLoop();
  readTimer = setInterval(async () => {
    // readBusy mencegah tumpang tindih: poll 40 ms lebih cepat daripada
    // respons invoke, jadi tanpa ini beberapa read bisa jalan bersamaan dan
    // merebut buffer satu sama lain (data hilang tanpa jejak).
    if (readBusy || !connected) return;
    readBusy = true;
    try { await readIncoming(); }
    finally { readBusy = false; }
  }, READ_POLL_MS);
}

function stopReadLoop() {
  if (readTimer) clearInterval(readTimer);
  readTimer = null;
}

// Ekspor untuk test; dipakai juga oleh disconnect().
export function stopAllBleTimers() { stopPing(); stopReadLoop(); }
export function stopPing() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; }

// ---- UI ----
export function updateConnectButton(state) {
  const btn = el('btnConnect');
  if (btn) btn.textContent = state ? t('transport.disconnect') : t('header.connect');
}

// Perbarui indikator di header DAN tampilkan UI utama.
//
// WAJIB ada di backend BLE, bukan hanya di serial-transport.js. #app (seluruh
// halaman aplikasi DAN panel log) disembunyikan lewat style.display, dan
// selama ini HANYA setConnected() di serial yang pernah mengubahnya. Backend
// BLE tidak pernah memanggilnya, jadi di mode BLE UI utama - termasuk panel
// log - tidak pernah muncul sama sekali. Akibatnya user tidak bisa melihat
// apa pun yang terjadi dan harus pindah ke USB untuk membaca log, padahal
// masalahnya justru sedang terjadi di BLE.
export function setConnected(state) {
  const dot = el('dot');
  if (dot) dot.classList.toggle('on', state);
  const st = el('statusText');
  if (st) st.textContent = state ? t('transport.connected') : t('transport.notConnected');
  updateConnectButton(state);
  const app = el('app');
  if (app) app.style.display = state ? 'block' : 'none';
  if (!state) hooks.onDisconnected();
}
