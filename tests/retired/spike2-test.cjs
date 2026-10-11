/**
 * spike2-test.js — verifikasi statis untuk firmware/spike_ble_hid2/spike_ble_hid2.ino
 *
 *-oldsaya: spike_ble_hid (v1) gagal karena Windows: "pair berhasil, beberapa
 * detik kemudian disconnect sendiri, lalu tidak bisa connect lagi."
 *
 * Test ini memeriksa 5 kelas regresi yang bisa dibuktikan TANPA hardware,
 * semuanya dibaca dari header core Arduino ESP32 3.3.11 yang benar-benar
 * terpasang di mesin ini:
 *   %LOCALAPPDATA%\Arduino15\packages\esp32\hardware\esp32\3.3.11\libraries\BLE\src
 *
 * Kalau header core tidak ada, test SKIP dengan pesan jelas - bukan hijau
 * palsu. Test yang diam-diam tidak memeriksa apa pun lebih berbahaya
 * daripada test yang gagal.
 *
 * Jalankan:  node spike2-test.js   (dari root repo)
 */

const fs = require('node:fs');
const path = require('node:path');

// Test ini hidup di folder temp, bukan di dalam repo. Jadi ROOT tidak bisa
// diturunkan dari __dirname. Ambil dari argumen CLI, atau dari environment,
// atau fallback ke repo yang sedang dipakai git.
function findRepoRoot() {
  const candidates = [];
  if (process.argv[2]) candidates.push(process.argv[2]);
  if (process.env.MACROPAD_ROOT) candidates.push(process.env.MACROPAD_ROOT);
  candidates.push(process.cwd());

  for (const c of candidates) {
    const abs = path.resolve(c);
    // Repo ditandai oleh kombinasi berkas ini: paket npm + crate Tauri.
    if (fs.existsSync(path.join(abs, 'package.json')) &&
        fs.existsSync(path.join(abs, 'src-tauri', 'src', 'ble.rs'))) {
      return abs;
    }
  }
  return null;
}

const ROOT = findRepoRoot();
const SKETCH = path.join(ROOT, 'firmware', 'spike_ble_hid2', 'spike_ble_hid2.ino');
const RUST_BLE = path.join(ROOT, 'src-tauri', 'src', 'ble.rs');

const CORE_BLE = path.join(
  process.env.LOCALAPPDATA || '',
  'Arduino15', 'packages', 'esp32', 'hardware', 'esp32', '3.3.11',
  'libraries', 'BLE', 'src'
);

let pass = 0, fail = 0;
const problems = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; problems.push(`${name}${detail ? ' -> ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`); }
}

function section(t) { console.log(`\n=== ${t} ===`); }

// ---------------------------------------------------------------------------
// 0. Prasyarat
// ---------------------------------------------------------------------------
section('0. Prasyarat berkas');

if (!ROOT) {
  console.log('  FAIL root repo tidak ditemukan. Jalankan dari root repo,');
  console.log('       atau: node spike2-test.js <path ke repo>');
  process.exit(1);
}
console.log(`  repo root: ${ROOT}`);

if (!fs.existsSync(SKETCH)) {
  console.log(`  FAIL sketch tidak ditemukan: ${SKETCH}`);
  process.exit(1);
}
ok('sketch spike_ble_hid2 ada', true);

const coreAvailable = fs.existsSync(CORE_BLE) && fs.existsSync(path.join(CORE_BLE, 'BLEServer.cpp'));
if (!coreAvailable) {
  console.log('\nSKIP: header core Arduino BLE tidak ditemukan di:');
  console.log('      ' + CORE_BLE);
  console.log('Verifikasi terhadap header core tidak bisa dilakukan.');
  console.log('Sisakan pemeriksaan lokal yang tidak butuh core.');
  process.exit(1);
}
ok('header core BLE 3.3.11 tersedia', true);

const src = fs.readFileSync(SKETCH, 'utf8');

// Buang komentar dan string supaya pemeriksaan tidak bisa cocok dengan teks
// penjelasan di komentar. Persis seperti spike-test.js v1: komentar berisi
// pola yang sama persis dengan kode, jadi kalau tidak dibuang test ini
// akan selalu hijau tanpa memeriksa apa pun.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}
const code = stripComments(src);

function countBraces(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) return -1;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// 1. Regresi v1: advertising mati permanen setelah disconnect
// ---------------------------------------------------------------------------
section('1. Regresi utama v1: advertiseOnDisconnect');

const serverCpp = fs.readFileSync(path.join(CORE_BLE, 'BLEServer.cpp'), 'utf8');

// Buktikan dulu bahwa default core memang false. Kalau ini tidak lagi benar,
//Means dari core berubah dan spike harus disesuaikan — test gagal lebih baik
// daripada diam-diam tidak berlaku.
ok('core: default m_advertiseOnDisconnect = false (dasar$v1)',
   /m_advertiseOnDisconnect\s*=\s*false/.test(serverCpp));

ok('core: advertising hanya di-restart kalau flag itu true',
   /if\s*\(\s*server->m_advertiseOnDisconnect\s*\)/.test(serverCpp));

// PENTING: periksa bahwa flag benar-benar di-set true, bukan sekadar ada
// panggilan advertiseOnDisconnect sama sekali. Versi pertama pemeriksaan ini
// hanya mencari "advertiseOnDisconnect(" sehingga advertiseOnDisconnect(false)
// ikut hijau - padahal itu persis kondisi yang membuat v1 gagal.
// Uji negatif mengonfirmasi: dengan pemeriksaan lemah ini, mutasi
// advertiseOnDisconnect(false) TIDAK terdeteksi.
ok('spike memanggil advertiseOnDisconnect(true) - nilai diverifikasi',
   /advertiseOnDisconnect\s*\(\s*true\s*\)(?!\s*["'])/.test(code));

// Dan tidak boleh ada panggilan dengan nilai lain di mana pun.
const otherFlags = [...code.matchAll(/advertiseOnDisconnect\s*\(\s*([^)]*)\)/g)]
  .map(m => m[1].trim())
  .filter(v => v !== 'true');
ok('tidak ada advertiseOnDisconnect dengan nilai selain true',
   otherFlags.length === 0, otherFlags.join(', '));

// Pengaman lapis kedua: onDisconnect harus juga memanggil startAdvertising.
ok('onDisconnect juga memanggil startAdvertising (jaring kedua)',
   /onDisconnect[\s\S]{0,600}?startAdvertising\s*\(\s*\)/.test(code));

// Dan watchdog: kalau semua gagal, tetap ada yang menghidupkan advertise.
ok('watchdog menghidupkan advertising saat belum terhubung',
   /!g_connected[\s\S]{0,400}?startAdvertising\s*\(\s*\)/.test(code));

ok('ada kelas BLEServerCallbacks (v1 tidak punya sama sekali)',
   /class\s+\w+\s*:\s*public\s+BLEServerCallbacks/.test(code));

// ---------------------------------------------------------------------------
// 2. Regresi v1: passkey acak yang regenerate + force authentication
// ---------------------------------------------------------------------------
section('2. Regresi v1: security configuration');

ok('memakai advertiseOnDisconnect, bukan deleteBond yang tidak ada',
   !/deleteBond/.test(code));

ok('memakai BLESecurity dengan mode Just Works (bonding, tanpa MITM, dengan SC)',
   /setAuthenticationMode\s*\(\s*true\s*,\s*false\s*,\s*true\s*\)/.test(code));

ok('IOCapability = NONE (Just Works)',
   /setCapability\s*\(\s*ESP_IO_CAP_NONE\s*\)/.test(code));

// Tiga ini justru PENYEBAB v1. Semuanya harus hilang.
ok('TIDAK ada setPassKey (v1 memaksa passkey yang tak pernah dipakai)',
   !/setPassKey\s*\(/.test(code));

ok('TIDAK ada regenPassKeyOnConnect (v1 merusak bond tiap connect)',
   !/regenPassKeyOnConnect\s*\(/.test(code));

ok('TIDAK ada setForceAuthentication (v1 memutus link saat security dipaksa)',
   !/setForceAuthentication\s*\(/.test(code));

// Just Works berarti passkey tidak boleh muncul di mana pun.
ok('tidak mencetak passkey ke Serial (Just Works tidak punya passkey)',
   !/getPassKey|onPassKeyNotify\s*\([^)]*\)\s*\{[^}]*Serial/.test(code));

// ---------------------------------------------------------------------------
// 3. Regresi v1: service HID tidak lengkap
// ---------------------------------------------------------------------------
section('3. Regresi v1: service HID wajib');

const hidCpp = fs.readFileSync(path.join(CORE_BLE, 'BLEHIDDevice.cpp'), 'utf8');

// Buktikan characteristic wajib benar-benar ada di core, supaya spike yang
// memakainya benar-benar mendapat semuanya.
for (const [uuid, label] of [['2a4a', 'HID Information'], ['2a4b', 'Report Map'],
                             ['2a4c', 'HID Control Point'], ['2a4e', 'Protocol Mode'],
                             ['2a50', 'PnP ID']]) {
  ok(`core: BLEHIDDevice membuat ${uuid} (${label})`,
     new RegExp(`0x${uuid}`).test(hidCpp));
}

ok('spike memakai kelas BLEHIDDevice (bukan bangun service sendiri)',
   /new\s+BLEHIDDevice\s*\(/.test(code));

ok('spike memanggil hid->startServices()', /startServices\s*\(\s*\)/.test(code));

ok('spike mengatur report map', /reportMap\s*\(/.test(code));
ok('spike mengatur PnP ID', /\bpnp\s*\(/.test(code));
ok('spike mengatur HID info', /hidInfo\s*\(/.test(code));

// v1 membuat 1812 + 2a4d langsung. Kalau pola itu muncul lagi, berarti
// berhenti memakai BLEHIDDevice.
ok('TIDAK lagi membuat service HID 1812 secara manual',
   !/createService\s*\(\s*BLEUUID\s*\(\s*(?:HID_SVC|"1812"|0x1812)\s*\)/.test(code));

ok('TIDAK lagi membuat characteristic 2a4d secara manual',
   !/createCharacteristic\s*\(\s*BLEUUID\s*\(\s*(?:HID_CHAR|"2a4d"|0x2a4d)\s*\)/.test(code));

ok('TIDAK memakai BLE2902 (deprecated di core 3.3.x)',
   !/BLE2902/.test(code));

// ---------------------------------------------------------------------------
// 4. Regresi v1: Report ID ada di map tapi tidak di payload
// ---------------------------------------------------------------------------
section('4. Regresi v1: Report ID harus cocok');

const reportIdConst = (code.match(/REPORT_ID_KEYBOARD\s*=\s*(0x[0-9a-fA-F]+|\d+)/) || [])[1];
ok('Report ID didefinisikan sebagai konstanta', !!reportIdConst, reportIdConst);

// Di dalam report map harus ada item 0x85 (Report ID).
ok('report map punya item Report ID (0x85)',
   /0x85\s*,\s*0x0[0-9A-Fa-f]/.test(code));

// Nilai setelah 0x85 harus sama dengan konstanta.
const idInMap = (code.match(/0x85\s*,\s*(0x[0-9a-fA-F]+)/) || [])[1];
ok('Report ID di map sama dengan REPORT_ID_KEYBOARD',
   idInMap === reportIdConst, `map=${idInMap} konstanta=${reportIdConst}`);

// Payload harus punya byte Report ID sebagai byte PERTAMA.
ok('payload report diawali byte Report ID',
   /r\.reportId\s*=\s*REPORT_ID_KEYBOARD/.test(code));

// Ukuran payload harus Report ID + 8 byte.
ok('payload adalah 9 byte (Report ID + 8 byte keyboard)',
   /struct\s+KbdReport[\s\S]*?uint8_t\s+reportId\s*;[\s\S]*?uint8_t\s+keys\s*\[\s*6\s*\]\s*;/.test(code));

// The bug itself: sending 8 bytes with no report id.
ok('TIDAK mengirim report 8 byte tanpa Report ID (bug v1)',
   !/uint8_t\s+report\s*\[\s*8\s*\]\s*=\s*\{\s*0x00\s*,\s*keycode/.test(code));

// ---------------------------------------------------------------------------
// 5. UUID harus sama dengan sisi Rust (kalau UUID beda, app tidak akan
//    pernah menemukan device - dan itu baru ketahuan setelah pairing)
// ---------------------------------------------------------------------------
section('5. Kontrak UUID dengan src-tauri/src/ble.rs');

const rust = fs.existsSync(RUST_BLE) ? fs.readFileSync(RUST_BLE, 'utf8') : '';

if (fs.existsSync(RUST_BLE)) {
  const uuids = { SERVICE_UUID: null, TX_UUID: null, RX_UUID: null };
  for (const key of Object.keys(uuids)) {
    const m = code.match(new RegExp(`${key}\\s*=\\s*"([0-9a-f-]+)"`));
    uuids[key] = m ? m[1] : null;
    ok(`${key} didefinisikan di sketch`, !!uuids[key]);
  }

  // Normalisasi ke huruf besar tanpa tanda hubung untuk perbandingan.
  const norm = (s) => (s || '').replace(/-/g, '').toUpperCase();
  const rustNorm = norm(rust);

  ok('UUID service NUS sama dengan ble.rs',
     norm(uuids.SERVICE_UUID) && rustNorm.includes(norm(uuids.SERVICE_UUID)),
     `sketch=${uuids.SERVICE_UUID}`);

  ok('UUID TX (app->device) ada di ble.rs',
     norm(uuids.TX_UUID) && rustNorm.includes(norm(uuids.TX_UUID)),
     `sketch=${uuids.TX_UUID}`);

  ok('UUID RX (device->app) ada di ble.rs',
     norm(uuids.RX_UUID) && rustNorm.includes(norm(uuids.RX_UUID)),
     `sketch=${uuids.RX_UUID}`);

  // Arah TX/RX adalah kesalahan yang sangat mudah terjadi dan tidak akan
  // ketahuan tanpa app yang benar-benar konek.
  ok('TX adalah ...0002 (app menulis ke device)',
     (uuids.TX_UUID || '').endsWith('0002-b5a3-f393-e0a9-e50e24dcca9e'));
  ok('RX adalah ...0003 (device memberi tahu app)',
     (uuids.RX_UUID || '').endsWith('0003-b5a3-f393-e0a9-e50e24dcca9e'));
  ok('TX dan RX tidak tertukar', uuids.TX_UUID !== uuids.RX_UUID);

  // Characteristic TX WAJIB punya PROPERTY_NOTIFY. Kalau tidak, subscribe dari
  // sisi app tidak akan pernah sampai - dan gejalanya persis "app tidak
  // menerima apa-apa" yang sulit dijelaskan.
  //
  // Penting: yang dicocokkan adalah blok PENUGASAN
  // "g_nusTx = nus->createCharacteristic( ... )", bukan kemunculan pertama
  // "g_nusTx" - yang itu deklarasi variabel global dan tidak punya properti
  // sama sekali. Versi pertama pemeriksaan ini memakai split() dan karena itu
  // salah.
  function assignedProps(varName) {
    const re = new RegExp(
      varName + '\\s*=\\s*[\\w:>-]+\\s*->\\s*createCharacteristic\\s*\\(([\\s\\S]*?)\\)\\s*;');
    const m = code.match(re);
    return m ? m[1] : null;
  }

  const txProps = assignedProps('g_nusTx');
  const rxProps = assignedProps('g_nusRx');
  ok('blok createCharacteristic untuk g_nusTx ditemukan', !!txProps);
  ok('blok createCharacteristic untuk g_nusRx ditemukan', !!rxProps);
  ok('characteristic TX (device->app) punya PROPERTY_NOTIFY',
     !!txProps && /PROPERTY_NOTIFY/.test(txProps), txProps || '-');
  ok('characteristic RX (app->device) punya PROPERTY_WRITE',
     !!rxProps && /PROPERTY_WRITE/.test(rxProps), rxProps || '-');
} else {
  console.log('  SKIP ble.rs tidak ditemukan, perbandingan UUID dilewati');
}

// ---------------------------------------------------------------------------
// 6. Bentuk kode yang harus tetap benar
// ---------------------------------------------------------------------------
section('6. Bentuk kode');

ok('kurung kurawal seimbang', countBraces(code) === 0, `depth=${countBraces(code)}`);

const setupCount = (code.match(/\bvoid\s+setup\s*\(\s*\)/g) || []).length;
const loopCount = (code.match(/\bvoid\s+loop\s*\(\s*\)/g) || []).length;
ok('setup() ada tepat satu kali', setupCount === 1, `ditemukan ${setupCount}`);
ok('loop() ada tepat satu kali', loopCount === 1, `ditemukan ${loopCount}`);

ok('loop() memanggil loopImpl (bukan loopImpl yang rekursif)',
   /void\s+loop\s*\(\s*\)\s*\{\s*loopImpl\s*\(\s*\)\s*;?\s*\}/.test(code)
   && !/loopImpl[\s\S]{0,50}loopImpl\s*\(\s*\)\s*;/.test(
        (code.split('static void loopImpl')[1] || '')));

// Buffer baris Serial harus dideklarasikan SEBELUM dipakai. Ini compile error
// di C++ dan sudah pernah menjadi masalah nyata di proyek ini.
const serDecl = code.indexOf('String g_serLine');
const serUse = code.indexOf('g_serLine');
ok('g_serLine dideklarasikan sebelum dipakai', serDecl >= 0 && serDecl <= serUse,
   serDecl < 0 ? 'tidak dideklarasikan' : `deklarasi@${serDecl} pakai@${serUse}`);

// Buffer baris harus berbatas, supaya data mengalir terus tidak memakan RAM.
ok('buffer baris Serial dibatasi panjangnya', /g_serLine\.length\s*\(\s*\)\s*<\s*\d+/.test(code));

// Characteristic HID harus disimpan di variabel, bukan dicari ulang per ketikan.
ok('pointer characteristic HID disimpan di variabel global',
   /static\s+BLECharacteristic\s*\*\s*g_kbdReport/.test(code));
ok('tidak mencari characteristic lewat UUID di dalam loop',
   !/getServiceByUUID|getCharacteristic\s*\(/.test(code));

// Notify hanya boleh jalan kalau ada subscriber.
ok('notifikasi NUS dijaga flag subscriber', /if\s*\(\s*!\s*g_nusNotifyOn\s*\)\s*return/.test(code));
ok('default notifikasi NUS = off', /g_nusNotifyOn\s*=\s*false/.test(code));

// Tidak ada delay panjang di loop.
const delays = [...code.matchAll(/delay\s*\(\s*(\d+)\s*\)/g)].map(m => +m[1]);
const longDelays = delays.filter(d => d > 50);
ok('tidak ada delay > 50ms di loop', longDelays.length === 0, `ditemukan: ${longDelays.join(',')}`);

// Nama device harus pendek & tetap (nama panjang dipangkas Windows).
const nameM = code.match(/DEVICE_NAME\s*=\s*"([^"]*)"/);
ok('nama device didefinisikan', !!nameM, nameM ? nameM[1] : 'tidak ada');
ok('nama device <= 29 karakter (batas nama advertising legacy)',
   !!nameM && nameM[1].length <= 29, nameM ? `${nameM[1].length} karakter` : '-');
ok('nama device TANPA spasi (tidak ada padding yang menyesatkan)',
   !!nameM && !/\s/.test(nameM[1]));

// Pelaporan RAM harus ada - satu-satunya cara melihat kebocoran memori.
ok('melaporkan free heap', /getFreeHeap/.test(code));
ok('melaporkan min free heap (men glimpses kebocoran)', /getMinFreeHeap/.test(code));
ok('laporan RAM ada di setup', /reportRam\s*\(\s*"setelah\s+BLE"\s*\)/.test(code));

// USB HID harus tetap ada sebagai pembanding A/B.
ok('USB HID dipertahankan sebagai pembanding', /USBHIDKeyboard/.test(code));

// Tanda throwaway harus ada supaya tidak pernah ikut ter-build di produksi.
ok('ditandai throwaway', /THROWAWAY/.test(src));
ok('folder terpisah dari common/ dan folder profil',
   !fs.existsSync(path.join(ROOT, 'firmware', 'common', 'spike_ble_hid2.ino')));

// Tidak boleh ada karakter CJK / pikar tak terduga di source.
const weird = [...code].filter(ch => {
  const c = ch.codePointAt(0);
  return (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3000 && c <= 0x303F);
});
ok('tidak ada karakter CJK/aneh yang tidak sengaja', weird.length === 0,
   weird.length ? [...new Set(weird)].join(' ') : '');

// ---------------------------------------------------------------------------
// Ringkasan
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
console.log(`spike2-test.js: ${pass} lulus, ${fail} gagal`);
if (fail) {
  console.log('\nYang gagal:');
  for (const p of problems) console.log('  - ' + p);
} else {
  console.log('Semua hijau.');
}
console.log('\nCATATAN: test ini BUKAN pengganti komfigurasi di device.');
console.log('Yang tidak bisa dibuktikan di sini:');
console.log('  - apakah Windows benar-benar menerima input report');
console.log('  - apakah reconnect setelah cabut-colok berhasil');
console.log('  - apakah RAM cukup setelah stack BLE');
console.log('Uji device tetap wajib: npm run tauri dev tidak menggantikan ini.');

// Exit code diturunkan dari penghitung kegagalan, DALAM SATU tempat.
//
// Kenapa bukan `process.exit(0)` di jalur sukses: runner suite hanya bisa
// membedakan "hijau" dari "selesai tanpa exit code" kalau exit code jelas
// terkait keadaan. Jalur sukses yang diam-diam keluar dengan 0, dan script
// yang crash karena exception, keduanya berstatus 0 bagi runner - keduanya
// terlihat sama. Runner bahkan menandai file ini "selalu hijau?" karena itu.
//
// Diverifikasi: dengan baris ini, mutasi advertiseOnDisconnect(false)
// menghasilkan status 1, dan kode asli menghasilkan status 0.
process.exitCode = fail > 0 ? 1 : 0;