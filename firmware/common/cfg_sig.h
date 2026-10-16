/* =================== CFG_SIG - SIDIK JARI KONFIGURASI ===================
 *
 * Sidik jari isi konfigurasi yang HIDUP, supaya companion app bisa bertanya
 * "device sudah punya preset ini?" alih-alih menebak dari cache-nya sendiri.
 *
 * Aturan main: hash KANONIK, bukan sizeof(struct) mentah. Tiga alasan, dan
 * ketiganya adalah kelas bug yang mahal dicari nanti:
 *
 *  1. STRUKTURE PUNYA PADDING. Dua config yang isinya identik bisa punya byte
 *     berbeda di padding. Hash mentah menghasilkan dua sidik jari untuk satu
 *     config yang sama - dan efeknya app mengunggah ulang preset setiap kali.
 *
 *  2. NILAI ACTION DIISI strncpy. strncpy tidak menyisakan nol di seluruh sisa
 *     field, jadi byte setelah NUL bisa berisi sisa nilai yang lebih panjang
 *     dari nilai sekarang. Menghitung strlen()+1 membuat sidik jari bergantung
 *     pada byte sisa itu. Karena itu nilai action SELURUH lebarnya dihitung.
 *
 *  3. LAYER DI ATAS layerCount TIDAK PERNAH DIBACA device. Kalau ikut
 *     dihitung, config yang sama akan punya sidik jari berbeda tergantung
 *     sampah yang kebetulan tertinggal di layer yang sudah dihapus.
 *
 * BENTUK KANONIK (urutan persis, semua byte literal):
 *
 *   u8  version
 *   u8  layerCount
 *   u8  currentLayer
 *   untuk l = 0 .. nLayers-1:
 *       nameLen byte nama layer
 *       untuk k = 0 .. nKeys-1:  u8 type, lalu valueLen byte nilai
 *   untuk i = 0 .. nEncoders*encPerKnob-1:
 *       u8 type, lalu valueLen byte nilai
 *
 * Tidak ada panjang variabel di mana pun - itulah yang membuat dua sidik jari
 * bisa dibandingkan tanpa deskripsi tambahan.
 *
 * =================== KENAPA STRIDE DIPISAH SATU PER ARRAY ===================
 *
 * Ini kontrak yang perlu dibaca pelamar dengan teliti.
 *
 * type dan value berada di DALAM satu struct KeyAction pada firmware, jadi
 * keduanya memakai stride yang sama (sizeof(KeyAction)). Tapi pada pemanggil
 * lain - runner test memakai array datar - type berjejer setiap 1 byte dan
 * value berjejer setiap valueLen byte. Dua layout yang sah, dua stride
 * berbeda.
 *
 * Versi pertama memakai SATU stride untuk keduanya karena di firmware kebetulan
 * sama, dan itu terlihat hemat. Akibatnya test dan firmware menghitung hal yang
 * berbeda tanpa satu pun error - persis kelas bug yang tidak akan ketahuan
 * sampai ada preset yang gagal switch di tangan user. Sekarang tiap array punya
 * stride sendiri, jadi perbedaan layout jadi eksplisit di pemanggilnya.
 *
 * HEADER INI BEBAS ARDUINO dan bebas struct apa pun: hanya butuh <stddef.h> dan
 * crc32.h. Dipakai frame_proto.h di firmware dan tests/native/cfg_test.c di host.
 */

#ifndef CFG_SIG_H_
#define CFG_SIG_H_

#include <stddef.h>
#include <stdint.h>
#include "crc32.h"

typedef struct {
  const char*    layerNames;
  const uint8_t* keyTypes;    /* nLayers*nKeys entri, langkah keyTypeStride */
  const char*    keyValues;   /* nLayers*nKeys*valueLen byte, langkah keyValueStride */
  const uint8_t* encTypes;    /* nEncoders*encPerKnob entri, langkah encTypeStride */
  const char*    encValues;   /* nEncoders*encPerKnob*valueLen byte, langkah encValueStride */

  size_t layerNameStride;
  size_t keyTypeStride;
  size_t keyValueStride;
  size_t encTypeStride;
  size_t encValueStride;

  uint8_t nLayers;     /* sudah dipotong ke MAX_LAYERS oleh pemanggil */
  uint8_t nKeys;       /* jumlah kunci per layer, mis. ROWS*COLS */
  uint8_t nEncoders;
  uint8_t encPerKnob;  /* binding per knob, yaitu 3 */
  uint8_t nameLen;     /* lebar yang DIHITUNG, mis. NAME_LEN */
  uint8_t valueLen;    /* lebar yang DIHITUNG, mis. MACRO_MAX_LEN */
} cfg_sig_src_t;

static inline uint32_t cfgSigCompute(uint8_t version, uint8_t layerCount, uint8_t currentLayer,
                                     const cfg_sig_src_t* s) {
  uint32_t h = CRC32_INIT;
  h = crc32_update(h, version);
  h = crc32_update(h, layerCount);
  h = crc32_update(h, currentLayer);

  for (uint8_t l = 0; l < s->nLayers; l++) {
    h = crc32_fixed(h, s->layerNames + (size_t)l * s->layerNameStride, s->nameLen);

    const size_t base = (size_t)l * s->nKeys;
    for (uint8_t k = 0; k < s->nKeys; k++) {
      const size_t idx = base + k;
      h = crc32_update(h, s->keyTypes[idx * s->keyTypeStride]);
      h = crc32_fixed(h, s->keyValues + idx * s->keyValueStride, s->valueLen);
    }
  }

  const uint8_t nEnc = (uint8_t)(s->nEncoders * s->encPerKnob);
  for (uint8_t i = 0; i < nEnc; i++) {
    h = crc32_update(h, s->encTypes[i * s->encTypeStride]);
    h = crc32_fixed(h, s->encValues + i * s->encValueStride, s->valueLen);
  }

  return crc32_finish(h);
}

#endif /* CFG_SIG_H_ */
