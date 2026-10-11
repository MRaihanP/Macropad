// Guard untuk F5a (C7): batas chunk notify harus mengikuti MTU hasil negosiasi.
//
// Masalah yang dicegah: kalau Windows menawar MTU < 247, notify dengan
// hardcode 244 byte akan gagal diam-diam → jawaban DUMP terpotong → parser
// app desync tanpa error yang jelas.
//
// Jalankan: node tests/suites/contract-chunk-test.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const shared = read('firmware/common/ble_shared.h');
const hid = read('firmware/common/ble_hid.h');
const transport = read('firmware/common/transport_ble.h');
const hidCode = strip(hid);
const transportCode = strip(transport);

console.log('--- 1. Konstanta hardcode 244 sudah dihapus ---');
// Strip komentar dulu: nama BLE_NUS_MAX_CHUNK sengaja masih ada di komentar
// penjelas supaya orang tahu kenapa dihapus.
const sharedCode = strip(shared);
ok(!/BLE_NUS_MAX_CHUNK/.test(sharedCode),
  'ble_shared.h: tidak ada BLE_NUS_MAX_CHUNK di kode');
ok(!/BLE_NUS_MAX_CHUNK/.test(transportCode),
  'transport_ble.h: tidak memakai BLE_NUS_MAX_CHUNK');
ok(!/244/.test(transportCode),
  'transport_ble.h: tidak ada angka 244 (MTU - 3 bukan 244)');

console.log('\n--- 2. MTU hasil negosiasi disimpan ---');
ok(/bleAttMtu\s*=\s*mtu/.test(hidCode),
  'onMTUChange menyimpan mtu ke bleAttMtu');
ok(/static uint16_t bleAttMtu\s*=\s*23/.test(hidCode),
  'bleAttMtu default 23 (MTU minimum BLE)');
ok(/bleAttMtu\s*=\s*mtu/.test(hidCode),
  'bleAttMtu diisi dengan nilai MTU dari event');

console.log('\n--- 3. bleNusChunkLimit() diimplementasikan ---');
// Deklarasi ada di ble_shared.h, implementasi di ble_hid.h (karena butuh
// akses ke bleAttMtu yang private). Keduanya harus ada.
ok(/uint16_t bleNusChunkLimit\(\)/.test(strip(shared)),
  'ble_shared.h: bleNusChunkLimit() dideklarasikan');
ok(/inline uint16_t bleNusChunkLimit\(\)/.test(hidCode),
  'ble_hid.h: bleNusChunkLimit() diimplementasikan');
ok(/bleAttMtu\s*>\s*3/.test(hidCode),
  'chunk limit = MTU - 3 (ATT header)');
ok(/:\s*20/.test(hidCode),
  'fallback 20 byte kalau MTU <= 3');

console.log('\n--- 4. transport_ble.h memakai chunk limit dinamis ---');
ok(/bleNusChunkLimit\(\)/.test(transportCode),
  'write() memanggil bleNusChunkLimit()');
ok(/const uint16_t chunkMax = bleNusChunkLimit/.test(transportCode),
  'chunkMax diambil sekali per write()');
ok(/if \(n > chunkMax\) n = chunkMax/.test(transportCode),
  'chunk di-clamp ke chunkMax');

console.log('\n--- 5. Hanya ada satu definisi chunk limit ---');
// bleNusChunkLimit() dideklarasikan di ble_shared.h dan diimplementasikan
// di ble_hid.h. Tidak boleh ada definisi lain di header lain.
const allHeaders = ['ble_shared.h', 'ble_hid.h', 'transport_ble.h', 'hid_link.h', 'macropad_core.h']
  .map((f) => [f, strip(read(`firmware/common/${f}`))]);
for (const [nama, isi] of allHeaders) {
  const n = (isi.match(/bleNusChunkLimit/g) || []).length;
  if (nama === 'ble_shared.h') {
    ok(n === 1, `ble_shared.h: tepat 1 deklarasi (ditemukan ${n})`);
  } else if (nama === 'ble_hid.h') {
    ok(n === 1, `ble_hid.h: tepat 1 implementasi (ditemukan ${n})`);
  } else if (nama === 'transport_ble.h') {
    // transport_ble.h boleh MEMANGGIL, tidak boleh mendefinisikan.
    ok(n >= 1, `transport_ble.h: memakai bleNusChunkLimit() (ditemukan ${n})`);
    ok(!/uint16_t bleNusChunkLimit\(\)/.test(isi),
      'transport_ble.h: tidak mendefinisikan bleNusChunkLimit()');
  } else {
    ok(n === 0, `${nama}: tidak mendefinisikan bleNusChunkLimit()`);
  }
}

console.log('\n--- 6. Penjelasan ada ---');
ok(/MTU/.test(hidCode) && /247/.test(hidCode),
  'ble_hid.h menjelaskan kenapa 244 hardcode gagal');
ok(/chunk/.test(transportCode.toLowerCase()),
  'transport_ble.h menjelaskan chunking');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
