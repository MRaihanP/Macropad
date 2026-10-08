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
import { sendLine } from './serial-transport.js';
import { isConnected } from './serial-transport.js';
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
  const t = el('autostartToggle');
  try {
    const s = await invoke('autostart_status');
    t.checked = s.enabled;
    t.disabled = !s.available;
    el('autostartLabel').title = s.available ? '' : 'Hanya bisa diatur di build rilis (npm run tauri build)';
  } catch (e) { t.disabled = true; log('[ERROR] Gagal membaca status autostart: ' + e, 'err'); }
}

export function initAutostartToggle() {
  el('autostartToggle').onchange = async (e) => {
    const want = e.target.checked;
    try {
      await invoke('autostart_set', { value: want });
      log(want ? '[LOG] Autostart aktif: app jalan di tray saat Windows start' : '[LOG] Autostart dimatikan', 'ok');
    } catch (err) {
      // Kembalikan posisi toggle supaya tidak menampilkan keadaan yang tidak berlaku.
      e.target.checked = !want;
      log('[ERROR] Gagal mengubah autostart: ' + err, 'err');
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
        'Ada perubahan belum disimpan',
        quitting
          ? 'Konfigurasi di device sudah berubah tapi belum disimpan ke flash. Simpan dulu sebelum keluar?'
          : 'Konfigurasi di device sudah berubah tapi belum disimpan ke flash. Simpan dulu sebelum app disembunyikan ke tray?',
        [
          { label: 'Cancel', value: 'cancel' },
          { label: "Don't Save", value: 'discard' },
          { label: 'Save', value: 'save', primary: true }
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
      log('[LOG] Render tidak merespons, lanjut tanpa mengubah config di device.', 'err');
      return true;
    }
    return false; // 'cancel' atau Escape
  } finally {
    unsavedDialogOpen = false;
  }
}

// ==================== PENANGAN JENDELA & TRAY ====================
export function initTrayHandlers() {
  const appWindow = getCurrentWindow();
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