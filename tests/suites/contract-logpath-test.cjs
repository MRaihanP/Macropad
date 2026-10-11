// Guard untuk F1 (C10): jalur LOG harus terpisah dari jalur PROTOKOL.
//
// Mulai F5, g_transport bisa diarahkan ke BLE NUS. Kalau ada baris log yang
// masih menulis lewat SERIAL->, baris itu ikut terkirim ke companion app di
// stream protokol. Parser app punya aturan ketat, jadi jawaban DUMP bisa
// tercampur dan state app menyimpang tanpa error yang jelas.
//
// Aturan yang dijaga di sini:
//   - LOG (diagnostik, untuk manusia)  -> LOGS->  , dan LOGS = USB CDC selalu
//   - PROTOKOL (jawaban, [KEY], EVT:)  -> SERIAL->
//   - firmware/common/macropad_core.h  -> HARUS pakai SERIAL-> saja
//
// Jalankan: node tests/suites/contract-logpath-test.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const transport = read('firmware/common/transport.h');
const core = read('firmware/common/macropad_core.h');
const bleHid = read('firmware/common/ble_hid.h');
const bleDiag = read('firmware/common/ble_diag.h');
const hidLink = read('firmware/common/hid_link.h');
const proto = read('firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino');
const final = read('firmware/HID_Keypad_Final/HID_Keypad_Final.ino');

console.log('--- 1. Deklarasi LOGS ada ---');
ok(/extern Transport\*\s*g_logTransport\s*;/.test(transport),
  'transport.h mendeklarasikan g_logTransport');
ok(/#define\s+LOGS\s+g_logTransport/.test(transport),
  'transport.h mendefinisikan makro LOGS');
ok(/#define\s+SERIAL\s+g_transport/.test(transport),
  'SERIAL tetap menunjuk g_transport (protokol)');

console.log('\n--- 2. g_logTransport = USB CDC di kedua sketsh ---');
// Kalau log ikut diarahkan ke NUS, pemisahan ini tidak ada artinya.
for (const [nama, isi] of [['PROTOTYPE', proto], ['FINAL', final]]) {
  ok(/Transport\*\s*g_logTransport\s*=\s*&g_usbTransport\s*;/.test(isi),
    `${nama}: g_logTransport = &g_usbTransport (tidak pernah dialihkan)`);
  ok(/Transport\*\s*g_transport\s*=/.test(isi),
    `${nama}: g_transport ada dan terpisah`);
}

console.log('\n--- 3. Tidak ada log yang masih lewat SERIAL-> ---');
for (const [nama, isi] of [['ble_hid.h', bleHid], ['ble_diag.h', bleDiag], ['hid_link.h', hidLink]]) {
  ok(!/SERIAL->(printf|println)/.test(isi),
    `${nama}: tidak ada SERIAL->printf/println (semua log pakai LOGS->)`);
}
ok(/LOGS->printf\("\[BLE\]/.test(bleHid), 'ble_hid.h: log [BLE] lewat LOGS->');
ok(/LOGS->printf\("IFACE:link=/.test(bleDiag), 'ble_diag.h: status IFACE lewat LOGS->');
ok(/LOGS->printf\("\[IN:%s\]/.test(hidLink), 'hid_link.h: jejak input lewat LOGS->');

console.log('\n--- 4. Core TIDAK boleh pakai LOGS-> ---');
// core = protokol. Kalau satu baris pun di core memakai LOGS, jawaban
// perintah tidak akan sampai ke companion app.
ok(!/LOGS->/.test(core),
  'macropad_core.h tidak memakai LOGS-> sama sekali');
ok(/SERIAL->printf\("HWINFO:/.test(core), 'core masih menjawab HWINFO lewat SERIAL->');
ok(/SERIAL->printf\("\[KEY\] /.test(core), 'core masih mengirim [KEY] lewat SERIAL->');
ok(/SERIAL->printf\("EVT:/.test(core), 'core masih mengirim EVT: lewat SERIAL->');

console.log('\n--- 5. Jalur baca/tulis protokol tidak berubah ---');
// SERIAL->available/read/write adalah I/O ke app - itu protokol, bukan log.
for (const [nama, isi] of [['ble_hid.h', bleHid], ['ble_diag.h', bleDiag], ['hid_link.h', hidLink]]) {
  ok(!/LOGS->(available|read|write|flush)/.test(isi),
    `${nama}: tidak ada LOGS->available/read/write (I/O protokol tetap SERIAL->)`);
}

console.log('\n--- 6. BLE:ECHO tetap proof arah firmware->app ---');
// BLE:ECHO menulis ke characteristic NUS secara langsung, BUKAN lewat
// SERIAL-> atau LOGS->. Kalau ini ikut dialihkan ke LOGS, bukti arah
// firmware->app jadi tidak berarti apa-apa.
ok(/bleNusRx->notify/.test(bleDiag),
  'BLE:ECHO tetap notify langsung ke NUS (bukan lewat transport)');
ok(!/BLE:ECHO[\s\S]{0,400}LOGS->printf\("\[%s\] NUS notify/.test(bleDiag),
  'BLE:ECHO tidak tercampur dengan jalur log');

console.log('\n--- 7. Penjelasan ada di kode ---');
ok(/SERIAL/.test(transport) && /NUS|protokol/i.test(transport),
  'transport.h menjelaskan kenapa log dipisah dari protokol');
// Tidak semua berkas wajib menyebut "Serial Monitor" - yang penting semua
// pesan diagnostiknya memang lewat LOGS (sudah dijaga di bagian 3).
for (const [nama, isi] of [['ble_diag.h', bleDiag], ['hid_link.h', hidLink]]) {
  ok(/Serial Monitor/.test(isi),
    `${nama}: menyebut Serial Monitor sebagai pembaca log`);
}
// ble_hid.h sengaja tidak menyebut "Serial Monitor" (log-nya didokumentasikan
// di transport.h). Yang dijaga di sini cuma bahwa prefix [BLE] miliknya.
ok(/\[BLE\]/.test(bleHid), 'ble_hid.h: prefix log [BLE] masih ada');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
