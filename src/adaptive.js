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
} from './device-state.js';
import { el, log, escapeHtml } from './dom.js';
import { sendLine, sendBatch, isConnected, dumpInProgress } from './serial-transport.js';
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

const FOCUS_DEBOUNCE_MS = 150;
const FOCUS_POLL_MS = 120;

const APP_SLOTS = 6;                        // harus sama dengan APP_SLOTS di firmware
let slotTable = Array(APP_SLOTS).fill(null); // {id, sig, used}
let slotTick = 0;
// Sembunyikan balasan [OK]/[LAYER] selama batch runtime supaya panel log tidak
// penuh dengan konfirmasi yang tidak berguna.
let quietOkUntil = 0;

// Dipanggil handleLine di main.js: selama upload batch, device membalas banyak
// baris [OK] yang tidak perlu ditampilkan.
export function suppressDeviceEcho() { return Date.now() < quietOkUntil; }

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
  return dumpInProgress;
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

function waitForDump(layer, timeoutMs) {
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
const presetSig = p => JSON.stringify([p.layers, NUM_ENCODERS]);

function buildPresetLines(preset, slot) {
  const L = [`SLOT:${slot}:NEW`];
  for (let li = 0; li < preset.layers.length; li++) {
    if (li > 0) L.push('ADDLAYER');
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
  }
  return L;
}

async function activatePresetRuntime(preset, exe) {
  const sig = presetSig(preset);
  let slot = slotTable.findIndex(s => s && s.id === preset.id);
  const cached = slot >= 0 && slotTable[slot].sig === sig;
  if (slot < 0) {
    // Slot kosong dulu; kalau semuanya penuh, buang yang paling lama dipakai.
    slot = 0; let best = Infinity;
    slotTable.forEach((s, i) => { const u = s ? s.used : -1; if (u < best) { best = u; slot = i; } });
  }
  quietOkUntil = Date.now() + 500;
  const lines = cached ? [`SLOT:${slot}:USE`] : buildPresetLines(preset, slot);
  lines.push('INFO', 'DUMPENC');
  // Anggap slot tidak valid sampai write benar-benar sukses. Kalau gagal di tengah
  // (kabel dicabut), device punya keymap setengah jadi sementara tabel app
  // mengira slot itu utuh - berikutnya SLOT:<n>:USE akan mengaktifkan konten rusak.
  slotTable[slot] = null;
  await sendBatch(lines);
  slotTable[slot] = { id: preset.id, sig, used: ++slotTick };
  currentActivePresetId = preset.id;
  updateActivePresetLabel();
  log(t('adaptive.presetActiveLog', { name: preset.name, exe, cache: cached ? t('adaptive.cache') : '' }), 'ok');
  hooks.notify(t('adaptive.presetNotif', { name: preset.name }), 'preset');
}

let pollInFlight = false;
async function pollFocusedApp() {
  if (pollInFlight) return;
  if (!presetsData.masterEnabled || !isConnected() || editingPresetId || autoSwitchBusy) return;
  pollInFlight = true;
  try {
    let exe;
    try { exe = await invoke('get_foreground_exe'); } catch (e) { return; }
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

    autoSwitchBusy = true;
    try {
      if (matched) {
        await activatePresetRuntime(matched, exe);
      } else {
        quietOkUntil = Date.now() + 500;
        await sendBatch(['CONTEXT:DEFAULT', 'INFO', 'DUMPENC']);
        currentActivePresetId = null;
        updateActivePresetLabel();
        log(t('adaptive.backDefaultLog'), null);
        hooks.notify(t('adaptive.defaultNotif'), 'preset');
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