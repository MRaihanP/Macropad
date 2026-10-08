import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
// State device (dimensi matriks, layer, keymap, binding knob) tinggal di satu modul
// dengan mutator tervalidasi. Nilai di-import sebagai live binding, jadi kode yang
// hanya membaca tidak berubah; kode yang menulis wajib memakai setter dari sana.
// Diparser protokol, semua mutator dipakai dari sana - jadi yang diimpor di sini
// hanya yang masih dipakai oleh render/editor.
import {
  CAP_LAYERS, ROWS, COLS, NUM_ENCODERS, currentLayer, layerCount, maxLayers,
  mapping, layerNames, encConfig,
  setCurrentLayer, setMapping, setLayerNames, resetEncParse,
  ensureEncConfigSize, emptyLayer, reorderLayer, TYPE_NAMES,
} from "./device-state.js";
// Helper DOM dan seluruh logika halaman RGB dipisah ke modul sendiri. Halaman RGB
// membaca state dari device (RGB_DUMP/RGB_KEY), bukan dari default app.
import { el, log, escapeHtml } from "./dom.js";
import {
  rgb, renderRgbAll, initRgbPage, setRgbTransport, hexToRgb,
} from "./rgb-page.js";
// Seluruh urusan port serial (connect/reconnect, buffer baris, framing parser,
// pengiriman perintah) dipisah ke modul sendiri. Yang diimpor di sini hanya yang
// benar-benar dipakai main.js - sisanya dipanggil transport lewat hook initTransport()
// sehingga isi config/layer/preset tidak bocor ke dalam modul transport.
import {
  initTransport, sendLine, sendBatch, connect, disconnect,
  autoDetect, pollPorts, isConnected, isAutoBusy, enableAutoReconnect, deviceWasLost,
} from "./serial-transport.js";
// Adaptive Key Bind: manajemen preset + runtime auto-switch.
import {
  initAdaptive, initAdaptivePage, presetsData, editingPresetId, loadPresets,
  resetAdaptiveRuntimeState, confirmLeavePresetEditor,
} from "./adaptive.js";
// Indikator baterai & charger. Angkanya selalu dari firmware lewat EVT:BATT/EVT:CHG.
import { initBatteryUi, battUI, clearBattery } from "./battery-ui.js";
// Parser protokol: satu baris dari device -> aksi. Kontrak app<->firmware ada di
// sini; main.js hanya menyuntikkan fungsi yang menyentuh layar.
import { initProtocolParser, handleLine, deviceProfile, resetDeviceProfile } from "./protocol-parser.js";

const ENC_LABELS = { CW: 'Putar searah jarum jam (CW)', CCW: 'Putar berlawanan arah (CCW)', BTN: 'Tombol tekan' };
const MEDIA_MAP = { AudioVolumeUp: 'VOLUP', AudioVolumeDown: 'VOLDOWN', AudioVolumeMute: 'MUTE', MediaPlayPause: 'PLAYPAUSE', MediaTrackNext: 'NEXT', MediaTrackPrevious: 'PREV' };
const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta'];
const MODIFIER_NAMES = ['CTRL', 'SHIFT', 'ALT', 'GUI'];

let selected = null;
let recording = false, recordTokens = [];
let dirty = false;

// Profil & kemampuan hardware (HWINFO) sekarang milik protocol-parser.js, karena
// baris HWINFO: yang mengisinya diparse di sana. Badge di bawah membacanya sebagai
// live binding.
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
// deviceWasLost TIDAK dideklarasikan di sini: transport yang menandainya saat device
// dicabut, dan main.js membacanya untuk membedakan notifikasi "Terhubung" vs
// "Terhubung kembali". Dua salinan akan membuat yang di sini selalu false.

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

// Tutup editor + hentikan perekaman keyboard. Tanpa ini listener keydown
// (preventDefault) tetap aktif walau #app tersembunyi, dan mengunci keyboard
// setelah device terputus saat editor masih terbuka.
//
// Catatan: fungsi ini sempat hilang saat ekstraksi transport (Phase 8 tahap 3).
// Ia berdiri di antara autoDetect() dan handleDeviceLost(), jadi ikut terhapus
// bersama blok itu - dan karena dipakai di initAdaptive({...}) yang jalan saat
// modul dimuat, seluruh main.js gagal dimuat dan tidak ada satu pun port COM
// yang terlihat. Karena itu sekarang ada startup-smoke-test.mjs yang benar-benar
// memuat main.js.
function resetEditorState() {
  stopRecordingContinuous();
  recordTokens = [];
  selected = null;
  el('editPanel').style.display = 'none';
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

// ==================== SAMBUNGKAN MODUL LAIN ====================

// adaptive.js tidak memanggil fungsi main.js secara langsung - navigasi halaman,
// modal, notifikasi, dan flag "belum disimpan" semuanya disuntikkan di sini.
initAdaptive({
  switchPage,
  showConfirmModal,
  showPromptModal,
  showModalBase,
  notify,
  resetEditorState,
  isDirty: () => dirty,
  setDirty: (v) => { dirty = !!v; },
});
// Indikator baterai butuh notify() untuk peringatan ambang (batt-low / batt-crit).
initBatteryUi(notify);

// Parser protokol hanya boleh menyentuh layar lewat fungsi yang disuntikkan di
// sini. Segala sesuatu yang lain (device-state, transport, adaptive, rgb, battery)
// ia impor langsung, jadi daftar ini hanya berisi fungsi render/notify.
initProtocolParser({
  notify,
  notifyBoundAction,
  renderDeviceProfileBadge,
  renderTabs,
  renderGrid,
  renderEncoderList,
  loadLayer,
});

// ==================== SAMBUNGKAN TRANSPORT ====================
// serial-transport.js tidak tahu apa pun soal isi config, layer, atau preset, dan
// juga tidak memanggil fungsi main.js secara langsung. Semua sisi aplikasi
// disuntikkan di sini - titik pertemuan tunggal antara transport dan app.
initTransport({
  // Setiap baris dari device berakhir di protocol-parser.js. Transport hanya
  // hanya pemisah baris; ia tidak tahu apa arti baris-baris itu.
  onLine: (line) => handleLine(line),
  onConnected: () => {
    // deviceWasLost sudah di-reset oleh transport (atau oleh disconnect manual)
    // sebelum hook ini dipanggil - jadi yang perlu dibaca di sini hanya nilainya.
    notify(deviceWasLost ? 'Terhubung kembali' : 'Terhubung ke companion', 'connect');
    switchPage('home');   // Home selalu tampil saat pertama kali connect
  },
  onDisconnected: () => {
    // Jangan biarkan angka device sebelumnya tertinggal di UI setelah putus: profile
    // (dan badge SIMULASI) serta meter baterai harus ikut kosong, kalau tidak user
    // mengira device masih hidup dan tegangan terkahoir.
    resetDeviceProfile();
    clearBattery();
    renderDeviceProfileBadge();
  },
  // Saat koneksi putus, state yang BARU BOLEH ada di device hilang sekalian -
  // tidak ada yang perlu "menunggu upload", karena isi RAM device ikut hilang.
  // Yang tersisa hanya state lokal app (preset, editor, daftar aplikasi).
  onDeviceLost: () => {
    resetAdaptiveRuntimeState();
    resetEditorState();
  },
  clearDirty: () => { dirty = false; },
  notify: (text, kind) => notify(text, kind),
  onAutoConnectOk: () => { },
  onAutoConnectFail: () => { },
});
el('btnRefreshPorts').onclick = autoDetect;
el('btnConnect').onclick = () => {
  if (isConnected()) { disconnect(true); return; }
  if (isAutoBusy()) { log('[AUTO] Sedang mencari device, tunggu sebentar...'); return; }
  enableAutoReconnect();
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
// initAdaptivePage() memasang kontrol preset (tambah/rename/hapus, tombol Done/Cancel
// editor) DAN memulai polling window foreground. Kalau ini terlewat, daftar preset
// tetap tampil tapi tidak pernah auto-switch.
initAdaptivePage();
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
  if (!dirty || !isConnected()) return true; // tanpa koneksi tidak ada yang bisa disimpan/dikembalikan
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
