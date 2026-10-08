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
import { t } from './i18n.js';

let appsView = { names: [], custom: [], scanned_at: 0, ttl_days: 7, consent: false, stale: true };
// Sudah menolak consent di sesi ini: jangan tanya lagi tiap picker dibuka.
let scanDeclined = false;

export async function ensureAppList(force = false) {
  try {
    appsView = await invoke('apps_get');
    if (!appsView.consent) {
      if (scanDeclined) return false;
      const ok = await showConfirmModal(
        t('appPicker.scanTitle'),
        t('appPicker.scanMsg'),
        t('appPicker.scanConfirm')
      );
      if (!ok) { scanDeclined = true; return false; }
      await invoke('apps_set_consent', { value: true });
    }
    if (force || appsView.stale) {
      el('appMeta').textContent = t('appPicker.scanning');
      appsView = await invoke('apps_rescan');
      log(t('appPicker.foundLog', { n: appsView.names.length }), 'ok');
    }
    return true;
  } catch (e) {
    log(t('appPicker.loadErrorLog', { err: e }), 'err');
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
      del.title = t('appPicker.removeTitleAttr');
      del.onclick = async () => {
        if (!(await showConfirmModal(t('appPicker.removeTitle'), t('appPicker.removeMsg', { name }), t('adaptive.deleteConfirm')))) return;
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
      const name = await showPromptModal(t('appPicker.addTitle'), t('appPicker.addLabel'), clipUtf8(picked.name));
      if (name === null) return;
      const clean = clipUtf8(name.trim());
      if (!clean) return;
      await invoke('apps_add_custom', { name: clean, path: picked.path });
      appsView = await invoke('apps_get');
      el('editValue').value = clean;
      renderAppPicker();
      log(t('appPicker.addedLog', { name: clean, path: picked.path }), 'ok');
    } catch (e) { log(t('appPicker.addErrorLog', { err: e }), 'err'); }
  };
  el('btnRescanApps').onclick = () => openAppPicker(true);
  el('appTtl').onchange = () => invoke('apps_set_ttl', { days: parseInt(el('appTtl').value) });
}