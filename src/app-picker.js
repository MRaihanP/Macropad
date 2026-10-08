// ==================== DAFTAR APLIKASI ====================
//
// Picker aplikasi untuk binding key bertipe APP, dan untuk preset App Preset.
//
// Daftar dikelola di sisi Rust (cache + TTL di file) supaya tidak memindai
// Start Menu setiap kali picker dibuka. Modul ini tidak menyimpan apa pun di
// memory app selain tampilan terakhir.
//
// Consent: memindai daftar aplikasi terinstall butuh izin eksplisit user, dan
// jika ditolak, tidak ditanyakan lagi di sesi yang sama (scanDeclined) - kalau
// ditanyakan tiap kali picker dibuka, hanya mengganggu dan tidak informatif.

import { invoke } from '@tauri-apps/api/core';
import { el, log } from './dom.js';
import { showConfirmModal, showPromptModal, clipUtf8 } from './ui-modal.js';

let appsView = { names: [], custom: [], scanned_at: 0, ttl_days: 7, consent: false, stale: true };
// Sudah menolak consent di sesi ini: jangan tanya lagi tiap picker dibuka.
let scanDeclined = false;

export async function ensureAppList(force = false) {
  try {
    appsView = await invoke('apps_get');
    if (!appsView.consent) {
      if (scanDeclined) return false;
      const ok = await showConfirmModal(
        'Izinkan pemindaian aplikasi',
        'Untuk memilih aplikasi dari daftar, app ini perlu membaca daftar aplikasi terinstal di PC ini (sama seperti isi Start Menu). Tidak butuh hak admin, tidak ada data dikirim keluar, dan hasilnya disimpan lokal sehingga tidak dipindai ulang setiap kali.',
        'Izinkan'
      );
      if (!ok) { scanDeclined = true; return false; }
      await invoke('apps_set_consent', { value: true });
    }
    if (force || appsView.stale) {
      el('appMeta').textContent = 'Memindai aplikasi...';
      appsView = await invoke('apps_rescan');
      log(`[APP] ${appsView.names.length} aplikasi ditemukan`, 'ok');
    }
    return true;
  } catch (e) {
    log('[ERROR] Gagal memuat daftar aplikasi: ' + e, 'err');
    return false;
  }
}

export function renderAppPicker() {
  const q = el('appSearch').value.trim().toLowerCase();
  const list = el('appList');
  list.innerHTML = '';
  const customSet = new Set(appsView.custom || []);
  const matches = appsView.names
    .filter(n => n.toLowerCase().includes(q))
    .sort((a, b) => (customSet.has(b) - customSet.has(a))) // entri manual di atas (sort stabil)
    .slice(0, 80);
  matches.forEach(name => {
    const isCustom = customSet.has(name);
    const row = document.createElement('div');
    row.className = 'app-row';
    const b = document.createElement('button');
    b.className = 'app-item' + (clipUtf8(name) === el('editValue').value ? ' active' : '');
    b.textContent = (isCustom ? '★ ' : '') + name;
    b.onclick = () => { el('editValue').value = clipUtf8(name); renderAppPicker(); };
    row.appendChild(b);
    if (isCustom) {
      const del = document.createElement('button');
      del.className = 'app-del small';
      del.textContent = '×';
      del.title = 'Hapus dari daftar (file aslinya tidak dihapus)';
      del.onclick = async () => {
        if (!(await showConfirmModal('Hapus dari daftar', `Hapus "${name}" dari daftar aplikasi manual? File aslinya tidak dihapus.`, 'Hapus'))) return;
        await invoke('apps_remove_custom', { name });
        appsView = await invoke('apps_get');
        renderAppPicker();
      };
      row.appendChild(del);
    }
    list.appendChild(row);
  });
  if (matches.length === 0) list.innerHTML = '<div class="hint">Tidak ada yang cocok, atau daftar belum tersedia.</div>';
  const when = appsView.scanned_at
    ? new Date(appsView.scanned_at * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';
  const nCustom = (appsView.custom || []).length;
  el('appMeta').textContent = `${appsView.names.length} aplikasi${nCustom ? ` (${nCustom} manual)` : ''} · dipindai ${when}`;
  el('appTtl').value = String(appsView.ttl_days);
}

export async function openAppPicker(force = false) {
  el('appSearch').value = '';
  await ensureAppList(force);
  renderAppPicker();
}

export function initAppPicker() {
  el('appSearch').oninput = renderAppPicker;
  el('btnAddExe').onclick = async () => {
    try {
      const picked = await invoke('apps_pick_exe');
      if (!picked) return;
      const name = await showPromptModal('Tambah aplikasi', 'Nama tampilan (maks. 47 byte, ini yang disimpan di device):', clipUtf8(picked.name));
      if (name === null) return;
      const clean = clipUtf8(name.trim());
      if (!clean) return;
      await invoke('apps_add_custom', { name: clean, path: picked.path });
      appsView = await invoke('apps_get');
      el('editValue').value = clean;
      renderAppPicker();
      log(`[APP] Ditambahkan: ${clean} → ${picked.path}`, 'ok');
    } catch (e) { log('[ERROR] Gagal menambah aplikasi: ' + e, 'err'); }
  };
  el('btnRescanApps').onclick = () => openAppPicker(true);
  el('appTtl').onchange = () => invoke('apps_set_ttl', { days: parseInt(el('appTtl').value) });
}