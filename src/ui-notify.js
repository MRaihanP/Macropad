// ==================== NOTIFIKASI ====================
//
// Overlay notifikasi (jendela terpisah di Rust, digambar oleh overlay.html).
//
// kind: connect | disconnect | layer | preset | key | batt-low | batt-crit |
//       charge | charge-done | info
//
// Dipisah dari main.js karena bukan hal konkret: dipakai dari mana saja -
// parser protokol, adaptive, battery-ui, dan panel editor semuanya lewat
// notify() di modul ini.

import { invoke } from '@tauri-apps/api/core';
import { el, log } from './dom.js';
import { t } from './i18n.js';

// ---- Setting notifikasi ----
// Disimpan di localStorage, jadi pilihan user bertahan setelah app ditutup.
export const SETTINGS_KEY = 'macropad.settings';
export const settings = { notifyBasic: true, notifyKeys: true, notifyBattery: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { }
export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { }
}

// ---- Teks notifikasi per key = aksi yang di-bind pada tombol tersebut ----
const CONSUMER_LABEL = { VOLUP: 'Volume +', VOLDOWN: 'Volume -', MUTE: 'Mute', PLAYPAUSE: 'Play/Pause', NEXT: 'Next', PREV: 'Prev' };

export function describeAction(type, value) {
  const v = (value || '').trim();
  switch (type) {
    case 1: case 2: return v;                                          // KEY / COMBO: "1", "CTRL+C"
    case 3: return v.length > 28 ? v.slice(0, 27) + '…' : v;        // TEXT: teksnya
    case 4: return CONSUMER_LABEL[v.toUpperCase()] || v;               // CONSUMER: label media
    case 5: return t('app.openAction', { name: v.replace(/\.exe$/i, '') });   // APP: "Open Discord"
    default: return '';
  }
}

export function notifyBoundAction(type, value) {
  // Jangan namai variabel ini `t`: `t` adalah fungsi terjemahan yang diimpor di
  // file ini. Menimpanya di sini legal (describeAction tidak memanggil t()),
  // tapi setiap penambahan t() berikutnya diam-diam jadi bug yang salah string.
  const label = describeAction(type, value);
  if (label) notify(label, 'key');                                 // tombol kosong: tidak ada notifikasi
}

// Hanya error pertama yang dicatat ke panel log. Setelah itu, overlay yang gagal
// akan tetap gagal untuk setiap notifikasi berikutnya, jadi mengulangi pesan yang
// sama hanya memenuhi panel log tanpa menambah informasi.
let notifyErrShown = false;

export function notify(text, kind = 'info', opts = {}) {
  if (!opts.force) {
    if (kind === 'key'
      ? !settings.notifyKeys
      : (kind === 'batt-low' || kind === 'batt-crit' || kind === 'charge' || kind === 'charge-done')
        ? !settings.notifyBattery
        : !settings.notifyBasic) return;
  }
  const hold = opts.hold || (kind === 'key' ? 1000 : 3000);   // notifikasi per key hanya 1 detik
  invoke('notify', { text, kind, hold }).catch(e => {
    console.error('notify gagal:', e);
    if (!notifyErrShown) { notifyErrShown = true; log(t('notif.overlayError', { err: e }), 'err'); }
  });
}