// Uji negatif untuk contract-advertising-test (F4 / C8).
//
// Yang diuji: advertising tidak pernah dimatikan, apa pun mode iface.
// Kalau dimatikan, device hilang dari daftar Bluetooth dan companion app
// tidak bisa menemukannya untuk mengirim PROTO:NUS.
//
// Jalankan: node tests/negative/negative-advertising.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { REPO, suite, mutate } from '../runner/paths.mjs';

const TEST = suite('contract-advertising-test.js');

const BLE = `${REPO}/firmware/common/ble_hid.h`;
const PROTO = `${REPO}/firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino`;

const files = [BLE, PROTO].map((f) => [f, fs.readFileSync(f, 'utf8')]);
const restore = () => { for (const [f, c] of files) fs.writeFileSync(f, c, 'utf8'); };

const cases = [
  {
    name: 'bleHidStop() mematikan advertising lagi',
    file: BLE,
    from: 'bleLog("Advertising tetap ON (mode USB) - device tetap bisa ditemukan");',
    to: 'adv->stop(); bleLog("Advertising dimatikan (mode USB)");',
  },
  {
    name: 'sketsh mematikan advertising saat boot di mode USB',
    file: PROTO,
    from: 'LOGS->printf("[IFACE] link awal: %s (ganti: IFACE:USB / IFACE:BLE)\\n", hidLinkName(g_hidLink));',
    to: 'if (g_hidLink == HidLink::USB) NimBLEDevice::getAdvertising()->stop();\n  LOGS->printf("[IFACE] link awal: %s (ganti: IFACE:USB / IFACE:BLE)\\n", hidLinkName(g_hidLink));',
  },
  {
    name: 'watchdog dibatasi mode BLE lagi',
    file: PROTO,
    from: 'if (bleHidConnected()) return;',
    to: 'if (g_hidLink != HidLink::BLE) return;\n  if (bleHidConnected()) return;',
  },
  {
    name: 'bleHidStart() tidak bisa restart advertising',
    file: BLE,
    from: '  if (adv != nullptr && !adv->isAdvertising()) {\n    adv->start(0);',
    to: '  if (adv != nullptr && !adv->isAdvertising()) {\n    // adv->start(0); // disabled',
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
console.log(`OK: ${caught}/${cases.length} regresi advertising terdeteksi`);

try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('OK: hijau lagi setelah dipulihkan');
} catch {
  console.log('MASALAH: guard masih gagal setelah semua dipulihkan');
  process.exit(2);
}
