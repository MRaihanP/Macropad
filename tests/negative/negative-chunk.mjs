// Uji negatif untuk contract-chunk-test (F5a / C7).
//
// Yang diuji: batas chunk notify mengikuti MTU hasil negosiasi, bukan
// konstanta hardcode 244.
//
// Jalankan: node tests/negative/negative-chunk.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { REPO, suite, mutate } from '../runner/paths.mjs';

const TEST = suite('contract-chunk-test.js');

const SHARED = `${REPO}/firmware/common/ble_shared.h`;
const HID = `${REPO}/firmware/common/ble_hid.h`;
const TRANSPORT = `${REPO}/firmware/common/transport_ble.h`;

const files = [SHARED, HID, TRANSPORT].map((f) => [f, fs.readFileSync(f, 'utf8')]);
const restore = () => { for (const [f, c] of files) fs.writeFileSync(f, c, 'utf8'); };

const cases = [
  {
    name: 'BLE_NUS_MAX_CHUNK 244 kembali (hardcode)',
    file: SHARED,
    from: 'extern uint16_t bleNusChunkLimit();',
    to: '#define BLE_NUS_MAX_CHUNK 244\nextern uint16_t bleNusChunkLimit();',
  },
  {
    name: 'onMTUChange membuang nilai MTU lagi',
    file: HID,
    from: 'bleAttMtu = mtu;',
    to: '// bleAttMtu = mtu; // discarded',
  },
  {
    name: 'transport pakai hardcode 244 lagi',
    file: TRANSPORT,
    from: 'const uint16_t chunkMax = bleNusChunkLimit();',
    to: 'const uint16_t chunkMax = 244;',
  },
  {
    name: 'chunk limit tidak dikurangi 3 (ATT header)',
    file: HID,
    from: 'return (bleAttMtu > 3) ? (uint16_t)(bleAttMtu - 3) : 20;',
    to: 'return bleAttMtu;',
  },
  {
    name: 'default MTU 0 (chunk limit jadi 0)',
    file: HID,
    from: 'static uint16_t bleAttMtu = 23;',
    to: 'static uint16_t bleAttMtu = 0;',
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
    const line = out.split('\n').find((l) => l.includes('FAIL'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 90)}`);
  }

  restore();
  if (!hit) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  caught += hit ? 1 : 0;
}

const pulih = files.every(([f, c]) => fs.readFileSync(f, 'utf8') === c);
console.log(pulih ? '\nOK: semua berkas pulih utuh' : '\nMASALAH: ada berkas yang tidak pulih');

if (caught !== cases.length) {
  console.log(`MASALAH: hanya ${caught}/${cases.length} regresi terdeteksi`);
  process.exit(2);
}
console.log(`OK: ${caught}/${cases.length} regresi chunk-limit terdeteksi`);

try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('OK: hijau lagi setelah dipulihkan');
} catch {
  console.log('MASALAH: guard masih gagal setelah semua dipulihkan');
  process.exit(2);
}
