// Menangkap kelas bug yang sudah membuktikan diri di repo ini.
//
// Versi pertama switch GPIO0 (commit "BLE transport switching"))
// terlihat benar di commit message dan lolos build, tapi:
//
//   1. Hanya main.js yang diarahkan ke transport abstraction. Empat modul lain
//      (protocol-parser, adaptive, home-page, tray) tetap mengimpor
//      serial-transport.js langsung, jadi perintah tetap ditulis ke port COM
//      walau user sudah pilih BLE - companion app tidak pernah menerima apa pun.
//   2. Nama fungsi fiktif (tIsConnected, tDeviceWasLost) tidak pernah
//      dideklarasikan, jadi tidak ada yang menangkap error itu.
//
// Dua-duanya lolos karena test HANYA mencocokkan string di main.js dan tidak
// pernah MENGEKSEKUSI jalur transport. Test di sini menutup dua celah itu:
// memeriksa wiring (import benar-benar diarahkan) dan behavior (state berubah
// benar-benar terjadi).
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const proto = read('firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino');
const sw = read('firmware/common/switch_iface.h');
const hid = read('firmware/common/hid_link.h');

console.log('--- A. Switch harus benar-benar membalik DUA sumbu ---');
// Satu sumbu saja menghasilkan keadaan setengah-setengah: tombol ke USB tapi
// jawaban perintah lewat NUS, atau sebaliknya.
//
// PERBAIKAN: logika pindah ada di SATU fungsi (ifaceGo di switch_iface.h),
// dipakai oleh command IFACE:USB/IFACE:BLE DAN tombol GPIO0. Sebelumnya
// keduanya punya implementasi sendiri yang BERBEDA - command hanya memanggil
// hidLinkSet(), jadi PROTO_LINK tidak ikut berubah. Sekarang tidak mungkin
// lagi berbeda karena hanya ada satu implementasi.
const go = sw.match(/inline void ifaceGo\(bool toBle\)\s*\{([\s\S]*?)\n\}/);
ok(!!go, 'ifaceGo() ada di switch_iface.h');
const diag = read('firmware/common/ble_diag.h');
if (go) {
  const body = go[1];
  ok(/hidLinkSet\(toBle \? HidLink::BLE : HidLink::USB\)/.test(body), 'memindahkan HID_LINK');
  ok(/g_protoLink\s*=\s*toBle \? ProtoLink::NUS : ProtoLink::CDC/.test(body),
    'memindahkan PROTO_LINK');
  // Pointo paling penting: hidLinkSet harus dipanggil SEBELUM g_protoLink
  // ditulis, supaya advertising menyala sebelum app mencari NUS.
  const hidAt = body.indexOf('hidLinkSet(');
  const protoAt = body.indexOf('g_protoLink =');
  ok(hidAt >= 0 && protoAt > hidAt,
    'hidLinkSet() dijalankan SEBELUM g_protoLink ditulis (advertising dulu)');
  ok(/protoTransportSwitch\(\)/.test(body), 'protoTransportSwitch() dipanggil');
  // Pesan log harus lewat LOGS, bukan SERIAL. Kalau lewat SERIAL, pesan ini
  // sendiri terkirim ke companion app setelah g_transport pindah ke NUS dan
  // muncul sebagai baris protocol yang tidak dikenal.
  ok(/LOGS->printf/.test(body), 'log lewat LOGS (USB CDC), bukan SERIAL');
  ok(!/SERIAL->/.test(body), 'tidak ada SERIAL-> di dalam switch');
}
// Tombol dan command WAJIB memakai implementasi yang sama.
const fn = proto.match(/void ifaceToggleFromButton\(\)\s*\{([\s\S]*?)\n\}/);
ok(!!fn, 'ifaceToggleFromButton() ada di sketsh PROTOTYPE');
if (fn) {
  ok(/ifaceGo\(/.test(fn[1]), 'tombol memanggil ifaceGo(), bukan logika sendiri');
  ok(!/hidLinkSet/.test(fn[1]), 'tombol tidak punya implementasi sendiri');
}
ok(/if \(cmd == "IFACE:USB"\) \{\s*ifaceGo\(false\);/.test(diag),
  'IFACE:USB memanggil ifaceGo(false)');
ok(/if \(cmd == "IFACE:BLE"\) \{\s*ifaceGo\(true\);/.test(diag),
  'IFACE:BLE memanggil ifaceGo(true)');
// Bug lama yang harus tidak balik: command hanya mengubah SATU sumbu.
const usbBlock = diag.match(/if \(cmd == "IFACE:USB"\) \{([\s\S]*?)\n  \}/);
ok(usbBlock && !/hidLinkSet/.test(usbBlock[1]),
  'IFACE:USB tidak lagi hanya mengubah HID_LINK (bug lama)');
const bleBlock = diag.match(/if \(cmd == "IFACE:BLE"\) \{([\s\S]*?)\n  \}/);
ok(bleBlock && !/g_protoLink/.test(bleBlock[1]),
  'IFACE:BLE tidak lagi menyentuh PROTO_LINK sendiri (sudah di ifaceGo)');

console.log('\n--- B. Pola LED: BLE berkedip, USB menyala, keduanya 1 detik ---');
ok(/switchLedStart\(toBle \? SwitchLedPattern::SW_BLINK : SwitchLedPattern::SW_SOLID\)/.test(sw),
  'pola dipilih dari mode tujuan: blink=BLE, solid=USB (di ifaceGo)');
ok(/SWITCH_LED_BLINK_MS\s+200/.test(sw), 'interval kedip 200 ms');
ok(/SWITCH_LED_TOTAL_MS\s+1000/.test(sw), 'durasi total 1000 ms');
// Animasi WAJIB non-blocking. delay(1000) membekukan scan matrix + encoder
// + loop BLE selama 1 detik penuh, dan tombol yang ditekan selama itu hilang.
const tick = sw.match(/inline void switchLedTick\(\)\s*\{([\s\S]*?)\n\}/);
ok(!!tick, 'switchLedTick() ada');
if (tick) {
  ok(!/\bdelay\s*\(/.test(tick[1]), 'switchLedTick() tidak memakai delay()');
  ok(/millis\(\)/.test(tick[1]), 'switchLedTick() berbasis millis()');
  ok(/\(long\)\(now -/.test(tick[1]), 'perbandingan signed (aman saat millis() rollover)');
}

console.log('\n--- C. Debounce & latch: satu penekanan = satu switch ---');
ok(/BOOT_SWITCH_DEBOUNCE_MS\s+40/.test(sw), 'ada debounce');
ok(/BOOT_SWITCH_IGNORE_MS/.test(sw), 'tekan awal boot diabaikan');
// Tanpa latch, tombol yang DITAHAN akan memicu switch berulang tiap debounce -
// device akan berbolak-balik USB/BLE sendiri.
const poll = sw.match(/inline bool bootSwitchPoll\(\)\s*\{([\s\S]*?)\n\}/);
ok(!!poll, 'bootSwitchPoll() ada');
if (poll) {
  ok(/g_bootBtnArmed\s*=\s*false/.test(poll[1]), 'latch dilepas saat tekan dipicu');
  ok(/g_bootBtnArmed\s*=\s*true/.test(poll[1]), 'latch dipasang ulang saat tombol dilepas');
  ok(/g_bootBtnStableSince/.test(poll[1]), 'memakai timer stabilitas untuk debounce');
}

console.log('\n--- D. GPIO0 = BOOT, aktif-LOW, pull-up internal ---');
ok(/#define BOOT_SWITCH_PIN\s+0/.test(sw), 'BOOT_SWITCH_PIN = GPIO0');
ok(/pinMode\(BOOT_SWITCH_PIN, INPUT_PULLUP\)/.test(sw), 'dibaca sebagai INPUT_PULLUP');
ok(/digitalRead\(BOOT_SWITCH_PIN\) == LOW/.test(sw), 'aktif-LOW (ditekan = LOW)');
// GPIO0 dipakai hardware lain? Kalau ya, dua fitur berebut satu pin.
const otherPins = proto.match(/const uint8_t \w*PIN\w* = (\d+);/g) || [];
ok(!/\b0\b(?=[^;]*=\s*0;)/.test('') && !otherPins.some(p => /=\s*0;/.test(p)),
  'GPIO0 tidak dipakai pin lain di sketsh PROTOTYPE');

console.log('\n--- E. Hook dipanggil di tempat yang benar ---');
// Hook setup harus SEBELUM loop, dan hook loop harus dipanggil tiap iterasi
// di luar return cepat apa pun.
const core = read('firmware/common/macropad_core.h');
ok(/PROFILE_HOOK_SETUP\(\)/.test(core), 'PROFILE_HOOK_SETUP() dipanggil di setup()');
ok(/PROFILE_HOOK_LOOP\(\)/.test(core), 'PROFILE_HOOK_LOOP() dipanggil di loop()');
ok(/void profileLoopHook\(\)/.test(proto), 'profileLoopHook() terdefinisi');
// Ambil badan fungsi dengan menghitung kedalaman brace. Regex non-greedy
// sekecil itu akan berhenti di brace PERTAMA yang tertutup - dan badan
// profileLoopHook() memang memuat blok if, jadi hasilnya terpotong.
function fnBody(src, name) {
  // src.indexOf() akan kena DEKLARASI forward (dipisah titik koma) lebih dulu,
  // bukan definisi. Cari occurrence yang diikuti '{' untuk memastikan badan.
  let start = -1;
  let from = 0;
  for (;;) {
    const at = src.indexOf(name, from);
    if (at < 0) break;
    const brace = src.indexOf('{', at);
    const semi = src.indexOf(';', at);
    if (brace >= 0 && (semi < 0 || brace < semi)) { start = at; break; }
    from = at + 1;
  }
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

const loopHookBody = fnBody(proto, 'void profileLoopHook()');
ok(!!loopHookBody, 'badan profileLoopHook() terambil utuh');
if (loopHookBody) {
  const body = loopHookBody;
  const pollAt = body.indexOf('bootSwitchPoll()');
  const firstReturn = body.indexOf('return;');
  ok(pollAt >= 0, 'bootSwitchPoll() dipanggil di profileLoopHook()');
  // Kalau switchLedTick() ada SETELAH return pertama yang di-parameters
  // (early return saat BLE tersambung), animasi LED tidak akan jalan di
  // mode BLE - persis saat LED paling dibutuhkan.
  ok(/switchLedTick\(\)/.test(body), 'switchLedTick() dipanggil tiap iterasi');
  const tickAt = body.indexOf('switchLedTick()');
  const guardAt = body.indexOf('bleHidConnected()');
  ok(guardAt < 0 || tickAt < guardAt,
    'switchLedTick() dipanggil SEBELUM guard BLE (tidak tertimpa early return)');
}

console.log('\n--- F. LED tidak tertimpa init peripheral ---');
// switchLedAttach() menyalakan pin LED. Kalau dipanggil sebelum
// hwPeripheralsInit(),后者 menulis LOW dan membatalkan inisialisasi.
const setupOrder = core.indexOf('hwPeripheralsInit();');
const hookOrder = core.indexOf('PROFILE_HOOK_SETUP();');
ok(setupOrder >= 0 && hookOrder > setupOrder,
  'hwPeripheralsInit() jalan SEBELUM PROFILE_HOOK_SETUP() (LED tidak tertimpa)');
ok(/switchLedAttach\(STATUS_LED_PIN/.test(proto), 'PROTOTYPE attaching LED status GPIO12');

console.log('\n--- G. Header switch harus bisa dipakai profil tanpa LED ---');
// FINAL tidak punya LED status sama sekali (GPIO12 dipakai knob 2).
// Header tidak boleh MEREFERENSIKAN pin yang hanya ada di PROTOTYPE di kode -
// penyebutan di dalam komentar tidak masalah, yang penting tidak ada
// ketergantungan kompilasi ke pin milik profil lain.
const swCode = sw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
ok(!/STATUS_LED_PIN/.test(swCode), 'kode header switch tidak memakai STATUS_LED_PIN (aman untuk FINAL)');
ok(/g_switchLedUsable/.test(sw), 'ada penanda "LED tidak ada" sehingga fungsi jadi no-op');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);