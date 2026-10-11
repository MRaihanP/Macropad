// Uji negatif untuk contract-logpath-test (F1 / C10).
//
// Membalik pemisahan log-vs-protokol dengan cara yang paling mungkin terjadi
// nanti: ada yang "memperbaiki" satu baris log dan menulisnya pakai SERIAL-
// lagi. Kalau itu tidak ketahuan, NUS akan mencemari stream protokol.
//
// Jalankan: node tests/negative/negative-logpath.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { REPO, suite, mutate } from '../runner/paths.mjs';

const TEST = suite('contract-logpath-test.js');

const HID = `${REPO}/firmware/common/ble_hid.h`;
const DIAG = `${REPO}/firmware/common/ble_diag.h`;
const LINK = `${REPO}/firmware/common/hid_link.h`;
const CORE = `${REPO}/firmware/common/macropad_core.h`;
const SKETCH = `${REPO}/firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino`;

const files = [HID, DIAG, LINK, CORE, SKETCH]
  .map((f) => [f, fs.readFileSync(f, 'utf8')]);
const restore = () => { for (const [f, c] of files) fs.writeFileSync(f, c, 'utf8'); };

const cases = [
  {
    name: 'log [BLE] di ble_hid.h dikembalikan ke SERIAL->',
    file: HID,
    from: 'LOGS->printf("[BLE] %s\\n", msg);',
    to: 'SERIAL->printf("[BLE] %s\\n", msg);',
  },
  {
    name: 'status IFACE di ble_diag.h dikembalikan ke SERIAL->',
    file: DIAG,
    from: 'LOGS->printf("IFACE:link=%s,conn=%d,adv=%u,scan=%u,nus_sub=%u,nus_wr=%u\\n",',
    to: 'SERIAL->printf("IFACE:link=%s,conn=%d,adv=%u,scan=%u,nus_sub=%u,nus_wr=%u\\n",',
  },
  {
    name: 'jejak input di hid_link.h dikembalikan ke SERIAL->',
    file: LINK,
    from: 'LOGS->printf("[IN:%s] %s %s\\n", hidLinkName(g_hidLink), what, detail);',
    to: 'SERIAL->printf("[IN:%s] %s %s\\n", hidLinkName(g_hidLink), what, detail);',
  },
  {
    // Membalik bug: respons protokol core diarahkan ke jalur log, sehingga
    // jawaban HWINFO tidak akan pernah sampai ke companion app.
    name: 'core menjawab HWINFO lewat LOGS (jawaban tidak sampai ke app)',
    file: CORE,
    from: 'SERIAL->printf("HWINFO:profile=%s,encoders=%d,statusLed=%d,rgb=%d,rgbSlots=%d,vdiv=%d,chg=%d,simulated=%d\\n",',
    to: 'LOGS->printf("HWINFO:profile=%s,encoders=%d,statusLed=%d,rgb=%d,rgbSlots=%d,vdiv=%d,chg=%d,simulated=%d\\n",',
  },
  {
    name: 'g_logTransport ikut dialihkan ke NUS (Serial Monitor mati)',
    file: SKETCH,
    from: 'Transport* g_logTransport = &g_usbTransport;',
    to: 'Transport* g_logTransport = &BleNus;',
  },
  {
    name: 'LOG dikira jalur baca protokol',
    file: HID,
    from: 'LOGS->printf("[BLE] Putus (reason=0x%X)\\n", reason);',
    to: 'SERIAL->printf("[BLE] Putus (reason=0x%X)\\n", reason);\n  LOGS->available();',
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
console.log(`OK: ${caught}/${cases.length} regresi log-path terdeteksi`);

try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('OK: hijau lagi setelah dipulihkan');
} catch {
  console.log('MASALAH: guard masih gagal setelah semua dipulihkan');
  process.exit(2);
}
