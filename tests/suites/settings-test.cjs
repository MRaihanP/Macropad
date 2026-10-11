// Menguji: (1) default setting sesuai permintaan, (2) setting benar-benarpersist
// setelah app dibuka kembali, (3) kind notifikasi baterai memakai key yang memang
// dibaca filter notify() - sebelumnya 'batt' yang tidak ada di daftar filter, sehingga
// notifikasi baterai ikut dikendalikan toggle "Notifikasi dasar".
const fs = require('fs');
const src = fs.readFileSync('src/main.js', 'utf8');
// Bagian preset & indikator baterai sudah dipindah ke modul sendiri (Phase 8 tahap 4),
// jadi test ini harus membaca berkas yang tepat untuk tiap bagian.
const adaptiveSrc = fs.readFileSync('src/adaptive.js', 'utf8');
const batterySrc = fs.readFileSync('src/battery-ui.js', 'utf8');
const notifySrc = fs.readFileSync('src/ui-notify.js', 'utf8');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };

console.log('--- 1. Default semua aktif ---');
const def = notifySrc.match(/const settings = (\{[^}]+\})/);
ok(!!def, `objek settings ditemukan: ${def ? def[1] : '-'}`);
if (def) {
  for (const k of ['notifyBasic', 'notifyKeys', 'notifyBattery']) {
    const v = def[1].match(new RegExp(`${k}:\\s*(true|false)`));
    ok(v && v[1] === 'true', `${k} default true (ditemukan ${v ? v[1] : 'tidak ada'})`);
  }
}
const pd = adaptiveSrc.match(/let presetsData = \{ masterEnabled: (true|false)/);
ok(pd && pd[1] === 'true', `presetsData.masterEnabled default true (ditemukan ${pd ? pd[1] : 'tidak ada'})`);
const pf = adaptiveSrc.match(/presetsData = \{ masterEnabled: (true|false), presets: \[\] \}; \}/);
ok(pf && pf[1] === 'true', `fallback saat gagal muat juga true (ditemukan ${pf ? pf[1] : 'tidak ada'})`);

console.log('\n--- 2. Persistensi ---');
ok(/localStorage\.setItem\(SETTINGS_KEY/.test(notifySrc), 'settings ditulis ke localStorage');
ok(/localStorage\.getItem\(SETTINGS_KEY/.test(notifySrc), 'settings dibaca kembali dari localStorage saat start');
const toggles = ['notifyBasicToggle', 'notifyKeysToggle', 'notifyBatteryToggle'];
for (const t of toggles) {
  const hasSet = new RegExp(`el\\('${t}'\\)\\.checked = settings\\.`).test(src);
  const hasSave = new RegExp(`el\\('${t}'\\)\\.onchange[\\s\\S]{0,120}saveSettings\\(\\)`).test(src);
  ok(hasSet && hasSave, `${t} disinkronkan ke settings DAN memanggil saveSettings()`);
}
ok(/invoke\('presets_save'/.test(src), 'masterEnabled disimpan lewat presets_save ke presets.json');

console.log('\n--- 3. Kind notifikasi baterai cocok dengan filter notify() ---');
// Filter di notify()
const filter = notifySrc.match(/kind === 'batt-low' \|\| kind === 'batt-crit' \|\| kind === 'charge' \|\| kind === 'charge-done'/);
ok(!!filter, 'filter notify() recognises 4 kind baterai');
const used = [...notifySrc.matchAll(/notify\([^)]*?'(batt-low|batt-crit|charge|charge-done|batt)'/g)].map(m => m[1]);
const kinds = [...new Set(used)];
console.log(`  kind baterai yang dipakai: ${kinds.join(', ')}`);
for (const k of kinds) {
  ok(['batt-low', 'batt-crit', 'charge', 'charge-done'].includes(k), `kind "${k}" ada di filter notify()`);
}
ok(!kinds.includes('batt'), 'kind "batt" yang salah tidak lagi dipakai');

console.log('\n--- 4. Peringatan baterai tidak berulang ---');
ok(/battNotifLevel = null;/.test(batterySrc), 'ada reset ambang (baterai naik / sedang mengecas)');
const guarded = batterySrc.match(/else if \(lvl !== battNotifLevel\)/);
ok(!!guarded, 'notifikasi hanya saat ambang baru dil-crossing, bukan tiap EVT:BATT');

console.log('\n--- 5. Error simpan adaptive tidak ditelan ---');
ok(!/presets_save'\)\.catch\(\(\)=>\{\}\)/.test(src), 'presets_save tidak lagi memakai .catch(()=>{})');

console.log(fail === 0 ? '\nHASIL: default, persistensi, dan notifikasi baterai benar' : `\nHASIL: ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);