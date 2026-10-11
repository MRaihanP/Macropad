// Uji negatif untuk ble-rs-guard-test: kembalikan satu per satu dari 6 bug B1,
// pastikan guard benar-benar menangkap. Guard yang tidak pernah gagal tidak
// membuktikan apa pun.
//
// Jalankan: node tests/negative/negative-ble-rs-guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, suite, mutate } from '../runner/paths.mjs';

const TEST = suite('ble-rs-guard-test.js');

const BLE = `${REPO}/src-tauri/src/ble.rs`;
const LIB = `${REPO}/src-tauri/src/lib.rs`;

const files = { [BLE]: fs.readFileSync(BLE, 'utf8'), [LIB]: fs.readFileSync(LIB, 'utf8') };
const restore = () => {
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(f, c, 'utf8');
};

// Setiap mutasi mengembalikan satu bug B1 ke bentuk lamanya.
const cases = [
  {
    name: 'BUG 1: AQS ProtocolId (GUID protokol, bukan UUID service)',
    file: BLE,
    from: 'GattDeviceService::GetDeviceSelectorFromUuid(MACROPAD_SERVICE_UUID)',
    to: 'GUID_service_dummy()',
  },
  {
    // Membalik bug 2 berarti connect() kembali scanning sendiri alih-alih
    // memakai cache. Yang dirusak di sini adalah barrel yang searching-nya
    // diganti ke scan() langsung - persis bentuk yang dulu ada.
    name: 'BUG 2: connect() scan ulang 5 detik',
    file: LIB,
    from: 'let found = discovered',
    to: 'let found = BleTransport::scan().unwrap_or_default().iter()',
  },
  {
    name: 'BUG 3: WriteWithoutResponse (perintah bisa hilang senyap)',
    file: BLE,
    from: 'GattWriteOption::WriteWithResponse',
    to: 'GattWriteOption::WriteWithoutResponse',
  },
  {
    name: 'BUG 4: is_connected() cuma flag lokal',
    file: BLE,
    from: 'pub fn is_connected(&self) -> bool {',
    to: 'pub fn is_connected(&self) -> bool { if true { return self.connected; }',
  },
  {
    name: 'BUG 5: disconnect() tidak Close() service GATT',
    file: BLE,
    from: '            let _ = service.Close();',
    to: '            let _ = service;',
  },
  {
    name: 'BUG 6: baca per-byte + buffer tanpa batas',
    file: BLE,
    from: 'const RX_BUFFER_MAX: usize = 256 * 1024;',
    to: 'const RX_BUFFER_MAX: usize = usize::MAX;',
  },
];

let caught = 0;
for (const c of cases) {
  if (!mutate(c.file, c.from, c.to)) {
    console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`);
    restore();
    process.exit(2);
  }

  let hit = false;
  try {
    execFileSync('node', [TEST], { stdio: 'pipe' });
  } catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 90)}`);
  }

  restore();
  if (!hit) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  caught += hit ? 1 : 0;
}

const pulih = Object.entries(files).every(([f, c]) => fs.readFileSync(f, 'utf8') === c);
console.log(pulih ? '\nOK: kedua berkas pulih utuh' : '\nMASALAH: ada berkas yang tidak pulih');

if (caught !== cases.length) {
  console.log(`MASALAH: hanya ${caught}/${cases.length} regresi terdeteksi`);
  process.exit(2);
}
console.log(`OK: ${caught}/${cases.length} regresi B1 terdeteksi`);

try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('OK: hijau lagi setelah dipulihkan');
} catch {
  console.log('MASALAH: guard masih gagal setelah semua dipulihkan');
  process.exit(2);
}
