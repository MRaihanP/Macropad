// Menguji role=status pada indikator status simpan RGB (plan Phase 9.3).
//
// Gap yang ditutup: #rgbSaveState berisi teks "belum disimpan" yang berubah
// setiap kali user mengubah RGB. Screen reader hanya membacakan teks yang
// masuk accessibility tree, dan teks statis tidak diumumkan otomatis - jadi
// user buta tidak akan pernah tahu perubahan RGB-nya belum tersimpan ke
// device, dan bisa menekan "Simpan" atau bahkan menutup app tanpa sadar.
const fs = require('fs');

const path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const a11y = fs.readFileSync(path.join(__dirname, 'a11y-test.cjs'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. #rgbSaveState adalah live region ---');
ok(/id="rgbSaveState"[^>]*role="status"/.test(html),
  '#rgbSaveState punya role="status" (live region)');
ok(/id="rgbSaveState"[^>]*aria-live="polite"/.test(html),
  '#rgbSaveState punya aria-live="polite" (tidak memotong pembacaan lain)');

console.log('\n--- B. Live region ada SEBELUM teks berubah ---');
// Ini yang sering terlewat. Kalau live region baru dibuat atau baru diisi
// pada saat teks muncul, screen reader tidak punya kesempatan membandingkan
// "sebelum" vs "sesudah" dan tidak membacakan apa pun.
const rgb = fs.readFileSync('src/rgb-page.js', 'utf8');
ok(/el\('rgbSaveState'\)\.textContent/.test(rgb),
  'rgb-page.js menulis ke #rgbSaveState');
ok(!/createElement\([^)]*\)[\s\S]{0,200}rgbSaveState/.test(rgb),
  'tidak membuat elemen baru untuk live region (harus elemen yang sudah ada di HTML)');
ok(!/rgbSaveState[\s\S]{0,120}innerHTML\s*=/.test(rgb),
  'penulisan tidak lewat innerHTML (aman, dan tetap memicu live region)');

console.log('\n--- C. Teks yang diumumkan selalu berisi informasi ---');
ok(/el\('rgbSaveState'\)\.textContent = rgb\.dirty \? t\('rgb\.unsaved'\) : '';/.test(rgb),
  "status dirty memakai t('rgb.unsaved'), bukan string kosong sebagai placeholder");
ok(!/el\('rgbSaveState'\)\.textContent = '';/.test(rgb),
  'tidak pernah menulis string kosong tanpa kondisi yang bermakna');

console.log('\n--- D. Konsisten dengan pola live region lain di app ---');
ok(/id="statusText"[^>]*role="status"/.test(html),
  '#statusText juga role="status" (konsisten)');
ok(/id="log"[^>]*aria-live="polite"/.test(html),
  '#log juga live region (konsisten)');

console.log('\n--- E. a11y-test.js ikut menjaganya ---');
ok(/rgbSaveState/.test(a11y),
  'a11y-test.js punya pemeriksaan untuk #rgbSaveState (tidak hanya di test terpisah)');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
