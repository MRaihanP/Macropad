// Uji negatif untuk spike-test.js: sisipkan kesalahan kompilasi nyata,
// pastikan test menangkapnya.
import fs from 'fs';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';
import { execFileSync } from 'child_process';
import { REPO, SUITES_DIR } from '../runner/paths.mjs';

const TEST = `${SUITES_DIR}/spike-test.js`;
const target = 'firmware/spike_ble_hid/spike_ble_hid.ino';
const orig = fs.readFileSync(target, 'utf8');

const cases = [
  // --- Compile error nyata yang terjadi pada percobaan pertama ---
  {
    name: 'onWrite 3-argumen (API Bluedroid lama)',
    from: '  void onWrite(BLECharacteristic* ch) override {',
    to: '  void onWrite(BLECharacteristic* ch, uint8_t* data, size_t len) override {',
  },
  {
    name: 'createCharacteristic 3-argumen (tidak ada di core 3.3.x)',
    from: '      BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_WRITE);',
    to: `      BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_WRITE,
      BLECharacteristic::PROPERTY_READ);`,
  },
  {
    name: 'createDescriptor dipakai (BLEService tidak punya)',
    from: '  // TIDAK memakai createDescriptor() untuk CCCD: BLEService tidak punya',
    to: `  hid->createDescriptor(BLEUUID("2902"), 1);
  // TIDAK memakai createDescriptor() untuk CCCD: BLEService tidak punya`,
  },
  {
    name: 'BLE2902 dipakai lagi (deprecated, warning)',
    from: '// Artinya: begitu characteristic punya PROPERTY_NOTIFY,,',
    to: '  g_nusTx->addDescriptor(new BLE2902());\n// Artinya: begitu characteristic punya PROPERTY_NOTIFY,,',
  },
  {
    name: 'BLE2902.h di-include lagi (warning)',
    from: '#include <BLEUtils.h>',
    to: '#include <BLEUtils.h>\n#include <BLE2902.h>',
  },
  {
    name: 'sendReport() tanpa argumen dipanggil lagi',
    from: "    usbKeyboard.print('a');\n",
    to: "    usbKeyboard.print('a');\n    usbKeyboard.sendReport();\n",
  },

  // --- Yang sudah ada sebelumnya ---
  {
    name: 'kurung kurawal tidak seimbang (compile error)',
    from: 'void setup() {',
    to: 'void setup() { {',
  },
  {
    name: 'void loop() hilang (Arduino tidak bisa jalan)',
    from: 'void loop() { loopImpl(); }',
    to: '// loop dihapus',
  },
  {
    name: 'dua void loop() (redefinition error)',
    from: 'void loop() { loopImpl(); }',
    to: 'void loop() { loopImpl(); }\nvoid loop() { loopImpl(); }',
  },
  {
    name: 'loopImpl() memanggil dirinya sendiri (rekursi tak hingga)',
    from: 'static void loopImpl() {',
    to: 'static void loopImpl() {\n  loopImpl();',
  },
  {
    name: 'UUID NUS tidak sama dengan ble.rs (app tidak akan menemukan device)',
    from: '"6e400001-b5a3-f393-e0a9-e50e24dcca9e"',
    to: '"6e400001-aaaa-ffff-e0a9-e50e24dcca9e"',
  },
  {
    name: 'TX UUID tidak sama dengan ble.rs',
    from: '"6e400002-b5a3-f393-e0a9-e50e24dcca9e"',
    to: '"6e400002-aaaa-ffff-e0a9-e50e24dcca9e"',
  },
  {
    name: 'PROPERTY_NOTIFY dihapus (subscribe tidak akan sampai)',
    from: 'BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);',
    to: 'BLECharacteristic::PROPERTY_READ);',
  },
  {
    name: 'service NUS tidak lagi cohabit dengan HID (server terpisah)',
    from: '  BLEService* nus = server->createService(BLEUUID(SERVICE_UUID), 12);',
    to: '  BLEServer* server2 = BLEDevice::createServer();\n  BLEService* nus = server2->createService(BLEUUID(SERVICE_UUID), 12);',
  },
  {
    name: 'laporan memori dihapus (tidak ada yang bisa dinilai)',
    from: 'ESP.getMinFreeHeap()',
    to: '0',
  },
  {
    name: 'delay panjang di loop (tombol terasa macet)',
    from: '  delay(10);',
    to: '  delay(5000);',
  },
  {
    name: 'tanpa tanda throwaway (bisa terbawa ke produksi)',
    from: 'THROWAWAY',
    to: 'production ready',
  },
];

let caught = 0;
for (const c of cases) {
  if (!orig.includes(c.from)) { console.log(`GAGAL: pola tidak ditemukan -> ${c.name}`); process.exit(2); }
  fs.writeFileSync(target, orig.replace(c.from, c.to), 'utf8');
  let hit = false;
  try { execFileSync('node', [TEST], { stdio: 'pipe' }); }
  catch (e) {
    hit = true;
    const out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    const line = out.split('\n').find(l => l.includes('FAIL')) ||
                 out.split('\n').find(l => l.includes('Error'));
    console.log(`OK  terdeteksi: ${c.name}`);
    if (line) console.log(`      -> ${line.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 90)}`);
  }
  fs.writeFileSync(target, orig, 'utf8');
  if (!hit) console.log(`MASALAH: TIDAK terdeteksi -> ${c.name}`);
  caught += hit ? 1 : 0;
}

fs.writeFileSync(target, orig, 'utf8');
console.log(fs.readFileSync(target, 'utf8') === orig ? '\nOK: spike pulih utuh' : '\nMASALAH: tidak pulih');
if (caught !== cases.length) process.exit(2);
console.log(`OK: ${caught}/${cases.length} regresi terdeteksi`);
try { execFileSync('node', [TEST], { stdio: 'pipe' }); console.log('OK: hijau lagi setelah dipulihkan'); }
catch { console.log('MASALAH: masih gagal'); process.exit(2); }
