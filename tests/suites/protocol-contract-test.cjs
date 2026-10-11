// Uji kontrak protokol firmware <-> app.
// App memotong baris dengan substring(N); N HARUS sama dengan panjang prefiks yang
// dicetak firmware. Offset yang meleset akan memunculkan [ERROR] Komando tidak
// dikenal atau state yang terpotong tanpa keterangan.
const fs = require('fs');
const core = fs.readFileSync('firmware/common/macropad_core.h', 'utf8');
const app = fs.readFileSync('src/main.js', 'utf8');
// handleLine pindah ke src/protocol-parser.js (Phase 8 tahap 5), jadi baris device
// dari device dibaca dari sana.
const parser = fs.readFileSync('src/protocol-parser.js', 'utf8');
// Perintah RGB sudah pindah ke modul src/rgb-page.js (Phase 8 tahap 2),
// jadi kontrak harus diperiksa di sana - bukan hanya di main.js.
const rgbPage = fs.readFileSync('src/rgb-page.js', 'utf8');
const appAll = app + '\n' + rgbPage;

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

console.log('--- A. Prefix yang DICETAK firmware ---');
// Prefix dapat berisi beberapa segmen_upper-case yang dipisah titik dua,
// mis. "EVT:BATT:" - pola lama hanya menangkap sampai titik dua pertama.
const PFX = '((?:[A-Z_]+:)+)';
const printed = {};
for (const m of core.matchAll(new RegExp(`(?:Serial\\.|SERIAL->)(?:printf|print)\\("${PFX}`, 'g'))) printed[m[1]] = true;
for (const m of core.matchAll(/Serial\.println\("([A-Z_]+)"\)/g)) printed[m[1]] = true;
for (const m of core.matchAll(new RegExp(`Serial\\.println\\("${PFX}`, 'g'))) printed[m[1]] = true;

for (const p of ['RGB_DUMP:', 'RGB_KEY:', 'EVT:BATT:', 'HWINFO:']) {
  ok(printed[p], `firmware mencetak prefix "${p}"`);
}
ok(/EVT:CHG:state=%d/.test(core), 'firmware mencetak "EVT:CHG:state=%d"');

console.log('\n--- B. Prefix yang DIPARSE app (substring(N)) ---');
// app: line.substring(N) lalu cek startsWith(prefix)
const parseSites = [...parser.matchAll(/line\.startsWith\('([A-Z_]+:)'\)\)/g)].map(m => m[1]);
const subs = [...parser.matchAll(/line\.substring\((\d+)\)/g)].map(m => +m[1]);
console.log(`  app mem-parse: ${[...new Set(parseSites)].join(', ')}`);
console.log(`  substring(N) yang dipakai: ${[...new Set(subs)].sort((a,b)=>a-b).join(', ')}`);

// Pasangan: prefix -> offset yang harus dipakai
const expect = {
  'HWINFO:': 7, 'EVT:BATT:': 9, 'RGB_DUMP:': 9, 'RGB_KEY:': 8,
};
for (const [prefix, n] of Object.entries(expect)) {
  ok(subs.includes(n), `app memakai substring(${n}) untuk "${prefix}" (panjang prefix = ${prefix.length})`);
  ok(prefix.length === n, `panjang "${prefix}" = ${prefix.length} = offset ${n}`);
}

console.log('\n--- C. Command yang DIKIRIM app vs diterima firmware ---');
const sent = new Set([...appAll.matchAll(/sendLine\(`?['"]?(RGB:[A-Z]*[:A-Za-z]*)/g)].map(m => m[1]));
const sent2 = new Set([...appAll.matchAll(/sendLine\(\s*'(RGB:[A-Z]+)'/g)].map(m => m[1]));
for (const cmd of ['RGB:ON', 'RGB:OFF', 'RGB:EN:', 'RGB:MODE:', 'RGB:BRI:', 'RGB:ALL:', 'RGB:KEY:', 'RGB:SAVE', 'RGB:RESET', 'RGB:DUMP']) {
  ok(core.includes(`"${cmd}"`), `firmware menerima ${cmd}`);
}
const accepted = new Set([...core.matchAll(/cmd == "(RGB:[A-Z]+)"/g)].map(m => m[1]));
for (const [p, n] of [['RGB:BRI:', 8], ['RGB:ALL:', 8], ['RGB:KEY:', 8], ['RGB:EN:', 7], ['RGB:MODE:', 9]]) {
  const off = core.includes(`cmd.c_str() + ${n}`) || core.includes(`cmd.substring(${n})`);
  ok(off, `firmware menggeser ${n} karakter untuk ${p} (panjang prefix = ${p.length})`);
}

console.log('\n--- D. Format angka RGB:MODE (6 angka) ---');
const modeFmt = core.match(/sscanf\(cmd\.c_str\(\) \+ 9, "([^"]+)"/);
ok(!!modeFmt, 'firmware punya sscanf untuk RGB:MODE');
if (modeFmt) {
  const fields = modeFmt[1].split(':').filter(s => s.startsWith('%d'));
  ok(fields.length === 6, `RGB:MODE membaca ${fields.length} angka (mode,random,r,g,b,speed)`);
}
const appMode = "RGB:MODE:${rgb.mode}:${rgb.random ? 1 : 0}:${rgb.color.join(':')}:${rgb.speed}";
ok(rgbPage.includes(appMode), 'rgb-page mengirim RGB:MODE dengan mode,random,r:g:b,speed');

console.log(fail === 0 ? '\nHASIL: kontrak protokol firmware <-> app konsisten' : `\nHASIL: ${fail} ketidakcocokan`);
process.exit(fail === 0 ? 0 : 1);

