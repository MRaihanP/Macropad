// Memeriksa Phase 9a (aksesibilitas) pada sumber yang benar-benar di-build.
//
// Ini bukan audit lengkap WCAG - tidak ada browser headless di lingkungan ini.
// Yang diperiksa adalah hal-hal yang bisa diverifikasi statis dan yang kalau
// hilang akan langsung memblokir pengguna keyboard / screen reader:
//
//  1. Elemen interaktif benar-benar bisa difokus (tabindex / elemen native).
//  2. Ada role/label yang masuk akal untuk yang tidak bisa dibaca sebagai teks.
//  3. Perubahan status diumumkan (live region).
//  4. Ada focus ring yang terlihat.
//
// Jalankan: node a11y-test.js
const fs = require('fs');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

const html = fs.readFileSync('src/index.html', 'utf8');
const css = fs.readFileSync('src/styles.css', 'utf8');
const read = (p) => fs.readFileSync(p, 'utf8');

console.log('--- 1. Navigasi sidebar bisa diakses keyboard ---');
const navMatches = [...html.matchAll(/<(div|button)[^>]*class="nav-item[^"]*"[^>]*>/g)];
ok(navMatches.length === 4, `ada 4 item navigasi (ditemukan ${navMatches.length})`);
ok(navMatches.every((m) => m[1] === 'button'),
  'semua nav-item adalah <button> - hanya <button> yang masuk tab order dan bisa Enter/Space');
ok(navMatches.every((m) => m[0].includes('type="button"')),
  'nav-item punya type="button" (default <button> di dalam form = submit)');
ok(/aria-current/.test(read('src/ui-router.js')), 'ui-router.js mengelola aria-current');
ok(read('src/ui-router.js').includes("setAttribute('aria-current', 'page')"),
  'aria-current="page" dipasang pada item yang aktif');
ok(read('src/ui-router.js').includes("removeAttribute('aria-current')"),
  'aria-current dilepas dari item yang tidak aktif');

console.log('\n--- 2. Panah kiri/kanan memindah fokus di sidebar ---');
const router = read('src/ui-router.js');
ok(/onkeydown = \(e\) => \{/.test(router), 'router memasang penangan keydown');
ok(/ArrowRight/.test(router) && /ArrowLeft/.test(router), 'mendukung ArrowRight dan ArrowLeft');
ok(/ArrowDown/.test(router) && /ArrowUp/.test(router), 'mendukung ArrowUp dan ArrowDown');
ok(/e\.preventDefault\(\);/.test(router), 'preventDefault supaya halaman tidak ikut ter-scroll');
ok(/\.focus\(\)/.test(router), 'fokus benar-benar dipindahkan ke item berikutnya');

console.log('\n--- 3. Modal adalah dialog yang benar ---');
ok(/<div class="modal-box"[^>]*role="dialog"/.test(html), 'modal-box punya role="dialog"');
ok(/aria-modal="true"/.test(html), 'modal-box punya aria-modal="true"');
ok(/aria-labelledby="modalTitle"/.test(html), 'modal dikaitkan ke judulnya (aria-labelledby)');
const modal = read('src/ui-modal.js');
ok(/const FOCUSABLE = /.test(modal), 'ada daftar selektor elemen yang bisa difokus');
ok(/if \(e\.key === 'Tab'\)/.test(modal), 'Tab diintervensi (focus trap)');
ok(/e\.shiftKey && document\.activeElement === first/.test(modal), 'Shift+Tab dari elemen pertama memutar ke terakhir');
ok(/document\.activeElement === last/.test(modal), 'Tab dari elemen terakhir memutar ke pertama');
ok(/previouslyFocused/.test(modal), 'fokus sebelumnya disimpan');
ok(/previouslyFocused\.focus\(\)/.test(modal), 'fokus dikembalikan ke pemicu saat dialog ditutup');
ok(/removeEventListener\('keydown', onKey, true\)/.test(modal),
  'listener keydown dilepas saat dialog ditutup (tidak menumpuk)');

console.log('\n--- 4. Perubahan status diumumkan ke screen reader ---');
ok(/id="statusText"[^>]*role="status"/.test(html) || /role="status"[^>]*id="statusText"/.test(html),
  'status koneksi memakai role="status" (live region)');
ok(/id="log"[^>]*role="log"[^>]*aria-live="polite"/.test(html), 'panel log memakai role="log" + aria-live="polite"');
// aria-label datang dari tabel terjemahan (data-i18n-attr) sejak Phase 9b;
// nilainya dijamin oleh i18n-test.js, sedangkan a11y-test memastikan KENDAI-nya
// ada, bukan nilai satu bahasa tertentu.
ok(/data-i18n-attr="aria-label:home\.logLabel"/.test(html), 'panel log punya nama yang bisa dibaca');

console.log('\n--- 5. Elemen non-teks punya label ---');
ok(/id="battInd"[^>]*role="img"/.test(html), 'indikator baterai role="img" (SVG tidak terbaca screen reader)');
const battery = read('src/battery-ui.js');
ok(/setAttribute\('aria-label'/.test(battery), 'battery-ui.js mengisi aria-label dari angka nyata');
ok(/speak\(t\('batt\.noData'\)\)/.test(battery),
  'keadaan "belum ada data" juga diberi label lewat kunci i18n, bukan dibiarkan kosong');
ok(/data-i18n-attr="aria-label:header\.refreshPorts\|title:header\.refreshPorts"/.test(html),
  'tombol ikon ↻ punya aria-label lewat tabel terjemahan (tanpa itu hanya terbaca "tombol")');
const svgNoLabel = [...html.matchAll(/<svg(?![^>]*aria-hidden)[^>]*>/g)];
ok(svgNoLabel.length === 0, `semua SVG dekoratif diberi aria-hidden="true" (${svgNoLabel.length} yang terlewat)`);

console.log('\n--- 5b. Kontrol RGB punya nama yang bisa dibaca (Phase 9.4) ---');
// Dua slider RGB punya <span> di sebelahnya - terlihat, tapi TIDAK memberi
// accessible name. Screen reader hanya announcing "slider" tanpa nama.
// Dua color picker bahkan tidak punya teks sama sekali di dekatnya.
for (const [id, key] of [['rgbBri', 'rgb.brightness'], ['rgbSpeed', 'rgb.speed']]) {
  ok(new RegExp('<label for="' + id + '"[^>]*data-i18n="' + key.replace('.', '\\.') + '"').test(html),
    `slider #${id} punya <label for> yang punya teks, bukan hanya span di sebelahnya`);
  ok(new RegExp('id="' + id + '"').test(html), `#${id} masih ada`);
}
ok(/id="rgbColorPicker"[^>]*aria-labelledby="rgbKeyTitle"/.test(html),
  'color picker per key dikaitkan ke judul panel yang dinamis (rgbKeyTitle)');
ok(/id="rgbModeColor"[^>]*data-i18n-attr="aria-label:rgb\.modeColorLabel"/.test(html),
  'color picker mode lighting punya aria-label lewat kunci i18n');
// nilai slider harus terbaca sebagai persen, bukan angka mentah 0-255
ok(/id="rgbBriVal"[^>]*aria-hidden="true"/.test(html),
  'angka persen di layar disembunyikan dari a11y tree (sudah ada di aria-valuetext)');
const rgb = read('src/rgb-page.js');
ok(/function setSliderReadout/.test(rgb), 'ada helper setSliderReadout');
ok(/setAttribute\('aria-valuetext'/.test(rgb),
  'setSliderReadout mengisi aria-valuetext (bukan cuma teks di layar)');
// Semua penulisan nilai harus lewat helper, supaya tidak ada yang bisa
// memperbarui angka di layar tanpa memperbarui yang dibacakan.
const directWrites = [...rgb.matchAll(/el\('rgb(?:Bri|Speed)Val'\)\.textContent/g)].length;
ok(directWrites === 0,
  `tidak ada penulisan .textContent langsung ke readout RGB (temu ${directWrites}) - semua lewat helper`);
const helperCalls = (rgb.match(/setSliderReadout\(/g) || []).length;
ok(helperCalls >= 4, `setSliderReadout dipakai di render + kedua handler oninput (temu ${helperCalls} calls)`);
// CSS harus tetap menyasar label, kalau tidak label kehilangan lebar tetap
const rgbCss = read('src/styles.css');
ok(/\.rgb-slider-row > label:first-child/.test(rgbCss),
  'CSS menyasar <label> di .rgb-slider-row (lebar label tetap 78px)');

console.log('\n--- 5c. Status simpan RGB diumumkan (Phase 9.3) ---');
// #rgbSaveState menampilkan "belum disimpan" setiap kali RGB diubah. Tanpa
// live region, teks itu hanya terlihat - screen reader tidak mengumumkannya
// karena teks statis tidak masuk pengumuman otomatis. User buta bisa menutup
// app tanpa pernah tahu perubahan RGB-nya belum tersimpan ke device.
ok(/id="rgbSaveState"[^>]*role="status"/.test(html), '#rgbSaveState punya role="status"');
ok(/id="rgbSaveState"[^>]*aria-live="polite"/.test(html), '#rgbSaveState punya aria-live="polite"');
ok(!/id="rgbSaveState"[^>]*aria-live="assertive"/.test(html),
  'tidak assertive - tidak boleh memotong pembacaan lain');

// ---------- 6. Sel grid, baris knob, dan tab layer bisa diakses keyboard ----------
console.log('\n--- 6. Sel grid, baris knob, dan tab layer bisa diakses keyboard ---');
const home = read('src/home-page.js');
ok(/function makeInteractive/.test(home), 'ada helper makeInteractive');
ok(/node\.tabIndex = 0;/.test(home), 'tabIndex = 0 dipasang');
ok(/setAttribute\('role', 'button'\)/.test(home), 'role="button" dipasang');
ok(/if \(e\.key !== 'Enter' && e\.key !== ' '\) return;/.test(home), 'Enter dan Space memicu');
ok(/e\.preventDefault\(\);/.test(home), 'Space tidak menggulir halaman');
// Dipakai di ketiganya.
ok((home.match(/makeInteractive\(/g) || []).length >= 3,
  `makeInteractive dipakai di >=3 tempat (sekarang ${(home.match(/makeInteractive\(/g) || []).length})`);
ok(/makeInteractive\(cell, \(\) => openEditor\('key'/.test(home), 'sel grid bisa diaktifkan keyboard');
ok(/makeInteractive\(row, \(\) => openEditor\('enc'/.test(home), 'baris binding knob bisa diaktifkan keyboard');
ok(/tab\.setAttribute\('role', 'tab'\)/.test(home), 'tab layer memakai role="tab"');
ok(/tab\.setAttribute\('aria-selected'/.test(home), 'tab layer menandai yang terpilih');
ok(/ArrowLeft/.test(home) && /ArrowRight/.test(home), 'tab layer bisa diganti dengan panah kiri/kanan');

// ---------- 7. Fokus keyboard terlihat ----------
console.log('\n--- 7. Fokus keyboard terlihat ---');
ok(/focus-visible/.test(css), 'ada aturan :focus-visible');
const ring = [...css.matchAll(/:where\([^)]*\):focus-visible\s*\{([^}]*)\}/g)];
ok(ring.length > 0, 'focus ring berlaku untuk button, [role=button], [role=tab], input, select, textarea');
ok(ring.some((m) => /outline:\s*2px/.test(m[1])), 'focus ring memakai outline 2px (terlihat jelas)');

// ---------- 8. Tidak ada regresi: styling nav-item dinetralkan ----------
console.log('\n--- 8. Tidak ada regresi: styling nav-item dinetralkan ---');
// nav-item jadi <button> (section 1). <button> punya background, border, dan
// font bawaan browser; kalau .nav-item tidak menimpanya, sidebar berubah
// tampilan penuh hanya karena elemennya diganti dari <div> jadi <button>.
// Assertion ini menjaga perubahan a11y itu tidak merusak tampilan.
// PENTING: hanya aturan DASAR .nav-item yang diperiksa, bukan .nav-item:hover
// atau .nav-item.active. Versi pertama dari assertion ini memakai
// /\.nav-item[^{]*\{...\}/g yang ikut mencocokkan :hover, sehingga background
// di :hover membuat test tetap hijau walau `background: none` di aturan dasar
// sudah dihapus. Negative test (negative-a11y-s8.mjs) membuktikan cacat itu.
const navItemDasar = (css.match(/(^|[},;\s])\.nav-item\s*\{([^}]*)\}/g) || [])
  .map((m) => m.replace(/^[^{]*\{/, '').replace(/\}$/, '')).join('\n');
ok(navItemDasar.trim().length > 0, 'ada aturan dasar .nav-item (bukan hanya :hover/:active)');
ok(/background\s*:\s*none/.test(navItemDasar),
  '.nav-item menetralkan background bawaan <button> (background: none)');
ok(/border\s*:\s*0\s*;/.test(navItemDasar),
  '.nav-item menetralkan border bawaan <button> (border: 0)');
ok(/font-family\s*:\s*inherit/.test(navItemDasar),
  '.nav-item memakai font yang sama dengan teks lain (font-family: inherit)');
ok(/text-align\s*:\s*left/.test(navItemDasar),
  '.nav-item tetap rata kiri seperti versi <div> (text-align: left)');

// EXIT CODE. Bagian ini hilang saat file pernah rusak, dan itu membuat test
// hijau palsu: assertion bisa mencetak "FAIL" tapi process tetap exit 0,
// sehingga Negative test ikut salah menilai diri sendiri hijau.
// Jangan dihapus tanpa menggantinya Negative test.
console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
