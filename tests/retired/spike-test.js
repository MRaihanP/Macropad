// Memeriksa spike_ble_hid.ino secara statis.
//
// Spike ini tidak bisa di-compile di lingkungan build ini (tidak ada
// toolchain Arduino), jadi pemeriksaan berikut adalah satu-satunya jaring
// pengaman sebelum sketch masuk ke IDE.
//
// Yang diperiksa, dan alasannya:
//  - kurung kurawal seimbang           -> compile error pertama yang_TX_ok
//  - void setup() dan void loop() ada  -> Arduino memanggil keduanya
//  - TIDAK ADA dua loop()              -> redefinition error
//  - loop() memanggil loopImpl()       -> bukan loop kosong
//  - UUID NUS SAMA dengan ble.rs       -> kalau beda, app tidak akan
//                                          pernah menemukan device, dan itu
//                                          baru ketahuan saat pairing
//  - service HID + NUS di server sama  -> ini salah satu yang diuji spike
//  - tidak ada delay() besar di loop   -> loop beku = keypad tidak jalan
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const spikePath = path.join(root, 'firmware/spike_ble_hid/spike_ble_hid.ino');
const blePath = path.join(root, 'src-tauri/src/ble.rs');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

if (!fs.existsSync(spikePath)) {
  console.log('GAGAL: spike_ble_hid.ino tidak ada. Jalankan dari root repo.');
  process.exit(2);
}
const code = fs.readFileSync(spikePath, 'utf8');
const ble = fs.existsSync(blePath) ? fs.readFileSync(blePath, 'utf8') : '';

// Nama folder Arduino IDE harus sama dengan nama .ino, kalau tidak IDE
// tidak akan membuka sketch-nya.
const dirName = path.basename(path.dirname(spikePath));
const inoName = path.basename(spikePath, '.ino');
ok(dirName === inoName, `nama folder ("${dirName}") sama dengan nama .ino ("${inoName}")`);

console.log('\n--- A. Kurung kurawal seimbang ---');
// Buang string, char, dan komentar dulu supaya kurawal di dalamnya
// tidak dihitung.
const stripped = code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/"(\\.|[^"\\])*"/g, '""')
  .replace(/'(\\.|[^'\\])*'/g, "''");
let depth = 0, minDepth = 0;
for (const ch of stripped) {
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; }
}
ok(depth === 0, `kurawal seimbang (sisa ${depth})`);
ok(minDepth === 0, `tidak ada kurawal '}' berlebih (terendah ${minDepth})`);

console.log('\n--- B. Entry point Arduino ---');
ok(/^void setup\(\)\s*\{/m.test(code), 'ada void setup() di level teratas');
const loops = (code.match(/^(?:static\s+)?void loop\w*\s*\(\s*\)\s*\{/gm) || []);
ok(loops.length >= 1, `ada fungsi loop (${loops.length} ditemukan)`);
// Harus tepat satu yang bernama persis "loop" (yang dipanggil Arduino).
const exactLoop = loops.filter(l => /void loop\s*\(\s*\)/.test(l));
ok(exactLoop.length === 1, `tepat satu void loop() (ditemukan ${exactLoop.length}) - évite redefinition`);
ok(/void loop\(\)\s*\{\s*loopImpl\(\);/.test(code), 'loop() memanggil loopImpl()');
ok(/void loopImpl\(\)/.test(code) || /static void loopImpl\(\)/.test(code), 'loopImpl() terdefinisi');
ok(!/loopImpl\s*\(\s*\)\s*\{[^}]*loopImpl\s*\(/.test(code), 'loopImpl() tidak memanggil dirinya sendiri');

console.log('\n--- C. UUID NUS sama dengan ble.rs ---');
// Parse UUID dari spike (string) dan dari ble.rs (GUID heksadesimal).
const spikeUuids = [...code.matchAll(/"(6e40[0-9a-f]{4}-[0-9a-f-]+)"/g)].map(m => m[1].toLowerCase());
ok(spikeUuids.length === 3, `spike mendeklarasikan 3 UUID NUS (ditemukan ${spikeUuids.length})`);
if (ble) {
  // Di ble.rs: 0x6e40_0001 -> "6e400001-b5a3-f393-..."
  const guids = [...ble.matchAll(/GUID::from_values\(\s*0x([0-9a-fA-F_]+),\s*0x([0-9a-fA-F]+),\s*0x([0-9a-fA-F]+),\s*\[([^\]]+)\]/g)];
  ok(guids.length === 3, `ble.rs punya 3 GATT UUID (ditemukan ${guids.length})`);
  for (const g of guids) {
    const d1 = g[1].replace(/_/g, '').toLowerCase().padStart(8, '0');
    const d2 = g[2].toLowerCase().padStart(4, '0');
    const d3 = g[3].toLowerCase().padStart(4, '0');
    const tail = g[4].split(',').map(x => x.trim().replace(/^0x/, '').toLowerCase().padStart(2, '0'));
    const uuid = `${d1}-${d2}-${d3}-${tail.slice(0, 2).join('')}-${tail.slice(2).join('')}`;
    ok(spikeUuids.includes(uuid),
      `UUID ${uuid} dari ble.rs ada juga di spike (pakai service/TX/RX yang sama)`);
  }
  ok(/SERVICE_UUID[\s\S]{0,80}6e400001/.test(code) || /"6e400001/.test(code),
    'service UUID (6e400001-...) sama');
  ok(/"6e400002/.test(code) && /"6e400003/.test(code), 'TX (…002) dan RX (…003) sama');
}

console.log('\n--- D. Yang akan diuji spike ---');
ok(/createService\(BLEUUID\(HID_SVC\)/.test(code), 'membuat service HID (1812)');
ok(/createService\(BLEUUID\(SERVICE_UUID\)/.test(code), 'membuat service NUS di server yang sama');
// Satu BLEDevice::createServer() saja = satu server = dua service bisa cohabit.
const createServer = (code.match(/BLEDevice::createServer\(\)/g) || []).length;
ok(createServer === 1, `tepat satu createServer() (ditemukan ${createServer}) - dua service cohabit`);
ok(/BLEDevice::startAdvertising\(\)/.test(code), 'iklan BLE dijalankan');
ok(/setMTU\(517\)/.test(code), 'MTU diset ke 517 (report HID muat utuh)');
// CCCD tidak perlu dibuat manual: NimBLE menambahkannya otomatis begitu
// characteristic punya PROPERTY_NOTIFY. Yang penting NOTIFY itu ada.
//
// Dipakai kode bersih (tanpa komentar) karena penjelasan di komentar juga
// menyebut PROPERTY_NOTIFY - kalau tidak, test akan mencocokkan penjelasannya
// sendiri dan tetap hijau walau NOTIFY sudah dihapus dari kode.
const codeNoComment = code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const notifyCount = (codeNoComment.match(/PROPERTY_NOTIFY/g) || []).length;
const writeCount = (codeNoComment.match(/PROPERTY_WRITE\b/g) || []).length;

// Tepat DUA characteristic butuh NOTIFY: satu untuk HID report (device ->
// Windows) dan satu untuk NUS RX/TX (device -> app). Kalau hanya satu,
// karakter yang salah satu tidak akan bisa dipakai. Versi pertama memakai
// ">= 1" sehingga menghapus satu dari dua tetap hijau.
ok(notifyCount === 2,
  `tepat 2 characteristic punya NOTIFY - HID report dan NUS (ditemukan ${notifyCount})`);
// WRITE muncul di characteristic HID report (output report: keyboard
// memberi tahu host tentang LED) DAN di NUS TX (app -> device). Keduanya
// benar, jadi yang dijaga adalah NUS TX punya WRITE.
ok(/PROPERTY_WRITE\b[^;]*\);/.test(codeNoComment) &&
   /PROPERTY_WRITE_NR\s*\|\s*BLECharacteristic::PROPERTY_WRITE\)/.test(codeNoComment),
  'NUS TX punya WRITE (app -> device bisa mengirim perintah)');
ok(/PROPERTY_WRITE_NR/.test(codeNoComment),
  'NUS TX punya WRITE_NR (write tanpa response - lebih cepat untuk perintah)');

console.log('\n--- D2. API core ESP32 3.3.x (semua ini pernah jadi compile error) ---');
// Setiap item di bawah ini adalah error NYATA yang muncul saat user
// mencoba compile spike. Semuanya dicek terhadap header asli di
// Arduino15/packages/esp32/hardware/esp32/3.3.11/libraries/BLE/src.
const codeOnly = code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
ok(!/void onWrite\(BLECharacteristic\*\s*\w+,\s*uint8_t\*/.test(codeOnly),
  'onWrite() satu argumen - core 3.3.x tidak punya callback 3-argumen');
ok(/void onWrite\(BLECharacteristic\*\s*\w+\)\s*override/.test(codeOnly),
  'onWrite(BLECharacteristic*) override');
ok(!/createDescriptor\s*\(/.test(codeOnly),
  'tidak memakai createDescriptor() - BLEService tidak punya itu di core 3.3.x');
// createCharacteristic hanya menerima 2 argumen.
const createCalls = [...codeOnly.matchAll(/createCharacteristic\s*\(([\s\S]*?)\);/g)];
ok(createCalls.length >= 3, `createCharacteristic dipanggil ${createCalls.length} kali`);
for (const m of createCalls) {
  // Hitung koma di level teratas.
  const args = m[1];
  let depth = 0, commas = 0;
  for (const ch of args) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) commas++;
  }
  ok(commas === 1,
    `createCharacteristic punya 2 argumen (uuid, properties), ditemukan ${commas + 1}`);
}
ok(!/new BLE2902/.test(codeOnly),
  'tidak memakai BLE2902 - deprecated di core 3.3.x (NimBLE tambah CCCD otomatis)');
ok(!/#include\s*<BLE2902\.h>/.test(code),
  'BLE2902.h tidak di-include (hanya menghasilkan warning)');
ok(!/sendReport\s*\(\s*\)/.test(codeOnly),
  'tidak memanggil sendReport() tanpa argumen - overload-nya butuh KeyReport*');
ok(/usbKeyboard\.print\(/.test(codeOnly),
  'USB HID dikirim lewat print() yang sudah otomatis mengirim report');

console.log('\n--- E. Laporan yang harus dibaca setelah flash ---');
ok(/ESP\.getFreeHeap\(\)/.test(code), 'laporan free heap');
ok(/ESP\.getMinFreeHeap\(\)/.test(code), 'laporan min free heap (memori terendah, deteksi leak)');
ok(/getMaxAllocHeap/.test(code), 'laporan largest free block (fragmentasi)');
ok(/psramFound\(\)/.test(code), 'laporan keberadaan PSRAM');
ok(/getHeapSize\(\)/.test(code), 'laporan total heap');
ok(/NimBLE/.test(code), 'dokumentasikan cara memastikan core pakai NimBLE (bukan Bluedroid)');

console.log('\n--- F. Loop tidak memblokir ---');
// Loop spike boleh delaying, tapi hanya delay pendek. delay(5000) di loop
// akan membuat tombol terasa macet.
const loopStart = code.indexOf('static void loopImpl()');
const loopBody = loopStart > 0 ? code.slice(loopStart) : '';
const delays = [...loopBody.matchAll(/delay\((\d+)\)/g)].map(m => Number(m[1]));
const tooLong = delays.filter(d => d > 100);
ok(tooLong.length === 0,
  `tidak ada delay > 100ms di loop (ditemukan: ${tooLong.join(', ') || 'tidak ada'})`);

console.log('\n--- G. SPIKE benar-benar throwaway ---');
// Periksa penanda di blok header saja. Searching seluruh file akan salah:
// ada kata "THROWAWAY" di komentar bagian tengah yang bukan penanda utama.
const header = code.slice(0, Math.min(2000, code.length));
ok(/THROWAWAY/i.test(header), 'ditandai throwaway di blok header');
ok(/JANGAN menyalin kode ini ke firmware produksi/.test(code), 'ada peringatan jangan dipakai di produksi');
// Spike tidak boleh ter-sertakan ke firmware nyata: harus di folder sendiri
// yang namanya mengandung "spike", bukan di common/ atau folder profil.
const relPath = spikePath.replace(/\\/g, '/');
ok(/spike/i.test(relPath), 'berada di folder bernama "spike" (terpisah dari common/ dan folder profil)');
ok(!/firmware\/(common|HID_Keypad_)/.test(relPath), 'tidak berada di common/ atau folder profil');
// Spike tidak boleh ikut ter-sertakan ke firmware nyata: file-nya harus
// berada di folder terpisah, bukan di common/ atau folder profil.
ok(!/common/.test(spikePath.replace(/\\/g, '/')) || spikePath.includes('spike_ble_hid'),
  'berada di folder terpisah, tidak di common/ atau folder profil');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
