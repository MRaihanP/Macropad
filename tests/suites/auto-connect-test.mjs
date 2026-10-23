// Menguji inti auto-connect lintas transport (src/auto-connect-core.js).
//
// Yang dijaga:
//  1. Transport terakhir yang sukses dicoba lebih dulu, lalu fallback.
//  2. Backend baru diganti hanya setelah device ditemukan (probe non-invasif).
//  3. Loop tetap mencoba walau device belum ada, dengan backoff BLE.
//  4. Aksi manual (pause) membatalkan percobaan yang sedang menunggu await.
//  5. Setelah tersambung, loop tidak memprobe/connect lagi.
//
// Test ini memakai deps palsu + timer palsu, jadi tidak membuka port/Tauri.
import { createAutoConnectManager } from '../../src/auto-connect-core.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

function build(overrides = {}) {
  const state = {
    connected: false,
    active: overrides.active || 'usb',
    now: 1000,
    probes: { usb: 0, ble: 0 },
    connects: [],
    switches: [],
    remembered: [],
    failedPorts: [],
    logs: [],
    busy: false,
  };

  const manager = createAutoConnectManager({
    probeUsb: async () => {
      state.probes.usb++;
      return overrides.usb ? overrides.usb(state) : null;
    },
    probeBle: async () => {
      state.probes.ble++;
      return overrides.ble ? overrides.ble(state) : null;
    },
    connect: async (target) => {
      state.connects.push(target);
      const success = overrides.connect ? overrides.connect(target, state) : true;
      if (success) state.connected = true;
      return success;
    },
    isConnected: () => state.connected,
    isAutoBusy: () => state.busy,
    setTransportBackend: async (id) => {
      state.switches.push(id);
      state.active = id;
      return id;
    },
    transportId: () => state.active,
    enableAutoReconnect: () => { },
    lastTransport: () => overrides.lastTransport || null,
    rememberTransport: (id) => state.remembered.push(id),
    markPortFailed: (path) => state.failedPorts.push(path),
    log: (text) => state.logs.push(text),
    t: (key) => key,
    now: () => state.now,
    setTimeout: () => 0,
    clearTimeout: () => { },
    delay: async () => { },
    immediateStart: false,
  }, overrides.timings || {});

  manager.start();
  return { manager, state };
}

console.log('--- A. Prioritas: transport terakhir sukses dicoba dulu ---');
{
  const { manager, state } = build({
    lastTransport: 'ble',
    active: 'usb',
    ble: () => ({ id: 'ble-1', name: 'MacroPad BLE' }),
  });
  const res = await manager.runOnceForTest();
  ok(res.connected === true, 'BLE preferred langsung connect tanpa memprobe USB');
  ok(state.probes.ble === 1 && state.probes.usb === 0, 'USB tidak diprobe saat BLE berhasil');
  ok(state.switches.length === 1 && state.switches[0] === 'ble',
    'backend diganti ke BLE tepat sekali');
  ok(state.connects.length === 1 && state.connects[0] === 'ble-1',
    'connect dipanggil dengan id device BLE');
  ok(state.remembered.length === 1 && state.remembered[0] === 'ble',
    'transport sukses diingat untuk startup berikutnya');
}

console.log('\n--- B. Fallback: preferred gagal, transport lain dipakai ---');
{
  const { manager, state } = build({
    lastTransport: 'ble',
    active: 'ble',
    ble: () => null,
    usb: () => 'COM3',
  });
  const res = await manager.runOnceForTest();
  ok(res.connected === true, 'fallback USB tersambung saat BLE tidak ada');
  ok(state.probes.ble === 1 && state.probes.usb === 1,
    'kedua transport diprobe, BLE lebih dulu');
  ok(state.switches.length === 1 && state.switches[0] === 'usb',
    'backend berpindah ke USB hanya setelah device ditemukan');
  ok(state.connects.length === 1 && state.connects[0] === 'COM3',
    'connect USB memakai path yang ditemukan');
}

console.log('\n--- C. Device belum ada: loop tetap mencoba (backoff) ---');
{
  const usbResults = [null, null, 'COM3'];
  const { manager, state } = build({
    lastTransport: 'usb',
    usb: () => (usbResults.length ? usbResults.shift() : 'COM3'),
  });
  const first = await manager.runOnceForTest();
  ok(first.connected !== true, 'putaran pertama tidak connect (belum ada device)');
  ok(state.probes.usb === 1 && state.probes.ble === 1,
    'putaran pertama memprobe USB lalu BLE');
  ok(first.next >= 400, 'loop dijadwalkan mencoba lagi, bukan berhenti');

  state.now += 2000;
  await manager.runOnceForTest();
  ok(state.probes.usb === 2, 'USB dicoba lagi setelah interval 2 dtk');

  state.now += 3000;
  const third = await manager.runOnceForTest();
  ok(third.connected === true, 'device yang muncul belakangan ikut tersambung');
  ok(state.connects[0] === 'COM3', 'connect memakai path yang baru muncul');
}

console.log('\n--- D. Hold manual menghentikan loop ---');
{
  const { manager, state } = build({ lastTransport: 'usb', usb: () => 'COM3' });
  manager.pause();
  const res = await manager.runOnceForTest();
  ok(res.paused === true, 'runOnce melaporkan paused saat hold');
  ok(state.probes.usb === 0 && state.probes.ble === 0 && state.connects.length === 0,
    'hold tidak memprobe dan tidak connect');
  manager.resume();
  const after = await manager.runOnceForTest();
  ok(after.connected === true, 'resume mengaktifkan lagi siklus auto-connect');
}

console.log('\n--- E. Pause saat probe berjalan membatalkan connect ---');
{
  let release = null;
  const { manager, state } = build({
    lastTransport: 'usb',
    usb: () => new Promise((resolve) => { release = resolve; }),
  });
  const pending = manager.runOnceForTest();
  // probeUsb sudah dipanggil dan runOnce sedang menunggu await-nya.
  manager.pause();
  release('COM3');
  const res = await pending;
  ok(res.paused !== false, 'hasil putaran tidak mengklaim connect setelah pause');
  ok(state.probes.usb === 1, 'probe yang sudah berjalan tetap diselesaikan');
  ok(state.connects.length === 0,
    'generation/hold mencegah connect setelah user memutus/menjeda');
}

console.log('\n--- F. Connect gagal: port ditandai dan fallback dicoba ---');
{
  const { manager, state } = build({
    lastTransport: 'usb',
    active: 'usb',
    usb: () => 'COM3',
    ble: () => ({ id: 'ble-1', name: 'MacroPad BLE' }),
    connect: (target) => target !== 'COM3',
  });
  const res = await manager.runOnceForTest();
  ok(res.connected === true, 'fallback BLE dipakai setelah USB gagal connect');
  ok(state.failedPorts.length === 1 && state.failedPorts[0] === 'COM3',
    'port USB yang gagal connect ditandai supaya dicoba lagi');
  ok(state.connects.length === 3
      && state.connects[0] === 'COM3' && state.connects[1] === 'COM3'
      && state.connects[2] === 'ble-1',
    'USB dicoba dua kali, lalu BLE');
}

console.log('\n--- G. Setelah tersambung, loop tidak memprobe lagi ---');
{
  const { manager, state } = build({
    lastTransport: 'usb',
    usb: () => 'COM3',
  });
  await manager.runOnceForTest();
  const before = { usb: state.probes.usb, ble: state.probes.ble, connects: state.connects.length };
  const res = await manager.runOnceForTest();
  ok(res.connected === true, 'putaran berikutnya melaporkan sudah tersambung');
  ok(state.probes.usb === before.usb && state.probes.ble === before.ble,
    'tidak ada probe tambahan saat sudah tersambung');
  ok(state.connects.length === before.connects,
    'tidak ada connect tambahan saat sudah tersambung');
}

console.log('\n--- H. Busy dari backend lain menahan loop ---');
{
  const { manager, state } = build({ lastTransport: 'usb', usb: () => 'COM3' });
  state.busy = true;
  const res = await manager.runOnceForTest();
  ok(res.busy === true, 'runOnce melaporkan busy');
  ok(state.probes.usb === 0 && state.connects.length === 0,
    'loop tidak menabrak operasi transport yang sedang berjalan');
}

console.log('\n--- I. Preferensi manual menang atas nilai tersimpan ---');
{
  const { manager } = build({ lastTransport: 'usb' });
  manager.setPreferred('ble');
  ok(manager.getPreferred() === 'ble', 'setPreferred mengubah prioritas');
}

console.log(`\n${fail === 0 ? 'SEMUA OK' : `${fail} GAGAL`}`);
process.exit(fail ? 1 : 0);
