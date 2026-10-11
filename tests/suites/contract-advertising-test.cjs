// Guard untuk F4 (C8): device selalu advertising, apa pun mode iface.
//
// Masalah yang dicegah: kalau advertising dimatikan saat mode USB, device
// hilang dari daftar Bluetooth dan companion app tidak bisa menemukannya
// untuk mengirim PROTO:NUS — padahal itulah jalur satu-satunya untuk
// membuat protokol companion app hidup lewat BLE. Ini chicken-and-egg:
// app butuh advertising untuk connect, tapi advertising mati karena
// mode USB.
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
const finalSketch = read('firmware/HID_Keypad_Final/HID_Keypad_Final.ino');

console.log('--- 1. bleHidStop() tidak mematikan advertising ---');
const stopFn = bleHid.slice(bleHid.indexOf('inline void bleHidStop()'));
const stopBody = stopFn.slice(0, stopFn.indexOf('\n}') + 2);
ok(!/adv->stop\(\)/.test(stopBody),
  'bleHidStop() tidak memanggil adv->stop()');
ok(/server->disconnect/.test(stopBody),
  'bleHidStop() tetap memutus peer HID (Windows tidak menyimpan entri mati)');
ok(/Advertising tetap ON/.test(stopBody) || /advertising/.test(stopBody),
  'bleHidStop() menjelaskan bahwa advertising tetap on');

console.log('\n--- 2. Sketsh tidak mematikan advertising saat boot ---');
for (const [nama, isi] of [['PROTOTYPE', proto], ['FINAL', finalSketch]]) {
  ok(!/advertising\(\)->stop\(\)/.test(isi),
    `${nama}: tidak ada advertising()->stop()`);
  ok(!/getAdvertising\(\)->stop\(\)/.test(isi),
    `${nama}: tidak ada getAdvertising()->stop()`);
}

console.log('\n--- 3. Watchdog advertising jalan di mode apa pun ---');
// Cari DEFINISI fungsi (dengan '{'), bukan deklarasi forward (dengan ';').
const defIdx = proto.indexOf('void profileLoopHook() {');
ok(defIdx >= 0, 'definisi profileLoopHook() ditemukan');
const loopHook = proto.slice(defIdx);
const hookBody = loopHook.slice(0, loopHook.indexOf('\n}') + 2);
ok(!/g_hidLink != HidLink::BLE/.test(hookBody),
  'watchdog tidak lagi dibatasi mode BLE saja');
ok(/bleHidAdvertising\(\)/.test(hookBody),
  'watchdog masih cek bleHidAdvertising()');
ok(/bleHidStart\(\)/.test(hookBody),
  'watchdog memanggil bleHidStart() sebagai safety net');

console.log('\n--- 4. bleHidStart() tetap ada sebagai safety net ---');
// Strip komentar dulu: mutasi negative test menyisakan teks di dalam
// komentar, jadi regex tanpa strip akan tetap match.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const startFn = bleHid.slice(bleHid.indexOf('inline void bleHidStart()'));
const startBody = strip(startFn.slice(0, startFn.indexOf('\n}') + 2));
ok(/adv->start\(0\)/.test(startBody),
  'bleHidStart() masih bisa restart advertising kalau berhenti sendiri');

console.log('\n--- 5. Penjelasan ada di kode ---');
ok(/chicken-and-egg|PROTO:NUS|companion app/.test(bleHid),
  'ble_hid.h menjelaskan kenapa advertising tidak dimatikan');
ok(/advertising/.test(proto) && /tidak pernah dimatikan/i.test(proto),
  'sketsh menjelaskan bahwa advertising tidak pernah dimatikan');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
