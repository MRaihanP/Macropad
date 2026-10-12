// Guard untuk perbaikan B1 (6 bug di src-tauri/src/ble.rs + lib.rs).
//
// Setiap bug di sini SEBELUMNYE hanya bisa ditemukan dengan device BLE di
// tangan dan وقت yang lama. Guard ini membacanya sebagai teks sumber, jadi
// regresi ketahuan seketika di `npm test`.
//
// Yang dijaga bukan "kode ini jalan", tapi "kode yang salah tidak kembali".
// Jalankan: node tests/suites/ble-rs-guard-test.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(a === b, `${m} (ditemukan ${JSON.stringify(a)}, diharapkan ${JSON.stringify(b)})`);

const ble = read('src-tauri/src/ble.rs');
const lib = read('src-tauri/src/lib.rs');
const bleCode = strip(ble);

console.log('--- 1. Scan memakai AQS yang benar ---');
// BUG 1: AQS "System.Devices.Aep.ProtocolId" berisi GUID PROTOKOL, bukan
// UUID service. Memasang UUID service ke sana tidak akan pernah cocok, jadi
// watcher tidak pernah memberi hasil apa pun.
//
// Dicari di KODE yang sudah dibuang komentarnya: nama itu sengaja masih
// ada di komentar supaya orang berikutnya tahu kenapa jalan ini salah.
ok(!/System\.Devices\.Aep\.ProtocolId/.test(bleCode),
  'tidak ada AQS ProtocolId yang disalahpakai untuk UUID service');
ok(/System\.Devices\.Aep\.ProtocolId/.test(ble),
  'nama yang salah itu masih dijelaskan di komentar (agar tidak diulang)');
ok(/GattDeviceService::GetDeviceSelectorFromUuid\s*\(\s*MACROPAD_SERVICE_UUID\s*\)/.test(ble),
  'scan memakai GattDeviceService::GetDeviceSelectorFromUuid(service uuid)');
ok(/GetDeviceSelectorFromUuid/.test(ble) && /MACROPAD_SERVICE_UUID/.test(ble),
  'UUID service yang dipakai adalah UUID NUS yang benar');

console.log('\n--- 2. Connect tidak scan ulang ---');
// BUG 2: connect() memanggil scan() sekali lagi selama 5 detik, padahal hasil
// scan pertama dibuang. Kalau device tidak sedang advertising, hasilnya nol
// dan connect selalu gagal dengan "Device not found".
ok(!/BleTransport::scan\(\)\s*\n?\s*\.and_then/.test(lib),
  'connect() tidak langsung scan lalu cari id (pola scan().and_then)');
ok(/let mut discovered\s*:\s*Vec<DeviceInformation>/.test(lib),
  'worker menyimpan DeviceInformation hasil scan');
ok(/discovered\s*=\s*devices/.test(lib),
  'hasil scan disimpan ke cache');
ok(/let found = discovered\s*\n?\s*\.iter\(\)/.test(lib),
  'connect mencari device di cache, bukan scan baru');
// Penjaga tambahan: apa pun bentuknya, connect() tidak boleh memanggil scan()
// di jalur penentuan device - itu tanda regression ke perilaku lama.
const connectArm = lib.slice(
  lib.indexOf('BleRequest::Connect'),
  lib.indexOf('BleRequest::Disconnect')
);
const scanCalls = (connectArm.match(/BleTransport::scan\(\)/g) || []).length;
ok(scanCalls <= 1,
  `connect() memanggil scan() paling banyak sekali, hanya sebagai fallback (terhitung ${scanCalls})`);

console.log('\n--- 3. Write memakai WriteWithResponse ---');
// BUG 3: WriteWithoutResponse tidak punya flow control, jadi packet bisa
// hilang tanpa error. Untuk perintah protokol seperti SET:0:0:0:KEY:a itu
// berarti config tidak tersimpan dan app tidak pernah tahu.
ok(!/GattWriteOption::WriteWithoutResponse/.test(bleCode),
  'tidak ada WriteWithoutResponse (perintah bisa hilang senyap)');
ok(/GattWriteOption::WriteWithResponse/.test(bleCode),
  'write memakai WriteWithResponse');

console.log('\n--- 4. is_connected() membaca status link sungguhan ---');
// BUG 4: is_connected() hanya membaca flag lokal yang diset true saat
// connect() dan tidak pernah disentuh lagi. Kalau Windows memutus koneksi,
// app masih mengira device tersambung dan semua write diam-diam gagal.
const isConn = ble.slice(ble.indexOf('pub fn is_connected'));
const isConnBody = isConn.slice(0, isConn.indexOf('\n    }') + 6);
ok(/self\.connected/.test(isConnBody),
  'cek flag lokal dulu (murah, short-circuit)');
ok(/ConnectionStatus\s*\(\s*\)/.test(isConnBody),
  'is_connected() juga membaca ConnectionStatus dari Windows');
ok(/BluetoothConnectionStatus::Connected/.test(isConnBody),
  'status dibandingkan terhadap Connected');
// Yang harus dicek: tidak boleh ada jalan yang mengembalikan flag lokal
// sebelum status Windows dibaca. `if true { return self.connected; }` terlihat
// seperti-flag-lokal-polos kalau guard hanya mencai kata "self.connected".
ok(!/return\s+self\.connected\s*;/.test(isConnBody),
  'tidak ada return flag lokal sebelum status link dicek');
ok(!/^\s*pub fn is_connected\(&self\) -> bool \{\s*self\.connected\s*\}/m.test(ble),
  'is_connected() bukan lagi cuma flag lokal');

console.log('\n--- 5. disconnect() melepas semua handle ---');
// BUG 5: disconnect() tidak men-null CCCD dan tidak Close() service, sehingga
// Windows menahan handle dan connect berikutnya bisa gagal.
const disc = ble.slice(ble.indexOf('pub fn disconnect'));
const jsDisc = disc.slice(0, disc.indexOf('\n    }') + 6);
ok(/RemoveValueChanged/.test(jsDisc), 'langganan event ValueChanged dilepas');
ok(/GattClientCharacteristicConfigurationDescriptorValue::None/.test(jsDisc),
  'CCCD dinolkan (device tahu tidak ada yang mendengarkan)');
ok(/service\.Close\(\)|Close\(\)/.test(jsDisc),
  'handle service GATT ditutup');
ok(/service:\s*Option<GattDeviceService>/.test(ble),
  'transport menyimpan handle service');
ok(/self\.service = Some\(service\)/.test(ble),
  'service disimpan saat connect');

console.log('\n--- 6. Baca bulk dengan batas buffer ---');
// BUG 6: read() mengambil SATU byte per panggilan, jadi satu jawaban DUMP
// yang ratusan byte butuh ratusan round-trip WinRT. Selain itu buffer RX
// tidak punya batas dan tumbuh tanpa akhir kalau frontend berhenti mengaji.
ok(/pub fn read_bulk\s*\(\s*&mut self\s*,\s*max_len\s*:\s*usize\s*\)\s*->\s*Vec<u8>/.test(ble),
  'ada read_bulk(max_len) -> Vec<u8>');
ok(/t\.read_bulk\(max_len\)/.test(lib),
  'command ble_read memakai read_bulk');
ok(!/for _ in 0\.\.n\s*\{\s*\n\s*let b = t\.read\(\)/.test(lib),
  'tidak ada loop per-byte di command Read');
const RX_MAX = 256 * 1024;
ok(ble.includes('RX_BUFFER_MAX') && ble.includes(String(RX_MAX).replace('262144', '256 * 1024')),
  `buffer RX dibatasi ${RX_MAX} byte`);

console.log('\n--- 7. Penjelasan ada di kode ---');
// Aturan proyek: alasan tidak boleh hanya ada di kepala-peak orang yang
// menulisnya. Kalau penjelasannya hilang, orang berikutnya "memperbaiki"
// kembali ke versi yang salah.
ok(/PROTOKOL/.test(ble) && /GetDeviceSelectorFromUuid/.test(ble),
  'ada komentar kenapa ProtocolId salah');
ok(/flow control|WriteWithoutResponse/.test(ble),
  'ada penjelasan kenapa bukan WriteWithoutResponse');
ok(/ConnectionStatus|rusak|sleep/.test(ble),
  'ada penjelasan kenapa is_connected() harus cek status link');

console.log('\n--- 8. Jalur END-TO-END: notify (Rust) -> buffer -> tarikan (frontend) ---');
// BUG 8 (paling fatal dari semua yang pernah ditemukan di repo ini):
// firmware notify -> handler di ble.rs menaruh byte ke rx_buffer. Tapi TIDAK ADA
// frontend yang memanggil ble_read. Buffer itu tidak pernah dikosongkan, jadi
// handleLine() di protocol-parser tidak pernah dipanggil, dan companion app
// diam saja: tidak ada INFO, tidak ada preset, tidak ada apa pun - padahal
// GATT-nya tersambung dan notify-nya jalan.
//
// Gejalanya persis seperti yang dilaporkan user ("preset dan informasi tidak
// diterima"), padahal penyebabnya ada di frontend, bukan di pairing atau
// karakteristik GATT.
const bleJs = read('src/ble-transport.js');
ok(/invoke\('ble_read'/.test(bleJs),
  'frontend memanggil ble_read (satu-satunya jalan keluar dari rx_buffer Rust)');
ok(/READ_POLL_MS\s*=\s*40/.test(bleJs),
  'jeda tarik jauh di bawah poll koneksi serial 2 detik');
ok(/#readPoll masih 2 detik/.test(bleJs) === false,
  'bukan 2 detik: UI akan terasa macet padahal device sehat');
ok(/handleIncomingChunk/.test(bleJs) && /TextDecoder/.test(bleJs),
  'byte dari ble_read didekode dan masuk framing baris');
// Loop pembacaan harus hidup di connect() dan mati di SEMUA jalur keluar.
const jsConn = bleJs.match(/export async function connect[\s\S]*?\n\}/);
ok(jsConn && /startReadLoop\(\)/.test(jsConn[0]),
  'loop pembacaan dinyalakan di connect()');
const bleJsDisc = bleJs.match(/export async function disconnect[\s\S]*?\n\}/);
ok(bleJsDisc && /stopReadLoop\(\)/.test(bleJsDisc[0]),
  'loop pembacaan dimatikan di disconnect()');
ok(/handleDeviceLost[\s\S]*?stopReadLoop\(\)/.test(bleJs),
  'loop pembacaan dimatikan juga di handleDeviceLost()');
// Tanpa latch readBusy, poll 40 ms bisa tumpang tindih dan merebut buffer.
ok(/readBusy/.test(bleJs),
  'ada latch readBusy (poll cepat bisa tumpang tindih tanpa itu)');

console.log('\n--- 9. Perintah dari app ke firmware harus berakhir newline ---');
// BUG 9: firmware hanya menjalankan handleSerialCommand() saat menerima '\n'.
// ble_switch_interface mengirim "IFACE:USB" polos, jadi perintahnya menggantung
// di serialLine[] dan tidak pernah dieksekusi - tanpa error apa pun.
const rsSwitch = lib.match(/async fn ble_switch_interface[\s\S]*?\n\}/);
ok(!!rsSwitch, 'ble_switch_interface terambil');
if (rsSwitch) {
  ok(/"IFACE:USB\\n"/.test(rsSwitch[0]), 'IFACE:USB dikirim dengan newline');
  ok(/"IFACE:BLE\\n"/.test(rsSwitch[0]), 'IFACE:BLE dikirim dengan newline');
}
ok(/newline WAJIB ikut terkirim/.test(lib) || /hanya menjalankan[\s\S]*?handleSerialCommand/.test(lib),
  'ada penjelasan kenapa newline wajib');

console.log('\n--- 10. UUID dan nama field sama di kedua sisi ---');
// Field snake_case dari serde: frontend harus membacanya apa adanya.
ok(/is_paired:\s*bool/.test(lib), 'BleDeviceInfo punya field is_paired (snake_case)');
ok(/isPaired:\s*!!d\.is_paired/.test(bleJs),
  'scan() memetakan is_paired (snake_case dari serde) -> isPaired');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
