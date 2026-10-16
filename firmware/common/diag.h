// =================== DIAG PROTOKOL (LAPIS L3) ===================
//
// Penghitung lapis PROTOKOL: berapa baris yang diparse, berapa yang terlalu
// panjang, berapa perintah yang tidak dikenal, dan perintah terakhir yang
// masuk. Ditambah satu baris media (L4) yang diisi transport yang sedang aktif.
//
// Kenapa perlu terpisah dari laporan app:
//
// Tiga lapis bisa gagal dan gejalanya SAMA persis - companion app diam saja,
// tidak ada error, tidak ada preset. Tanpa penghitung per lapis, satu-satunya
// cara penyebabnya adalah menebak: ganti kabel, dekatkan device, ulangi.
//
// Setelah fase ini, setiap kegagalan punya satu baris yang menyebut lapis
// tempatnya, bukan lagi "sepertinya BLE-nya".
//
// ATURAN: file ini tidak boleh tahu media apa pun. Dia hanya menghitung apa
// yang sudah dilewatkan core. Bagian media datang lewat makro
// PROTO_DIAG_MEDIA(), yang overridden transport_ble.h kalau NUS dikompilasi
// (dan dibiarkan kosong kalau tidak) - supaya profil FINAL yang tidak punya
// NUS tetap bisa kompilasi tanpa perubahan lain.

#pragma once

#include <Arduino.h>
#include "limits.h"
#include "transport.h"

// ---- Penghitung lapis protokol ----
// Definisi (bukan extern), mengikuti pola yang dipakai file common lain:
// seluruhnya berada dalam satu translation unit (sketsh .ino).
uint32_t protoLinesParsed   = 0;   // baris lengkap yang diteruskan ke parser
uint32_t protoLineTooLong   = 0;   // baris > SERIAL_LINE_MAX, dibuang
uint32_t protoUnknownCmd    = 0;   // "[ERROR] Command tidak dikenal"
uint32_t protoCmdsTotal     = 0;   // perintah non-kosong yang masuk
uint32_t protoDiagServed    = 0;   // berapa kali DIAG menjawab (bukti DIAG hidup)
char     protoLastCmd[48]   = {0};

// Hook opsional. Default kosong supaya profil tanpa NUS (mis. FINAL) tidak
// perlu stub apa pun - satu-satunya yang harus ditulis adalah transport_ble.h.
#ifndef PROTO_DIAG_MEDIA
#define PROTO_DIAG_MEDIA() do {} while (0)
#endif
#ifndef PROTO_DIAG_RESET
#define PROTO_DIAG_RESET()  do {} while (0)
#endif

void protoDiagReset() {
  protoLinesParsed = 0;
  protoLineTooLong = 0;
  protoUnknownCmd  = 0;
  protoCmdsTotal   = 0;
  protoDiagServed  = 0;
  protoLastCmd[0]  = '\0';
  PROTO_DIAG_RESET();
}

// Perintah DIAG.
//
// Dua baris, bukan satu. Alasannya praktis: menyusun satu baris dengan
// key=value dari dua sumber (core + media) butuh buffer gabungan dan penyusunan
// manual - dan buffer itulah yang justru pernah jadi sumber bug "baris terlalu
// panjang" di lapisan ini. Dua baris membuat masing-masing pihak mencetak
// bagiannya sendiri lewat printf yang sudah teruji, tanpa buffer tambahan.
//
// Format dijaga ketat: KEY=VALUE, dipisah koma, tanpa spasi, tanpa nilai
// bertingkat. Parser di app cukup memotong pada ',' lalu '=' - tidak ada
// ekspresi yang perlu diurai.
static bool protoDiagCommand(const String& cmd) {
  if (cmd == "DIAG:ZERO") {
    protoDiagReset();
    SERIAL->println("[OK] DIAG counter direset");
    return true;
  }

  if (cmd == "DIAG") {
    protoDiagServed++;
    const char* tname = (g_transport && g_transport->type() == TransportType::TP_BLE) ? "nus" : "cdc";
    // lastCmd sengaja dibatasi supaya tidak pernah jadi pemicu baris melebihi
    // batas. Trim per byte, bukan strncpy: strncpy tidak menutup bila sumber
    // panjang dan tidak ada terminator setelahnya.
    size_t n = strlen(protoLastCmd);
    if (n > 40) n = 40;
    char last[41];
    memcpy(last, protoLastCmd, n);
    last[n] = '\0';

    SERIAL->printf("DIAG:lines=%lu,cmds=%lu,tooLong=%lu,unknown=%lu,diagServed=%lu,lastCmd=%s,transport=%s,heap=%lu\n",
                   (unsigned long)protoLinesParsed,
                   (unsigned long)protoCmdsTotal,
                   (unsigned long)protoLineTooLong,
                   (unsigned long)protoUnknownCmd,
                   (unsigned long)protoDiagServed,
                   last,
                   tname,
                   (unsigned long)ESP.getFreeHeap());
    PROTO_DIAG_MEDIA();
    return true;
  }

  return false;
}
