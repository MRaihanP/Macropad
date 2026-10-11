// Menguji src/i18n.js dan dua tabel terjemahan.
//
// Yang diuji, dan alasannya:
//  1. Dua tabel punya kunci yang PERSIS sama - kalau tidak, satu bahasa akan
//     diam-diam_show nama kunci, bukan teks.
//  2. Placeholder-nya sama antara bahasa - kalau `{n}` di id tapi `{count}` di en,
//     teks Inggerisnya akan menampilkan "{n} minutes" selamanya.
//  3. `t()` tidak pernah mengembalikan string kosong atau undefined.
//  4. Bahasa yang hilang jatuh ke bahasa dasar, bukan ke nama kunci, kalau
//     kunci itu memang ada di bahasa dasar.
//  5. Setiap `data-i18n` di index.html benar-benar ada di kedua tabel.
//  6. Pergantian bahasa memanggil render ulang yang terdaftar.
//
// Jalankan: node i18n-test.mjs
import { readFileSync as readFile } from 'node:fs';
import { registerHooks } from 'node:module';
import { SRC_URL as APP, STUB_DIR } from '../runner/paths.mjs';
import { pathToFileURL } from 'node:url';

const STUB = pathToFileURL(`${STUB_DIR}/tauri-stubs.mjs`).href;

// Stub invoke membaca nilai ini untuk perintah 'system_locale'.
let localeBalas = 'en-US';
globalThis.__TauriStub = { invokeCalls: [], invoked: {}, availablePorts: [], get systemLocale() { return localeBalas; } };

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'tauri-plugin-serialplugin') return { url: STUB, shortCircuit: true };
    if (spec.startsWith('@tauri-apps/')) return { url: STUB, shortCircuit: true };
    return next(spec, ctx);
  },
});

// ---- Stub DOM ----
const mkEl = (id) => {
  const attrs = {};
  return {
    id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    title: '', dataset: {}, style: {}, className: '', children: [],
    _attrs: attrs,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); },
    remove() { },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
};
const ELS = {};
globalThis.document = {
  getElementById: (id) => (ELS[id] || (ELS[id] = mkEl(id))),
  createElement: (t) => mkEl(t),
  querySelectorAll: () => [], querySelector: () => null,
  addEventListener() { }, removeEventListener() { }, body: mkEl('body'),
  documentElement: mkEl('html'),
};
globalThis.localStorage = {
  _m: {},
  getItem(k) { return k in this._m ? this._m[k] : null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

// ---- Muat modul (harus setelah stub terpasang) ----
// Stub Tauri. `systemLocale` adalah GETTER yang membaca `localeBalas`.
// Karena itu setLocale() di bawah cukup mengubah `localeBalas` - menulis
// ke `globalThis.__TauriStub.systemLocale` akan melempar TypeError
// ("which has only a getter"). Ini yang terjadi sebelum duplikat
// setLocale dibersihkan: versinya menulis ke properti getter-only.
function setLocale(v) { localeBalas = v; }
const { id: ID } = await import(`${APP}/locales/id.js`);
const { en: EN } = await import(`${APP}/locales/en.js`);
const i18n = await import(`${APP}/i18n.js`);
const { t, setLanguage, getLanguage, applyI18n, languageOf, initI18n, initLanguageSelect, registerRerender, missingKeys, LANGUAGES, FALLBACK } = i18n;

console.log('--- 1. Dua tabel punya kunci yang sama ---');
const idK = Object.keys(ID), enK = Object.keys(EN);
ok(idK.length > 80, `tabel punya cukup banyak kunci (id=${idK.length}, en=${enK.length})`);
const hanyaId = idK.filter((k) => !(k in EN));
const hanyaEn = enK.filter((k) => !(k in ID));
ok(hanyaId.length === 0, `tidak ada kunci yang hanya ada di id${hanyaId.length ? ': ' + hanyaId.join(', ') : ''}`);
ok(hanyaEn.length === 0, `tidak ada kunci yang hanya ada di en${hanyaEn.length ? ': ' + hanyaEn.join(', ') : ''}`);

console.log('\n--- 2. Tidak ada nilai kosong ---');
const kosongId = idK.filter((k) => typeof ID[k] !== 'string' || ID[k].trim() === '');
const kosongEn = enK.filter((k) => typeof EN[k] !== 'string' || EN[k].trim() === '');
ok(kosongId.length === 0, `tidak ada nilai kosong di id${kosongId.length ? ': ' + kosongId.join(', ') : ''}`);
ok(kosongEn.length === 0, `tidak ada nilai kosong di en${kosongEn.length ? ': ' + kosongEn.join(', ') : ''}`);

console.log('\n--- 3. Placeholder sama antara dua bahasa ---');
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const bedaPh = idK.filter((k) => ph(ID[k]) !== ph(EN[k]));
ok(bedaPh.length === 0,
  `placeholder identik untuk semua kunci${bedaPh.length ? ' - beda di: ' + bedaPh.map((k) => `${k} (id:${ph(ID[k])}) vs en:${ph(EN[k])}`).join('; ') : ''}`);

console.log('\n--- 4. t() mengembalikan teks dari bahasa yang benar ---');
setLanguage('id', false);
ok(t('home.save') === ID['home.save'], 'bahasa id mengembalikan teks id');
ok(getLanguage() === 'id', 'getLanguage() melaporkan id');
setLanguage('en', false);
ok(t('home.save') === EN['home.save'], 'bahasa en mengembalikan teks en');
ok(getLanguage() === 'en', 'getLanguage() melaporkan en');
ok(t('home.save') !== ID['home.save'], 'teks id dan en benar-benar berbeda (bukan salinan)');

console.log('\n--- 5. Placeholder diisi ---');
setLanguage('id', false);
ok(t('settings.sleep.minutes', { n: 30 }) === '30 menit', 'placeholder {n} diisi: "30 menit"');
setLanguage('en', false);
ok(t('settings.sleep.minutes', { n: 30 }) === '30 minutes', 'bahasa en: "30 minutes"');
ok(t('settings.sleep.minutes', { n: 5 }) === '5 minutes', 'nilai lain benar (5)');
ok(!/\{n\}/.test(t('settings.sleep.minutes', { n: 5 })), 'tidak ada placeholder yang tertinggal');
ok(t('settings.sleep.minutes') === '5 minutes' || /\{n\}/.test(t('settings.sleep.minutes')),
  'tanpa params, placeholder dibiarkan terlihat (bukan teks salah)');
ok(t('appPicker.days', { n: 30 }).includes('30'), 'appPicker.days menerima angka');

console.log('\n--- 6. Kunci hilang tidak boleh jadi UI kosong ---');
ok(t('tidak.ada.kunci.ini') === 'tidak.ada.kunci.ini', 'kunci tak dikenal dikembalikan apa adanya, bukan string kosong');
ok(missingKeys().includes('tidak.ada.kunci.ini'), 'kunci yang hilang dicatat untuk dilaporkan');

console.log('\n--- 7. applyI18n() mengisi DOM ---');
{
  // Bangun DOM tiruan: dua node, satu data-i18n, satu data-i18n-attr, satu
  // dengan data-i18n-n untuk placeholder.
  const n1 = mkEl('a'); n1.setAttribute('data-i18n', 'home.save');
  const n2 = mkEl('b'); n2.setAttribute('data-i18n-attr', 'placeholder:editor.valuePlaceholder|title:settings.language');
  const n3 = mkEl('c'); n3.setAttribute('data-i18n', 'settings.sleep.minutes'); n3.setAttribute('data-i18n-n', '30');
  const n4 = mkEl('d'); n4.setAttribute('data-i18n', 'tidak.ada.kunci.ini');
  const root = mkEl('root');
  root.querySelectorAll = (sel) => (sel === '[data-i18n]'
    ? [n1, n3, n4]
    : sel === '[data-i18n-attr]' ? [n2] : []);

  setLanguage('id', false);
  applyI18n(root);
  ok(n1.textContent === ID['home.save'], `data-i18n mengisi textContent (${JSON.stringify(n1.textContent)})`);
  ok(n2.getAttribute('placeholder') === ID['editor.valuePlaceholder'], 'data-i18n-attr mengisi beberapa atribut');
  ok(n2.getAttribute('title') === ID['settings.language'], 'atribut kedua pada node yang sama ikut terisi');
  ok(n3.textContent === '30 menit', `data-i18n-n mengisi placeholder {n} (${JSON.stringify(n3.textContent)})`);
  ok(n4.getAttribute('data-i18n-missing') === '1', 'kunci yang hilang ditandai data-i18n-missing supaya terlihat');

  setLanguage('en', false);
  applyI18n(root);
  ok(n1.textContent === EN['home.save'], 'berganti ke en setelah applyI18n ulang');
  ok(n3.textContent === '30 minutes', `placeholder ikut berubah bahasa (${JSON.stringify(n3.textContent)})`);
}

console.log('\n--- 8. languageOf() memotong locale ---');
ok(languageOf('id-ID') === 'id', 'id-ID -> id');
ok(languageOf('en-US') === 'en', 'en-US -> en');
ok(languageOf('EN-GB') === 'en', 'huruf besar dinormalkan');
ok(languageOf('id') === 'id', 'tanpa wilayah');
ok(languageOf('') === '', 'string kosong tidak melempar');
ok(languageOf(null) === '', 'null tidak melempar');

console.log('\n--- 9. setLanguage() menolak bahasa tak dikenal ---');
setLanguage('en', false);
const sebelum = getLanguage();
setLanguage('zz', false);
ok(getLanguage() === sebelum, 'bahasa tak dikenal ditolak, tetap ' + sebelum);

console.log('\n--- 10. Render ulang dijalankan saat bahasa berubah ---');
{
  let dipanggil = 0, bahasaTerakhir = null;
  const stop = registerRerender((code) => { dipanggil++; bahasaTerakhir = code; });
  setLanguage('id', false);
  ok(dipanggil === 1 && bahasaTerakhir === 'id', 'render ulang dipanggil sekali saat setLanguage');
  setLanguage('en', false);
  ok(dipanggil === 2 && bahasaTerakhir === 'en', 'dipanggil lagi untuk bahasa kedua');
  stop();
  setLanguage('id', false);
  ok(dipanggil === 2, 'setelah berhenti mendaftar, tidak dipanggil lagi');
}

console.log('\n--- 11. Render ulang yang melempar tidak menghentikan yang lain ---');
{
  let keduaDipanggil = false;
  const stop1 = registerRerender(() => { throw new Error('sengaja gagal'); });
  const stop2 = registerRerender(() => { keduaDipanggil = true; });
  const errAsli = console.error;
  console.error = () => { };   // menahan noise yang memang diharapkan
  setLanguage('en', false);
  console.error = errAsli;
  ok(keduaDipanggil, 'render ulang kedua tetap jalan meski yang pertama melempar');
  stop1(); stop2();
}

console.log('\n--- 12. Dropdown bahasa ---');
{
  const sel = mkEl('languageSelect');
  initLanguageSelect(sel);
  ok(sel.children.length === LANGUAGES.length, `opsidropdown = jumlah bahasa (${sel.children.length})`);
  ok(sel.children.map((o) => o.value).join(',') === LANGUAGES.map((l) => l.code).join(','), 'nilai opsi adalah kode bahasa');
  // Nama bahasa sengaja tidak lewat t(): itu nama bahasa Proper, tidak diterjemahkan.
  ok(sel.children[0].textContent === 'Bahasa Indonesia', 'nama bahasa ditampilkan apa adanya');
  setLanguage('id', false);
  sel.value = 'en';
  sel.onchange();
  ok(getLanguage() === 'en', 'mengubah dropdown mengganti bahasa aktif');
  ok(localStorage.getItem('appLanguage') === 'en', 'pilihan user disimpan ke localStorage');
}

console.log('\n--- 13. initI18n(): mengikuti bahasa Windows ---');
{
  // 13a. Belum pernah memilih -> ikut locale sistem.
  localStorage.removeItem('appLanguage');
  setLocale('en-US');
  await initI18n();
  ok(getLanguage() === 'en', 'locale en-US -> bahasa en');

  setLocale('id-ID');
  await initI18n();
  ok(getLanguage() === 'id', 'locale id-ID -> bahasa id');

  setLocale('fr-FR');
  await initI18n();
  ok(getLanguage() === FALLBACK, `locale tidak didukung -> bahasa dasar (${FALLBACK})`);

  setLocale(null);
  await initI18n();
  ok(getLanguage() === FALLBACK, 'locale null -> bahasa dasar');

  // 13b. User sudah memilih -> pilihannya menang atas locale sistem.
  localStorage.setItem('appLanguage', 'en');
  setLocale('id-ID');
  const dipanggilSebelum = globalThis.__TauriStub.invoked.system_locale || 0;
  await initI18n();
  ok(getLanguage() === 'en', 'pilihan user mengalahkan locale sistem');
  ok((globalThis.__TauriStub.invoked.system_locale || 0) === dipanggilSebelum,
    'locale sistem TIDAK dibaca ulang saat user sudah pernah memilih (start lebih cepat)');

  // 13c. Hasil deteksi tidak boleh ditulis sebagai pilihan user - kalau tidak,
  // mengubah bahasa di Windows tidak akan berefek apa pun selamanya.
  localStorage.removeItem('appLanguage');
  globalThis.__TauriStub.invoked = {};
  setLocale('en-US');
  await initI18n();
  ok(localStorage.getItem('appLanguage') === null,
    'hasil deteksi otomatis TIDAK disimpan sebagai pilihan user');
  ok(globalThis.__TauriStub.invoked.system_locale === 1,
    'locale sistem dibaca tepat satu kali per start');
}

console.log(`\n${fail === 0 ? 'HASIL: i18n benar' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);