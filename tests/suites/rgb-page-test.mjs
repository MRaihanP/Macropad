// Memeriksa modul src/rgb-page.js:
//  1. tidak lagi menduplikasi helper DOM yang sudah ada di dom.js
//  2. main.js tidak lagi menyimpan definisi RGB (tidak ada duplikasi / drift)
//  3. parsing RGB_DUMP / RGB_KEY benar dan menolak indeks rusak
// Jalankan: node rgb-page-test.mjs

import fs from 'node:fs';
import { SRC, SRC_URL } from '../runner/paths.mjs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const logs = [];
const log = (m) => logs.push(m);

const mkEl = () => ({
  value: '', textContent: '', innerHTML: '', checked: false, title: '', disabled: false,
  style: {}, dataset: {},
  className: '',
  classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
  appendChild() { }, querySelector() { return mkEl(); }, querySelectorAll() { return []; },
  addEventListener() { }, setAttribute() { }, remove() { },
});
globalThis.document = { getElementById: () => mkEl(), createElement: () => mkEl() };
const { rgb, handleRgbLine, rgbKeyName, ledIndex, hexToRgb, RGB_MODES, parseRgbTriple } =
  await import(`${SRC_URL}/rgb-page.js`);

console.log('--- 1. rgb-page.js tidak menduplikasi helper DOM ---');

const rgbSrc = fs.readFileSync(`${SRC}/rgb-page.js`, 'utf8');
const domSrc = fs.readFileSync(`${SRC}/dom.js`, 'utf8');
ok(/import\s*\{\s*el\s*\}\s*from\s*'\.\/dom\.js'/.test(rgbSrc), 'rgb-page meng-import el dari dom.js');
ok(!/^(const|function|export function)\s+el\s*[=(]/.test(rgbSrc), 'rgb-page tidak mendefinisikan el sendiri');
ok(!/^function\s+escapeHtml/.test(rgbSrc), 'rgb-page tidak mendefinisikan escapeHtml sendiri');
ok(/export function escapeHtml/.test(domSrc), 'escapeHtml ada di dom.js');

console.log('\n--- 2. main.js tidak lagi menyimpan definisi RGB ---');
const mainSrc = fs.readFileSync(`${SRC}/main.js`, 'utf8');
// handleLine (dan pemanggilan handleRgbLine di dalamnya) pindah ke
// src/protocol-parser.js pada Phase 8 tahap 5, jadi diperiksa di sana.
const parserSrc = fs.readFileSync(`${SRC}/protocol-parser.js`, 'utf8');
for (const sym of ['RGB_MODES', 'RGB_KF', 'RGB_LED_INDEX', 'briToPct', 'pctToBri', 'ensureRgbKeys', 'stopRgbAnims']) {
  const stillThere = new RegExp(`^(const|let|function)\\s+${sym}\\b`, 'm').test(mainSrc);
  ok(!stillThere, `${sym} tidak lagi didefinisikan di main.js`);
}
ok(/from "\.\/rgb-page\.js"/.test(mainSrc), 'main.js meng-import dari rgb-page.js');
ok(/from "\.\/dom\.js"/.test(mainSrc), 'main.js meng-import dari dom.js');
ok(/setRgbTransport\(sendLine\)/.test(mainSrc), 'transport disuntikkan lewat setRgbTransport()');
ok(/initRgbPage\(\)/.test(mainSrc), 'initRgbPage() dipanggil');
ok(/if \(handleRgbLine\(line, log\)\) return;/.test(parserSrc), 'parser RGB ditangani oleh handleRgbLine()');

console.log('\n--- 3. Nama & indeks key mengikuti urutan rantai LED ---');
ok(rgbKeyName(0, 0) === 'RGB 1' && rgbKeyName(0, 1) === 'RGB 2' && rgbKeyName(0, 2) === 'RGB 3', 'baris 0: RGB 1..3');
ok(rgbKeyName(1, 2) === 'RGB 4' && rgbKeyName(1, 1) === 'RGB 5' && rgbKeyName(1, 0) === 'RGB 6', 'baris 1 serpentine: RGB 6, 5, 4');
ok(rgbKeyName(2, 0) === 'RGB 7' && rgbKeyName(2, 2) === 'RGB 9', 'baris 2: RGB 7..9');
ok(ledIndex(1, 0) === 5 && ledIndex(2, 2) === 8, 'indeks rantai sesuai firmware');
ok(RGB_MODES.length === 9, '9 mode lighting');

console.log('\n--- 4. handleRgbLine mengenal baris RGB dan menolak yang lain ---');
ok(handleRgbLine('[KEY] 0,0,0,1,a', log) === false, 'baris non-RGB dikembalikan false (tidak dimakan)');
ok(handleRgbLine('DUMP_END', log) === false, 'DUMP_END bukan urusan RGB');

console.log('\n--- 5. RGB_DUMP mengisi state dari device ---');
rgb.dirty = false; rgb.mode = 0;
handleRgbLine('RGB_DUMP:enabled=1,mode=6,random=1,bri=120,speed=200,color=10:20:30,dirty=1', log);
ok(rgb.mode === 6, `mode terbaca 6 (ditemukan ${rgb.mode})`);
ok(rgb.bri === 120, `brightness terbaca 120 (ditemukan ${rgb.bri})`);
ok(rgb.speed === 200, `speed terbaca 200 (ditemukan ${rgb.speed})`);
ok(rgb.random === true, 'random terbaca true');
ok(rgb.dirty === true, 'flag dirty terbaca dari device');
ok(JSON.stringify(rgb.color) === '[10,20,30]', `warna global terbaca (${JSON.stringify(rgb.color)})`);

console.log('\n--- 6. RGB_KEY: indeks rusak ditolak, nilai ber-koma utuh ---');
rgb.keys = [];
handleRgbLine('RGB_KEY:1,1,40:50:60', log);
ok(rgb.keys[1] && rgb.keys[1][1] && rgb.keys[1][1].join(':') === '40:50:60',
  `warna per key tersimpan sebagai triple (ditemukan ${JSON.stringify(rgb.keys[1] && rgb.keys[1][1])})`);
const before = JSON.stringify(rgb.keys);
handleRgbLine('RGB_KEY:99,0,1:2:3', log);
ok(JSON.stringify(rgb.keys) === before, 'baris dengan indeks 99 ditolak, state tidak berubah');
handleRgbLine('RGB_KEY:0,0,40:50', log);          // hanya 2 komponen warna
ok(logs.length > 0 && logs.some(l => l.includes('tidak valid')), 'warna tidak lengkap dicatat sebagai error');

console.log('\n--- 7. hexToRgb ---');
ok(JSON.stringify(hexToRgb('#10605A')) === '[16,96,90]', 'hex 6 digit');
ok(JSON.stringify(hexToRgb('#abc')) === '[170,187,204]', 'hex 3 digit');
ok(JSON.stringify(parseRgbTriple('10:20:30')) === '[10,20,30]', 'triple RGB dibaca benar (regresi map(parseInt))');
ok(parseRgbTriple('10:20') === null, 'triple tidak lengkap ditolak');
ok(parseRgbTriple('10:20:300') === null, 'komponen > 255 ditolak');
ok(parseRgbTriple('a:b:c') === null, 'komponen non-numerik ditolak');
ok(JSON.stringify(parseRgbTriple('0:128:255')) === '[0,128,255]', 'angka > 9 (yang dulu jadi radix) benar');

console.log(`\n${fail === 0 ? 'HASIL: rgb-page.js benar dan mandiri' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);




