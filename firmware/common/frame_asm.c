/* =================== PERAKIT FRAME v2 ===================
 *
 * Implementasi state machine dari frame.h.
 *
 * Tanpa Arduino, tanpa alokasi memori, tanpa I/O. Semua yang dilakukan fungsi
 * ini adalah mengubah byte menjadi frame - atau melaporkan mengapa itu tidak
 * bisa terjadi.
 *
 * Alur state:
 *
 *   SOF --0xA5--> VER --0x02--> TYPE --> LEN --2 byte--> PAYLOAD --LEN--> CRC --2--> selesai
 *    ^             |                    |                  |               |
 *    |             v                    v                  v               v
 *    |        FA_F_ERR_VER        FA_F_ERR_LEN     (isi payload)    FA_F_ERR_CRC
 *    +<--------------------------------------------------------------------- +
 *                     kembali ke FA_ST_SOF, resyncs naik
 *
 * Perhatikan tidak ada panah kembali ke SOF di tengah frame. Itu disengaja:
 * membuat 0xA5 di dalam payload aman tanpa perlu escaping sama sekali.
 */

#include "frame.h"

/* Titik masuk tunggal untuk semua jalur kesalahan. Menjamin tidak ada keadaan
 * yang bisa "lupa" kembali ke awal setelah gagal. */
static void faResync(fa_state_t* s) {
  s->st = FA_ST_SOF;
  s->got = 0;
  s->got_crc = 0;
  s->crc = fa_crc16_init();
  s->resyncs++;
}

fa_feed_t faFeed(fa_state_t* s, uint8_t b) {
  switch (s->st) {
    case FA_ST_SOF:
      /* Byte lain diabaikan. Inilah yang membedakan "menunggu frame" dari
       * "terjadi transmisi ulang yang berantakan" - log device dari Serial
       * Monitor tidak akan salah dibaca sebagai frame rusak. */
      if (b == FA_SOF) s->st = FA_ST_VER;
      return FA_F_NONE;

    case FA_ST_VER:
      if (b != FA_VER) {
        s->err_ver++;
        faResync(s);
        return FA_F_ERR_VER;
      }
      /* VER sudah divalidasi dan tidak ikut dihitung CRC, jadi CRC mulai dari
       * byte berikutnya, yaitu TYPE. */
      s->crc = fa_crc16_init();
      s->got = 0;
      s->st = FA_ST_TYPE;
      return FA_F_NONE;

    case FA_ST_TYPE:
      s->type = b;
      s->crc = fa_crc16_update(s->crc, b);
      s->want = 0;
      s->got = 0;
      s->st = FA_ST_LEN;
      return FA_F_NONE;

    case FA_ST_LEN:
      /* LEN little-endian: byte pertama adalah yang rendah, dipakai
       * penggeseran 8 * got. */
      s->crc = fa_crc16_update(s->crc, b);
      s->want |= (uint16_t)((uint16_t)b << (8 * s->got));
      s->got++;
      if (s->got < 2) return FA_F_NONE;

      /* Panjang sudah lengkap; baru di sini ketahuan apakah wajar. */
      if (s->want > FA_MAX_PAYLOAD) {
        s->err_len++;
        /* Pindah ke SKIP supaya sisa payload dibuang tepat sebanyak LEN,
         * bukan dipindai sebagai kandidat SOF. Kalau tidak, byte 0xA5 di
         * dalam payload monster itu bisa membingkai frame palsu. */
        s->st = FA_ST_SKIP;
        s->got = 0;
        return FA_F_NONE;
      }
      s->got = 0;
      s->got_crc = 0;
      /* LEN == 0 itu sah (mis. CFG_QUERY tanpa payload), jadi langsung ke
       * CRC tanpa state terpisah. */
      s->st = (s->want == 0) ? FA_ST_CRC : FA_ST_PAYLOAD;
      return FA_F_NONE;

    case FA_ST_PAYLOAD:
      if (s->got < FA_MAX_PAYLOAD) s->payload[s->got] = b;
      s->crc = fa_crc16_update(s->crc, b);
      s->got++;
      if (s->got >= s->want) {
        s->st = FA_ST_CRC;
        /* got WAJIB direset di sini. State CRC memakai `got` sebagai indeks
         * byte CRC (0 lalu 1). Kalau dibiarkan berisi panjang payload, ia
         * jadi 5, 12, 250... dan penggeseran 8 * got melampaui lebar uint16
         * - perilaku tak terdefinisi, dan CRC yang dihitung diam-diam salah.
         * Di sinilah golden vectors lintas bahasa pertama kali menangkapnya. */
        s->got = 0;
        s->got_crc = 0;
      }
      return FA_F_NONE;

    case FA_ST_CRC: {
      s->got_crc |= (uint16_t)((uint16_t)b << (8 * s->got));
      s->got++;
      if (s->got < 2) return FA_F_NONE;

      if (s->got_crc != s->crc) {
        s->err_crc++;
        faResync(s);
        return FA_F_ERR_CRC;
      }
      /* Frame valid. State sengaja TIDAK diubah di sini: pemanggil yang
       * mengambil frame lewat faNextFrame() yang mengembalikan perakit
       * ke mode mencari SOF. Kalau diubah sekarang, pemanggil yang lupa
       * mengambil frame akan membaca frame berikutnya sebagai isi frame ini. */
      s->frames_ok++;
      return FA_F_FRAME;
    }

    case FA_ST_SKIP:
      /* Membuang sisa payload yang kelewat besar. `want` tidak dikurangi;
      * `got` dipakai sebagai hitungan byte yang sudah dibuang. */
      s->got++;
      if (s->got >= s->want) {
        faResync(s);
        return FA_F_ERR_LEN;
      }
      return FA_F_NONE;
  }

  /* Tidak tercapai untuk state yang valid. Dipulihkan ke SOF supaya perakit
   * tidak terjebak diam-diam kalau nanti ada state baru yang lupa ditangani. */
  faResync(s);
  return FA_F_NONE;
}

bool faNextFrame(fa_state_t* s, fa_frame_t* out) {
  if (s->st != FA_ST_CRC) return false;
  out->type = s->type;
  out->len = s->want;
  for (uint16_t i = 0; i < s->want; i++) out->payload[i] = s->payload[i];
  faResync(s);
  return true;
}

size_t faEncode(uint8_t type, const uint8_t* payload, uint16_t len, uint8_t* out, size_t outCap) {
  if (len > FA_MAX_PAYLOAD) return 0;
  const size_t total = (size_t)FA_OVERHEAD + len;
  if (outCap < total) return 0;

  out[0] = FA_SOF;
  out[1] = FA_VER;
  out[2] = type;
  out[3] = (uint8_t)(len & 0xFFu);
  out[4] = (uint8_t)((len >> 8) & 0xFFu);
  for (uint16_t i = 0; i < len; i++) out[FA_HEADER_LEN + i] = payload[i];

  /* CRC atas TYPE + LEN + PAYLOAD, yaitu rentang out[2 .. 5+len). */
  const uint16_t crc = fa_crc16(out + 2, (size_t)3 + len);
  out[5 + len] = (uint8_t)(crc & 0xFFu);
  out[6 + len] = (uint8_t)((crc >> 8) & 0xFFu);
  return total;
}
