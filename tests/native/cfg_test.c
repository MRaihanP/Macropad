/* =================== UJI CRC32 + CFG_SIG DI HOST ===================
 *
 * Program uji mandiri, bukan potongan kode di dalam template literal
 * JavaScript.
 *
 * Alasannya bukan soal selera: program uji C yang ditulis di dalam template
 * literal JS butuh dua lapis escaping (newline dan newline), dan setiap
 * kesalahan escaping muncul sebagai "error kompilasi yang sama sekali tidak
 * mengarah ke penyebabnya". Berkas .c sungguhan dibaca apa adanya, dan
 * diff-nya masuk review seperti kode biasa.
 *
 * Yang diuji HANYA dua header yang dipakai firmware:
 *   firmware/common/crc32.h
 *   firmware/common/cfg_sig.h
 *
 * Angka harapan dibaca dari tests/vectors/cfg.vec, yang dihasilkan
 * tools/gen-cfg-vectors.mjs. Jadi angka di sini bukan hasil perhitungan ulang
 * - kalau implementasinya salah, angkanya tetap dibandingkan dengan angka
 * yang benar.
 *
 * Jalankan: ./cfg_test <tests/vectors/cfg.vec>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <strings.h>

#include "crc32.h"
#include "cfg_sig.h"

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* Parser deskripsi tanpa strtok.
 *
 * strtok menyimpan state global, jadi dua pemanggilan bersarang (outer dengan
 * satu separator, lalu inner dengan separator lain) merusak parser luar.
 * Percobaan pertama memakai strtok dan gagal pada 12 dari 13 vektor dengan
 * angka hasil yang sama persis - tanda jelas bahwa inputnya salah parse,
 * bukan algoritmanya salah.
 *
 * Parser di bawah memisahkan satu field pada satu waktu dari pointer yang
 * sudah disalin. Tidak ada state global, jadi nesting aman. */
static char* next_field(char** cur, char sep) {
  char* s = *cur;
  if (!s) return NULL;
  char* end = strchr(s, sep);
  if (end) { *end = 0; *cur = end + 1; }
  else { *cur = s + strlen(s); }
  return s;
}

/* Isi byte dari string heksadesimal ke buffer, lalu isi sisa dengan nol.
 *
 * Padding nol bukan hiasan: vektor menulis nama dan nilai sebagai byte tetap
 * selebar lebarnya, tapi pemanggil harus tetap aman kalau ada byte yang tidak
 * terbaca, bukan membaca byte sampah. */
static int hex_into(const char* hex, uint8_t* out, int width) {
  int n = 0;
  while (*hex && n < width) {
    int hi = hexval(hex[0]);
    int lo = (hi >= 0 && hex[1]) ? hexval(hex[1]) : -1;
    if (hi < 0 || lo < 0) break;
    out[n++] = (uint8_t)((hi << 4) | lo);
    hex += 2;
  }
  memset(out + n, 0, (size_t)(width - n));
  return n;
}

/* Parse satu deretan heksadesimal BERSPASI (dipakai baris CRC32). */
static long parse_hex_spaced(const char* s, unsigned char* out, long cap) {
  long n = 0;
  while (*s == ' ') s++;
  while (*s) {
    int hi, lo;
    if (*s == ' ') { s++; continue; }
    hi = hexval(s[0]);
    lo = (hi >= 0 && s[1] && s[1] != ' ') ? hexval(s[1]) : -1;
    if (hi < 0 || lo < 0) break;
    if (n >= cap) return -1;
    out[n++] = (uint8_t)((hi << 4) | lo);
    s += 2;
  }
  return n;
}

static unsigned char g_buf[200000];
static char g_line[200000];

static long crc_total = 0, crc_bad = 0;
static long sig_total = 0, sig_bad = 0;

static void uji_crc32_line(char* p) {
  char* nama = p + 6;              /* lewat "CRC32 " */
  char* sp = strchr(nama, ' ');
  if (!sp) return;
  *sp = 0;
  char* sisa = sp + 1;

  /* Token terakhir = crc yang diharapkan; sisanya byte. */
  char* akhir = sisa + strlen(sisa);
  while (akhir > sisa && (akhir[-1] == '\n' || akhir[-1] == '\r')) *(--akhir) = 0;
  char* tokExpect = akhir;
  while (tokExpect > sisa && tokExpect[-1] != ' ') tokExpect--;
  char expect[16];
  strncpy(expect, tokExpect, 15);
  expect[15] = 0;
  if (tokExpect > sisa) *(tokExpect - 1) = 0;

  long len = parse_hex_spaced(sisa, g_buf, (long)sizeof(g_buf));
  if (len < 0) { printf("GAGAL CRC32 %s: hexOverflow\n", nama); crc_bad++; return; }

  uint32_t got = crc32_bytes(g_buf, (size_t)len);
  char heksa[16];
  snprintf(heksa, sizeof(heksa), "%08lx", (unsigned long)got);
  crc_total++;
  if (strncasecmp(expect, heksa, 8) != 0) {
    printf("GAGAL CRC32 %s: harap %s dapat %s\n", nama, expect, heksa);
    crc_bad++;
  }
}

static void uji_sig_line(char* p) {
  char* nama = p + 4;              /* lewat "SIG " */
  char* sp = strchr(nama, ' ');
  if (!sp) return;
  *sp = 0;
  char* desc = sp + 1;

  /* Signature = token terakhir deskripsi. */
  char* akhirDesc = desc + strlen(desc);
  while (akhirDesc > desc && akhirDesc[-1] != ' ') akhirDesc--;
  char expect[16];
  strncpy(expect, akhirDesc, 15);
  expect[15] = 0;
  if (akhirDesc > desc) *(--akhirDesc) = 0;

  static char names[16][64];
  static uint8_t keyT[256];
  static char keyV[256][64];
  static uint8_t encT[64];
  static char encV[64][64];
  unsigned nNames = 0, nKeyRows = 0, nEnc = 0;
  int ver = 0, lc = 0, clv = 0;
  int nl = 0, nk = 0, ne = 0, epk = 0, nameLen = 0, valLen = 0;

  /* Buffer DIRESET di awal setiap kasus.
   *
   * Buffer ini static, jadi isinya bertahan antar baris vektor. Kalau tidak
   * direset, kasus yang key-nya lebih pendek akan membaca sisa kasus
   * sebelumnya - dan hasilnya "salah" tanpa jejak yang mengarah ke penyebabnya.
   * Generator sudah melengkapi deskripsi jadi selalu penuh, tapi reset di sini
   * tetap wajib: kalau nanti ada vektor yang sengaja tidak lengkap, hasilnya
   * harus "belum terisi", bukan "sisa kasus lalu". */
  memset(keyT, 0, sizeof(keyT));
  memset(keyV, 0, sizeof(keyV));
  memset(encT, 0, sizeof(encT));
  memset(encV, 0, sizeof(encV));
  memset(names, 0, sizeof(names));

  /* Deskripsi: key=value dipisah ',', field dipisah ';'. Nama layer dalam
   * satu field dipisah '|', item key dipisah ',' dengan "type:hex".
   * Semuanya tanpa spasi, jadi tidak ada ambiguitas pemisah. */
  {
    char* cur = desc;
    char* f;
    while ((f = next_field(&cur, ';')) != NULL && *f) {
      /* Field N=/K=/E= punya nilai yang mengandung koma sendiri, jadi HARUS
       * diambil apa adanya - tidak boleh dipecah koma. Percobaan pertama
       * memecah semua field dengan koma dan berakhir hanya membaca key "v",
       * sehingga semua vektor menghasilkan sidik jari yang sama persis.
       * Field lainnya adalah pasangan key=value yang dipisah koma. */
      if (!strncmp(f, "N=", 2) || !strncmp(f, "K=", 2) || !strncmp(f, "E=", 2)) {
        char* eq = strchr(f, '=');
        *eq = 0;
        const char* k = f;
        char* v = eq + 1;
        if (!strcmp(k, "N")) {
        char* curN = v;
        char* item;
        while ((item = next_field(&curN, '|')) != NULL && *item != 0 && nNames < 16) {
          hex_into(item, (uint8_t*)names[nNames], nameLen);
          nNames++;
        }
      } else if (!strcmp(k, "K")) {
        char* curK = v;
        char* row;
        while ((row = next_field(&curK, '|')) != NULL && *row != 0 && nKeyRows < 16) {
          char* curI = row;
          char* item;
          unsigned idx = 0;
          while ((item = next_field(&curI, ',')) != NULL && *item != 0 && nk > 0 && idx < (unsigned)nk) {
            char* colon = strchr(item, ':');
            if (!colon) continue;
            *colon = 0;
            keyT[(size_t)nKeyRows * nk + idx] = (uint8_t)atoi(item);
            hex_into(colon + 1, (uint8_t*)keyV[(size_t)nKeyRows * nk + idx], valLen);
            idx++;
          }
          nKeyRows++;
        }
      } else if (!strcmp(k, "E")) {
        char* curE = v;
        char* item;
        while ((item = next_field(&curE, ',')) != NULL && *item != 0 && nEnc < 64) {
          char* colon = strchr(item, ':');
          if (!colon) continue;
          *colon = 0;
          encT[nEnc] = (uint8_t)atoi(item);
          hex_into(colon + 1, (uint8_t*)encV[nEnc], valLen);
          nEnc++;
        }
      }
        continue;   /* field N=/K=/E= selesai; jangan dipisah koma */
      }

      /* Selain itu: pasangan key=value dipisah koma. */
      {
        char* cur2 = f;
        char* pair;
        while ((pair = next_field(&cur2, ',')) != NULL && *pair) {
          char* eq2 = strchr(pair, '=');
          if (!eq2) continue;
          *eq2 = 0;
          const char* k2 = pair;
          char* v2 = eq2 + 1;
          if (!strcmp(k2, "v")) ver = atoi(v2);
          else if (!strcmp(k2, "lc")) lc = atoi(v2);
          else if (!strcmp(k2, "cl")) clv = atoi(v2);
          else if (!strcmp(k2, "nl")) nl = atoi(v2);
          else if (!strcmp(k2, "nk")) nk = atoi(v2);
          else if (!strcmp(k2, "ne")) ne = atoi(v2);
          else if (!strcmp(k2, "epk")) epk = atoi(v2);
          else if (!strcmp(k2, "nl_len")) nameLen = atoi(v2);
          else if (!strcmp(k2, "val_len")) valLen = atoi(v2);
        }
      }
    }
  }

  cfg_sig_src_t src;
  memset(&src, 0, sizeof(src));
  src.layerNames   = (const char*)names[0];
  src.keyTypes       = keyT;
  src.keyValues      = (const char*)keyV[0];
  src.encTypes       = encT;
  src.encValues      = (const char*)encV[0];
  /* Stride di sini BERBEDA dari firmware, dan itu justru inti ujinya.
   * Di firmware type dan value sama-sama di dalam KeyAction jadi jaraknya sama.
   * Di sini keduanya array datar: type berjejer setiap 1 byte, value setiap
   * sizeof(keyV[0]). Kalau cfg_sig.h masih memakai satu stride untuk keduanya,
   * nilai yang dihitung di sini akan beda dari firmware tanpa error. */
  src.keyTypeStride   = 1;
  src.keyValueStride  = (size_t)sizeof(keyV[0]);
  src.encTypeStride   = 1;
  src.encValueStride  = (size_t)sizeof(encV[0]);
  src.layerNameStride = (size_t)sizeof(names[0]);
  src.nLayers      = (uint8_t)nl;
  src.nKeys        = (uint8_t)nk;
  src.nEncoders    = (uint8_t)ne;
  src.encPerKnob   = (uint8_t)epk;
  src.nameLen      = (uint8_t)nameLen;
  src.valueLen     = (uint8_t)valLen;

  uint32_t got = cfgSigCompute((uint8_t)ver, (uint8_t)lc, (uint8_t)clv, &src);
  char heksa[16];
  snprintf(heksa, sizeof(heksa), "%08lx", (unsigned long)got);
  sig_total++;
  if (strncasecmp(expect, heksa, 8) != 0) {
    printf("GAGAL SIG %s: harap %s dapat %s\n", nama, expect, heksa);
    sig_bad++;
  }
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "pakai: %s <cfg.vec>\n", argv[0]);
    return 2;
  }
  FILE* f = fopen(argv[1], "rb");
  if (!f) { fprintf(stderr, "tidak bisa buka %s\n", argv[1]); return 2; }

  /* Check value baku. Kalau angka ini salah, semua kesimpulan lain tidak
   * berarti - persis seperti check value CRC16 di runner frame. */
  if (crc32_bytes((const uint8_t*)"123456789", 9) != 0xCBF43926u) {
    printf("GAGAL crc32 check value: dapat %08lX, harus CBF43926\n",
           (unsigned long)crc32_bytes((const uint8_t*)"123456789", 9));
    crc_bad++;
  } else {
    printf("OK   crc32 check value CBF43926\n");
  }

  while (fgets(g_line, sizeof(g_line), f)) {
    char* p = g_line;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '#' || *p == '\n' || *p == '\r' || *p == 0) continue;
    if (strncmp(p, "CRC32 ", 6) == 0)      uji_crc32_line(p);
    else if (strncmp(p, "SIG ", 4) == 0)  uji_sig_line(p);
  }
  fclose(f);

  printf("CFG crc=%ld/%ld sig=%ld/%ld\n",
         crc_total - crc_bad, crc_total, sig_total - sig_bad, sig_total);
  return (crc_bad || sig_bad) ? 1 : 0;
}
