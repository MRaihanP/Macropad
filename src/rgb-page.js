// ==================== HALAMAN RGB ====================
//
// Seluruh logika halaman "RGB Setting" dipindah ke sini dari main.js.
//
// State RGB dibaca dari DEVICE lewat RGB_DUMP / RGB_KEY (lihat handleRgbLine di
// bawah), bukan dari default app. Ini penting karena firmware PROTOTYPE mengirim
// angka simulasi dan FINAL mengirim angka hardware sungguhan - dengan format pesan
// yang sama persis, sehingga saat board FINAL siap dipakai modul ini tidak perlu
// diubah sama sekali.
//
// Nama key memakai "RGB 1".."RGB 9" mengikuti urutan rantai LED fisik, dicerminkan
// dari RGB_INDEX di firmware.

import { ROWS, COLS } from './device-state.js';
import { t } from './i18n.js';
import { el } from './dom.js';

const RGB_FW_BRI_CAP = Math.round(255 * 0.6);
const briToPct = v => Math.max(0, Math.min(100, Math.round(v / RGB_FW_BRI_CAP * 100)));
const pctToBri = p => Math.round(Math.max(0, Math.min(100, p)) / 100 * RGB_FW_BRI_CAP);

export const rgb = { enabled: true, mode: 0, random: false, color: [16, 96, 90], bri: 200, speed: 128, keys: [], sel: null, dirty: false };

export const RGB_MODES = [
  { id: 0, name: 'Static Light', desc: 'rgb.modeDesc.0', color: true, random: false, speed: false },
  { id: 1, name: 'Custom per Key', desc: 'rgb.modeDesc.1', color: false, random: false, speed: false },
  { id: 2, name: 'Breathing', desc: 'rgb.modeDesc.2', color: true, random: true, speed: true },
  { id: 3, name: 'Color Cycle', desc: 'rgb.modeDesc.3', color: false, random: false, speed: true },
  { id: 4, name: 'Rainbow', desc: 'rgb.modeDesc.4', color: false, random: false, speed: true },
  { id: 5, name: 'Color Waves', desc: 'rgb.modeDesc.5', color: true, random: true, speed: true },
  { id: 6, name: 'Snake', desc: 'rgb.modeDesc.6', color: true, random: true, speed: true },
  { id: 7, name: 'Randomize', desc: 'rgb.modeDesc.7', color: true, random: true, speed: true },
  { id: 8, name: 'React Light', desc: 'rgb.modeDesc.8', color: true, random: false, speed: false }
];

// Peta posisi tombol [row][col] -> index LED di rantai, 0 = RGB 1 ... 8 = RGB 9.
const RGB_LED_INDEX = { '0,0': 0, '0,1': 1, '0,2': 2, '1,0': 5, '1,1': 4, '1,2': 3, '2,0': 6, '2,1': 7, '2,2': 8 };
export function ledIndex(r, c) { const i = RGB_LED_INDEX[`${r},${c}`]; return i === undefined ? r * COLS + c : i; }
export function rgbKeyName(r, c) { const i = RGB_LED_INDEX[`${r},${c}`]; return i === undefined ? `R${r} C${c}` : `RGB ${i + 1}`; }

// ---- Preview animasi (Web Animations API) ----
// Dipakai imperative, bukan CSS animation, karena rule stylesheet (mis. rgb-off atau
// prefers-reduced-motion) bisa mematikan animasi dan preview jadi diam. WAAPI tidak
// bisa ditimpa dari CSS, jadi preview selalu terlihat selama rgb.enabled aktif.
const RGB_KF = {
  hue: [{ filter: 'hue-rotate(0deg)' }, { filter: 'hue-rotate(360deg)' }],
  breath: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.42)', opacity: .22 }, { transform: 'scale(1)', opacity: 1 }],
  wave: [{ transform: 'scale(.45)', opacity: .18 }, { transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.45)', opacity: .18 }],
  snake: [{ transform: 'scale(.55)', opacity: .1 }, { transform: 'scale(.55)', opacity: .1, offset: .8 },
  { transform: 'scale(1.12)', opacity: 1, offset: .88 }, { transform: 'scale(.55)', opacity: .1 }],
  react: [{ transform: 'scale(.55)', opacity: .1 }, { transform: 'scale(.55)', opacity: .1, offset: .72 },
  { transform: 'scale(1.15)', opacity: 1, offset: .78 }, { transform: 'scale(.6)', opacity: .22, offset: .9 },
  { transform: 'scale(.55)', opacity: .1 }],
  pulse: [{ opacity: 1 }, { opacity: .1 }, { opacity: 1 }],
};
const RGB_INF = { iterations: Infinity, fill: 'both' };
let rgbAnims = [];
function stopRgbAnims() { rgbAnims.forEach(a => { try { a.cancel(); } catch (e) { } }); rgbAnims = []; }

// Bangun animasi untuk satu titik. Fase (delay negatif) mengikuti mode: snake/react
// memakai urutan rantai LED, rainbow menggeser mendatar, waves menyapu diagonal,
// randomize memakai seed per key.
function rgbAnimFor(dot, mode, r, c) {
  const led = ledIndex(r, c);
  const play = (kf, dur, ease, delay) => { if (dot.animate) rgbAnims.push(dot.animate(kf, Object.assign({}, RGB_INF, { duration: dur, easing: ease, delay: delay || 0 }))); };
  const hue = (dur, delay) => play(RGB_KF.hue, dur, 'linear', delay);
  if (!rgb.enabled) return;
  switch (mode) {
    case 2: play(RGB_KF.breath, 2200, 'ease-in-out'); break;
    case 3: hue(4000); break;
    case 4: hue(3400, -led * 140); break;
    case 5: hue(3800, -(r + c) * 160); play(RGB_KF.wave, 1900, 'ease-in-out', -(r + c) * 160); break;
    case 6: hue(3000, -led * 200); play(RGB_KF.snake, 1600, 'linear', -led * 200); break;
    case 7: hue(4000, -led * 370); play(RGB_KF.pulse, 1100 + (led % 5) * 220, 'ease-in-out', -led * 370); break;
    case 8: hue(4000, -led * 290); play(RGB_KF.react, 2600, 'ease-out', -led * 290); break;
  }
}

export function ensureRgbKeys() {
  for (let r = 0; r < ROWS; r++) {
    rgb.keys[r] = rgb.keys[r] || [];
    for (let c = 0; c < COLS; c++) rgb.keys[r][c] = rgb.keys[r][c] || [16, 96, 90];
  }
}
const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const rgbToHex = (c) => ('#' + c.map(x => x.toString(16).padStart(2, '0')).join('')).toUpperCase();
export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Parse tiga komponen "r:g:b" yang dikirim firmware.
// JANGAN memakai .map(parseInt): map meneruskan index sebagai argumen kedua, dan
// parseInt(value, radix) memperlakukannya sebagai radix - sehingga
// "20:30".map(parseInt) menghasilkan NaN karena radix 1 dan 2 tidak valid.
// Gejalanya diam-diam: warna dari device tidak pernah ter-parse benar.
export function parseRgbTriple(s) {
  const parts = String(s).split(':');
  if (parts.length !== 3) return null;
  const out = parts.map(x => parseInt(x, 10));
  return out.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? out : null;
}

export function renderRgbGrid() {
  ensureRgbKeys(); stopRgbAnims();
  const g = el('rgbGrid');
  g.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;
  g.classList.toggle('rgb-off', !rgb.enabled);
  g.innerHTML = '';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const d = document.createElement('div');
    d.className = 'cell rgb-cell' + ((rgb.sel && rgb.sel[0] === r && rgb.sel[1] === c) ? ' sel' : '');
    const bg = rgb.mode === 1 ? rgbCss(rgb.keys[r][c]) : rgbCss(rgb.color);
    d.innerHTML = `<span class="rgb-dot" style="background:${bg}"></span><span class="val">${rgbKeyName(r, c)}</span>`;
    d.title = t('rgb.keyPosTitle', { r, c });
    d.onclick = () => { rgb.sel = [r, c]; renderRgbGrid(); renderRgbKeyCard(); };
    g.appendChild(d);
    rgbAnimFor(d.querySelector('.rgb-dot'), rgb.mode, r, c);
  }
}

export function renderRgbKeyCard() {
  const card = el('rgbKeyCard');
  if (!rgb.sel) { card.style.display = 'none'; return; }
  ensureRgbKeys();
  card.style.display = 'block';
  el('rgbKeyTitle').textContent = t('rgb.keyColorTitle', { name: rgbKeyName(rgb.sel[0], rgb.sel[1]) });
  el('rgbColorPicker').value = rgbToHex(rgb.keys[rgb.sel[0]][rgb.sel[1]]);
}

export function renderRgbPresets() {
  const list = el('rgbPresetList');
  list.innerHTML = '';
  RGB_MODES.forEach(m => {
    const row = document.createElement('div');
    row.className = 'rgb-preset' + (rgb.mode === m.id ? ' active' : '');
    row.innerHTML = `<div class="rgb-preset-name">${m.name}</div><div class="rgb-preset-desc">${t(m.desc)}</div>`;
    row.onclick = () => {
      rgb.mode = m.id;
      el('rgbSaveState').textContent = t('rgb.unsavedShort');
      transportSendLine(`RGB:MODE:${rgb.mode}:${rgb.random ? 1 : 0}:${rgb.color.join(':')}:${rgb.speed}`);
      renderRgbPresets(); renderRgbGrid();
    };
    list.appendChild(row);
  });
  el('cpModeWrap').style.display = (RGB_MODES[rgb.mode]?.color ? 1 : 0) ? 'block' : 'none';
}

// Hanya ganti warna titik, JANGAN bangun ulang grid: membangun ulang akan
// mengulang animasi dari awal dan ikut mengirim ulang state ke device.
export function syncRgbDotColors() {
  const dots = el('rgbGrid').querySelectorAll('.rgb-dot');
  dots.forEach((dot, i) => {
    const r = Math.floor(i / COLS), c = i % COLS;
    dot.style.background = rgb.mode === 1 ? rgbCss(rgb.keys[r][c]) : rgbCss(rgb.color);
  });
}

// Tampilkan nilai slider di layar DAN ke screen reader sekaligus.
//
// Dua tempat harus selalu ditulis bersamaan: teks yang terlihat (#rgbBriVal)
// dan aria-valuetext yang dibacakan screen reader. Hanya mengisi salah satunya
// membuat keduanya berbeda - user mendengar angka yang tidak cocok dengan yang
// dia lihat di layar.
//
// Yang ditulis adalah versi persen ('78%') yang tampil di layar, bukan angka
// mentah 0-255 yang ada di atribut value - supaya yang dibacakan persis sama
// dengan yang tertulis.
function setSliderReadout(inputId, readoutId, displayText) {
  el(readoutId).textContent = displayText;
  el(inputId).setAttribute('aria-valuetext', displayText);
}

export function renderRgbAll() {
  el('rgbEnabledToggle').checked = rgb.enabled;
  el('rgbBri').value = briToPct(rgb.bri);
  setSliderReadout('rgbBri', 'rgbBriVal', briToPct(rgb.bri) + '%');
  el('rgbSpeed').value = rgb.speed;
  setSliderReadout('rgbSpeed', 'rgbSpeedVal', Math.round(rgb.speed / 255 * 100) + '%');
  renderRgbGrid(); renderRgbKeyCard(); renderRgbPresets();
  el('rgbSaveState').textContent = rgb.dirty ? t('rgb.unsaved') : '';
}

// ---- Parser baris RGB dari device ----
// Firmware adalah sumber kebenaran state RGB. Handle baris "RGB_DUMP:" / "RGB_KEY:"
// di sini; HWINFO/EVT:BATT bukan urusan halaman ini dan tetap di main.js.
export function handleRgbLine(line, log) {
  if (line.startsWith('RGB_DUMP:')) {
    const kv = {};
    line.substring(9).split(',').forEach(p => { const eq = p.indexOf('='); if (eq > 0) kv[p.substring(0, eq)] = p.substring(eq + 1); });
    if (kv.enabled !== undefined) rgb.enabled = kv.enabled === '1';
    if (kv.mode !== undefined) rgb.mode = parseInt(kv.mode);
    if (kv.random !== undefined) rgb.random = kv.random === '1';
    if (kv.bri !== undefined) rgb.bri = parseInt(kv.bri);
    if (kv.speed !== undefined) rgb.speed = parseInt(kv.speed);
    if (kv.dirty !== undefined) rgb.dirty = kv.dirty === '1';
    if (kv.color) { const c = parseRgbTriple(kv.color); if (c) rgb.color = c; }
    rgb.keys = [];          // kunci berikutnya akan mengisi ulang
    renderRgbAll();
    return true;
  }
  if (line.startsWith('RGB_KEY:')) {
    const p = line.substring(8).split(',');
    if (p.length === 3) {
      const r = parseInt(p[0]), c = parseInt(p[1]);
      const col = parseRgbTriple(p[2]);
      if (Number.isInteger(r) && r >= 0 && r < ROWS && Number.isInteger(c) && c >= 0 && c < COLS && col) {
        ensureRgbKeys();
        rgb.keys[r][c] = col;
        renderRgbAll();
      } else {
        log(t('rgb.invalidKeyLine', { line }), 'err');
      }
    }
    return true;
  }
  return false;
}

// Transport (port serial) disuntikkan saat init supaya modul ini tidak bergantung
// pada main.js - keduanya saling memakai, dan import langsung akan membuat siklus.
let transportSendLine = () => { };
export function setRgbTransport(sendLine) { transportSendLine = sendLine; }

// Pasang seluruh penangan kontrol di halaman RGB.
export function initRgbPage() {
  el('globalRgbToggle').checked = rgb.enabled;
  el('globalRgbToggle').onchange = (e) => { rgb.enabled = e.target.checked; transportSendLine('RGB:EN:' + (rgb.enabled ? 1 : 0)); renderRgbAll(); };

  el('rgbEnabledToggle').checked = rgb.enabled;
  el('rgbEnabledToggle').onchange = (e) => { rgb.enabled = e.target.checked; transportSendLine('RGB:EN:' + (rgb.enabled ? 1 : 0)); renderRgbAll(); };

  el('rgbBri').oninput = (e) => {
    const pct = parseInt(e.target.value);
    rgb.bri = pctToBri(pct); rgb.dirty = true;
    setSliderReadout('rgbBri', 'rgbBriVal', pct + '%');
    transportSendLine(`RGB:BRI:${rgb.bri}`);
    renderRgbAll();
  };
  el('rgbSpeed').oninput = (e) => {
    rgb.speed = parseInt(e.target.value); rgb.dirty = true;
    setSliderReadout('rgbSpeed', 'rgbSpeedVal', Math.round(rgb.speed / 255 * 100) + '%');
    transportSendLine(`RGB:MODE:${rgb.mode}:${rgb.random ? 1 : 0}:${rgb.color.join(':')}:${rgb.speed}`);
    renderRgbAll();
  };
  // Warna global: ganti warna titik saja, tanpa membangun ulang grid (dan tanpa
  // mengirim ulang state), supaya fase animasi tidak reset.
  el('rgbColorPicker').oninput = (e) => {
    if (!rgb.sel) {
      rgb.color = hexToRgb(e.target.value);
      transportSendLine(`RGB:ALL:${rgb.color.join(':')}`);
      syncRgbDotColors();
    } else {
      ensureRgbKeys();
      rgb.keys[rgb.sel[0]][rgb.sel[1]] = hexToRgb(e.target.value);
      rgb.mode = 1;
      transportSendLine(`RGB:KEY:${rgb.sel[0]}:${rgb.sel[1]}:${rgb.keys[rgb.sel[0]][rgb.sel[1]].join(':')}`);
      renderRgbAll();
    }
  };
  el('rgbModeColor').oninput = (e) => {
    rgb.color = hexToRgb(e.target.value);
    transportSendLine(`RGB:MODE:${rgb.mode}:${rgb.random ? 1 : 0}:${rgb.color.join(':')}:${rgb.speed}`);
    syncRgbDotColors();
    renderRgbKeyCard();
  };

  // Flag dirty dibaca dari device (RGB_DUMP:dirty=), bukan asumsi lokal.
  el('btnRgbSave').onclick = async () => { await transportSendLine('RGB:SAVE'); await transportSendLine('RGB:DUMP'); };
  el('btnRgbReset').onclick = async () => { if (confirm('Reset RGB ke default?')) { await transportSendLine('RGB:RESET'); await transportSendLine('RGB:DUMP'); } };
}