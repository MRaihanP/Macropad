// Uji negatif untuk contract-hwinfo-test (F2 / C5).
//
// Yang diuji: HWINFO melaporkan iface=usb|ble dengan benar, dan field itu
// tidak merusak field yang sudah ada.
//
// Jalankan: node tests/negative/negative-hwinfo.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { REPO, suite, mutate } from '../runner/paths.mjs';

const TEST = suite('contract-hwinfo-test.js');

const CORE = `${REPO}/firmware/common/macropad_core.h`;
const LIMITS = `${REPO}/firmware/common/limits.h`;
const LINK = `${REPO}/firmware/common/hid_link.h`;

const files = [CORE, LIMITS, LINK].map((f) => [f, fs.readFileSync(f, 'utf8')]);
const restore = () => { for (const [f, c] of files) fs.writeFileSync(f, c, 'utf8'); };

const cases = [
  {
    name: 'iface= dihapus dari HWINFO (app jadi tidak tahu mode HID)',
    file: CORE,
    from: ',simulated=%d,iface=%s,proto=%s\r\n",',
    to: ',simulated=%d,proto=%s\r\n",',
  },
  {
    name: 'iface diisi string hardcode (selalu "usb" walau mode BLE)',
    file: CORE,
    from: 'HW_DATA_SIMULATED,\r\n                  hidLinkName(g_hidLink), protoLinkName(g_protoLink));\r\n    return',
    to: 'HW_DATA_SIMULATED,\r\n                  "usb");\r\n    return',
  },
  {
    name: 'iface kembali huruf besar (app harus normalisasi)',
    file: LIMITS,
    from: 'return (l == HidLink::BLE) ? "ble" : "usb";',
    to: 'return (l == HidLink::BLE) ? "BLE" : "USB";',
  },
  {
    name: 'hidLinkName didefinisikan ulang di hid_link.h (redefinition)',
    file: LINK,
    from: 'HidLink g_hidLink = (HidLink)HID_LINK_DEFAULT;',
    to: 'HidLink g_hidLink = (HidLink)HID_LINK_DEFAULT;\ninline const char* hidLinkName(HidLink l) { return "usb"; }',
  },
  {
    name: 'proto= muncul di HWINFO (F2 mengerjakan langkah F3)',
    file: CORE,
    from: ',iface=%s,proto=%s\r\n",',
    to: ',iface=%s,proto=%s,foo=%s\r\n",',
  },
  {
    name: 'field lama rgbSlots dihapus (ganti nama tanpa alasan)',
    file: CORE,
    from: 'rgb=%d,rgbSlots=%d,',
    to: 'rgb=%d,',
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
console.log(`OK: ${caught}/${cases.length} regresi HWINFO terdeteksi`);

try {
  execFileSync('node', [TEST], { stdio: 'pipe' });
  console.log('OK: hijau lagi setelah dipulihkan');
} catch {
  console.log('MASALAH: guard masih gagal setelah semua dipulihkan');
  process.exit(2);
}