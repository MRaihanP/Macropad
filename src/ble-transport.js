// ==================== BLE TRANSPORT (JavaScript) ====================
//
// Wrapper untuk Tauri BLE commands. Mirip serial-transport.js tapi
// berbicara lewat Tauri commands (ble_scan, ble_connect, dll).
//
// Transport ini BUKAN thread-safe - dipakai dari main thread saja.
// WinRT object ownership sudah ditangani di Rust thread worker.

import { invoke } from "@tauri-apps/api/core";
import { log } from './dom.js'; import { t } from './i18n.js';

const BLE_READ_CHUNK = 1024;

export class BleTransport {
  constructor() {
    this.connected = false;
    this.deviceId = null;
    this.deviceName = null;
    this.buffer = '';
    this.onLine = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this.onDeviceLost = null;
    this.pingTimer = null;
  }

  async scan() {
    const devices = await invoke('ble_scan');
    return devices.map(d => ({
      id: d.id,
      name: d.name || 'MacroPad',
      isPaired: d.is_paired,
    }));
  }

  async connect(deviceId) {
    if (this.connected) return false;

    try {
      await invoke('ble_connect', { id: deviceId });
      this.connected = true;
      this.deviceId = deviceId;
      if (this.onConnected) this.onConnected();
      this.startPing();
      return true;
    } catch (e) {
      log(t('ble.connectError', { err: e }), 'err');
      return false;
    }
  }

  async disconnect() {
    if (!this.connected) return;

    try {
      await invoke('ble_disconnect');
    } catch (e) {
      log(t('ble.disconnectError', { err: e }), 'err');
    }

    this.connected = false;
    this.deviceId = null;
    this.stopPing();
    if (this.onDisconnected) this.onDisconnected();
  }

  async isConnected() {
    return await invoke('ble_is_connected');
  }

  async write(data) {
    if (!this.connected) return 0;
    try {
      const len = await invoke('ble_write', { data });
      return len;
    } catch (e) {
      log(t('ble.writeError', { err: e }), 'err');
      await this.handleDeviceLost();
      return 0;
    }
  }

  async read(maxLen = BLE_READ_CHUNK) {
    if (!this.connected) return new Uint8Array(0);
    try {
      const data = await invoke('ble_read', { max_len: maxLen });
      return new Uint8Array(data);
    } catch (e) {
      log(t('ble.readError', { err: e }), 'err');
      return new Uint8Array(0);
    }
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.connected) this.write(new TextEncoder().encode('PING\n'));
    }, 1500);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  async handleIncoming() {
    if (!this.connected) return;
    try {
      const data = await this.read();
      if (data.length === 0) return;
      this.buffer += new TextDecoder().decode(data);
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (this.onLine) this.onLine(line);
      }
    } catch (e) {
      log(t('ble.readError', { err: e }), 'err');
      await this.handleDeviceLost();
    }
  }

  async handleDeviceLost() {
    if (!this.connected) return;
    this.connected = false;
    this.stopPing();
    if (this.onDeviceLost) this.onDeviceLost();
  }

  // Interface compatible dengan serial transport
  on(event, handler) {
    switch (event) {
      case 'line': this.onLine = handler; break;
      case 'connected': this.onConnected = handler; break;
      case 'disconnected': this.onDisconnected = handler; break;
      case 'deviceLost': this.onDeviceLost = handler; break;
    }
  }

  destroy() {
    this.stopPing();
    this.connected = false;
  }
}

export const bleTransport = new BleTransport();