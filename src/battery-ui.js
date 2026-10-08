// ==================== UI BATERAI & CHARGER ====================
//
// Indikator baterai di header beserta logika peringatan ambang.
//
// Angka di sini SELALU berasal dari firmware lewat EVT:BATT / EVT:CHG - bukan
// angka buatan app. Pada board PROTOTYPE firmware mengirim angka simulasi dan
// deviceProfile.simulated membuat UI menandainya demikian, supaya tidak
// tertukar dengan data hardware asli.
//
// Modul ini dipisah dari adaptive/runtime karena tidak ada hubungannya sama sekali
// dengan preset, tapi sebelumnya terselip di tengah blok tersebut.

import { el } from './dom.js';
import { t } from './i18n.js';

// pct/mv null = belum ada data. chargeState mengikuti enum ChargeState di firmware:
// 0 = tidak mengecas, 1 = sedang mengecas, 2 = selesai.
export let battUI = { pct: null, mv: null, charging: false, usb: false, chargeState: 0, simulated: false };
export let battNotifLevel = null;   // 'low' | 'crit' | null - ambang terakhir yang dinotifikasi

let notify = () => { };
export function initBatteryUi(n) { notify = n || notify; }

// Firmware melaporkan status charger sebagai angka; mapping ini harus sama dengan
// enum ChargeState di firmware/common/limits.h.
const CHARGE_STATES = { 0: 'batt.charge0', 1: 'batt.charge1', 2: 'batt.charge2' };

export function chargeStateLabel(st) { return t(CHARGE_STATES[st] || 'batt.chargeUnknown'); }

// Dipakai HWINFO: profil baru saja diterima, tapi angka baterai yang lama (dari
// device sebelumnya) tidak boleh ikut terbawa.
export function markBatterySimulated(sim) { battUI.simulated = !!sim; }

// Angka dari device tidak boleh dipercaya buta: parseInt("abc") = NaN, dan NaN
// akan tampil sebagai "NaN%" di UI serta merusak perbandingan ambang (NaN <= 20
// selalu false, jadi peringatan low tidak akan pernah berbunyi).
function num(v) {
  const n = parseInt(v);
  return Number.isInteger(n) ? n : null;
}

export function setBatteryFromKv(kv) {
  if (kv.pct !== undefined) { const n = num(kv.pct); if (n !== null && n >= 0 && n <= 100) battUI.pct = n; }
  if (kv.mv !== undefined) { const n = num(kv.mv); if (n !== null) battUI.mv = n; }
  if (kv.charging !== undefined) battUI.charging = kv.charging === '1';
  if (kv.usb !== undefined) battUI.usb = kv.usb === '1';
  updateBatteryUI();
}

export function setChargeState(st) {
  const n = parseInt(st);
  if (!Number.isInteger(n)) return;
  battUI.chargeState = n;
  battUI.charging = n === 1;
  updateBatteryUI();
}

// Dipakai hook onDisconnected: jangan biarkan angka device sebelumnya tertinggal
// di UI setelah putus, karena user akan mengira device masih hidup.
export function clearBattery() {
  battUI = { pct: null, mv: null, charging: false, usb: false, chargeState: 0, simulated: false };
  battNotifLevel = null;
  updateBatteryUI();
}

export function updateBatteryUI() {
  const ind = el('battInd'); if (!ind) return;
  // Screen reader tidak bisa membaca isi SVG. Karena itu indikator ditandai
  // role="img" di index.html, dan maknanya dipindahkan ke aria-label.
  // Nilai "--" pun tetap diberi label, kalau tidak screen reader membacakan kosong.
  const speak = (txt) => { ind.setAttribute('aria-label', txt); };
  if (battUI.pct === null) {
    el('battPct').textContent = '--';
    el('battFill').style.transform = 'scaleX(0.02)';
    el('battBolt').style.display = 'none';
    ind.classList.remove('low', 'crit');
    speak(t('batt.noData'));
    return;
  }
  el('battPct').textContent = battUI.pct + '%';
  el('battFill').style.transform = `scaleX(${Math.max(0.02, battUI.pct / 100)})`;
  ind.classList.toggle('low', battUI.pct <= 20 && battUI.pct > 10);
  ind.classList.toggle('crit', battUI.pct <= 10);
  el('battBolt').style.display = battUI.charging ? 'block' : 'none';
  ind.title = battUI.simulated
    ? t('batt.titleSim') + (battUI.mv !== null ? t('batt.titleSimMv', { mv: battUI.mv }) : '')
    : (battUI.mv !== null ? t('batt.titleMv', { mv: battUI.mv }) : t('batt.titleNone'));
  const mAh = battUI.mv !== null ? t('batt.mvolts', { mv: battUI.mv }) : '';
  const mode = battUI.simulated ? t('batt.simMode') : '';
  speak(t('batt.pct', { pct: battUI.pct, charging: battUI.charging ? t('batt.chargingNow') : '', mv: mAh, sim: mode }));

  // Peringatan hanya saat ambang BARU dilewati, bukan setiap EVT:BATT (yang datang
  // tiap 5 detik) - tanpa ini notifikasi muncul terus-menerus.
  // Ambang direset saat baterai naik lagi atau sedang mengecas supaya peringatan
  // bisa berbunyi lagi di siklus berikutnya.
  const lvl = battUI.pct <= 10 ? 'crit' : (battUI.pct <= 20 ? 'low' : 'ok');
  if (battUI.charging || lvl === 'ok') battNotifLevel = null;
  else if (lvl !== battNotifLevel) {
    battNotifLevel = lvl;
    if (lvl === 'crit') notify(t('batt.critNotif', { pct: battUI.pct }), 'batt-crit', { hold: 8000 });
    else notify(t('batt.lowNotif', { pct: battUI.pct }), 'batt-low', { hold: 6000 });
  }
}

// Render pertama saat modul dimuat, supaya indikator langsung tampil "--" dan
// bukan kosong. Dijadwalkan (bukan langsung) karena modul ini bisa diimpor
// sebelum DOM siap di sidebar.
setTimeout(updateBatteryUI, 0);