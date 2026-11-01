#pragma once

// =================== MESIN EFEK RGB (MURNI) ===================
//
// Berisi SATU hal:diberi phase waktu, menghasilkan warna per LED.
//
// Sifat penting berkas ini:
//
//  1. **Murni.** Tidak ada #include <Arduino.h>, tidak ada Adafruit_NeoPixel,
//     tidak ada digitalWrite, tidak ada millis(). Semua input masuk lewat
//     parameter dan semua output keluar lewat array. Ini yang membuat isinya
//     bisa diuji di host (Node) tanpa hardware - lihat rgb-effects-test.js,
//     yang menjalankan ulang algoritma ini persis seperti tertulis di sini.
//
//  2. **Tidak punya state.** Tidak ada variabel global yang berubah antar
//     panggilan. Frame ke-N hanya bergantung pada phase ke-N. Kalau butuh
//     state (mis. warna acak tiap siklus), pemanggil yang mengacak lebih dulu lalu
//    randomize() dulu lalu hasilnya dikirim sebagai phase-dependent seed.
//     Alasannya: state tersembunyi di dalam renderer hampir mustahil diuji dan
//     hampir mustahil direproduksi di device.
//
//  3. **Tidak menyentuh hardware.** Pushing ke strip tetap urusan profil.
//
// Mode mengikuti tabel di src/rgb-page.js (RGB_MODES). Angka di sini WAJIB
// sama dengan `mode` di struct RgbState dan dengan apa yang dikirim app lewat
// RGB:MODE.

#include <stdint.h>
#include "limits.h"

// Wheel HSV: h = 0..359, s/v = 0..255. Mengembalikan RGB32 (0x00RRGGBB).
//
// s dan v sengaja float supaya interpolasi (mis. breathing) mudah
// ditulis dan hasilnya membulat dengan benar. ESP32-S3 punya FPU, jadi ini
// tidak mahal. Di host (Node) float identik dengan C, jadi hasil uji di Node
// berlaku untuk device.
static inline uint32_t rgbHsv(float h, float s, float v) {
  if (h < 0) h = 0;
  if (h >= 360.0f) h = 0;          // 360 identik dengan 0, bukan hue ke-6
  if (s < 0) s = 0; if (s > 255.0f) s = 255.0f;
  if (v < 0) v = 0; if (v > 255.0f) v = 255.0f;

  float c = v * s / 255.0f;        // chroma
  float hp = h / 60.0f;            // 0..6
  // x = komponen kedua roda HSV: 0 di setiap batas 60 derajat, maksimum di
  // tengah sektor, berubah arah tiap 120 derajat.
  //
  // Rumus ini sudah diverifikasi titik per titik (verify-hsv-ref.mjs).
  // Dua bentuk yang salah sempat dipakai lebih dulu:
  //   x = c * (1 - frac(hp))       -> h=0 jadi kuning (x tidak nol di batas)
  //   x = c * (1 - |frac(hp) - 1|) -> h=60 jadi hijau (salah di batas sektor)
  float hpr = fmodf(hp, 2.0f);    // 0..2, berubah arah tiap 120 derajat
  float adiff = (hpr < 1.0f) ? (1.0f - hpr) : (hpr - 1.0f);   // |hpr - 1|, 0..1
  float x = c * (1.0f - adiff);
  float m = v - c;                 // match lightness

  // Sektor 0..5, masing-masing 60 derajat.
  float r = 0, g = 0, b = 0;
  int sector = (int)hp;
  if (sector >= 6) sector = 0;     // jaga-jaga: h mendekati 360 -> kembali merah
  switch (sector) {
    case 0: r = c; g = x; b = 0; break;   // merah -> kuning
    case 1: r = x; g = c; b = 0; break;   // kuning -> hijau
    case 2: r = 0; g = c; b = x; break;   // hijau -> sian
    case 3: r = 0; g = x; b = c; break;   // sian -> biru
    case 4: r = x; g = 0; b = c; break;   // biru -> magenta
    default: r = c; g = 0; b = x; break;  // magenta -> merah
  }
  uint8_t R = (uint8_t)((r + m) + 0.5f);
  uint8_t G = (uint8_t)((g + m) + 0.5f);
  uint8_t B = (uint8_t)((b + m) + 0.5f);
  return RGB32(R, G, B);
}

//_PRNG_)32 yang deterministik dari seed - dipakai untuk mode acak.
static inline uint32_t rgbRand(uint32_t seed) {
  // xorshift32: sederhana, cepat, dan SELALU menghasilkan urutan yang sama
  // untuk seed yang sama. Ini penting supaya hasil di Node sama persis dengan
  // device - kalau pakai random() Arduino, hasilnya berbeda antar platform.
  uint32_t x = seed ? seed : 0x9E3779B9u;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  return x;
}

// Hitung frame: isi `out` (RGB32 per LED, minimal RGB_COUNT elemen).
//
//   phase  - posisi waktu, 0..PHASE_MAX. Pemanggil yang bertambah dan
//            incremented; fungsi ini tidak menyimpan apa pun.
//   seed   - untuk mode acak. Pemanggil yang mengacak tiap siklus.
//
//svyaziMode 0 (Static) dan 1 (Custom per Key) tidak bergerak: isinya cuma
// warna apa adanya, jadi phase diabaikan. Mode 8 (React) juga tidak bergerak -
// menyala sesaat lalu gelap, itu urusan pemanggil (rgbKeyFlash).
//
// Kecerahan TIDAK dikalikan di sini. Brightness ditangani strip.setBrightness()
// di sisi hardware, supaya mixer angka di sini tetap sederhana dan tidak ada
// yang terpotong dua kali.
static inline void rgbFrame(uint8_t mode, uint8_t speed, const uint8_t color[3],
                            const uint8_t keys[ROWS][COLS][3],
                            uint16_t phase, uint32_t seed, uint32_t *out) {
  // Kecepatan 0..255 -> pergeseran phase per "siklus penuh".
  // speed 128 -> ~1 siklus per beberapa frame, speed 255 -> paling cepat.
  // Rumus ini SAMA dengan yang dipakai preview di app supaya device dan
  // preview terasa speed-nya mirip.
  float step = 0.35f + (speed / 255.0f) * 5.65f;   // 0.35 .. 6.0 per siklus
  float ph = (float)phase * step;

  switch (mode) {
    // ---- 0: Static Light ----
    case 0:
      for (uint8_t i = 0; i < RGB_COUNT; i++)
        out[i] = RGB32(color[0], color[1], color[2]);
      return;

    // ---- 1: Custom per Key ----
    case 1:
      for (uint8_t r = 0; r < ROWS; r++)
        for (uint8_t c = 0; c < COLS; c++) {
          int8_t i = RGB_INDEX[r][c];
          if (i < 0 || i >= RGB_COUNT) continue;
          out[i] = RGB32(keys[r][c][0], keys[r][c][1], keys[r][c][2]);
        }
      return;

    // ---- 2: Breathing ----
    //Nada magnitude 0..255, kontras 0.05..0.95 -> denyut tak pernah
    // benar-benar gelap atau benar-benar putih (lebih enak dilihat mata).
    case 2: {
      // Segitiga wave: naik-turun berulang. Periodanya 256 frame supaya
      // phase bisa uint16_t tanpa wrap yang membingungkan.
      float t = (ph / 256.0f);
      t = t - (float)(int)t;                       // 0..1
      float tri = t < 0.5f ? (t * 2.0f) : (2.0f - t * 2.0f);
      float val = 0.05f + tri * 0.90f;
      float s = 255.0f;                             // full saturation
      float h = fmodf((float)seed, 360.0f);         // warna acak per siklus
      for (uint8_t i = 0; i < RGB_COUNT; i++) out[i] = rgbHsv(h, s, val * 255.0f);
      return;
    }

    // ---- 3: Color Cycle ----
    // Satu warna untuk semua LED, tapi hue-nya berputar.
    case 3: {
      float h = fmodf(ph * 6.0f, 360.0f);
      uint32_t c = rgbHsv(h, 255.0f, 255.0f);
      for (uint8_t i = 0; i < RGB_COUNT; i++) out[i] = c;
      return;
    }

    // ---- 4: Rainbow ----
    // Mirip Color Cycle, tapi tiap LED punya offset hue -inilah rainbow.
    case 4: {
      for (uint8_t i = 0; i < RGB_COUNT; i++) {
        float h = fmodf(ph * 6.0f + (360.0f / (float)RGB_COUNT) * (float)i, 360.0f);
        out[i] = rgbHsv(h, 255.0f, 255.0f);
      }
      return;
    }

    // ---- 5: Color Waves ----
    // Gelombang cahaya berjalan melintasi rantai LED, mengikuti urutan
    // RGB_INDEX (bukan urutan baris-kolom) supaya movement-nya sesuai kabel.
    case 5: {
      for (uint8_t r = 0; r < ROWS; r++)
        for (uint8_t c = 0; c < COLS; c++) {
          int8_t i = RGB_INDEX[r][c];
          if (i < 0 || i >= RGB_COUNT) continue;
          float h = (float)color[0] + ph * 6.0f + (360.0f / (float)RGB_COUNT) * (float)i;
          h = fmodf(h, 360.0f);
          out[i] = rgbHsv(h, (float)color[1], (float)color[2]);
        }
      return;
    }

    // ---- 6: Snake ----
    // Satu "kepala" bergerak; LED yang dilaluinya menyala redup.
    // Panjang ekor = 3, tidak bergantung speed supaya bentuknya tetap terbaca.
    case 6: {
      for (uint8_t i = 0; i < RGB_COUNT; i++) out[i] = RGB32(0, 0, 0);
      int head = (int)fmodf(ph, (float)RGB_COUNT);
      for (uint8_t k = 0; k < 3; k++) {
        int idx = (head - (int)k + RGB_COUNT) % RGB_COUNT;
        // Ekor memudar: k=0 terang, k=1 setengah, k=2 hampir gelap.
        float v = 1.0f - (float)k * 0.4f;
        out[idx] = rgbHsv((float)color[0], (float)color[1], v * 255.0f);
      }
      return;
    }

    // ---- 7: Randomize ----
    // Tiap framecenderung acak, tapi dibatasi ke keluarga warna agar tidak menyilaukan.
    case 7: {
      for (uint8_t i = 0; i < RGB_COUNT; i++) {
        uint32_t r1 = rgbRand(seed + i * 2654435761u);
        uint32_t r2 = rgbRand(r1);
        float h = (float)(r1 % 360u);
        float s = 140.0f + (float)(r2 % 116u);      // 140..255, tidak pastel
        out[i] = rgbHsv(h, s, 255.0f);
      }
      return;
    }

    // ---- 8: React Light ----
    // Bukan animasi: menyala saat ada tombol ditekan. Warna dasar saja yang
    // dikembalikan di sini; nyala/mati ditangani rgbKeyFlash di sisi profil.
    case 8:
    default:
      for (uint8_t i = 0; i < RGB_COUNT; i++)
        out[i] = RGB32(color[0], color[1], color[2]);
      return;
  }
}
