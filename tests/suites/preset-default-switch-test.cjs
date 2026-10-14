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
console.log('\n--- G. Companion app fokus -> preset KEMBALI ke Default ---');
const rust = R('src-tauri/src/lib.rs');
ok(/async fn get_foreground_exe\(\) -> Option<String>/.test(rust),
  'get_foreground_exe tetap mengembalikan nama exe (termasuk companion app)');
ok(!/pid == std::process::id\(\) \{ return None; \}/.test(rust),
  'companion app TIDAK disembunyikan dari deteksi - user minta preset balik ke Default di sini');
ok(/fn get_own_exe_name\(\) -> Option<String>/.test(rust),
  'ada command get_own_exe_name supaya frontend tahu exe companion app sendiri');
ok(/get_own_exe_name,/.test(rust), 'get_own_exe_name terdaftar di invoke_handler');
ok(/export async function loadOwnExeName\(\)/.test(adaptive),
  'frontend memuat nama exe companion app');
ok(/loadOwnExeName\(\)/.test(R('src/main.js')), 'main.js memanggil loadOwnExeName()');
ok(/const isOwnApp = !!ownExeName && exe === ownExeName;/.test(adaptive),
  'companion app dikenali dari nama exe-nya sendiri');
// Companion app tidak punya preset, jadi harus jatuh ke cabang "tidak ada
// yang cocok" = Default. Yang dicek: tidak ada pengecualian yang menahannya.
const ownAppBlock = adaptive.match(/const isOwnApp = [\s\S]*?\n/);
ok(ownAppBlock && !/return;/.test(ownAppBlock[0]),
  'companion app tidak otomatis ditolak - ia ikut ke jalur Default');

console.log('\n--- H. Anti-bolak-balik saat alt+tab ke companion app ---');
ok(/const OWN_APP_COOLDOWN_MS = \d+;/.test(adaptive),
  'companion app punya cooldown sendiri yang lebih panjang');
ok(/Date\.now\(\) - lastSwitchAt < holdMs/.test(adaptive),
  'cooldown yang dipakai adalah holdMs (hasil choosing kedua jenis cooldown)');
ok(/const holdMs = isOwnApp \? OWN_APP_COOLDOWN_MS : SWITCH_COOLDOWN_MS;/.test(adaptive),
  'holdMs memilih cooldown companion app vs app biasa');
ok(/if \(isOwnApp\) lastOwnAppSeenAt = Date\.now\(\);/.test(adaptive),
  'waktu terakhir companion app dipakai dicatat');
ok(/lastOwnAppSeenAt = 0;/.test(adaptive),
  'lastOwnAppSeenAt direset saat connect (bukan sisa sesi sebelumnya)');

console.log('\n--- H2. Notifikasi layer 0 akibat switch disembunyikan ---');
ok(/export function suppressLayerNotif\(\)/.test(adaptive),
  'adaptive menyediakan penapis notifikasi layer');
ok(/layerNotifSuppressedUntil = Date\.now\(\) \+ \d+/.test(adaptive),
  'jendela penyembunyian dibatasi waktu (bukan permanen)');
const notifCount = (adaptive.match(/markPresetSwitch\(\);/g) || []).length;
ok(notifCount >= 3,
  `markPresetSwitch() dipanggil di semua jalur switch (ditemukan ${notifCount})`);
ok(/if \(n === 0 && suppressLayerNotif\(\)\) return;/.test(parser),
  'hanya notifikasi layer 0 yang disembunyikan');
ok(!/if \(n !== 0 && suppressLayerNotif/.test(parser),
  'penyembunyian tidak memakai kondisi "layer bukan 0" - layer lain tetap dinotifikasi');
ok(!/if \(suppressLayerNotif\(\)\) return;/.test(parser),
  'penapis tidak pernah membungkam notifikasi layer tanpa syarat nomor layer');

console.log('\n--- I. Penanda frame NAMES tidak tertelan jebakan dump ---');
// Urutan lama: NAMES_BEGIN/NAMES_END dicek SETELAH branch dumpInProgress.
// Kalau NAMES_BEGIN datang saat dump berjalan, baris itu tertelan sebagai
// "isi dump", setNamesInProgress tidak pernah jalan, dan NAMES_END berikutnya
// ikut tertelan - menyisakan namesInProgress = true selamanya, yang
// muncul sebagai "DUMPNAMES never closed".
// PENTING: yang dibandingkan harus jebakan dump DI DALAM handleFrameLine.
// handleRealtimeLine juga punya `if (dumpInProgress())` (untuk EVT:LAYER),
// dan itu muncul lebih dulu di berkas - jadi indexOf harus disembunyikan
// ke bawah fungsi handleFrameLine dulu.
const frameStart = parser.indexOf('function handleFrameLine(line)');
ok(frameStart > 0, 'handleFrameLine ditemukan');
const frameBody = parser.slice(frameStart);
const namesBeginIdx = frameBody.indexOf("if (line === 'NAMES_BEGIN')");
const dumpCatchIdx = frameBody.indexOf('if (dumpInProgress()) {');
ok(namesBeginIdx > 0 && dumpCatchIdx > 0 && namesBeginIdx < dumpCatchIdx,
  'NAMES_BEGIN/NAMES_END diperiksa SEBELUM jebakan dumpInProgress');
const namesBeginCount = (parser.match(/if \(line === 'NAMES_BEGIN'\)/g) || []).length;
const namesEndCount = (parser.match(/if \(line === 'NAMES_END'\)/g) || []).length;
ok(namesBeginCount === 1 && namesEndCount === 1,
  'penanda NAMES_BEGIN/NAMES_END hanya ada satu kali (tidak ada versi duplikat)');

console.log('\n--- J. Connect pertama membuka Default, baru ikut pindah ---');
ok(/let switchPendingOnConnect = false;/.test(adaptive),
  'ada penanda yang menunggu pengiriman Default setelah connect');
ok(/switchPendingOnConnect = true;/.test(adaptive),
  'resetAdaptiveRuntimeState menandai Default perlu dikirim');
const resetBlock = adaptive.match(/export function resetAdaptiveRuntimeState\(\) \{[\s\S]*?\n\}/);
ok(resetBlock && /switchPendingOnConnect = true;/.test(resetBlock[0]),
  'resetAdaptiveRuntimeState (dipanggil tiap connect) menyalakan penanda itu');
ok(/await sendBatch\(\['CONTEXT:DEFAULT', 'LAYER:0'\]\)/.test(adaptive),
  'Default dikirim eksplisit ke device setelah connect (tanpa INFO - token switch)');
// Token switch: perpindahan Default tidak boleh lagi memicu frame DUMP /
// DUMPNAMES. Frame itulah yang bikin watchdog melapor "never closed".
const swFn = adaptive.match(/async function switchToDefault\(\) \{[\s\S]*?\n\}/);
ok(!!swFn, 'fungsi switchToDefault() ada');
if (swFn) {
  const b = swFn[0];
  ok(/CONTEXT:DEFAULT/.test(b) && /LAYER:0/.test(b), 'perintah Default dikirim');
  ok(!/\bINFO\b/.test(b), 'tidak ada lagi INFO di jalur switch Default');
  ok(/applyDefaultCache\(\)/.test(b), 'grid digambar dari cache lokal, bukan read-back');
  ok(!/sendLine\('DUMP:/.test(b), 'tidak ada DUMP langsung di jalur switch');
}
ok(!/loadActiveLayerDump\(\)/.test(
  adaptive.match(/async function activatePresetRuntime[\s\S]*?\n\}/)[0]),
  'aktivasi preset juga tidak lagi read-back DUMP - render dari cache lokal');
ok(/function renderPresetLocally\(preset\)/.test(adaptive),
  'preset dirender dari isi preset yang ada di app (presetsData)');
// Cache Default di-persist ke localStorage supaya tetap instan setelah restart.
const ds = R('src/device-state.js');
ok(/localStorage\.setItem/.test(ds) && /localStorage\.getItem/.test(ds),
  'cache Default di-persist ke localStorage');
ok(/if \(!c \|\| c\.fw !== currentFw\) return;/.test(ds),
  'cache dengan jejak firmware berbeda dibuang (isi device bisa berbeda)');
ok(/export function invalidateDefaultCache\(\)/.test(ds),
  'ada pembatalan cache saat Default diubah dari app');
ok(/invalidateDefaultCache/.test(R('src/main.js')),
  'main.js membatalkan cache saat Default bisa berubah');
// SLOTS / CTX? - token status dari device (point 6: cache hilang saat mati).
ok(/if \(cmd == "SLOTS"\)/.test(R('firmware/common/macropad_core.h')),
  'firmware menjawab SLOTS (mask slot terisi + boot id)');
ok(/if \(cmd == "CTX\?"\)/.test(R('firmware/common/macropad_core.h')),
  'firmware menjawab CTX? (konteks + layer aktif, satu baris)');
ok(/bootId\+\+/.test(R('firmware/common/macropad_core.h')),
  'boot id naik tiap boot sehingga app tahu cache device hilang');
ok(/slotUsed\[n\] = true/.test(R('firmware/common/macropad_core.h')),
  'slot ditandai terisi saat SLOT:<n>:NEW diterima');
ok(/export async function syncSlotStatus\(\)/.test(adaptive),
  'app menanyakan status slot device setelah connect');
ok(/deviceSlotOccupied\(slot\)/.test(adaptive),
  'app memakai jawaban device sebagai acuan, bukan cuma tabelnya sendiri');
// Pemeriksaan ini harus DI LUAR blok yang butuh exe - kalau tidak, tidak
// pernah terkirim saat companion app yang fokus (exe null).
const connectBlock = adaptive.match(/if \(switchPendingOnConnect\) \{[\s\S]*?\n    \}/);
ok(!!connectBlock, 'blok pengiriman Default setelah connect ditemukan');
const exeLookup = adaptive.indexOf("await invoke('get_foreground_exe')");
const connectIdx = adaptive.indexOf('if (switchPendingOnConnect) {');
ok(connectIdx > 0 && connectIdx < exeLookup,
  'Default dikirim SEBELUM membaca window foreground (jadi jalan walau exe null)');

console.log('\n--- K. Jeda antar switch cukup untuk device selesai ---');
ok(/const SWITCH_COOLDOWN_MS = 4000;/.test(adaptive),
  'cooldown dinaikkan ke 4000 ms (2500 ms tidak cukup untuk preset besar)');

console.log(fail === 0 ? '\nOK: semua pemeriksaan hijau.' : `\n${fail} pemeriksaan gagal.`);
process.exit(fail === 0 ? 0 : 1);
