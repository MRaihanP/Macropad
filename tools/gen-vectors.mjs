#!/usr/bin/env node
// =================== GENERATOR GOLDEN VECTORS ===================
//
// SATU-SATUNYA sumber kebenaran untuk pengujian codec frame.
//
// File yang dihasilkan: tests/vectors/frames.vec
//
// Format txt (sengaja sederhana supaya bisa dibaca tanpa parser dari tiga
// bahasa: JS, Rust, dan C - ketiganya cuma perlu split whitespace):
//
//   #  baris komentar
//   SEQ <nama> <hex byte> <ekspektasi>
//
// <ekspektasi> adalah daftar event yang HARUS muncul berurutan, dipisah koma:
//
//   F:0x13      satu frame valid dengan TIPE 0x13
//   E:BAD_CRC   satu kesalahan
//   NONE        tidak boleh ada event sama sekali
//
// Contoh:
//
//   SEQ cfg_query  a5 02 13 00 00 af d6            F:0x13
//   SEQ crc_rusak a5 02 20 03 00 00 00 00          E:BAD_CRC
//   SEQ pulih     a5 02 20 01 00 00 ab cd a5 02 13 00 00 af d6   E:BAD_CRC,F:0x13
//
// Format SEQ dipakai (bukan "VALID"/"ERR" terpisah) karena ada kelas kasus yang
// tidak bisa dinyatakan oleh format dua jenis itu: satu frame rusak DITEMUKAN
// dan framework harus pulih untuk membaca frame sah berikutnya. Kalau kasus itu
// tidak dinyatakan eksplisit, test jadi hanya memeriksa "ada error" - dan
// kemampuan pulih bisa rusak tanpa terdeteksi.
//
// Jalankan: node tools/gen-vectors.mjs
//
// kenapa file ini di-generate, bukan ditulis tangan:
//
//  1. CRC harus dihitung oleh implementasi yang BENAR, bukan diketik manual.
//     Kalau angka CRC diketik tangan, testnya hanya membuktikan bahwa angka
//     yang diketik konsisten, bukan bahwa algoritmanya benar.
//  2. Vektor harus dibangun dari ATURAN yang sama dengan frame.h. Generator
//     mengimplementasikan aturan itu sekali; tiga decoder lain diuji terhadap
//     hasilnya.
//  3. Saat format berubah, cukup jalankan ulang generator - tidak ada checksum
//     yang harus diperbarui tangan dan diam-diam basi.
//
// Jalankan ulang setiap kali frame.h berubah.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'vectors', 'frames.vec');

// ---- Konstanta, harus identik dengan firmware/common/frame.h ----
const SOF = 0xa5;
const VER = 0x02;
const HEADER_LEN = 5;
const OVERHEAD = 7;
const MAX_PAYLOAD = 512;

const T_HELLO = 0x01;
const T_LINE = 0x02;
const T_CFG_BEGIN = 0x10;
const T_CFG_WRITE = 0x11;
const T_CFG_COMMIT = 0x12;
const T_CFG_QUERY = 0x13;
const T_CFG_ACTIVATE = 0x14;
const T_EVT = 0x20;
const T_ERR = 0x7f;

/** CRC16/CCITT-FALSE - parameter harus sama persis dengan frame.h. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= (b << 8) & 0xffff;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Header + payload + CRC, persis seperti faEncode(). */
export function encode(type, payload = []) {
  const len = payload.length;
  const body = [type, len & 0xff, (len >> 8) & 0xff, ...payload];
  const crc = crc16(body);
  return [SOF, VER, ...body, crc & 0xff, (crc >> 8) & 0xff];
}

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

// ---- Kumpulan vektor ----
// Each entry: [nama, bytes, ekspektasi].
// Ekspektasi ditulis sebagai F:<tipe> / E:<kode> / NONE.
const CASES = [];
const seq = (name, bytes, expect) => CASES.push({ name, bytes, expect });

const F = (t) => `F:0x${t.toString(16).padStart(2, '0')}`;
const E = (c) => `E:${c}`;

// --- 1. Bentuk dasar ---
seq('hello_kosong', encode(T_HELLO, []), [F(T_HELLO)]);
seq('cfg_query_kosong', encode(T_CFG_QUERY, []), [F(T_CFG_QUERY)]);
seq('payload_1_byte', encode(T_EVT, [0x00]), [F(T_EVT)]);
seq('payload_8_byte', encode(T_CFG_ACTIVATE, [1, 2, 3, 4, 5, 6, 7, 8]), [F(T_CFG_ACTIVATE)]);
seq('payload_16_byte', encode(T_CFG_COMMIT,
  Array.from({ length: 16 }, (_, i) => (i * 7) & 0xff)), [F(T_CFG_COMMIT)]);
seq('payload_32_byte', encode(T_CFG_BEGIN,
  Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff)), [F(T_CFG_BEGIN)]);

// --- 2. Semua jenis frame harus punya minimal satu vektor ---
// Tanpa ini, test bisa hijau padahal satu jenis frame tidak pernah diuji sama
// sekali - dan itu kelas bug yang paling mahal ditemukan belakangan.
seq('tipe_line', encode(T_LINE, Array.from('DIAG', (c) => c.charCodeAt(0))), [F(T_LINE)]);
seq('tipe_cfg_write', encode(T_CFG_WRITE, [0x00, 0x00, 0xde, 0xad]), [F(T_CFG_WRITE)]);
seq('tipe_err', encode(T_ERR, [0x02, 0x01]), [F(T_ERR)]);
seq('tipe_evt', encode(T_EVT, [0x01, 0x00]), [F(T_EVT)]);
seq('tipe_hello', encode(T_HELLO, [0x02, 0x05, 0xed, 0x00]), [F(T_HELLO)]);

// --- 3. Kasus batas panjang ---
seq('payload_255', encode(T_CFG_WRITE, new Array(255).fill(0xa5)), [F(T_CFG_WRITE)]);
seq('payload_256', encode(T_CFG_WRITE, new Array(256).fill(0x00)), [F(T_CFG_WRITE)]);
seq('payload_maks_512', encode(T_CFG_WRITE, new Array(MAX_PAYLOAD).fill(0x5a)), [F(T_CFG_WRITE)]);

// --- 4. Payload yang berisi byte struktural ---
// Kasus yang paling mudah salah. Kalau SOF (0xA5) atau VER (0x02) muncul di
// dalam payload, perakit yang salah akan salah memotong frame. Vektor ini ada
// supaya kelas bug itu mustahil lolos diam-diam.
const campur = [SOF, VER, 0x00, 0xff, SOF, SOF, 0x0a, 0x0d, 0x02, SOF];
seq('payload_ada_sof_dan_ver', encode(T_CFG_WRITE, campur), [F(T_CFG_WRITE)]);
seq('payload_panjang_ada_sof', encode(T_CFG_WRITE,
  Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? SOF : (i & 0xff)))), [F(T_CFG_WRITE)]);
seq('payload_panjang_ada_versinya', encode(T_EVT,
  Array.from({ length: 200 }, (_, i) => (i % 5 === 0 ? VER : (i & 0x7f)))), [F(T_EVT)]);

// --- 5. Semua nilai byte 0..255 ---
// Menutup kemungkinan ada byte tertentu yang membuat state machine berhenti di tempat
// berhenti di tempat yang tidak terduga.
seq('payload_semua_byte', encode(T_EVT, Array.from({ length: 256 }, (_, i) => i)), [F(T_EVT)]);

// --- 6. Beberapa frame bersambung tanpa jeda ---
// Memverifikasi perakit kembali ke mode cari-SOF dengan benar setelah satu frame
// selesai, dan langsung bisa menerima frame berikutnya.
seq('dua_frame_berturut', [
  ...encode(T_CFG_QUERY, []),
  ...encode(T_EVT, [0xaa]),
], [F(T_CFG_QUERY), F(T_EVT)]);

seq('tiga_frame_berturut', [
  ...encode(T_CFG_QUERY, []),
  ...encode(T_HELLO, [0x02]),
  ...encode(T_EVT, [0x01, 0x02, 0x03]),
], [F(T_CFG_QUERY), F(T_HELLO), F(T_EVT)]);

// --- 7. Salah CRC ---
{
  const b = encode(T_EVT, [1, 2, 3, 4, 5]);
  const rusak = [...b];
  rusak[rusak.length - 1] ^= 0x01;
  seq('crc_salah_satu_bit', rusak, [E('BAD_CRC')]);
}
{
  const b = encode(T_CFG_WRITE, new Array(64).fill(0x33));
  const rusak = [...b];
  rusak[7] ^= 0x80;
  seq('crc_payload_rusak', rusak, [E('BAD_CRC')]);
}
{
  // CRC ditukar byte-nya (endianness terbalik). Perakit harus tetap menolak:
  // ini memastikan urutan byte CRC benar-benar little-endian di ketiga bahasa.
  const b = encode(T_EVT, [0x11, 0x22]);
  seq('crc_ditukar_endian',
    [...b.slice(0, b.length - 2), b[b.length - 1], b[b.length - 2]], [E('BAD_CRC')]);
}

// --- 8. Salah versi ---
seq('versi_tidak_dikenal', [SOF, 0x03, T_EVT, 0x00, 0x00, 0x00, 0x00], [E('BAD_VER')]);
seq('versi_nol', [SOF, 0x00, T_EVT, 0x00, 0x00, 0x00, 0x00], [E('BAD_VER')]);

// --- 9. LEN melebihi batas ---
// 513 = FA_MAX_PAYLOAD + 1. Perakit harus melompat ke SKIP dan membuang sisa
// payload, lalu melaporkan error SETELAH membuang semuanya.
seq('len_513', [
  SOF, VER, T_CFG_WRITE, 0x01, 0x02,
  ...new Array(513).fill(0xcc),
], [E('LEN_OVERFLOW')]);

// LEN maksimum uint16 tanpa payloadnya. Perakit HARUS tetap diam (masih di
// SKIP) - tidak boleh melaporkan error lebih dulu dan tidak boleh keluar dari
// SKIP. Ini menguji bahwa LEN monster tidak membuat perakit ikut terdesync ke
// tengah payload.
seq('len_u16_tanpa_payload', [SOF, VER, T_CFG_WRITE, 0xff, 0xff, 0x00, 0x00], ['NONE']);

// --- 10. Pemulihan setelah frame rusak ---
// Salah satu, seluruh stream berikutnya HARUS tetap terbaca. Tanpa kasus ini,
// satu CRC rusak akan mematikan seluruh sesi dan gejalanya "device mati".
{
  const rusak = encode(T_EVT, [9, 9]);
  rusak[rusak.length - 1] ^= 0xff;
  seq('pulih_setelah_crc_rusak', [
    ...rusak,
    ...encode(T_CFG_QUERY, []),
  ], [E('BAD_CRC'), F(T_CFG_QUERY)]);
}
{
  seq('pulih_setelah_versi_salah', [
    SOF, 0x09, 0x11, 0x22, 0x33,
    ...encode(T_CFG_ACTIVATE, [2]),
  ], [E('BAD_VER'), F(T_CFG_ACTIVATE)]);
}
{
  // Dua frame rusak berturut-turut lalu frame sah. Menguji bahwa resync
  // bekerja lebih dari sekali.
  const r1 = encode(T_EVT, [1]);
  r1[r1.length - 1] ^= 0xff;
  const r2 = encode(T_EVT, [2]);
  r2[r2.length - 1] ^= 0xff;
  seq('pulih_dua_kali', [
    ...r1, ...r2,
    ...encode(T_CFG_QUERY, []),
  ], [E('BAD_CRC'), E('BAD_CRC'), F(T_CFG_QUERY)]);
}

// --- 11. Noise sebelum frame ---
// Serial Monitor / teks lain bisa sampai ke stream yang sama. Semua byte
// sebelum SOF harus diabaikan tanpa melaporkan error.
seq('noise_sebelum_frame', [
  0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x0a,   // "Hello\0\n"
  ...encode(T_EVT, [0x42]),
], [F(T_EVT)]);

seq('noise_panjang', [
  ...new Array(200).fill(0x00),
  ...encode(T_EVT, [0x01]),
], [F(T_EVT)]);
// --- 12. SOF beruntun ---
// Byte SOF berulang adalah tempat yang mudah salah. Perakit memperlakukan
// setiap SOF sebagai kandidat baru: SOF kedua yang datang saat sudah di state
// VER dianggap salah versi dan DILAPORKAN, bukan diabaikan diam-diam.
//
// Ekspektasi DUA BAD_VER untuk EMPAT SOF: SOF #1 memulai frame, SOF #2 mendarat
// di state VER lalu ditolak, SOF #3 memulai lagi, SOF #4 ditolak lagi. Jadi dua
// percobaan gagal. Perilaku ini disengaja - lebih jujur daripada diam-diam
// mengabaikan, dan biayanya nol pada traffic valid karena SOF beruntun tidak
// pernah muncul di dalam frame yang benar.
seq('sof_beruntun', [
  SOF, SOF, SOF, SOF,
  ...encode(T_EVT, [0x07]),
], [E('BAD_VER'), E('BAD_VER'), F(T_EVT)]);

// ---- Menulis file ----
const lines = [];
lines.push('# GOLDEN VECTORS - protokol frame v2');
lines.push('# DIHASILKAN OLEH tools/gen-vectors.mjs. Jangan diedit tangan.');
lines.push('# Jalankan ulang generator setiap kali firmware/common/frame.h berubah.');
lines.push('#');
lines.push(`# SOF=0x${SOF.toString(16)} VER=0x${VER.toString(16)} overhead=${OVERHEAD}B maxPayload=${MAX_PAYLOAD}B`);
lines.push('# CRC16/CCITT-FALSE atas TYPE+LEN+PAYLOAD, little-endian.');
lines.push('#');
lines.push('# SEQ <nama> <hex byte> <ekspektasi comma-separated>');
lines.push('#   F:0xTT = frame valid tipe TT | E:KODE = kesalahan | NONE = tanpa event');
lines.push(`# ${CASES.length} vektor.`);
lines.push('');
for (const c of CASES) {
  lines.push(`SEQ ${c.name} ${hex(c.bytes)} ${c.expect.join(',')}`);
}
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log(`tests/vectors/frames.vec ditulis: ${CASES.length} vektor`);
console.log(`check value crc16("123456789") = 0x${crc16(Array.from('123456789', (c) => c.charCodeAt(0))).toString(16).toUpperCase()} (harus 0x29B1)`);
