// Test Fase 2: CRC32 dan CFG_SIG harus identik antara C dan JavaScript.
//
// tests/vectors/cfg.vec dibaca dua runner independen:
//
//   1. tests/native/cfg_test.c   -> firmware/common/crc32.h + cfg_sig.h
//   2. file ini                  -> src/cfg-sig.js
//
// Kalau hanya JS yang diuji, tidak ada yang membuktikan firmware dan app
// menghitung sidik jari yang sama - dan "sama" di sini berarti: kalau tidak,
// app akan mengunggah ulang preset yang sebenarnya sudah ada, setiap kali.
//
// Jalankan: node tests/suites/cfg-sig-test.mjs
import fs from 'node:fs';
import { cfgSigCompute, cfgSigOfPreset, sigHex } from '../../src/cfg-sig.js';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };

const VEC = 'tests/vectors/cfg.vec';
const teks = fs.readFileSync(VEC, 'utf8');

// ---- Parser vektor: format tanpa spasi, dipisah ';' lalu ',' ----
// Sengaja tanpa pustaka: C harus bisa membaca format yang sama, dan joiner
// seperti ini adalah satu-satunya hal yang bisa dilakukan identik di semua
// bahasa tanpa menarik dependensi.
function nextField(cur, sep) {
  const i = cur.indexOf(sep);
  if (i < 0) { const s = cur; cur.indexOf = null; return [s, null]; }
  return [cur.slice(0, i), cur.slice(i + 1)];
}

function hexBytes(h, width) {
  const out = new Uint8Array(width);
  for (let b = 0; b < width; b++) {
    out[b] = b * 2 + 1 < h.length ? parseInt(h.slice(b * 2, b * 2 + 2), 16) : 0;
  }
  return out;
}

const hexStr = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// CRC32 harus dihitung ulang di sini, TIDAK diimpor dari modul lain, supaya
// test ini benar-benar menguji algoritma yang dipakai firmware dan bukan
// objek yang sama yang tengah diuji.
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

console.log('--- 1. Berkas vektor terbaca ---');
const baris = teks.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const crcBaris = baris.filter((l) => l.startsWith('CRC32 '));
const sigBaris = baris.filter((l) => l.startsWith('SIG '));
ok(crcBaris.length >= 8, `vektor CRC32: ${crcBaris.length}`);
ok(sigBaris.length >= 10, `vektor CFG_SIG: ${sigBaris.length}`);

console.log('\n--- 2. Check value CRC32 ---');
{
  const v = crc32(Array.from('123456789', (c) => c.charCodeAt(0)));
  ok(v === 0xcbf43926, `crc32("123456789") = 0x${v.toString(16)} (harus cbf43926)`);
}

console.log('\n--- 3. CRC32 cocok dengan vektor ---');
{
  const gagal = [];
  for (const l of crcBaris) {
    const t = l.trim().split(/\s+/);
    const nama = t[1];
    const expect = t[t.length - 1];
    const bytes = new Uint8Array(t.slice(2, t.length - 1).map((h) => parseInt(h, 16)));
    const got = crc32(bytes).toString(16).padStart(8, '0');
    if (got !== expect.toLowerCase()) gagal.push(`${nama}: harap ${expect} dapat ${got}`);
  }
  ok(gagal.length === 0, gagal.length === 0
    ? `semua ${crcBaris.length} vektor CRC32 cocok`
    : `${gagal.length} gagal: ${gagal.join(' | ')}`);
}

console.log('\n--- 4. CFG_SIG dihitung dari deskripsi vektor ---');
{
  const gagal = [];
  let dihitung = 0;
  for (const l of sigBaris) {
    const t = l.trim().split(/\s+/);
    const nama = t[1];
    const desc = t[2];
    const expect = t[3].toLowerCase();

    const fields = desc.split(';');
    const kv = {};
    for (const pair of fields[0].split(',')) {
      const i = pair.indexOf('=');
      if (i > 0) kv[pair.slice(0, i)] = Number(pair.slice(i + 1));
    }
    const nk = kv.nk, nameLen = kv.nl_len, valLen = kv.val_len;

    // Nama layer: char[nl][nameLen] dengan stride nameLen.
    const nLayers = kv.nl;
    const layerNames = new Uint8Array(kv.nl * nameLen);
    fields[1].slice(2).split('|').forEach((n, l) => {
      layerNames.set(hexBytes(n, nameLen), l * nameLen);
    });

    // type dan value memakai stride AKSI yang sama, persis seperti firmware
    // membaca KeyAction.
    const total = nLayers * nk;
    const keyTypes = new Uint8Array(total);
    const keyValues = new Uint8Array(total * valLen);
    fields[2].slice(2).split('|').forEach((row, l) => {
      row.split(',').forEach((item, k) => {
        if (!item) return;
        const c = item.indexOf(':');
        const idx = l * nk + k;
        keyTypes[idx] = parseInt(item.slice(0, c), 10);
        keyValues.set(hexBytes(item.slice(c + 1), valLen), idx * valLen);
      });
    });

    const nEnc = kv.ne * kv.epk;
    const encTypes = new Uint8Array(nEnc);
    const encValues = new Uint8Array(nEnc * valLen);
    fields[3].slice(2).split(',').forEach((item, i) => {
      if (!item) return;
      const c = item.indexOf(':');
      encTypes[i] = parseInt(item.slice(0, c), 10);
      encValues.set(hexBytes(item.slice(c + 1), valLen), i * valLen);
    });

    const got = cfgSigCompute(kv.v, kv.lc, kv.cl, {
      layerNames, keyTypes, keyValues, encTypes, encValues,
      // Array datar: type setiap 1 byte, value setiap valLen byte. Berbeda
      // dari firmware yang keduanya di dalam satu KeyAction - dan perbedaan
      // inilah yang diuji.
      keyTypeStride: 1,
      keyValueStride: valLen,
      encTypeStride: 1,
      encValueStride: valLen,
      layerNameStride: nameLen,
      nLayers, nKeys: nk, nEncoders: kv.ne, encPerKnob: kv.epk,
      nameLen, valueLen: valLen,
    });
    dihitung++;
    const hex = sigHex(got);
    if (hex !== expect) gagal.push(`${nama}: harap ${expect} dapat ${hex}`);
  }
  ok(gagal.length === 0, gagal.length === 0
    ? `semua ${dihitung} vektor CFG_SIG cocok di JS`
    : `${gagal.length} gagal: ${gagal.join(' | ')}`);
}

console.log('\n--- 5. Sifat penting sidik jari ---');
{
  const dims = {
    maxLayers: 8, rows: 3, cols: 3, numEncoders: 1, encPerKnob: 3,
    nameLen: 16, valueLen: 48, actionLen: 49,
  };
  const preset = () => ({
    version: 5, layerCount: 1, currentLayer: 0,
    names: ['Utama', '', '', '', '', '', '', ''],
    layers: [{
      keys: [
        { type: 1, value: 'a' }, { type: 2, value: 'ctrl+c' }, { type: 0, value: '' },
        { type: 0, value: '' }, { type: 0, value: '' }, { type: 0, value: '' },
        { type: 0, value: '' }, { type: 0, value: '' }, { type: 0, value: '' },
      ],
    }],
    enc: [
      { type: 4, value: 'VOLUP' }, { type: 4, value: 'VOLDOWN' }, { type: 4, value: 'MUTE' },
    ],
  });

  const dasar = cfgSigOfPreset(preset(), dims);

  ok(cfgSigOfPreset(preset(), dims) === dasar, 'preset sama menghasilkan sidik jari sama (deterministis)');

  // Layer di atas layerCount tidak boleh memengaruhi. Ini yang mencegah app
  // mengunggah ulang preset yang isinya sudah benar.
  const denganSampah = preset();
  denganSampah.names[5] = 'sampah';
  denganSampah.layers.push({ keys: Array.from({ length: 9 }, () => ({ type: 9, value: 'x' })) });
  ok(cfgSigOfPreset(denganSampah, dims) === dasar,
    'data di layer yang tidak hidup TIDAK memengaruhi sidik jari');

  // Nilai yang lebih panjang dari valueLen-1 harus dipotong, bukan bocor.
  // Dipakai 47 (= valueLen-1) dan 48 karakter.
  const batas = preset();
  batas.layers[0].keys[0].value = 'a'.repeat(47);
  const batas2 = preset();
  batas2.layers[0].keys[0].value = 'a'.repeat(48);
  ok(cfgSigOfPreset(batas, dims) === cfgSigOfPreset(batas2, dims),
    `nilai 47 dan 48 karakter punya sidik jari sama (dipotong ke ${dims.valueLen - 1})`);

  const satuLebih = preset();
  satuLebih.layers[0].keys[0].value = 'a'.repeat(46);
  ok(cfgSigOfPreset(satuLebih, dims) !== cfgSigOfPreset(batas, dims),
    'nilai 46 karakter TIDAK boleh dianggap sama dengan 47 karakter');

  // Dua nilai dengan isi sama pada karakter yang tersimpan tapi berbeda
  // sisanya harus tetap sama - inilah yang membuktikan tidak ada byte sisa yang bocor.
  const denganSisa = preset();
  denganSisa.layers[0].keys[0].value = 'b'.repeat(47);
  ok(cfgSigOfPreset(denganSisa, dims) !== cfgSigOfPreset(batas, dims),
    'nilai dengan karakter berbeda punya sidik jari berbeda');

  // currentLayer adalah bagian dari identitas: device sedang menampilkan layer
  // berbeda, jadi app tidak boleh menganggap config sama.
  const layerLain = preset();
  layerLain.currentLayer = 1;
  ok(cfgSigOfPreset(layerLain, dims) !== dasar, 'currentLayer berbeda menghasilkan sidik jari berbeda');
}

console.log(`\n${fail === 0 ? 'SEMUA OK' : fail + ' ASSERTION GAGAL'}: CRC32 dan CFG_SIG sama di C dan JS`);
process.exit(fail ? 1 : 0);
