// ==================== ROUTER HALAMAN ====================
//
// Navigasi sidebar: menyembunyikan/menampilkan blok .page dan menandai .nav-item
// yang aktif.
//
// `navOverride` dipakai saat masuk mode edit App Preset: isi Home yang ditampilkan
// tapi sidebar tetap menyorot "Adaptive", karena secara konsep user memang sedang
// ada di Adaptive. Tanpa itu, user mengira dia sudah pindah ke Home dan klik
// sesuatu yang salah.

import { el } from './dom.js';

export function switchPage(name, navOverride) {
  const navName = navOverride || name;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === navName));
  document.querySelectorAll('.page').forEach(p => p.style.display = (p.id === 'page-' + name) ? 'block' : 'none');
}

// Hook halaman ikut dipasang di sini, tapi butuh adaptive.js (untuk
// confirmLeavePresetEditor) - jadi lewat initRouter(), bukan langsung di level modul.
let confirmLeave = async () => { };
let isEditingPreset = () => false;
export function initRouter({ confirmLeavePresetEditor, editingPreset }) {
  if (confirmLeavePresetEditor) confirmLeave = confirmLeavePresetEditor;
  if (editingPreset) isEditingPreset = editingPreset;
}

export function initSidebar() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = async () => {
      const target = item.dataset.page;
      // Saat mode edit preset, pindah halaman berarti meninggalkan draft. Tutup
      // editor dulu (dengan konfirmasi kalau ada perubahan) - JANGAN pindah
      // halaman seperti biasa, karena draft-nya akan menggantung tanpa penjelasan.
      if (isEditingPreset()) {
        if (target === 'adaptive') return;   // sudah "di situ" secara konsep, no-op
        await confirmLeave();
        return;
      }
      switchPage(target);
    };
  });

  el('btnToggleSidebar').onclick = () => {
    el('sidebar').classList.toggle('collapsed');
    try { localStorage.setItem('sidebarCollapsed', el('sidebar').classList.contains('collapsed')); } catch (e) { }
  };
  // Default-nya collapsed: sidebar sempit lebih sering dipakai daripada ruang lega.
  if (localStorage.getItem('sidebarCollapsed') !== 'false') el('sidebar').classList.add('collapsed');
}