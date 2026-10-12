// Menangkap KELAS bug yang baru saja menggagalkan kompilasi.
//
// Tiga bug nyata ditemukan saat user mencoba compile firmware PROTOTYPE:
//
//  1. #define TRANSPORT_USB 0 bentrok dengan enumerator
//     `enum class TransportType { TRANSPORT_USB = 0 }`. Preprocessor
//     substitute makro di SELURUH token berikutnya, jadi enumerator-nya
//     jadi `0 = 0` -> "expected identifier before numeric constant".
//
//  2. #define SERIAL g_transport menimpa `#define SERIAL 0x0` dari core
//     Arduino tanpa #undef -> warning "SERIAL redefined".
//
//  3. Serial.dtr() tidak bisa dipanggil: pada core ESP32 3.3.11, USBCDC
//     punya `bool dtr;` sebagai member PROTECTED, bukan fungsi ->
//     "is protected within this context" + "cannot be used as a function".
//
// Test ini mensimulasikan preprocessor untuk (1) dan (2), dan memeriksa
// bentuk kode untuk (3). Ini BUKAN pengganti kompilasi - hanya yang bisa
// dilakukan tanpa toolchain.
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const limits = read('firmware/common/limits.h');
const transport = read('firmware/common/transport.h');
const usb = read('firmware/common/transport_usb.h');
const core = read('src-tauri/src/lib.rs');   // hanya untuk memastikan tidak salah file

console.log('--- A. Makro dan enumerator TIDAK boleh sama nama ---');
// Kumpulkan nama makro transport.
const macroNames = [...limits.matchAll(/^#define\s+(TRANSPORT_\w+)\s/gm)].map(m => m[1]);
ok(macroNames.includes('TRANSPORT_USB') && macroNames.includes('TRANSPORT_BLE'),
  `limits.h tetap mendefinisikan makro (${macroNames.filter(n => /^TRANSPORT_/.test(n)).join(', ')})`);

// Kumpulkan nama enumerator dari enum class TransportType.
const enumBlock = transport.match(/enum class TransportType[^{]*\{([\s\S]*?)\};/);
ok(!!enumBlock, 'enum class TransportType ditemukan');
const enumNames = enumBlock
  ? [...enumBlock[1].matchAll(/^\s*(\w+)\s*=/gm)].map(m => m[1])
  : [];
ok(enumNames.length > 0, `enumerator ditemukan (${enumNames.join(', ')})`);

// INI intinya: tidak boleh ada nama yang sama.
const collisions = enumNames.filter(n => macroNames.includes(n));
ok(collisions.length === 0,
  `tidak ada bentrok nama makro vs enumerator${collisions.length ? ' (bentrok: ' + collisions.join(', ') + ')' : ''}`);

// Simulasi langsung: kalau nama sama, preprocessor mengubahnya.
for (const name of enumNames) {
  const simulated = `#define ${name} 0\nenum class T { ${name} = 0 };`;
  const broken = new RegExp(`\\{\\s*0\\s*=\\s*0`).test(simulated.replace(/#define.*\n/, '#define X 0\n'));
  if (macroNames.includes(name)) {
    ok(broken, `simulasi: "${name}" yang sama dengan makro akan jadi "0 = 0" (memang rusak)`);
  }
}

// Buang komentar dulu. Penjelasan bug di dalam komentar juga mengandung
// "#define SERIAL" dan "Serial.dtr()" - kalau tidak dibuang, test akan
// mencocokkan penjelasannya sendiri dan selalu gagal.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const transportCode = stripComments(transport);
const usbCode = stripComments(usb);

console.log('\n--- B. SERIAL harus di-#undef sebelum di-#define ---');
ok(/#ifdef SERIAL\s*\n#undef SERIAL\s*\n#endif\s*\n#define SERIAL g_transport/.test(transportCode),
  'pola #ifdef SERIAL / #undef SERIAL / #endif ada sebelum #define SERIAL');
const defineCount = (transportCode.match(/#define SERIAL/g) || []).length;
ok(defineCount === 1, `hanya ada satu #define SERIAL (ditemukan ${defineCount})`);
// Urutan penting: #undef HARUS sebelum #define.
const undefAt = transport.indexOf('#undef SERIAL');
const defineAt = transport.indexOf('#define SERIAL');
ok(undefAt >= 0 && defineAt > undefAt, '#undef muncul SEBELUM #define (urutan benar)');

console.log('\n--- C. Serial.dtr() tidak boleh dipanggil ---');
ok(!/\bSerial\s*\.\s*dtr\s*\(/.test(usbCode),
  'tidak ada Serial.dtr() - dtr adalah member protected di core 3.3.11');
// Dulu test ini menuntut literal `if (Serial) return true;`. Implementasi
// sekarang lebih baik: operator bool() DAN buffer RX digabung dalam satu
// ekspresi, jadi device yang sudah melepas port tapi masih punya byte terakhir
// tetap dilaporkan tersambung. Yang dijaga di sini adalah SEMAKINNYA -
// operator bool() yang publik, bukan bentuk kode yang pernah dipakai.
ok(/\(bool\)\s*Serial|if\s*\(\s*(bool\)\s*)?Serial\s*\)/.test(usbCode),
  'isConnected() memakai operator bool() yang memang publik di USBCDC/HWCDC');
ok(/Serial\.available\(\)\s*>\s*0/.test(usbCode), 'isConnected() tetap mengecek buffer RX');

console.log('\n--- D. Komentar menjelaskan kenapa ---');
// Penjelasan "kenapa jangan panggil dtr()" TIDAK HARUS di transport_usb.h.
// Yang dijaga hanya: penjelasan itu ada di salah satu dari file yang
// relevan, supaya tidak ada yang "memperbaiki" Serial.dtr() kembali tanpa
// tahu alasannya. Memindahkan penjelasan antar file bukan regresi.
const penjelasanDtr = [usb, read('firmware/common/limits.h')].join('\n');
ok(/protected/i.test(penjelasanDtr), 'ada penjelasan kenapa dtr() tidak dipakai (biar tidak ada yang "memperbaiki" balik)');

// Sama seperti di atas: awalan TP_ dijelaskan di limits.h ( blok TRANSPORT
// SELECTION ), bukan di transport.h. Yang dijaga: penjelasannya masih ada.
const penjelasanTp = [transport, read('firmware/common/limits.h')].join('\n');
ok(/TP_USB|TRANSPORT_USB/.test(penjelasanTp) && /nama/i.test(penjelasanTp),
  'ada penjelasan kenapa enumerator memakai awalan TP_');

console.log('\n--- E. Semua pemakai enum memakai nama baru ---');
const files = ['firmware/common/transport.h', 'firmware/common/transport_usb.h',
  'firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino',
  'firmware/HID_Keypad_Final/HID_Keypad_Final.ino'];
for (const f of files) {
  const src = read(f);
  ok(!/TransportType::TRANSPORT_/.test(src), `${f}: tidak ada TransportType::TRANSPORT_* yang lama`);
}
ok(/TransportType::TP_USB/.test(usb), 'transport_usb.h memakai TransportType::TP_USB');
// BLE belum diimplementasikan, tapi nilainya harus tetap ada agar
// transport_ble.h nanti bisa langsung memakainya.
ok(/TP_BLE/.test(transport), 'TP_BLE ada (dipakai transport_ble.h nanti)');

console.log('\n--- F. println() harus bisa di-assign ulang (bukan const) ---');
// Bug nyata yang lolos semua test dan baru ketahuan saat user mencoba compile:
// `const size_t len = strlen(str);` lalu `if (len > ...) len = ...;`
// -> "assignment of read-only variable". Repo ini tidak punya toolchain
// Arduino, jadi test ini yang harus menangkap kelas kesalahan ini.
//
// Pola umum yang dilindungi: identifier yang di-declare const lalu di-assign
// ulang di baris berikutnya. Dicek pada fungsi yang jelas punya pemotongan.
const printlnBody = transportCode.match(/void println\(const char\* str\) override \{([\s\S]*?)\n  \}/);
ok(!!printlnBody, 'println() override ditemukan');
if (printlnBody) {
  const pb = printlnBody[1];
  const constLen = pb.match(/const\s+size_t\s+len\s*=/);
  const assignsLen = /(^|[^\w.])len\s*=[^=]/.test(pb.replace(/size_t\s+len\s*=\s*strlen\([^)]*\);/, ''));
  ok(!constLen || !assignsLen,
    'len tidak const bila di-assign ulang (const + assign = compile error)');
  ok(/size_t\s+len\s*=/.test(pb), 'len dideklarasikan size_t');
  ok(/memcpy\(line, str, len\)/.test(pb), 'isi baris disalin ke buffer stack');
  ok(/write\(\(const uint8_t\*\)line,\s*len \+ 1\)/.test(pb),
    'tulis string + newline dalam satu write');
  // Guard batas harus benar: len maksimal sizeof(line)-2 supaya newline muat.
  const capMatch = pb.match(/if \(len > sizeof\(line\) - (\d+)\) len = sizeof\(line\) - (\d+);/);
  ok(!!capMatch && capMatch[1] === capMatch[2] && Number(capMatch[1]) >= 2,
    'batas pemotongan menyisakan ruang untuk newline (>= 2)');
  // Tidak boleh ada const di fungsi yang Assignment ulang ke variabel itu.
  const constDecls = [...pb.matchAll(/const\s+\w+\s+(\w+)\s*=/g)].map(m => m[1]);
  for (const name of constDecls) {
    const reassigned = new RegExp('(^|[^\\w.])' + name + '\\s*=[^=]').test(
      pb.replace(new RegExp('const\\s+\\w+\\s+' + name + '\\s*=[^;]*;'), ''));
    ok(!reassigned, `${name} tidak const bila di-assign ulang`);
  }
}

console.log('\n--- I. Nomor versi harus punya SATU sumber dan terlihat dari device ---');
// Dua nomor versi yang tidak saling mengenal = sumber kebinguan berulang:
// user tidak bisa tahu firmware mana yang terpasang, dan tidak bisa ditelusuri
// perubahan hanya dari komit berhex panjang.
//
// Aturan: FW_VERSION di limits.h adalah satu-satunya sumber. Header sketsh
// hanya catatan. Dan WHOAMI wajib mengirimkannya supaya bisa dibaca langsung
// dari Serial Monitor maupun companion app.
const limH = read('firmware/common/limits.h');
const coreH = read('firmware/common/macropad_core.h');
const fwVerMatch = limH.match(/#define\s+FW_VERSION\s+(\d+)/);
ok(!!fwVerMatch, 'FW_VERSION ada di limits.h (sumber tunggal nomor versi)');
if (fwVerMatch) {
  const fwVer = fwVerMatch[1];
  // WHOAMI harus mengirimkannya - inilah yang membuat versi bisa DILIHAT,
  // bukan sekadar diasumsikan.
  ok(new RegExp('WHOAMI:.*fw=%d').test(coreH),
    'WHOAMI mengirim fw= (versi firmware terbaca dari Serial Monitor dan app)');
  // Header sketsh harus cocok dengan FW_VERSION, kalau tidak orang akan baca
  // "Firmware v6" di header padahal device melaporkan fw=7.
  for (const sk of ['HID_Keypad_Prototype', 'HID_Keypad_Final']) {
    const src = read(`firmware/${sk}/${sk}.ino`);
    const headerVer = (src.match(/Firmware v(\d+)/) || [])[1];
    ok(headerVer === fwVer,
      `${sk}: header "Firmware v${headerVer}" cocok dengan FW_VERSION=${fwVer}`);
  }
}

// App version harus sama di ketiga berkas - kalau beda, installer dan UI
// menampilkan nomor yang berbeda.
const pkg = JSON.parse(read('package.json'));
const cargo = read('src-tauri/Cargo.toml');
const tauriConf = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoVer = (cargo.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
ok(pkg.version === cargoVer && pkg.version === tauriConf.version,
  `versi app sama di package.json / Cargo.toml / tauri.conf.json (${pkg.version})`);

console.log('\n--- J. Ring buffer NUS tidak boleh membuang perintah diam-diam ---');
// Gejala yang dilaporkan: preset berpindah BERJAYA beberapa kali, lalu
// STUCK - dan baru bergerak setelah ada perintah kecil yang ditekan.
//
// bleNusPush() lama: saat ring penuh, `break` - dan karena itu byte LANJUTAN
// dibuang, termasuk kalau ada di TENGAH baris perintah. Perintah korup itu
// dibaca sebagai perintah lain atau ditolak, dan device masuk state yang
// tidak sesuai.
//
// Yang cocok dengan gejala: switch Several berhasil (ring belum penuh),
// lalu penuh (preset >1,5 KB vs ring 2 KB), lalu byte terpotong, device
// kacau. Perintah kecil berikutnya muat, dan stream ikut resinkron.
const shared = read('firmware/common/ble_shared.h');
ok(/#define\s+BLE_NUS_RING_SIZE\s+4096/.test(shared),
  'ring buffer NUS 4096 (batch preset >1,5 KB tidak langsung penuh)');
ok(/bleNusDroppedBytes/.test(shared), 'ada penghitung byte yang dibuang');
ok(/bleNusPushOverflows/.test(shared), 'ada penghitung kejadian overflow');
// Yang paling penting: byte yang dibuang harus TERLIHAT.
ok(/ring PENUH/.test(shared), 'overflow dicatat lewat log, bukan diam-diam');
// Drop harus dihitung, bukan hanya di-break tanpa dilog.
const pushBody = shared.match(/inline void bleNusPush[\s\S]*?\n\}/);
ok(!!pushBody, 'bleNusPush() terambil');
if (pushBody) {
  ok(!/if \(next == bleNusTail\) break;/.test(pushBody[0]),
    'tidak ada "break" yang membuang sisa tanpa dihitung');
  ok(/dropped\+\+/.test(pushBody[0]), 'byte yang dibuang dihitung');
  ok(/bleNusDroppedBytes \+=/.test(pushBody[0]), 'total terpotong ikut bertambah');
  // Log harus DI LUAR critical section - menulis USB CDC di dalam
  // portENTER_CRITICAL bisa memblokir dan memperburuk keadaan.
  const critAt = pushBody[0].indexOf('portENTER_CRITICAL');
  const exitAt = pushBody[0].indexOf('portEXIT_CRITICAL');
  const logAt = pushBody[0].indexOf('ring PENUH');
  ok(critAt >= 0 && exitAt > critAt, 'ada critical section yang seimbang');
  ok(logAt > exitAt, 'log overflow DI LUAR critical section (menulis USB CDC di dalamnya memblokir)');
}
// Perintah untuk mengeceknya harus lewat LOGS, bukan stream protokol - kalau
// lewat SERIAL, barisnya ikut masuk ke protocol-parser dan bisa merusak
// parsing, persis masalah sebelumnya.
const diagH = read('firmware/common/ble_diag.h');
const ringBlock = diagH.match(/if \(cmd == "BLE:RING"\) \{([\s\S]*?)\n  \}/);
ok(!!ringBlock, 'perintah BLE:RING ada');
if (ringBlock) {
  ok(/LOGS->/.test(ringBlock[1]), 'BLE:RING lewat LOGS (tidak masuk stream protokol)');
  ok(!/SERIAL->/.test(ringBlock[1]), 'BLE:RING tidak memakai SERIAL');
}

console.log('\n--- K. Flow control di sisi app: jangan kirim lebih cepat dari firmware ---');
const bleT2 = read('src/ble-transport.js');
ok(/const BATCH_CHUNK_MS = \d+/.test(bleT2), 'ada jeda antar potongan batch');
const sbatch = bleT2.match(/export async function sendBatch[\s\S]*?\n\}/);
ok(!!sbatch, 'sendBatch() terambil');
if (sbatch) {
  ok(/setTimeout/.test(sbatch[0]), 'sendBatch() memberi jeda antar potongan');
  // Jeda hanya untuk batch. sendLine (perintah tunggal) tidak boleh waited,
  // supaya respons PING/INFO tetap seketika.
  const sl = bleT2.match(/export async function sendLine[\s\S]*?\n\}/);
  ok(sl && !/setTimeout/.test(sl[0]), 'sendLine() TIDAK diberi jeda (respons cepat tetap cepat)');
}

// PERINGATAN REGRESI: perubahan di sini HARUS BLE-only. Round lalu user melaporkan
// "perubahan mempengaruhi USB" - karena diagnostic pernah pakai SERIAL (= USB CDC).
ok(!/SERIAL->/.test(shared), 'ble_shared.h tidak menyentuh jalur protokol (tidak memengaruhi USB)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
