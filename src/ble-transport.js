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
  let idx;
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    hooks.onLine(lineBuffer.slice(0, idx));
    lineBuffer = lineBuffer.slice(idx + 1);
  }
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
    await sendLine('WHOAMI');
    await sendLine('HWINFO');
    await sendLine('LAYER:0');
    await sendLine('INFO');
    await sendLine('DUMPENC');
    await sendLine('BATT');
    await sendLine('RGB:DUMP');
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
  connected = true;
  deviceId = id;
  lastGoodDeviceId = id;
  clearTimeout(retryTimer);
  try { localStorage.setItem(LAST_DEVICE_KEY, id); } catch (e) { }
  hooks.onConnected();
  deviceWasLost = false;
  startPing();
  suppressEventsUntil = Date.now() + 800;
  await sendLine('PING');
  await afterConnectHandshake();
  return true;
}

export async function disconnect(manual) {
  if (manual) {
    autoReconnect = false;
    deviceWasLost = false;
    hooks.notify(t('ble.notifDisconnected'), 'disconnect');
    log(t('ble.autoPausedLog'));
  }
  stopPing();
  // Parser ikut dibersihkan di jalur manual juga: tanpa ini baris parsial dari
  // sesi lama menempel pada byte pertama device berikutnya.
  resetParserState();
  try { await invoke('ble_disconnect'); } catch (e) { log(t('ble.disconnectError', { err: e }), 'err'); }
  connected = false;
  deviceId = null;
  hooks.onDeviceLost();
  hooks.onDisconnected();
  updateConnectButton(false);
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
  hooks.onDisconnected();
  stopPing();
  updateConnectButton(false);
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

// Pantau status koneksi dari sisi Rust. bledevices bisa hilang tanpa Notifikasi
// (jarak, device mati), jadi harus dicek berkala seperti port serial.
export async function poll() {
  if (!connected) return;
  try {
    const stillUp = await invoke('ble_is_connected');
    if (!stillUp) await handleDeviceLost();
  } catch (e) { /* invoke gagal = Perlakukan sebagai putus, bukan diamkan */ await handleDeviceLost(); }
}

// ---- Ping ----
export function startPing() {
  stopPing();
  pingTimer = setInterval(() => { if (connected) sendLine('PING'); }, PING_MS);
}
export function stopPing() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; }

// ---- UI ----
export function updateConnectButton(state) {
  const btn = el('btnConnect');
  if (btn) btn.textContent = state ? t('transport.disconnect') : t('header.connect');
}
