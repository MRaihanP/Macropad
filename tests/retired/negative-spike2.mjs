/**
 * negative-spike2.mjs — UJI NEGATIF untuk spike2-test.js
 *
 * Aturan proyek: "Test yang tidak pernah gagal tidak membuktikan apa pun."
 * Jadi di sini tiap bug v1 dikembalikan ke bentuk semula di sketch spike_ble_hid2,
 * lalu spike2-test.js HARUS gagal. Kalau ada mutasi yang tetap hijau, test-nya
 * lemah dan harus diperkuat - bukan mutationnya yang "tidak dihitung".
 *
 * Semua mutasi bekerja pada salinan sementara. Sketch asli tidak pernah
 * disentuh, dan selalu dipulihkan，就算 file asli gagal ditulis pun.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const REPO = process.argv[2] || process.cwd();
const TEST = path.join(os.tmpdir(), 'opencode', 'spike2-test.js');
const SKETCH_REL = path.join('firmware', 'spike_ble_hid2', 'spike_ble_hid2.ino');
const SKETCH = path.join(REPO, SKETCH_REL);
const BACKUP = SKETCH + '.negtest-backup';

if (!fs.existsSync(TEST)) { console.log(`FAIL test tidak ditemukan: ${TEST}`); process.exit(1); }
if (!fs.existsSync(SKETCH)) { console.log(`FAIL sketch tidak ditemukan: ${SKETCH}`); process.exit(1); }

// Salinan asli, satu kali.
fs.copyFileSync(SKETCH, BACKUP);
const original = fs.readFileSync(SKETCH, 'utf8');

function runTest() {
  try {
    const out = execFileSync(process.execPath, [TEST, REPO], { encoding: 'utf8', stdio: 'pipe' });
    return { failed: false, out };
  } catch (e) {
    return { failed: true, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// Daftar mutasi. Tiap entri:
//
//   nama   : apa yang disisipkan/diubah
//   mutasi : (kode) => kode baru
//   why    : bug nyata apa yang harus kembali terdeteksi
//
// Penting: mutasi harus mengembalikan KODE, bukan komentar. Kalau hanya
// menambah penjelasan di komentar, test yang membuang komentar tidak akan
// bereaksi - dan itu memang yang kita uji di sini.
const MUTATIONS = [
  {
    nama: 'advertiseOnDisconnect(true) dihapus',
    why: 'Persis bug v1: perangkat berhenti advertise permanen setelah disconnect.',
    mutasi: (c) => c.replace(/g_server->advertiseOnDisconnect\s*\(\s*true\s*\)\s*;/, ''),
  },
  {
    nama: 'advertiseOnDisconnect(false) — advertising tetap mati',
    why: 'Variasi: flag ada tapi salah nilainya, tetap tidak me-restart.',
    // WAJIB men-target pemanggilan KODE, bukan kemunculan pertama di berkas.
    // Berkas ini menjelaskan bug-nya di komentar ("v1 tidak pernah memanggil
    // advertiseOnDisconnect(true)"), jadi pola tanpa konteks akan mengenai
    // KOMENTAR lebih dulu - dan karena spike2-test.js membuang komentar,
    // mutasi seperti itu tidak akan pernah terdeteksi.
    // Guard "hanya menyentuh komentar" di bawah menangkap kasus ini; di sini
    // pola dibuat sempit supaya yang diganti memang baris kodenya.
    mutasi: (c) => c.replace(/g_server->advertiseOnDisconnect\s*\(\s*true\s*\)\s*;/,
                             'g_server->advertiseOnDisconnect(false);'),
  },
  {
    nama: 'startAdvertising dihapus dari onDisconnect',
    why: 'Pengaman lapis kedua hilang; hanya mengandalkan flag.',
    mutasi: (c) => c.replace(/(onDisconnect[\s\S]{0,400}?)BLEDevice::startAdvertising\s*\(\s*\)\s*;/, '$1;'),
  },
  {
    nama: 'BLEServerCallbacks dihapus total',
    why: 'v1 tidak punya callback sama sekali.',
    mutasi: (c) => c.replace(/class\s+\w+\s*:\s*public\s+BLEServerCallbacks[\s\S]*?^\};/m, ''),
  },
  {
    nama: 'setPassKey acak dikembalikan',
    why: 'Bug v1: passkey yang tak pernah dipakai tapi merusak pairing.',
    mutasi: (c) => c.replace(/(setCapability\s*\(\s*ESP_IO_CAP_NONE\s*\)\s*;)/,
      '$1 sec->setPassKey(false, BLESecurity::generateRandomPassKey());'),
  },
  {
    nama: 'regenPassKeyOnConnect(true) dikembalikan',
    why: 'Bug v1: passkey berubah tiap koneksi sehingga bond tidak cocok.',
    mutasi: (c) => c.replace(/(setCapability\s*\(\s*ESP_IO_CAP_NONE\s*\)\s*;)/,
      '$1 sec->regenPassKeyOnConnect(true);'),
  },
  {
    nama: 'setForceAuthentication(true) dikembalikan',
    why: 'Bug v1: security dipaksa saat connect, link putus sendiri.',
    mutasi: (c) => c.replace(/(setCapability\s*\(\s*ESP_IO_CAP_NONE\s*\)\s*;)/,
      '$1 sec->setForceAuthentication(true);'),
  },
  {
    nama: 'BLEHIDDevice diganti bangun service manual (1812 + 2a4d)',
    why: 'Bug v1: characteristic wajib HID tidak ada, Windows HOGP gagal enumerasi.',
    mutasi: (c) => c.replace(/BLEHIDDevice\*\s*hid\s*=\s*new\s+BLEHIDDevice\s*\(g_server\)\s*;/,
      'BLEService* hid = g_server->createService(BLEUUID("1812"), 40);\n' +
      '  hid->createCharacteristic(BLEUUID("2a4d"), BLECharacteristic::PROPERTY_NOTIFY);'),
  },
  {
    nama: 'startServices() tidak dipanggil',
    why: 'Service HID tidak pernah di-start; host tidak pernah melihatnya.',
    mutasi: (c) => c.replace(/hid->startServices\s*\(\s*\)\s*;/, ''),
  },
  {
    nama: 'Report ID dibuang dari payload (dikembalikan ke bug v1)',
    why: 'Bug v1: map menyebut Report ID tapi payload 8 byte tanpanya.',
    mutasi: (c) => c
      .replace(/r\.reportId\s*=\s*REPORT_ID_KEYBOARD\s*;/, '')
      .replace(/r\.reportId;\s*uint8_t\s+modifiers;/, 'uint8_t modifiers;'),
  },
  {
    nama: 'Report ID di map diubah jadi 0x10 (tidak cocok dengan payload)',
    why: 'v1: map 0x85,0x10 tapi payload tanpa Report ID. Bolak-balik dari v1.',
    mutasi: (c) => c.replace(/0x85,\s*0x01,(\s*\/\/[^\n]*)/, '0x85, 0x10,$1'),
  },
  {
    nama: 'payload jadi 8 byte (tanpa Report ID)',
    why: 'Bentuk literal bug v1.',
    mutasi: (c) => c.replace(/struct\s+KbdReport\s*\{[\s\S]*?\};/,
      'struct KbdReport {\n  uint8_t modifiers;\n  uint8_t keys[6];\n};'),
  },
  {
    nama: 'UUID TX dan RX ditukar (arah NUS terbalik)',
    why: 'Companion akan menulis ke characteristic notify dan tidak pernahZQGMX.',
    // Menukar nilai UUID-nya saja sudah cukup untuk disimulasikan: ini yang
    // menentukan arah baca/tulis antara app dan device.
    mutasi: (c) => c
      .replace(/TX_UUID(\s*=\s*")6e400002/, 'TX_UUID$16e400003')
      .replace(/RX_UUID(\s*=\s*")6e400003/, 'RX_UUID$16e400002'),
  },
  {
    nama: 'TX characteristic tanpa PROPERTY_NOTIFY',
    why: 'Device tidak bisa memberi tahu app; subscribe tidak akan sampai.',
    mutasi: (c) => c.replace(
      /BLECharacteristic::PROPERTY_NOTIFY \| BLECharacteristic::PROPERTY_READ\)\s*;/,
      'BLECharacteristic::PROPERTY_READ);'),
  },
  {
    nama: 'UUID NUS service diubah (tidak cocok dengan ble.rs)',
    why: 'Companion app tidak akan pernah menemukan device.',
    mutasi: (c) => c.replace(/(SERVICE_UUID\s*=\s*")6e400001/, '$10000beef'),
  },
  {
    nama: 'g_serLine dipakai sebelum dideklarasikan',
    why: 'Compile error C++; pernah jadi masalah nyata di proyek ini.',
    mutasi: (c) => {
      // Pindahkan deklarasi ke bawah loopImpl.
      const decl = /static String g_serLine = "";\n/;
      const m = c.match(decl);
      if (!m) return c;
      return c.replace(decl, '').replace(/\nvoid setup\(\) \{/, '\nvoid setup() {\n' + m[0]);
    },
  },
  {
    nama: 'buffer baris Serial jadi tanpa batas',
    why: 'Data mengalir terus akan memakan RAM tanpa batas.',
    mutasi: (c) => c.replace(/else if \(g_serLine\.length\s*\(\s*\)\s*<\s*\d+\)\s*g_serLine\s*\+=\s*c;/,
      'else g_serLine += c;'),
  },
  {
    nama: 'pointer characteristic HID diganti lookup UUID per ketikan',
    why: 'Bug v1: alokasi + lookup di tengah koneksi.',
    mutasi: (c) => c.replace(/g_kbdReport->setValue\(\(uint8_t\*\)&r, sizeof\(r\)\);/,
      'BLEService* s = BLEDevice::getServer()->getServiceByUUID(BLEUUID("1812"));\n' +
      '  s->getCharacteristic(BLEUUID("2a4d"))->setValue((uint8_t*)&r, sizeof(r));'),
  },
  {
    nama: 'notifikasi NUS dikirim tanpa penjaga subscriber',
    why: 'Notify tanpa subscriber bisa memicu error pada stack NimBLE.',
    mutasi: (c) => c.replace(/if\s*\(\s*!\s*g_nusNotifyOn\s*\)\s*return\s*;/, ''),
  },
  {
    nama: 'delay 500ms ditambahkan di loop',
    why: 'Loop lambat; tidak ada yang merespons disconnect.',
    mutasi: (c) => c.replace(/delay\s*\(\s*5\s*\)\s*;\s*\}\s*$/m, 'delay(500);\n}\n'),
  },
  {
    nama: 'nama device diganti panjang dan ber-spasi',
    why: 'Nama panjang dipangkas Windows; bond lama tidak cocok.',
    mutasi: (c) => c.replace(/DEVICE_NAME\s*=\s*"MacroPad"/,
      'DEVICE_NAME = "MacroPad BLE Keyboard Experimental v2"'),
  },
  {
    nama: 'BLE2902 dikembalikan (deprecated di core 3.3.x)',
    why: 'Compile error/warning; CCCD dibuat otomatis NimBLE.',
    mutasi: (c) => c.replace(/(#include <BLESecurity\.h>)/,
      '$1\n#include <BLE2902.h>\nstatic BLE2902 g_cccd;'),
  },
  {
    nama: 'loop() dobel (redefinition)',
    why: 'Compile error.',
    mutasi: (c) => c + '\nvoid loop() { loopImpl(); }\n',
  },
  {
    nama: 'kurung kurawal tidak seimbang',
    why: 'Compile error.',
    mutasi: (c) => c + '\nvoid extraFunc() {\n',
  },
];

console.log(`Uji negatif untuk spike2-test.js`);
console.log(`sketch: ${SKETCH}`);
console.log(`total mutasi: ${MUTATIONS.length}\n`);

// Sanity check: dengan kode asli, test harus hijau. Kalau tidak, seluruh
// hasil di bawah tidak berarti apa-apa.
console.log('Baseline (kode asli, harus hijau):');
const base = runTest();
if (base.failed) {
  console.log('  FAIL test sudah gagal pada kode asli. Perbaiki test dulu.');
  fs.copyFileSync(BACKUP, SKETCH);
  process.exit(1);
}
console.log('  OK  hijau\n');

let detected = 0;
const undetected = [];
const invalid = [];

for (const mut of MUTATIONS) {
  const changed = mut.mutasi(original);

  // Kalau mutasi tidak mengubah apa pun, itu keliruAN pada daftar mutasi,
  // bukan pada test. Kalau diabaikan, jumlah "terdeteksi" jadi Rendezvous.
  if (changed === original) {
    console.log(`  ? ${mut.nama}\n      TIDAK BERUBAH - pola sumber tidak cocok. Perbaiki mutasi.`);
    undetected.push(mut.nama + ' (mutasi tidak mengubah berkas)');
    continue;
  }

  // Pengaman kedua yang ditemukan oleh uji ini sendiri: mutasi boleh saja
  // SUKAR mengubah berkas tapi hanya menyentuh KOMENTAR. spike2-test.js
  // membuang komentar sebelum memeriksa, jadi mutasi seperti itu tidak akan
  // pernah terdeteksi - dan akan dilaporkan sebagai "tidak terdeteksi",
  // padahal masalahnya ada di daftar mutasi, bukan di test.
  //
  // Karena itu: kalau isi kode (tanpa komentar) tidak berubah, mutasi dianggap
  // TIDAK VALID dan tidak dihitung sebagai deteksi либо kegagalan.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  if (strip(changed) === strip(original)) {
    console.log(`  ? ${mut.nama}\n      HANYA MENYENTUH KOMENTAR - mutasi tidak valid, diabaikan.`);
    invalid.push(mut.nama);
    continue;
  }

  fs.writeFileSync(SKETCH, changed, 'utf8');
  const res = runTest();

  if (res.failed) {
    detected++;
    // Ambil baris pesan gagalnya supaya terlihat DETEKSI-nya benar.
    const msg = (res.out.match(/^\s*-\s*(.+)$/m) || [])[1] || '(tanpa detail)';
    console.log(`  OK  terdeteksi: ${mut.nama}\n      -> ${msg.trim()}`);
  } else {
    console.log(`  FAIL TIDAK terdeteksi: ${mut.nama}\n      ${mut.why}`);
    undetected.push(mut.nama);
  }
}

// Selalu pulihkan, apa pun hasilnya.
fs.copyFileSync(BACKUP, SKETCH);
fs.unlinkSync(BACKUP);

const valid = MUTATIONS.length - invalid.length;

console.log(`\n${'='.repeat(60)}`);
console.log(`Uji negatif: ${detected}/${valid} mutasi valid terdeteksi` +
            (invalid.length ? ` (${invalid.length} mutasi tidak valid, diabaikan)` : ''));

if (invalid.length) {
  console.log('\nMutasi TIDAK VALID (hanya menyentuh komentar / pola tidak cocok):');
  for (const v of invalid) console.log('  - ' + v);
  console.log('\nDaftar mutasi harus diperbaiki - ini keliruAN pada harness,');
  console.log('bukan pada spike2-test.js.');
}

if (undetected.length) {
  console.log('\nMutasi yang TIDAK terdeteksi:');
  for (const u of undetected) console.log('  - ' + u);
  console.log('\nTest terlalu lemah. Perbaiki spike2-test.js, lalu ulangi.');
  process.exit(1);
}

if (invalid.length) {
  console.log('\nHarness mutasi masih punya yang tidak valid. Perbaiki lalu ulangi.');
  process.exit(1);
}

console.log('Semua mutasi valid terdeteksi.');