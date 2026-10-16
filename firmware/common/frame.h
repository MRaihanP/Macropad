/* =================== PROTOKOL FRAME v2 ===================
 *
 * FORMAT (semua multi-byte LITTLE-ENDIAN):
 *
 *   +0   SOF     u8    0xA5          penanda awal frame
 *   +1   VER     u8    0x02          versi protokol
 *   +2   TYPE    u8                 jenis frame
 *   +3   LEN     u16                panjang payload, dalam byte
 *   +5   PAYLOAD LEN byte
 *   +5+N CRC16   u16                CRC16/CCITT-FALSE
 *
 * Total = 7 + LEN byte.
 *
 * CRC16/CCITT-FALSE: poly 0x1021, init 0xFFFF, tanpa refleksi, xorout 0x0000.
 * Nilainya dihitung ATAS byte TYPE, LEN, dan PAYLOAD - bukan SOF/VER, karena
 * keduanya sudah divalidasi secara terpisah dan punya pesan kesalahan sendiri.
 * Check value: crc16("123456789") == 0x29B1.
 *
 * KENAPA 0xA5 SEBAGAI SOF, BUKAN 0x0A ATAU 0x7E
 *
 * Protokol lama (baris teks) memakai 0x0A sebagai penanda akhir baris. Kalau
 * SOF yang baru bernilai yang sama, keduanya jadi tidak bisa dibedakan dan
 * perakit akan salah memotong. 0xA5 tidak pernah muncul sebagai byte kendali
 * pada protokol teks mana pun di repo ini.
 *
 * 0xA5 BOLEH muncul DI DALAM payload. Itu aman karena perakit tidak mencari
 * SOF di tengah frame: begitu SOF diterima, ia langsung menghitung LEN byte
 * dan hanya kembali mencari SOF setelah frame selesai (valid atau tidak). Jadi
 * payload yang isinya 0xA5 tidak pernah salah dipotong. Vectors di
 * tests/vectors/frames.vec sengaja memuat kasus ini.
 *
 * KENAPA ADA STATE "SKIP" UNTUK LEN YANG TERLALU BESAR
 *
 * Kalau LEN (> 512) langsung memicu reset ke mode cari-SOF, byte-byte sisa
 * payload itu akan dipindai sebagai kandidat SOF dan bisa meniru SOF asli -
 * perakit lalu membingkai frame palsu yang "valid" tapi isinya sampah.
 * State SKIP membuang tepat LEN byte lalu kembali ke posisi yang benar, jadi
 * resync selalu presisi.
 *
 * BATAS YANG DISENGaja DI FILE INI
 *
 * Perakit hanya memvalidasi STRUKTUR. "Apakah TYPE ini dikenali" bukan
 * pertanyaan perakit - itu keputusan lapisan di atasnya, karena satu perangkat
 * bisa jadi/device bisa saja mendukung lebih banyak. Makanya kode kesalahan
 * SEQ_GAP, CREDIT_EXHAUSTED, dan sejenisnya ADA di sini untuk dipakai fase
 * berikutnya, tapi TIDAK pernah dikeluarkan oleh faFeed().
 *
 * HEADER INI SENGAJA BEBAS ARDUINO
 *
 * Tidak ada #include <Arduino.h>, tidak ada Serial, tidak ada malloc. Itu
 * yang membuatnya bisa diuji di host dengan gcc biasa
 * (tests/suites/frame-asm-native-test.js), tanpa toolchain ESP32 dan tanpa
 * perangkat. Sumber kebenaran format ini adalah file ini - implementasi di
 * frame_asm.c, src/frame-codec.js, dan src-tauri/src/frame.rs semuanya harus
 * menghasilkan byte identik untuk input identik, dan itu yang diperiksa oleh
 * tests/vectors/frames.vec.
 */

#ifndef FRAME_H_
#define FRAME_H_

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

/* ---- Konstanta struktural ---- */
#define FA_SOF        0xA5u
#define FA_VER        0x02u
#define FA_HEADER_LEN 5u    /* SOF + VER + TYPE + LEN(2) */
#define FA_CRC_LEN    2u
#define FA_OVERHEAD   (FA_HEADER_LEN + FA_CRC_LEN)  /* 7 */

/* Batas payload. Jauh di atas MTU BLE maksimum (247), tapi cukup kecil
 * supaya buffer perakit muat di stack tanpa alokasi dinamis. */
#define FA_MAX_PAYLOAD 512u

/* ---- Jenis frame ----
 * 0x00         : reserved / tidak boleh dipakai
 * 0x01 HELLO   : app -> fw, jabat tangan + capabilities
 * 0x02 LINE    : dua arah, escape hatch protokol baris lama
 * 0x10 CFG_BEGIN
 * 0x11 CFG_WRITE
 * 0x12 CFG_COMMIT
 * 0x13 CFG_QUERY
 * 0x14 CFG_ACTIVATE
 * 0x20 EVT      : fw -> app
 * 0x7F ERR      : dua arah
 * Sengaja renggang, dikelompokkan per kelompok agar tidak bentrok
 * saat versi protocol naik nanti.
 */
#define FA_T_HELLO        0x01u
#define FA_T_LINE         0x02u
#define FA_T_CFG_BEGIN    0x10u
#define FA_T_CFG_WRITE    0x11u
#define FA_T_CFG_COMMIT   0x12u
#define FA_T_CFG_QUERY    0x13u
#define FA_T_CFG_ACTIVATE 0x14u
#define FA_T_EVT          0x20u
#define FA_T_ERR          0x7Fu

/* ---- Kode kesalahan ----
 * Hanya tiga yang benar-benar dikeluarkan perakit sekarang. Sisanya
 * dicadangkan untuk fase berikutnya dan sengaja TIDAK dipakai di sini supaya
 * tidak terlihat seperti "sudah didukung" padahal belum.
 */
#define FA_ERR_NONE          0x00u
#define FA_ERR_BAD_VER       0x01u  /* VER bukan FA_VER */
#define FA_ERR_BAD_CRC       0x02u  /* CRC tidak cocok */
#define FA_ERR_LEN_OVERFLOW  0x03u  /* LEN > FA_MAX_PAYLOAD */

/* Dipakai lapisan di atas perakit pada fase berikutnya. */
#define FA_ERR_SEQ_GAP          0x10u
#define FA_ERR_SEQ_DUP          0x11u
#define FA_ERR_NO_SESSION       0x12u
#define FA_ERR_CREDIT_EXHAUSTED 0x13u
#define FA_ERR_STAGING_FULL     0x14u
#define FA_ERR_CRC32_MISMATCH   0x15u
#define FA_ERR_UNSUPPORTED      0x16u

/* ---- CRC16/CCITT-FALSE ----
 * Versi streaming: panggil berulang dengan byte satu per satu. Nilai awal
 * adalah 0xFFFF, sesuai parameter "init" algoritmanya.
 */
static inline uint16_t fa_crc16_init(void) {
  return 0xFFFFu;
}

static inline uint16_t fa_crc16_update(uint16_t crc, uint8_t b) {
  crc ^= (uint16_t)((uint16_t)b << 8);
  for (int i = 0; i < 8; i++) {
    if (crc & 0x8000u) crc = (uint16_t)((crc << 1) ^ 0x1021u);
    else                crc = (uint16_t)(crc << 1);
  }
  return crc;
}

/* Bentuk satu paket. Memakai crc16_update sehingga encoder dan decoder dijamin
 * memakai algoritma yang sama - bukan dua implementasi yang bisa berbeda. */
static inline uint16_t fa_crc16(const uint8_t* data, size_t len) {
  uint16_t crc = fa_crc16_init();
  for (size_t i = 0; i < len; i++) crc = fa_crc16_update(crc, data[i]);
  return crc;
}

/* ---- Perakit ---- */

typedef enum {
  FA_ST_SOF = 0,   /* mencari SOF */
  FA_ST_VER,       /* sudah dapat SOF, membaca VER */
  FA_ST_TYPE,      /* membaca TYPE */
  FA_ST_LEN,       /* membaca LEN (2 byte) */
  FA_ST_PAYLOAD,   /* membaca LEN byte payload */
  FA_ST_CRC,       /* membaca CRC16 (2 byte) */
  FA_ST_SKIP       /* membuang sisa payload yang kelewat besar */
} fa_state_id_t;

typedef struct {
  uint8_t  type;
  uint16_t len;
  uint8_t  payload[FA_MAX_PAYLOAD];
} fa_frame_t;

typedef struct {
  fa_state_id_t st;

  uint8_t  type;
  uint16_t want;      /* LEN yang diharapkan, atau sisa byte yang harus dibuang */
  uint16_t got;       /* byte payload yang sudah diterima */
  uint8_t  payload[FA_MAX_PAYLOAD];
  uint16_t crc;       /* CRC berjalan */
  uint16_t got_crc;   /* byte CRC yang sudah diterima */

  /* Statistik. Menghapus kebutuhan melacak counter di pemanggil, dan membuat
   * "tidak ada error" bisa dibedakan dari "tidak ada yang diukur". */
  uint32_t frames_ok;
  uint32_t err_ver;
  uint32_t err_crc;
  uint32_t err_len;
  uint32_t resyncs;      /* berapa kali kembali ke FA_ST_SOF karena kesalahan */
} fa_state_t;

/* Hasil faFeed(). */
typedef enum {
  FA_F_NONE = 0,  /* belum frame utuh */
  FA_F_FRAME,     /* frame lengkap, ambil dengan faNextFrame() */
  FA_F_ERR_VER,
  FA_F_ERR_CRC,
  FA_F_ERR_LEN
} fa_feed_t;

static inline void faInit(fa_state_t* s) {
  s->st = FA_ST_SOF;
  s->type = 0;
  s->want = 0;
  s->got = 0;
  s->crc = fa_crc16_init();
  s->got_crc = 0;
}

/* Masukkan satu byte.
 *
 * SANGAT penting: fungsi ini tidak pernah mengecek SOF lagi di tengah frame.
 * Itu yang membuat payload yang memuat 0xA5 aman.
 */
fa_feed_t faFeed(fa_state_t* s, uint8_t b);

/* Ambil frame lengkap setelah faFeed() mengembalikan FA_F_FRAME.
 * Mengembalikan false kalau belum ada frame (dipanggil berlebihan). */
bool faNextFrame(fa_state_t* s, fa_frame_t* out);

/* Enkode satu frame ke buffer. Mengembalikan jumlah byte yang ditulis, atau 0
 * kalau payload terlalu besar. Dipakai generator vectors dan tes round-trip. */
size_t faEncode(uint8_t type, const uint8_t* payload, uint16_t len, uint8_t* out, size_t outCap);

#endif /* FRAME_H_ */
