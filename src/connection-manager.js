// ==================== CONNECTION MANAGER ====================
//
// Titik sambung antara auto-connect-core.js (logika murni) dan transport
// sungguhan. Semua modul lain cukup memakai export di file ini; tidak perlu
// tahu apakah siklusnya sedang memprobe USB, BLE, atau sedang dijeda.
//
// Yang dijaga di sini:
//  - probing TIDAK mengaktifkan transport (backend baru diganti saat device
//    ditemukan), sehingga app tidak bolak-balik switch hanya untuk mencari.
//  - satu instance manager = satu pemilik retry. Backend tidak lagi menjalankan
//    auto-connect sendiri saat mode ini aktif.
//  - aksi manual (Connect/Disconnect/Refresh/pilih transport) menang atas loop.

import { log } from './dom.js';
import { t } from './i18n.js';
import {
  connect, isConnected, isAutoBusy, enableAutoReconnect,
  setTransportBackend, transportId, lastTransport, rememberTransport,
  probeUsbDevice, probeBleDevice, markUsbPortFailed, setManagerMode,
} from './transport.js';
import { createAutoConnectManager } from './auto-connect-core.js';

const manager = createAutoConnectManager({
  probeUsb: probeUsbDevice,
  probeBle: probeBleDevice,
  connect,
  isConnected,
  isAutoBusy,
  setTransportBackend,
  transportId,
  enableAutoReconnect,
  lastTransport,
  rememberTransport,
  markPortFailed: markUsbPortFailed,
  log,
  t,
});

// Manager mengambil alih auto-connect dari backend. Tanpa ini, pollPorts()
// USB dan scheduleRetry() backend bisa mencoba connect bersamaan dengan loop.
function takeOver() { setManagerMode(true); }

export function startAutoConnect(opts = {}) {
  takeOver();
  return manager.start(opts);
}

export function pauseAutoConnect() {
  manager.pause();
}

export function resumeAutoConnect() {
  takeOver();
  return manager.resume();
}

export function stopAutoConnect() {
  manager.stop();
  setManagerMode(false);
}

export function setPreferredTransport(id) { manager.setPreferred(id); }
export function getPreferredTransport() { return manager.getPreferred(); }
export function isAutoConnectPaused() { return manager.isPaused(); }
export function isAutoConnectBusy() { return manager.isBusy(); }
