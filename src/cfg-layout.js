// ==================== KONSTANTA LAYOUT KONFIGURASI ====================
//
// Sekumpulan angka yang HARUS sama persis dengan firmware/common/limits.h.
//
// Kenapa modul ini ada, dan kenapa tidak ditulis sebagai angka di tempat dipakai:
//
// Tiga aturan yang harus dipegang, dan ketiganya mudah dilanggar diam-diam:
//
//  1. SIDIK JARI. cfgSigOfPreset() menghitung CRC32 atas bentuk kanonik yang
//     lebarnya diambil dari CONFIG_VERSION, NAME_LEN, MACRO_MAX_LEN, dan lebar
//     struct action. Kalau satu angka meleset satu byte saja, sidik jari berubah
//     dan device tidak akan pernah mengenali preset yang sebenarnya identik.
//     Gejalanya "app mengunggah ulang terus-menerus" - tanpa error sama sekali
//     di kedua sisi, jadi tidak ada yang bisa blamed.
//
//  2. TATA LETAK BALASAN. parseCfgMeta() membaca stride 6 byte per slot.
//     Angka 6 itu berasal dari sizeof() struct C. Menyalinnya sebagai literal
//     ke JS berarti perubahan struct di firmware tidak terbawa - dan payload
//     dibaca dengan offset yang bergeser, menghasilkan sidik jari yang masuk
//     akal tapi salah.
//
//  3. LEBAR STRUCT ACTION. Firmware meletakkan type di byte 0 struct KeyAction
//     lalu value mulai byte 1. App membuat blok berukuran ACTION_LEN sendiri,
//     dengan type di offset 0 dan value dijejer mulai offset 0 juga (sisa
//    byte dipadankan nol). Karena itu stride type dan stride value di app SAMA,
//     dan cfgSigOfPreset() memang memakai ACTION_LEN untuk keduanya.
//    Test silang dengan implementasi C membuktikannya lewat tests/vectors/cfg.vec -
//     kalau lebar ini salah, salah satu dari 13 vektor itu akan gagal.
//
// Modul ini SENGAJA tanpa import apa pun supaya bisa diuji di node tanpa Tauri,
// dan supaya test bisa membandingkannya langsung dengan limits.h.
//
// tests/suites/cfg-layout-test.mjs membandingkan setiap angka di sini dengan
// baris #define yang sebenarnya ada di firmware. Kalau limits.h berubah dan file
// ini tidak, test itu yang lebih dulu gagal - bukan user yang melihat preset
// gagal switch.

// --- Batas dan versi (limits.h) ---

// CONFIG_VERSION: byte pertama bentuk kanonik, jadi ikut dihitung CRC-nya.
// Menaikannya berarti setiap preset tersimpan dianggap berubah - itu disengaja
// dan hanya boleh terjadi kalau bentuk kanoniknya memang berubah.
export const CONFIG_VERSION = 5;

// MAX_LAYERS: batas keras per preset. Device tidak pernah membaca layer di atas
// jumlah ini, jadi layer lebih dari itu tidak boleh ikut dihitung.
export const MAX_LAYERS = 8;

// APP_SLOTS: jumlah slot preset yang disimpan firmware. Dipakai juga untuk
// menggambar tabel slot di CFG_META.
export const APP_SLOTS = 6;

// --- Lebar field (limits.h) ---

// NAME_LEN: lebar field nama layer, termasuk byte penutup NUL.
export const NAME_LEN = 16;

// MACRO_MAX_LEN: lebar field nilai action, termasuk byte penutup NUL.
export const VALUE_LEN = 48;

// Lebar blok action di sisi app. Lihat catatan poin 3 di header.
export const ACTION_LEN = VALUE_LEN;

// ENC_PER_KNOB: binding per knob, yaitu CW / CCW / BTN.
export const ENC_PER_KNOB = 3;

// --- Tata letak payload biner (frame_proto.h) ---

// CFG_META = u8 activeSlot, lalu per slot { u32 sig, u8 layers, u8 valid }.
// Enam byte per slot, tanpa padding: payload frame dikirim apa adanya dan tidak
// pernah melewati struct C.
export const CFG_META_SLOT_STRIDE = 6;
export const CFG_META_HEADER_LEN = 1;
export const CFG_META_PAYLOAD_LEN = CFG_META_HEADER_LEN + APP_SLOTS * CFG_META_SLOT_STRIDE;

// Slot aktif bernilai 0xFF kalau device sedang menampilkan Default Preset,
// bukan salah satu slot preset.
export const SLOT_NONE = 0xff;

// CFG_ACT_RSP = u8 code, u32 appliedSig, u8 slot.
export const CFG_ACT_RSP_LEN = 6;

// --- Bentuk helper ---

/**
 * Dimensi untuk cfgSigOfPreset(). Dihitung dari konstanta modul ini supaya
 * pemanggil tidak bisa kelewat mengetik angka sendiri - itu persis penyebab
 * nilai meleset yang modul ini ada untuk cegah.
 *
 * @param {object} geom {rows, cols, numEncoders}
 * @returns {object} dimensi lengkap untuk cfgSigOfPreset()
 */
export function cfgSigDims({ rows, cols, numEncoders }) {
  return {
    maxLayers: MAX_LAYERS,
    rows,
    cols,
    numEncoders,
    encPerKnob: ENC_PER_KNOB,
    nameLen: NAME_LEN,
    valueLen: VALUE_LEN,
    actionLen: ACTION_LEN,
  };
}