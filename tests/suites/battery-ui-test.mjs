// Menguji src/battery-ui.js tanpa browser.
//
// Yang diuji adalah bagian yang tricky: penentuan ambang dan KAPAN notifikasi
// battery low/critical harus berbunyi. EVT:BATT datang setiap 5 detik, jadi kalau
// setiap event memicu notifikasi, overlay akan sangat menyebalkan.
//
// Jalankan: node battery-ui-test.mjs
import { SRC_URL } from '../runner/paths.mjs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (ditemukan ${JSON.stringify(a)}, diharapkan ${JSON.stringify(b)})`);

const SRC = SRC_URL;   // dihitung dari lokasi file ini, bukan path absolut

// --- Stub DOM yang mencatat perubahan ---
// setAttribute/getAttribute dipakai battery-ui.js untuk aria-label (indikator baterai
// berupa SVG, yang isinya tidak bisa dibaca screen reader).
function mkIndicator() {
  const set = new Set();
  const attrs = {};
  return {
    style: {}, title: '', innerHTML: '', _c: set, _attrs: attrs,
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
      contains: (c) => set.has(c),
    },
  };
}
const ind = mkIndicator();
const mkEl = () => ({
  value: '', textContent: '', innerHTML: '', checked: false, style: {},
  classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
  appendChild() { }, querySelector() { return mkEl(); }, querySelectorAll() { return []; },
  addEventListener() { }, setAttribute() { }, remove() { },
});
const els = {};
globalThis.document = {
  getElementById: (id) => (id === 'battInd' ? ind : (els[id] || (els[id] = mkEl()))),
  createElement: () => mkEl(),
};

const B = await import(`${SRC}/battery-ui.js`);
const notes = [];
B.initBatteryUi((t, k, o) => notes.push({ t, k, hold: o && o.hold }));
// Modul menjadwalkan render pertama; tunggu supaya assertion bisa/GlobalState-ons.
await new Promise((r) => setTimeout(r, 10));

// Bentuk baris EVT:BATT seperti yang dikirim firmware.
const batt = (pct, extra = {}) =>
  B.setBatteryFromKv({ pct: String(pct), mv: String(3300 + pct * 3), charging: '0', usb: '0', ...extra });

console.log('--- 1. Belum ada data = tanda "--", bukan angka palsu ---');
eq(els.battPct.textContent, '--', 'persentase menampilkan -- sebelum EVT:BATT pertama');
eq(B.battUI.pct, null, 'pct null sebelum data');

console.log('\n--- 2. Data EVT:BATT terbaca dan tampil ---');
batt(55);
eq(els.battPct.textContent, '55%', 'persentase sesuai firmware');
eq(B.battUI.pct, 55, 'pct tersimpan');
ok(/scaleX\(0\.55\)/.test(els.battFill.style.transform), `bar terisi sesuai pct (${els.battFill.style.transform})`);
ok(!ind.classList.contains('low') && !ind.classList.contains('crit'), '55% tidak ditandai low/crit');
eq(els.battBolt.style.display, 'none', 'tidak ada ikon charging');

console.log('\n--- 3. Batas low (<=20) dan crit (<=10) ---');
batt(20);
ok(ind.classList.contains('low'), 'tepat 20% = low');
batt(21);
ok(!ind.classList.contains('low'), '21% bukan low');
batt(10);
ok(ind.classList.contains('crit'), 'tepat 10% = crit');
batt(11);
ok(ind.classList.contains('low'), '11% = low (bukan crit)');

console.log('\n--- 4. Notifikasi hanya saat ambang BARU dil-crossing ---');
notes.length = 0;
B.clearBattery();
batt(50); eq(notes.length, 0, 'baterai sehat: tidak ada notifikasi');
batt(19); eq(notes.length, 1, 'turun ke 19% memicu tepat 1 notifikasi');
eq(notes[0].k, 'batt-low', `kind notifikasi low (${notes[0].k})`);
batt(18); eq(notes.length, 1, 'EVT:BATT berikutnya di 18% TIDAK mengulang notifikasi');
batt(17); batt(16); eq(notes.length, 1, 'masih tidak mengulang');
batt(9);  eq(notes.length, 2, 'turun ke 9% memicu notifikasi critical');
eq(notes[1].k, 'batt-crit', `kind notifikasi crit (${notes[1].k})`);
ok(notes[1].hold > notes[0].hold, 'notifikasi crit ditahan lebih lama dari low');

console.log('\n--- 5. Naik lagi / mulai mengecas = ambang direset ---');
notes.length = 0;
batt(60); eq(notes.length, 0, 'baterai naik: tidak ada notifikasi');
batt(19); eq(notes.length, 1, 'turun lagi ke 19% setelah naik: notifikasi berbunyi lagi');
notes.length = 0;
batt(5);  eq(notes.length, 1, 'turun ke 5% = crit');
notes.length = 0;
batt(5, { charging: '1' }); eq(notes.length, 0, 'mengecas: tidak ada notifikasi baru');
batt(4, { charging: '1' }); eq(notes.length, 0, 'mengecas dengan tegangan turun: tetap tidak ada notifikasi');
batt(4, { charging: '0' }); eq(notes.length, 1, 'berhenti mengecas di 4%: ambang dibunyikan lagi (siklus berikutnya)');

console.log('\n--- 6. Ikon charging mengikuti EVT:CHG ---');
B.clearBattery();
batt(50, { charging: '0' });
eq(els.battBolt.style.display, 'none', 'EVT:CHG state=0 (tidak mengecas)');
B.setChargeState(1);
eq(B.battUI.charging, true, 'state=1 = sedang mengecas');
eq(els.battBolt.style.display, 'block', 'ikon petir tampil saat mengecas');
B.setChargeState(2);
eq(B.battUI.charging, false, 'state=2 (cas selesai) BUKAN charging');
eq(els.battBolt.style.display, 'none', 'ikon charging mati setelah cas selesai');
eq(B.chargeStateLabel(0), 'tidak mengecas', 'label state 0');
eq(B.chargeStateLabel(1), 'mengecas', 'label state 1');
eq(B.chargeStateLabel(2), 'cas selesai', 'label state 2');
eq(B.chargeStateLabel(99), 'tidak diketahui', 'state di luar enum ditangani, tidak crash');

console.log('\n--- 7. Badge simulasi firmware prototipe ---');
B.clearBattery();
batt(80);
ok(!/SIMULASI/.test(ind.title), 'HWINFO tanpa flag simulated: judul tidak menandai simulasi');
B.markBatterySimulated(true);
batt(80);
ok(/SIMULASI/.test(ind.title), 'HWINFO simulated=1: judul menandai DATA SIMULASI');
ok(/mV/.test(ind.title), 'judul tetap menampilkan tegangan');

console.log('\n--- 8. clearBattery() mengosongkan semua, termasuk ambang notifikasi ---');
B.markBatterySimulated(true);
batt(5);
eq(B.battUI.pct, 5, 'sebelum clear: pct 5');
B.clearBattery();
eq(B.battUI.pct, null, 'clearBattery() mengosongkan pct');
eq(B.battUI.mv, null, 'clearBattery() mengosongkan mv');
eq(B.battUI.chargeState, 0, 'clearBattery() mengembalikan chargeState ke 0');
eq(els.battPct.textContent, '--', 'UI kembali menampilkan --');
notes.length = 0;
batt(19);
eq(notes.length, 1, 'ambang ikut direset: notifikasi bisa berbunyi lagi setelah reconnect');

console.log('\n--- 9. Nilai tidak valid dari device tidak bikin crash ---');
B.clearBattery();
B.clearBattery();
B.setBatteryFromKv({ pct: 'abc', mv: 'xyz' });
ok(Number.isNaN(B.battUI.pct) === false, 'pct non-numerik DITOLAK, bukan NaN');
eq(B.battUI.pct, null, 'pct tetap null, bukan NaN');
eq(B.battUI.mv, null, 'mv non-numerik ditolak');
eq(els.battPct.textContent, '--', 'tidak ada NaN% yang bocor ke UI');
notes.length = 0;
batt(5);
eq(notes.length, 1, 'ambang tetap bekerja setelah nilai buruk ditolak');
notes.length = 0;
B.setBatteryFromKv({ pct: '999' });
eq(B.battUI.pct, 5, 'pct di luar 0..100 ditolak, nilai lama dipertahankan');
eq(els.battPct.textContent, '5%', 'UI tidak menampilkan angka di luar jangkauan');
batt(30);
eq(els.battPct.textContent, '30%', 'data valid tetap terbaca');

console.log(`\n${fail === 0 ? 'HASIL: battery-ui.js berperilaku benar' : 'HASIL: ' + fail + ' gagal'}`);
process.exit(fail === 0 ? 0 : 1);