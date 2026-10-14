// ==================== ADAPTIVE KEY BIND ====================
//
// Seluruh fitur "App Preset" dipindah ke sini dari main.js: manajemen preset
// (buat, ubah nama, hapus, aktif/nonaktif, editor) dan runtime auto-switch
// (polling window foreground, cache slot di firmware, dan perpindahan otomatis).
//
// Batas tanggung jawab:
//  - Preset disimpan sebagai daftar layer lengkap (bukan preset = shortcut ke
//    layer yang sudah ada), jadi satu preset harus bisa diputar ulang ke device.
//  - Runtime memakai cache slot firmware: preset di-upload SEKALI lewat batch
//    SLOT:<n>:NEW, dan setiap pergantian berikutnya cukup satu perintah SLOT:<n>:USE.
//    Tanpa cache itu, tiap alt+tab menulis ulang seluruh keymap lewat serial.
//
// Modul ini tidak memanggil fungsi main.js secara langsung - semuanya lewat
// initAdaptive() di bawah. Yang dibutuhkan dari luar cuma: navigasi halaman,
// modal, notifikasi, dan flag "belum disimpan".

import { invoke } from '@tauri-apps/api/core';
import {
  ROWS, COLS, NUM_ENCODERS, TYPE_NAMES,
  mapping, encConfig, layerNames, layerCount, currentLayer,
  setCurrentLayer, reorderLayer,
} from './device-state.js';
import { el, log, escapeHtml } from './dom.js';
import { sendLine, sendBatch, isConnected, dumpInProgress } from './transport.js';
import { t } from './i18n.js';

// ---- State ----
export let presetsData = { masterEnabled: true, presets: [] };
export let editingPresetId = null;
let currentActivePresetId = null;

// Layer terakhir yang sedang dibuka untuk setiap preset.
//
// Dipakai supaya membuka ulang preset kembali ke layer yang sama, bukan selalu
// layer 0. Scope-nya SESI KONEKSI, bukan aplikasi: peta ini dikosongkan di
// resetAdaptiveRuntimeState() yang dipanggil tiap koneksi putus. Alasannya -
// isi RAM device ikut hilang saat koneksi putus (lihat catatan clearDirty di
// serial-transport.js), jadi device sedang tidak menampilkan preset mana pun.
// Mengambil "terakhir dibuka" dari sesi yang lalu akan membuka layer yang
// isinya sudah tidak ada di device.
let lastLayerByPreset = new Map();   // presetId -> layer

// Catat layer aktif untuk preset yang sedang diedit.
//
// Dipanggil SEBELUM editingPresetId ditimpa, sehingga perpindahan langsung dari
// preset A ke preset B (tanpa lewat Selesai/Batal) juga ikut tercatat. Kalau
// hanya dicatat di exitPresetEditor(), layer terakhir preset A akan hilang
// setiap kali user langsung melompat ke preset lain.
function noteCurrentLayerForEditingPreset() {
  if (editingPresetId) lastLayerByPreset.set(editingPresetId, currentLayer);
}
let focusedExeLast = null;
let pendingFocusSince = 0;
let escapeFrozenForExe = null;
let autoSwitchBusy = false;
let bindableAppsCache = null;
// Flag untuk menahan polling selama device sedang beralih konteks
// (CONTEXT:DEFAULT / SLOT:USE). Ini seperti autoSwitchBusy tapi lebih spesifik:
// polling tidak boleh mengirim perintah baru sampai device selesai memproses
// konteks yang sedang berjalan. Tanpa ini, app bisa mengirim DUMP:0 sebelum
// device selesai CONTEXT:DEFAULT, menyebabkan response tumpang tindih.
let contextSwitchPending = false;

// Default harus dikirim tepat setelah connect (lihat resetAdaptiveRuntimeState).
// Polling auto-switchMENUNGGU flag ini turun, supaya tidak ada dua aliran
// perintah yang tumpang tindih di device tepat setelah connect.
let switchPendingOnConnect = false;

const FOCUS_DEBOUNCE_MS = 150;
const FOCUS_POLL_MS = 120;
// Jeda minimal antar dua perpindahan preset.
//
// Upload preset itu mahal: ratusan perintah SET yang harus device proses satu
// per satu, dan switch berikutnya tidak boleh menumpuk di belakang yang
// sedang jalan. Tanpa jeda ini, companion app (yang sedang difokuskan) memicu
// "Back to Default" dan target memicu switch balik - menghasilkan bolak-balik
// tanpa henti yang membanjiri antrean device.
// Jeda minimal antar dua perpindahan preset.
//
// Upload preset itu mahal: ratusan perintah SET yang harus device proses satu
// per satu, dan switch berikutnya tidak boleh menumpuk di belakang yang
// sedang jalan. Tanpa jeda ini, companion app (yang sedang difokuskan) memicu
// "Back to Default" dan target memicu switch balik - menghasilkan bolak-balik
// tanpa henti yang membanjiri antrean device.
//
// 2,5 detik ternyata BELUM cukup. activatePresetRuntime() untuk preset besar
// (8 layer) butuh jauh lebih lama, dan selama itu device masih sibuk. Switch
// yang masuk di tengah-tengahnya membuat device never selesai, dan frame DUMP
// yang sedang berjalan tidak pernah tertutup - pesan "DUMP never closed".
//
// Jeda ini diukur dari waktu switch DIMULAI, bukan dari switch selesai, jadi
// switch yang sah tetap terjadi - hanya tidak menumpuk.
const SWITCH_COOLDOWN_MS = 4000;
let lastSwitchAt = 0;

const APP_SLOTS = 6;                        // harus sama dengan APP_SLOTS di firmware
let slotTable = Array(APP_SLOTS).fill(null); // {id, sig, used}
let slotTick = 0;
// Sembunyikan balasan [OK]/[LAYER] selama batch runtime supaya panel log tidak
// penuh dengan konfirmasi yang tidak berguna.
let quietOkUntil = 0;

// Dipanggil handleLine di main.js: selama upload batch, device membalas banyak
// baris [OK] yang tidak perlu ditampilkan.
export function suppressDeviceEcho() { return Date.now() < quietOkUntil; }

// Definisi markBatchSettling ada di upload-state.js - modul itu sengaja
// dipisah dari adaptive.js supaya backend BLE bisa memakainya tanpa mengimpor
// modul ini (adaptive -> transport <- BLE transport = siklus import).
import { markBatchSettling } from './upload-state.js';

// Dipanggil handleLine untuk notifikasi [LAYER] yang harus menyebut nama preset.
export function activePresetName() {
  const p = currentActivePresetId ? presetsData.presets.find(x => x.id === currentActivePresetId) : null;
  return p ? p.name : null;
}
export function activePresetLayers() {
  const p = currentActivePresetId ? presetsData.presets.find(x => x.id === currentActivePresetId) : null;
  return p ? (p.layers || []) : null;
}

// ---- Hook ke main.js ----
let hooks = {
  switchPage: () => { },
  showConfirmModal: async () => false,
  showPromptModal: async () => null,
  showModalBase: async () => null,
  notify: () => { },
  resetEditorState: () => { },
  isDirty: () => false,
  setDirty: () => { },
  // Dipasang main.js. adaptive TIDAK mengimpor home-page.js: aturan proyeknya
  // modul ini tidak boleh memanggil fungsi halaman secara langsung, supaya arah
  // ketergantungan tetap satu arah dan tidak muncul siklus import.
  loadLayer: async () => { },
  // Loading screen untuk upload preset per-layer. Dipasang main.js.
  showPresetUploadProgress: () => { },
  hidePresetUploadProgress: () => { },
};
export function initAdaptive(h) { hooks = Object.assign({}, hooks, h); }

// ---- Jeda setelah user pindah layer dari device ----
//
// Long-press knob di device mengirim EVT:LAYER:. Tanpa jeda, preset Adaptive
// yang sedang aktif bisa langsung memaksa balik ke layer 0 dalam hitungan
// polling (~120 ms), sehingga pilihan layer user hilang tanpa sebab.
//
// Yang ditunda HANYA perpindahan otomatis. Klik tab di app bukan termasuk -
// user sudah menyatakannya sendiri, dan menundanya akan terasa seperti
// aplikasi tidak responsif.
const LAYER_CHOICE_HOLD_MS = 1500;

// Waktu EVT:LAYER: terakhir, disuntik oleh protocol-parser.js. Lihat catatan
// import di atas soal kenapa bukan di-import langsung.
let lastDeviceLayerEventAt = 0;
// Dipakai protocol-parser.js setiap kali device melaporkan perpindahan layer.
export function noteDeviceLayerEvent() { lastDeviceLayerEventAt = Date.now(); }
export function resetLayerChoiceHold() { lastDeviceLayerEventAt = 0; }

function autoSwitchBlockedByLayerChoice() {
  // 0 = belum pernah ada event, jadi bukan tundaan yang masih aktif.
  if (lastDeviceLayerEventAt === 0) return false;
  if (Date.now() - lastDeviceLayerEventAt < LAYER_CHOICE_HOLD_MS) return true;
  // Dump yang sedang berjalan: preset memuat ulang seluruh layer dan memanggil
  // DUMP untuk masing-masing. Menjalankan auto-switch di tengah itu akan
  // menyisipkan perintah baru ke stream dump yang sedang dibaca, dan DUMP_END
  // bisa resolve waiter yang salah. Tunggu saja - dump ini hampir selalu
  // selesai dalam hitungan milidetik.
  return dumpInProgress();
}

// ---- Waiter DUMP ----
// Dipetakan per layer, bukan satu slot global: dengan satu slot, dump latar
// belakang (mis. dari EVT:LAYER:) yang selesai lebih dulu akan me-resolve waiter
// packer, sehingga packCurrentAsPresetLayers() membaca mapping yang belum terisi
// penuh dan menyimpan preset setengah jadi ke disk.
//
// Tiap layer boleh punya BANYAK waiter (Set, bukan satu entri): kalau hanya satu
// entri per layer, waiter kedua akan menggantikan yang pertama tanpa
// me-resolve-nya, sehingga pemanggil pertama menggantung selamanya.
// Tiap waiter juga punya timeout supaya tidak menggantung kalau device menjawab
// [ERROR] alih-alih DUMP_END (mis. layerCount UI basi setelah RESET di luar app).
const dumpWaiters = new Map();   // layer -> Set<{resolve, timer}>

// Diekspor supaya home-page.js bisa memakainya di jalur muat layer.
//
// Kenapa diekspor, bukan sebaliknya? Arahnya satu: home-page -> adaptive.
// Adaptive tidak pernah mengimpor home-page (ia memakai hooks), jadi tidak
// muncul siklus import - import-cycle-check.mjs yang menjaganya.
//
// Tanpa waiter ini, jalur muat layer cuma "kirim DAN LUPA": kalau DUMP_END
// hilang di tengah jalan, mapping[layer] sudah dikosongkan di protocol-parser.js
// (emptyLayer) lalu hanya terisi sebagian baris yang sempat sampai. Tidak ada
// apa pun yang memintanya ulang, jadi grid menampilkan keymap setengah jadi
// sampai user menekan Refresh. Waiter inilah yang membuat alurnya menutup diri
// sendiri.
export function waitForDump(layer, timeoutMs) {
  const key = (layer === undefined || layer === null || Number.isNaN(layer)) ? currentLayer : layer;
  return new Promise((resolve) => {
    const entry = { resolve: null, timer: null };
    entry.resolve = (okFlag) => {
      if (entry.timer) clearTimeout(entry.timer);
      const set = dumpWaiters.get(key);
      if (set) { set.delete(entry); if (!set.size) dumpWaiters.delete(key); }
      resolve(okFlag);
    };
    entry.timer = setTimeout(() => {
      log(t('adaptive.timeoutLog', { key }), 'err');
      entry.resolve(false);
    }, timeoutMs || 3000);
    if (!dumpWaiters.has(key)) dumpWaiters.set(key, new Set());
    dumpWaiters.get(key).add(entry);
  });
}

// Dipanggil handleLine saat DUMP_END. Layer NaN berarti device tidak menyebut
// nomor layer, jadi pakai layer yang sedang aktif.
export function resolveDumpWaiters(layer) {
  const done = (layer === undefined || layer === null || Number.isNaN(layer)) ? currentLayer : layer;
  const set = dumpWaiters.get(done);
  if (set) [...set].forEach(e => e.resolve(true));
}

async function fetchAllLayersForPacking() {
  for (let l = 0; l < layerCount; l++) {
    // Tidak mengirim LAYER: dan tidak perlu jeda. DUMP:<n> membaca layer n tanpa
    // memindahkan layer aktif device, jadi layer yang sedang dipakai user tidak
    // ikut berubah. Timeout mencegah menggantung jika device tidak menjawab.
    const waiter = waitForDump(l, 3000);
    await sendLine('DUMP:' + l);
    await waiter;
  }
}

function packCurrentAsPresetLayers() {
  const layers = [];
  for (let l = 0; l < layerCount; l++) {
    const keys = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const d = (mapping[l] && mapping[l][r] && mapping[l][r][c]) || { type: 0, value: '' };
        row.push({ type: d.type, value: d.value || '' });
      }
      keys.push(row);
    }
    const encCw = [], encCcw = [], encBtn = [];
    for (let i = 0; i < NUM_ENCODERS; i++) {
      const e = encConfig[i] || {};
      encCw.push(e.CW ? { type: e.CW.type, value: e.CW.value } : { type: 0, value: '' });
      encCcw.push(e.CCW ? { type: e.CCW.type, value: e.CCW.value } : { type: 0, value: '' });
      encBtn.push(e.BTN ? { type: e.BTN.type, value: e.BTN.value } : { type: 0, value: '' });
    }
    layers.push({ name: layerNames[l] || t('layer.n', { n: l }), keys, encCw, encCcw, encBtn });
  }
  return layers;
}

// ---- Daftar & edit preset ----
function presetColor(seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 55%, 42%)`;
}

export async function loadPresets() {
  try { presetsData = await invoke('presets_get'); }
  catch (e) { log(t('adaptive.loadErrorLog', { err: e }), 'err'); presetsData = { masterEnabled: true, presets: [] }; }
  el('masterEnabledToggle').checked = presetsData.masterEnabled;
  renderPresetList();
}

export function renderPresetList() {
  const box = el('presetList');
  box.innerHTML = '';
  if (presetsData.presets.length === 0) {
    box.innerHTML = '<div class="hint">' + t('adaptive.emptyList') + '</div>';
    return;
  }
  presetsData.presets.forEach(preset => {
    const initial = (preset.name || '?').trim().charAt(0).toUpperCase() || '?';
    const row = document.createElement('div');
    row.className = 'preset-row';
    row.innerHTML = `
      <div class="preset-avatar" style="background:${presetColor(preset.name || preset.id)}">${escapeHtml(initial)}</div>
      <div class="preset-info">
        <div class="preset-name">${escapeHtml(preset.name)}</div>
        <div class="preset-app">${escapeHtml(preset.exeName)}</div>
      </div>
      <div class="preset-actions">
        <label class="toggle-switch"><input type="checkbox" class="preset-toggle-input" ${preset.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
        <button class="small preset-rename" title="${t('adaptive.renameTitle')}" aria-label="${t('adaptive.renameTitle')}">✎</button>
        <button class="small preset-delete" title="${t('adaptive.deleteTitle')}" aria-label="${t('adaptive.deleteTitle')}">✕</button>
      </div>`;
    row.querySelector('.preset-info').onclick = () => openPresetEditor(preset.id);
    row.querySelector('.preset-avatar').onclick = () => openPresetEditor(preset.id);
    row.querySelector('.preset-toggle-input').onchange = (e) => togglePresetEnabled(preset.id, e.target.checked, e.target);
    row.querySelector('.preset-rename').onclick = () => renamePreset(preset.id);
    row.querySelector('.preset-delete').onclick = () => deletePreset(preset.id);
    box.appendChild(row);
  });
}

async function togglePresetEnabled(id, checked, checkboxEl) {
  const preset = presetsData.presets.find(p => p.id === id);
  if (!preset) return;
  if (checked) {
    // Hanya satu preset aktif per aplikasi: kalau dua aktif untuk exe yang sama,
    // poll foreground akan menentukan yang menang dan yang lain diam-diam tidak
    // pernah dipakai. Minta konfirmasi alih-alih menimpa tanpa pemberitahuan.
    const conflict = presetsData.presets.find(p => p.id !== id && p.enabled && p.exeName === preset.exeName);
    if (conflict) {
      const ok = await hooks.showConfirmModal(t('adaptive.switchTitle'),
        t('adaptive.switchMsg', { conflict: conflict.name, preset: preset.name }), t('adaptive.switchConfirm'));
      if (!ok) { checkboxEl.checked = false; return; }
      conflict.enabled = false;
    }
  }
  preset.enabled = checked;
  await invoke('presets_save', { data: presetsData });

  if (!checked && currentActivePresetId === id && isConnected() && !editingPresetId) {
    await sendLine('CONTEXT:DEFAULT');
    currentActivePresetId = null;
    updateActivePresetLabel();
    log(t('adaptive.presetDisabledLog'), null);
  }

  renderPresetList();
}

async function renamePreset(id) {
  const preset = presetsData.presets.find(p => p.id === id);
  if (!preset) return;
  const name = await hooks.showPromptModal(t('adaptive.renameTitle'), t('adaptive.nameLabel'), preset.name);
  if (name === null || !name.trim()) return;
  preset.name = name.trim();
  await invoke('presets_save', { data: presetsData });
  renderPresetList();
}

async function deletePreset(id) {
  const preset = presetsData.presets.find(p => p.id === id);

  if (currentActivePresetId === id && isConnected() && !editingPresetId) {
    await sendLine('CONTEXT:DEFAULT');
    currentActivePresetId = null;
    updateActivePresetLabel();
  }

  if (!preset) return;
  if (!(await hooks.showConfirmModal(t('adaptive.deleteTitle'), t('adaptive.deleteMsg', { name: preset.name }), t('adaptive.deleteConfirm')))) return;
  presetsData.presets = presetsData.presets.filter(p => p.id !== id);
  await invoke('presets_save', { data: presetsData });
  renderPresetList();
}

// ---- Picker aplikasi khusus binding preset (Rust: scan_bindable_apps) ----
async function getBindableApps(force) {
  if (bindableAppsCache && !force) return bindableAppsCache;
  bindableAppsCache = await invoke('scan_bindable_apps');
  return bindableAppsCache;
}

function pickBindableApp() {
  // Executor Promise TIDAK boleh async: kalau pemanggilnya menolak (scan
  // gagal), rejection-nya jadi unhandled DAN promise ini tidak pernah selesai,
  // sehingga modal menggantung selamanya tanpa jalan keluar. Lazy-load async-nya
  // di dalam .then, dengan try/catch yang selalu menutup modal.
  return new Promise((resolve) => {
    const overlay = el('modalOverlay');
    el('modalTitle').textContent = t('adaptive.pickApp');
    el('modalBody').innerHTML = `
      <input type="text" id="bindAppSearch" placeholder="${t('adaptive.searchApps')}" style="width:100%; margin-bottom:8px;">
      <div class="app-list" id="bindAppList" style="max-height:240px;"></div>
      <button class="small" id="btnBindAppBrowse" style="margin-top:8px;">${t('adaptive.browseExe')}</button>`;
    el('modalActions').innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('modal.cancel');
    cancelBtn.onclick = () => close(null);
    el('modalActions').appendChild(cancelBtn);

    function close(value) { overlay.classList.remove('show'); document.removeEventListener('keydown', onKey); resolve(value); }
    // preventDefault wajib, bukan hanya demi Enter: home-page.js memakai
    // e.defaultPrevented sebagai sinyal "sudah ada yang menangani Escape".
    // Tanpa ini satu tekan Escape menutup modal ini DAN membatalkan editor
    // rekaman yang sedang berjalan - dua perubahan dari satu penekanan.
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }
    document.addEventListener('keydown', onKey);

    el('bindAppList').innerHTML = '<div class="hint">' + t('adaptive.scanning') + '</div>';
    overlay.classList.add('show');

    getBindableApps().then(apps => {
      // Sambil menunggu, user bisa saja menutup modal (Cancel/Escape).
      // Kalau begitu jangan pasang handler ke DOM yang sudah tidak terlihat.
      if (!overlay.classList.contains('show')) { document.removeEventListener('keydown', onKey); return; }

    function renderList(filter) {
      const q = (filter || '').toLowerCase();
      const listEl = el('bindAppList');
      listEl.innerHTML = '';
      const matches = apps.filter(a => a.name.toLowerCase().includes(q)).slice(0, 80);
      if (matches.length === 0) { listEl.innerHTML = '<div class="hint">' + t('adaptive.noMatch') + '</div>'; return; }
      matches.forEach(a => {
        const b = document.createElement('button');
        b.className = 'app-item';
        b.textContent = a.name;
        b.onclick = () => close({ name: a.name, exeName: a.exeName });
        listEl.appendChild(b);
      });
    }
    renderList('');
    el('bindAppSearch').oninput = (e) => renderList(e.target.value);
    el('btnBindAppBrowse').onclick = async () => {
      try {
        const picked = await invoke('apps_pick_exe');
        if (picked) close({ name: picked.name, exeName: picked.path.split(/[\\/]/).pop() });
      } catch (e) { }
    };
    }).catch(e => {
      // Scan gagal: tutup modal, jangan andalkan user menekan Cancel.
      // Promise yang dibiarkan menggantung akan membekukan alur preset.
      log(t('adaptive.pickApp') + ': ' + (e && e.message ? e.message : e), 'err');
      document.getElementById('modalOverlay')?.classList.remove('show');
      document.removeEventListener('keydown', onKey);
      resolve(null);
    });
  });
}

// ---- Masuk/keluar mode edit preset (reuse Home sepenuhnya) ----
export async function openPresetEditor(id) {
  if (!isConnected()) { log(t('adaptive.needConnectLog'), 'err'); return; }
  const preset = presetsData.presets.find(p => p.id === id);
  if (!preset) return;
  noteCurrentLayerForEditingPreset();
  editingPresetId = id;
  // Sedang DIEDIT, bukan lagi "auto-matched" - kalau tidak, label dan poll loop
  // akan menganggap preset ini masih aktif karena exe-nya lagi difokuskan.
  currentActivePresetId = null;
  updateActivePresetLabel();
  el('presetEditName').textContent = preset.name;
  el('presetEditBanner').style.display = 'flex';
  el('btnSave').style.display = 'none'; // SAVE (flash) tidak relevan selagi edit App Preset

  hooks.switchPage('home', 'adaptive'); // tampilkan Home, tapi highlight sidebar tetap di Adaptive

  await sendLine('CONTEXT:APP:NEW');
  await replayPresetLayers(preset);

  // Layer tujuan: terakhir dibuka untuk preset ini di sesi koneksi ini, atau 0
  // kalau preset ini baru pertama kali dibuka. Dijepit ke rentang layer milik
  // preset - preset bisa punya lebih sedikit layer daripada yang tercatat,
  // misalnya setelah diedit dan sebagian layer dihapus. Tanpa jepit ini device
  // akan Staying di layer yang tidak ada dan grid tampil kosong.
  const maxLayer = Math.max(0, (preset.layers?.length || 1) - 1);
  const wanted = lastLayerByPreset.get(id);
  const targetLayer = (wanted === undefined) ? 0 : Math.min(Math.max(0, wanted), maxLayer);

  await sendLine('LAYER:' + targetLayer);
  await sendLine('INFO');
  await sendLine('DUMPENC');
}

export async function exitPresetEditor() {
  noteCurrentLayerForEditingPreset();
  editingPresetId = null;
  el('presetEditBanner').style.display = 'none';
  el('btnSave').style.display = '';
  hooks.resetEditorState();
  await sendLine('CONTEXT:DEFAULT');
  await sendLine('INFO');
  await sendLine('DUMPENC');
  hooks.switchPage('adaptive');
  renderPresetList();

  updateActivePresetLabel();
}

export async function confirmLeavePresetEditor() {
  if (!hooks.isDirty()) { await exitPresetEditor(); return; }
  const choice = await hooks.showModalBase(
    t('adaptive.unsavedTitle'),
    t('adaptive.unsavedMsg'),
    [
      { label: t('modal.cancel'), value: 'cancel' },
      { label: t('modal.dontSave'), value: 'discard' },
      { label: t('modal.save'), value: 'save', primary: true }
    ]
  );
  if (choice === 'save') {
    const preset = presetsData.presets.find(p => p.id === editingPresetId);
    if (preset) {
      await fetchAllLayersForPacking();
      preset.layers = packCurrentAsPresetLayers();
      await invoke('presets_save', { data: presetsData });
      log(t('adaptive.presetSavedSimpleLog', { name: preset.name }), 'ok');
    }
    hooks.setDirty(false);
    await exitPresetEditor();
  } else if (choice === 'discard') {
    hooks.setDirty(false);
    await exitPresetEditor();
  }
  // 'cancel'/Escape: tidak melakukan apa pun, tetap di editor
}

export function updateActivePresetLabel() {
  const label = el('deviceActivePresetLabel');
  if (!label) return;
  label.textContent = currentActivePresetId ? (activePresetName() || t('adaptive.appPreset')) : t('common.default');
}

// ---- Runtime: unggah preset ke slot firmware ----
// Replay layer demi layer - dipakai SAMA baik saat edit (openPresetEditor) maupun
// runtime auto-switch, biar tidak ada dua jalur yang bisa berbeda.
async function replayPresetLayers(preset) {
  for (let li = 0; li < preset.layers.length; li++) {
    if (li > 0) await sendLine('ADDLAYER');
    const layer = preset.layers[li];
    await sendLine(`RENAMELAYER:${li}:${layer.name}`);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const k = layer.keys?.[r]?.[c];
      if (k && k.type !== 0) await sendLine(`SET:${li}:${r}:${c}:${TYPE_NAMES[k.type]}:${k.value}`);
    }
    for (let i = 0; i < NUM_ENCODERS; i++) {
      const cw = layer.encCw?.[i], ccw = layer.encCcw?.[i], btn = layer.encBtn?.[i];
      if (cw && cw.type) await sendLine(`SETENC:${i}:CW:${TYPE_NAMES[cw.type]}:${cw.value}`);
      if (ccw && ccw.type) await sendLine(`SETENC:${i}:CCW:${TYPE_NAMES[ccw.type]}:${ccw.value}`);
      if (btn && btn.type) await sendLine(`SETENC:${i}:BTN:${TYPE_NAMES[btn.type]}:${btn.value}`);
    }
  }
}

// Versi batch dari hal yang sama: banyak baris dalam sedikit write, karena
// Set<encoder> untuk 3x3 key x beberapa layer bisa ratusan baris.
//
// DIPERBARUI: preset di-upload PER LAYER, bukan semua sekaligus. Setiap layer
// adalah batch kecil (~3000 byte untuk 3x3). Ini mendekati ukuran MTU BLE
// dan mengurangi kemungkinan watchdog tembak / parser error yang mengaruhi.
const presetSig = p => JSON.stringify([p.layers, NUM_ENCODERS]);

// buildPresetLines: membangun seluruh baris preset ke dalam satu array.
// PERINGATAN DEPRECATED: fungsi ini menghasilkan batch yang sangat besar
// untuk preset dengan banyak layer, meningkatkan risiko error BLE.
// Gunakan buildPresetLayerLines() untuk setiap layer.
// Tetap ada untuk kompatibilitas test audit "no-lost-functions".
function buildPresetLines(preset, slot) {
  const lines = [];
  for (let li = 0; li < preset.layers.length; li++) {
    lines.push(...buildPresetLayerLines(preset, li, slot));
  }
  return lines;
}

function buildPresetLayerLines(preset, li, slot) {
  // Layer pertama memakai SLOT:<n>:NEW, layer berikutnya memakai ADDLAYER.
  const L = li === 0 ? [`SLOT:${slot}:NEW`] : [`ADDLAYER`];
  const layer = preset.layers[li];
  L.push(`RENAMELAYER:${li}:${layer.name}`);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const k = layer.keys?.[r]?.[c];
    if (k && k.type !== 0) L.push(`SET:${li}:${r}:${c}:${TYPE_NAMES[k.type]}:${k.value}`);
  }
  for (let i = 0; i < NUM_ENCODERS; i++) {
    for (const [key, name] of [['encCw', 'CW'], ['encCcw', 'CCW'], ['encBtn', 'BTN']]) {
      const a = layer[key]?.[i];
      if (a && a.type) L.push(`SETENC:${i}:${name}:${TYPE_NAMES[a.type]}:${a.value}`);
    }
  }
  return L;
}

async function activatePresetRuntime(preset, exe) {
  const sig = presetSig(preset);
  let slot = slotTable.findIndex(s => s && s.id === preset.id);
  const cached = slot >= 0 && slotTable[slot].sig === sig;
  log(t('adaptive.presetActivateLog', {
    name: preset.name, exe, cache: cached ? t('adaptive.cache') : '', cachedSlot: slot,
  }), 'ok');
  if (slot < 0) {
    // Slot kosong dulu; kalau semuanya penuh, buang yang paling lama dipakai.
    slot = 0; let best = Infinity;
    slotTable.forEach((s, i) => { const u = s ? s.used : -1; if (u < best) { best = u; slot = i; } });
  }
  quietOkUntil = Date.now() + 500;
  // Simpan state lama untuk restore bila gagal.
  const savedSlot = slotTable[slot];
  // Anggap slot tidak valid sampai semua layer berhasil di-upload.
  // Kalau gagal di tengah (kabel dicabut), device punya keymap setengah jadi
  // sementara tabel app mengira slot itu utuh - berikutnaya SLOT:<n>:USE akan
  // mengaktifkan konten rusak.
  slotTable[slot] = null;
  try {
    if (cached) {
      // Preset sudah pernah di-upload ke slot ini dan signature-nya masih sama:
      // cukup kirim SLOT:<n>:USE (satu baris).
      await sendBatch([`SLOT:${slot}:USE`, 'LAYER:0', 'INFO', 'DUMPENC']);
      markBatchSettling(4000);
    } else {
      // Upload per layer. Setiap layer adalah batch kecil (~3000 byte), jauh
      // di bawah MTU BLE dan cukup kecil untuk device memprosesnya dalam
      // hitungan ratusan milidetik — mengurangi kemungkinan watchdog temak
      // dan parser error yang menganggu.
      hooks.showPresetUploadProgress?.(preset.name, 0, preset.layers.length);
      for (let li = 0; li < preset.layers.length; li++) {
        const layerLines = buildPresetLayerLines(preset, li, slot);
        await sendBatch(layerLines);
        // Beri jeda singkat agar firmware sempat memproses perintah ini sebelum
        // layer berikutnya dikirim. Jeda ini jauh lebih pendek dari
        // markBatchSettling(4000) — device hanya perlu menulis ke memory,
        // bukan menunggu response DUMP.
        await new Promise(r => setTimeout(r, 200));
        hooks.showPresetUploadProgress?.(preset.name, li + 1, preset.layers.length);
      }
      hooks.hidePresetUploadProgress?.();
      // Setelah semua layer ter-upload, baru kirim INFO + DUMPENC untuk
      // trigger refresh layer di parser.
      await sendBatch(['LAYER:0', 'INFO', 'DUMPENC']);
      markBatchSettling(6000);
    }
    // Reset currentLayer di app state ke layer 0 karena kita mengirim LAYER:0
    // ke device di atas. Tanpa ini, loadActiveLayerDump() akan memakai nilai
    // currentLayer lama (dari app sebelumnya) yang mungkin berbeda.
    setCurrentLayer(0);
    slotTable[slot] = { id: preset.id, sig, used: ++slotTick };
    currentActivePresetId = preset.id;
    updateActivePresetLabel();
    log(t('adaptive.presetActiveLog', { name: preset.name, exe, cache: cached ? t('adaptive.cache') : '' }), 'ok');
    hooks.notify(t('adaptive.presetNotif', { name: preset.name }), 'preset');
    // Minta ulang isi layer yang sekarang aktif. Ini yang membuat grid ikut
    // berubah saat preset berganti - tanpa itu, app menampilkan keymap preset
    // sebelumnya sampai user menekan Refresh secara manual.
    await loadActiveLayerDump();
    markBatchSettling(6000);
  } catch (e) {
    // Restore slot state: jika upload gagal, slot lama mungkin masih valid.
    slotTable[slot] = savedSlot;
    hooks.hidePresetUploadProgress?.();
    log(t('adaptive.presetUploadError', { name: preset.name, err: String(e) }), 'err');
    hooks.notify(t('adaptive.presetUploadErrorNotif', { name: preset.name }), 'error');
  }
}

// Minta dump layer aktif dari device supaya grid ikut berubah saat preset
// berganti.
//
// Dipisah dari activatePresetRuntime karena harus dikirim SETELAH batch upload
// selesai, bukan di baris yang sama. Kalau dikirim bersamaan, DUMP:0 masuk ke
// antrean device di belakang ratusan perintah SET dan jawabannya tertahan lama
// - dan kalau ada frame lain yang sedang berjalan, parser menundanya.
async function loadActiveLayerDump() {
  await hooks.loadLayer(currentLayer);
}

let pollInFlight = false;
async function pollFocusedApp() {
  if (pollInFlight) return;
  if (!presetsData.masterEnabled || !isConnected() || editingPresetId || autoSwitchBusy || contextSwitchPending) return;
  pollInFlight = true;
  try {
    // Default setelah connect. Dikirim di sini, bukan di dalam blok exe di
    // bawah, karena harus terjadi SEKALI irrespective of window mana yang
    // kebetulan sedang fokus - termasuk kalau window itu companion app
    // sendiri (exe null) yang akan langsung return.
    if (switchPendingOnConnect) {
      switchPendingOnConnect = false;
      contextSwitchPending = true;
      quietOkUntil = Date.now() + 500;
      await sendBatch(['CONTEXT:DEFAULT', 'LAYER:0', 'INFO']);
      setCurrentLayer(0);
      updateActivePresetLabel();
      log(t('adaptive.backDefaultLog'), null);
      hooks.notify(t('adaptive.defaultNotif'), 'preset');
      setTimeout(() => { contextSwitchPending = false; }, 2500);
      return;
    }

    let exe;
    try { exe = await invoke('get_foreground_exe'); } catch (e) { return; }
    // exe null = window yang aktif adalah companion app sendiri (Rust
    // menyaringnya lewat PID), atau tidak ada window foreground sama sekali.
    //
    // Ini BUKAN "user pindah ke aplikasi tanpa preset". Companion app tidak
    // punya preset, jadi kalau null diperlakukan sebagai "tidak ada yang
    // cocok", setiap alt+tab ke app untuk melihat grid akan memaksa preset
    // balik ke Default - dan alt+tab balik ke aplikasi target mengaktifkannya
    // lagi. Log user menunjukkan pola bolak-balik persis itu.
    //
    // Yang benar: tidak ada perubahan. Preset yang aktif TETAP aktif selama
    // user berada di companion app.
    if (!exe) return;

    if (exe !== focusedExeLast) {
      focusedExeLast = exe;
      pendingFocusSince = Date.now();
      if (escapeFrozenForExe && escapeFrozenForExe !== exe) escapeFrozenForExe = null;
      return; // debounce: window harus stabil dulu (alt+tab cepat melewati app perantara tidak dihitung)
    }
    if (Date.now() - pendingFocusSince < FOCUS_DEBOUNCE_MS) return;
    if (escapeFrozenForExe === exe) return;
    // User baru saja memilih layer dari device (knob) atau ada dump yang
    // sedang berjalan. Pemindahan otomatis menunggu - poll 1.2 detik
    // berikutnya akan mencoba lagi tanpa intervene apa pun.
    if (autoSwitchBlockedByLayerChoice()) return;

    const matched = presetsData.presets.find(p => p.enabled && p.exeName === exe);
    const targetId = matched ? matched.id : null;
    if (targetId === currentActivePresetId) return;
    // Cooldown setelah switch. Tanpa ini, companion app sendiri yang sedang
    // difokuskan ikut memicu "Back to Default", lalu user alt+tab ke aplikasi
    // target memicu switch lagi - dan dua-duanya butuh upload penuh (ratusan
    // perintah SET). Akibatnya preset berganti bolak-balik tanpa henti,
    // device tidak pernah selesai memproses antrean, dan grid app tidak pernah
    // sempat menampilkan keymap yang benar.
    //
    // Jeda ini bukan penalti: switch yang sah tetap terjadi, hanya tidak
    // menumpuk dengan switch berikutnya yang belum sempat selesai.
    if (Date.now() - lastSwitchAt < SWITCH_COOLDOWN_MS) return;
    lastSwitchAt = Date.now();

    autoSwitchBusy = true;
    try {
      if (matched) {
        await activatePresetRuntime(matched, exe);
      } else {
        quietOkUntil = Date.now() + 500;
        // Back to Default — ini persis seperti slot cache: device sudah
        // menyimpan default config permanen di flash, jadi kita hanya
        // butuh token CONTEXT:DEFAULT, bukan re-upload seluruh keymap.
        //
        // LAYER:0 diperlukan karena device mungkin masih di layer lama
        // (dari preset app sebelumnya) yang tidak valid di default config.
        //
        // PENTING: tidak memakai markBatchSettling() di sini — ini BUKAN
        // upload batch (hanya 3 baris kecil). markBatchSettling akan membuat
        // batchUploadInFlight() = true selama 4 detik, dan handleIncomingChunk
        // akan MELEWATI semua response (CONTEXT:DEFAULT, INFO, DUMP) lewat
        // watchdog logic. Akibatnya watchdog tidak pernah armed, DUMP_END
        // datang tanpa ada yang cancel, dan jika device lambat sempat saja
        // dump terlihat macam "never closed".
        //
        // DUMPENC tidak dikirim di sini: encoder config sudah dilaporkan
        // lewat INFO response. DUMPENC dipisahkan ke sendLine tunggal setelah
        // DUMP layer selesai, untuk menghindari dua frame dump berpotongan.
        await sendBatch(['CONTEXT:DEFAULT', 'LAYER:0', 'INFO']);
        // Set flag untuk menahan polling: device butuh waktu untuk memproses
        // konteks + INFO + DUMP. Polling tidak boleh interleave selama ini.
        contextSwitchPending = true;
        // Reset currentLayer di app state ke 0 untuk konsisten dengan LAYER:0.
        setCurrentLayer(0);
        currentActivePresetId = null;
        updateActivePresetLabel();
        log(t('adaptive.backDefaultLog'), null);
        hooks.notify(t('adaptive.defaultNotif'), 'preset');
        // INFO response akan trigger hooks.loadLayer(currentLayer) secara
        // otomatis di protocol-parser.js. Tidak perlu panggil
        // loadActiveLayerDump() manual — sudah pasti race condition dengan
        // response INFO yang sedang berjalan.
        //
        // Tunggu sampai device selesai memproses (INFO + DUMP response datang
        // lewat protocol-parser). Karena kita tidak pakai markBatchSettling
        // (yang akan nge-skip watchdog), flag ini akan di-clear oleh timer.
        // Durasi 2.5 detik cukup untuk device memproses 3 perintah kecil +
        // DUMP response (9 key lines + LAYER_END).
        setTimeout(() => { contextSwitchPending = false; }, 2500);
      }
    } finally { autoSwitchBusy = false; }
  } finally { pollInFlight = false; }
}

export function resetAdaptiveRuntimeState() {
  lastDeviceLayerEventAt = 0;
  // Peta "layer terakhir" hanya berlaku selama satu sesi koneksi. Device sudah
  // tidak menampilkan isi preset mana pun setelah putus, jadi layer yang
  // tercatat dari sesi lalu tidak lagi punya arti.
  lastLayerByPreset = new Map();
  slotTable = Array(APP_SLOTS).fill(null);
  currentActivePresetId = null; focusedExeLast = null; escapeFrozenForExe = null; pendingFocusSince = 0;
  // Default lebih dulu setelah setiap koneksi. Permintaan user: begitu app
  // terhubung, yang tampil adalah preset Default; baru setelah user pindah ke
  // window aplikasi lain (mis. Brave) preset ikut pindah.
  //
  // Ini juga menutup celah nyata: device yang baru boot sudah di CONTEXT:DEFAULT,
  // tapi device yang reconnect setelah app restart bisa saja masih Ingat
  // CONTEXT:APP dari sesi sebelumnya (context hidup di RAM device, bukan di
  // app). Tanpa perintah eksplisit, app mengira sudah Default padahal device
  // masih menjalankan preset lama - dan grid yang tampil bukan isi device.
  //
  // Sengaja tidak pakai markBatchSettling: ini 3 baris kecil, bukan upload
  // batch. Lihat catatan panjang di pollFocusedApp soal alasannya.
  switchPendingOnConnect = true;
  contextSwitchPending = false;
  lastSwitchAt = Date.now();
  updateActivePresetLabel();
}

// Dipanggil handleLine saat EVT:ESCAPE. Gestur escape memaksa balik ke Default
// Preset; selama mode edit draft tidak boleh hilang, jadi escape diabaikan.
export function handleEscapeGesture() {
  if (editingPresetId) {
    sendLine('CONTEXT:APP:RESUME');
    log(t('adaptive.escapeIgnoredLog'), null);
    return true;
  }
  if (currentActivePresetId) {
    escapeFrozenForExe = focusedExeLast;
    hooks.notify(t('adaptive.defaultNotif'), 'preset');
    currentActivePresetId = null;
    updateActivePresetLabel();
    log(`[ADAPT] Escape manual - auto-switch dibekukan untuk "${focusedExeLast}" sampai window lain difokuskan.`, null);
    return true;
  }
  return false;
}

// ---- Pemasangan kontrol & polling ----
export function initAdaptivePage() {
  el('masterEnabledToggle').onchange = async (e) => {
    presetsData.masterEnabled = e.target.checked;
    await invoke('presets_save', { data: presetsData });
    if (!presetsData.masterEnabled && currentActivePresetId && isConnected() && !editingPresetId) {
      await sendLine('CONTEXT:DEFAULT');
      currentActivePresetId = null;
      updateActivePresetLabel();
      log(t('adaptive.featureOffLog'), null);
    }
  };

  el('btnAddPreset').onclick = async () => {
    const picked = await pickBindableApp();
    if (!picked) return;
    const name = await hooks.showPromptModal(t('adaptive.newTitle'), t('adaptive.nameLabel'), picked.name);
    if (name === null || !name.trim()) return;
    const id = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const conflict = presetsData.presets.find(p => p.enabled && p.exeName === picked.exeName);
    const newPreset = { id, name: name.trim(), exeName: picked.exeName, enabled: !conflict, layers: [] };
    presetsData.presets.push(newPreset);
    await invoke('presets_save', { data: presetsData });
    if (conflict) log(t('adaptive.presetCreatedDisabled', { name: newPreset.name, conflict: conflict.name }), null);
    renderPresetList();
    openPresetEditor(id);
  };

  el('btnPresetEditDone').onclick = async () => {
    if (!editingPresetId) return;
    const preset = presetsData.presets.find(p => p.id === editingPresetId);
    if (preset) {
      await fetchAllLayersForPacking();
      preset.layers = packCurrentAsPresetLayers();
      await invoke('presets_save', { data: presetsData });
      log(t('adaptive.presetSavedLog', { name: preset.name, n: preset.layers.length }), 'ok');
    }
    await exitPresetEditor();
  };

  el('btnPresetEditCancel').onclick = async () => {
    if (await hooks.showConfirmModal(t('adaptive.cancelEditTitle'), t('adaptive.cancelEditMsg'), t('adaptive.cancelEditConfirm'))) {
      await exitPresetEditor();
    }
  };

  // Polling window foreground. 120 ms terasa instan tanpa membanjiri OS dengan
  // permintaan GetForegroundWindow.
  setInterval(pollFocusedApp, FOCUS_POLL_MS);
}