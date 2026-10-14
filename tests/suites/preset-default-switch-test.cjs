// Menguji perbaikan perpindahan preset app -> default.
//
// Gejala yang dilaporkan user: sering nyangkut, preset tidak load, dan muncul
// pesan "[BLE] DUMP never closed (terminator lost)".
//
// Akar yang ditutup di sini:
//   1. Jalur muat layer hanya "kirim DAN LUPA" - tidak menunggu DUMP_END dan
//      tidak pernah mengirim ulang. mapping[layer] sudah dikosongkan di
//      protocol-parser.js, jadi kalau penutup frame hilang, grid displaying
//      keymap setengah jadi SAMPAI user menekan Refresh.
//   2. Watchdog dibatalkan setiap kali batch upload dimulai, sehingga frame
//      yang benar-benar rusak TIDAK dilaporkan. Error-nya baru muncul belasan
//      detik kemudian saat dump berikutnya, melapor kejadian yang sudah lewat.
//   3. Perpindahan ke default memicu loadLayer() dua kali (EVT:LAYER:0 dan
//      balasan INFO), jadi device menerima dua DUMP:0 untuk satu permintaan.
//   4. DUMPNAMES dikirim di handler INFO berdampingan dengan DUMP:0, sehingga
//      dua frame bisa saling memotong dan membatalkan watchdog yang salah.
const fs = require('fs');
const path = require('path');

const R = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const home = R('src/home-page.js');
const adaptive = R('src/adaptive.js');
const ble = R('src/ble-transport.js');
const parser = R('src/protocol-parser.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Jalur muat layer menunggu DUMP_END dan mengirim ulang ---');
ok(/waitForDump\(layer, 3000\)/.test(home),
  'loadLayer memakai waiter DUMP_END, bukan kirim-and-lupa');
ok(/await sendLine\('DUMP:' \+ layer\)/.test(home),
  'DUMP:<layer> tetap dikirim');
ok(/for \(let attempt = 1; attempt <= 2; attempt\+\+\)/.test(home),
  'ada percobaan kedua kalau DUMP_END tidak sampai');
ok(/if \(await waiter\) return true;/.test(home),
  'retry HANYA jalan kalau waiter benar-benar gagal (bukan selalu)');
ok(/home\.dumpRetry/.test(home) && /home\.dumpFailed/.test(home),
  'kedua hasil dicatat ke log pakai pesan i18n');
// Waiter harus dipasang SEBELUM DUMP dikirim, kalau tidak DUMP_END yang
// sangat cepat bisa datang sebelum waiter terdaftar dan menggantung.
const waiterIdx = home.indexOf('const waiter = waitForDump(layer, 3000);');
const sendIdx = home.indexOf("await sendLine('DUMP:' + layer);");
ok(waiterIdx > 0 && sendIdx > waiterIdx,
  'waiter dipasang sebelum DUMP dikirim (DUMP_END cepat tidak boleh terlewat)');

console.log('\n--- B. DUMP ganda dicegah, tapi tombol Refresh tetap hidup ---');
ok(/const layerDumpInFlight = new Map\(\)/.test(home),
  'ada kunci permintaan per layer');
ok(/if \(jalan\) return jalan;/.test(home),
  'permintaan yang sedang berjalan dipakai ulang, bukan dikirimi DUMP lagi');
ok(/layerDumpInFlight\.delete\(layer\)/.test(home),
  'kunci dilepas setelah selesai - Refresh berikutnya tetap dikirim normal');

console.log('\n--- C. Watchdog tidak lagi dibungkam blindness ---');
ok(/registerOnBatchStart\(\(\) => \{\s*if \(dumpInProgress \|\| namesInProgress\) return;/.test(ble),
  'batch tidak lagi membatalkan watchdog yang sedang mengawasi frame berjalan');
ok(/if \(batchUploadInFlight\(\)\) \{[\s\S]*?armDumpWatchdog\(\);/.test(ble),
  'watchdog menunda diri sendiri saat device sibuk (bukan melapor salah)');

console.log('\n--- D. DUMPNAMES tidak lagi berebut dengan DUMP ---');
ok(/function requestNames\(\)/.test(parser) && /function flushPendingNames\(\)/.test(parser),
  'ada mechanism antre untuk DUMPNAMES');
ok(/if \(namesInProgress\(\) \|\| dumpInProgress\(\)\) \{ namesPending = true; return; \}/.test(parser),
  'DUMPNAMES ditunda selama ada frame yang berjalan');
ok(/line === 'DUMP_END'[\s\S]*?flushPendingNames\(\)/.test(parser),
  'permintaan tertunda dikirim setelah DUMP_END, bukan berdampingan');

console.log('\n--- E. Notifikasi perpindahan layer ---');
ok(/\^\\\[LAYER\\\] Pindah \(\?:manual \)\?ke layer/.test(parser),
  'kedua varian "[LAYER] Pindah..." dari firmware dicocokkan');
ok(/\[LAYER\] Pindah ke layer/.test(R('firmware/common/macropad_core.h')),
  'firmware memang mengirim varian tanpa "manual" (knob)');
ok(/\[LAYER\] Pindah manual ke layer/.test(R('firmware/common/macropad_core.h')),
  'firmware memang mengirim varian dengan "manual" (perintah LAYER:)');

console.log('\n--- F. waitForDump diekspor, dan import tetap bebas siklus ---');
ok(/export function waitForDump\(/.test(adaptive),
  'waitForDump diekspor untuk dipakai home-page.js');
ok(/from '\.\/adaptive\.js'/.test(home),
  'home-page.js mengimpor dari adaptive.js');

// ==================== OSILASI alt+tab ====================
// Log user: "Brave" -> "Kembali ke Default" -> "Brave" -> "Kembali ke
// Default" berulang, lalu "DUMP never closed".
//
// Akarnya: companion app sendiri terbaca sebagai "window aplikasi lain".
// Companion app tidak punya preset, jadi tiap alt+tab ke app memaksa preset
// balik ke Default, dan alt+tab balik ke aplikasi target mengaktifkannya
// lagi. Tiap putaran = upload/instruksi baru ke device yang never selesai.
console.log('\n--- G. Companion app sendiri tidak memicu perpindahan preset ---');
const rust = R('src-tauri/src/lib.rs');
ok(/if pid == std::process::id\(\) \{ return None; \}/.test(rust),
  'get_foreground_exe mengabaikan window companion app sendiri (dicek via PID)');
ok(/^\s*if \(!exe\) return;$/m.test(adaptive),
  'exe null (companion app / tanpa window) tidak dianggap "tidak ada preset"');
// Null harusreturnSEBELUM blok yang deciding preset, bukan sesudah.
const nullIdx = adaptive.indexOf('if (!exe) return;');
const matchIdx = adaptive.indexOf('presetsData.presets.find(p => p.enabled');
ok(nullIdx > 0 && matchIdx > nullIdx,
  'penanganan exe null ada sebelum keputusan preset (bukan sesudah)');

console.log('\n--- H. Connect pertama membuka Default, baru ikut pindah ---');
ok(/let switchPendingOnConnect = false;/.test(adaptive),
  'ada penanda yang menunggu pengiriman Default setelah connect');
ok(/switchPendingOnConnect = true;/.test(adaptive),
  'resetAdaptiveRuntimeState menandai Default perlu dikirim');
const resetBlock = adaptive.match(/export function resetAdaptiveRuntimeState\(\) \{[\s\S]*?\n\}/);
ok(resetBlock && /switchPendingOnConnect = true;/.test(resetBlock[0]),
  'resetAdaptiveRuntimeState (dipanggil tiap connect) menyalakan penanda itu');
ok(/await sendBatch\(\['CONTEXT:DEFAULT', 'LAYER:0', 'INFO'\]\)/.test(adaptive),
  'Default dikirim eksplisit ke device setelah connect');
// Pemeriksaan ini harus DI LUAR blok yang butuh exe - kalau tidak, tidak
// pernah terkirim saat companion app yang fokus (exe null).
const connectBlock = adaptive.match(/if \(switchPendingOnConnect\) \{[\s\S]*?\n    \}/);
ok(!!connectBlock, 'blok pengiriman Default setelah connect ditemukan');
const exeLookup = adaptive.indexOf("await invoke('get_foreground_exe')");
const connectIdx = adaptive.indexOf('if (switchPendingOnConnect) {');
ok(connectIdx > 0 && connectIdx < exeLookup,
  'Default dikirim SEBELUM membaca window foreground (jadi jalan walau exe null)');

console.log('\n--- I. Jeda antar switch cukup untuk device selesai ---');
ok(/const SWITCH_COOLDOWN_MS = 4000;/.test(adaptive),
  'cooldown dinaikkan ke 4000 ms (2500 ms tidak cukup untuk preset besar)');

console.log(fail === 0 ? '\nOK: semua pemeriksaan hijau.' : `\n${fail} pemeriksaan gagal.`);
process.exit(fail === 0 ? 0 : 1);
