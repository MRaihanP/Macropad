// ==================== ROUTER HALAMAN ====================
//
// Navigasi sidebar: menyembunyikan/menampilkan blok .page dan menandai item yang
// aktif, untuk mata maupun untuk keyboard.
//
// `navOverride` dipakai saat masuk mode edit App Preset: isi Home yang ditampilkan
// tapi sidebar tetap menyorot "Adaptive", karena secara konsep user memang sedang
// ada di Adaptive. Tanpa itu, user mengira dia sudah pindah ke Home dan klik
// sesuatu yang salah.
//
// Aksesibilitas:
//  - Item navigasi adalah <button>, jadi otomatis masuk tab order dan bisa
//    ditekan Enter/Space tanpa handler tambahan.
//  - aria-current="page" menandai halaman yang sedang aktif - tanpa itu screen
//    reader hanya membacakan daftar tombol tanpa tahu posisi sekarang.
//  - Panah kiri/kanan memindah fokus antar item, pola yang lazim untuk
//    navigator seperti tab list. Tanpa ini, pindah halaman harus Tab lewat
//    seluruh isi halaman dulu.

import { el } from './dom.js';

export function switchPage(name, navOverride) {
  const navName = navOverride || name;
  document.querySelectorAll('.nav-item').forEach(i => {
    const isActive = i.dataset.page === navName;
    i.classList.toggle('active', isActive);
    // Hanya item yang disorot yang ditandai current. Saat navOverride dipakai,
    // sidebar menyorot Adaptive sementara Home yang terlihat - aria-current
    // sengaja mengikuti sorotan supaya tidak bertentangan dengan yang diucapkan.
    if (isActive) i.setAttribute('aria-current', 'page');
    else i.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach(p => p.style.display = (p.id === 'page-' + name) ? 'block' : 'none');
  // Beri tahu modul halaman supaya bisa menyegarkan data saat halaman dibuka
  // (mis. library soundboard yang berubah dari tempat lain).
  document.dispatchEvent(new CustomEvent('page:change', { detail: name }));
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
    // Tombol sudah bisa ditekan Enter/Space oleh browser sendiri, jadi onclick
    // saja cukup untuk aktivasi.
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

    item.onkeydown = (e) => {
      const fwd = (e.key === 'ArrowRight' || e.key === 'ArrowDown');
      const back = (e.key === 'ArrowLeft' || e.key === 'ArrowUp');
      if (!fwd && !back) return;
      e.preventDefault();   // jangan sampai halaman ikut ter-scroll
      const items = [...document.querySelectorAll('.nav-item')];
      if (items.length === 0) return;
      const i = items.indexOf(item);
      const next = items[(i + (fwd ? 1 : -1) + items.length) % items.length];
      next.focus();
    };
  });

  const sidebar = el('sidebar');
  const toggle = el('btnToggleSidebar');
  toggle.onclick = () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    // aria-expanded memberitahu screen reader apakah isi sidebar sedang terlihat.
    toggle.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('sidebarCollapsed', String(collapsed)); } catch (e) { }
  };
  // Default-nya collapsed: sidebar sempit lebih sering dipakai daripada ruang lega.
// localStorage di-wrap try/catch seperti di semua modul lain: kalau storage
// diblokir (webview belum siap, storage penuh), satu lemparan di sini membatalkan
// seluruh initSidebar() dan item navigasi tidak pernah terpasang sama sekali.
  let stored = null;
  try { stored = localStorage.getItem('sidebarCollapsed'); } catch (e) { }
  const startCollapsed = stored !== 'false';
  if (startCollapsed) sidebar.classList.add('collapsed');
  toggle.setAttribute('aria-expanded', String(!startCollapsed));
}