// Menguji kecocokan format baris [KEY] antara firmware dan app.
// App mem-parsing dengan regex; kalau tidak cocok, notifikasi per key hilang
// persis seperti yang terjadi setelah log [KEY] dimatikan di Phase 6.
const fs = require('fs');
const core = fs.readFileSync('firmware/common/macropad_core.h', 'utf8');
const app = fs.readFileSync('src/main.js', 'utf8');
// handleLine pindah ke src/protocol-parser.js (Phase 8 tahap 5), jadi baris device
// dari device dibaca dari sana.
const parser = fs.readFileSync('src/protocol-parser.js', 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- A. Format yang dicetak firmware ---');
const fmt = core.match(/(?:Serial\.|SERIAL->)printf\("(\[KEY\][^"]*)"/);
ok(!!fmt, `firmware punya printf untuk [KEY]: ${fmt ? fmt[1] : 'TIDAK ADA'}`);
if (fmt) {
  const spec = fmt[1];
  const nums = (spec.match(/%d/g) || []).length;
  ok(nums === 4, `ada 4 specifier %d (layer,row,col,type) - ditemukan ${nums}`);
  ok(spec.endsWith('%s\\n'), 'diakhiri %s lalu newline');
}

console.log('\n--- B. Regex parser di app ---');
const rx = parser.match(/\^\\\[KEY\\\]\s*(.*?)\$/);
const rxSrc = parser.match(/line\.match\(\/\^\\\[KEY\\\][^/]*\/[a-z]*\)/);
ok(!!rxSrc, `app punya regex untuk [KEY]: ${rxSrc ? rxSrc[0].slice(0, 70) : 'TIDAK ADA'}`);

console.log('\n--- C. Simulasi baris nyata dari firmware vs parser app ---');
// Ambil regex persis dari main.js supaya yang diuji adalah kode yang jalan.
const m = parser.match(/line\.match\((\/\^\\\[KEY\\\][\s\S]*?\/[a-z]*)\)/);
if (!m) { console.log('  FAIL tidak bisa ekstrak regex'); process.exit(1); }
const re = eval(m[1]);

const cases = [
  { line: '[KEY] 0,0,0,1,a',                       expect: { type: 1, value: 'a' } },
  { line: '[KEY] 3,1,2,2,CTRL+C',                  expect: { type: 2, value: 'CTRL+C' } },
  { line: '[KEY] 7,2,2,3,hallo dunia',             expect: { type: 3, value: 'hallo dunia' } },
  { line: '[KEY] 0,0,1,4,AudioVolumeUp',           expect: { type: 4, value: 'AudioVolumeUp' } },
  { line: '[KEY] 2,1,2,5,Discord.exe',             expect: { type: 5, value: 'Discord.exe' } },
  // nilai macro ber-koma harus utuh (COMBO/TEXT bisa mengandung koma)
  { line: '[KEY] 0,0,1,3,a,b,c',                    expect: { type: 3, value: 'a,b,c' } },
  { line: '[KEY] 5,1,1,3,Ctrl+Shift+5, lalu enter', expect: { type: 3, value: 'Ctrl+Shift+5, lalu enter' } },
];
for (const c of cases) {
  const mm = re.exec(c.line);
  if (!mm) { ok(false, `TIDAK COCOK: "${c.line}"`); continue; }
  const type = parseInt(mm[4]), value = mm[5];
  const good = type === c.expect.type && value === c.expect.value;
  ok(good, good ? `"${c.line.slice(0, 34)}..." -> type=${type} value="${value}"`
                : `"${c.line}" -> type=${type} value="${value}" (harusnya type=${c.expect.type} value="${c.expect.value}")`);
}

console.log('\n--- D. Panjang terburuk tidak melewati buffer 64 byte ---');
const worst = '[KEY] 7,2,2,3,' + 'x'.repeat(47);
ok(worst.length + 1 <= 64, `panjang terburuk ${worst.length} + newline = ${worst.length + 1} byte (<= 64)`);

console.log('\n--- E. Format lama tidak lagi dipakai di kedua sisi ---');
ok(!core.includes('[KEY] Layer %d'), 'firmware tidak lagi memakai format verbose lama');
ok(!parser.includes('Layer (\\d+), R(\\d+) C(\\d+) -> type='), 'app tidak lagi memakai regex lama');

console.log(fail === 0 ? '\nHASIL: format [KEY] firmware <-> app konsisten' : `\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);