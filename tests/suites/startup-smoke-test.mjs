// Memuat SELURUH pohon modul src/main.js di Node dengan stub untuk @tauri-apps
import { readFileSync as readFile } from 'node:fs';
import { SRC, SRC_URL as APP, STUB_DIR } from '../runner/paths.mjs';
import { pathToFileURL } from 'node:url';
// dimuat - terutama TDZ / import siklik, yang lolos dari `vite build` tapi
// langsung mematikan app saat start.
//
// Jalankan: node startup-smoke-test.mjs
import { registerHooks } from 'node:module';

const STUB = pathToFileURL(`${STUB_DIR}/tauri-stubs.mjs`).href;

globalThis.__TauriStub = {
  invokeCalls: [],
  availablePorts: ['COM3', 'COM7'],
  invoked: {},
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'tauri-plugin-serialplugin') return { url: STUB, shortCircuit: true };
    if (specifier.startsWith('@tauri-apps/')) return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// ---- Stub DOM ----
const mkEl = (id) => ({
  id, value: 'COM7', textContent: '', innerHTML: '', checked: false, disabled: false,
  title: '', selectedIndex: 0, options: [], dataset: {}, style: {}, className: '',
  classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
  appendChild(c) { this.options.push(c); }, removeChild() { }, remove() { },
  querySelector() { return mkEl('sub'); }, querySelectorAll() { return []; },
  addEventListener() { }, removeEventListener() { }, setAttribute() { }, getAttribute() { return null; },
  focus() { }, blur() { }, click() { }, scrollIntoView() { },
});
const ELS = {};
globalThis.document = {
  getElementById: (id) => (ELS[id] || (ELS[id] = mkEl(id))),
  createElement: (t) => mkEl(t),
  querySelectorAll: () => [],
  querySelector: () => mkEl('q'),
  addEventListener() { }, removeEventListener() { }, body: mkEl('body'),
  createDocumentFragment: () => mkEl('frag'),
  documentElement: mkEl('html'),
};
globalThis.window = { addEventListener() { }, removeEventListener() { }, __TAURI__: {} };
globalThis.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = v; }, removeItem(k) { delete this._m[k]; } };
globalThis.confirm = () => true;
globalThis.alert = () => { };
globalThis.prompt = () => null;
globalThis.performance = { now: () => Date.now() };
globalThis.getCurrentWindow = () => ({ onCloseRequested: () => { }, close: () => { } });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 16);
globalThis.cancelAnimationFrame = (h) => clearTimeout(h);

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const S = globalThis.__TauriStub;

console.log('--- 1. Pohon modul muat tanpa exception ---');
let loaded = false, err = null;
try {
  await import(`${APP}/main.js`);
  loaded = true;
} catch (e) {
  err = e;
}
ok(loaded, loaded ? 'main.js dan seluruh import-nya berhasil dimuat' : `GAGAL: ${err && err.message}`);
if (err) {
  console.log('\n--- STACK ---');
  console.log((err.stack || '').split('\n').slice(0, 14).join('\n'));
  console.log('\n--- PETUNJUK ---');
  console.log('ReferenceError = TDZ: modul diakses sebelum initialized (import siklik / urutan).');
  console.log('TypeError      = elemen DOM null atau fungsi tidak terdefinisi saat wiring top-level.');
  process.exit(1);
}

console.log('\n--- 2. Stub plugin serial terpakai ---');
ok(S.serialConstructed > 0, `SerialPort dipakai (${S.serialConstructed} instance)`);

console.log('\n--- 3. autoDetect() benar-benar memanggil enumerasi port ---');
ok(S.invoked.available_ports > 0, `available_ports() dipanggil ${S.invoked.available_ports}x saat start`);

console.log('\n--- 4. Dropdown COM terisi hasil enumerasi ---');
const sel = ELS.portSelect;
ok(!!sel, 'el("portSelect") ada');
ok(sel && sel.options.length === S.availablePorts.length,
  `dropdown berisi ${sel ? sel.options.length : 0} opsi, diharapkan ${S.availablePorts.length}`);
if (sel && sel.options.length) {
  ok(sel.options.every((o, i) => o.value === S.availablePorts[i]),
    `opsi dropdown = ${sel.options.map(o => o.value).join(', ')}`);
}

console.log('\n--- 5. Semua fungsi init* benar-benar DIPANGGIL, bukan hanya diekstrak ---');
// Pelajaran dari dua bug sebelumnya: initAdaptivePage() dan initSidebar() sempat
// diekstrak ke modul tapi tidak pernah dipanggil. Build hijau, app jalan, tapi
// fiturnya mati diam-diam. Test ini menutup kelas bug itu.
const mainSrc = readFile(`${SRC}/main.js`, 'utf8');
// Cocokkan identifier apa pun, lalu difilter per nama - bukan hanya /^init/,
// supaya nama seperti setRgbTransport() ikut terhitung.
const callsIn = (src) => [...src.matchAll(/(?<![.\w])(\w+)\s*\(/g)].map((m) => m[1]);

// (a) fungsi init* yang dideklarasikan sendiri di main.js.
// Tidak harus ada - setelah Tahap 8 semua init* sudah tinggal di modul masing-masing.
const declaredHere = [...mainSrc.matchAll(/\bfunction\s+(init\w+)\s*\(/g)].map((m) => m[1]);
console.log(`  info ${declaredHere.length} fungsi init* masih dideklarasikan di main.js` +
  (declaredHere.length ? ` (${[...new Set(declaredHere)].join(', ')})` : ' - semua sudah diekstrak'));
for (const name of new Set(declaredHere)) {
  const n = callsIn(mainSrc).filter((c) => c === name).length;
  ok(n > 0, `${name}() dipanggil (${n}x)`);
}
// (b) init* yang diekstrak ke modul lain dan harus dipanggil dari main.js
for (const name of ['initSidebar', 'initRouter', 'initAdaptive', 'initAdaptivePage',
  'initBatteryUi', 'initProtocolParser', 'initTransport', 'initRgbPage', 'setRgbTransport',
  'initHomePage', 'initEditorPanel', 'initAppPicker',
  'initTray', 'initAutostart', 'initAutostartToggle', 'initTrayHandlers']) {
  const n = callsIn(mainSrc).filter((c) => c === name).length;
  ok(n > 0, `${name}() dipanggil dari main.js (${n}x)`);
}

console.log('\n--- 6. Kontrol utama masih terpasang di DOM ---');
const routerSrc = readFile(`${SRC}/ui-router.js`, 'utf8');
// Toggle sidebar sekarang milik ui-router.js (sudah ikut diekstrak), sisanya di main.js.
ok(routerSrc.includes("el('btnToggleSidebar')"), 'toggle sidebar di-wire di ui-router.js');
for (const id of ['btnConnect', 'btnSave', 'btnRefreshPorts', 'editType']) {
  ok(mainSrc.includes(`el('${id}')`), `el('${id}') masih di-wire di main.js`);
}
ok(/initSidebar\(\)/.test(mainSrc), 'main.js memanggil initSidebar()');

console.log(`\n${fail === 0 ? 'HASIL: startup app tidak melempar error dan port terbaca' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);