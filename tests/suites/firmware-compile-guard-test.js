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

console.log('\n--- H. Diagnostik DUMP harus ada dan TIDAK mengubah perilaku ---');
// Tanpa log ini, "penutup frame hilang" punya DUA kemungkinan yang sama
// sekali geomotri:
//
//   (a) firmware tidak pernah mengirim DUMP_END
//   (b) firmware mengirimnya tapi hilang di antara device dan app
//
// Keduanya tampak sama dari sisi app, dan keduanya menghasilkan gejala yang
// identik. Selama ini setiap fix danced aimed(a) padahal bukti-bukti
// menunjukkan notify() tidak pernah gagal - jadi (a) belum pernah terbukti.
const coreH = read('firmware/common/macropad_core.h');
const dumpBlock = coreH.match(/if \(cmd\.startsWith\("DUMP:"\)\) \{([\s\S]*?)\n  \}/);
ok(!!dumpBlock, 'blok handler DUMP: ditemukan');
if (dumpBlock) {
  const db = dumpBlock[1];
  ok(/SERIAL->printf\("\[DUMP\] mulai/.test(db), 'ada log saat DUMP dimulai (tahu perintah sampai)');
  ok(/\[DUMP\].*selesai.*DUMP_END/.test(db), 'ada log tepat sebelum DUMP_END dikirim');
  // WAJIB SERIAL-> bukan LOGS->: LOGS selalu USB CDC jadi pesan tidak terlihat
  // saat device bicara BLE - persis saat diagnosinya paling dibutuhkan. Test
  // contract-logpath-test.cjs juga melarang LOGS-> di file ini.
  ok(!/LOGS->/.test(db), 'diagnostik memakai SERIAL-> (dilarang LOGS-> di macropad_core.h)');
  // UrutanWAJIB: log harus SESUDAH DUMP_BEGIN dan SEBELUM DUMP_END.
  const beginAt = db.indexOf('DUMP_BEGIN:%d');
  const beginLog = db.indexOf('[DUMP] mulai');
  // lastIndexOf, BUKAN indexOf: '[DUMP]' muncul dua kali dan indexOf akan
  // menemukan yang pertama (log "mulai"), bukan log sebelum DUMP_END.
  const endLog = db.lastIndexOf('[DUMP]');
  const endSend = db.indexOf('SERIAL->println("DUMP_END")');
  ok(beginLog < beginAt, 'log "mulai" diletakkan sebelum DUMP_BEGIN');
  ok(endLog > beginAt && endLog < endSend,
    'log "selesai" diletakkan tepat sebelum DUMP_END dikirim');
}
// Perintah dari app harus terlihat di Serial Monitor - itu yang membedakan
// "app tidak mengirim" dari "firmware tidak menjawab".
const hidH = read('firmware/common/ble_hid.h');
ok(/NUS RX/.test(hidH), 'ada log NUS RX (perintah dari app terlihat di Serial Monitor)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
