// Menguji waitForDump() yang SESUNGGUHNYA dipakai app. Modul Adaptive sudah
// diekstrak dari main.js ke src/adaptive.js, jadi potongan diambil dari sana.
// diambil dari sana.
const fs = require('fs');
const src = fs.readFileSync('src/adaptive.js', 'utf8');

const start = src.indexOf('function waitForDump(layer, timeoutMs)');
const end = src.indexOf('async function fetchAllLayersForPacking');
if (start < 0 || end < 0) { console.error('SLICE GAGAL'); process.exit(1); }
// Buang prefiks export: potongan dijalankan lewat new Function (bukan modul ES),
// dan resolveDumpWaiters ikut terbawa di antara waitForDump dan fetchAllLayersForPacking.
const slice = src.slice(start, end).replace(/^export /gm, "");

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// dumpWaiters & currentLayer dideklarasikan di luar potongan, jadi dioper sebagai
// parameter supaya kode yang diuji persis sama dengan yang jalan di app.
// `t` juga dioper: potongan memakai t() untuk pesan error (i18n), dan new Function
// tidak mewarisi scope modul.
function harness() {
  const logs = [];
  const log = (m) => logs.push(m);
  const dumpWaiters = new Map();
  const currentLayer = 0;
  const t = (k) => k;   // stub terjemahan: cukup mengembalikan kuncinya
  const factory = new Function('dumpWaiters', 'currentLayer', 'log', 'setTimeout', 'clearTimeout', 't',
    slice + '\n return { waitForDump };');
  const api = factory(dumpWaiters, currentLayer, log, setTimeout, clearTimeout, t);
  const resolveLayer = (layer, v) => {
    const s = dumpWaiters.get(layer);
    if (s) [...s].forEach(e => e.resolve(v));
  };
  return { api, logs, dumpWaiters, resolveLayer };
}

(async () => {
  console.log('--- 1. Dump latar belakang tidak boleh me-resolve waiter packer ---');
  {
    const h = harness();
    let packerDone = null, bgDone = null;
    const packer = h.api.waitForDump(2, 500).then(v => { packerDone = v; });
    const bg = h.api.waitForDump(0, 500).then(v => { bgDone = v; });
    h.resolveLayer(0, true);                      // device selesai untuk layer 0 dulu
    await sleep(30);
    ok(bgDone === true, 'waiter layer 0 ter-resolve');
    ok(packerDone === null, `waiter packer (layer 2) BELUM ter-resolve (nilai=${packerDone})`);
    h.resolveLayer(2, true);
    await Promise.all([packer, bg]);
    ok(packerDone === true, 'waiter packer ter-resolve setelah DUMP_END layer 2');
  }

  console.log('\n--- 2. Timeout kalau device tidak menjawab ---');
  {
    const h = harness();
    const t0 = Date.now();
    const res = await h.api.waitForDump(1, 200);
    const dt = Date.now() - t0;
    ok(res === false, 'timeout mengembalikan false (bukan menggantung)');
    ok(dt >= 180 && dt < 700, `timeout jalan ~200ms (terukur ${dt}ms)`);
    ok(h.logs.some(l => l.includes('adaptive.timeoutLog')), `ada pesan timeout di log (${JSON.stringify(h.logs)})`);
  }

  console.log('\n--- 3. Dua waiter untuk layer sama: keduanya harus selesai ---');
  {
    const h = harness();
    let r1 = null, r2 = null;
    const first = h.api.waitForDump(3, 1000).then(v => { r1 = v; });
    const second = h.api.waitForDump(3, 1000).then(v => { r2 = v; });
    ok(h.dumpWaiters.get(3).size === 2, `kedua waiter cohabit di layer yang sama (size=${h.dumpWaiters.get(3).size})`);
    h.resolveLayer(3, true);
    const both = await Promise.all([first, second]);
    ok(r1 === true && r2 === true, `keduanya ter-resolve: ${JSON.stringify(both)}`);
    ok(!h.dumpWaiters.has(3), 'entri waiter dibersihkan setelah selesai');
  }

  console.log('\n--- 4. DUMP_END untuk layer lain tidak menyelesaikan waiter ini ---');
  {
    const h = harness();
    let done = null;
    const w = h.api.waitForDump(5, 300).then(v => { done = v; });
    h.resolveLayer(0, true);                       // device menjawab untuk layer yang SALAH
    await sleep(30);
    ok(done === null, 'waiter layer 5 tidak ikut selesai karena DUMP_END layer 0');
    h.resolveLayer(5, true);
    await w;
    ok(done === true, 'waiter layer 5 selesai setelah DUMP_END layer 5');
  }

  console.log('\n--- 5. waiter tanpa nomor layer memakai currentLayer ---');
  {
    const h = harness();
    let done = null;
    const w = h.api.waitForDump().then(v => { done = v; });
    h.resolveLayer(0, true);
    await w;
    ok(done === true, 'waitForDump() tanpa argumen memakai currentLayer (0)');
  }

  console.log(fail === 0 ? '\nHASIL: waiter DUMP per-layer berperilaku benar' : `\nHASIL: ${fail} gagal`);
  process.exit(fail === 0 ? 0 : 1);
})();