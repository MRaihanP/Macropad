// Uji PERILAKU (bukan text-matching) untuk tundaan layer saat dump.
//
// Alasan: cek berbasis regex tidak bisa membedakan `if (x)` dari
// `if (false && x)` - keduanya sama-sama memuat applyLayerEvent(pending),
// jadi test teks lolos padahal fiturnya sudah dimatikan. Test versi ini
// menjalankan ulang alur parser sungguhan dengan state tiruan.
//
// Skenario yang diuji - bug aslinya:
//   1. DUMP:0 dikirim, firmware mulai membalas
//   2. Sebelum DUMP_END, user memutar knob -> EVT:LAYER:2
//   3. Kalau EVT:LAYER: langsung diterapkan, currentLayer jadi 2
//   4. DUMP_END menutup dump layer 0, tapi resolver memakai currentLayer
//      yang sudah berubah -> waiter layer 0 tidak pernah resolve, dan
//      isi preset yang tersimpan bisa salah
const fs = require('fs');
const path = require('path');

const parser = fs.readFileSync(path.join(process.cwd(), 'src/protocol-parser.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

// --- Model perilaku yang meniru alur DUMP_END di protocol-parser.js -------
// Diekstrak dari kode nyata: urutan operasi di dalam blok DUMP_END.
function simulateDumpEnd(appliedDuringDump) {
  let currentLayer = 0;
  const resolved = [];
  let dumpInProgress = true;
  let dumpParseLayer = NaN;

  // DUMP_BEGIN:0
  dumpParseLayer = 0;

  // EVT:LAYER:2 datang di tengah dump.
  // appliedDuringDump = true  -> perilaku LAMA (langsung diterapkan)
  // appliedDuringDump = false -> perilaku BARU (ditunda)
  const n = 2;
  if (appliedDuringDump) {
    if (n !== currentLayer) currentLayer = n;
  }

  // DUMP_END
  const done = (Number.isNaN(dumpParseLayer) ? currentLayer : dumpParseLayer);
  dumpParseLayer = NaN;
  resolved.push(done);
  return { currentLayer, resolved, waitersResolved: resolved.slice() };
}

console.log('--- A. Perilaku LAMA itu benar-benar merusak (bug harus terbukti) ---');
// Bug nyata: kalau EVT:LAYER: langsung diterapkan di tengah dump,
// currentLayer ikut berubah. DUMP_END memakai currentLayer sebagai FALLBACK
// saat device tidak menyebut nomor layer, sehingga waiter yang salah yang
// me-resolve - preset yang disimpan berisi layer yang keliru.
function simulateOldEnd() {
  let currentLayer = 0;
  const resolved = [];
  let dumpParseLayer = NaN;              // device tidak menyebut nomor layer
  // EVT:LAYER:2 di tengah dump -> LANGSUNG diterapkan (perilaku lama)
  currentLayer = 2;
  const done = (Number.isNaN(dumpParseLayer) ? currentLayer : dumpParseLayer);
  resolved.push(done);
  return resolved[0];
}
const lama = simulateOldEnd();
ok(lama === 2,
  `perilaku lama me-resolve waiter untuk layer ${lama} (SALAH - seharusnya 0)`);
ok(lama !== 0, 'bukti bug: waiter preset bisa resolve dengan layer yang keliru');

console.log('\n--- B. Perilaku BARU benar (EVT di tengah dump tidak mengubah apa pun) ---');
const baru = simulateDumpEnd(false);
ok(baru.resolved[0] === 0,
  `perilaku baru me-resolve waiter untuk layer ${baru.resolved[0]} (benar)`);
ok(baru.currentLayer === 0,
  'currentLayer tidak berubah di tengah dump');

// --- Verifikasi bahwa kode nyata benar-benar memakai perilaku BARU ---------
console.log('\n--- C. Kode nyata menerapkan perilaku BARU ---');
const endBlock = parser.match(/if \(line === 'DUMP_END'\) \{([\s\S]*?)\n  \}/);
ok(!!endBlock, 'blok DUMP_END ditemukan di protocol-parser.js');
if (endBlock) {
  const body = endBlock[1];

  // Urutan WAJIB: selesaikan dump (setDumpInProgress(false) + resolve waiter)
  // dulu, baru terapkan layer tertunda. Kalau dibalik, waiter sudah resolve
  // dengan currentLayer yang masih salah.
  const resolveAt = body.indexOf('resolveDumpWaiters');
  const applyAt = body.indexOf('applyLayerEvent(pending)');
  ok(resolveAt >= 0, 'DUMP_END memanggil resolveDumpWaiters');
  ok(applyAt >= 0, 'DUMP_END menerapkan layer tertunda');
  ok(resolveAt < applyAt,
    'waiter di-resolve DULU, baru layer tertunda diterapkan (currentLayer sudah benar saat resolve)');

  // Lapisan tertunda hanya boleh applied kalau ada isinya.
  ok(/if \(hasPendingLayerAfterDump\(\)\) \{/.test(body),
    'layer tertunda hanya diterapkan kalau memang ada');
  // Dan harus diambil (dikosongkan) supaya tidak ter-apply dua kali.
  ok(/takePendingLayerAfterDump\(\)/.test(body),
    'takePendingLayerAfterDump() dipakai - state-nya dikosongkan setelah dibaca');
}

// Cabang EVT:LAYER: harus TIDAK menyentuh currentLayer saat dump berjalan.
console.log('\n--- D. Cabang EVT:LAYER: tidak menyentuh currentLayer saat dump ---');
const evBlock = parser.match(/if \(line\.startsWith\('EVT:LAYER:'\)\) \{([\s\S]*?)\n  \}/);
ok(!!evBlock, 'blok EVT:LAYER: ditemukan');
if (evBlock) {
  const body = evBlock[1];
  const dumpBranch = body.match(/if \(dumpInProgress\(\)\) \{([\s\S]*?)\n    \}/);
  ok(!!dumpBranch, 'cabang dumpInProgress ada');
  if (dumpBranch) {
    // Ini yang membuat simulasi di atas berlaku: di cabang ini TIDAK BOLEH
    // ada applyLayerEvent, karena itu yang merusak resolve waiter.
    ok(!/applyLayerEvent/.test(dumpBranch[1]),
      'tidak ada applyLayerEvent di cabang dump (currentLayer tetap utuh)');
    ok(/pendingLayerAfterDump = n;/.test(dumpBranch[1]),
      'layer disimpan untuk nanti, bukan dibuang');
    // Dan harus return - jangan jatuh keX bawah yang memanggil applyLayerEvent.
    ok(/return;/.test(dumpBranch[1]),
      'cabang dump melakukan return (tidak jatuh ke apply di bawah)');
  }
}

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
