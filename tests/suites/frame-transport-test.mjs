// Test untuk src/frame-transport.js, src/frame-dispatch.js, src/cfg-layout.js.
//
//_modules ini tidak punya test sama sekali sampai sekarang, dan itu bukan
// kebetulan: 315 baris yang menentukan apakah preset switch lewat 8 byte atau
// lewat 600 baris, tanpa satu pun assertion. Test di sini dibuat supaya
// kegagalan bisa ditunjuk ke baris yang salah, bukan "fast path-nya tidak jalan".
//
// Yang diuji, dan alasan setiap kelompok ada:
//
//  A. PARSING PAYLOAD  - parseCfgMeta / parseCfgActRsp / parseErr. Offset salah
//     satu byte menghasilkan sidik jari yang masuk akal tapi salah, dan itu
//     tidak akan pernah muncul sebagai error.
//  B. PEMILIHAN SLOT   - findMatchingSlot / findEmptySlot. Slot yang ditandai
//     tidak sah masih punya sidik jari sisa; mempercayainya berarti app
//     melewati unggahan dan device mengaktifkan keymap yang berbeda.
//  C. CORRELASI        - antrean penunggu per tipe. Dua permintaan tumpang tindih
//     harus dilayani berurutan, tidak saling menimpa.
//  D. DUAL PATH       - byte teks DAN byte biner diproses pada saat yang sama.
//     Ini regresi untuk model "ganti" yang menghapus EVT:LAYER:.
//  E. KONSTANTA       - src/cfg-layout.js dibandingkan dengan limits.h asli.
//  F. STATE UPLOAD    - jendela jawaban diturunkan dari pekerjaan nyata.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

let lulus = 0;
const gagal = [];
function ok(kondisi, nama) {
  if (kondisi) lulus++;
  else gagal.push(nama);
}
function eq(a, b, nama) {
  if (a === b) lulus++;
  else gagal.push(`${nama} (dapat ${JSON.stringify(a)}, harap ${JSON.stringify(b)})`);
}
function eqObj(a, b, nama) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) lulus++;
  else gagal.push(`${nama} (dapat ${x}, harap ${y})`);
}

// Helper invoke() yang dipanggil modul yang mengimpor @tauri-apps/api/core.
// Codec tidak butuh Tauri, jadi yang perlu ditirukan hanya bridge invoke.
globalThis.__tauriStubs = true;

const codec = await import('../../src/frame-codec.js');
const layout = await import('../../src/cfg-layout.js');
const cfgSig = await import('../../src/cfg-sig.js');

// ===================================================================
console.log('\n--- A. Parsing payload jawaban ---');
// ===================================================================

const FT = await import('../../src/frame-transport.js');

// Payload CFG_META yang disusun persis seperti faCmdCfgQuery() di firmware.
function buildCfgMeta({ activeSlot = 0xff, slots }) {
  const p = [activeSlot];
  for (const s of slots) {
    p.push(s.sig & 0xff, (s.sig >>> 8) & 0xff, (s.sig >>> 16) & 0xff, (s.sig >>> 24) & 0xff,
      s.layers & 0xff, s.valid ? 1 : 0);
  }
  return Uint8Array.from(p);
}

const metaPenuh = FT.parseCfgMeta(buildCfgMeta({
  activeSlot: 0xff,
  slots: [
    { sig: 0x292c0f05, layers: 1, valid: true },
    { sig: 0xdeadbeef, layers: 4, valid: true },
    { sig: 0x00000000, layers: 0, valid: false },
    { sig: 0x11111111, layers: 2, valid: true },
    { sig: 0x22222222, layers: 1, valid: true },
    { sig: 0x33333333, layers: 3, valid: true },
  ],
}));
ok(metaPenuh !== null, 'CFG_META penuh terbaca');
eq(metaPenuh.activeSlot, 0xff, 'activeSlot 0xFF terbaca sebagai Default Preset');
eq(metaPenuh.slots.length, 6, 'enam slot terbaca');
eq(metaPenuh.slots[0].sig, 0x292c0f05, 'sidik jari slot 0 (little-endian)');
eq(metaPenuh.slots[1].sig, 0xdeadbeef, 'sidik jari slot 1Interpretation benar');
eq(metaPenuh.slots[1].layers, 4, 'jumlah layer slot 1');
eq(metaPenuh.slots[0].valid, true, 'slot 0 sah');
eq(metaPenuh.slots[2].valid, false, 'slot 2 tidak sah');

// Byte 0xFFFFFFFF harus jadi 4294967295, bukan -1. Sidik jari yang negatif akan
// gagal cocok dengan uint32 dari firmware dan tidak akan pernah ketemu.
const metaTinggi = FT.parseCfgMeta(buildCfgMeta({
  activeSlot: 3,
  slots: [{ sig: 0xffffffff, layers: 1, valid: true },
    ...Array(5).fill({ sig: 0, layers: 0, valid: false })],
}));
eq(metaTinggi.slots[0].sig, 4294967295, 'sidik jari 0xFFFFFFFF tidak menjadi negatif');

// Payload TERPOTONG. Device lama bisa mengirim lebih sedikit slot.
// Slot yang tidak terkirim TIDAK boleh dipad jadi slot "kosong", karena slot
// palsu yang terbaca kosong akan dipilih untuk unggahan baru dan menimpa preset.
const metaPotong = FT.parseCfgMeta(buildCfgMeta({
  activeSlot: 1,
  slots: [{ sig: 0x11111111, layers: 1, valid: true }, { sig: 0x22222222, layers: 1, valid: true }],
}));
eq(metaPotong.slots.length, 2, 'slot yang tidak dikirim dipotong, bukan dipad');
eq(FT.parseCfgMeta(new Uint8Array(0)), null, 'payload kosong ditolak');

// Offset satu byte akan menggeser semua sidik jari. Ini harus gagal, bukan
// "kebetulan menghasilkan angka yang masuk akal".
const geser = Uint8Array.from([0x00, 0x05, 0x0f, 0x2c, 0x29, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00]);
eq(FT.parseCfgMeta(geser).slots.length, 1, 'payload geser hanya menghasilkan satu slot');

// CFG_ACT_RSP
eqObj(FT.parseCfgActRsp(Uint8Array.from([0, 0x05, 0x0f, 0x2c, 0x29, 2])),
  { code: 0, appliedSig: 0x292c0f05, slot: 2 },
  'CFG_ACT_RSP lengkap terbaca');
eq(FT.parseCfgActRsp(Uint8Array.from([1])).code, 1, 'payload hanya code: code terbaca');
eq(FT.parseCfgActRsp(Uint8Array.from([1])).appliedSig, 0, 'appliedSig 0 saat payload pendek');
eq(FT.parseCfgActRsp(new Uint8Array(0)), null, 'CFG_ACT_RSP kosong ditolak');

// ERR
eqObj(FT.parseErr(Uint8Array.from([0x13, 0x16])), { reqType: 0x13, code: 0x16 },
  'ERR terbaca: reqType + code');
eq(FT.parseErr(new Uint8Array(0)).code, 0, 'ERR kosong tidak melempar');

// ===================================================================
console.log('--- B. Pemilihan slot ---');
// ===================================================================

const slots = [
  { sig: 0xaaa, valid: true }, { sig: 0xbbb, valid: false },
  { sig: 0xccc, valid: true }, { sig: 0xaaa, valid: true },
];
eq(FT.findMatchingSlot(0xccc, slots), 2, 'slot cocok pertama yang dipilih');
eq(FT.findMatchingSlot(0xaaa, slots), 0, 'cocok pertama menang, bukan yang terakhir');
eq(FT.findMatchingSlot(0x999, slots), -1, 'tidak ada yang cocok -> -1');
// INI yang mudah salah: sidik jari sama persis, tapi slot ditandai tidak sah.
eq(FT.findMatchingSlot(0xbbb, slots), -1, 'slot tidak sah DITOLAK walau sidik jarinya sama');
eq(FT.findEmptySlot(slots), 1, 'slot kosong pertama');
eq(FT.findEmptySlot(Array(4).fill({ sig: 1, valid: true })), -1, 'semua penuh -> -1');
eq(FT.findMatchingSlot(1, null), -1, 'slots null ditangani');
eq(FT.findEmptySlot(undefined), -1, 'slots undefined ditangani');

// ===================================================================
console.log('--- C. Korelasi jawaban frame ---');
// ===================================================================

const RX = await import('../../src/frame-dispatch.js');

RX.resetFrameRx();
eq(RX.frameRxStats().waiting, 0, 'tidak ada penunggu setelah reset');

// Suatu saat device membalas frame; harus sampai ke penunggu yang tepat.
const p1 = RX.waitForFrame(codec.T_CFG_META, 500);
RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_CFG_META, [0xff, 1, 2, 3, 4, 1, 1])));
eq((await p1)[0], 0xff, 'jawaban CFG_META sampai ke penunggu');

// DUA penunggu untuk tipe yang sama harus dilayani berurutan. Versi pertama
// menyimpan satu variabel global, jadi yang kedua menimpa yang pertama dan yang
// pertama menggantung sampai timeout.
RX.resetFrameRx();
const a = RX.waitForFrame(codec.T_CFG_META, 800);
const b = RX.waitForFrame(codec.T_CFG_META, 800);
RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_CFG_META, [0x01])));
RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_CFG_META, [0x02])));
eq((await a)[0], 0x01, 'penunggu pertama menerima frame pertama');
eq((await b)[0], 0x02, 'penunggu kedua menerima frame kedua (tidak tertukar)');

// Tipe berbeda tidak saling mengganggu. Kalau pemetaannya salah, HELLO_RSP akan
// diambil penunggu CFG_META dan sebaliknya tidak akan pernah sampai.
RX.resetFrameRx();
const m = RX.waitForFrame(codec.T_CFG_META, 800);
const h = RX.waitForFrame(codec.T_HELLO_RSP, 800);
RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_HELLO_RSP, [2, 7])));
ok((await h) !== null, 'HELLO_RSP tidak tertelan oleh penunggu CFG_META');
RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_CFG_META, [0xff])));
ok((await m) !== null, 'penunggu CFG_META tetap utuh setelah frame lain lewat');

// Timeout harus mengembalikan null, bukan menggantung atau melempar.
RX.resetFrameRx();
const t = await RX.waitForFrame(codec.T_CFG_META, 60);
eq(t, null, 'timeout mengembalikan null');

// resetFrameRx() harus membatalkan penunggu yang sedang menggantung, supaya
// auto-switch preset tidak ikut tertahan sampai batas waktu penuh.
RX.resetFrameRx();
const batal = await RX.waitForFrame(codec.T_CFG_META, 30000);
const mulai = Date.now();
RX.resetFrameRx();
eq(await batal, null, 'resetFrameRx() membatalkan penunggu yang menggantung');
ok(Date.now() - mulai < 500, 'pembatalan terjadi seketika, bukan menunggu 30 detik');

// ===================================================================
console.log('--- D. Byte teks dan biner dua-duanya diproses ---');
// ===================================================================

// INI regresi untuk model "ganti": versi pertama mengalihkan SELURUH byte ke
// frame decoder begitu ada penunggu, sehingga parser baris dilewati. Bukti dari
// perangkat: device mengirim EVT:LAYER:0 sebagai TEKS tepat setelah
// CFG_ACTIVATE, jadi event itu hilang dan app tidak bereaksi.
//
// FrameDecoder hanya bereaksi pada SOF 0xA5, jadi teks harus lewat perakit
// tanpa merusak dan tanpa menghasilkan frame.
RX.resetFrameRx();
const frameTeks = RX.waitForFrame(codec.T_CFG_META, 500);
const teks = Buffer.from('EVT:LAYER:0\nDUMP_END\n', 'utf8');
eq(RX.feedFrameBytes(Uint8Array.from(teks)), 0, 'teks tidak dihitung sebagai frame');
eq(RX.frameRxStats().err_crc, 0, 'teks tidak menambah err_crc');
eq(RX.frameRxStats().err_ver, 0, 'teks ASCII tidak memicu SOF');
RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_CFG_META, [0xff])));
ok((await frameTeks) !== null, 'frame setelah teks tetap diterima');

// Teks yang memuat byte 0xA5 (lambang yen, UTF-8 C2 A5) akan memicu percobaan
// SOF yang gagal. Yang diuji bukan "tidak boleh terjadi" - itu tidak mungkin,
// karena 0xA5 memang continuation byte UTF-8 yang sah - tapi "frame utuh
// sesudahnya tetap tidak rusak".
RX.resetFrameRx();
const setelahYen = RX.waitForFrame(codec.T_CFG_META, 500);
RX.feedFrameBytes(Uint8Array.from(Buffer.from('nilai ¥ 100\n', 'utf8')));
eq(RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_CFG_META, [7]))), 1,
  'frame setelah teks berisi 0xA5 tetap utuh');
eq((await setelahYen)[0], 7, 'payload frame setelah 0xA5 tidak bergeser');

// Frame yang TERBAGI dua chunk harus tetap lengkap. Decoder persisten
// purposefully dipakai di sini: decoder baru per permintaan akan kehilangan
// setengah frame setiap kali notify BLE membelah di tengah payload.
RX.resetFrameRx();
const terbagi = RX.waitForFrame(codec.T_CFG_META, 500);
const utuh = Uint8Array.from(codec.encode(codec.T_CFG_META, [1, 2, 3, 4, 5, 6, 1, 1]));
RX.feedFrameBytes(utuh.slice(0, 4));
eq(RX.feedFrameBytes(utuh.slice(4)), 1, 'frame terbelah dua chunk tetap lengkap');
ok((await terbagi) !== null, 'payload frame terbelah diterima');

// Frame tanpa penunggu dihitung sebagai orphan, bukan dibuang diam-diam.
// Angka ini yang membedakan "device diam" dari "app tidak pernah menunggu".
RX.resetFrameRx();
RX.feedFrameBytes(Uint8Array.from(codec.encode(codec.T_EVT, [1])));
eq(RX.frameRxStats().orphans, 1, 'frame tanpa penerima dihitung sebagai orphan');

// ===================================================================
console.log('--- E. Konstanta layout cocok dengan firmware ---');
// ===================================================================

const limits = fs.readFileSync(path.join(REPO, 'firmware', 'common', 'limits.h'), 'utf8');
function define(name) {
  const m = limits.match(new RegExp(`#define\\s+${name}\\s+([0-9]+)`));
  return m ? parseInt(m[1], 10) : null;
}

eq(layout.CONFIG_VERSION, define('CONFIG_VERSION'), 'CONFIG_VERSION sama dengan limits.h');
eq(layout.MAX_LAYERS, define('MAX_LAYERS'), 'MAX_LAYERS sama dengan limits.h');
eq(layout.NAME_LEN, define('NAME_LEN'), 'NAME_LEN sama dengan limits.h');
eq(layout.VALUE_LEN, define('MACRO_MAX_LEN'), 'VALUE_LEN sama dengan MACRO_MAX_LEN');
eq(layout.APP_SLOTS, define('APP_SLOTS'), 'APP_SLOTS sama dengan limits.h');

// Stride CFG_META harus cocok dengan yang benar-benar dipakai firmware, bukan
// dengan sizeof(struct) yang di kira-kira. Dipotong dari faCmdCfgQuery().
const frameProto = fs.readFileSync(path.join(REPO, 'firmware', 'common', 'frame_proto.h'), 'utf8');
ok(/resp\[1 \+ APP_SLOTS \* 6\]/.test(frameProto), 'firmware memang mengirim 1 + APP_SLOTS*6');
eq(layout.CFG_META_SLOT_STRIDE, 6, 'stride CFG_META = 6 sesuai firmware');
eq(layout.CFG_META_PAYLOAD_LEN, 1 + 6 * 6, 'panjang CFG_META penuh = 37');
eq(layout.CFG_META_PAYLOAD_LEN, frameProto.match(/resp\[1 \+ APP_SLOTS \* 6\]/) ? 37 : -1,
  'panjang yang dihitung app sama dengan yang dikirim firmware');

// Konstanta response harus DITURUNKAN dari request + RESP_BIT, bukan literal.
ok(codec.T_CFG_META === (codec.T_CFG_QUERY | codec.RESP_BIT), 'T_CFG_META diturunkan, bukan literal');
ok(codec.T_CFG_ACT_RSP === (codec.T_CFG_ACTIVATE | codec.RESP_BIT), 'T_CFG_ACT_RSP diturunkan');
ok(codec.T_CFG_META === 0x93, 'nilai T_CFG_META sesuai FA_T_CFG_META firmware');
ok(codec.T_CFG_ACT_RSP === 0x94, 'nilai T_CFG_ACT_RSP sesuai FA_T_CFG_ACT_RSP firmware');
const frameH = fs.readFileSync(path.join(REPO, 'firmware', 'common', 'frame.h'), 'utf8');
const respBitC = frameH.match(/#define\s+FA_RESP_BIT\s+(0x[0-9A-Fa-f]+)u/);
ok(respBitC && codec.RESP_BIT === parseInt(respBitC[1], 16),
  'RESP_BIT di JS sama dengan FA_RESP_BIT di firmware');

// ===================================================================
console.log('--- F. presetSig memakai konstanta yang benar ---');
// ===================================================================

const geom = { rows: 3, cols: 3, numEncoders: 1 };

// Bentuk preset di app adalah keys[r][c] (2D), hasil packCurrentAsPresetLayers().
// Menguji dengan array datar akan lolos secara kebetulan, jadi bentuknya harus
// benar di sini.
function keys2d(sideal) {
  return Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 3 }, (_, c) =>
      (r === 1 && c === 1 && sideal) ? { type: 7, value: 'C:/x.exe' } : { type: 0, value: '' }));
}
function preset(namaLayer, sideal, enc = null) {
  return {
    layers: [{
      name: namaLayer,
      keys: keys2d(sideal),
      encCw: enc ? [enc] : [{ type: 0, value: '' }],
      encCcw: [{ type: 0, value: '' }],
      encBtn: [{ type: 0, value: '' }],
    }],
  };
}

const sigA = FT.presetSig(preset('L', false), geom);
const sigB = FT.presetSig(preset('L', true), geom);
ok(sigA !== sigB, 'isi tombol berbeda -> sidik jari berbeda');

const sigC = FT.presetSig(preset('Lain', false), geom);
ok(sigA !== sigC, 'nama layer berbeda -> sidik jari berbeda');

eq(FT.presetSig(preset('L', false), geom), sigA, 'preset sama -> sidik jari sama (stabil)');

// Najam: nama layer lebih panjang dari NAME_LEN harus dipotong, persis seperti
// firmware. Kalau tidak, dua nama yang device potong jadi sama punya sidik jari
// berbeda di app - dan app akan mengunggah ulang tanpa henti.
const namaPanjang = 'X'.repeat(layout.NAME_LEN + 10);
const namaTepat = 'X'.repeat(layout.NAME_LEN);
eq(FT.presetSig(preset(namaPanjang, false), geom),
  FT.presetSig(preset(namaTepat, false), geom),
  'nama layer dipotong ke NAME_LEN seperti firmware');

// Jumlah layer di atas MAX_LAYERS tidak boleh ikut dihitung.
function lapis(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `L${i}`, keys: keys2d(false),
    encCw: [{ type: 0, value: '' }], encCcw: [{ type: 0, value: '' }], encBtn: [{ type: 0, value: '' }],
  }));
}
eq(FT.presetSig({ layers: lapis(layout.MAX_LAYERS + 4) }, geom),
  FT.presetSig({ layers: lapis(layout.MAX_LAYERS) }, geom),
  'layer di atas MAX_LAYERS diabaikan seperti firmware');

// Ukuran matriks salah harus menghasilkan sidik jari BERBEDA, bukan diam-diam
// sama. Kalau sama, app akan menganggap device sudah punya preset padahal tidak.
ok(FT.presetSig(preset('L', false), { rows: 3, cols: 3, numEncoders: 2 }) !== sigA,
  'jumlah encoder berbeda -> sidik jari berbeda');

// --- Kasus yang menemukan bug nyata ---
//
// Encoder di firmware GLOBAL: SETENC menulis ke activeCfg->encCW[encIdx] tanpa
// indeks layer. buildPresetLines() mengirim SETENC untuk setiap layer berurutan,
// jadi lapisan TERAKHIR menimpa semua yang sebelumnya, dan device menyimpan satu
// set binding saja. cfgSig() juga cuma membaca c.encCW[0] di luar loop layer.
//
// Kalau app menghitung sidik jari dari layer 0, dua angka itu tidak akan pernah
// sama: preset yang sebenarnya sudah ada di device akan selalu dianggap baru.
const duaLap = (enc0, enc1) => ({
  layers: [
    { name: 'A', keys: keys2d(false), encCw: [enc0], encCcw: [{ type: 0, value: '' }], encBtn: [{ type: 0, value: '' }] },
    { name: 'B', keys: keys2d(false), encCw: [enc1], encCcw: [{ type: 0, value: '' }], encBtn: [{ type: 0, value: '' }] },
  ],
});
const encA = { type: 7, value: 'C:/a.exe' };
const encB = { type: 9, value: 'C:/b.exe' };

eq(FT.presetSig(duaLap(encA, encB), geom), FT.presetSig(duaLap(encB, encB), geom),
  'encoder dihitung dari layer TERAKHIR (device hanya menyimpan yang terakhir)');
ok(FT.presetSig(duaLap(encA, encA), geom) !== FT.presetSig(duaLap(encA, encB), geom),
  'encoder layer terakhir yang berbeda -> sidik jari berbeda');

// Konvensi ini harus dikunci ke firmware, bukan hanya ke Conventions app.
// Kalau SETENC nanti diubah jadi per-layer, assertion ini yang harus gagal.
ok(/activeCfg->encCW\[encIdx\] = newAction/.test(
  fs.readFileSync(path.join(REPO, 'firmware', 'common', 'macropad_core.h'), 'utf8')),
  'firmware memang menyimpan encoder secara global (tanpa indeks layer)');

// Kontrak sigHex harus sama dengan firmware.
eq(FT.sigHex(0x292c0f05), '292c0f05', 'sigHex 8 digit huruf kecil');
eq(FT.sigHex(0x0000000a), '0000000a', 'sigHex mengisi nol di depan');

// ===================================================================
console.log('--- G. State upload diturunkan dari pekerjaan ---');
// ===================================================================

const UP = await import('../../src/upload-state.js');

UP.resetBatchUploadState();
eq(UP.batchUploadInFlight(), false, 'setelah reset: device tidak dianggapBusy');
eq(UP.answerWindowMs(), 0, 'tanpa pekerjaan tidak ada jendela jawaban');

// Batch KECIL: jendela harus jauh lebih pendek dari tebakan 4000 ms lama.
// Batch kecil selesai dalam hitungan milidetik, jadi menahan watchdog dump
// 4 detik penuh, dan 4 detik itu terbuang sia-sia.
UP.beginCfgTransfer(3);
eq(UP.cfgTransferActive(), true, 'transfer ditandai aktif');
eq(UP.batchUploadInFlight(), true, 'selama transfer, device dianggap sibuk');
UP.endCfgTransfer();
eq(UP.cfgTransferActive(), false, 'endCfgTransfer menutup flag');
const kecil = UP.answerWindowMs();
ok(kecil < 1000, `batch kecil -> jendela pendek (${kecil} ms), bukan 4000 ms`);

// Batch BESAR: jendela harus lebih panjang. Ini arah yang salah kalau tidak
// diperiksa - di situlah watchdog salah melaporkan dump yang sehat sebagai hilang.
UP.resetBatchUploadState();
UP.beginCfgTransfer(600);
UP.endCfgTransfer();
const besar = UP.answerWindowMs();
ok(besar > kecil, `batch besar -> jendela lebih panjang (${besar} ms > ${kecil} ms)`);
ok(besar <= 20000, 'jendela dibatasi atas supaya tidak menggantung selamanya');

//.noteCfgCommands() memperpanjang jendela dari titik pengiriman, bukan dari awal
// transfer. Tanpa itu, potongan batch terakhir tidak memperhitungkan waktu.
UP.resetBatchUploadState();
UP.beginCfgTransfer(3);
UP.endCfgTransfer();
const sebelum = UP.answerWindowMs();
UP.noteCfgCommands(300);
ok(UP.answerWindowMs() > sebelum, 'perintah susulan memperpanjang jendela');

// Jendela harus benar-benar menutup setelah waktu habis - kalau tidak, watchdog
// dump tidak akan pernah hidup lagi selama sesi itu.
UP.resetBatchUploadState();
UP.beginCfgTransfer(2);
UP.endCfgTransfer();
UP.noteCfgCommands(2);
ok(UP.batchUploadInFlight(), 'jendela terbuka sesaat setelah transfer ditutup');
UP.cfgAnswersSettled();
eq(UP.batchUploadInFlight(), false, 'cfgAnswersSettled() menutup jendela');

// Transfer aktif harus menang atas jendela yang sudah habis: selama masih ada
// perintah yang dikirim, device belum tentu selesai.
UP.resetBatchUploadState();
UP.beginCfgTransfer(1);
eq(UP.batchUploadInFlight(), true, 'flag eksplisit menang atas jendela');

// ===================================================================
console.log('--- G½. Konstanta Fase 5 (credit flow control) ---');
// ===================================================================

// Frame type untuk credit flow control harus ada dan sesuai firmware.
eq(codec.T_CFG_READY, 0x15, 'T_CFG_READY = 0x15 (FA_T_CFG_READY)');
eq(codec.T_CREDIT, 0x16, 'T_CREDIT = 0x16 (FA_T_CREDIT)');

// ERR code untuk credit flow control.
eq(codec.ERR_CREDIT_EXHAUSTED, 0x13, 'ERR_CREDIT_EXHAUSTED = 0x13');
eq(codec.ERR_STAGING_FULL, 0x14, 'ERR_STAGING_FULL = 0x14');
eq(codec.ERR_CRC32_MISMATCH, 0x15, 'ERR_CRC32_MISMATCH = 0x15');
eq(codec.ERR_UNSUPPORTED, 0x16, 'ERR_UNSUPPORTED = 0x16');

// Semua ERR_NAMES di frame-transport.js harus mencakup semua kode di atas.
const ftSrc = fs.readFileSync(path.join(REPO, 'src', 'frame-transport.js'), 'utf8');
ok(/'CREDIT_EXHAUSTED'/.test(ftSrc), 'ERR_NAMES mencakup CREDIT_EXHAUSTED');
ok(/'STAGING_FULL'/.test(ftSrc), 'ERR_NAMES mencakup STAGING_FULL');
ok(/'CRC32_MISMATCH'/.test(ftSrc), 'ERR_NAMES mencakup CRC32_MISMATCH');
ok(/'UNSUPPORTED'/.test(ftSrc), 'ERR_NAMES mencakup UNSUPPORTED');

// uploadPresetBinary harus memakai T_CFG_READY, T_CREDIT, T_CFG_WRITE, sendRawNoAck.
ok(/T_CFG_READY/.test(ftSrc) && /T_CREDIT/.test(ftSrc), 'uploadPresetBinary memakai T_CFG_READY + T_CREDIT');
ok(/sendRawNoAck/.test(ftSrc), 'uploadPresetBinary memakai sendRawNoAck untuk CFG_WRITE');
// CFG_BEGIN dikirim via sendFrame (WriteWithResponse), bukan sendRawNoAck.
const beginSection = ftSrc.slice(ftSrc.indexOf('1. CFG_BEGIN'), ftSrc.indexOf('2. CFG_WRITE'));
ok(/sendFrame.*T_CFG_BEGIN/.test(beginSection), 'CFG_BEGIN via sendFrame (WriteWithResponse)');

// transport.js facade harus mengekspor sendRawNoAck.
const transportSrc = fs.readFileSync(path.join(REPO, 'src', 'transport.js'), 'utf8');
ok(/sendRawNoAck/.test(transportSrc), 'transport.js mengekspor sendRawNoAck');

// Rust: command ble_write_no_ack terdaftar di lib.rs.
const libSrc = fs.readFileSync(path.join(REPO, 'src-tauri', 'src', 'lib.rs'), 'utf8');
ok(/ble_write_no_ack/.test(libSrc), 'lib.rs mendaftarkan command ble_write_no_ack');

// Rust: write_no_ack() pakai WriteWithoutResponse, write() pakai WriteWithResponse.
const bleRust = fs.readFileSync(path.join(REPO, 'src-tauri', 'src', 'ble.rs'), 'utf8');
const bleRustStripped = bleRust.replace(/\/[\s\S]*?\*/g, '').replace(/^\s*\/\/.*$/gm, '');
const writeFnBody = bleRustStripped.slice(
  bleRustStripped.indexOf('fn write('),
  bleRustStripped.indexOf('fn write_no_ack(')
);
ok(/WriteWithResponse/.test(writeFnBody), 'Rust write() pakai WriteWithResponse');
ok(!/WriteWithoutResponse/.test(writeFnBody), 'Rust write() TIDAK pakai WriteWithoutResponse');

// ===================================================================
console.log('--- H. Kontrak wiring transport ---');
// ===================================================================

// Dua jalur HARUS berjalan berdampingan. Model "ganti" (semua byte dialihkan ke
// frame decoder begitu ada penunggu) menghapus event real-time yang tetap keluar
// sebagai teks - buktinya dari perangkat: EVT:LAYER:0 keluar sebagai teks tepat
// setelah CFG_ACTIVATE.
//
// Yang diuji di sini adalah KONTRAK di source backend, karena perilaku
//_combined_ sudah diuji di bagian D. Tanpa ini, penyuntingan diam-diam yang
// mengembalikan model "ganti" akan lolos semua test lain.
const serialSrc = fs.readFileSync(path.join(REPO, 'src', 'serial-transport.js'), 'utf8');
const bleSrc = fs.readFileSync(path.join(REPO, 'src', 'ble-transport.js'), 'utf8');

for (const [nama, src] of [['serial-transport.js', serialSrc], ['ble-transport.js', bleSrc]]) {
  ok(/feedFrameBytes\s*\(/.test(src), `${nama} mengalirkan byte ke frame RX`);
  ok(/handleIncomingChunk\s*\(/.test(src), `${nama} tetap mengalirkan byte ke parser baris`);
  ok(!/getFrameDataHandler/.test(src), `${nama} tidak memakai model "ganti" yang sudah dihapus`);
}

// Parser baris harus tetap berjalan di kedua backend, dan keduanya harus
// berhenti SEBELUM baris diproses - kalau tidak, satu chunk bisa diproses dua
// kali (menggandakan INFO, dan INFO memicu loadLayer dua kali).
ok(/feedFrameBytes\(bytes\);[\s\S]{0,200}lineBuffer \+=/.test(serialSrc),
  'serial: frame RX dipanggil sebelum baris masuk lineBuffer (urutan benar)');
ok(/feedFrameBytes\(bytes\);[\s\S]{0,200}handleIncomingChunk\(/.test(bleSrc),
  'ble: frame RX dipanggil sebelum parser baris (urutan benar)');

// State frame harus ikut dibersihkan saat parser dirapikan. Kalau tidak,
// setengah frame dari sesi lama menempel pada byte pertama device berikutnya.
ok(/resetParserState\(\)\s*\{[\s\S]{0,400}resetFrameRx\(\)/.test(serialSrc),
  'serial: resetParserState() juga membersihkan state frame');
ok(/resetParserState\(\)\s*\{[\s\S]{0,1600}resetFrameRx\(\)/.test(bleSrc),
  'ble: resetParserState() juga membersihkan state frame');

// PONG harus dilaporkan ke probe, supaya ensureLineMode() punya bukti nyata
// bahwa device sudah keluar dari mode frame.
const parserSrc = fs.readFileSync(path.join(REPO, 'src', 'protocol-parser.js'), 'utf8');
ok(/reportPong\s*\(\s*\)/.test(parserSrc), 'parser melaporkan PONG ke probe');
// Baris kosong pernah dipakai untuk memaksa device keluar dari mode frame tanpa
// diverifikasi.
//
// Komentar harus dibuang dulu: penjelasan kenapa pola itu dihapus wajar sekali
// menyebutnya, dan kalau tidak dibuang setiap penambahan satu kalimat yang wajar
// akan menggagalkan test.
//
// Polanya /\/\/.*/ tanpa akhiran $: baris sudah dipisah dengan split('\n'), jadi
// tidak perlu anchor, dan `.*` greedy sudah memakan sisa baris. Versi dengan $
// gagal diam-diam pada file BER-CR-LF, karena $ tanpa flag m tidak cocok
// sebelum \r di akhir baris - jadi test ini akan selalu hijau tanpa alasan.
const adaptiveKode = fs.readFileSync(path.join(REPO, 'src', 'adaptive.js'), 'utf8')
  .split('\n').map(l => l.replace(/\/\/.*/, '')).join('\n');
ok(!/sendLine\s*\(\s*''\s*\)/.test(adaptiveKode),
  'adaptive.js tidak lagi memakai baris kosong sebagai sakelar mode');

// ===================================================================
console.log('--- I. Ringkasan ---');
// ===================================================================
console.log(`\n${lulus} assertion lulus, ${gagal.length} gagal`);
if (gagal.length) {
  console.log('\nGAGAL:');
  gagal.forEach(g => console.log('  FAIL ' + g));
}
const fail = gagal.length;
process.exit(fail === 0 ? 0 : 1);