// Membandingkan perintah serial yang dikirim adaptive.js sekarang dengan yang
// dikirim blok Adaptive di main.js SEBELUM ekstraksi (diambil dari git HEAD).
//
// Tujuannya menangkap perintah yang hilang diam-diam saat pemindahan kode -
// tidak ada error build yang akan memberi tahu kalau satu `await sendLine(...)`
// ikut hilang.
//
// Jalankan: node adaptive-contract-test.js
const fs = require('fs');
const { execSync } = require('child_process');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

// Commit tepat SEBELUM Adaptive diekstrak (tahap 3 = transport). Dipin, bukan
// memakai HEAD: begitu ekstraksi di-commit, blok lama sudah tidak ada di HEAD
// dan test ini akan salah melaporkan "blok tidak ditemukan".
const BEFORE_ADAPTIVE = 'ad8ae07';
const oldMain = execSync(`git show ${BEFORE_ADAPTIVE}:src/main.js`, { maxBuffer: 1 << 28 }).toString();

// Blok Adaptive versi lama: dari banner "Manajemen Preset" sampai setInterval poll.
const start = oldMain.indexOf('// ==================== ADAPTIVE KEY BIND');
const end = oldMain.indexOf('setInterval(pollFocusedApp, FOCUS_POLL_MS);');
ok(start >= 0 && end > start, `blok Adaptive lama ditemukan (${start}..${end})`);
const oldBlock = oldMain.slice(start, end);

const newMod = fs.readFileSync('src/adaptive.js', 'utf8');
const newMain = fs.readFileSync('src/main.js', 'utf8');

// Kumpulkan nama perintah yang muncul sebagai argumen sendLine/sendBatch.
function commands(src) {
  const out = new Set();
  const re = /(?:sendLine|sendBatch)\(\s*(['"`])([A-Z]+)/g;
  let m;
  while ((m = re.exec(src))) out.add(m[2]);
  // sendBatch juga menerima array literal ['A', 'B', ...]
  const re2 = /sendBatch\(\s*\[([^\]]*)\]/g;
  while ((m = re2.exec(src))) {
    for (const s of m[1].matchAll(/['"]([A-Z]+)['"]/g)) out.add(s[1]);
  }
  return out;
}

const oldCmds = commands(oldBlock);
const newCmds = commands(newMod);
const mainCmds = commands(newMain);

console.log('\n--- 1. Tidak ada perintah serial yang hilang saat ekstraksi ---');
const missing = [...oldCmds].filter(c => !newCmds.has(c)).sort();
ok(missing.length === 0, `semua ${oldCmds.size} perintah lama masih ada${missing.length ? ' (hilang: ' + missing.join(', ') + ')' : ''}`);
console.log(`  perintah di blok lama : ${[...oldCmds].sort().join(', ')}`);
console.log(`  perintah di adaptive.js: ${[...newCmds].sort().join(', ')}`);

console.log('\n--- 2. Format perintah bertemplate tetap sama ---');
// Pola bertemplate (SLOT:, SET:, SETENC:, RENAMELAYER:, LAYER:, DUMP:) harus utuh
// persis seperti di versi lama - nama variabel di dalamnya boleh sama.
const templates = [...oldBlock.matchAll(/(?:sendLine|sendBatch)\(\s*`([^`]*)`/g)].map(m => m[1]);
const uniqueT = [...new Set(templates)];
const lost = uniqueT.filter(t => !newMod.includes('`' + t + '`'));
ok(lost.length === 0, `semua ${uniqueT.length} perintah bertemplate ada persis sama di adaptive.js${lost.length ? ' (hilang: ' + lost.join(' | ') + ')' : ''}`);
for (const t of uniqueT) console.log(`  ${newMod.includes('`' + t + '`') ? 'OK  ' : 'FAIL'} ${t}`);

console.log('\n--- 3. Konstanta runtime tidak berubah ---');
ok(/FOCUS_DEBOUNCE_MS = 150/.test(newMod), 'FOCUS_DEBOUNCE_MS masih 150 ms');
ok(/FOCUS_POLL_MS = 120/.test(newMod), 'FOCUS_POLL_MS masih 120 ms');
ok(/const APP_SLOTS = 6/.test(newMod), 'APP_SLOTS masih 6 (harus sama dengan firmware)');
ok(/quietOkUntil = Date\.now\(\) \+ 500/.test(newMod), 'jendela sunyi quietOkUntil masih 500 ms');
ok(/timeoutMs \|\| 3000/.test(newMod), 'timeout waiter DUMP masih 3000 ms');

console.log('\n--- 4. main.js tidak lagi menduplikasi logika Adaptive ---');
for (const fn of ['pollFocusedApp', 'activatePresetRuntime', 'replayPresetLayers', 'buildPresetLines',
  'packCurrentAsPresetLayers', 'waitForDump', 'fetchAllLayersForPacking', 'pickBindableApp',
  'getBindableApps', 'renderPresetList', 'openPresetEditor', 'exitPresetEditor', 'updateActivePresetLabel']) {
  const stillThere = new RegExp(`^(async )?function ${fn}\\b`, 'm').test(newMain);
  ok(!stillThere, `${fn} tidak lagi didefinisikan di main.js`);
}

console.log('\n--- 5. main.js memakai API modul Adaptive ---');
for (const api of ['initAdaptive({', 'initAdaptivePage();', 'loadPresets();', 'resetAdaptiveRuntimeState()',
  'confirmLeavePresetEditor()']) {
  ok(newMain.includes(api), `main.js memakai ${api}`);
}
ok(/from "\.\/adaptive\.js"/.test(newMain), 'main.js meng-import adaptive.js');

console.log('\n--- 5b. protocol-parser.js memakai API Adaptive yang lain ---');
// Lima API ini dipakai dari handleLine, yang sekarang tinggal di protocol-parser.js.
const newParser = fs.readFileSync('src/protocol-parser.js', 'utf8');
for (const api of ['suppressDeviceEcho()', 'activePresetName()', 'activePresetLayers()',
  'resolveDumpWaiters(', 'handleEscapeGesture()']) {
  ok(newParser.includes(api), `protocol-parser.js memakai ${api}`);
}
ok(/from ['"]\.\/adaptive\.js['"]/.test(newParser), 'protocol-parser.js meng-import adaptive.js');

console.log('\n--- 6. Global main.js tidak bocor ke adaptive.js ---');
// Hanya call site yang diuji: deklarasi hook (mis. "switchPage: () => {}") memang
// wajar menyebut nama fungsi itu, yang dilarang adalah memanggilnya langsung.
const globals = ['renderTabs', 'renderGrid', 'renderEncoderList', 'loadLayer', 'switchPage',
  'showModalBase', 'showConfirmModal', 'showPromptModal', 'resetEditorState', 'notifyBoundAction', 'sleep'];
for (const g of globals) {
  const uses = new RegExp('(?<![\\w.])' + g + '\\(').test(newMod);
  ok(!uses, `adaptive.js tidak memanggil ${g}() secara langsung`);
}
const bareNotify = new RegExp('(?<![\\w.])notify\\(').test(newMod);
ok(!bareNotify, 'adaptive.js tidak memanggil notify() secara langsung');
ok(/hooks\.showConfirmModal/.test(newMod), 'modal lewat hooks.showConfirmModal');
ok(/hooks\.notify/.test(newMod), 'notifikasi lewat hooks.notify');
ok(/hooks\.isDirty\(\)/.test(newMod), 'flag dirty dibaca lewat hooks.isDirty()');

console.log('\n--- 7. TYPE_NAMES hanya ada di device-state.js ---');
ok(!/^const TYPE_NAMES =/m.test(newMain), 'main.js tidak lagi mendefinisikan TYPE_NAMES');
const ds = fs.readFileSync('src/device-state.js', 'utf8');
ok(/export const TYPE_NAMES = \["NONE", "KEY", "COMBO", "TEXT", "CONSUMER", "APP"\]/.test(ds),
  'TYPE_NAMES diekspor dari device-state.js dengan isi yang sama');
ok(/TYPE_NAMES/.test(newMod), 'adaptive.js mengimpor TYPE_NAMES dari device-state.js');

console.log(`\n${fail === 0 ? 'HASIL: kontrak Adaptive main.js <-> adaptive.js konsisten' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);