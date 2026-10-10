// ==================== TRANSPORT MANAGER ====================
//
// Manajer transport tunggal yang bisa switch runtime antara USB serial
// dan BLE NUS. Semua modul lain hanya perlu import transportManager
// dan memanggil transport.write(), transport.on('line', ...), dll.
//
// Switch transport dilakukan via switchTransport('usb' | 'ble').

import { el, log } from './dom.js';
import { t } from './i18n.js';
import { invoke } from '@tauri-apps/api/core';
import { sleep } from './serial-transport.js';
import { bleTransport } from './ble-transport.js';

// State transport aktif
let activeTransport = null;
let transportType = 'usb';
let autoBusy = false;

// Serial transport (imported lazily untuk hindari circular)
let serialTransport = null;
let serialTransportPromise = null;

// Hooks yang dipakai main.js
let hooks = {
  onLine: function() {},
  onConnected: function() {},
  onDisconnected: function() {},
  onDeviceLost: function() {},
  onAutoConnectOk: function() {},
  onAutoConnectFail: function() {},
  notify: function() {},
  clearDirty: function() {},
};

function getSerialTransport() {
  if (serialTransport) return serialTransport;
  if (!serialTransportPromise) {
    serialTransportPromise = import('./serial-transport.js').then(function(mod) {
      serialTransport = mod;
      return serialTransport;
    });
  }
  throw new Error('Serial transport not yet initialized. Call initTransportManager() first.');
}


function setActiveTransport(transport, type) {
  if (activeTransport && activeTransport.off) {
    activeTransport.off('line');
    activeTransport.off('connected');
    activeTransport.off('disconnected');
    activeTransport.off('deviceLost');
  }

  activeTransport = transport;
  transportType = type;

  if (!activeTransport) return;

  if (activeTransport.on) {
    activeTransport.on('line', function(line) { hooks.onLine(line); });
    activeTransport.on('connected', function() {
      hooks.onConnected();
      updateUIState(true);
    });
    activeTransport.on('disconnected', function() {
      hooks.onDisconnected();
      updateUIState(false);
    });
    activeTransport.on('deviceLost', function() {
      hooks.onDeviceLost();
      updateUIState(false);
    });
  }
}

async function createTransport(type) {
  if (type === 'usb') {
    var serial = await getSerialTransport();
    return {
      write: async function(data) {
        if (typeof data === 'string') data = new TextEncoder().encode(data);
        return serial.port.write(data);
      },
      on: function(event, handler) {
        if (event === 'line') hooks.onLine = handler;
        else if (event === 'connected') hooks.onConnected = handler;
        else if (event === 'disconnected') hooks.onDisconnected = handler;
        else if (event === 'deviceLost') hooks.onDeviceLost = handler;
      },
      connect: function(path) { return serial.connect(path); },
      disconnect: function(manual) { return serial.disconnect(manual); },
      isConnected: function() { return serial.isConnected(); }
    };
  } else {
    return bleTransport;
  }
}

export async function switchTransport(type) {
  if (type === transportType) return;

  log(t('transport.switching', { from: transportType, to: type }));

  if (activeTransport) {
    await activeTransport.disconnect(true);
    await sleep(200);
  }

  if (type === 'ble') {
    try { await invoke('ble_switch_interface', { iface: 'ble' }); }
    catch (e) { log(t('ble.switchError', { err: e }), 'err'); }
  } else if (type === 'usb') {
    try { await invoke('ble_switch_interface', { iface: 'usb' }); }
    catch (e) { log(t('ble.switchError', { err: e }), 'err'); }
  }

  var newTransport = await createTransport(type);
  setActiveTransport(newTransport, type);

  if (type === 'usb') {
    var serial = await getSerialTransport();
    if (serial.lastGoodPort) {
      await newTransport.connect(serial.lastGoodPort);
    } else {
      await serial.autoDetect();
    }
  } else {
    await scanAndConnectBle();
  }

  localStorage.setItem('macropad.transportType', type);
  log(t('transport.switched', { type: transportType }));
}

async function scanAndConnectBle() {
  try {
    var devices = await bleTransport.scan();
    if (devices.length === 0) {
      log(t('ble.noDevices'), 'err');
      return false;
    }

    var paired = devices.find(function(d) { return d.isPaired; }) || devices[0];
    log(t('ble.connecting', { name: paired.name }));

    var ok = await bleTransport.connect(paired.id);
    if (ok) {
      log(t('ble.connected', { name: paired.name }), 'ok');
      return true;
    } else {
      log(t('ble.connectFailed'), 'err');
      return false;
    }
  } catch (e) {
    log(t('ble.scanError', { err: e }), 'err');
    return false;
  }
}

function updateUIState(connected) {
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('statusText');
  if (dot) dot.classList.toggle('on', connected);
  if (statusText) statusText.textContent = connected
    ? t('transport.connected')
    : t('transport.notConnected');
  
  var badge = document.getElementById('transportBadge');
  if (badge) {
    badge.textContent = transportType === 'usb' ? 'USB' : 'BLE';
    badge.classList.toggle('ble', transportType === 'ble');
  }
}

export async function connect(path) {
  if (transportType === 'usb') return activeTransport.connect(path);
  return false;
}

export async function disconnect(manual) {
  if (activeTransport) await activeTransport.disconnect(manual);
}

export async function sendLine(str) {
  if (activeTransport) await activeTransport.write(str + '\n');
}

export async function sendBatch(lines) {
  if (!activeTransport) return;
  var chunk = lines.join('\n') + '\n';
  await activeTransport.write(chunk);
}

export async function writeRaw(data) {
  if (activeTransport) await activeTransport.write(data);
}

export function isConnected() {
  return activeTransport && activeTransport.connected;
}

export function getTransportType() {
  return transportType;
}

export async function autoDetect() {
  if (transportType === 'usb') {
    var serial = await getSerialTransport();
    return serial.autoDetect();
  } else {
    return scanAndConnectBle();
  }
}

export async function pollPorts() {
  if (transportType === 'usb') {
    var serial = await getSerialTransport();
    return serial.pollPorts();
  }
  if (bleTransport.connected) {
    var ok = await bleTransport.isConnected();
    if (!ok) {
      log(t('ble.deviceLostLog'), 'err');
      bleTransport.onDeviceLost && bleTransport.onDeviceLost();
    }
  }
}

export function isAutoBusy() {
  return autoBusy;
}

export function deviceWasLost() {
  return activeTransport ? !activeTransport.connected : false;
}

export function updateConnectButton(state) {
  var btn = document.getElementById('btnConnect');
  if (btn) btn.textContent = state ? t('transport.disconnect') : t('header.connect');
}

export default {
  switchTransport: switchTransport,
  getTransportType: function() { return transportType; },
  getActiveTransport: function() { return activeTransport; },
  updateConnectButton: updateConnectButton,
  deviceWasLost: deviceWasLost,
  isAutoBusy: isAutoBusy,
};

export { sleep };

export async function initTransportManager(h) {
  Object.assign(hooks, h);
  var savedType = localStorage.getItem('macropad.transportType') || 'usb';
  await switchTransport(savedType);
}

