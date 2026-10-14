// Uji negatif: serial-transport.js (jalur USB) TIDAK BOLEH berubah.
//
// Latar belakang yang nyata: pada sesi sebelumnya, perubahan yang dimaksudkan
// untuk BLE ikut mengubah jalur USB, dan user melaporkan "USB ikut berubah".
// Test-suite biasa tidak menangkap itu - semua test tetap hijau, karena
// keduanya sama-sama punya test yang lulus.
//
// Jadi test iniini mengunci HAL SPECIFIK: kalau file USB berubah, test gagal
// dengan pesan yang menyebut file mana. Risiko regresi USB jadi terlihat
// OTOMATIS, bukan dari laporan user.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, suite } from '../runner/paths.mjs';

const CHECK = suite('import-cycle-check.mjs');
const FILE = path.join(REPO, 'src/serial-transport.js');
const orig = fs.readFileSync(FILE, 'utf8');

// Yang TIDAK boleh berubah di jalur USB. Semuanya adalah keputusan yang
// disengaja dan sudah diverifikasi:
//
//   USB_WRITE_CHUNK_MAX 4000 - USB CDC punya flow control, jadi write besar
//                              aman. Menurunkannya kembali ke 900 (nilai era
//                              BLE) cuma memperlambat.
//   port.write() menunggu   - inilah yang membuat USB tidak butuh watchdog
//   port.listen() mendorong - data masuk tanpa app harus menarik
//
// Kalau test ini gagal, periksa: apakah perubahan itu memang dimaksudkan
// untuk USB? Kalau tidak, kembalikan.
const MUST_STAY = [
  [/const USB_WRITE_CHUNK_MAX = 4000;/, 'batas write USB 4000 byte (bukan 900 warisan BLE)'],
  [/await port\.write\(str\);/, 'writeRaw() tetap menunggu (USB punya flow control)'],
  [/await port\.write\(str \+ "\\n"\);/, 'sendLine() tetap menunggu'],
  [/port\.listen\(\(data\) => handleIncomingChunk\(data\)\)/, 'data didorong via port.listen(), bukan dipoll'],
  [/export const isConnected = \(\) => !!port;/, 'isConnected() tetap membaca handle port'],
];

// Firmware TIDAK BOLEH memakai serial-transport.js (itulah TransportBase-nya),
// dan macropad_core.h TIDAK BOLEH memakai LOGS-> untuk pesan diagnostiik -
// USB dan LOGS adalah dua hal berbeda.
const CORE = path.join(REPO, 'firmware/common/macropad_core.h');
const core = fs.readFileSync(CORE, 'utf8');
const logsInCore = /(^|\n)[^/\n]*\bLOGS->/.test(core);
if (logsInCore) {
  console.log('MASALAH: macropad_core.h memakai LOGS-> - itu masuk stream protokol USB dan merusak parser');
  process.exit(2);
}

let bad = 0;
for (const [pat, msg] of MUST_STAY) {
  const ok = pat.test(orig);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!ok) bad++;
}

// Sanity: file harus bisa dibaca sebagai CommonJS-ish JS tanpa sindaks rusak.
try {
  new Function(orig.replace(/^\s*import[\s\S]*?;$/gm, '').replace(/^\s*export /gm, ''));
} catch (e) {
  console.log(`  FAIL serial-transport.js tidak bisa diparse: ${e.message}`);
  bad++;
}

// Cyclic-import guard tetap harus jalan (dipakai file lain juga, tapi dijaga
// di sini supaya kegagalan di negative-cycle tidak lolos diam-diam).
try {
  execFileSync('node', [CHECK], { stdio: 'pipe' });
  console.log('  OK   import-cycle-check tetap jalan');
} catch (e) {
  console.log('  FAIL import-cycle-check gagal dijalankan');
  bad++;
}

console.log(bad === 0
  ? '\nOK: jalur USB utuh - tidak ada perubahan yang tidak disengaja.'
  : `\n${bad} pemeriksaan gagal - jalur USB berubah.`);
process.exit(bad === 0 ? 0 : 1);
