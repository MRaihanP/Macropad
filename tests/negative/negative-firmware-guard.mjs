// Uji negatif: kembalikan tiga bug yang baru saja menggagalkan kompilasi,
// pastikan guard menangkapnya.
import fs from 'fs';
import { REPO, SUITES_DIR, suite } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';

const TEST = suite('firmware-compile-guard-test.js');
const targets = {
  limits: 'firmware/common/limits.h',
  transport: 'firmware/common/transport.h',
  usb: 'firmware/common/transport_usb.h',
};
const orig = {};
for (const [k, v] of Object.entries(targets)) orig[k] = fs.readFileSync(v, 'utf8');

const restore = () => { for (const [k, v] of Object.entries(targets)) fs.writeFileSync(v, orig[k], 'utf8'); };

const cases = [
  {
    name: 'BUG 1a: enumerator kembali bernama TRANSPORT_USB (bentrok makro)',
    file: 'transport',
    from: '  TP_USB = 0,    // USB CDC (Serial)',
    to: '  TRANSPORT_USB = 0,    // USB CDC (Serial)',
  },
  {
    name: 'BUG 1b: enumerator kembali bernama TRANSPORT_BLE (bentrok makro)',
    file: 'transport',
    from: '  TP_BLE = 1,    // BLE GATT',
    to: '  TRANSPORT_BLE = 1,    // BLE GATT',
  },
  {
    name: 'BUG 2a: #undef SERIAL dihapus (memperbaiki SERIAL redefined)',
    file: 'transport',
    from: '#ifdef SERIAL\n#undef SERIAL\n#endif\n#define SERIAL g_transport',
    to: '#define SERIAL g_transport',
  },
  {
    name: 'BUG 3a: Serial.dtr() dipanggil lagi (protected di core 3.3.11)',
    file: 'usb',
    from: '    if (Serial) return true;',
    to: '    return Serial.dtr() || Serial.available() > 0;',
  },
  {
    name: 'BUG 3b: pemakai enum tidak ikut di-update (nama lama tertinggal)',
    file: 'usb',
    from: 'return TransportType::TP_USB;',
    to: 'return TransportType::TRANSPORT_USB;',
  },
];

let caught = 0;
for (const c of cases) {
  const p = targets[c.file];
  if (!orig[c.file].includes(c.from)) { console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`); restore(); process.exit(2); }
  fs.writeFileSync(p, orig[c.file].replace(c.from, c.to), 'utf8');
  let hit = false;
  try { execFileSync('node', [TEST], { stdio: 'pipe' }); }
  catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 88)}`);
  }
  restore();
  if (!hit) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  caught += hit ? 1 : 0;
}

console.log('\nOK: ketiga berkas pulih utuh' +
  (Object.keys(targets).every(k => fs.readFileSync(targets[k], 'utf8') === orig[k]) ? '' : ' (TIDAK)'));
if (caught !== cases.length) process.exit(2);
console.log(`OK: ${caught}/${cases.length} regresi terdeteksi`);
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
