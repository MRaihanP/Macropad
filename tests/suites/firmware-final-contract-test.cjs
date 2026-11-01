// Kontrak firmware FINAL vs PROTOTYPE.
//
// Semua hal di bawah pernah (atau hampir) jadi bug yang lolos build karena
// firmware hanya diperiksa statis:
//
//   - GPIO21 bukan pin ADC di ESP32-S3, jadi deteksi USB lewat ADC tidak pernah
//     bekerja - charger/BLE otomatis ikut mati tanpa error.
//   - CFG_STAGING_SIZE dihitung untuk 1 knob, sehingga upload biner preset
//     2 knob selalu ditolak dan app diam-diam turun ke jalur teks.
//   - cfgSig membaca CW,CCW,BTN sebagai array berurutan; dengan 2 knob urutannya
//     berbeda dari app dan sidik jari tidak pernah cocok.
//   - Gesture menempel ke ENC_PRIMARY, padahal FINAL harus bisa memindahkannya
//     ke knob mana pun dari app.
//
// Test ini menjaga kontrak tersebut tetap tertulis di kode.
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const finalIno = read('firmware/HID_Keypad_Final/HID_Keypad_Final.ino');
const core = read('firmware/common/macropad_core.h');
const frameProto = read('firmware/common/frame_proto.h');
const ds = read('src/device-state.js');
const parser = read('src/protocol-parser.js');
const serial = read('src/serial-transport.js');
const ble = read('src/ble-transport.js');
const home = read('src/home-page.js');

console.log('--- A. FINAL wajib punya BLE dan pindah media otomatis ---');
ok(/#define HID_BLE_SUPPORT\s+1/.test(finalIno), 'FINAL mengompilasi BLE HID (HID_BLE_SUPPORT=1)');
const ifaceFn = finalIno.match(/void ifaceSwitchFull\(bool goBle\)\s*\{([\s\S]*?)\n\}/);
ok(!!ifaceFn, 'ifaceSwitchFull() didefinisikan di sketsh FINAL');
if (ifaceFn) {
  ok(/hidLinkSet\(HidLink::BLE\)/.test(ifaceFn[1]), 'ifaceSwitchFull memindahkan HID ke BLE');
  ok(/usbDevicePower\(!goBle\)/.test(ifaceFn[1]), 'ifaceSwitchFull mematikan USB saat mode BLE');
}
const pollFn = finalIno.match(/void pollTransportSense\(\)\s*\{([\s\S]*?)\n\}/);
ok(!!pollFn, 'pollTransportSense() ada untuk membaca VD_VB');
if (pollFn) {
  ok(/vbusPresent\(\)/.test(pollFn[1]), 'pollTransportSense membaca VD_VB');
  ok(/ifaceSwitchFull\(wantBle\)/.test(pollFn[1]), 'pollTransportSense memanggil ifaceSwitchFull');
  ok(/TRANSPORT_STABLE_N/.test(pollFn[1]), 'pergantian media memakai debounce beberapa bacaan');
}
ok(/pollTransportSense\(\);/.test(finalIno), 'profileLoopHook memanggil pollTransportSense()');
ok(!/bootSwitchPoll/.test(finalIno), 'FINAL tidak memakai tombol BOOT/GPIO0 untuk switch media');

console.log('--- B. VD_VB harus dibaca digital, bukan ADC ---');
ok(/#define VBUS_READ_PIN\s+21/.test(finalIno), 'VD_VB ada di GPIO21');
ok(/bool vbusPresent\(\)\s*\{\s*return digitalRead\(VBUS_READ_PIN\)\s*==\s*HIGH;\s*\}/.test(finalIno),
  'vbusPresent() memakai digitalRead(GPIO21)');
const vbusBlocks = finalIno.split('HAS_VBUS_SENSE').slice(1).join('');
ok(!/analogReadMilliVolts\(VBUS_READ_PIN\)/.test(vbusBlocks),
  'tidak ada analogReadMilliVolts pada pin VD_VB (GPIO21 bukan ADC)');

console.log('--- C. Battery sense: EN_VD on -> settle -> baca -> off ---');
ok(/digitalWrite\(VDIV_EN_PIN,[^\n]*HIGH/.test(finalIno), 'readBatteryMv menyalakan EN_VD sebelum membaca');
ok(/delay\(VDIV_SETTLE_MS\)/.test(finalIno), 'readBatteryMv menunggu settle sebelum sampling');
ok(/delayMicroseconds\(200\)/.test(finalIno), 'readBatteryMv mengambil banyak sampel');
const battFn = finalIno.match(/uint32_t readBatteryMv\([\s\S]*?\n\}/);
ok(battFn && /digitalWrite\(VDIV_EN_PIN,[^\n]*LOW/.test(battFn[0].split('return')[0]),
  'readBatteryMv mematikan EN_VD lagi setelah membaca');

console.log('--- D. Status baterai tidak boleh mencek VBUS tiap loop ---');
ok(/CHARGE_POLL_INTERVAL_MS/.test(core), 'core punya interval polling status charger');
const reportFn = core.match(/void reportBatt\(\)\s*\{([\s\S]*?)\n\}/);
ok(reportFn && /CHARGE_POLL_INTERVAL_MS/.test(reportFn[1]), 'reportBatt memakai interval, bukan bacaan tiap loop');

console.log('--- E. RGB: efek, power, dan state off yang dihormati ---');
ok(/#include "\.\.\/common\/rgb_effects\.h"/.test(finalIno), 'FINAL memakai mesin efek rgb_effects.h');
ok(/rgbFrame\(rgbState\.mode/.test(finalIno), 'frame animasi dihitung oleh rgbFrame()');
ok(/bool rgbStateHasLight\(\)/.test(finalIno), 'ada pemeriksaan "state benar-benar menghasilkan cahaya"');
ok(/if \(!rgbStateHasLight\(\)\) \{\s*rgbPower\(false\);/.test(finalIno),
  'rgbApplyState mematikan MOSFET saat off / brightness 0 / warna hitam');
ok(/if \(!rgbState\.enabled \|\| rgbState\.bri == 0\) return false;/.test(finalIno),
  'rgbStateHasLight menolak enabled=0 dan brightness=0');
ok(/if \(rgbStateHasLight\(\)\) \{[\s\S]*?strip\.show\(\)/.test(finalIno),
  'rgbInit tidak menjalankan sweep saat state tersimpan off');
const setupOrder = core.indexOf('rgbRestore();') < core.indexOf('hwPeripheralsInit();');
ok(setupOrder, 'state RGB dipulihkan SEBELUM peripheral/MOSFET dinyalakan');

console.log('--- F. Gesture bisa dipindah knob dan durasinya diatur ---');
ok(/struct EncGesture/.test(core), 'ada struktur konfigurasi gesture');
ok(/EncGesture gestCfg\[NUM_ENCODERS\]/.test(core), 'gesture disimpan PER KNOB (bukan satu global)');
ok(!/if \(i == ENC_PRIMARY\) continue;/.test(core), 'tidak ada lagi knob yang dikecualikan dari gesture');
ok(/void runEncoderGesture\(uint8_t type, uint8_t idx\)/.test(core), 'eksekusi gesture menerima index knob');
ok(/gestCfg\[0\]\.t1Ms\s*=\s*2000/.test(core) && /gestCfg\[0\]\.t2Ms\s*=\s*3000/.test(core),
  'default pindah layer 2 dtk dan keluar preset 3 dtk');
ok(/cmd\.startsWith\("SETGEST:"\)/.test(core), 'perintah SETGEST tersedia');
ok(/cmd == "GEST"/.test(core), 'perintah GEST (dump) tersedia');
ok(/gestRestore\(\);/.test(core), 'gesture dipulihkan saat setup');

console.log('--- G. Payload biner preset harus mendukung 2 knob ---');
ok(/#define CFG_LAYER_BYTES[\s\S]*?NUM_ENCODERS \* 3/.test(frameProto),
  'ukuran layer dihitung dari NUM_ENCODERS');
ok(/CFG_LAYER_BYTES \* nLayers/.test(frameProto), 'batas panjang commit memakai CFG_LAYER_BYTES');
ok(/static_assert\(CFG_MAX_PAYLOAD <= CFG_STAGING_SIZE/.test(frameProto),
  'staging dijaga static_assert terhadap payload maksimum');
ok(/encCanon\[i \* 3 \+ 0\] = c\.encCW\[i\]/.test(frameProto),
  'cfgSig menyusun encoder dalam urutan kanonik CW,CCW,BTN per knob');

console.log('--- H. App benar-benar bisa membaca dan mengirim gesture ---');
ok(/export function applyGestRow\(/.test(ds), 'device-state punya applyGestRow()');
ok(/gestConfig/.test(ds), 'device-state menyimpan gesture per knob');
ok(/line\.startsWith\('GEST:'\)/.test(parser), 'protocol-parser membaca baris GEST:');
ok(/line === 'GEST_END'/.test(parser), 'protocol-parser mengenali GEST_END');
ok(/sendLine\('GEST'\)/.test(serial), 'handshake USB meminta dump GEST');
ok(/sendLine\('GEST'\)/.test(ble), 'handshake BLE meminta dump GEST');
ok(/SETGEST:\$\{idx\}:1:/.test(home), 'UI knob mengirim SETGEST tier 1');
ok(/SETGEST:\$\{idx\}:2:/.test(home), 'UI knob mengirim SETGEST tier 2');

console.log(fail === 0 ? '\nSEMUA OK' : `\n${fail} GAGAL`);
process.exit(fail === 0 ? 0 : 1);
