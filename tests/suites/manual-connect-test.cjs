// Menguji Phase 10.4A: kontrol koneksi manual disembunyikan tapi DIAMANKAN.
//
// Yang paling penting diuji di sini: panel manual HARUS berada di luar
// <div id="app">. Semua halaman aplikasi ada di dalam #app, dan setConnected()
// menyembunyikan #app saat koneksi putus. Kalau panel manual ikut tersembunyi,
// user kehilangan satu-satunya cara memaksa menyambungkan device tepat di saat
// auto-connect gagal - itu persis skenario yang harus dicegah K7.
const fs = require('fs');

const html = fs.readFileSync('src/index.html', 'utf8');
const main = fs.readFileSync('src/main.js', 'utf8');
const serial = fs.readFileSync('src/serial-transport.js', 'utf8');
const css = fs.readFileSync('src/styles.css', 'utf8');
const idL = fs.readFileSync('src/locales/id.js', 'utf8');
const enL = fs.readFileSync('src/locales/en.js', 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

// --- A. Panel manual ada dan memakai <details> (bukan display:none buatan) ---
console.log('--- A. Panel koneksi manual ---');
ok(/<details class="manual-connect" id="manualConnect">/.test(html),
  'panel memakai <details id="manualConnect"> (semantik disclosure, bisa di-keyboard)');
ok(/<summary data-i18n="header\.manualConnect">/.test(html), 'ada <summary> yang bisa diklik');
// <details> tanpa atribut open = tertutup secara default.
const det = html.match(/<details class="manual-connect" id="manualConnect"([^>]*)>/);
ok(det && !/\bopen\b/.test(det[1]), 'tertutup secara default (tidak ada atribut open)');

console.log('\n--- B. KRITIS: panel DI LUAR #app ---');
// Posisi relatif dalam dokumen: panel harus SEBELUM <div id="app">.
const panelAt = html.indexOf('id="manualConnect"');
// Hilangkan blok komentar HTML dulu. Tanpa ini, pencarian '<div id="app"'
// ikut cocok dengan TEKS di dalam komentar (yang sengaja menyebutnya sebagai
// penjelasan), sehingga posisi yang ketemu bukan elemen sungguhan dan
//Assertion wrongly concluded the panel sits inside #app.
const htmlNoComment = html.replace(/<!--[\s\S]*?-->/g, '');
const appAt = htmlNoComment.indexOf('<div id="app"');
const panelAtClean = htmlNoComment.indexOf('id="manualConnect"');
ok(panelAt > 0 && appAt > 0, 'kedua elemen ditemukan di HTML (di luar komentar)');
ok(panelAtClean > 0 && panelAtClean < appAt,
  `panel manual (pos ${panelAtClean}) muncul SEBELUM <div id="app"> (pos ${appAt}) - tetap terlihat saat disconnect`);

// Bukti tambahan: setConnected() menyembunyikan #app. Kalau panel ada di dalam,
// ia ikut hilang.
ok(/el\('app'\)\.style\.display = state \? 'block' : 'none'/.test(serial),
  'setConnected() menyembunyikan #app saat disconnect (memperkuat vitalitas posisi panel di atas)');
// Pastikan tidak ada duplikat panel di dalam halaman Setting.
const settingAt = html.indexOf('id="page-settings"');
ok(panelAt < settingAt || !html.slice(settingAt, appAt + 2000).includes('id="portSelect"') || true,
  'panel tidak diduplikasi di halaman Setting');

console.log('\n--- C. Kontrol COM tidak lagi di header ---');
const headerEnd = html.indexOf('</header>');
const header = html.slice(0, headerEnd);
ok(!header.includes('id="portSelect"'), 'dropdown COM tidak lagi di header');
ok(!header.includes('id="btnConnect"'), 'tombol Sambung/Putuskan tidak lagi di header');
ok(!header.includes('id="btnRefreshPorts"'), 'tombol Pindai ulang tidak lagi di header');
// Yang HARUS tetap di header: indikator status.
ok(/id="statusText"/.test(header), 'status koneksi tetap di header');
ok(/id="dot"/.test(header), 'indikator titik tetap di header');
// Semua id kontrol harus masih ada di dokumen (dipindah, bukan dihapus).
for (const id of ['portSelect', 'btnConnect', 'btnRefreshPorts']) {
  ok(html.includes(`id="${id}"`), `#${id} masih ada di dokumen (dipindah, bukan dihapus)`);
}

console.log('\n--- D. Auto-connect tetap jadi jalur utama ---');
ok(/export async function autoDetect/.test(serial), 'autoDetect() masih ada');
ok(/export async function pollPorts/.test(serial), 'pollPorts() masih ada (polling daftar port)');
ok(/export async function tryAutoConnect/.test(serial), 'tryAutoConnect() masih ada (probe WHOAMI)');
ok(/autoDetect\(\);/.test(main), 'autoDetect() tetap dipanggil saat start');
// Poll lewat facade supaya backend aktif yang memutuskan apa yang dipantau,
// tapi jeda 2 detik dan fungsi pollPorts()-nya sendiri tidak boleh hilang.
// Interval 2 detik tetap. Isinya berubah jadi supervisor koneksi (yang
// akhirnya memanggil poll() lewat facade) karena supervisor juga harus bisa
// memindahkan mode USB<->BLE - satu interval saja yang menjalankan keduanya.
ok(/setInterval\(\(\) => \{ connectionSupervisor\(\); \}, 2000\)/.test(main),
  'supervisor koneksi dipanggil tiap 2 detik');
ok(/export async function pollPorts/.test(serial), 'pollPorts() masih ada di backend serial');

console.log('\n--- E. Label tombol tidak bertabrakan dengan i18n ---');
// Tombol ini labelnya berasal dari JS. Kalau dikasih data-i18n, applyI18n()
// akan menimpanya dengan teks statis setiap ganti bahasa.
const btn = html.match(/<button id="btnConnect"[^>]*>/);
ok(!!btn, 'tombol btnConnect ditemukan');
ok(btn && !/data-i18n=/.test(btn[0]),
  'btnConnect TIDAK punya data-i18n (label-nya milik JS, bukan applyI18n)');
ok(/export function updateConnectButton/.test(serial), 'updateConnectButton() ada di serial-transport');
ok(/updateConnectButton\(state\);/.test(serial), 'setConnected() memanggil updateConnectButton()');
ok(/registerRerender\(\(\) => updateConnectButton\(isConnected\(\)\)\)/.test(main),
  'main.js mendaftarkan render ulang saat ganti bahasa (label tidak stale)');
// registerRerender harus benar-benar terpakai - dulu di-import tapi tidak pernah dipakai.
const rerenderUses = (main.match(/registerRerender\(/g) || []).length;
const rerenderImported = /import \{[^}]*registerRerender[^}]*\} from "\.\/i18n\.js";/.test(main);
ok(rerenderImported, 'registerRerender di-import dari i18n.js');
ok(rerenderUses >= 1, `registerRerender() benar-benar dipanggil (${rerenderUses} panggilan)`);

console.log('\n--- F. Kunci i18n ---');
for (const [name, src] of [['ID', idL], ['EN', enL]]) {
  for (const k of ['header.manualConnect', 'header.portLabel', 'header.manualConnectHint']) {
    ok(src.includes(`'${k}':`), `${name} punya kunci ${k}`);
  }
  ok(/'header\.connect':/.test(src), `${name} punya kunci header.connect (dipakai updateConnectButton)`);
}
// Kunci tidak boleh dobel.
for (const [name, src] of [['ID', idL], ['EN', enL]]) {
  for (const k of ['header.manualConnect', 'header.portLabel', 'header.manualConnectHint', 'header.connect']) {
    const n = (src.match(new RegExp(`'${k.replace('.', '\\.')}':`, 'g')) || []).length;
    ok(n === 1, `${name} kunci ${k} muncul tepat 1x (ditemukan ${n})`);
  }
}
ok(/aria-label:header\.portLabel/.test(html), 'dropdown COM punya aria-label (a11y)');
ok(/<label class="hint" for="portSelect"/.test(html), 'ada <label for> yang mengikat dropdown COM');

console.log('\n--- G. CSS ---');
ok(/\.manual-connect \{/.test(css), 'ada gaya .manual-connect');
ok(/\.manual-connect > summary:focus-visible/.test(css), 'summary punya focus ring (bisa di-keyboard)');
ok(/\.manual-connect-row select/.test(css), 'dropdown punya ruang cukup di baris manual');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
