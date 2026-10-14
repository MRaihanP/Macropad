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
  ROWS, COLS, NUM_ENCODERS, TYPE_NAMES, CAP_LAYERS,
  mapping, encConfig, layerNames, layerCount, currentLayer,
  setCurrentLayer, reorderLayer, setMapping, setLayerNames, setEncConfig,
  getLayer, applyDefaultCache, setDefaultCache,
  clearDefaultCache, loadDefaultCacheFromStorage,
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

// Nama file exe companion app sendiri, dibaca sekali dari Rust. Dipakai untuk
// mengenali "user pindah ke companion app" - kasus yang perilakunya berbeda
// dari "user pindah ke aplikasi lain": companion app berarti kembali ke
// Default dan HOLD (tidak_posts switch lain selama beberapa detik), supaya
// user bisa melihat grid tanpa device ikut berbolak-balik.
let ownExeName = null;
export async function loadOwnExeName() {
  try { ownExeName = await invoke('get_own_exe_name'); }
  catch (e) { ownExeName = null; }
}

// Companion app dianggap "baru saja ditinggalkan" selama beberapa detik
// setelah terakhir kali fokus. Selama itu, perpindahan ke companion app
// diabaikan - jadi user bisa alt+tab ke app, lihat grid, dan kembali tanpa
// memicu Default lalu preset lagi.
const OWN_APP_COOLDOWN_MS = 8000;
let lastOwnAppSeenAt = 0;

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

// Jendela waktu di mana notifikasi "pergantian layer ke layer 0" yang
// DISEBABKAN switch preset harus disembunyikan.
//
// Switch preset mengirim LAYER:0 untuk memaksa device ke layer 0, dan device
// membalas "[LAYER] Pindah manual ke layer 0". Tanpa penapis ini, notifikasi
// itu muncul tepat di atas notifikasi "preset aktif" dan keduanya saling
// menutupi - user melihat dua notifikasi yang sebenarnya satu peristiwa.
//
// Hanya berlaku sebentar (1,5 detik) dan hanya untuk layer 0. Kalau user
// memutar knob ke layer lain, notifikasinya tetap harus tampil.
let layerNotifSuppressedUntil = 0;
export function suppressLayerNotif() { return Date.now() < layerNotifSuppressedUntil; }
function markPresetSwitch() { layerNotifSuppressedUntil = Date.now() + 1500; }

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
  // Digantar renderPresetLocally() & switchToDefault(): grid digambar dari
  // cache lokal, jadi tidak ada yang perlu menunggu DUMP_END dari device.
  renderGrid: () => { },
  renderTabs: () => { },
  renderEncoderList: () => { },
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

// True kalau tidak ada App Preset yang aktif, artinya device sedang di
// CONTEXT:DEFAULT. Edit per-key/knob hanya mengubah Default Preset dalam kasus
// ini - kalau App Preset aktif, device menunjuk ke slot dan yang berubah isi
// slot itu, bukan Default. Dipakai main.js supaya cache Default hanya
// dibatalkan saat memang perlu.
export function isDefaultContext() { return !currentActivePresetId; }

export function updateActivePresetLabel() {  const label = el('deviceActivePresetLabel');
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
  markPresetSwitch();
  // Simpan state lama untuk restore bila gagal.
  const savedSlot = slotTable[slot];
  // Anggap slot tidak valid sampai semua layer berhasil di-upload.
  // Kalau gagal di tengah (kabel dicabut), device punya keymap setengah jadi
  // sementara tabel app mengira slot itu utuh - berikutnaya SLOT:<n>:USE akan
  // mengaktifkan konten rusak.
  slotTable[slot] = null;
  try {
    // Cache app Says slot ini valid, tapi device bisa menyatakan otherwise
    // (device restart, atau upload sebelumnya gagal di tengah). Device yang
    // jadi acuan - kalau device bilang kosong, cache app tidak dipercaya.
    const useCache = cached && deviceSlotOccupied(slot);
    if (useCache) {
      // Preset sudah pernah di-upload ke slot ini dan signature-nya masih sama:
      // cukup kirim SLOT:<n>:USE (satu baris). TIDAK ada INFO/DUMP/DUMPENC
      // karena app sudah punya isi preset ini di presetsData - render dari
      // sana, bukan baca ulang dari device.
      await sendBatch([`SLOT:${slot}:USE`, 'LAYER:0']);
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
      // Setelah semua layer ter-upload, kunci ke layer 0. TIDAK requesting
      // INFO/DUMP/DUMPENC: app sudah tahu isi preset ini (baru saja dikirim),
      // jadi read-back hanya menambah frame yang harus dijaga watchdog.
      await sendBatch(['LAYER:0']);
      markBatchSettling(4000);
    }
    // Reset currentLayer di app state ke layer 0 karena kita mengirim LAYER:0
    // ke device di atas.
    setCurrentLayer(0);
    slotTable[slot] = { id: preset.id, sig, used: ++slotTick };
    currentActivePresetId = preset.id;
    updateActivePresetLabel();
    log(t('adaptive.presetActiveLog', { name: preset.name, exe, cache: cached ? t('adaptive.cache') : '' }), 'ok');
    hooks.notify(t('adaptive.presetNotif', { name: preset.name }), 'preset');
    // Grid digambar dari preset yang ada di app, bukan dari read-back device.
    renderPresetLocally(preset);
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

// Gambar grid dari isi preset yang sudah ada di app (presetsData).
//
// Ini menggantikan read-back DUMP:0 setelah preset aktif. Alasannya:
// app JUSTRU baru saja mengirim isi preset ini ke device, jadi isinya sudah
// diketahui app. Membacanya kembali dari device menambah ~200 byte dalam 11
// baris dan satu frame DUMP yang harus dijaga watchdog - tanpa menambah
// informasi apa pun.
//
// Bentuk preset.layers sudah sama dengan yang dipakai modul home-page:
// keys[r][c] = { type, value }, name, encCw/encCcw/encBtn.
function renderPresetLocally(preset) {
  const layers = preset.layers || [];
  if (!layers.length) return;
  const grid = Array.from({ length: CAP_LAYERS }, () => Array.from({ length: ROWS }, () => Array(COLS).fill(null)));
  const names = Array(CAP_LAYERS).fill(null);
  for (let li = 0; li < layers.length && li < CAP_LAYERS; li++) {
    const L = layers[li];
    names[li] = L.name || null;
    for (let r = 0; r < ROWS; r++) {
      const row = L.keys?.[r];
      if (!row) continue;
      for (let c = 0; c < COLS; c++) {
        const k = row[c];
        grid[li][r][c] = (k && k.type) ? { type: k.type, value: k.value || '' } : null;
      }
    }
  }
  // Knob: preset menyimpan encCw/encCcw/encBtn per layer, tapi device hanya
  // punya satu set knob untuk layer aktif. Ambil dari layer yang sedang
  // ditampilkan.
  const cur = layers[Math.min(currentLayer, layers.length - 1)] || layers[0];
  const enc = Array.from({ length: NUM_ENCODERS }, (_, i) => ({
    CW:  pick(cur?.encCw?.[i]),
    CCW: pick(cur?.encCcw?.[i]),
    BTN: pick(cur?.encBtn?.[i]),
  }));
  setMapping(grid);
  setLayerNames(names);
  setEncConfig(enc);
  hooks.renderTabs();
  hooks.renderGrid();
  hooks.renderEncoderList();
}
const pick = (a) => (a && a.type ? { type: a.type, value: a.value || '' } : null);

// ==================== TOKEN SWITCH ====================
//
// Default Preset ada di flash device, jadi Device TIDAK perluan mengirimi
// ulang isinya. Yang perlu Device lakukan cuma memindahkan activeCfg.
//
// Versi lama mengirim CONTEXT:DEFAULT + LAYER:0 + INFO dan lalu menunggu
// INFO -> DUMP:0 -> DUMPNAMES. Itu ~490 byte dalam 4 frame, dan tiap frame
// punya BEGIN/END yang harus dijaga watchdog. "DUMPNAMES never closed" dan
// "DUMP never closed" datang dari kelas bug ini - bukan dari satu baris
// yang hilang di jalan.
//
// Sekarang: 1 write, 0 frame. Grid langsung dirender dari cache, tanpa
// menunggu device sama sekali. Kalau cache belum ada (pertama kali, atau
// Default baru diubah), jatuh ke full read - lebih lambat sekali, bukan
// error.
async function switchToDefault() {
  quietOkUntil = Date.now() + 500;
  markPresetSwitch();
  await sendBatch(['CONTEXT:DEFAULT', 'LAYER:0']);
  contextSwitchPending = true;
  setCurrentLayer(0);
  currentActivePresetId = null;
  updateActivePresetLabel();

  if (applyDefaultCache()) {
    // Cache memuat seluruh Default Preset, jadi tidak ada yang perlu dibaca
    // dari device. Tinggal gambar ulang.
    hooks.renderTabs();
    hooks.renderGrid();
    hooks.renderEncoderList();
  } else {
    // Cache belum ada / sudah basi. Baca sekali dari device, lalu simpan
    // supaya perpindahan berikutnya instan.
    await readDefaultFromDevice();
  }

  log(t('adaptive.backDefaultLog'), null);
  hooks.notify(t('adaptive.defaultNotif'), 'preset');
  setTimeout(() => { contextSwitchPending = false; }, 1200);
}

// Full read Default: semua layer + nama layer + knob. Ini satu-satunya
// jalur yang memakai frame DUMP/NAMES, dan hanya jalan saat cache belum ada.
async function readDefaultFromDevice() {
  const layers = [];
  for (let l = 0; l < layerCount; l++) {
    const waiter = waitForDump(l, 3000);
    await sendLine('DUMP:' + l);
    await waiter;
    layers.push(cloneLayer(getLayer(l)));
  }
  const names = layerNames.slice();
  const enc = encConfig.map(e => ({ CW: cloneAction(e.CW), CCW: cloneAction(e.CCW), BTN: cloneAction(e.BTN) }));
  setDefaultCache(fwVersion, layers, names, enc);
  hooks.renderTabs(); hooks.renderGrid(); hooks.renderEncoderList();
}

const cloneAction = (a) => (a && a.type ? { type: a.type, value: a.value } : null);
const cloneLayer = (g) => (g || []).map(row => (row || []).map(c => cloneAction(c)));

// Versi firmware device, dibaca dari WHOAMI. Dipakai sebagai jejak cache
// Default: cache yang dibuat firmware berbeda tidak boleh dipakai.
let fwVersion = 0;
export function setDeviceFwVersion(v) {
  if (!Number.isInteger(v) || v <= 0) return;
  if (fwVersion === v) return;
  fwVersion = v;
  // Firmware berubah -> cache lama bisa tidak cocok dengan isi device.
  clearDefaultCache();
  loadDefaultCacheFromStorage(v);
}

// ---- Status cache slot di device (point 6 user) ----
//
// Cache App Preset hidup di RAM device: hilang saat device mati/reset.
// Tabel slot di app tidak tahu itu, jadi tanpa pengecekan di sini app bisa
// mengirim SLOT:<n>:USE ke slot yang sudah kosong - keymap hilang tanpa jejak.
//
// Perintah SLOTS membalas "SLOTS:<mask6>,boot=<n>". boot id naik tiap boot
// device; kalau beda, semua cache app dianggap basi karena device pernah
// restart di luar app.
let deviceBootId = null;
let deviceSlotMask = 0;

export async function syncSlotStatus() {
  try {
    const line = await requestOneLine('SLOTS', 2000);
    if (!line) return;
    const m = line.match(/^SLOTS:([01]{6}),boot=(\d+)/);
    if (!m) return;
    const mask = parseInt(m[1], 2);
    const boot = parseInt(m[2], 10);
    // boot id berubah = device restart = semua slot kosong di device.
    if (deviceBootId !== null && boot !== deviceBootId) {
      slotTable = Array(APP_SLOTS).fill(null);
    }
    deviceBootId = boot;
    deviceSlotMask = mask;
    // Slot yang device nyatakan kosong tapi app think-nya terisi = app salah,
    // entah karena device restart atau karena upload pernah gagal di tengah.
    for (let i = 0; i < APP_SLOTS; i++) {
      if (!slotTable[i]) continue;
      if (!((mask >> i) & 1)) slotTable[i] = null;
    }
  } catch (e) { /* device tidak menjawab: pakai tabel apa adanya */ }
}

export function deviceSlotOccupied(i) { return ((deviceSlotMask >> i) & 1) === 1; }

// Kirim satu perintah dan tunggu satu baris jawaban, dengan batas waktu.
//
// Sengaja TIDAK memakai flag frame milik transport (dumpInProgress dll):
// SLOTS/CTX? adalah perintah sekali-pakai, bukan frame panjang. Kalau
// ikut memakai flag itu, satu baris jawaban singkat bisa ikut teranjak
// watchdog sebagai "isi frame yang tidak pernah ditutup" - persis kelas bug
// yang sedang kita hilangkan.
function requestOneLine(cmd, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;
    const handler = (line) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pendingOneLine === handler) pendingOneLine = null;
      resolve(line);
      return true;                       // baris sudah dikonsumsi
    };
    pendingOneLine = handler;
    timer = setTimeout(() => {
      if (pendingOneLine === handler) pendingOneLine = null;
      resolve(null);                     // tidak dijawab - bukan error fatal
    }, timeoutMs || 2000);
    sendLine(cmd).catch(() => { });
  });
}

let pendingOneLine = null;

// Dipanggil protocol-parser untuk setiap baris device. Kalau ada perintah
// sekali-pakai yang sedang menunggu jawaban, baris itu diserahkan ke sana
// supaya tidak sampai dibaca sebagai frame/command lain.
export function offerOneLine(line) {
  const f = pendingOneLine;
  if (!f) return false;
  return f(line) === true;
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
      // Tanya dulu cache slot device masih hidup atau tidak (point 6 user).
      // Device yang baru boot punya slot kosong; app yang tidak tahu itu
      // akan mengirim SLOT:<n>:USE ke slot kosong - keymap hilang tanpa jejak.
      await syncSlotStatus();
      await switchToDefault();
      return;
    }

    let exe;
    try { exe = await invoke('get_foreground_exe'); } catch (e) { return; }
    // exe null = tidak ada window foreground (mis. layar terkunci). Bukan
    // permintaan perpindahan, jadi jangan apa-apakan.
    if (!exe) return;
    // Companion app punya perilaku KHUSUS: preset KEMBALI ke Default. Ini
    // permintaan user - ketika user pindah ke companion app untuk melihat
    // grid, device harus ikut kembali ke Default.
    //
    // Tanpa jeda, ini justru menjadi sumber osilasi: alt+tab ke companion app
    // -> Default, alt+tab balik -> preset aktif lagi, bolak-balik. Jeda di
    // sini memakai OWN_APP_COOLDOWN_MS yang lebih panjang, karena perpindahan
    // ke companion app hampir selalu sementara - user hanya mau melihat grid
    // sebentar lalu kembali ke aplikasinya.
    const isOwnApp = !!ownExeName && exe === ownExeName;
    const holdMs = isOwnApp ? OWN_APP_COOLDOWN_MS : SWITCH_COOLDOWN_MS;

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
    if (Date.now() - lastSwitchAt < holdMs) return;
    lastSwitchAt = Date.now();
    // Companion app baru saja dipakai. Catat waktunya supaya perpindahan
    // BALIK dari companion app (user kembali ke aplikasinya) tidak langsung
    // memicu upload preset - user biasanya cuma mau lihat grid sebentar.
    if (isOwnApp) lastOwnAppSeenAt = Date.now();

    autoSwitchBusy = true;
    try {
      if (matched) {
        await activatePresetRuntime(matched, exe);
      } else {
        quietOkUntil = Date.now() + 500;
        markPresetSwitch();
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
        await switchToDefault();
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
  lastOwnAppSeenAt = 0;
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