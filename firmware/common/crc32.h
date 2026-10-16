/* =================== CRC-32/ISO-HDLC (zlib) ===================
 *
 * Dipakai untuk CFG_SIG: sidik jari isi konfigurasi yang aktif, supaya app
 * bisa bertanya "device sudah punya preset ini?" alih-alih menebak dari
 * cache-nya sendiri.
 *
 * Kenapa algoritma ini, bukan CRC16 atau FNV:
 * - CRC32 ISO-HDLC persis sama dengan zlib.crc32(), jadi bisa dihitung ulang
 *   di mana saja tanpa tabel: satu baris di shell, satu fungsi di Python,
 *   satu pustaka di app. Saat perlu membandingkan sidik jari dari log lama
 *   dengan config baru, angka itu bisa dipercaya tanpa menjalankan firmware.
 * - Hal yang sama berlaku di JS, Rust, dan C, dan diuji silang dengan golden
 *   vectors seperti pada frame protocol.
 *
 * Parameter: poly 0xEDB88320 (reflektif), init 0xFFFFFFFF, xorout 0xFFFFFFFF.
 * Check value: crc32("123456789") == 0xCBF43926.
 *
 * Versi bit-per-bit, tanpa tabel 1 KB.
 *
 * Kenapa tanpa tabel: di sini kejelasan lebih berharga dari kecepatan.
 * Perhitungan ini hanya jalan saat app bertanya CFG_QUERY - sekali per
 * pergantian preset, bukan di loop dan bukan di jalur HID. Tabel 1 KB akan
 * memakan RAM yang dibutuhkan stack di ESP32-S3, untuk menghemat beberapa
 * lusinan siklus yang tidak pernah terasa.
 *
 * HEADER INI BEBAS ARDUINO, sama seperti frame.h, supaya bisa diuji di host
 * (tests/suites/frame-asm-native-test.js).
 */

#ifndef CRC32_H_
#define CRC32_H_

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define CRC32_INIT 0xFFFFFFFFu

static inline uint32_t crc32_update(uint32_t crc, uint8_t b) {
  crc ^= b;
  for (int i = 0; i < 8; i++) {
    if (crc & 1u) crc = (crc >> 1) ^ 0xEDB88320u;
    else           crc = crc >> 1;
  }
  return crc;
}

/* Seluruh buffer sekaligus. */
static inline uint32_t crc32_bytes(const uint8_t* data, size_t len) {
  uint32_t crc = CRC32_INIT;
  for (size_t i = 0; i < len; i++) crc = crc32_update(crc, data[i]);
  return crc ^ 0xFFFFFFFFu;
}

/* Untuk menghitung beberapa bagian berurutan tanpa menyalin buffer:
 *   crc = crc32_update(crc, byte) untuk tiap byte, lalu crc32_finish(crc).
 * Mengambil crc32_bytes untuk tiap bagian lalu menggabungkannya akan salah -
 * nilai akhir tiap bagian sudah di-XOR dan tidak bisa dilanjutkan. */
static inline uint32_t crc32_finish(uint32_t crc) { return crc ^ 0xFFFFFFFFu; }

/* String termasuk NUL penutupnya.
 *
 * Byte NUL sengaja ikut dihitung. Kalau tidak, "a" dan "a\0" menghasilkan
 * sidik jari sama, dan field yang kosong bisa bertabrakan dengan field yang
 * isinya byte 0 - bukan masalah untuk teks ASCII, tapi menghasilkan bug
 * yang sangat sulit dicari kalau nanti ada field biner. */
static inline uint32_t crc32_str(uint32_t crc, const char* s) {
  for (size_t i = 0; i < strlen(s); i++) crc = crc32_update(crc, (uint8_t)s[i]);
  return crc32_update(crc, 0);
}

/* Field lebar tetap: selalu panjang `len` byte, tanpaشق terminator.
 * Bentuk ini yang dipakai nama layer dan nilai action, karena keduanya punya
 * lebar tetap dalam struct dan tidak boleh dipengaruhi byte sisa di belakang NUL.
 * lebar tetap dalam struct dan tidak boleh dipengaruhi byte sisa di
 * belakang NUL. */
static inline uint32_t crc32_fixed(uint32_t crc, const char* s, size_t len) {
  for (size_t i = 0; i < len; i++) crc = crc32_update(crc, (uint8_t)s[i]);
  return crc;
}

#endif /* CRC32_H_ */
