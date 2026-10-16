#!/usr/bin/env node
// =================== GENERATOR VECTOR CRC32 + CFG_SIG ===================
//
// Sumber kebenaran untuk pengujian sidik jari konfigurasi.
//
// File yang dihasilkan: tests/vectors/cfg.vec
//
// Format txt (sama dengan frames.vec supaya bisa dibaca C, Rust, dan JS
// tanpa parser):
//
//   CRC32 <nama> <hex byte> <crc32 hex8>
//   SIG   <nama> <deskripsi> <sig hex8>
//
// Untuk baris SIG, deskripsi-nya diserialisasi supaya bisa direkonstruksi
// persis oleh ketiga bahasa:
//
//   v=<version>;lc=<layerCount>;cl=<currentLayer>;
//   nl=<nLayers>;nk=<nKeysPerLayer>;ne=<nEncoders>;epk=<encPerKnob>;
//   nl_len=<nameLen>;val_len=<valueLen>;action_stride=<stride>;
//   names=<hex nama layer, dipisah |>
//   keys=<hex tiap "type:hex value", dipisah |>
//   enc=<hex tiap "type:hex value", dipisah |>
//
// Kenapa deskripsi, bukan hanya angka hasilnya: kalau test cuma membandingkan
// angka, implementasi yang sama-sama salah akan lolos. Dengan menyertakan
// konfigurasi yang menghasilkan angka itu, ketiga bahasa harus merekonstruksi
// struktur yang sama dan baru depois angkanya dibandingkan.
//
// Jalankan: node tools/gen-cfg-vectors.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'vectors', 'cfg.vec');

// ---- CRC-32/ISO-HDLC, parameter wajib sama dengan firmware/common/crc32.h ----
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = (crc ^ b) >>> 0;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) >>> 0 : (crc >>> 1) >>> 0;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bentuk kanonik, cermin persis cfgSigCompute() di cfg_sig.h. */
function cfgSigBytes(d) {
  const out = [d.v & 0xff, d.lc & 0xff, d.cl & 0xff];
  for (let l = 0; l < d.nl; l++) {
    const name = d.names[l] || '';
    const n = Buffer.alloc(d.nl_len);
    n.write(name.slice(0, d.nl_len), 'latin1');
    out.push(...n);
    for (let k = 0; k < d.nk; k++) {
      const key = d.keys[l][k] || { type: 0, value: '' };
      out.push(key.type & 0xff);
      const v = Buffer.alloc(d.val_len);
  v.write(String(key.value || '').slice(0, d.val_len - 1), 'latin1');
      out.push(...v);
    }
  }
  for (let i = 0; i < d.ne * d.epk; i++) {
    const e = d.enc[i] || { type: 0, value: '' };
    out.push(e.type & 0xff);
    const v = Buffer.alloc(d.val_len);
  v.write(String(e.value || '').slice(0, d.val_len - 1), 'latin1');
    out.push(...v);
  }
  return out;
}

const hex = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const hex8 = (n) => n.toString(16).padStart(8, '0');
const buf = (s, len) => {
  const b = Buffer.alloc(len);
  b.write(String(s).slice(0, len), 'latin1');
  return b;
};
const lines = [];
const push = (s) => lines.push(s);

// =================== CRC32 ===================
push('# CRC32/ISO-HDLC + CFG_SIG - DIHASILKAN tools/gen-cfg-vectors.mjs');
push('# Jangan diedit tangan; jalankan ulang generator.');
push('#');
push('# CRC32 <nama> <hex byte> <crc32 hex8>');
push('# SIG   <nama> <deskripsi> <sig hex8>');
push('');
push('# CRC32');

const crcCases = [];
const crcPush = (name, bytes) => crcCases.push([name, bytes]);
crcPush('kosong', []);
crcPush('satu_byte', [0x00]);
crcPush('cek_value_standar', Array.from('123456789', (c) => c.charCodeAt(0)));
crcPush('semua_nol_8', [0, 0, 0, 0, 0, 0, 0, 0]);
crcPush('semua_ff_8', [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
crcPush('nully_dalam', Array.from({ length: 32 }, (_, i) => (i % 4 === 0 ? 0 : i & 0xff)));
crcPush('semua_byte_0_255', Array.from({ length: 256 }, (_, i) => i));
crcPush('balik_urutan', Array.from({ length: 256 }, (_, i) => 255 - i));

for (const [name, bytes] of crcCases) {
  push(`CRC32 ${name} ${hex(bytes)} ${hex8(crc32(bytes))}`);
}
push('');

// =================== CFG_SIG ===================
// Dimensi kecil supaya vektor tetap enak dibaca. Yang diuji adalah urutan
// dan lebarnya, bukan ukurannya.
const D = {
  nl_len: 8,
  val_len: 12,
  nk: 3,
  epk: 3,
  ne: 1,
};

function base(over = {}) {
  return {
    v: 5, lc: 2, cl: 0,
    nl: 2, nk: D.nk, ne: D.ne, epk: D.epk,
    nl_len: D.nl_len, val_len: D.val_len,
    names: ['Main', 'Alt'],
    keys: [
      [{ type: 1, value: 'a' }, { type: 2, value: 'ctrl+c' }, { type: 0, value: '' }],
      [{ type: 3, value: 'macro1' }, { type: 4, value: 'MUTE' }, { type: 0, value: '' }],
    ],
    enc: [
      { type: 4, value: 'VOLUP' },
      { type: 4, value: 'VOLDOWN' },
      { type: 4, value: 'MUTE' },
    ],
    ...over,
  };
}

const sigCases = [];
const sigPush = (name, d) => sigCases.push([name, d]);

sigPush('preset_penuh', base());

sigPush('layer_kosong', base({ nl: 1, lc: 1, names: ['Main'] }));

sigPush('satu_layer_saja', base({
  nl: 1, lc: 1, names: ['Solo'], nk: D.nk,
  keys: [[{ type: 1, value: 'x' }, { type: 0, value: '' }, { type: 0, value: '' }]],
}));

sigPush('nilai_melebihi_panjang', base({
  // Value lebih panjang dari val_len harus dipotong, bukan membuat hash
  // berbeda karena bocor di luar field. Ini yang sering jadi sumber bug.
  keys: [[{ type: 1, value: 'abcdefghijklmnop' }, { type: 0, value: '' }, { type: 0, value: '' }], []],
}));

sigPush('nilai_pascal_tepat_panjang', base({
  keys: [[{ type: 1, value: 'abcdefghijkl' }, { type: 0, value: '' }, { type: 0, value: '' }], []],
}));

sigPush('layer_di_atas_layercount', base({
  // Data di layer yang tidak hidup HARUS tidak memengaruhi hash.
  lc: 1, nl: 1,
  names: ['Main', 'Sampah'],
  keys: [
    [{ type: 1, value: 'a' }, { type: 2, value: 'ctrl+c' }, { type: 0, value: '' }],
    [{ type: 9, value: 'sampah' }, { type: 9, value: 'sampah' }, { type: 9, value: 'x' }],
  ],
}));

sigPush('current_layer_berbeda', base({ cl: 1 }));
sigPush('version_berbeda', base({ v: 4 }));
sigPush('layer_count_berbeda', base({ lc: 1, nl: 1 }));
sigPush('tipe_saja_berbeda', base({
  keys: [[{ type: 9, value: 'a' }, { type: 2, value: 'ctrl+c' }, { type: 0, value: '' }], []],
}));
sigPush('semua_kosong', base({
  nl: 1, lc: 1, names: [''],
  keys: [[{ type: 0, value: '' }, { type: 0, value: '' }, { type: 0, value: '' }]],
  enc: [{ type: 0, value: '' }, { type: 0, value: '' }, { type: 0, value: '' }],
}));
sigPush('nama_layer_dengan_nul', base({
  nl: 1, lc: 1, names: ['ab\0cd'],   // bytes sisanya harus ikut terhitung
}));
sigPush('dua_encoder', base({
  ne: 2,
  enc: [
    { type: 4, value: 'VOLUP' }, { type: 4, value: 'VOLDOWN' }, { type: 4, value: 'MUTE' },
    { type: 1, value: 'p' }, { type: 1, value: 'q' }, { type: 1, value: 'r' },
  ],
}));

// Deskripsi TANPA SPASI sama sekali.
//
// Ini bukan soal aesthetics: nama layer dan nilai action ditulis sebagai byte
// heksadesimal BERSPASI, jadi kalau deskripsi dipisah spasi, isinya sendiri
// jadi tidak bisa dibedakan dari pemisah. Percobaan pertama persis begitu, dan
// hasilnya 12 dari 13 vektor gagal dengan angka yang sama persis - tanda bahwa
// parser-nya, bukan algositmanya, yang salah.
//
// Format: key=value dipisah ',', field dipisah ';', nama layer dipisah '|',
// item key dipisah ',' dan ':'. Semua karakter itu tidak pernah muncul di
// heksadesimal, jadi parsingnya tidak pernah ambigu.
/**
 * Lengkapi config supaya EVERY slot terisi.
 *
 * Tanpa ini, `keys: [[a], []]` menghasilkan deskripsi dengan baris kedua
 * kosong, dan implementasi yang membaca deskripsi itu tidak punya cara tahu
 * harusnya isi baris kedua apa - ia akan memakai sisa dari vektor SEBELUMNYA
 * atau byte nol, tergantung kebetulan. Dua implementasi bisa jujur berbeda
 * interceptor dan tetap terlihat "menyesatkan".
 *
 * Setelah fungsi ini, deskripsi selalu berisi nl baris × nk item, lengkap.
 */
function norm(d) {
  const out = { ...d };
  out.names = [];
  for (let l = 0; l < d.nl; l++) out.names.push(d.names[l] ?? '');
  out.keys = [];
  for (let l = 0; l < d.nl; l++) {
    const row = [];
    for (let k = 0; k < d.nk; k++) {
      row.push((d.keys[l] && d.keys[l][k]) ? d.keys[l][k] : { type: 0, value: '' });
    }
    out.keys.push(row);
  }
  out.enc = [];
  for (let i = 0; i < d.ne * d.epk; i++) {
    out.enc.push(d.enc[i] ? d.enc[i] : { type: 0, value: '' });
  }
  return out;
}

const desc = (d) => {
  const hexNoSp = (b, len) => hex([...buf(b, len)]).replace(/ /g, '');
  // Panjang efektif nilai adalah val_len-1 karakter: firmware mengisi dengan
  // strncpy(v, s, LEN-1) lalu v[LEN-1] = 0, jadi byte terakhir selalu nol.
  const key = (k) => `${k.type & 0xff}:${hexNoSp(String(k.value || '').slice(0, d.val_len - 1), d.val_len)}`;
  const fields = [
    `v=${d.v}`, `lc=${d.lc}`, `cl=${d.cl}`,
    `nl=${d.nl}`, `nk=${d.nk}`, `ne=${d.ne}`, `epk=${d.epk}`,
    `nl_len=${d.nl_len}`, `val_len=${d.val_len}`,
  ].join(',');
  const names = d.names.map((n) => hexNoSp(n, d.nl_len)).join('|');
  const keys = d.keys.map((row) => row.map(key).join(',')).join('|');
  const enc = d.enc.map(key).join(',');
  return `${fields};N=${names};K=${keys};E=${enc}`;
};

push('# CFG_SIG');
push('# action_stride tidak ditulis: ketiga bahasa memakai array datar, jadi');
push('# stride selalu 1 pada sisi test. Yang diuji di sini adalah urutan dan');
push('# lebarnya - bukan struct KeyAction milik firmware.');
push('# Deskripsi TANPA SPASI (lihat catatan di atas tools/gen-cfg-vectors.mjs).');
push('');
for (const [name, raw] of sigCases) {
  const d = norm(raw);   // lengkapi dulu, supaya deskripsi selalu utuh
  push(`SIG ${name} ${desc(d)} ${hex8(crc32(cfgSigBytes(d)))}`);
}
push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

console.log(`tests/vectors/cfg.vec ditulis: ${crcCases.length} vektor CRC32, ${sigCases.length} vektor CFG_SIG`);
console.log(`crc32("123456789") = 0x${hex8(crc32(Array.from('123456789', (c) => c.charCodeAt(0))))} (harus cbf43926)`);
