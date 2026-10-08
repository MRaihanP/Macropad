import { SerialPort } from "tauri-plugin-serialplugin";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
// State device (dimensi matriks, layer, keymap, binding knob) tinggal di satu modul
// dengan mutator tervalidasi. Nilai di-import sebagai live binding, jadi kode yang
// hanya membaca tidak berubah; kode yang menulis wajib memakai setter dari sana.
import {
  CAP_LAYERS, ROWS, COLS, NUM_ENCODERS, currentLayer, layerCount, maxLayers,
  mapping, layerNames, encConfig, encParseIdx,
  setCurrentLayer, setNumEncoders, setMapping, setLayerNames, setEncParseIdx, resetEncParse,
  ensureEncConfigSize, emptyLayer,
  applyInfo, applyDumpRow, applyEncRow, applyName, applyLayerEvent, applyEncCount, applyEncIdx,
  reorderLayer,
} from "./device-state.js";
// Helper DOM dan seluruh logika halaman RGB dipisah ke modul sendiri. Halaman RGB
// membaca state dari device (RGB_DUMP/RGB_KEY), bukan dari default app.
import { el, log, escapeHtml } from "./dom.js";
import {
  rgb, renderRgbAll, renderRgbKeyCard, renderRgbGrid, renderRgbPresets, syncRgbDotColors,
  handleRgbLine, initRgbPage, setRgbTransport, hexToRgb, rgbKeyName, ledIndex,
} from "./rgb-page.js";

const TYPE_NAMES = ["NONE", "KEY", "COMBO", "TEXT", "CONSUMER", "APP"];
const ENC_LABELS = { CW: 'Putar searah jarum jam (CW)', CCW: 'Putar berlawanan arah (CCW)', BTN: 'Tombol tekan' };
const MEDIA_MAP = { AudioVolumeUp: 'VOLUP', AudioVolumeDown: 'VOLDOWN', AudioVolumeMute: 'MUTE', MediaPlayPause: 'PLAYPAUSE', MediaTrackNext: 'NEXT', MediaTrackPrevious: 'PREV' };
const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta'];
const MODIFIER_NAMES = ['CTRL', 'SHIFT', 'ALT', 'GUI'];

let port = null;
let lineBuffer = "";
// Handle unlisten dari port.listen(). Plugin serial tidak memanggilnya sendiri saat
// stopListening(), jadi tanpa disimpan di sini setiap reconnect/probe menambah satu
// listener baru. Akibatnya satu chunk dari device diproses N kali dan tiap baris
// terkirim berganda -> desync protokol.
let portUnlisten = null;
// Batas aman untuk buffer baris. Kalau device atau derau tidak pernah mengirim
// newline, buffer akan tumbuh tanpa batas selama sesi.
const LINE_BUFFER_MAX = 64 * 1024;

function resetParserState() {
  lineBuffer = '';
  dumpInProgress = false;
  dumpEncInProgress = false;
  namesInProgress = false;
}
function releasePortListener() {
  const u = portUnlisten;
  portUnlisten = null;
  if (u) { try { u(); } catch (e) { log('[ERROR] Gagal lepas listener: ' + e, 'err'); } }
}
let selected = null;
let dumpInProgress = false, dumpEncInProgress = false, namesInProgress = false;
// Layer yang sedang di-dump, dibaca dari DUMP_BEGIN:<n>. Dipakai supaya isi dump
// masuk ke layer asalnya, bukan ke currentLayer yang mungkin sudah berubah.
let dumpParseLayer = NaN;
let recording = false, recordTokens = [];
let dirty = false;
let ignoreEvtUntil = 0;
let lastDeviceLayerEventAt = 0;

// Kemampuan hardware device, dibaca dari HWINFO. Penting karena firmware PROTOTYPE
// mengirim angka SIMULASI untuk baterai/RGB; app harus menandai agar data palsu
// tidak dibaca sebagai data hardware sungguhan.
let deviceProfile = { connected: false };
function renderDeviceProfileBadge() {
  const b = el('hwProfileBadge'); if (!b) return;
  const sim = deviceProfile.simulated === 1 || battUI.simulated;
  if (!deviceProfile.profile) { b.style.display = 'none'; return; }
  b.style.display = 'inline-flex';
  b.textContent = sim ? `${deviceProfile.profile} - DATA SIMULASI` : deviceProfile.profile;
  b.classList.toggle('sim', !!sim);
  b.title = sim
    ? 'Firmware prototipe mengirim angka simulasi untuk baterai/RGB. Format pesan sama dengan board final, jadi app tidak perlu diubah.'
    : 'Data dibaca langsung dari hardware';
}
// Auto-reconnect
const LAST_PORT_KEY = 'macropad.lastPort';
let portPath = null;                       // path port yang sedang terhubung
let lastGoodPort = null;                   // port terakhir yang berhasil terhubung (dicoba duluan)
try { lastGoodPort = localStorage.getItem(LAST_PORT_KEY); } catch (e) {}
let autoReconnect = true;                  // false setelah user menekan Disconnect sendiri
let autoBusy = false;                      // sedang probe/connect otomatis
let pollBusy = false;
let knownPorts = new Set();
let pingTimer = null;
let retryTimer = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Overlay notifikasi (jendela terpisah di Rust, digambar oleh overlay.html)
// kind: connect | disconnect | layer | preset | key | batt-low | batt-crit | charge | charge-done | info
// Setting notifikasi (disimpan di localStorage, jadi pilihan user bertahan setelah app ditutup)
const SETTINGS_KEY = 'macropad.settings';
const settings = { notifyBasic: true, notifyKeys: true, notifyBattery: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
// Teks notifikasi per key = aksi yang di-bind pada tombol tersebut
const CONSUMER_LABEL = { VOLUP: 'Volume +', VOLDOWN: 'Volume −', MUTE: 'Mute', PLAYPAUSE: 'Play/Pause', NEXT: 'Next', PREV: 'Prev' };
function describeAction(type, value) {
  const v = (value || '').trim();
  switch (type) {
    case 1: case 2: return v;                                          // KEY / COMBO: "1", "CTRL+C"
    case 3: return v.length > 28 ? v.slice(0, 27) + '…' : v;           // TEXT: teksnya
    case 4: return CONSUMER_LABEL[v.toUpperCase()] || v;               // CONSUMER: label media
    case 5: return 'Open ' + v.replace(/\.exe$/i, '');                 // APP: "Open Discord"
    default: return '';
  }
}
function notifyBoundAction(type, value) {
  const t = describeAction(type, value);
  if (t) notify(t, 'key');                                             // tombol kosong: tidak ada notifikasi
}
let notifyErrShown = false;
function notify(text, kind = 'info', opts = {}) {
  if (!opts.force) {
    if (kind === 'key' ? !settings.notifyKeys : (kind === 'batt-low' || kind === 'batt-crit' || kind === 'charge' || kind === 'charge-done') ? !settings.notifyBattery : !settings.notifyBasic) return;
  }
  const hold = opts.hold || (kind === 'key' ? 1000 : 3000);   // notifikasi per key hanya 1 detik
  invoke('notify', { text, kind, hold }).catch(e => {
    console.error('notify gagal:', e);
    if (!notifyErrShown) { notifyErrShown = true; log('[ERROR] Overlay: ' + e, 'err'); }
  });
}
let deviceWasLost = false;

// ==================== ROUTER HALAMAN ====================
function switchPage(name, navOverride) {
  const navName = navOverride || name;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === navName));
  document.querySelectorAll('.page').forEach(p => p.style.display = (p.id === 'page-' + name) ? 'block' : 'none');
}
document.querySelectorAll('.nav-item').forEach(item => {
  item.onclick = async () => {
    const target = item.dataset.page;
    if (editingPresetId) {
      if (target === 'adaptive') return; // sudah "di situ" secara konsep, no-op
      await confirmLeavePresetEditor();
      return;
    }
    switchPage(target);
  };
});
el('btnToggleSidebar').onclick = () => {
  el('sidebar').classList.toggle('collapsed');
  try { localStorage.setItem('sidebarCollapsed', el('sidebar').classList.contains('collapsed')); } catch (e) {}
};
if (localStorage.getItem('sidebarCollapsed') !== 'false') el('sidebar').classList.add('collapsed');

// ==================== MODAL (pengganti prompt()/confirm() bawaan browser) ====================
function showModalBase(titleText, bodyHtml, buttons) {
  return new Promise(resolve => {
    const overlay = el('modalOverlay');
    el('modalTitle').textContent = titleText;
    el('modalBody').innerHTML = bodyHtml;
    const actions = el('modalActions');
    actions.innerHTML = '';
    function close(value) { overlay.classList.remove('show'); document.removeEventListener('keydown', onKey); resolve(value); }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') {
        const okBtn = buttons.find(b => b.primary);
        if (okBtn) close(okBtn.value);
      }
    }
    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      if (btn.primary) b.className = 'primary';
      b.onclick = () => close(btn.value);
      actions.appendChild(b);
    });
    document.addEventListener('keydown', onKey);
    overlay.classList.add('show');
    const input = el('modalInput');
    if (input) { input.focus(); input.select(); }
  });
}

async function showPromptModal(title, label, defaultValue) {
  const bodyHtml = `<div>${escapeHtml(label)}</div><input type="text" id="modalInput" value="${escapeHtml(defaultValue)}">`;
  const result = await showModalBase(title, bodyHtml, [
    { label: 'Cancel', value: null },
    { label: 'OK', value: 'ok', primary: true }
  ]);
  if (result !== 'ok') return null;
  return el('modalInput').value;
}

function showConfirmModal(title, message, confirmLabel) {
  return showModalBase(title, escapeHtml(message), [
    { label: 'Cancel', value: false },
    { label: confirmLabel || 'OK', value: true, primary: true }
  ]);
}

// Firmware menyimpan maksimal 47 byte (MACRO_MAX_LEN 48 termasuk terminator). Potong per karakter utuh.
function clipUtf8(s, maxBytes = 47) {
  const enc = new TextEncoder();
  let out = '', used = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch; used += n;
  }
  return out;
}

// ==================== DAFTAR APLIKASI (dikelola Rust: cache + TTL di file) ====================
let appsView = { names: [], custom: [], scanned_at: 0, ttl_days: 7, consent: false, stale: true };
let scanDeclined = false; // sudah menolak consent di sesi ini: jangan tanya lagi tiap picker dibuka

async function ensureAppList(force = false) {
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

function renderAppPicker() {
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

async function openAppPicker(force = false) {
  el('appSearch').value = '';
  await ensureAppList(force);
  renderAppPicker();
}

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

// ==================== ADAPTIVE KEY BIND — Manajemen Preset ====================
// Adaptive Key Bind aktif secara bawaan. Disimpan ke presets.json lewat
// presets_save, jadi pilihan user bertahan setelah app ditutup.
let presetsData = { masterEnabled: true, presets: [] };
let editingPresetId = null;
let bindableAppsCache = null;
const dumpWaiters = new Map();   // layer -> { resolve, timer }

function presetColor(seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 55%, 42%)`;
}

async function loadPresets() {
  try { presetsData = await invoke('presets_get'); }
  catch (e) { log('[ERROR] Gagal memuat preset: ' + e, 'err'); presetsData = { masterEnabled: true, presets: [] }; }
  el('masterEnabledToggle').checked = presetsData.masterEnabled;
  renderPresetList();
}

el('masterEnabledToggle').onchange = async (e) => {
  presetsData.masterEnabled = e.target.checked;
  await invoke('presets_save', { data: presetsData });
  if (!presetsData.masterEnabled && currentActivePresetId && port && !editingPresetId) {
    await sendLine('CONTEXT:DEFAULT');
    currentActivePresetId = null;
    updateActivePresetLabel();
    log('[ADAPT] Fitur dimatikan, kembali ke Default Preset', null);
  }
};

function renderPresetList() {
  const box = el('presetList');
  box.innerHTML = '';
  if (presetsData.presets.length === 0) {
    box.innerHTML = '<div class="hint">Belum ada preset. Klik "+ Tambah preset" di bawah.</div>';
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
        <button class="small preset-rename">✎</button>
        <button class="small preset-delete">✕</button>
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
    const conflict = presetsData.presets.find(p => p.id !== id && p.enabled && p.exeName === preset.exeName);
    if (conflict) {
      const ok = await showConfirmModal('Ganti preset aktif',
        `"${conflict.name}" sudah aktif untuk aplikasi yang sama. Aktifkan "${preset.name}" dan nonaktifkan "${conflict.name}"?`, 'Ganti');
      if (!ok) { checkboxEl.checked = false; return; }
      conflict.enabled = false;
    }
  }
  preset.enabled = checked;
  await invoke('presets_save', { data: presetsData });

  if (!checked && currentActivePresetId === id && port && !editingPresetId) {
    await sendLine('CONTEXT:DEFAULT');
    currentActivePresetId = null;
    updateActivePresetLabel();
    log('[ADAPT] Preset dinonaktifkan selagi aktif, kembali ke Default Preset', null);
  }

  renderPresetList();
}

async function renamePreset(id) {
  const preset = presetsData.presets.find(p => p.id === id);
  if (!preset) return;
  const name = await showPromptModal('Rename preset', 'Nama preset:', preset.name);
  if (name === null || !name.trim()) return;
  preset.name = name.trim();
  await invoke('presets_save', { data: presetsData });
  renderPresetList();
}

async function deletePreset(id) {
  const preset = presetsData.presets.find(p => p.id === id);

  if (currentActivePresetId === id && port && !editingPresetId) {
    await sendLine('CONTEXT:DEFAULT');
    currentActivePresetId = null;
    updateActivePresetLabel();
  }

  if (!preset) return;
  if (!(await showConfirmModal('Hapus preset', `Hapus preset "${preset.name}"? Tidak bisa dibatalkan.`, 'Hapus'))) return;
  presetsData.presets = presetsData.presets.filter(p => p.id !== id);
  await invoke('presets_save', { data: presetsData });
  renderPresetList();
}

// ---- Picker aplikasi KHUSUS binding preset (Rust: scan_bindable_apps, exe name tanpa perlu app dibuka) ----
async function getBindableApps(force) {
  if (bindableAppsCache && !force) return bindableAppsCache;
  bindableAppsCache = await invoke('scan_bindable_apps');
  return bindableAppsCache;
}

function pickBindableApp() {
  return new Promise(async (resolve) => {
    const overlay = el('modalOverlay');
    el('modalTitle').textContent = 'Pilih aplikasi untuk preset';
    el('modalBody').innerHTML = `
      <input type="text" id="bindAppSearch" placeholder="Cari aplikasi..." style="width:100%; margin-bottom:8px;">
      <div class="app-list" id="bindAppList" style="max-height:240px;"></div>
      <button class="small" id="btnBindAppBrowse" style="margin-top:8px;">Browse .exe manual...</button>`;
    el('modalActions').innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Batal';
    cancelBtn.onclick = () => close(null);
    el('modalActions').appendChild(cancelBtn);

    function close(value) { overlay.classList.remove('show'); document.removeEventListener('keydown', onKey); resolve(value); }
    function onKey(e) { if (e.key === 'Escape') close(null); }
    document.addEventListener('keydown', onKey);

    el('bindAppList').innerHTML = '<div class="hint">Memindai...</div>';
    overlay.classList.add('show');
    const apps = await getBindableApps();

    function renderList(filter) {
      const q = (filter || '').toLowerCase();
      const listEl = el('bindAppList');
      listEl.innerHTML = '';
      const matches = apps.filter(a => a.name.toLowerCase().includes(q)).slice(0, 80);
      if (matches.length === 0) { listEl.innerHTML = '<div class="hint">Tidak ada yang cocok.</div>'; return; }
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
      } catch (e) {}
    };
  });
}

el('btnAddPreset').onclick = async () => {
  const picked = await pickBindableApp();
  if (!picked) return;
  const name = await showPromptModal('Nama preset', 'Nama preset:', picked.name);
  if (name === null || !name.trim()) return;
  const id = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const conflict = presetsData.presets.find(p => p.enabled && p.exeName === picked.exeName);
  const newPreset = { id, name: name.trim(), exeName: picked.exeName, enabled: !conflict, layers: [] };
  presetsData.presets.push(newPreset);
  await invoke('presets_save', { data: presetsData });
  if (conflict) log(`[PRESET] "${newPreset.name}" dibuat nonaktif — "${conflict.name}" sudah aktif untuk app yang sama.`, null);
  renderPresetList();
  openPresetEditor(id);
};

// ---- Masuk/keluar mode edit preset (reuse Home sepenuhnya) ----
// Waiter DUMP dipeta per layer, bukan satu slot global. Dengan satu slot, dump
// latar belakang (mis. dari EVT:LAYER:) yang selesai lebih dulu akan me-resolve
// waiter packer, sehingga packCurrentAsPresetLayers() membaca mapping yang belum
// terisi penuh dan menyimpan preset setengah jadi ke disk.
//
// Tiap layer boleh punya BANYAK waiter (Set, bukan satu entri): kalau hanya satu
// entri per layer, waiter kedua akan menggantikan yang pertama tanpa
// me-resolve-nya, sehingga pemanggil pertama menggantung selamanya.
// Tiap waiter juga punya timeout supaya tidak menggantung kalau device menjawab
// [ERROR] alih-alih DUMP_END (mis. layerCount UI basi setelah RESET di luar app).
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
      log('[ERROR] Timeout menunggu DUMP_END untuk layer ' + key, 'err');
      entry.resolve(false);
    }, timeoutMs || 3000);
    if (!dumpWaiters.has(key)) dumpWaiters.set(key, new Set());
    dumpWaiters.get(key).add(entry);
  });
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
    layers.push({ name: layerNames[l] || ('Layer ' + l), keys, encCw, encCcw, encBtn });
  }
  return layers;
}

async function openPresetEditor(id) {
  if (!port) { log('[ERROR] Hubungkan device dulu untuk edit preset', 'err'); return; }
  const preset = presetsData.presets.find(p => p.id === id);
  if (!preset) return;
  editingPresetId = id;
  currentActivePresetId = null; // sedang DIEDIT, bukan lagi "auto-matched" — biar label & poll loop tidak bingung
  updateActivePresetLabel();
  el('presetEditName').textContent = preset.name;
  el('presetEditBanner').style.display = 'flex';
  el('btnSave').style.display = 'none'; // SAVE (flash) tidak relevan selagi edit App Preset

  switchPage('home', 'adaptive'); // tampilkan Home, tapi highlight sidebar tetap di Adaptive

  await sendLine('CONTEXT:APP:NEW');
  await replayPresetLayers(preset);
  await sendLine('LAYER:0');
  await sendLine('INFO');
  await sendLine('DUMPENC');
}

async function exitPresetEditor() {
  editingPresetId = null;
  el('presetEditBanner').style.display = 'none';
  el('btnSave').style.display = '';
  resetEditorState();
  await sendLine('CONTEXT:DEFAULT');
  await sendLine('INFO');
  await sendLine('DUMPENC');
  switchPage('adaptive');
  renderPresetList();

  updateActivePresetLabel();
}

async function confirmLeavePresetEditor() {
  if (!dirty) { await exitPresetEditor(); return; }
  const choice = await showModalBase(
    'Ada perubahan belum disimpan',
    'Preset ini punya perubahan yang belum disimpan. Simpan dulu sebelum keluar?',
    [
      { label: 'Cancel', value: 'cancel' },
      { label: "Don't Save", value: 'discard' },
      { label: 'Save', value: 'save', primary: true }
    ]
  );
  if (choice === 'save') {
    const preset = presetsData.presets.find(p => p.id === editingPresetId);
    if (preset) {
      await fetchAllLayersForPacking();
      preset.layers = packCurrentAsPresetLayers();
      await invoke('presets_save', { data: presetsData });
      log(`[PRESET] "${preset.name}" tersimpan`, 'ok');
    }
    dirty = false;
    await exitPresetEditor();
  } else if (choice === 'discard') {
    dirty = false;
    await exitPresetEditor();
  }
  // 'cancel'/Escape: tidak melakukan apapun, tetap di editor
}

el('btnPresetEditDone').onclick = async () => {
  if (!editingPresetId) return;
  const preset = presetsData.presets.find(p => p.id === editingPresetId);
  if (preset) {
    await fetchAllLayersForPacking();
    preset.layers = packCurrentAsPresetLayers();
    await invoke('presets_save', { data: presetsData });
    log(`[PRESET] "${preset.name}" tersimpan (${preset.layers.length} layer)`, 'ok');
  }
  await exitPresetEditor();
};
el('btnPresetEditCancel').onclick = async () => {
  if (await showConfirmModal('Batalkan edit', 'Perubahan pada preset ini TIDAK akan disimpan. Yakin batal?', 'Batal edit')) {
    await exitPresetEditor();
  }
};

// ==================== ADAPTIVE KEY BIND — Runtime Auto-Switch ====================
let currentActivePresetId = null;
let focusedExeLast = null;
let pendingFocusSince = 0;
let escapeFrozenForExe = null;
let autoSwitchBusy = false;
const FOCUS_DEBOUNCE_MS = 150;
const FOCUS_POLL_MS = 120;

function syncGlobalToggles() {
  el('masterEnabledToggle').checked = presetsData.masterEnabled;
  if (el('globalAdaptiveToggle')) el('globalAdaptiveToggle').checked = presetsData.masterEnabled;
  if (el('globalRgbToggle')) el('globalRgbToggle').checked = rgb.enabled;
  // Firmware belum punya perintah sleep sama sekali, jadi kontrol ini dikunci
  // dengan penjelasan. Sebelumnya di-enable tapi tanpa handler, jadi user
  // bisa memilih nilai lalu replikasi terjadi diam-diam tanpa efek apa pun.
  const sleepSel = el('sleepTimeoutSelect');
  if (sleepSel) {
    sleepSel.disabled = true;
    sleepSel.title = 'Belum didukung firmware (perintah sleep belum ada)';
  }
}

// Status baterai & charger. Sumbernya firmware lewat EVT:BATT / EVT:CHG - bukan
// angka buatan app. Pada board PROTOTYPE firmware mengirim angka simulasi, dan
// deviceProfile.simulated membuat UI menandai demikian supaya tidak tertukar
// dengan data hardware asli.
let battUI = { pct: null, mv: null, charging: false, usb: false, chargeState: 0, simulated: false };
// Level ambang baterai yang terakhir dinotifikasi ('low' | 'crit' | null).
let battNotifLevel = null;
function updateBatteryUI() {
  const ind = el('battInd'); if (!ind) return;
  if (battUI.pct === null) {
    el('battPct').textContent = '--';
    el('battFill').style.transform = 'scaleX(0.02)';
    el('battBolt').style.display = 'none';
    ind.classList.remove('low', 'crit');
    return;
  }
  el('battPct').textContent = battUI.pct + '%';
  el('battFill').style.transform = `scaleX(${Math.max(0.02, battUI.pct / 100)})`;
  ind.classList.toggle('low', battUI.pct <= 20 && battUI.pct > 10);
  ind.classList.toggle('crit', battUI.pct <= 10);
  el('battBolt').style.display = battUI.charging ? 'block' : 'none';
  ind.title = battUI.simulated
    ? `Data SIMULASI (firmware prototipe)${battUI.mv !== null ? ` - ${battUI.mv} mV` : ''}`
    : (battUI.mv !== null ? `${battUI.mv} mV` : 'Baterai');
  // Notifikasi baterai lemah hanya saat ambang baru dil-crossing sekali, bukan
  // setiap EVT:BATT (yang datang tiap 5 detik). Tanpa ini notifikasi muncul terus.
  // Reset saat baterai naik lagi atau saat sedang mengecas supaya peringatan
  // bisa berbunyi lagi di siklus berikutnya.
  const lvl = battUI.pct <= 10 ? 'crit' : (battUI.pct <= 20 ? 'low' : 'ok');
  if (battUI.charging || lvl === 'ok') battNotifLevel = null;
  else if (lvl !== battNotifLevel) {
    battNotifLevel = lvl;
    if (lvl === 'crit') notify(`Baterai kritis: ${battUI.pct}%`, 'batt-crit', { hold: 8000 });
    else notify(`Baterai lemah: ${battUI.pct}%`, 'batt-low', { hold: 6000 });
  }
}
setTimeout(updateBatteryUI, 0);
function updateActivePresetLabel() {
  const label = el('deviceActivePresetLabel');
  if (!label) return;
  if (currentActivePresetId) {
    const p = presetsData.presets.find(x => x.id === currentActivePresetId);
    label.textContent = p ? p.name : 'App Preset';
  } else {
    label.textContent = 'Default';
  }
}

// Replay layer demi layer ke device — dipakai SAMA baik pas edit (openPresetEditor)
// maupun runtime auto-switch (activatePresetRuntime), biar tidak dobel logic.
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

// ---- Cache slot di firmware: preset di-upload SEKALI (batch), switch berikutnya = 1 command ----
const APP_SLOTS = 6;                       // harus sama dengan APP_SLOTS di firmware
let slotTable = Array(APP_SLOTS).fill(null); // {id, sig, used}
let slotTick = 0;
let quietOkUntil = 0;                      // sembunyikan balasan [OK]/[LAYER] selama batch runtime

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

// Kirim banyak baris dalam sedikit write (bukan 1 write per baris).
async function sendBatch(lines) {
  if (!port) return;
  let chunk = '';
  for (const ln of lines) {
    if (chunk.length + ln.length + 1 > 900) { await writeRaw(chunk); chunk = ''; }
    chunk += ln + '\n';
  }
  if (chunk) await writeRaw(chunk);
}
async function writeRaw(str) {
  try { await port.write(str); }
  catch (e) { log('[ERROR] Gagal kirim: ' + e, 'err'); await handleDeviceLost(); }
}

async function activatePresetRuntime(preset, exe) {
  const sig = presetSig(preset);
  let slot = slotTable.findIndex(s => s && s.id === preset.id);
  const cached = slot >= 0 && slotTable[slot].sig === sig;
  if (slot < 0) {
    slot = 0; let best = Infinity;                       // slot kosong dulu, kalau penuh buang yang paling lama dipakai
    slotTable.forEach((s, i) => { const u = s ? s.used : -1; if (u < best) { best = u; slot = i; } });
  }
  quietOkUntil = Date.now() + 500;
  const lines = cached ? [`SLOT:${slot}:USE`] : buildPresetLines(preset, slot);
  lines.push('INFO', 'DUMPENC');
  slotTable[slot] = null;                                // anggap belum valid sampai write sukses
  await sendBatch(lines);
  slotTable[slot] = { id: preset.id, sig, used: ++slotTick };
  currentActivePresetId = preset.id;
  updateActivePresetLabel();
  log(`[ADAPT] Preset aktif: "${preset.name}" (${exe})${cached ? ' · cache' : ''}`, 'ok');
  notify(`Preset: ${preset.name}`, 'preset');
}

let pollInFlight = false;
async function pollFocusedApp() {
  if (pollInFlight) return;
  if (!presetsData.masterEnabled || !port || editingPresetId || autoSwitchBusy) return;
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
        log('[ADAPT] Kembali ke Default Preset', null);
        notify('Preset: Default', 'preset');
      }
    } finally { autoSwitchBusy = false; }
  } finally { pollInFlight = false; }
}

function resetAdaptiveRuntimeState() {
  slotTable = Array(APP_SLOTS).fill(null);
  currentActivePresetId = null; focusedExeLast = null; escapeFrozenForExe = null; pendingFocusSince = 0;
  updateActivePresetLabel();
}

setInterval(pollFocusedApp, FOCUS_POLL_MS);

// ==================== PORT LIST & KONEKSI ====================
async function listPortPaths() {
  const ports = await SerialPort.available_ports();
  const list = Array.isArray(ports) ? ports : Object.keys(ports);
  return list.map(p => typeof p === 'string' ? p : (p.path || p.name || JSON.stringify(p)));
}

// Isi dropdown. `paths` opsional (kalau sudah punya daftar), `quiet` = jangan log kalau kosong.
async function refreshPorts(paths, quiet) {
  try {
    const list = paths || await listPortPaths();
    knownPorts = new Set(list);
    const sel = el('portSelect');
    const keep = sel.value;
    sel.innerHTML = '';
    list.forEach(value => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = value;
      sel.appendChild(opt);
    });
    if (keep && list.includes(keep)) sel.value = keep;
    if (list.length === 0 && !quiet) log('[LOG] Tidak ada port terdeteksi. Klik ↻ setelah colok device.', 'err');
    return list;
  } catch (e) { log('[ERROR] Gagal ambil daftar port: ' + e, 'err'); return []; }
}

async function probeWhoAmI(path) {
  let temp, tempUnlisten = null, probeTimer = null;
  try {
    temp = new SerialPort({ path, baudRate: 115200, size: 1024 });
    await temp.open();
    await temp.setDataTerminalReady(true);
    await temp.setRequestToSend(true);
    await temp.startListening();

    const result = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      // listen() mengembalikan UnlistenFn; WAJIB disimpan dan dipanggil, kalau tidak
      // setiap probe menambah listener permanen pada event read port tersebut.
      tempUnlisten = null;
      temp.listen((data) => { if (data.includes('WHOAMI:MacroPad')) finish(true); })
        .then((u) => { tempUnlisten = u; })
        .catch(() => finish(false));
      temp.write('WHOAMI\n').catch(() => finish(false));
      probeTimer = setTimeout(() => finish(false), 700);
    });
    return result;
  } catch (e) {
    return false;
  } finally {
    if (probeTimer) clearTimeout(probeTimer);
    if (tempUnlisten) { try { tempUnlisten(); } catch (e) {} }
    try { if (temp) { await temp.stopListening(); await temp.close(); } } catch (e) {}
  }
}

// Cari MacroPad lalu connect. `only` = daftar port yang boleh di-probe (dipakai saat ada port BARU muncul,
// supaya port lama yang bukan MacroPad tidak ikut di-probe ulang). Tanpa `only` = semua port.
// Port terakhir yang berhasil selalu dicoba duluan.
async function tryAutoConnect(verbose, only) {
  if (autoBusy || port) return false;
  autoBusy = true;
  try {
    const all = await refreshPorts(null, !verbose);
    if (all.length === 0) { if (verbose) log('[AUTO] Tidak ada port sama sekali.', 'err'); return false; }
    const paths = only ? all.filter(p => only.includes(p)) : all;
    if (paths.length === 0) return false;
    const ordered = [...paths].sort((a, b) => (b === lastGoodPort) - (a === lastGoodPort));

    log('[AUTO] Mencari MacroPad...', null);
    for (const path of ordered) {
      const ok = await probeWhoAmI(path);
      if (!ok) continue;
      el('portSelect').value = path;
      await sleep(400); // beri jeda, Windows perlu lepas handle port dulu
      if (await connect()) { log('[AUTO] Terhubung otomatis ke ' + path, 'ok'); return true; }
      log('[AUTO] Gagal reconnect ke ' + path + ', coba lagi...', 'err');
      await sleep(400);
      if (await connect()) { log('[AUTO] Terhubung otomatis ke ' + path + ' (percobaan ke-2)', 'ok'); return true; }
    }
    if (verbose) log('[AUTO] MacroPad tidak ditemukan otomatis. Pilih port manual, klik Connect.', 'err');
    return false;
  } finally { autoBusy = false; }
}

// Retry terbatas (maks. 2x, jeda 3 dtk lalu 6 dtk) untuk device yang baru muncul tapi belum siap menjawab
// (mis. ESP32 masih booting saat Windows baru start). Bukan polling terus-menerus.
function scheduleRetry(only, attempt = 1) {
  clearTimeout(retryTimer);
  if (attempt > 2) return;
  retryTimer = setTimeout(async () => {
    if (port || !autoReconnect) return;
    const ok = await tryAutoConnect(false, only);
    if (!ok) scheduleRetry(only, attempt + 1);
  }, attempt * 3000);
}

// Tombol ↻ dan start awal
async function autoDetect() {
  autoReconnect = true;
  clearTimeout(retryTimer);
  if (port) { await refreshPorts(); return; }
  const ok = await tryAutoConnect(true);
  if (!ok && knownPorts.size) scheduleRetry([...knownPorts]);
}

// Tutup editor + hentikan perekaman keyboard. Tanpa ini listener keydown (preventDefault) tetap aktif
// walau #app tersembunyi, dan mengunci keyboard setelah device terputus saat editor terbuka.
function resetEditorState() {
  stopRecordingContinuous();
  recordTokens = [];
  selected = null;
  el('editPanel').style.display = 'none';
}

// Device tercabut / hilang: bersihkan state supaya reconnect bisa jalan.
// Dipanggil baik dari pollPorts (path hilang dari daftar) maupun dari sendLine (gagal tulis) —
// yang kedua perlu untuk kasus cabut-colok cepat ke nomor COM yang sama, dimana daftar port
// tidak sempat kelihatan berubah di antara dua polling 2 detik.
async function handleDeviceLost() {
  if (!port) return;
  log('[AUTO] Device terputus.', 'err');
  deviceWasLost = true;
  notify('Device terputus', 'disconnect');
  const p = port, lostPath = portPath;
  port = null; portPath = null; dirty = false; // RAM device hilang bersama daftar port; tidak ada yang tertunda
  resetParserState();
  resetAdaptiveRuntimeState();
  stopPing();
  resetEditorState();
  setConnected(false);
  releasePortListener();
  try { await Promise.race([(async () => { await p.stopListening(); await p.close(); })(), sleep(1000)]); } catch (e) {}
  // Path ini mungkin tidak pernah "hilang" dari enumerasi OS (nomor COM sama, cabut-colok cepat),
  // jadi selain menunggu pollPorts mendeteksi lewat added/removed, langsung coba lagi path ini juga.
  if (lostPath && autoReconnect) { knownPorts.delete(lostPath); scheduleRetry([lostPath]); }
}

// Pantau daftar port tiap 2 dtk (enumerasi murah). Probe HANYA jalan kalau ada port BARU muncul,
// tidak pernah saat daftar tetap atau hanya berkurang.
async function pollPorts() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const paths = await listPortPaths();
    if (port && portPath && !paths.includes(portPath)) await handleDeviceLost();
    if (autoBusy) return; // biarkan selesai; perubahan dihitung di putaran berikutnya
    const added = paths.filter(p => !knownPorts.has(p));
    const removed = [...knownPorts].some(p => !paths.includes(p));
    if (!added.length && !removed) return;
    await refreshPorts(paths, true);
    if (added.length && !port && autoReconnect) {
      const ok = await tryAutoConnect(false, added); // hanya port yang baru muncul
      if (!ok) scheduleRetry(added);
    }
  } catch (e) {
  } finally { pollBusy = false; }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => { if (port) sendLine('PING'); }, 1500);
}
function stopPing() { clearInterval(pingTimer); pingTimer = null; }

function setConnected(state) {
  el('dot').classList.toggle('on', state);
  el('statusText').textContent = state ? 'Connected' : 'Not connected';
  el('btnConnect').textContent = state ? 'Disconnect' : 'Connect';
  el('app').style.display = state ? 'block' : 'none';
  if (!state) {
    // Jangan biarkan angka device sebelumnya tertinggal di UI setelah putus.
    deviceProfile = { connected: false };
    battUI = { pct: null, mv: null, charging: false, usb: false, chargeState: 0, simulated: false };
    renderDeviceProfileBadge();
    updateBatteryUI();
  }
}

async function sendLine(str) {
  if (!port) return;
  try { await port.write(str + "\n"); }
  catch (e) {
    log('[ERROR] Gagal kirim: ' + e, 'err');
    await handleDeviceLost(); // tulis gagal = koneksi sudah putus di level OS, jangan tunggu polling
  }
}

function handleIncomingChunk(data) {
  lineBuffer += data;
  // Kalau tidak ada newline sama sekali, buffer tumbuh tanpa batas dan handleLine
  // tidak pernah dipanggil sehingga tidak ada yang bisa pulih. Buang sisa dan reset
  // parser, lalu lanjut dari newline terakhir agar koneksi berikutnya tetap sinkron.
  if (lineBuffer.length > LINE_BUFFER_MAX) {
    log('[ERROR] Buffer baris melebihi ' + LINE_BUFFER_MAX + ' byte, parser di-reset', 'err');
    resetParserState();
    const nl = lineBuffer.lastIndexOf('\n');
    lineBuffer = nl >= 0 ? lineBuffer.slice(nl + 1) : '';
  }
  let idx;
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    handleLine(lineBuffer.slice(0, idx));
    lineBuffer = lineBuffer.slice(idx + 1);
  }
}

function handleLine(line) {
  line = line.trim();
  if (!line) return;

  // ---- Notifikasi overlay dari event hardware ----
  let mm;
  if ((mm = line.match(/^\[LAYER\] Pindah ke layer (\d+)/))) {
    const n = parseInt(mm[1]);
    const ap = currentActivePresetId ? presetsData.presets.find(x => x.id === currentActivePresetId) : null;
    const pname = ap ? ap.name : 'Default';
    const lname = (ap ? ap.layers?.[n]?.name : layerNames[n]) || ('Layer ' + n);
    notify(`${pname} · ${lname}`, 'layer');
  } else if ((mm = line.match(/^\[KEY\] (\d+),(\d+),(\d+),(\d+),(.*)$/))) {
    // Format ringkas dari firmware: layer,row,col,type,value. Notifikasi hanya
    // memakai type + value; posisi tombol tetap tampil di panel log.
    notifyBoundAction(parseInt(mm[4]), mm[5]);
  } else if ((mm = line.match(/^EVT:ENC:(\d+):(CW|CCW)$/))) {
    const a = encConfig[+mm[1]]?.[mm[2]];
    if (a) notifyBoundAction(a.type, a.value);
  } else if ((mm = line.match(/^\[ENC_BTN\] Knob (\d+):/)) || line.startsWith('[ENC_BTN] Aksi terkonfigurasi')) {
    const a = encConfig[mm ? +mm[1] : 0]?.BTN;                         // knob utama (index 0) mencetak tanpa nomor
    if (a) notifyBoundAction(a.type, a.value);
  }
  if (Date.now() < quietOkUntil && (line.startsWith('[OK]') || line.startsWith('[LAYER]'))) return;

  if (line.startsWith('EVT:APP:')) {
    if (Date.now() < ignoreEvtUntil) { log('[APP] Event lama diabaikan'); return; }
    const name = line.substring(8);
    invoke('launch_app', { name })
      .then(n => log('[APP] Membuka: ' + n, 'ok'))
      .catch(e => log('[ERROR] ' + e, 'err'));
    return;
  }

  if (line === 'EVT:ESCAPE') {
    if (editingPresetId) {
      sendLine('CONTEXT:APP:RESUME');
      log('[PRESET] Gestur escape diabaikan selama mode edit (draft tetap aman).', null);
    } else if (currentActivePresetId) {
      escapeFrozenForExe = focusedExeLast;
      notify('Preset: Default', 'preset');
      currentActivePresetId = null;
      updateActivePresetLabel();
      log(`[ADAPT] Escape manual — auto-switch dibekukan untuk "${focusedExeLast}" sampai window lain difokuskan.`, null);
    }
    return;
  }

  if (line.startsWith('EVT:LAYER:')) {
    const n = parseInt(line.substring(10));
    lastDeviceLayerEventAt = Date.now(); // dipakai nanti buat pause auto-switch
    if (n !== currentLayer && applyLayerEvent(n)) {
      // Device sudah pindah layer dengan sendirinya (long-press knob), jadi jangan
      // kirim LAYER: balik - cukup baca isinya.
      renderTabs();
      loadLayer(n);
    }
    return;
  }

  if (line.startsWith('DUMP_BEGIN:')) { dumpInProgress = true; dumpParseLayer = parseInt(line.substring(11)); return; }
  if (line === 'DUMP_END') {
    dumpInProgress = false; renderGrid();
    // Resolve waiter milik layer yang benar-benar didump.
    const done = (Number.isNaN(dumpParseLayer) ? currentLayer : dumpParseLayer);
    dumpParseLayer = NaN;
    const set = dumpWaiters.get(done);
    if (set) [...set].forEach(e => e.resolve(true));
    return;
  }
  if (dumpInProgress) {
    const p = line.split(',');
    // Semua index dari device harus divalidasi. Tanpa ini, baris korup seperti
    // "99,0,1,x" membuat mapping[..][99] undefined dan penugasannya melempar
    // TypeError DI DALAM callback serial, yang ditangkap plugin dan ditelan. Akibatnya
    // parser mati di tengah stream dan semua baris berikutnya dimakan sebagai payload
    // DUMP - desync permanen sampai reconnect.
    // Validasi lengkap (indeks, tipe, alokasi layer) ada di device-state.js.
    // Nilai boleh mengandung koma (macro TEXT), jadi field terakhir adalah sisa baris.
    if (p.length >= 4) {
      const layer = (Number.isNaN(dumpParseLayer) ? currentLayer : dumpParseLayer);
      const applied = applyDumpRow(layer, parseInt(p[0]), parseInt(p[1]), parseInt(p[2]), p.slice(3).join(','), log);
      if (!applied) log('[ERROR] Baris DUMP tidak valid, dilewati: ' + line, 'err');
    }
    return;
  }
  if (line.startsWith('ENC_BEGIN')) {
    dumpEncInProgress = true;
    const m = line.match(/count=(\d+)/);
    if (m && applyEncCount(parseInt(m[1]), log)) el('deviceEncLabel').textContent = String(NUM_ENCODERS);
    return;
  }
  if (line === 'ENC_END') { dumpEncInProgress = false; renderEncoderList(); return; }
  if (dumpEncInProgress) {
    if (line.startsWith('IDX:')) { applyEncIdx(parseInt(line.substring(4))); return; }
    const p = line.split(',');
    // Allowlist kunci ada di applyEncRow - tanpa itu device bisa mengirim
    // "__proto__" yang menjadi prototype assignment pada objek knob.
    if (p.length >= 3) applyEncRow(encParseIdx, p[0], parseInt(p[1]), p.slice(2).join(','), log);
    return;
  }
  if (line.startsWith('HWINFO:')) {
    deviceProfile = { connected: true };
    line.substring(7).split(',').forEach(p => {
      const eq = p.indexOf('='); if (eq < 0) return;
      const k = p.substring(0, eq), v = p.substring(eq + 1);
      deviceProfile[k] = /^-?\d+$/.test(v) ? parseInt(v) : v;
    });
    if (deviceProfile.encoders) setNumEncoders(deviceProfile.encoders);
    battUI.simulated = deviceProfile.simulated === 1;
    log(`[HW] Profil ${deviceProfile.profile} - rgb=${deviceProfile.rgb} vdiv=${deviceProfile.vdiv} chg=${deviceProfile.chg}` + (battUI.simulated ? ' (data simulasi)' : ''));
    renderDeviceProfileBadge();
    updateBatteryUI();
    return;
  }
  if (line.startsWith('EVT:BATT:')) {
    const kv = {}; line.substring(9).split(',').forEach(p => { const eq = p.indexOf('='); if (eq > 0) kv[p.substring(0, eq)] = p.substring(eq + 1); });
    if (kv.pct !== undefined) battUI.pct = parseInt(kv.pct);
    if (kv.mv !== undefined) battUI.mv = parseInt(kv.mv);
    if (kv.charging !== undefined) battUI.charging = kv.charging === '1';
    if (kv.usb !== undefined) battUI.usb = kv.usb === '1';
    if (kv.profile !== undefined) deviceProfile.profile = kv.profile;
    updateBatteryUI();
    return;
  }
  if (line.startsWith('EVT:CHG:')) {
    const m = line.match(/state=(\d+)/);
    if (m) {
      const st = parseInt(m[1]);
      battUI.chargeState = st;
      battUI.charging = st === 1;
      updateBatteryUI();
      // Penting: kind harus salah satu dari yang dipakai filter notifikasi baterai.
      // Sebelumnya dipakai 'batt' yang TIDAK ada di daftar filter, sehingga notifikasi
      // baterai ikut dikendalikan toggle "Notifikasi dasar", bukan "Notifikasi baterai".
      if (st === 1) notify('Baterai: mulai mengecas', 'charge', { hold: 5000 });
      else if (st === 2) notify('Baterai: cas selesai', 'charge-done', { hold: 5000 });
      // state 0 (charger dicabut) sengaja tidak dinotifikasi supaya tidak membising.
    }
    return;
  }
  // Baris RGB ditangani oleh modul halaman RGB (state-nya dibaca dari device).
  if (handleRgbLine(line, log)) return;
  if (line === 'NAMES_BEGIN') { namesInProgress = true; return; }
  if (line === 'NAMES_END') { namesInProgress = false; renderTabs(); return; }
  if (namesInProgress) {
    // Nama layer boleh mengandung koma, jadi field terakhir adalah sisa baris.
    const idx = line.indexOf(',');
    if (idx > -1) {
      if (!applyName(parseInt(line.substring(0, idx)), line.substring(idx + 1), log))
        log('[ERROR] Baris NAMES tidak valid, dilewati: ' + line, 'err');
    }
    return;
  }
  if (line.startsWith('INFO:')) {
    // Nilai dari device tidak boleh dipercaya buta: parseInt("abc") = NaN, dan
    // ROWS = NaN membuat Array.from({length: NaN}) -> [] sehingga renderGrid melempar.
    // Validasi + penulisan ada di applyInfo() (device-state.js).
    const kv = {};
    line.substring(5).split(',').forEach(p => {
      const eq = p.indexOf('='); if (eq < 0) return;
      kv[p.substring(0, eq)] = p.substring(eq + 1);
    });
    applyInfo(kv, { log });
    el('deviceEncLabel').textContent = String(NUM_ENCODERS);
    el('deviceMatrixLabel').textContent = ROWS + ' × ' + COLS;
    renderTabs(); loadLayer(currentLayer); sendLine('DUMPNAMES');
    return;
  }
  if (line.startsWith('WHOAMI:')) {
    const parts = line.split(':');
    el('deviceNameLabel').textContent = parts[1] || 'MacroPad';
    return;
  }
  if (line === 'PONG') return;   // sembunyikan PONG dari log

  if (line.startsWith('[ERROR]')) log(line, 'err');
  else if (line.startsWith('[OK]')) log(line, 'ok');
  else log(line);
}

async function connect() {
  const path = el('portSelect').value;
  if (!path) { log('[ERROR] Pilih port dulu (klik ↻ kalau kosong)', 'err'); return false; }
  try {
    port = new SerialPort({ path, baudRate: 115200, size: 1024 });
    await port.open();
    await port.setDataTerminalReady(true);
    await port.setRequestToSend(true);
    await port.startListening();
    portUnlisten = await port.listen((data) => handleIncomingChunk(data));
  } catch (e) {
    log('[ERROR] Gagal membuka port: ' + e, 'err');
    port = null; return false;
  }
  portPath = path;
  lastGoodPort = path;
  try { localStorage.setItem(LAST_PORT_KEY, path); } catch (e) {}
  setConnected(true);
  notify(deviceWasLost ? 'Terhubung kembali' : 'Terhubung ke companion', 'connect');
  deviceWasLost = false;
    switchPage('home'); // sesuai poin 4: Home selalu tampil pas pertama kali connect
  startPing();
  ignoreEvtUntil = Date.now() + 800;
  await sendLine('PING');
  // HWINFO wajib dikirim pertama: memberi tahu profile, jumlah knob, dan apakah angka
// baterai/RGB yang akan datang adalah simulasi (prototipe) atau hardware asli.
setTimeout(async () => {
    await sendLine('WHOAMI');
    await sendLine('HWINFO');
    await sendLine('INFO');
    await sendLine('DUMPENC');
    await sendLine('BATT');
    await sendLine('RGB:DUMP');
  }, 400);
  return true;
}

async function disconnect(manual) {
  if (manual) {
    autoReconnect = false; // user sengaja memutus: jangan disambung otomatis lagi
    deviceWasLost = false;
    notify('Koneksi diputus', 'disconnect');
    log('[LOG] Auto-reconnect dijeda. Klik Connect atau ↻ untuk mengaktifkan lagi.');
  }
  stopPing();
  // Parser state harus ikut dibersihkan di jalur manual, sama seperti di
  // handleDeviceLost(). Sebelumnya Disconnect manual meninggalkan baris parsial di
  // lineBuffer dan dumpInProgress = true, sehingga byte pertama device berikutnya
  // menempel pada baris rusak itu.
  resetParserState();
  releasePortListener();
  try { if (port) { await port.stopListening(); await port.close(); } } catch (e) {}
  port = null; portPath = null;
  resetAdaptiveRuntimeState();
  resetEditorState();
  setConnected(false);
}

// ==================== RENDER: LAYER, GRID, ENCODER ====================
let tabDragMoved = false;

function renderTabs() {
  const tabs = el('tabs');
  tabs.innerHTML = '';
  el('deviceLayerLabel').textContent = layerNames[currentLayer] || ('Layer ' + currentLayer);
  for (let l = 0; l < layerCount; l++) {
    const t = document.createElement('div');
    t.className = 'tab' + (l === currentLayer ? ' active' : '');
    t.textContent = layerNames[l] || ('Layer ' + l);
    t.style.touchAction = 'none';
    t.onclick = () => { if (tabDragMoved) return; switchLayer(l); };
    t.onpointerdown = (e) => startTabDrag(e, t, l);
    tabs.appendChild(t);
  }
  el('btnDelLayer').disabled = layerCount <= 1;
  el('btnAddLayer').disabled = layerCount >= maxLayers;
}

// Drag pakai Pointer Events (bukan native HTML5 DnD) supaya nggak ke-capture
// oleh fitur window-level drag-drop Tauri. Tab yang di-drag ikut geser visual
// mengikuti cursor, dan tab-tab lain di antara posisi asal & tujuan ikut geser
// (menghindar) untuk mengisi/membuka ruang, seperti reorder list pada umumnya.
function startTabDrag(e, tabEl, index) {
  if (e.button !== undefined && e.button !== 0) return; // hanya klik kiri
  const tabs = el('tabs');
  const startX = e.clientX;
  const others = Array.from(tabs.children).filter(c => c !== tabEl);
  const rects = others.map(c => c.getBoundingClientRect());
  const dragRect = tabEl.getBoundingClientRect();
  const gapPx = parseFloat(getComputedStyle(tabs).columnGap) || 10;
  const shiftAmount = dragRect.width + gapPx;
  tabDragMoved = false;

  tabEl.setPointerCapture(e.pointerId);
  tabEl.classList.add('dragging');
  document.body.classList.add('no-select');

  function computeTargetRealIndex(clientX) {
    if (!rects.length) return index;
    if (clientX <= rects[0].left) return 0;
    if (clientX >= rects[rects.length - 1].right) return layerCount - 1;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (clientX >= r.left && clientX <= r.right) return i < index ? i : i + 1;
    }
    return index;
  }

  function onMove(ev) {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 4) tabDragMoved = true;
    tabEl.style.transform = `translateX(${dx}px)`;

    const targetRealIndex = computeTargetRealIndex(ev.clientX);
    others.forEach((c, i) => {
      const otherRealIndex = i < index ? i : i + 1;
      let shift = 0;
      if (targetRealIndex > index && otherRealIndex > index && otherRealIndex <= targetRealIndex) shift = -shiftAmount;
      else if (targetRealIndex < index && otherRealIndex < index && otherRealIndex >= targetRealIndex) shift = shiftAmount;
      c.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  }

  function onUp(ev) {
    tabEl.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    tabEl.classList.remove('dragging');
    document.body.classList.remove('no-select');

    const targetRealIndex = computeTargetRealIndex(ev.clientX);

    if (tabDragMoved && targetRealIndex !== index) {
      // Susun ulang node tab di DOM ke urutan barunya SEKARANG (bukan nunggu
      // roundtrip device), supaya transform yang di-nol-kan di bawah langsung
      // "landing" ke posisi akhir yang benar tanpa balik dulu ke posisi lama.
      const allTabs = Array.from(tabs.children); // urutan lama, tabEl masih di 'index'
      allTabs.splice(index, 1);
      allTabs.splice(targetRealIndex, 0, tabEl);
      allTabs.forEach(node => tabs.appendChild(node));
      allTabs.forEach((node, i) => node.classList.toggle('active', i === targetRealIndex));

      // Optimistic update data lokal biar konsisten dgn urutan DOM baru,
      // sebelum device benar-benar konfirmasi lewat INFO
      reorderLayer(index, targetRealIndex);
      setCurrentLayer(targetRealIndex);
      renderGrid();

      moveLayerTo(index, targetRealIndex); // sinkron ke device di background
    }

    // Nol-kan transform SETELAH reorder DOM di atas, supaya animasi "landing"-nya
    // menuju posisi yang sudah benar, bukan balik ke posisi lama dulu.
    tabEl.style.transform = '';
    others.forEach(c => { c.style.transform = ''; });

    setTimeout(() => { tabDragMoved = false; }, 0);
  }

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// Geser layer dari srcIndex ke targetIndex dengan mengirim MOVELAYER berturut-turut
// (protokol device cuma punya perintah geser satu langkah kiri/kanan pada layer yang sedang aktif)
async function moveLayerTo(srcIndex, targetIndex) {
  if (srcIndex === targetIndex) return;
  dirty = true;
  await sendLine('LAYER:' + srcIndex);
  const dir = targetIndex > srcIndex ? 'RIGHT' : 'LEFT';
  const steps = Math.abs(targetIndex - srcIndex);
  for (let i = 0; i < steps; i++) {
    await sendLine('MOVELAYER:' + dir);
    await new Promise(r => setTimeout(r, 150));
  }
  await sendLine('INFO');
}

function renderGrid() {
  const grid = el('grid');
  grid.style.gridTemplateColumns = 'repeat(' + COLS + ', 1fr)';
  grid.innerHTML = '';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const data = mapping[currentLayer][r][c];
    const isEmpty = !data || data.type === 0;
    const typeClass = 'type-' + (data ? TYPE_NAMES[data.type] : 'NONE').toLowerCase();
    const cell = document.createElement('div');
    cell.className = 'cell' + (isEmpty ? ' empty' : '') + ' ' + typeClass;
    cell.innerHTML = `<div class="type">R${r}C${c} · ${data ? TYPE_NAMES[data.type] : '...'}</div>
                       <div class="val">${data ? (isEmpty ? '—' : escapeHtml(data.value)) : '...'}</div>`;
    cell.onclick = () => openEditor('key', { r, c });
    grid.appendChild(cell);
  }
}

function renderEncoderList() {
  const list = el('encList');
  list.innerHTML = '';
  for (let i = 0; i < NUM_ENCODERS; i++) {
    if (NUM_ENCODERS > 1) {
      const h = document.createElement('div');
      h.className = 'enc-group-label';
      h.textContent = `Knob ${i}` + (i === 0 ? ' (gesture dasar)' : '');
      list.appendChild(h);
    }
    ['CW', 'CCW', 'BTN'].forEach(which => {
      const data = (encConfig[i] || {})[which];
      const isEmpty = !data || data.type === 0;
      const typeClass = 'type-' + (data ? TYPE_NAMES[data.type] : 'NONE').toLowerCase();
      const row = document.createElement('div');
      row.className = 'enc-row' + (isEmpty ? ' empty' : '') + ' ' + typeClass;
      row.innerHTML = `<span class="label">${ENC_LABELS[which]}</span><span class="val">${data ? (isEmpty ? '—' : escapeHtml(data.value)) : '...'}</span>`;
      row.onclick = () => openEditor('enc', { idx: i, which });
      list.appendChild(row);
    });
  }
}

// ==================== EDITOR PANEL ====================
function updateEditorFieldsVisibility() {
  const type = parseInt(el('editType').value);
  const isCaptureType = (type === 1 || type === 2 || type === 4);
  el('editValue').style.display = (type >= 1 && type <= 5) ? 'block' : 'none';
  el('editValue').readOnly = isCaptureType || type === 5;
  el('editValue').placeholder = type === 3 ? 'ketik teks di sini'
    : (type === 5 ? 'pilih aplikasi dari daftar di bawah' : (isCaptureType ? 'tekan tombol fisik...' : ''));
  el('consumerButtons').style.display = (type === 4) ? 'flex' : 'none';
  el('appPicker').style.display = (type === 5) ? 'block' : 'none';
  document.querySelectorAll('#consumerButtons button').forEach(b => b.classList.toggle('active', b.dataset.val === el('editValue').value));
}

function openEditor(kind, params) {
  selected = { kind, ...params };
  let data;
  if (kind === 'key') {
    data = mapping[currentLayer][params.r][params.c] || { type: 0, value: '' };
    el('editTitle').textContent = `Edit ${layerNames[currentLayer] || ('Layer ' + currentLayer)} — R${params.r} C${params.c}`;
  } else {
    data = (encConfig[params.idx] || {})[params.which] || { type: 0, value: '' };
    const prefix = NUM_ENCODERS > 1 ? `Knob ${params.idx} — ` : 'Encoder — ';
    el('editTitle').textContent = 'Edit ' + prefix + ENC_LABELS[params.which];
  }
  el('editType').value = data.type;
  el('editValue').value = data.type === 0 ? '' : data.value;
  recordTokens = data.value ? data.value.split('+') : [];
  updateEditorFieldsVisibility();
  el('editPanel').style.display = 'block';
  el('editPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const type = parseInt(el('editType').value);
  if (type === 1 || type === 2 || type === 4) startRecordingContinuous(); else stopRecordingContinuous();
  if (type === 5) openAppPicker();
}

// Baca isi layer l ke UI TANPA memindahkan layer aktif device.
//
// DUMP:<n> di firmware sudah bisa membaca layer mana pun tanpa berganti layer, dan
// setiap perintah tulis (SET:<layer>:...) menyebut nomornya secara eksplisit. Jadi
// jalur baca tidak perlu mengirim LAYER: sama sekali - mengirimnya hanya akan
// memindahkan layer yang sedang dipakai user di device.
// Ganti layer sungguhan ditangani switchLayer().
async function loadLayer(l) {
  mapping[l] = emptyLayer();
  await sendLine('DUMP:' + l);
}

// Ganti layer aktif di device DAN muat isinya ke UI. Dipakai saat user menekan tab
// layer. Jalur baca (EVT:LAYER:, refresh, connect) cukup loadLayer().
async function switchLayer(l) {
  setCurrentLayer(l);
  renderTabs();
  await sendLine('LAYER:' + l);
  await loadLayer(l);
}

// ==================== REKAM DARI KEYBOARD — OTOMATIS & KONTINU ====================
function isModifierKey(key) { return MODIFIER_KEYS.includes(key); }
function modifierName(key) { return { Control: 'CTRL', Shift: 'SHIFT', Alt: 'ALT', Meta: 'GUI' }[key]; }

function updateRecordPreview() {
  el('editValue').value = recordTokens.join('+');
  if (recordTokens.length === 0) return;
  if (recordTokens.length === 1 && !MODIFIER_NAMES.includes(recordTokens[0])) el('editType').value = '1';
  else el('editType').value = '2';
}

function captureKeyDuringRecording(e) {
  if (!recording) return;

  if (e.key === 'Backspace') { e.preventDefault(); recordTokens.pop(); updateRecordPreview(); return; }
  if (e.key === 'Delete') { e.preventDefault(); recordTokens = []; el('editValue').value = ''; el('editType').value = '0'; return; }

  if (MEDIA_MAP[e.code]) {
    e.preventDefault();
    recordTokens = [MEDIA_MAP[e.code]];
    el('editType').value = '4';
    el('editValue').value = MEDIA_MAP[e.code];
    updateEditorFieldsVisibility();
    return;
  }

  e.preventDefault();
  if (e.repeat) return; // abaikan auto-repeat saat tombol ditahan lama

  const name = isModifierKey(e.key) ? modifierName(e.key) : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (MODIFIER_NAMES.includes(name)) {
    if (recordTokens[recordTokens.length - 1] !== name) recordTokens.push(name);
  } else {
    recordTokens.push(name); // tombol biasa selalu jadi token baru, walau ditekan berkali-kali terpisah
  }
  updateRecordPreview();
}

function startRecordingContinuous() {
  if (recording) return;
  recording = true;
  window.addEventListener('keydown', captureKeyDuringRecording);
}
function stopRecordingContinuous() {
  recording = false;
  window.removeEventListener('keydown', captureKeyDuringRecording);
}

el('editType').onchange = () => {
  const type = parseInt(el('editType').value);
  recordTokens = [];
  el('editValue').value = '';
  updateEditorFieldsVisibility();
  if (type === 1 || type === 2 || type === 4) startRecordingContinuous(); else stopRecordingContinuous();
  if (type === 5) openAppPicker();
};

document.querySelectorAll('#consumerButtons button').forEach(b => {
  b.onclick = () => { recordTokens = [b.dataset.val]; el('editValue').value = b.dataset.val; updateEditorFieldsVisibility(); };
});

// ==================== TOMBOL LAIN ====================
el('btnRefreshPorts').onclick = autoDetect;
el('btnConnect').onclick = () => {
  if (port) { disconnect(true); return; }
  if (autoBusy) { log('[AUTO] Sedang mencari device, tunggu sebentar...'); return; }
  autoReconnect = true;
  connect();
};
el('btnRefresh').onclick = () => loadLayer(currentLayer);
el('btnSave').onclick = () => { dirty = false; sendLine('SAVE'); };
el('btnReset').onclick = async () => {
  if (await showConfirmModal('Reset config', 'Reset semua config ke default? (Belum permanen sampai klik Save)', 'Reset')) {
    dirty = true;
    sendLine('RESET').then(() => sendLine('INFO'));
  }
};
el('btnAddLayer').onclick = async () => { dirty = true; await sendLine('ADDLAYER'); setTimeout(() => sendLine('INFO'), 200); };
el('btnDelLayer').onclick = async () => {
  const name = layerNames[currentLayer] || ('Layer ' + currentLayer);
  if (!(await showConfirmModal('Delete layer', `Hapus "${name}"? Semua mapping di layer ini akan hilang.`, 'Delete'))) return;
  dirty = true;
  await sendLine('DELLAYER'); setTimeout(() => sendLine('INFO'), 200);
};
el('btnRenameLayer').onclick = async () => {
  const current = layerNames[currentLayer] || ('Layer ' + currentLayer);
  const name = await showPromptModal('Rename Layer', 'Nama baru untuk layer ini:', current);
  if (name !== null && name.trim() !== '') {
    dirty = true;
    sendLine(`RENAMELAYER:${currentLayer}:${name.trim()}`).then(() => setTimeout(() => sendLine('DUMPNAMES'), 200));
  }
};
el('btnCancel').onclick = () => { stopRecordingContinuous(); el('editPanel').style.display = 'none'; selected = null; };
el('btnApply').onclick = async () => {
  if (!selected) return;
  stopRecordingContinuous();
  dirty = true;
  const type = TYPE_NAMES[parseInt(el('editType').value)];
  const value = el('editValue').value;
  if (selected.kind === 'key') {
    await sendLine(`SET:${currentLayer}:${selected.r}:${selected.c}:${type}:${value}`);
    setTimeout(() => loadLayer(currentLayer), 300);
  } else {
    await sendLine(`SETENC:${selected.idx}:${selected.which}:${type}:${value}`);
    setTimeout(() => sendLine('DUMPENC'), 300);
  }
  el('editPanel').style.display = 'none';
};

renderTabs(); renderGrid(); renderEncoderList();
autoDetect();
loadPresets();

// ==================== PAGE SETTING ====================
el('notifyBasicToggle').checked = settings.notifyBasic;
el('notifyKeysToggle').checked = settings.notifyKeys;
el('notifyBasicToggle').onchange = e => { settings.notifyBasic = e.target.checked; saveSettings(); };
el('notifyKeysToggle').onchange = e => { settings.notifyKeys = e.target.checked; saveSettings(); };
el('notifyBatteryToggle').checked = settings.notifyBattery;
el('notifyBatteryToggle').onchange = e => { settings.notifyBattery = e.target.checked; saveSettings(); };
el('globalAdaptiveToggle').checked = presetsData.masterEnabled;
el('globalAdaptiveToggle').onchange = (e) => {
  presetsData.masterEnabled = e.target.checked;
  // Jangan ditelan diam-diam: kalau gagal, user mengira toggle tersimpan padahal
  // akan kembali ke nilai lama setelah app ditutup.
  invoke('presets_save', { data: presetsData })
    .catch(err => log('[ERROR] Gagal menyimpan setting adaptive: ' + err, 'err'));
  syncGlobalToggles();
};
el('btnTestNotif').onclick = () => notify('Tes notifikasi', 'connect', { force: true });
setInterval(pollPorts, 2000);

// Halaman RGB di-wire di dalam modusnya sendiri; transport serial disuntikkan supaya
// tidak ada import bolak-balik antara main.js dan rgb-page.js.
setRgbTransport(sendLine);
initRgbPage();
renderRgbAll(); syncGlobalToggles();

// ==================== AUTOSTART (toggle; auto-aktif sekali di build rilis, diatur Rust) ====================
async function initAutostart() {
  const t = el('autostartToggle');
  try {
    const s = await invoke('autostart_status');
    t.checked = s.enabled;
    t.disabled = !s.available;
    el('autostartLabel').title = s.available ? '' : 'Hanya bisa diatur di build rilis (npm run tauri build)';
  } catch (e) { t.disabled = true; log('[ERROR] Gagal membaca status autostart: ' + e, 'err'); }
}
el('autostartToggle').onchange = async (e) => {
  const want = e.target.checked;
  try {
    await invoke('autostart_set', { value: want });
    log(want ? '[LOG] Autostart aktif: app jalan di tray saat Windows start' : '[LOG] Autostart dimatikan', 'ok');
  } catch (err) {
    e.target.checked = !want;
    log('[ERROR] Gagal mengubah autostart: ' + err, 'err');
  }
};
initAutostart();

// Deteksi render (compositor) benar-benar berhenti mengecat, bukan sekadar user lama mikir di depan modal.
// requestAnimationFrame hanya jalan kalau compositor masih sehat; setInterval di bawah tidak bergantung
// padanya, jadi tetap bisa mendeteksi walau paint sudah berhenti (JS-nya sendiri masih hidup).
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

// ==================== TRAY: X = sembunyi ke tray, bukan keluar ====================
// Dialog simpan dipakai untuk dua jalur: X (ke tray) dan menu tray "Keluar" saat jendela masih terbuka.
// Return true kalau boleh lanjut, false kalau user batal.
let unsavedDialogOpen = false;
async function confirmUnsaved(quitting) {
  if (!dirty || !port) return true; // tanpa koneksi tidak ada yang bisa disimpan/dikembalikan
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
      dirty = false;
      await sendLine('SAVE');
      return true;
    }
    if (choice === 'discard') {
      // Kembalikan isi device ke isi flash supaya tidak menggantung setengah berubah
      dirty = false;
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

const appWindow = getCurrentWindow();
appWindow.onCloseRequested(async (event) => {
  event.preventDefault(); // X tidak pernah menutup app; keluar lewat menu tray
  if (!(await confirmUnsaved(false))) return;
  stopRecordingContinuous();
  el('editPanel').style.display = 'none';
  selected = null;
  await invoke('hide_to_tray');
});

listen('tray-quit', async () => {
  if (!(await confirmUnsaved(true))) return;
  await invoke('quit_app');
});
