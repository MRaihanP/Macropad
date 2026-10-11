// Menguji jeda auto-switch setelah user pindah layer dari device (step 4).
//
// Bug ditutup: lastDeviceLayerEventAt sudah diisi setiap ada EVT:LAYER: sejak
// lama, tapi tidak pernah dibaca siapa pun. Akibatnya preset Adaptive yang
// aktif bisa langsung memaksa balik ke layer 0 dalam ~120 ms (interval poll),
// dan pilihan layer user hilang tanpa sebab.
//
// Dua bagian:
//  A. Auto-switch ditunda setelah EVT:LAYER: (memakai getLastDeviceLayerEventAt
//     yang dulu write-only).
//  B. EVT:LAYER: yang datang di tengah dump ditunda, bukan langsung diterapkan -
//     kalau langsung diterapkan, DUMP_END akan me-resolve waiter yang salah dan
//     preset setengah jadi bisa tersimpan ke disk.
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const adaptive = fs.readFileSync(path.join(root, 'src/adaptive.js'), 'utf8');
const parser = fs.readFileSync(path.join(root, 'src/protocol-parser.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Jeda setelah EVT:LAYER: ---');
ok(/const LAYER_CHOICE_HOLD_MS = \d+;/.test(adaptive),
  'ada konstanta LAYER_CHOICE_HOLD_MS (jeda terdefinisi, bukan angka magis inline)');
ok(/function autoSwitchBlockedByLayerChoice\(\)/.test(adaptive),
  'ada helper autoSwitchBlockedByLayerChoice()');
ok(/Date\.now\(\) - lastDeviceLayerEventAt < LAYER_CHOICE_HOLD_MS/.test(adaptive),
  'helper membandingkan waktu sejak event dengan ambang jeda');
// 0 berarti belum pernah ada event - harus mengembalikan false, bukan memblokir
// auto-switch selamanya.
ok(/if \(lastDeviceLayerEventAt === 0\) return false;/.test(adaptive),
  'nilai 0 (belum ada event) tidak memblokir auto-switch');
ok(/if \(autoSwitchBlockedByLayerChoice\(\)\) return;/.test(adaptive),
  'pollFocusedApp() benar-benar memakai helper itu (read-only state jadi berfungsi)');

console.log('\n--- B. Ditunda juga saat dump berjalan ---');
ok(/return dumpInProgress;/.test(adaptive),
  'helper juga memblokir selama dump berjalan');
ok(/dumpInProgress/.test(adaptive) && /from '\.\/serial-transport\.js'/.test(adaptive),
  'dumpInProgress diambil dari serial-transport (tidak ada siklus baru)');

console.log('\n--- C. EVT:LAYER: di tengah dump ditunda, bukan diterapkan ---');
ok(/let pendingLayerAfterDump = null;/.test(parser),
  'ada state pendingLayerAfterDump');
const evBlock = parser.match(/if \(line\.startsWith\('EVT:LAYER:'\)\) \{([\s\S]*?)\n  \}/);
ok(!!evBlock, 'blok EVT:LAYER: ditemukan');
if (evBlock) {
  ok(/if \(dumpInProgress\) \{/.test(evBlock[1]),
    'EVT:LAYER: memeriksa dumpInProgress');
  ok(/pendingLayerAfterDump = n;/.test(evBlock[1]),
    'layer disimpan untuk diterapkan nanti (bukan diabaikan/dibuang)');
  // applyLayerEvent harus TIDAK dipanggil di cabang dump - kalau dipanggil,
  // currentLayer berubah di tengah dump dan DUMP_END resolve waiter yang salah.
  const dumpBranch = evBlock[1].match(/if \(dumpInProgress\) \{([\s\S]*?)\n    \}/);
  ok(dumpBranch && !/applyLayerEvent/.test(dumpBranch[1]),
    'applyLayerEvent TIDAK dipanggil saat dump berjalan (currentLayer tidak berubah di tengah dump)');
}

console.log('\n--- D. Diterapkan setelah DUMP_END ---');
// CATATAN: urutan apply-vs-resolve TIDAK diuji di sini. Cek berbasis regex
// tidak bisa membedakan `if (x)` dari `if (false && x)` - keduanya sama-sama
// memuat applyLayerEvent(pending), jadi test teks akan lolos padahal fiturnya
// sudah dimatikan. Urutan itu diuji di layer-hold-behaviour-test.js, yang
// menjalankan ulang alurnya dan memang menangkap bug urutan yang terjadi.
const endBlock = parser.match(/if \(line === 'DUMP_END'\) \{([\s\S]*?)\n  \}/);
ok(!!endBlock, 'blok DUMP_END ditemukan');
if (endBlock) {
  ok(/hasPendingLayerAfterDump\(\)/.test(endBlock[1]),
    'DUMP_END mengecek apakah ada layer tertunda');
  ok(/takePendingLayerAfterDump\(\)/.test(endBlock[1]),
    'DUMP_END mengambil layer tertunda');
  ok(/applyLayerEvent\(pending\)/.test(endBlock[1]),
    'layer tertunda diterapkan di dalam DUMP_END');
  // resolveDumpWaiters harus tetap dipanggil - itu yang menyelesaikan dump.
  ok(/resolveDumpWaiters\(done\)/.test(endBlock[1]),
    'DUMP_END tetap me-resolve waiter dump (tidak hilang digantikan logika baru)');
}

console.log('\n--- E. Arah import tetap satu-way (tidak ada siklus) ---');
// parser sudah mengimpor adaptive (escape/preset). adaptive TIDAK boleh
// mengimpor parser - itu akan menutup lingkaran.
ok(!/from '\.\/protocol-parser\.js'/.test(adaptive),
  'adaptive.js TIDAK mengimpor protocol-parser.js (tidak ada siklus)');
ok(/from '\.\/adaptive\.js'/.test(parser), 'protocol-parser.js mengimpor adaptive.js');
// Nilai dikirim lewat panggilan, bukan import balik.
ok(/noteDeviceLayerEvent\(\)/.test(parser),
  'parser memberi tahu adaptive lewat noteDeviceLayerEvent()');
ok(/export function noteDeviceLayerEvent\(\)/.test(adaptive),
  'adaptive menyediakan noteDeviceLayerEvent()');
ok(!/getLastDeviceLayerEventAt/.test(adaptive) || !/getLastDeviceLayerEventAt/.test(parser),
  'getLastDeviceLayerEventAt yang lama sudah tidak jadi jalur utama');

console.log('\n--- F. State dibersihkan saat koneksi putus ---');
ok(/export function resetLayerChoiceHold\(\)/.test(adaptive),
  'ada resetLayerChoiceHold()');
ok(/export function resetAdaptiveRuntimeState\(\) \{[\s\S]*?lastDeviceLayerEventAt = 0;/.test(adaptive),
  'resetAdaptiveRuntimeState() mengosongkan waktu event');
ok(/pendingLayerAfterDump = null;/.test(parser),
  'resetDeviceProfile() mengosongkan layer tertunda');
ok(/resetAdaptiveRuntimeState/.test(main), 'main.js memanggil resetAdaptiveRuntimeState()');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
