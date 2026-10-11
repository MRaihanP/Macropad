// Menguji jalan keluar dari mode rekam keyboard (Phase 9.6).
//
// Bug yang ditutup: captureKeyDuringRecording() memanggil preventDefault() pada
// SEMUA keydown saat recording aktif. Akibatnya F5, Ctrl+R, Ctrl+W, Ctrl+T
// tertahan, dan satu-satunya cara keluar adalah klik tombol Cancel - yang
// mustahil dijangkau karena keyboard sedang direkam. User terkunci.
//
// Yang diuji di sini murni secara statis + simulasi logika, karena
// home-page.js butuh DOM dan serial. Yang diperiksa adalah bentuk kode yang
// salah bisa lolos tanpa terlihat.
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const home = fs.readFileSync(path.join(root, 'src/home-page.js'), 'utf8');
const modal = fs.readFileSync(path.join(root, 'src/ui-modal.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const idLocale = fs.readFileSync(path.join(root, 'src/locales/id.js'), 'utf8');
const enLocale = fs.readFileSync(path.join(root, 'src/locales/en.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Escape jadi jalan keluar ---');
const capture = home.match(/function captureKeyDuringRecording\(e\) \{([\s\S]*?)\n\}/);
ok(!!capture, 'captureKeyDuringRecording() ditemukan');
const body = capture ? capture[1] : '';
ok(/e\.key === 'Escape'/.test(body), "pengecekan e.key === 'Escape' ada di dalam handler");
ok(/cancelEditor\(\)/.test(body), 'Escape memanggil cancelEditor()');
ok(/e\.preventDefault\(\)/.test(body), 'Escape memanggil preventDefault() (tak lolos ke browser)');
// PENTING: pengecekan Escape harus SEBELUM preventDefault umum, kalau tidak
// Escape ikut preventDefault lalu jatuh ke branch "tombol biasa" dan jadi token.
const escIdx = body.indexOf("e.key === 'Escape'");
const generalPrevent = body.indexOf('e.preventDefault();\n  if (e.repeat)');
ok(escIdx >= 0 && escIdx < body.length, 'Escape ditangani sebelum branch tombol biasa');

console.log('--- B. cancelEditor() Defined & exported ---');
ok(/export function cancelEditor\(\)/.test(home), 'cancelEditor() di-export');
const ce = home.match(/export function cancelEditor\(\) \{([\s\S]*?)\n\}/);
ok(!!ce, 'badan cancelEditor() terbaca');
if (ce) {
  ok(/stopRecordingContinuous\(\)/.test(ce[1]), 'cancelEditor() memanggil stopRecordingContinuous()');
  ok(/editPanel/.test(ce[1]), "cancelEditor() menyembunyikan #editPanel");
  ok(/clearSelection\(\)/.test(ce[1]), 'cancelEditor() memanggil clearSelection()');
}

console.log('--- C. Listener perekaman selalu dilepas ---');
ok(/stopRecordingContinuous\(\) \{\s*\n\s*recording = false;\s*\n\s*window\.removeEventListener\('keydown', captureKeyDuringRecording\)/.test(home),
  'stopRecordingContinuous()BENAR-benar melepas listener keydown');
ok(/window\.addEventListener\('keydown', captureKeyDuringRecording\)/.test(home),
  'listener ditambahkan di startRecordingContinuous()');
// Kalau addEventListener dipanggil tanpa remove yang cocok, setiap buka editor
// menambah listener baru dan satu Escape memicu cancelEditor() berkali-kali.
const adds = (home.match(/addEventListener\('keydown', captureKeyDuringRecording\)/g) || []).length;
const removes = (home.match(/removeEventListener\('keydown', captureKeyDuringRecording\)/g) || []).length;
ok(adds === removes, `jumlah add (${adds}) == jumlah remove (${removes}) - tidak ada listener yang menumpuk`);

console.log('--- D. Modal tidak bertabrakan dengan Escape ---');
// ui-modal memasang listener di fase CAPTURE pada document, home-page di
// window fase BUBBLE. Capture jalan lebih dulu. Kalau ui-modal tidak
// preventDefault(), home-page tidak tahu event sudah ditangani -> satu Escape
// menutup modal DAN membatalkan editor.
ok(/document\.addEventListener\('keydown', onKey, true\)/.test(modal),
  'ui-modal memasang listener di fase capture (true)');
const modalKey = modal.match(/function onKey\(e\) \{([\s\S]*?)\n      \}/);
ok(!!modalKey, 'onKey() di ui-modal terbaca');
if (modalKey) {
  ok(/e\.key === 'Escape'\)\s*\{\s*e\.preventDefault\(\)/.test(modalKey[1]),
    "ui-modal memanggil preventDefault() saat Escape - jadi sinyal bagi listener lain");
}
ok(/e\.defaultPrevented/.test(body),
  'home-page memeriksa e.defaultPrevented supaya tidak menutup editor bersamaan');

console.log('--- E. Petunjuk di UI menyebut Escape ---');
ok(/Escape = batal/.test(idLocale), 'petunjuk Bahasa Indonesia menyebut Escape');
ok(/Escape = cancel/.test(enLocale), 'petunjuk Bahasa Inggris menyebut Escape');
// Petunjuk hanya berguna kalau benar-benar tampil.
ok(/data-i18n="editor\.recordHint"/.test(fs.readFileSync(path.join(root, 'src/index.html'), 'utf8')),
  'petunjuk dirender dari index.html (bukan teks mati di JS)');

console.log('--- F. main.js memakai cancelEditor() ---');
ok(/el\('btnCancel'\)\.onclick = cancelEditor;/.test(main),
  'tombol Cancel memakai cancelEditor() yang sama');
ok(/cancelEditor/.test(main.match(/import \{[\s\S]*?\} from "\.\/home-page\.js";/)[0]),
  'cancelEditor di-import oleh main.js');
ok(!/stopRecordingContinuous\(\); el\('editPanel'\)\.style\.display = 'none'/.test(main),
  'tidak ada lagipenyalinan logika batal di main.js (tidak bisa melenceng)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
