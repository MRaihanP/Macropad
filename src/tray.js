// ==================== TRAY & AUTOSTART ====================
//
// secara sengaja X tidak menutup app - jendela disembunyikan ke tray. Keluar hanya lewat
// menu tray, supaya tidak ada yang hilang karena salah klik tombol close.
//
// Modul ini memegang dua hal yang berdiri sendiri: status autostart Windows, dan
// dialog "Simpan dulu?" yang dipakai dua jalur (X dan menu tray "Keluar").
//
// Jaring pengaman render: kalau WebView2 sama sekali tidak mengecat lagi (putih
// hitam), dialog yang menunggu klik user akan menggantung selamanya dan X/Keluar ikut
// macet. requestAnimationFrame hanya jalan selama compositor sehat, jadi absence-nya
// dipakai sebagai sinyal "render benar-benar berhenti" - bukan "user sedang mikir".

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { el, log } from './dom.js';
import { showModalBase } from './ui-modal.js';
import { t } from './i18n.js';
import { sendLine, isConnected } from './transport.js';
import { stopRecordingContinuous, clearSelection } from './home-page.js';

// ---- Hook ke main.js ----
let isDirty = () => false;
let setDirty = () => { };
export function initTray(h) {
  if (h.isDirty) isDirty = h.isDirty;
  if (h.setDirty) setDirty = h.setDirty;
}

// ==================== AUTOSTART ====================
// Hanya bisa diatur di build rilis - di mode dev, shortcut menunjuk ke folder target
// debug yang bisa terhapus, jadi toggle-nya dinonaktifkan dengan penjelasan.
export async function initAutostart() {
  // Variabel lokal sengaja tidak disebut "t": "t" adalah fungsi terjemahan dari
  // i18n.js, dan menimpanya di sini membuat panggilan t('tray.autostartError', ...)
  // gagal dengan "t is not a function" karena yang terlihat adalah elemen DOM ini.
  const toggle = el('autostartToggle');
  try {
    const s = await invoke('autostart_status');
    toggle.checked = s.enabled;
    toggle.disabled = !s.available;
    el('autostartLabel').title = s.available ? '' : 'Hanya bisa diatur di build rilis (npm run tauri build)';
  } catch (e) { toggle.disabled = true; log(t('tray.autostartError', { err: e }), 'err'); }
}

export function initAutostartToggle() {
  el('autostartToggle').onchange = async (e) => {
    const want = e.target.checked;
    try {
      await invoke('autostart_set', { value: want });
      log(want ? t('tray.autostartOnLog') : t('tray.autostartOffLog'), 'ok');
    } catch (err) {
      // Kembalikan posisi toggle supaya tidak menampilkan keadaan yang tidak berlaku.
      e.target.checked = !want;
      log(t('tray.autostartSetError', { err }), 'err');
    }
  };
}

// ==================== DETEKSI RENDER STALLED ====================
let lastFrameTs = performance.now();
(function rafLoop(t) { lastFrameTs = t; requestAnimationFrame(rafLoop); })(lastFrameTs);

// Selesai (resolve 'render-stalled') hanya kalau tidak ada frame ter-render selama `ms` berturut-turut.
// Dipakai sebagai jaring pengaman X/Keluar: modal boleh menunggu selama apa pun selama render masih sehat,
// baru dilepas otomatis kalau render benar-benar macet (mis. WebView2 gagal render/putih-hitam).
function whenRenderStalled(ms) {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (performance.now() - lastFrameTs > ms) { clearInterval(iv); resolve('render-stalled'); }
    }, 500);
  });
}

// ==================== DIALOG "SIMPAN DULU?" ====================
// Dipakai untuk dua jalur: X (ke tray) dan menu tray "Keluar" saat jendela masih terbuka.
// Return true kalau boleh lanjut, false kalau user batal.
let unsavedDialogOpen = false;
export async function confirmUnsaved(quitting) {
  if (!isDirty() || !isConnected()) return true; // tanpa koneksi tidak ada yang bisa disimpan/dikembalikan
  if (unsavedDialogOpen) return false;
  unsavedDialogOpen = true;
  try {
    await invoke('show_main_window'); // pastikan dialog terlihat (kasus Keluar dari tray)
    const choice = await Promise.race([
      showModalBase(
        t('tray.unsavedTitle'),
        quitting
          ? t('tray.unsavedQuit')
          : t('tray.unsavedHide'),
        [
          { label: t('modal.cancel'), value: 'cancel' },
          { label: t('modal.dontSave'), value: 'discard' },
          { label: t('modal.save'), value: 'save', primary: true }
        ]
      ),
      whenRenderStalled(3000)
    ]);
    if (choice === 'save') {
      setDirty(false);
      await sendLine('SAVE');
      return true;
    }
    if (choice === 'discard') {
      // Kembalikan isi device ke isi flash supaya tidak menggantung setengah berubah
      setDirty(false);
      await sendLine('LOAD');
      if (!quitting) { await sendLine('INFO'); await sendLine('DUMPENC'); } // segarkan tampilan untuk saat jendela dibuka lagi
      return true;
    }
    if (choice === 'render-stalled') {
      // Render benar-benar berhenti (bukan user lama mikir): jangan biarkan X/Keluar nyangkut selamanya.
      // Config di device TIDAK disentuh (tidak dipaksa save/discard) supaya tidak ada yang hilang salah waktu.
      log(t('tray.renderError'), 'err');
      return true;
    }
    return false; // 'cancel' atau Escape
  } finally {
    unsavedDialogOpen = false;
  }
}

// ==================== PENANGAN JENDELA & TRAY ====================

// Dipanggil main.js lewat setWindowRestoredHandler() supaya "dibuka dari tray"
// bisa menghidupkan kembali auto-connect tanpa tray.js perlu meng-import
// main.js (menghindari siklus import: tray.js sudah meng-import transport.js,
// dan main.js meng-import tray.js).
let onWindowRestored = null;
export function setWindowRestoredHandler(fn) { onWindowRestored = fn; }

export function initTrayHandlers() {
  const appWindow = getCurrentWindow();

  // Jendela disembunyikan ke tray = app masih hidup, hanya tidak terlihat.
  // Desktop tidak punya event "jendela tampil lagi" yang bisa didengar dari
  // JS, tapi membuka jendela dari tray PASTI menghasilkan focus - jadi itu
  // sinyalnya.
  //
  // Filter isVisible() mencegah resume terpicu oleh focus yang terjadi saat
  // app baru start (jendela sudah tampil sejak awal, tidak lewat tray).
  //
  // DIJAGA SUPAYA TIDAK MELEDAK kalau onFocusChanged tidak tersedia: API-nya
  // bisa berubah antar versi Tauri, dan startup-smoke-test memanggil tray.js
  // dengan mock yang tidak punya method ini. Kehilangan auto-resume dari tray
  // jauh lebih baik daripada app yang gagal start.
  if (typeof appWindow.onFocusChanged === 'function') {
    appWindow.onFocusChanged(async ({ payload: focused }) => {
      if (!focused || !onWindowRestored) return;
      const win = getCurrentWindow();
      if (typeof win.isVisible === 'function' && !(await win.isVisible())) return;
      onWindowRestored();
    });
  }

  appWindow.onCloseRequested(async (event) => {
    event.preventDefault(); // X tidak pernah menutup app; keluar lewat menu tray
    if (!(await confirmUnsaved(false))) return;
    stopRecordingContinuous();
    el('editPanel').style.display = 'none';
    clearSelection();
    await invoke('hide_to_tray');
  });

  listen('tray-quit', async () => {
    if (!(await confirmUnsaved(true))) return;
    await invoke('quit_app');
  });
}