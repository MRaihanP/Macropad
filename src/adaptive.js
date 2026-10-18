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
import { sendLine, sendBatch, isConnected, dumpInProgress, handshakePending } from './transport.js';
import {
  deviceSupportsFrame, frameModeStatus, resetFrameMode, queryFrameSlots,
  activateFrameSlot, ensureLineMode, presetSig, findMatchingSlot, sigHex,
} from './frame-transport.js';
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
// Jeda minimal antar dua perpindahan preset.
//
// Upload preset itu mahal: ratusan perintah SET yang harus device proses satu
// per satu, dan switch berikutnya tidak boleh menumpuk di belakang yang
// sedang jalan. Tanpa jeda ini, companion app (yang sedang difokuskan) memicu
// "Back to Default" dan target memicu switch balik - menghasilkan bolak-balik
// tanpa henti yang membanjiri antrean device.
//
// CATATAN PENTING: cooldown ini dihitung dari WAKTU switch DIMULAI, dan switch
// yang sekarang bisa memakan belasan detik di link lambat (upload + tunggu
// DUMP_END). Jadi saat switch pertama masih berjalan, cooldown sudah lama
// terlewati - dan begitu switch pertama selesai, switch kedua langsung boleh
// jalan. Itu perilaku yang benar: yang dicegah adalah dua switch BERJALAN
// BERSAMAAN, dan `autoSwitchBusy` sudah menjaganya.
//
// Gejala "percobaan ketiga tidak berpindah sama sekali" punya sebab lain:
// bukan cooldown, tapi `targetId === currentActivePresetId`. Kalau switch
// sebelumnya sempat menandai preset sebagai aktif lalu grid-nya gagal dimuat,
// app akan melihat "sudah di preset ini" dan tidak melakukan apa-apa - padahal
// grid masih menampilkan isi lama. Karena itu penandaan `currentActivePresetId`
// harus terjadi BERSAMAAN dengan preset benar-benar terpasang di device.
const SWITCH_COOLDOWN_MS = 2500;
let lastSwitchAt = 0;

// Berapa lama menunggu DUMP_END setelah switch preset.
//
// Yang ditunggu HANYA penanda DUMP_END, bukan isi lengkap dump - jadi ini bukan
// "berapa lama switch boleh". Yang dijaga adalah urutan: switch berikutnya tidak
// boleh dikirim sebelum dump yang sekarang selesai, karena dua dump yang
// tumpang tindih membuat grid menampilkan isi yang salah.
//
// 8 detik longgar untuk link lambat (rtt p95 bisa ~1 detik di adapter buruk),
// tapi bukan tanpa batas: kalau device tidak pernah mengirim DUMP_END, switch
// berikutnya akan terkunci selamanya dan auto-switch mati permanen.
//
// WAJIB DILEBIHI dari DUMP_STUCK_MS di ble-transport.js (20 detik). Kalau nilai
// di sini lebih kecil, app akan menyerah dulu dan mencatat error, padahal
// watchdog di backend belum sempat menyalakan - dan grid tetap stale tanpa
// penjelasan. Dua batas harus urut: app lebih dulu menyerah, baru backend
// membersihkan parser sebagai jaring pengaman terakhir.
const DUMP_WAIT_MS = 12000;

const APP_SLOTS = 6;                        // harus sama dengan APP_SLOTS di firmware
let slotTable = Array(APP_SLOTS).fill(null); // {id, sig, used}
let slotTick = 0;
// Sembunyikan balasan [OK]/[LAYER] selama batch runtime supaya panel log tidak
// penuh dengan konfirmasi yang tidak berguna.
let quietOkUntil = 0;

// Dipanggil handleLine di main.js: selama upload batch, device membalas banyak
// baris [OK] yang tidak perlu ditampilkan.
export function suppressDeviceEcho() { return Date.now() < quietOkUntil; }

// State upload ada di upload-state.js - modul itu sengaja dipisah dari
// adaptive.js supaya backend BLE bisa memakainya tanpa mengimpor modul ini
// (adaptive -> transport <- BLE transport = siklus import).
import { beginCfgTransfer, endCfgTransfer, noteCfgCommands } from './upload-state.js';

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
  // Dipasang main.js dari protocol-parser.js deviceProfile.
  // Dipakai adaptive.js untuk mengecek apakah device mendukung frame mode
  // tanpa perlu mengimpor protocol-parser.js langsung (yang akan menutup siklus
  // import, karena protocol-parser mengimpor adaptive.js).
  getDeviceProfile: () => null,
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
  // Handshake setelah connect belum selesai. `isConnected()` sudah true
  // selama handshake berjalan, jadi tanpa guard ini poll auto-switch akan
  // mengirim upload preset lengkap (ratusan perintah SET) di atas 7 perintah
  // handshake yang masih diproses device. Dua aliran perintah tumpang tindih
  // itu yang membuat link putus tepat setelah connect.
  if (handshakePending()) return true;
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
//
// presetSig sekarang diimpor dari frame-transport.js (CRC32 kanonik).
// Lihat komentar di file tersebut soal perbandingan dengan implementasi C/Rust.

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
  const dims = { rows: ROWS, cols: COLS, numEncoders: NUM_ENCODERS };
  const sig = presetSig(preset, dims);

  let slot = slotTable.findIndex(s => s && s.id === preset.id);
  const cached = slot >= 0 && slotTable[slot].sig === sig;
  if (slot < 0) {
    // Slot kosong dulu; kalau semuanya penuh, buang yang paling lama dipakai.
    slot = 0; let best = Infinity;
    slotTable.forEach((s, i) => { const u = s ? s.used : -1; if (u < best) { best = u; slot = i; } });
  }
  quietOkUntil = Date.now() + 500;

  // ---- FAST PATH: CFG_SIG + CFG_QUERY + CFG_ACTIVATE ----
  //
  // Log di baris pertama ini PENTING dan bukan hiasan.
  //
  // Gejala yang dilaporkan: "pindah ke preset app lain, app terlihat diam saja
  // tanpa log apapun, setelah beberapa menit baru keluar [ADAPT] Active
  // Preset". Tanpa log di sini, semua yang terjadi di bawah - queryFrameSlots
  // (1 RTT), findMatchingSlot, mungkin upload binary (N RTT), CFG_ACTIVATE
  // (1 RTT), ensureLineMode (1 RTT + PONG) - terjadi di dalam keheningan total.
  // User melihat app macet, padahal sebenarnya link BLE yang lambat sedang
  // membayar beberapa round-trip.
  log(t('adaptive.frameSwitchStart', { name: preset.name, exe }), null);
  //
  // Alurnya: tanya device slot mana yang isinya sudah sama dengan preset ini
  // (pakai CFG_SIG kanonik yang sama persis dengan firmware). Kalau ada,
  // cukup SATU frame 8 byte untuk beralih - bukan ratusan baris SET.
  //
  // Ini hemat yang jauh lebih besar daripada kelihatannya: yang dihemat bukan
  // hanya bandwidth, tapi juga WAKTU. Unggah penuh pada preset besar menulis
  // ratusan perintah yang device harus proses satu per satu, dan selama itu
  // device tidak sempat mengolah perintah switch, dan grid app tidak pernah
  // sempat menampilkan keymap yang benar.
  //
  // Syaratnya device harus mendukung frame. Device baru masuk mode frame
  // setelah menerima SOF 0xA5, jadi deviceSupportsFrame() hanya PETUNJUK -
  // percobaan pertama yang benar-benar membuktikan. Kalau percobaan gagal,
  // jalur teks dipakai dan kegagalan dicatat supaya tidak diulang.
  //
  // Bukti frame dari DUA sumber, dan keduanya wajib dipakai.
  //
  // `getDeviceProfile()` memberi profil SESI INI - tapi resetDeviceProfile()
  // menghapusnya setiap disconnect, dan tepat setelah connect baru profil itu
  // belum terisi (WHOAMI dijawab beberapa ratus ms kemudian). Selama jendela itu
  // deviceSupportsFrame() bernilai false, jadi fast path tidak pernah dicoba,
  // dan switch pertama/setiap switch setelah reconnect jatuh ke jalur teks yang
  // mengirim ratusan baris SET.
  //
  // `getFrameCapability()` mengembalikan `lastFrameSof` yang SENGAJA bertahan
  // melewati disconnect (lihat protocol-parser.js). Itu yang membuat fast path
  // tetap hidup di switch pertama dan setelah reconnect.
  //
  // Gejala yang dilaporkan persis ini: switch pertama sangat lama lalu stream
  // membanjiri, switch berikutnya lebih cepat karena profil sudah terisi.
  const buktiFrame = deviceSupportsFrame(hooks.getDeviceProfile())
    || !!hooks.getFrameCapability?.();
  if (buktiFrame && frameModeStatus() !== false) {
    const meta = await queryFrameSlots();
    if (meta) {
      const devSlot = findMatchingSlot(sig, meta.slots);
      if (devSlot >= 0) {
        const rsp = await activateFrameSlot(devSlot);
        if (rsp) {
          // Device sudah pindah slot, dan itu SEKARANG terjadi - jadi preset
          // sudah aktif dari sisi device. Itu yang penting untuk gejala
          // "perpindahan lama": pengguna tidak perlu menunggu dump selesai.
          //
          // CFG_ACTIVATE dijawab dengan CFG_ACT_RSP di mode frame. Sebelum
          // INFO/DUMPENC (yang berupa teks) dikirim, device harus keluar dari
          // mode frame - perintah resminya satu byte 0x0A lewat jalur RAW.
          //
          // verifyLineMode TIDAK dipakai di sini, dan itu keputusan sadar:
          // probePong() adalah satu RTT penuh (PING -> PONG), jadi memverifikasi
          // setelah SETIAP switch menambah ~240ms pada RTT p50 device Anda -
          // dan device yang lambat justru yang paling dirugikan. Yang membuat
          // ini tetap aman adalah 0x0A dikirim lewat jalur frame (sendRaw),
          // bukan sendLine: jadi byte itu tidak mungkin hilang di barisan teks.
          //
          // Kalau ternyata mode frame tidak berubah, gejala yang muncul adalah
          // grid kosong (INFO/DUMPENC jadi payload rusak) - dan itu terlihat
          // sebagai crcErr naik di DIAG, bukan sebagai preset yang salah.
          const inLineMode = await ensureLineMode();
          if (!inLineMode) {
            // BUKAN fallback penuh. Preset sudah aktif di device; yang belum
            // synced hanya grid di app. Menjalankan activatePresetRuntimeText()
            // di sini akan mengirim ulang ratusan baris SET - persis perintah
            // yang membuat device kewalahan dan Windows memutus link.
            //
            // Dampaknya sampai DUMP di bawah: kalau device ternyata masih mode
            // frame, INFO/DUMPENC akan dibaca sebagai payload frame rusak dan
            // DUMP_BEGIN yang menyertainya tidak pernah punya DUMP_END - itu
            // persis error "DUMP never closed" yang muncul di log. Jadi kalau
            // mode line gagal dipastikan, jangan kirim DUMP sama sekali;
            // lebih baik grid stale sementara daripada parser terkunci.
            log(t('adaptive.frameModeStuck'), 'err');
            log(t('adaptive.presetActiveLog', {
              name: preset.name, exe,
              cache: t('adaptive.cacheFrame'),
            }), 'ok');
            hooks.notify(t('adaptive.presetNotif', { name: preset.name }), 'preset');
            currentActivePresetId = preset.id;
            updateActivePresetLabel();
            slotTable[slot] = { id: preset.id, sig, used: ++slotTick };
            return;
          }
          log(t('adaptive.presetActiveLog', {
            name: preset.name, exe,
            cache: t('adaptive.cacheFrame'),
          }), 'ok');
          hooks.notify(t('adaptive.presetNotif', { name: preset.name }), 'preset');
          slotTable[slot] = { id: preset.id, sig, used: ++slotTick };
          // Dump dulu, baru tandai aktif.
          //
          // Urutan ini penting dan terbalik di versi lama. Kalau
          // `currentActivePresetId` di-set SEBELUM dump, lalu dump gagal
          // (timeout), maka switch berikutnya melihat
          // `targetId === currentActivePresetId` dan langsung return tanpa
          // melakukan apa pun. Itulah gejala "percobaan ketiga tidak
          // berpindah sama sekali": preset-nya ditandai aktif padahal grid
          // masih menampilkan isi lama dan tidak pernah dicoba lagi.
          //
          // Menandainya setelah dump berarti switch berikutnya selalu punya
          // kesempatan mencoba lagi kalau grid memang belum sinkron.
          await loadActiveLayerDump();
          currentActivePresetId = preset.id;
          updateActivePresetLabel();
          return;
        }
        log(t('adaptive.frameActivateFail', { name: preset.name }), 'err');
      } else {
        log(t('adaptive.frameNoMatch', { sig: sigHex(sig) }), null);
      }
    } else {
      log(t('adaptive.frameQueryFail'), 'err');
    }
  }
  // Tidak ada slot yang cocok, atau percobaan frame gagal: turun ke jalur teks.

  await activatePresetRuntimeText(preset, exe, sig, slot, cached);
}

// Jalur teks. Dipisah dari activatePresetRuntime supaya ada SATU tempat yang
// menulis SLOT: dan satu tempat yang mengurus state upload - bukan dua salinan
// yang bisa mulai berbeda satu sama lain.
async function activatePresetRuntimeText(preset, exe, sig, slot, cached) {
  const lines = cached ? [`SLOT:${slot}:USE`] : buildPresetLines(preset, slot);
  // SLOT:n:USE TIDAK mengirim INFO ke device, dan INFO pun tidak cukup:
  // INFO memicu muat ulang layer dari protocol-parser, tapi pemanggilan itu
  // ditunda kalau ada frame lain yang sedang berjalan (DUMP/DUMPNAMES).
  // Akibatnya grid di app tetap menampilkan isi preset LAMA setelah preset
  // berganti - persis gejala "matrix tombol tidak berubah".
  //
  // Jadi minta dump layer secara eksplisit, terpisah dari batch upload.
  lines.push('INFO', 'DUMPENC');

  // Anggap slot tidak valid sampai write benar-benar sukses. Kalau gagal di
  // tengah (kabel dicabut), device punya keymap setengah jadi sementara tabel app
  // mengira slot itu utuh - berikutnya SLOT:<n>:USE akan mengaktifkan isi rusak.
  slotTable[slot] = null;

  // Transfer ditandai SEBELUM perintah dikirim, dan ditandai selesai di finally.
  // Menandainya setelah sendBatch() akan meninggalkan jendela waktu di mana
  // device sudah menjalankan ratusan SET sementara app masih menganggapnya idle.
  beginCfgTransfer(lines.length);
  try {
    await sendBatch(lines);
    noteCfgCommands(lines.length);
  } finally {
    endCfgTransfer();
  }

  slotTable[slot] = { id: preset.id, sig, used: ++slotTick };
  log(t('adaptive.presetActiveLog', { name: preset.name, exe, cache: cached ? t('adaptive.cache') : '' }), 'ok');
  hooks.notify(t('adaptive.presetNotif', { name: preset.name }), 'preset');
  // Minta ulang isi layer yang sekarang aktif, dan TUNGGU sampai selesai.
  //
  // Penandaan `currentActivePresetId` sengaja ada SETELAH baris ini: kalau
  // preset ditandai aktif sebelum grid benar-benar sinkron, switch berikutnya
  // akan melihat "sudah di preset ini" lalu tidak melakukan apa pun. Lihat
  // catatan yang sama di activatePresetRuntime.
  await loadActiveLayerDump();
  currentActivePresetId = preset.id;
  updateActivePresetLabel();
}

// Minta dump layer aktif dari device supaya grid ikut berubah saat preset
// berganti.
//
// Dipisah dari activatePresetRuntime karena harus dikirim SETELAH batch upload
// selesai, bukan di baris yang sama. Kalau dikirim bersamaan, DUMP:0 masuk ke
// antrean device di belakang ratusan perintah SET dan jawabannya tertahan lama
// - dan kalau ada frame lain yang sedang berjalan, parser menundanya.
//
// WAIT DUMP WAJIB, dan itu yang hilang di versi lama.
//
// Gejala: "matrix tidak berubah, tapi input dari key sudah benar preset yang
// seharusnya". Itu persis tanda device sudah benar sementara app masih
// menampilkan keymap LAMA. hooks.loadLayer() hanya await sendLine() - yang
// selesai begitu byte-nya masuk antrean, bukan begitu DUMP_END sampai. Jadi
// pemanggil lanjut dan switch berikutnya dimulai sebelum dump yang lama
// selesai, dan dua dump saling menimpa: yang terakhir selesai bukan yang
// terakhir diminta.
//
// Di link lambat (rtt p50=237ms) ini bukan detail kecil: DUMP untuk 3x3 plus
// encoder adalah puluhan baris, dan tanpa jeda switch berikutnya sudah dikirim
// di tengah-tengahnya.
//
// Timeout-nya longgar (8 detik) karena yang ditunggu hanya penanda DUMP_END,
// bukan isi lengkapnya - dan selama menunggu tidak ada switch lain yang boleh
// jalan (autoSwitchBusy masih true). Jadi menunggu di sini bukan deadlock,
// hanya memastikan urutan yang benar.
async function loadActiveLayerDump() {
  const layer = currentLayer;
  // Waiter dipasang SEBELUM hooks.loadLayer mengirim DUMP. Kalau dibalik,
  // device bisa menjawab dalam hitungan milidetik dan DUMP_END-nya tiba saat
  // belum ada yang menunggu - dump selesai tanpa jejak, dan kita menunggu
  // timeout tanpa sebab.
  const settled = waitForDump(layer, DUMP_WAIT_MS);
  await hooks.loadLayer(layer);
  const ok = await settled;
  if (!ok) {
    log(t('adaptive.dumpWaitTimeout', { layer }), 'err');
  }
  // Status dikembalikan, bukan diabaikan di sini. Pemanggil butuh tahu apakah grid
  // benar-benar sudah sinkron sebelum menandai preset sebagai aktif - kalau
  // tidak, switch berikutnya akan mengira sudah di preset yang benar lalu
  // tidak melakukan apa-apa.
  return ok;
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
    // Cooldown setelah switch. Tanpa ini, companion app sendiri yang sedang
    // difokuskan ikut memicu "Back to Default", lalu user alt+tab ke aplikasi
    // target memicu switch lagi - dan dua-duanya butuh upload. Akibatnya preset
    // berganti bolak-balik tanpa henti, device tidak pernah selesai memproses
    // antrean, dan grid app tidak pernah sempat menampilkan keymap yang benar.
    //
    // Catatan tentang gejala "tidak ada notifikasi perpindahan sampai lama":
    // penyebabnya bukan cooldown ini. Poll 120 ms + debounce 150 ms sudah
    // membuka jalan dalam ~300 ms. Yang hilang adalah UMPAN BALIK ke user -
    // activatePresetRuntime() tidak memberi log apa pun sampai selesai, dan pada
    // preset yang harus di-upload lewat frame itu bisa beberapa detik. Jadi
    // switch yang sudah tahu akan dicatat di frameSwitchStart.
    if (Date.now() - lastSwitchAt < SWITCH_COOLDOWN_MS) return;
    lastSwitchAt = Date.now();

    autoSwitchBusy = true;
    try {
      if (matched) {
        await activatePresetRuntime(matched, exe);
      } else {
        quietOkUntil = Date.now() + 500;
        const lines = ['CONTEXT:DEFAULT', 'INFO', 'DUMPENC'];
        // Pola yang sama seperti activatePresetRuntimeText: transfer ditandai
        // sebelum dikirim dan ditutup di finally. Jendela 4000 ms yang lama memakai
        // konstanta tetap, jadi tiga perintah ini pun menahan watchdog dump
        // selama 4 detik - hampir 4 detik sia-sia untuk hal yang selesai dalam
        // hitungan milidetik.
        beginCfgTransfer(lines.length);
        try {
          await sendBatch(lines);
          noteCfgCommands(lines.length);
        } finally {
          endCfgTransfer();
        }
        currentActivePresetId = null;
        updateActivePresetLabel();
        log(t('adaptive.backDefaultLog'), null);
        hooks.notify(t('adaptive.defaultNotif'), 'preset');
        // Muat ulang grid. Tanpa ini, kekacauan yang dilaporkan terjadi:
        // "pindah ke aplikasi lain, key masih nyangkut di preset app
        // sebelumnya". Device sudah benar (CONTEXT:DEFAULT sudah sampai),
        // tapi grid masih menampilkan isi preset LAMA karena tidak ada
        // yang meminta DUMP.
        //
        // INFO di baris perintah di atas TIDAK cukup: INFO memicu muat
        // ulang layer di protocol-parser, tapi pemanggilan itu ditunda
        // kalau ada frame atau dump lain yang sedang berjalan - dan tepat
        // setelah switch ke preset(frame) itu memang sedang berjalan.
        // Jadi dump layer aktif diminta eksplisit di sini.
        await loadActiveLayerDump();
      }
    } finally { autoSwitchBusy = false; }
  } finally { pollInFlight = false; }
}

// ---- State reset keadaan koneksi ----
//
// resetAdaptiveRuntimeState() (milik onDeviceLost) mereset SEMUA termasuk
// frameUsable -> null. Itu benar saat device benar-benar hilang, tapi SALAH
// dipakai untuk (re)connect USB manual: frameUsablenull akan memaksa
// queryFrameSlots() dijalankan kembali di adaptive.js, dan queryFrameSlots
// memakai sendFrame() -> sendRaw(Uint8Array). Tauri serial plugin di build ini
// MENOLAK Uint8Array ("invalid type: sequence, expected a string"), jadi tiap
// (re)connect yang me-reset frameModeMode ke null memicu crash reconnect loop.
//
// Di samping itu, frame-mode pada prototipe belum "disambungkan ke app"
// (lihat komentar di firmware/common/frame_proto.h line 12-14): WHOAMI
// prototype kirim proto=line, jadi tidak boleh pernah masuk frame-path.
//
// resetAdaptiveOnConnect() merupakan reset SELEKTIF: hanya state yang memang
// hilang dari RAM device (slotTable, currentActivePresetId, dll.) AGAR text
// path upload penuh dijalankan sekali (cache miss). frameUsable dibiarkan apa
// adanya supaya tidak memaksa queryFrameSlots yang akan crash, dan tidak
// memaksa retry frame-path yang prototipe tidak dukung.
export function resetAdaptiveOnConnect() {
  lastDeviceLayerEventAt = 0;
  lastLayerByPreset = new Map();
  slotTable = Array(APP_SLOTS).fill(null);
  currentActivePresetId = null;
  focusedExeLast = null;
  escapeFrozenForExe = null;
  pendingFocusSince = 0;
  autoSwitchBusy = false;
  updateActivePresetLabel();
}

export function resetAdaptiveRuntimeState() {
  lastDeviceLayerEventAt = 0;
  // Peta "layer terakhir" hanya berlaku selama satu sesi koneksi. Device sudah
  // tidak menampilkan isi preset mana pun setelah putus, jadi layer yang
  // tercatat dari sesi lalu tidak lagi punya arti.
  lastLayerByPreset = new Map();
  slotTable = Array(APP_SLOTS).fill(null);
  currentActivePresetId = null; focusedExeLast = null; escapeFrozenForExe = null; pendingFocusSince = 0;
  // Keputusan "format frame dipakai atau tidak" juga milik SESI, bukan milik
  // aplikasi. Kalau tidak dihapus, device yang gagal menjawab frame sekali pun
  // akan dicatat "tidak mendukung frame" selamanya - termasuk device berikutnya
  // yang mungkin device yang sama dan sekarang sehat.
  resetFrameMode();
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