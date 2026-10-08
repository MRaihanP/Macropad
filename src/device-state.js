// ==================== STATE DEVICE ====================
//
// Satu-satunya tempat yang memegang keadaan yang dilaporkan device: ukuran matriks,
// jumlah knob, layer aktif, isi setiap tombol, nama layer, dan binding knob.
//
// Semula semua ini adalah `let` global di main.js yang ditulis dari lima tempat
// berbeda (HWINFO, INFO, DUMP, DUMPENC, DUMPNAMES) plus beberapa event. Sekarang
// semua penulisan lewat setter di sini, dan SETIAP indeks dari device divalidasi
// sebelum menyentuh state.
//
// Kenapa penting: output serial adalah input yang tidak dipercaya. Kalau indeks
// di luar jangkauan atau NaN lolos, `mapping[..][99]` jadi undefined dan
// penugasannya melempar TypeError DI DALAM callback serial - yang ditangkap plugin
// dan ditelan, sehingga parser mati di tengah stream dan semua baris berikutnya
// dimakan sebagai payload. Desync permanen sampai reconnect.
//
// Nilai diekspor sebagai live binding, jadi kode yang hanya MEMBACA (ROWS, currentLayer,
// mapping, ...) tetap seperti semula: `import { ROWS } from './device-state.js'`
// selalu melihat nilai terbaru. Yang menulis harus memakai setter di bawah.

export const CAP_LAYERS = 8;

export let ROWS = 3, COLS = 3;
export let NUM_ENCODERS = 1;   // dilaporkan device lewat WHOAMI/INFO/DUMPENC, bukan di-hardcode
export let currentLayer = 0, layerCount = 4, maxLayers = CAP_LAYERS;
export let mapping = Array.from({ length: CAP_LAYERS }, () => Array.from({ length: ROWS }, () => Array(COLS).fill(null)));
export let layerNames = Array(CAP_LAYERS).fill(null);
export let encConfig = [{ CW: null, CCW: null, BTN: null }];
export let encParseIdx = 0;

// ---- Akses untuk pengujian ----
// Life bindings (export let) bersifat read-only dari luar modul, jadi test butuh
// jalan baca ini. Dipakai juga oleh modul lain yang butuh nilai yang dijamin mutlak.
export const getDims = () => ({ ROWS, COLS });
export const getLayer = (l) => mapping[l];
export const getEnc = (i) => encConfig[i];
export const getEncList = () => encConfig;
export const getNames = () => layerNames;
export const getNumEnc = () => NUM_ENCODERS;
export const getCurrentLayer = () => currentLayer;

// Kembalikan state ke kondisi awal. Hanya untuk test.
export function resetForTest() {
  ROWS = 3; COLS = 3; NUM_ENCODERS = 1;
  currentLayer = 0; layerCount = 4; maxLayers = CAP_LAYERS;
  mapping = Array.from({ length: CAP_LAYERS }, () => Array.from({ length: ROWS }, () => Array(COLS).fill(null)));
  layerNames = Array(CAP_LAYERS).fill(null);
  encConfig = [{ CW: null, CCW: null, BTN: null }];
  encParseIdx = 0;
}

// ---- Setter ----
export function setDims(r, c) { ROWS = r; COLS = c; }
export function setCurrentLayer(l) { currentLayer = l; }
export function setLayerCount(n) { layerCount = n; }
export function setMaxLayers(n) { maxLayers = n; }
export function setLayerNames(names) { layerNames = names; }
export function setEncConfig(c) { encConfig = c; }
export function setEncParseIdx(i) { encParseIdx = i; }
export function setMapping(m) { mapping = m; }

export function setNumEncoders(n) {
  NUM_ENCODERS = n;
  ensureEncConfigSize();
}

export function ensureEncConfigSize() {
  encConfig = Array.from({ length: NUM_ENCODERS }, () => ({ CW: null, CCW: null, BTN: null }));
}

// Parser juga butuh index knob yang sedang dibaca (DUMPENC), diekspor agar bisa di-reset.
export function resetEncParse() { encParseIdx = 0; }

// ---- Helper tampilan ----
export function emptyLayer() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// ---- Mutator tervalidasi ----
// Semuanya mengembalikan true kalau diterapkan, false kalau baris ditolak.
// Penolakan selalu dicatat terpisah oleh pemanggil karena dia yang punya akses ke UI/log.

const isInt = (v) => Number.isInteger(v);

// INFO:<key>=<value>,...  - semua nilai device di sini bisa rusak (mis. "abc" -> NaN).
// NaN pada ROWS membuat Array.from({length: NaN}) -> [] sehingga renderGrid melempar.
export function applyInfo(kv, deps) {
  const { log } = deps;
  // num() mengembalikan nilai lama kalau input bukan integer atau di luar rentang
  const num = (v, lo, hi, cur) => {
    const n = parseInt(v);
    if (!isInt(n) || n < lo || n > hi) {
      log(`[ERROR] INFO: nilai "${v}" di luar rentang ${lo}..${hi}, dipertahankan ${cur}`, 'err');
      return cur;
    }
    return n;
  };
  if (kv.layerCount !== undefined) setLayerCount(num(kv.layerCount, 1, CAP_LAYERS, layerCount));
  if (kv.currentLayer !== undefined) setCurrentLayer(num(kv.currentLayer, 0, layerCount - 1, currentLayer));
  if (kv.maxLayers !== undefined) setMaxLayers(num(kv.maxLayers, 1, CAP_LAYERS, maxLayers));
  if (kv.rows !== undefined || kv.cols !== undefined) {
    const r = kv.rows !== undefined ? num(kv.rows, 1, 16, ROWS) : ROWS;
    const c = kv.cols !== undefined ? num(kv.cols, 1, 16, COLS) : COLS;
    if (r !== ROWS || c !== COLS) {
      setDims(r, c);
      setMapping(Array.from({ length: CAP_LAYERS }, () => Array.from({ length: r }, () => Array(c).fill(null))));
    }
  }
  if (kv.encoders !== undefined) setNumEncoders(num(kv.encoders, 1, 8, NUM_ENCODERS));
}

// Satu baris DUMP: "<layer>,<row>,<col>,<type>,<value...>".
// layer diambil dari DUMP_BEGIN sehingga isi dump masuk ke layer asalnya, bukan ke
// currentLayer yang mungkin sudah berubah.
// Nilai boleh mengandung koma (macro TEXT), jadi field terakhir adalah sisa baris.
export function applyDumpRow(layer, row, col, type, value, log) {
  if (!isInt(layer) || layer < 0 || layer >= CAP_LAYERS) return false;
  if (!isInt(row) || row < 0 || row >= ROWS) return false;
  if (!isInt(col) || col < 0 || col >= COLS) return false;
  if (!isInt(type) || type < 0 || type > 5) return false;
  if (!mapping[layer] || !mapping[layer][row]) {
    log(`[ERROR] DUMP: layer ${layer} belum dialokasikan, baris dilewati`, 'err');
    return false;
  }
  mapping[layer][row][col] = { type, value };
  return true;
}

// Satu baris DUMPENC: "<CW|CCW|BTN>,<type>,<value>".
// Allowlist kunci WAJIB: tanpa itu device bisa mengirim "__proto__" yang menjadi
// prototype assignment pada objek knob.
const ENC_KEYS = ['CW', 'CCW', 'BTN'];
export function applyEncRow(idx, which, type, value, log) {
  if (!ENC_KEYS.includes(which)) return false;
  if (!isInt(idx) || idx < 0 || idx >= NUM_ENCODERS) return false;
  if (!encConfig[idx]) return false;
  if (!isInt(type) || type < 0 || type > 5) return false;
  encConfig[idx][which] = { type, value };
  return true;
}

// Satu baris DUMPNAMES: "<idx>,<name>"
export function applyName(idx, name, log) {
  if (!isInt(idx) || idx < 0 || idx >= maxLayers) return false;
  layerNames[idx] = name;
  return true;
}

// EVT:LAYER:<n>
export function applyLayerEvent(n) {
  if (!isInt(n) || n < 0 || n >= CAP_LAYERS) return false;
  currentLayer = n;
  return true;
}

// ENC_BEGIN:count=<n>
export function applyEncCount(n, log) {
  // Reset parser SELALU, meski count-nya tidak valid - kalau tidak, penanda knob
  // dari dump sebelumnya masih tertinggal dan baris berikutnya ditulis ke knob keliru.
  resetEncParse();
  if (!isInt(n) || n < 0 || n > 8) return false;
  setNumEncoders(n);
  return true;
}

// IDX:<n> - knob yang sedang dibaca saatparsing DUMPENC
export function applyEncIdx(n) {
  if (!isInt(n) || n < 0 || n >= NUM_ENCODERS) return false;
  encParseIdx = n;
  return true;
}

// Urutkan layer (MOVELAYER). Nilai sekali jalan, jadi kegagalan parsial harus dicegah
// lebih dulu - kalau tidak, keymap dan nama layer bisa terpisah.
export function reorderLayer(from, to) {
  if (!isInt(from) || !isInt(to) || from < 0 || from >= CAP_LAYERS || to < 0 || to >= CAP_LAYERS) return false;
  const map = mapping[from], name = layerNames[from];
  if (to > from) {
    for (let k = from; k < to; k++) { layerNames[k] = layerNames[k + 1]; mapping[k] = mapping[k + 1]; }
  } else {
    for (let k = from; k > to; k--) { layerNames[k] = layerNames[k - 1]; mapping[k] = mapping[k - 1]; }
  }
  layerNames[to] = name;
  mapping[to] = map;
  return true;
}

// ---- Konstanta protokol yang dipakai lebih dari satu modul ----
// TYPE_NAMES memetakan index tipe pada keymap ke nama yang dikirim ke firmware.
// Pindah ke sini karena dipakai editor di main.js maupun uploader preset di
// adaptive.js - kalau tiap modul punya salinannya, keduanya bisa berbeda diam-diam.
export const TYPE_NAMES = ["NONE", "KEY", "COMBO", "TEXT", "CONSUMER", "APP"];