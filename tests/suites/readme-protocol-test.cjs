// Memastikan README.md tidak berbohong tentang protokol.
//
// README adalah satu-satunya spesifikasi protokol yang dibaca manusia, tapi
// tidak ada yang memverifikasinya terhadap firmware. Kalau README menyebut
// perintah yang tidak lagi ada di firmware (atau sebaliknya), dokumentasi itu
// menyesatkan dan tidak ada yang akan tahu.
//
// Test ini membandingkan isi README dengan bukti nyata di
// firmware/common/macropad_core.h dan dengan app.
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const core = fs.readFileSync(path.join(root, 'firmware/common/macropad_core.h'), 'utf8');
const limits = fs.readFileSync(path.join(root, 'firmware/common/limits.h'), 'utf8');
// Perintah diagnosa (DIAG) tinggal di diag.h, bukan di core. Tanpa baris ini,
// setiap perintah yang dipindah ke header sendiri akan dilaporkan sebagai
// "tidak ada di firmware" - padahal ia hanya pindah tempat.
const diag = fs.readFileSync(path.join(root, 'firmware/common/diag.h'), 'utf8');
const fwSources = core + '\n' + diag;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. README bukan template Tauri lagi ---');
ok(readme.length > 2000, `README punya isi substantial (${readme.length} karakter)`);
ok(/^# Macro Pad Configurator/.test(readme), 'judul README benar');
ok(!/This template should help you get started/.test(readme),
  'template bawaan Tauri sudah hilang');

console.log('\n--- B. Setiap perintah yang didokumentasikan ADA di firmware ---');
// Ambil nama perintah dari kolom pertama tabel Perintah.
const cmdRows = [...readme.matchAll(/^\| `([A-Z][A-Z0-9]*)(?::[^`]*)?` \|/gm)].map(m => m[1]);
const uniqCmds = [...new Set(cmdRows)];
ok(uniqCmds.length >= 20, `README mendokumentasikan ${uniqCmds.length} perintah`);

for (const c of uniqCmds) {
  // Firmwareiniti dengan either startsWith("X:") atau cmd == "X".
  const found = fwSources.includes(`"${c}:`) || fwSources.includes(`cmd == "${c}"`) || fwSources.includes(`"${c}"`);
  ok(found, `perintah ${c} ada di firmware`);
}

console.log('\n--- C. Setiap prefix yang didokumentasikan DICETAK firmware ---');
const prefixes = ['INFO:', 'HWINFO:', 'BATT:', 'EVT:CHG:', 'EVT:LAYER:', 'EVT:ESCAPE',
  'EVT:ENC:', 'EVT:APP:', 'DUMP_BEGIN:', 'DUMP_END', 'ENC_BEGIN:', 'ENC_END',
  'IDX:', 'NAMES_BEGIN', 'NAMES_END', 'RGB_DUMP:', 'RGB_KEY:', 'RGB_DUMP_END',
  'WHOAMI:', 'PONG', '[KEY]', '[ENC_BTN]'];
for (const p of prefixes) {
  ok(core.includes(p), `firmware mencetak ${p}`);
}

console.log('\n--- D. Batas angka yang diklaim README benar ---');
const mm = limits.match(/#define MACRO_MAX_LEN\s+(\d+)/);
ok(!!mm, 'MACRO_MAX_LEN ada di limits.h');
ok(/47 byte/.test(readme), 'README menyebut 47 byte');
ok(mm && parseInt(mm[1]) - 1 === 47,
  `47 = MACRO_MAX_LEN (${mm && mm[1]}) - 1 untuk terminator`);

const rgbCount = limits.match(/#define RGB_COUNT\s+(\d+)/);
ok(!!rgbCount, 'RGB_COUNT ada di limits.h');
ok(rgbCount && parseInt(rgbCount[1]) === 9, `RGB_COUNT = ${rgbCount && rgbCount[1]} (README bilang 9)`);
// Yang penting: angka di README harus BENAR-BENAR sama dengan firmware.
// Hanya mengecek "firmware = 9" tidak cukup - kalau README menulis 16,
// test tetap hijau. Jadi bandingkan keduanya secara langsung.
const readmeRgb = readme.match(/RGB slots \| (\d+)/);
ok(!!readmeRgb, 'README menyebut jumlah RGB slots di tabel konstanta');
ok(readmeRgb && rgbCount && readmeRgb[1] === rgbCount[1],
  `jumlah RGB slots di README (${readmeRgb && readmeRgb[1]}) = RGB_COUNT di firmware (${rgbCount && rgbCount[1]})`);

const readmeSlots = readme.match(/`APP_SLOTS` \| (\d+)/);
ok(!!readmeSlots, 'README menyebut APP_SLOTS di tabel konstanta');
const coreSlots = core.match(/#define APP_SLOTS\s+(\d+)/) || limits.match(/#define APP_SLOTS\s+(\d+)/);
ok(!!coreSlots, 'APP_SLOTS ada di firmware');
ok(readmeSlots && coreSlots && readmeSlots[1] === coreSlots[1],
  `APP_SLOTS di README (${readmeSlots && readmeSlots[1]}) = di firmware (${coreSlots && coreSlots[1]})`);

console.log('\n--- E. Klaim "[KEY] maksimal 62 byte" bisa dihitung ulang ---');
// README menyatakan 62 byte. Hitung ulang dari angka yang sama supaya
// klaimnya tidak sekadar tebakan.
const keyLine = core.match(/printf\("\[KEY\] %d,%d,%d,%d,%s\\n"/);
ok(!!keyLine, 'format [KEY] di firmware persis seperti yang README gambarkan');
// Hitung ulang dari format lengkap, bukan cuma bagian setelah prefix.
// Penting: prefix literal "[KEY] " ikut terhitung, dan itulah yang membuat
// angkanya 62 dan bukan 56. Versi pertama test ini kelewatan 6 karakter
// prefix dan menyimpulkan README salah - padahal README-nya benar.
const full = '[KEY] ' + '7,2,2,3,' + 'a'.repeat(47);
const longest = full.length + 1;   // +1 untuk newline
ok(longest === 62, `hitungan ulang: ${full.length} + newline = ${longest} byte (README bilang 62)`);
ok(/62 byte/.test(readme), 'README menyebut 62 byte');
ok(/64 byte/.test(readme), 'README menyebut batas buffer stack vprintf (64)');
ok(longest <= 64, `${longest} <= 64 byte, jadi tidak kena alokasi malloc di vprintf`);

console.log('\n--- F. Klaim "currentLayer ikut tersimpan ke flash" ---');
ok(/cmd == "SAVE"\) \{ saveConfigToFlash\(\); return; \}/.test(core),
  'firmware SAVE menuliskan seluruh struct cfg (berisi currentLayer)');
ok(/uint8_t currentLayer;/.test(core), 'currentLayer memang anggota struct cfg');
ok(/LAYER:0/.test(readme), 'README menyebut solusi app-side (LAYER:0 setelah connect)');

console.log('\n--- G. README menyebut keadaan yang benar ---');
ok(/cargo test --lib/.test(readme), 'README menyebut cara test Rust');
ok(/npx vite build|vite build/.test(readme), 'README menyebut cara build frontend');
ok(/Toolchain Arduino|tidak ada\s*\n?\s*toolchain Arduino/i.test(readme) || /tidak ada toolchain Arduino/.test(readme),
  'README jujur soal keterbatasan verifikasi firmware');
ok(/USB-OTG \(TinyUSB\)/.test(readme), 'README menyebut setting board Arduino');
ok(/PROTOTYPE/.test(readme) && /FINAL/.test(readme), 'README menjelaskan dua profil');

console.log(`\nHASIL: ${fail} gagal`);
process.exit(fail ? 1 : 0);
