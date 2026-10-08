// ==================== HALAMAN HOME ====================
//
// Seluruh isi halaman utama: tab layer dengan drag-reorder, grid tombol, daftar
// binding knob, panel editor, dan perekaman tombol keyboard.
//
// Ketiganya sengaja jadi satu modul, bukan tiga. Mereka saling memanggil:
// klik sel grid -> openEditor() -> panel editor -> startRecordingContinuous() ->
// recordTokens -> apply -> kirim ke device; dan tab layer -> switchLayer() ->
// loadLayer() -> renderGrid(). Kalau dipisah tiga modul, ada yang harus
// mengimpor balik ke modul lain dan muncul siklus import.

import {
  ROWS, COLS, NUM_ENCODERS, TYPE_NAMES,
  currentLayer, layerCount, maxLayers, layerNames, mapping, encConfig,
  setCurrentLayer, reorderLayer, emptyLayer,
} from './device-state.js';
import { el, escapeHtml } from './dom.js';
import { sendLine } from './serial-transport.js';
import { openAppPicker } from './app-picker.js';
import { t } from './i18n.js';

// Nilai di sini adalah KUNCI tabel i18n; diterjemahkan saat pemakaian,
// jadi ganti bahasa langsung memperbarui label berikutnya.
export const ENC_LABELS = { CW: 'enc.cw', CCW: 'enc.ccw', BTN: 'enc.btn' };
const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta'];
const MODIFIER_NAMES = ['CTRL', 'SHIFT', 'ALT', 'GUI'];
const MEDIA_MAP = {
  AudioVolumeUp: 'VOLUP', AudioVolumeDown: 'VOLDOWN', AudioVolumeMute: 'MUTE',
  MediaPlayPause: 'PLAYPAUSE', MediaTrackNext: 'NEXT', MediaTrackPrevious: 'PREV',
};

// ---- State ----
// selected = tombol/knob yang sedang diedit di panel editor.
export let selected = null;
export let recording = false;
export let recordTokens = [];
let tabDragMoved = false;

// ---- Hook ke main.js ----
let markDirty = () => { };
export function initHomePage(h) { if (h && h.markDirty) markDirty = h.markDirty; }

// ==================== TAB LAYER ====================
// Helper: menjadikan elemen non-button bisa dioperasikan dari keyboard.
//
// Sel grid dan baris binding knob sengaja <div> (bukan <button>) karena isinya
// HTML bebas. Tanpa tabindex + role + penangan key, area itu hanya bisa diklik
// mouse - pengguna keyboard tidak bisa mengedit binding sama sekali.
function makeInteractive(node, onActivate, label) {
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  if (label) node.setAttribute('aria-label', label);
  node.onclick = onActivate;
  // Enter dan Space mengaktifkan role="button"; tanpa ini, mustahil dipicu keyboard.
  node.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();   // Space tanpa ini akan menggulir halaman
    onActivate();
  };
  return node;
}

export function renderTabs() {
  const tabs = el('tabs');
  tabs.innerHTML = '';
  el('deviceLayerLabel').textContent = layerNames[currentLayer] || t('layer.n', { n: currentLayer });
  for (let l = 0; l < layerCount; l++) {
    // Variabel lokal sengaja tidak disebut "t": "t" adalah fungsi terjemahan dari
    // i18n.js, dan menimpanya di sini membuat panggilan t('layer.n', ...) gagal
    // dengan "t is not a function" karena yang terlihat adalah elemen DOM ini.
    const tab = document.createElement('div');
    tab.className = 'tab' + (l === currentLayer ? ' active' : '');
    tab.textContent = layerNames[l] || t('layer.n', { n: l });
    tab.style.touchAction = 'none';
    // Tab layer adalah tab strip: harus bisa difokus dan bisa diganti dengan
    // panah kiri/kanan, karena drag hanya bisa dilakukan dengan mouse.
    tab.tabIndex = 0;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', l === currentLayer ? 'true' : 'false');
    tab.setAttribute('aria-label', t('layer.n', { n: l + 1 }) + (layerNames[l] ? ': ' + layerNames[l] : ''));
    tab.onclick = () => { if (tabDragMoved) return; switchLayer(l); };
    tab.onpointerdown = (e) => startTabDrag(e, tab, l);
    tab.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchLayer(l); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = (e.key === 'ArrowRight') ? 1 : -1;
      const next = Math.min(layerCount - 1, Math.max(0, l + step));
      if (next === l) return;
      switchLayer(next);
      const nodes = el('tabs').children;
      if (nodes[next]) nodes[next].focus();
    };
    tabs.appendChild(tab);
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
  markDirty();
  await sendLine('LAYER:' + srcIndex);
  const dir = targetIndex > srcIndex ? 'RIGHT' : 'LEFT';
  const steps = Math.abs(targetIndex - srcIndex);
  for (let i = 0; i < steps; i++) {
    await sendLine('MOVELAYER:' + dir);
    await new Promise(r => setTimeout(r, 150));
  }
  await sendLine('INFO');
}

// ==================== GRID & DAFTAR KNOB ====================
export function renderGrid() {
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
    const label = t('grid.cellLabel', { r: r + 1, c: c + 1 }) +
      (data && data.type !== 0 ? data.value || TYPE_NAMES[data.type] : t('editor.empty'));
    makeInteractive(cell, () => openEditor('key', { r, c }), label);
    grid.appendChild(cell);
  }
}

export function renderEncoderList() {
  const list = el('encList');
  list.innerHTML = '';
  for (let i = 0; i < NUM_ENCODERS; i++) {
    if (NUM_ENCODERS > 1) {
      const h = document.createElement('div');
      h.className = 'enc-group-label';
      h.textContent = t('enc.knobHeader', { i }) + (i === 0 ? t('enc.gestureBasic') : '');
      list.appendChild(h);
    }
    ['CW', 'CCW', 'BTN'].forEach(which => {
      const data = (encConfig[i] || {})[which];
      const isEmpty = !data || data.type === 0;
      const typeClass = 'type-' + (data ? TYPE_NAMES[data.type] : 'NONE').toLowerCase();
      const row = document.createElement('div');
      row.className = 'enc-row' + (isEmpty ? ' empty' : '') + ' ' + typeClass;
      row.innerHTML = `<span class="label">${t(ENC_LABELS[which])}</span><span class="val">${data ? (isEmpty ? '—' : escapeHtml(data.value)) : '...'}</span>`;
      const label = (NUM_ENCODERS > 1 ? t('enc.knobLabel', { n: i + 1 }) : '') +
        t(ENC_LABELS[which]) + ': ' + (data && data.type !== 0 ? data.value || TYPE_NAMES[data.type] : t('editor.empty'));
      makeInteractive(row, () => openEditor('enc', { idx: i, which }), label);
      list.appendChild(row);
    });
  }
}

// ==================== PANEL EDITOR ====================
export function updateEditorFieldsVisibility() {
  const type = parseInt(el('editType').value);
  const isCaptureType = (type === 1 || type === 2 || type === 4);
  el('editValue').style.display = (type >= 1 && type <= 5) ? 'block' : 'none';
  el('editValue').readOnly = isCaptureType || type === 5;
  el('editValue').placeholder = type === 3 ? t('editor.phText')
    : (type === 5 ? t('editor.phApp') : (isCaptureType ? t('editor.phCapture') : ''));
  el('consumerButtons').style.display = (type === 4) ? 'flex' : 'none';
  el('appPicker').style.display = (type === 5) ? 'block' : 'none';
  document.querySelectorAll('#consumerButtons button').forEach(b => b.classList.toggle('active', b.dataset.val === el('editValue').value));
}

export function openEditor(kind, params) {
  selected = { kind, ...params };
  let data;
  if (kind === 'key') {
    data = mapping[currentLayer][params.r][params.c] || { type: 0, value: '' };
    el('editTitle').textContent = t('editor.titleKey', { layer: layerNames[currentLayer] || t('layer.n', { n: currentLayer }), r: params.r, c: params.c });
  } else {
    data = (encConfig[params.idx] || {})[params.which] || { type: 0, value: '' };
    const prefix = NUM_ENCODERS > 1 ? t('editor.prefixKnob', { idx: params.idx }) : t('editor.prefixEnc');
    el('editTitle').textContent = t('editor.titleEnc', { prefix, label: t(ENC_LABELS[params.which]) });
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
export async function loadLayer(l) {
  mapping[l] = emptyLayer();
  await sendLine('DUMP:' + l);
}

// Ganti layer aktif di device DAN muat isinya ke UI. Dipakai saat user menekan tab
// layer. Jalur baca (EVT:LAYER:, refresh, connect) cukup loadLayer().
export async function switchLayer(l) {
  setCurrentLayer(l);
  renderTabs();
  await sendLine('LAYER:' + l);
  await loadLayer(l);
}

// ==================== REKAM DARI KEYBOARD ====================
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

export function startRecordingContinuous() {
  if (recording) return;
  recording = true;
  window.addEventListener('keydown', captureKeyDuringRecording);
}

export function stopRecordingContinuous() {
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
// Dipanggil main.js saat user menekan Cancel atau menutup jendela. selected milik
// modul ini, jadi main.js tidak boleh menulisnya langsung (import tidak bisa di-assign).
export function clearSelection() { selected = null; }

export function resetEditorState() {
  stopRecordingContinuous();
  recordTokens = [];
  selected = null;
  el('editPanel').style.display = 'none';
}

// ---- Pemasangan kontrol editor ----
export function initEditorPanel() {
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
}