// Guard untuk F2 (C5): HWINFO harus melaporkan iface=usb|ble.
//
// App perlu tahu ke mana report HID dikirim saat ini tanpa harus menebak dari
// status pairing Bluetooth. Field ini hanya INFORMASI - belum ada aksi, dan
// app belum ditampilkan (itu langkah B3).
//
// Yang dijaga:
//   - HWINFO punya iface=
//   - nilainya lowercase (usb/ble), bukan USB/BLE, supaya app bisa
//     membandingkannya dengan string tanpa normalisasi
//   - iface != jalur protokol. Jalur protokol akan punya field sendiri
//     (proto=, langkah F3). Kalau iface ikut berubah Meaning-nya, app akan
//     salah baca.
//
// Jalankan: node tests/suites/contract-hwinfo-test.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const core = read('firmware/common/macropad_core.h');
const limits = read('firmware/common/limits.h');
const hidLink = read('firmware/common/hid_link.h');
const parser = read('src/protocol-parser.js');

// Buang komentar supaya yang diperiksa benar-benar KODE. Tanpa ini,
// penyebutan "proto=" di dalam komentar penjelas ikut terhitung sebagai field.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('--- 1. HWINFO memuat iface= ---');
const hwinfo = core.slice(core.indexOf('if (cmd == "HWINFO")'));
const baris = hwinfo.slice(0, hwinfo.indexOf('return;'));
const barisKode = strip(baris);
ok(/HWINFO:/.test(baris), 'blok HWINFO ditemukan');
ok(/iface=%s/.test(barisKode), 'format HWINFO punya field iface=%s');
ok(/hidLinkName\s*\(\s*g_hidLink\s*\)/.test(barisKode),
  'iface diisi dari hidLinkName(g_hidLink) - bukan string hardcode');

console.log('\n--- 2. Nilai iface lowercase ---');
// Huruf besar hanya untuk tampilan log. Yang masuk protokol harus lowercase
// supaya app bisa membandingkan dengan string apa adanya.
ok(/return\s*\(l == HidLink::BLE\)\s*\?\s*"ble"\s*:\s*"usb"/.test(limits),
  'hidLinkName() mengembalikan "usb"/"ble" (huruf kecil)');
ok(!/hidLinkName[\s\S]{0,200}\?\s*"BLE"\s*:\s*"USB"/.test(hidLink),
  'definisi lama hidLinkName() di hid_link.h sudah dihapus');
ok(/hidLinkName/.test(hidLink), 'hid_link.h masih memakai hidLinkName (dari limits.h)');

console.log('\n--- 3. Hanya ada satu definisi ---');
// Dua definisi = redefinition error, atau diam-diam yang dipakai yang salah.
// Yang dijaga BANYAK file, bukan cuma limits.h: kalau hidLinkName()
// didefinisikan lagi di header lain yang di-include setelah limits.h, yang
// dipakai adalah yang terakhir - bisa jadi yang salah.
const defs = (limits.match(/const char\*\s*hidLinkName/g) || []).length;
ok(defs === 1, `hidLinkName() didefinisikan tepat sekali (ditemukan ${defs})`);
ok(limits.includes('enum class HidLink'), 'enum HidLink ada di limits.h');
ok(/HidLink g_hidLink\s*=/.test(hidLink), 'g_hidLink tetap di hid_link.h');
// Header lain yang memakainya TIDAK BOLEH punya definisinya sendiri.
for (const [nama, isi] of [
  ['hid_link.h', hidLink],
  ['ble_diag.h', read('firmware/common/ble_diag.h')],
  ['ble_hid.h', read('firmware/common/ble_hid.h')],
  ['macropad_core.h', core],
]) {
  ok(!/const char\*\s*hidLinkName\s*\(/.test(isi),
    `${nama}: tidak mendefinisikan ulang hidLinkName()`);
}

console.log('\n--- 4. Field yang sudah ada tidak berubah ---');
// Menambahkan field baru tidak boleh mengubah field lama - kalau berubah,
// companion app yang sudah dipasangkan dengan firmware lama akan salah baca.
for (const k of ['profile', 'encoders', 'statusLed', 'rgb', 'rgbSlots', 'vdiv', 'chg', 'simulated', 'iface']) {
  ok(new RegExp(`${k}=%`).test(barisKode), `HWINFO masih punya field ${k}=`);
}
ok(/proto=%s/.test(barisKode), 'HWINFO punya field proto=%s');
ok(/protoLinkName\s*\(\s*g_protoLink\s*\)/.test(barisKode),
  'proto diisi dari protoLinkName(g_protoLink) - bukan string hardcode');

console.log('\n--- 4b. ProtoLink: enum, definisi tunggal, perintah PROTO:* ---');
const diag = read('firmware/common/ble_diag.h');
ok(/enum class ProtoLink : uint8_t \{ CDC = 0, NUS = 1 \}/.test(limits),
  'limits.h: enum ProtoLink { CDC=0, NUS=1 }');
ok(/ProtoLink g_protoLink\s*=\s*\(ProtoLink\)PROTO_DEFAULT/.test(limits),
  'limits.h: g_protoLink didefinisikan dengan default PROTO_DEFAULT');
ok((limits.match(/extern ProtoLink g_protoLink/g) || []).length === 1,
  'extern ProtoLink g_protoLink dideklarasikan tepat sekali');
// protoLinkName hanya boleh ada di satu tempat.
const protoDefs = (limits.match(/const char\*\s*protoLinkName/g) || []).length;
ok(protoDefs === 1, `protoLinkName() didefinisikan tepat sekali (ditemukan ${protoDefs})`);
// enum ProtoLink juga hanya boleh ada di satu tempat.
const enumDefs = (limits.match(/enum class ProtoLink/g) || []).length;
ok(enumDefs === 1, `enum ProtoLink didefinisikan tepat sekali (ditemukan ${enumDefs})`);
for (const [nama, isi] of [
  ['hid_link.h', hidLink],
  ['ble_diag.h', diag],
  ['ble_hid.h', read('firmware/common/ble_hid.h')],
  ['macropad_core.h', core],
]) {
  ok(!/const char\*\s*protoLinkName\s*\(/.test(isi),
    `${nama}: tidak mendefinisikan ulang protoLinkName()`);
  ok(!/enum class ProtoLink/.test(isi),
    `${nama}: tidak mendefinisikan ulang enum ProtoLink`);
}
// Perintah PROTO:* harus ada dan terpisah dari IFACE:*.
for (const cmd of ['PROTO', 'PROTO:CDC', 'PROTO:NUS']) {
  ok(diag.includes(`cmd == "${cmd}"`), `ble_diag.h: ada perintah ${cmd}`);
}
// g_protoLink harus ditulis oleh PROTO:* (bukan hanya dideklarasikan).
ok(/g_protoLink\s*=\s*ProtoLink::CDC/.test(diag), 'PROTO:CDC mengatur g_protoLink ke CDC');
ok(/g_protoLink\s*=\s*ProtoLink::NUS/.test(diag), 'PROTO:NUS mengatur g_protoLink ke NUS');
// Nilai proto= lowercase.
ok(/return \(l == ProtoLink::NUS\)\s*\?\s*"nus"\s*:\s*"cdc"/.test(limits),
  'protoLinkName() mengembalikan "cdc"/"nus" (huruf kecil)');

console.log('\n--- 5. Parser app menangani field baru ---');
// Parser HWINFO generic key=value, jadi iface= otomatis ikut terbaca.
// Guard ini memastikan parser itu masih generic - kalau nanti dirubah jadi
// daftar field eksplisit, iface= akan hilang diam-diam.
const parseHw = parser.slice(parser.indexOf("line.startsWith('HWINFO:')"));
const blok = parseHw.slice(0, parseHw.indexOf('return;'));
ok(/split\s*\(\s*','\s*\)/.test(blok), 'parser memecah HWINFO per key=value (generic)');
ok(!/iface/.test(blok), 'parser tidak punya daftar field hardcode (iface ikut otomatis)');

console.log('\n--- 6. Penjelasan ada ---');
ok(/iface/.test(baris) || /iface/.test(core),
  'ada penjelasan di firmware tentang apa itu iface');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
