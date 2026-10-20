// Guard untuk F4 (C8): saat pindah ke USB, BLE dimatikan total
// (peer diputus + advertising mati). Saat pindah ke BLE, USB dimatikan total.
// Hanya SATU medium yang hidup pada satu waktu (mutual exclusion).
//
// Masalah yang dicegah: kalau USB dan BLE sama-sama hidup, Windows
// mencatat DUA karakter untuk satu penekanan tombol (hid_link.h:8-10).
//
// Jalankan: node tests/suites/contract-advertising-test.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const bleHid = read('firmware/common/ble_hid.h');
const proto = read('firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino');
const transport = read('firmware/common/transport_usb.h');
const hid = read('firmware/common/hid_link.h');

console.log('--- 1. bleHidStop() mematikan advertising (total, bukan hanya peer) ---');
const stopFn = bleHid.slice(bleHid.indexOf('inline void bleHidStop()'));
const stopBody = stopFn.slice(0, stopFn.indexOf('\n}') + 2);
ok(/adv->stop\(\)/.test(stopBody),
  'bleHidStop() memanggil adv->stop()');
ok(/server->disconnect/.test(stopBody),
  'bleHidStop() tetap memutus peer HID (Windows tidak menyimpan entri mati)');
ok(/Advertising dimatikan/.test(stopBody),
  'bleHidStop() menjelaskan bahwa advertising dimatikan (mode USB)');

console.log('\n--- 2. usbDevicePower mematikan USB device secara total ---');
ok(/tud_disconnect\(\)/.test(transport),
  'transport_usb.h memanggil tud_disconnect() saat USB dimatikan');
ok(/tud_connect\(\)/.test(transport),
  'transport_usb.h memanggil tud_connect() saat USB dihidupkan');
ok(/g_usbPowered/.test(transport),
  'transport_usb.h memelihara state g_usbPowered');

console.log('\n--- 3. Watchdog advertising HANYA di mode BLE ---');
// Cari DEFINISI fungsi (dengan '{'), bukan deklarasi forward (dengan ';').
const defIdx = proto.indexOf('void profileLoopHook() {');
ok(defIdx >= 0, 'definisi profileLoopHook() ditemukan');
const loopHook = proto.slice(defIdx);
const hookBody = loopHook.slice(0, loopHook.indexOf('\n}') + 2);
// Guard `if (g_hidLink != HidLink::BLE) return;` HARUS ada SEBELUM
// `if (bleHidConnected()) return;` supaya watchdog tidak menyala di mode USB.
const guardAt = hookBody.indexOf('if (g_hidLink != HidLink::BLE) return;');
const connectedAt = hookBody.indexOf('if (bleHidConnected()) return;');
ok(guardAt >= 0, 'watchdog guard (BLE only) ditemukan di profileLoopHook()');
ok(connectedAt >= 0, 'cek bleHidConnected() ditemukan di profileLoopHook()');
ok(guardAt < connectedAt,
  'watchdog guard (BLE only) ada SEBELUM cek bleHidConnected()');
ok(/bleHidAdvertising\(\)/.test(hookBody),
  'watchdog masih cek bleHidAdvertising()');
ok(/bleHidStart\(\)/.test(hookBody),
  'watchdog memanggil bleHidStart() sebagai safety net');

console.log('\n--- 3b. Setup mematikan BLE saat boot di mode USB ---');
ok(/if \(g_hidLink != HidLink::BLE\)\s*bleHidStop\(\)/.test(proto),
  'setup memanggil bleHidStop() saat mode USB (mutual exclusion sejak boot)');

console.log('\n--- 4. Penyeswitan penuh lewat ifaceSwitchFull (HID + PROTO + POWER) ---');
ok(/void ifaceSwitchFull\(bool goBle\)/.test(proto),
  'ifaceSwitchFull(bool goBle) terdefinisi di sketsh PROTOTYPE');
ok(/usbDevicePower\(!goBle\)/.test(proto),
  'ifaceSwitchFull memanggil usbDevicePower (mutual exclusion)');
ok(/hidLinkSet\(HidLink::BLE\)/.test(proto),
  'ifaceSwitchFull memindahkan HID_LINK ke BLE');
ok(/hidLinkSet\(HidLink::USB\)/.test(proto),
  'ifaceSwitchFull memindahkan HID_LINK ke USB');
ok(/g_protoLink\s*=\s*ProtoLink::NUS/.test(proto),
  'ifaceSwitchFull memindahkan PROTO_LINK ke NUS');
ok(/g_protoLink\s*=\s*ProtoLink::CDC/.test(proto),
  'ifaceSwitchFull memindahkan PROTO_LINK ke CDC');
ok(/protoTransportSwitch\(\)/.test(proto),
  'protoTransportSwitch() dipanggil');
ok(/switchLedStart\(goBle \? SwitchLedPattern::SW_BLINK : SwitchLedPattern::SW_SOLID\)/.test(proto),
  'LED: blink=BLE, solid=USB');

console.log('\n--- 4b. bleHidStart() masih bisa nyalakan advertising ---');
const strip4b = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const startFn = bleHid.slice(bleHid.indexOf('inline void bleHidStart()'));
const startBody = strip4b(startFn.slice(0, startFn.indexOf('\n}') + 2));
ok(/adv->start\(0\)/.test(startBody),
  'bleHidStart() masih bisa restart advertising kalau berhenti sendiri');

console.log('\n--- 5. MODE:BT/MODE:PC di ble_diag.h memanggil ifaceSwitchFull ---');
const diag = read('firmware/common/ble_diag.h');
ok(/ifaceSwitchFull\(goBle\)/.test(diag),
  'ble_diag.h MODE:BT/MODE:PC panggil ifaceSwitchFull()');

console.log('\n--- 6. switchLedTick non-blocking (tanpa delay) ---');
const sw = read('firmware/common/switch_iface.h');
ok(/SWITCH_LED_BLINK_MS\s+200/.test(sw), 'interval kedip 200 ms');
ok(/SWITCH_LED_TOTAL_MS\s+1000/.test(sw), 'durasi total 1000 ms');
const tick = sw.match(/inline void switchLedTick\(\)\s*\{([\s\S]*?)\n\}/);
ok(!!tick, 'switchLedTick() ada');
if (tick) {
  ok(!/\bdelay\s*\(/.test(tick[1]), 'switchLedTick() tidak memakai delay()');
  ok(/millis\(\)/.test(tick[1]), 'switchLedTick() berbasis millis()');
}

console.log('\n--- 7. GPIO0 = BOOT, aktif-LOW, pull-up internal ---');
ok(/#define BOOT_SWITCH_PIN\s+0/.test(sw), 'BOOT_SWITCH_PIN = GPIO0');
ok(/pinMode\(BOOT_SWITCH_PIN, INPUT_PULLUP\)/.test(sw), 'dibaca sebagai INPUT_PULLUP');
ok(/digitalRead\(BOOT_SWITCH_PIN\) == LOW/.test(sw), 'aktif-LOW (ditekan = LOW)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
