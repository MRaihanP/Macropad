// ==================== CFG_SIG (JS) ===================
//
// Cermin persis firmware/common/cfg_sig.h - termasuk struktur loop dan cara
// menghitung stride. Ini bukan implementasi ulang yang "setara": kalau ada
// satu baris yang berbeda urutan atau salah lebar, sidik jarinya berbeda, dan
// test silang dengan implementasi C akan langsung menangkapnya.
//
// BENTUK KANONIK (urutan persis, semua byte literal):
//
//   u8 version
//   u8 layerCount
//   u8 currentLayer
//   untuk l = 0 .. nLayers-1:
//       nameLen byte nama layer   (lebar tetap, byte sisanya ikut dihitung)
//       untuk k = 0 .. nKeys-1:   u8 type, lalu valueLen byte nilai
//   untuk i = 0 .. nEncoders*encPerKnob-1:
//       u8 type, lalu valueLen byte nilai
//
// Tidak ada panjang variabel di mana pun. Itulah yang membuat dua sidik jari
// bisa dibandingkan tanpa deskripsi tambahan.
//
// TIGA HAL YANG SERING SALAH, DAN DIKUNCI OLEH TES:
//
//  1. Nilai action SELURUH lebarnya ikut dihitung. Nilai diisi strncpy di
//     firmware, dan byte setelah NUL bisa berisi sisa nilai yang lebih panjang
//     dari nilai sekarang. Menghitung strlen+1 membuat sidik jari bergantung
//     pada byte sisa itu - jadi dua config yang terlihat sama punya sidik jari
//     berbeda.
//  2. Layer di atas layerCount TIDAK ikut dihitung. Device tidak pernah
//     membacanya, jadi sampah di sana tidak boleh memengaruhi sidik jari.
//  3. Stride dan lebar field adalah dua hal BERBEDA. Di struct firmware
//     keduanya kebetulan sama; di layout lain tidak. Menggabungkannya
//     menghasilkan hash yang salah tanpa error sama sekali.

// Nilai byte per Update CRC32/ISO-HDLC - wajib identik dengan crc32.h.
const CRC32_INIT = 0xffffffff;

/**
 * @param {object} s sumber daya, dengan ptr+stride seperti cfg_sig_src_t
 *   layerNames, keyTypes, keyValues, encTypes, encValues: Uint8Array
 *   actionStride, layerNameStride: bilangan (index ke dalam array datar)
 *   nLayers, nKeys, nEncoders, encPerKnob, nameLen, valueLen
 * @returns {number} sidik jari unsigned 32-bit
 */
export function cfgSigCompute(version, layerCount, currentLayer, s) {
  let crc = CRC32_INIT;
  const step = (crc0, b) => {
    let c = (crc0 ^ b) >>> 0;
    for (let i = 0; i < 8; i++) {
      c = (c & 1) ? ((c >>> 1) ^ 0xedb88320) >>> 0 : (c >>> 1) >>> 0;
    }
    return c;
  };
  const fixed = (crc0, arr, off, len) => {
    let c = crc0;
    for (let i = 0; i < len; i++) c = step(c, arr[off + i]);
    return c;
  };

  crc = step(crc, version & 0xff);
  crc = step(crc, layerCount & 0xff);
  crc = step(crc, currentLayer & 0xff);

  for (let l = 0; l < s.nLayers; l++) {
    crc = fixed(crc, s.layerNames, l * s.layerNameStride, s.nameLen);
    const base = l * s.nKeys;
    for (let k = 0; k < s.nKeys; k++) {
      const idx = base + k;
      crc = step(crc, s.keyTypes[idx * s.keyTypeStride]);
      crc = fixed(crc, s.keyValues, idx * s.keyValueStride, s.valueLen);
    }
  }

  const nEnc = s.nEncoders * s.encPerKnob;
  for (let i = 0; i < nEnc; i++) {
    crc = step(crc, s.encTypes[i * s.encTypeStride]);
    crc = fixed(crc, s.encValues, i * s.encValueStride, s.valueLen);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Bentuk SIDIK JARI dari objek preset yang dipakai app.
 *
 * Ini yang akan dipakai adaptive.js nanti (Fase 3). Untuk sekarang hanya
 * perluverterifikasi bahwa ia menghasilkan angka yang sama dengan firmware.
 *
 * Bentuk inputnya datar dan TIDAK punya stride, jadi helper di sini menyusun
 * array datar yang benar. Perhatikan `value` SELALU dipotong ke valueLen - ini
 * yang membuat "abcdefghijkl" (tepat 12) dan "abcdefghijklmnop" (16) punya
 * sidik jari sama, persis seperti di firmware.
 *
 * @param {object} p preset datar
 * @param {number} p.maxLayers batas MAX_LAYERS
 * @param {number} p.rows, p.cols ukuran matriks
 * @param {number} p.numEncoders jumlah knob
 * @param {number} p.encPerKnob binding per knob
 * @param {number} p.nameLen lebar nama layer
 * @param {number} p.valueLen lebar nilai action
 * @param {number} p.actionLen lebar struct action di app (untuk stride)
 * @returns {number} sidik jari unsigned 32-bit
 */
export function cfgSigOfPreset(p, dims) {
  const { maxLayers, rows, cols, numEncoders, encPerKnob, nameLen, valueLen, actionLen } = dims;
  const nKeys = rows * cols;
  const nLayers = Math.min(p.layerCount ?? 0, maxLayers);
  const nEnc = numEncoders * encPerKnob;

  // Nama layer: lebar tetap, di-pad dengan nol.
  const layerNames = new Uint8Array(maxLayers * nameLen);
  for (let l = 0; l < maxLayers; l++) {
    const nama = (p.names && p.names[l]) || '';
    for (let b = 0; b < nameLen; b++) {
      layerNames[l * nameLen + b] = b < nama.length ? (nama.charCodeAt(b) & 0xff) : 0;
    }
  }

  // type dan value diletakkan pada struct action berukuran actionLen, lalu
  // dibaca ulang dengan stride - persis seperti firmware membaca KeyAction.
  const keyTypes = new Uint8Array(maxLayers * nKeys * actionLen);
  const keyValues = new Uint8Array(maxLayers * nKeys * actionLen);
  for (let l = 0; l < maxLayers; l++) {
    for (let k = 0; k < nKeys; k++) {
      const off = (l * nKeys + k) * actionLen;
      const a = (p.layers && p.layers[l] && p.layers[l].keys && p.layers[l].keys[k]) || null;
      keyTypes[off] = a ? (a.type & 0xff) : 0;
      // Panjang efektif adalah valueLen-1 karakter: firmware memakai
      // strncpy(v, s, valueLen-1) lalu v[valueLen-1] = 0. Jadi byte terakhir
      // SELALU nol dan karakter ke-(valueLen-1) tidak pernah ikut tersimpan.
      const v = a ? String(a.value || '').slice(0, valueLen - 1) : '';
      for (let b = 0; b < valueLen; b++) {
        keyValues[off + b] = b < v.length ? (v.charCodeAt(b) & 0xff) : 0;
      }
    }
  }

  const encTypes = new Uint8Array(nEnc * actionLen);
  const encValues = new Uint8Array(nEnc * actionLen);
  for (let i = 0; i < nEnc; i++) {
    const off = i * actionLen;
    const a = (p.enc && p.enc[i]) || null;
    encTypes[off] = a ? (a.type & 0xff) : 0;
    const v = a ? String(a.value || '').slice(0, valueLen - 1) : '';
    for (let b = 0; b < valueLen; b++) {
      encValues[off + b] = b < v.length ? (v.charCodeAt(b) & 0xff) : 0;
    }
  }

  return cfgSigCompute(
    p.version & 0xff,
    p.layerCount & 0xff,
    (p.currentLayer || 0) & 0xff,
    {
      layerNames, keyTypes, keyValues, encTypes, encValues,
      // Di sini type dan value memang berada di dalam satu blok actionLen
      // seperti KeyAction, jadi keempat stride sama - persis seperti firmware.
      keyTypeStride: actionLen,
      keyValueStride: actionLen,
      encTypeStride: actionLen,
      encValueStride: actionLen,
      layerNameStride: nameLen,
      nLayers, nKeys, nEncoders: numEncoders, encPerKnob,
      nameLen, valueLen,
    },
  );
}

/** Format 8 digit heksadesimal huruf kecil - sama dengan yang dipakai firmware. */
export const sigHex = (sig) => (sig >>> 0).toString(16).padStart(8, '0');
