// Test Fase 1, runner KETIGA: firmware/common/frame_asm.c diuji dengan gcc
// di host, tanpa Arduino dan tanpa perangkat.
//
// Kenapa runner ini wajib ada, bukan cuma "nice to have":
// - Dua implementasi (JS dan Rust) sudah diuji. Tapi yang akan benar-benar
//   berjalan di device adalah yang C. Kalau hanya JS dan Rust yang hijau,
//   bug di kode C bisa tetap lolos sampai perangkat ada di tangan.
// - Header frame.h sengaja bebas Arduino justru supaya ini mungkin. Kalau
//   perakit ikut terikat Serial/millis, state machine-nya tidak akan pernah
//   bisa diuji tanpa flashing.
// - gcc memeriksa hal-hal yang tidak akan pernah diperiksa compiler lain:
//   perilaku tak terdefinisi dan integer overflow yang lolos begitu saja.
//
// Jalankan: node tests/suites/frame-asm-native-test.js
//
// Kalau gcc tidak ada, test ini DILEWATI dengan pesan jelas - bukan dianggap
// hijau. "Tidak dijalankan" dan "lulus" harus bisa dibedakan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFileSync as run } from 'node:child_process';

let fail = 0;
let lewati = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };
const skip = (msg) => { console.log(`  LEWAT ${msg}`); lewati++; };
// WARN dihitung sebagai "belum sepadan" dan menampilkan nomor urut juga, supaya
// jelas bedanya dari OK dan dari LEWAT yang berarti "tidak dijalankan".
const warn = (msg) => { console.log(`  WARN  ${msg}`); lewati++; };

const ROOT = process.cwd();
const VEC = path.join(ROOT, 'tests', 'vectors', 'frames.vec');

// ---- Cek gcc ----
let gcc = null;
for (const cand of ['gcc', 'clang', 'cc']) {
  try {
    run(cand, ['--version'], { stdio: 'ignore' });
    gcc = cand;
    break;
  } catch { /* coba berikutnya */ }
}

if (!gcc) {
  console.log('--- gcc tidak tersedia ---');
  skip('compiler C tidak ditemukan - test ini DILEWATI, bukan dianggap lulus');
  console.log(`\n${lewati} test dilewati: compiler C tidak ada di PATH`);
  process.exit(0);
}
console.log(`compiler: ${gcc}`);

// ---- Program uji C ----
// Program ini membaca tests/vectors/frames.vec langsung dan mencetak verdict
// per vektor. Dengan begitu HANYA yang diuji adalah frame_asm.c + frame.h -
// tidak ada reimplementasi algoritma di JavaScript yang bisa "membantu" atau
// menutupi bug di C.
const C_SRC = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "frame.h"

/* Buffers dialokasikan sekali di luar fungsi supaya ukuran payload maksimum
   (512 byte) tidak membuat stack meledak di host 32-bit. */
static unsigned char g_in[70000];
static fa_frame_t   g_frame;

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static long parse_hex(const char* s, unsigned char* out, long cap) {
  long n = 0;
  while (*s == ' ') s++;
  while (*s) {
    int hi, lo;
    if (*s == ' ') { s++; continue; }
    hi = hexval(s[0]);
    lo = (hi >= 0 && s[1]) ? hexval(s[1]) : -1;
    if (hi < 0 || lo < 0) break;
    if (n >= cap) return -1;
    out[n++] = (unsigned char)((hi << 4) | lo);
    s += 2;
  }
  return n;
}

static const char* err_name(int e) {
  if (e == FA_F_ERR_VER) return "BAD_VER";
  if (e == FA_F_ERR_CRC) return "BAD_CRC";
  if (e == FA_F_ERR_LEN) return "LEN_OVERFLOW";
  return "?";
}

int main(int argc, char** argv) {
  if (argc < 2) { fprintf(stderr, "pakai: %s <frames.vec>\\n", argv[0]); return 2; }

  FILE* f = fopen(argv[1], "rb");
  if (!f) { fprintf(stderr, "tidak bisa buka %s\\n", argv[1]); return 2; }

  char line[80000];
  long total = 0, gagal = 0;

  /* Check value dulu: kalau algoritma CRC salah, semua kesimpulan lain
     tidak berarti. */
  if (fa_crc16((const unsigned char*)"123456789", 9) != 0x29B1) {
    printf("GAGAL crc16 check value: 0x%04x, harus 0x29B1\\n", fa_crc16((const unsigned char*)"123456789", 9));
    gagal++;
  } else {
    printf("OK   crc16 check value 0x29B1\\n");
  }

  while (fgets(line, sizeof(line), f)) {
    char* p = line;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '#' || *p == '\\n' || *p == '\\r' || *p == 0) continue;
    if (strncmp(p, "SEQ ", 4) != 0) continue;

    char* nama = p + 4;
    char* sp = strchr(nama, ' ');
    if (!sp) continue;
    *sp = 0;
    char* next = sp + 1;

    /* Ekspektasi = token terakhir baris. */
    char* akhir = next + strlen(next);
    while (akhir > next && (akhir[-1] == '\\n' || akhir[-1] == '\\r')) *(--akhir) = 0;
    char* eksp = akhir;
    while (eksp > next && eksp[-1] != ' ') eksp--;
    if (*eksp == 0) { eksp = next; *eksp = 0; }
    char* token_akhir = eksp;
    if (eksp > next) *(eksp - 1) = 0;

    long len = parse_hex(next, g_in, (long)sizeof(g_in));
    if (len < 0) { printf("GAGAL %s: hexOverflow\\n", nama); gagal++; continue; }

    /* Jalankan perakit dan kumpulkan event. */
    fa_state_t st;
    faInit(&st);

    char mendapat[16][24];
    int njumlah = 0;

    for (long i = 0; i < len && njumlah < 16; i++) {
      fa_feed_t r = faFeed(&st, g_in[i]);
      if (r == FA_F_FRAME) {
        if (!faNextFrame(&st, &g_frame)) continue;
        char buf[24];
        snprintf(buf, sizeof(buf), "F:0x%02x", g_frame.type);
        strncpy(mendapat[njumlah], buf, 23);
        njumlah++;
      } else if (r != FA_F_NONE) {
        char buf[24];
        snprintf(buf, sizeof(buf), "E:%s", err_name((int)r));
        strncpy(mendapat[njumlah], buf, 23);
        njumlah++;
      }
    }

    /* Bandingkan dengan ekspektasi. */
    char didapat[512];
    didapat[0] = 0;
    for (int i = 0; i < njumlah; i++) {
      if (i) strcat(didapat, ",");
      strcat(didapat, mendapat[i]);
    }
    char harap[512];
    strncpy(harap, token_akhir, sizeof(harap) - 1);
    harap[sizeof(harap) - 1] = 0;
    if (strcmp(harap, "NONE") == 0) strcpy(harap, "");

    total++;
    if (strcmp(didapat, harap) != 0) {
      printf("GAGAL %s: harap [%s] dapat [%s]\\n", nama, harap, didapat);
      gagal++;
    } else {
      /* Vektor yang persis satu frame harus bisa di-encode ulang persis sama.
         Ini menutup jebakan encode dan decode yang sama-sama salah. */
      if (njumlah == 1 && strncmp(didapat, "F:", 2) == 0 &&
          len == (long)(FA_OVERHEAD + g_frame.len)) {
        static unsigned char enc[1024];
        size_t n = faEncode(g_frame.type, g_frame.payload, g_frame.len, enc, sizeof(enc));
        if (n != (size_t)len || memcmp(enc, g_in, n) != 0) {
          printf("GAGAL %s: encode() byte-nya beda dari vektor\\n", nama);
          gagal++;
        }
      }
    }
  }

  fclose(f);
  printf("VEC %ld GAGAL %ld\\n", total, gagal);
  return gagal ? 1 : 0;
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-asm-'));
const cPath = path.join(dir, 'uji_frame.c');
const exe = path.join(dir, 'uji_frame.exe');
fs.writeFileSync(cPath, C_SRC, 'utf8');

// Salin frame.h + frame_asm.c ke direktori sementara, lalu kompilasi TANPA -I.
//
// kenapa tidak pakai -I firmware/common: firmware/common/limits.h akan
// MENGGANTIKAN <limits.h> milik standar C. stdlib.h memuat <limits.h>, dan
// begitu folder itu masuk jalur include, kompilasi gagal dengan error
// 'enum class' yang sama sekali tidak berhubungan dengan penyebabnya.
//
// Build Arduino tidak kena karena header-nya di-include lewat path relatif,
// bukan lewat -I. Tes ini memakai -I, jadi menyalin file lebih aman.
//
// Efek sampingnya bagus: frame_asm.c + frame.h terbukti benar-benar mandiri,
// tidak diam-diam bergantung pada header lain di firmware/common.
const commonDir = path.join(ROOT, 'firmware', 'common');
for (const f of ['frame.h', 'frame_asm.c']) {
  fs.copyFileSync(path.join(commonDir, f), path.join(dir, f));
}

console.log('\n--- 1. Kompilasi frame_asm.c di host ---');
// -std=c11 : mengikuti default Arduino ESP32.
// -Wall -Wextra -Werror : warning diperlakukan sebagai error. Compiler yang
//   bisa membiarkan kode berbahaya lewat harus tertangkap di sini, bukan
//   ditemukan nanti saat flash ke perangkat.
const DASAR = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-g', '-O1'];
const sumber = [cPath, path.join(dir, 'frame_asm.c')];

let sanitizerAktif = false;
try {
  run(gcc, [...DASAR, '-fsanitize=address,undefined', ...sumber, '-o', exe], { stdio: 'pipe' });
  sanitizerAktif = true;
  ok(true, `kompilasi bersih tanpa warning, dengan ASan/UBSan (${gcc})`);
} catch (e) {
  const pesan = (e.stdout || '') + (e.stderr || '');
  const sanitizerHilang = /cannot find -l(asan|ubsan)/.test(pesan);
  if (!sanitizerHilang) {
    // Error kompilasi yang sebenarnya - tampilkan apa adanya.
    process.stdout.write(pesan);
    ok(false, 'kompilasi gagal - lihat output di atas');
    console.log(`\n${fail} ASSERTION GAGAL`);
    process.exit(1);
  }
  // Sanitizer tidak ada di toolchain ini (paket mingw yang dipangkas biasanya).
  // Itu bukan kegagalan test, tapi TIDAK BOLEH dilaporkan hijau tanpa disebut -
  // kalau tidak, orang akan mengira perilaku tak terdefinisi terpantau.
  try {
    run(gcc, [...DASAR, ...sumber, '-o', exe], { stdio: 'pipe' });
    ok(true, `kompilasi bersih tanpa warning (${gcc} -Wall -Wextra -Werror)`);
    warn('ASan/UBSan tidak ada di toolchain ini, jadi perilaku tak terdefinisi tidak terpantau di runner ini');
  } catch (e2) {
    process.stdout.write(((e2.stdout || '') + (e2.stderr || '')));
    ok(false, 'kompilasi gagal tanpa sanitizer juga gagal');
    console.log(`\n${fail} ASSERTION GAGAL`);
    process.exit(1);
  }
}

console.log('\n--- 2. frame_asm.c cocok dengan golden vectors ---');
try {
  const out = run(exe, [VEC], { encoding: 'utf8' });
  const baris = out.trim().split('\n');
  let vektor = 0;
  for (const b of baris) {
    if (b.startsWith('GAGAL')) { ok(false, b); continue; }
    if (b.startsWith('OK   crc16')) { ok(true, 'CRC16/CCITT-FALSE check value cocok'); continue; }
    if (b.startsWith('VEC ')) {
      const [, t, , g] = b.split(/\s+/);
      vektor = parseInt(t, 10);
      const nGagal = parseInt(g, 10);
      ok(nGagal === 0, `semua ${vektor} vektor cocok di implementasi C`);
    }
  }
  ok(vektor >= 25, `jumlah vektor yang diproses: ${vektor}`);
} catch (e) {
  const out = ((e.stdout || '') + (e.stderr || '')).trim();
  ok(false, `program uji C gagal${out ? ':\n' + out : ''}`);
}

fs.rmSync(dir, { recursive: true, force: true });

// Ringkasan menyebut catatan secara terbuka. Kalau ada WARN yang
// disembunyikan di dalam "SEMUA OK", orang akan mengira sanitizer aktif padahal
// tidak - dan itu persis ketidaktahuan yang membuat fase ini tidak berguna.
const bagian = [fail === 0 ? 'SEMUA OK' : `${fail} ASSERTION GAGAL`];
if (lewati > 0) bagian.push(`${lewati} catatan`);
console.log(`\n${bagian.join(' - ')}: implementasi C cocok dengan golden vectors`);
process.exit(fail ? 1 : 0);
