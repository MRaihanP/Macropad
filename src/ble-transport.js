// ==================== BLE TRANSPORT (Tauri BLE) ====================
//
// Mirrors serial-transport.js but uses Tauri BLE commands.
// Transport doesn't know about command meanings - just line framing and
// connection management. All protocol logic is in main.js via hooks.
//
// Key differences from serial:
// - Uses Tauri ble_* commands instead of SerialPort
// - Connection identified by device ID (not path)
// - Notifications subscribed on connect (RX characteristic)
// - Write uses ble_write (with chunking for large payloads)
// - Read uses ble_read bulk (not per-byte)

import { invoke } from "@tauri-apps/api/core";
import { el, log } from './dom.js';
import { t } from './i18n.js';

const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_READ_CHUNK = 4096;
const LINE_BUFFER_MAX = 64 * 1024;
const LAST_DEVICE_KEY = 'macropad.lastBleDevice';

// ---- State koneksi ----
let deviceId = null;
let deviceName = null;
let isConnected = false;
let lineBuffer = '';
let dumpInProgress = false;
let dumpEncInProgress = false;
let namesInProgress = false;
let suppressEventsUntil = 0;
let pingTimer = null;
let retryTimer = null;
let autoReconnect = true;
let autoBusy = false;
let pollBusy = false;
let deviceWasLost = false;

// Port-like tracking for retry logic
let lastGoodDeviceId = null;
try { lastGoodDeviceId = localStorage.getItem(LAST_DEVICE_KEY); } catch (e) { }

// ---- Hooks ke main.js ----
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

export function initBleTransport(h) { hooks = Object.assign({}, hooks, h); }
export { initBleTransport as initTransport };

// ---- Buffer baris (reused from serial) ----
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
export const isBleConnected = () => isConnected;

// Dipakai tombol Connect di main.js.js
export const isAutoBusy = () => autoBusy;
export function enableAutoReconnect() { autoReconnect = true; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Buffer baris (reused from serial) ----
export function handleIncomingChunk(data) {
  lineBuffer += data;
  if (lineBuffer.length > LINE_BUFFER_MAX) {
    log(t('transport.lineTooLong', { max: LINE_BUFFER_MAX }), 'err');
    resetParserState();
    const nl = lineBuffer.lastIndexOf('\n');
    lineBuffer = nl >= 0 ? lineBuffer.slice(nl + 1) : '';
  }
  let idx;
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    hooks.onLine(lineBuffer.slice(0, idx));
    lineBuffer = lineBuffer.slice(idx + 1);
  }
}

// ---- Scan / Connect ----
export async function scan() {
  try {
    const devices = await invoke('ble_scan');
    return devices.map(d => ({
      id: d.id,
      name: d.name || 'MacroPad',
      isPaired: d.is_paired,
    }));
  } catch (e) {
    log(t('ble.scanError', { err: e }), 'err');
    return [];
  }
}

export async function connect(deviceIdArg) {
  const id = deviceIdArg || el('bleDeviceSelect')?.value;
  if (!id) { log(t('ble.pickDevice'), 'err'); return false; }

  try {
    await invoke('ble_connect', { id });
    isConnected = true;
    deviceId = id;
    if (hooks.onConnected) hooks.onConnected();
    startPing();
    return true;
  } catch (e) {
    log(t('ble.connectError', { err: e }), 'err');
    return false;
  }
}

export async function disconnect(manual) {
  if (manual) {
    autoReconnect = false;
    hooks.notify(t('ble.notifDisconnected'), 'disconnect');
    log(t('ble.autoPausedLog'));
  }
  stopPing();
  resetParserState();
  try {
    await invoke('ble_disconnect');
  } catch (e) {
    log(t('ble.disconnectError', { err: e }), 'err');
  }
  isConnected = false;
  deviceId = null;
  if (hooks.onDisconnected) hooks.onDisconnected();
}

export async function handleDeviceLost() {
  if (!isConnected) return;
  log(t('ble.deviceLostLog'), 'err');
  isConnected = false;
  deviceId = null;
  hooks.notify(t('ble.notifDeviceLost'), 'disconnect');
  resetParserState();
  hooks.onDeviceLost();
  stopPing();
  setConnected(false);
  if (autoReconnect && lastGoodDeviceId) {
    scheduleRetry([lastGoodDeviceId]);
  }
}

// ---- Ping ----
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (isConnected) sendLine('PING');
  }, 2000);
}
function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

// ---- Send / Receive ----
async function writeRaw(str) {
  try {
    await invoke('ble_write', { data: new TextEncoder().encode(str) });
  } catch (e) {
    log(t('ble.writeError', { err: e }), 'err');
    await handleDeviceLost();
  }
}

export async function sendLine(str) {
  if (!isConnected) return;
  try {
    await invoke('ble_write', { data: new TextEncoder().encode(str + "\n") });
  } catch (e) {
    log(t('ble.writeError', { err: e }), 'err');
    await handleDeviceLost();
  }
}

export async function sendBatch(lines) {
  if (!isConnected) return;
  let chunk = '';
  for (const ln of lines) {
    if (chunk.length + ln.length + 1 > 900) { await writeRaw(chunk); chunk = ''; }
    chunk += ln + '\n';
  }
  if (chunk) await writeRaw(chunk);
}

// Receive handled by notification callback in Rust (ble.rs)
// ble_read bulk is available but we use push notifications

// ---- Scan / Connect UI ----
export async function scanAndUpdateSelect() {
  try {
    const devices = await scan();
    const sel = el('bleDeviceSelect');
    const keep = sel.value;
    sel.innerHTML = '';
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + (d.isPaired ? ' (paired)' : '');
      sel.appendChild(opt);
    });
    if (keep && devices.some(d => d.id === keep)) sel.value = keep;
    if (devices.length === 0) log(t('ble.noDevices'), 'err');
    return devices;
  } catch (e) {
    log(t('ble.scanError', { err: e }), 'err');
    return [];
  }
}

// ---- Auto-reconnect / Retry ----
const RETRY_MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 2500;
const RETRY_MAX_MS = 20000;

function retryDelay(attempt) {
  return Math.min(RETRY_BASE_MS * attempt, RETRY_MAX_MS);
}

function scheduleRetry(only, attempt = 1) {
  if (attempt > RETRY_MAX_ATTEMPTS) return;
  const delay = retryDelay(attempt);
  retryTimer = setTimeout(async () => {
    const ok = await connect(only ? only[0] : null);
    if (!ok) scheduleRetry(only, attempt + 1);
  }, delay);
}

export async function autoDetect() {
  if (autoBusy || isConnected) return false;
  autoBusy = true;
  try {
    const devices = await scan();
    if (devices.length === 0) { log(t('ble.noDevices'), 'err'); return false; }
    const ordered = [...devices].sort((a, b) => (b.id === lastGoodDeviceId) - (a.id === lastGoodDeviceId));
    for (const d of ordered) {
      if (await connect(d.id)) {
        log(t('ble.autoConnectOk', { name: d.name }), 'ok');
        hooks.onAutoConnectOk(d.id);
        return true;
      }
      await sleep(400);
      if (await connect(d.id)) {
        log(t('ble.autoConnectOk2', { name: d.name }), 'ok');
        hooks.onAutoConnectOk(d.id);
        return true;
      }
    }
    log(t('ble.autoNotFound'), 'err');
    hooks.onAutoConnectFail();
    return false;
  } finally { autoBusy = false; }
}

export async function pollBle() {
  if (pollBusy || isConnected) return;
  pollBusy = true;
  try {
    const connected = await invoke('ble_is_connected');
    if (!connected && isConnected) {
      await handleDeviceLost();
    }
  } catch (e) {
    log(t('ble.pollError', { err: e }), 'err');
  } finally {
    pollBusy = false;
  }
}

// ---- Connection state helpers ----
function setConnected(state) {
  isConnected = state;
  el('bleDot').classList.toggle('on', state);
  el('bleStatusText').textContent = state ? t('ble.connected') : t('ble.notConnected');
  updateConnectButton(state);
  if (!state) hooks.onDisconnected();
}

export function updateConnectButton(state) {
  el('bleConnectBtn').textContent = state ? t('ble.disconnect') : t('ble.connect');
}

// Aliased exports for main.js compatibility
export { sendLine as sendLineBle, sendBatch as sendBatchBle };
export { connect as connectBle, disconnect as disconnectBle };
export { isAutoBusy as isBleAutoBusy };
export { enableAutoReconnect as enableBleAutoReconnect };
export { deviceWasLost as bleDeviceWasLost };
export { updateConnectButton as updateBleConnectButton };