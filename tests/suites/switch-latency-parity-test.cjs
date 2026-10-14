// Mengunci KECEPATAN perpindahan preset, dan yang paling penting:
// KESIMBANGAN antara perpindahan ke preset dan ke Default.
//
// Gejala user: pindah ke preset Brave = 1 ketukan, pindah ke Default =
// 2 ketukan. Itu asimetri, bukan kebetulan.
//
// Akarnya: jalur ke preset sudah merender dari preset.layers yang ada di app
// (tidak ada read-back), tapi jalur ke Default masih mengirim
// CONTEXT:DEFAULT + INFO + DUMPENC dan lalu menunggu INFO memicu DUMP:0.
// Default justru butuh LEBIH SEDIKIT perintah dari device (preset harus
// upload ratusan SET), tapi justru lebih lambat - itu yang salah.
//
// Perbaikan: snapshot isi Default diambil saat app berada di Default, lalu
// dipasang langsung saat kembali. Grid berubah tanpa satu pun read-back.
//
// Test ini mengunci itu supaya tidak balik lagi.
const fs = require('node:fs');
const path = require('node:path');

const R = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const adaptive = R('src/adaptive.js');
const state = R('src/device-state.js');
const main = R('src/main.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Jalur ke Default tidak lagi read-back ---');
const swFn = adaptive.match(/async function switchToDefault\(\) \{[\s\S]*?\n\}/);
ok(!!swFn, 'fungsi switchToDefault() ada');
if (swFn) {
  const b = swFn[0];
  ok(/CONTEXT:DEFAULT/.test(b), 'device tetap dipindahkan ke Default');
  // BACAAN HARUS DI DALAM CABANG FALLBACK SAJA, bukan di jalur utama.
  ok(/hasDefaultSnapshot\(\) && applyDefaultSnapshot\(\)/.test(b),
    'snapshot dipakai sebelum membaca dari device');
  ok(/hooks\.renderGrid\(\)/.test(b), 'grid digambar langsung dari snapshot');
  ok(/else \{[\s\S]*sendBatch\(\['INFO', 'DUMPENC', 'DUMPNAMES'\]\)/.test(b),
    'baca penuh hanya di cabang fallback (snapshot tidak ada)');
}

// Yang penting: di jalur cepat, TIDAK boleh ada INFO/DUMP yang memicu dump.
const cacheHit = swFn ? swFn[0].split('else {')[0] : '';
ok(!/DUMPENC|DUMPNAMES/.test(cacheHit),
  'jalur cache-hit tidak mengirim DUMPENC/DUMPNAMES sama sekali');
ok(!/hooks\.loadLayer\(/.test(cacheHit),
  'jalur cache-hit tidak memicu loadLayer (tidak ada DUMP:0)');

console.log('\n--- B. Snapshot diambil di waktu yang BENAR ---');
// Salah waktu = cache berisi isi preset, user melihat preset yang salah.
ok(/function captureDefaultIfActive\(\) \{[\s\S]*?if \(!currentActivePresetId\) captureDefaultSnapshot\(\);/.test(adaptive),
  'snapshot hanya diambil saat tidak ada preset aktif');
const act = adaptive.match(/async function activatePresetRuntime[\s\S]*?\n\}/);
ok(!!act, 'activatePresetRuntime ditemukan');
if (act) {
  const body = act[0];
  const capIdx = body.indexOf('captureDefaultIfActive()');
  const renderIdx = body.indexOf('renderPresetLocally(preset)');
  ok(capIdx > 0 && renderIdx > 0 && capIdx < renderIdx,
    'snapshot diambil SEBELUM renderPresetLocally menimpa state');
}
ok(/captureDefaultSnapshot\(\);/.test(swFn ? swFn[0] : ''),
  'fallback juga mengambil snapshot setelah baca selesai');

console.log('\n--- C. Snapshot divalidasi saat Default berubah ---');
ok(/export function invalidateDefaultSnapshot\(\)/.test(state),
  'ada invalidateDefaultSnapshot()');
ok(/export function clearDefaultSnapshot\(\)/.test(state),
  'ada clearDefaultSnapshot() untuk batas sesi koneksi');
ok(/clearDefaultSnapshot\(\)/.test(
  adaptive.match(/export function resetAdaptiveRuntimeState[\s\S]*?\n\}/)[0]),
  'snapshot dibuang tiap connect (device bisa punya Default berbeda)');
ok(/function defaultMayHaveChanged\(\)/.test(main), 'main.js punya helper invalidasi');
const invalidationCount = (main.match(/defaultMayHaveChanged\(\);/g) || []).length;
ok(invalidationCount >= 6,
  `semua jalur ubah-Default meng-invalidasi (ditemukan ${invalidationCount})`);
ok(/isDefaultContext\(\)/.test(main),
  'helper hanya meng-invalidasi saat memang di Default, bukan saat edit preset');

console.log('\n--- D. Kecepatan preset (tidak boleh ikut melambat) ---');
const actCached = act ? act[0] : '';
ok(/renderPresetLocally\(preset\)/.test(actCached),
  'preset masih dirender lokal (tidak read-back)');
ok(!/INFO'/.test(actCached), 'tidak ada INFO di jalur aktivasi preset');

console.log(fail === 0 ? '\nOK: perpindahan preset dan Default sama-sama cepat.' : `\n${fail} pemeriksaan gagal.`);
process.exit(fail === 0 ? 0 : 1);
