// =================== DIAGNOSTIK HID / BLE (Serial Monitor) ===================
//
// Perintah debug untuk menguji pemisahan USB HID <-> BLE HID tanpa companion app.
// Dijawab lewat USB CDC, jadi Serial Monitor tetap hidup di kedua mode.
//
//   IFACE                 -> status link HID yang aktif + koneksi BLE
//   IFACE:USB             -> semua jalur BLE dihentikan, input hanya USB
//   IFACE:BLE             -> input hanya BLE, advertising dinyalakan
//   HID:SELF:<k>[+<k>]    -> kirim 1 report ke backend aktif SAJA (untuk tes)
//   BLE:ADV               -> restart paksa advertising
//   BLE:BOND:CLEAR        -> hapus semua bond di sisi device
//   BLE:RAM / BLE:RING               -> sisa heap / status ring buffer NUS
//
// HID:SELF mengetuk backend aktif langsung (bukan lewat facade) supaya hasilnya
// murni dari medium itu dan bisa dipakai membedakan "backend bermasalah" vs
// "host/pairing bermasalah".

#pragma once

#include <Arduino.h>
#include "limits.h"
#include "transport.h"
#include "hid_link.h"

#if HID_BLE_SUPPORT
#include "ble_hid.h"
#endif

static void bleDiagSelfTest(const String& spec) {
  char buf[MACRO_MAX_LEN];
  spec.toCharArray(buf, sizeof(buf));
  buf[sizeof(buf) - 1] = '\0';

  uint8_t tokens[6];
  uint8_t count = 0;
  char* tok = strtok(buf, "+");
  while (tok != NULL && count < 6) {
    if (strcasecmp(tok, "CTRL") == 0)       tokens[count++] = KEY_LEFT_CTRL;
    else if (strcasecmp(tok, "SHIFT") == 0) tokens[count++] = KEY_LEFT_SHIFT;
    else if (strcasecmp(tok, "ALT") == 0)   tokens[count++] = KEY_LEFT_ALT;
    else if (strcasecmp(tok, "GUI") == 0 || strcasecmp(tok, "WIN") == 0) tokens[count++] = KEY_LEFT_GUI;
    else if (strlen(tok) == 1)              tokens[count++] = (uint8_t)tok[0];
    tok = strtok(NULL, "+");
  }
  if (count == 0) {
    LOGS->println("[ERROR] Format HID:SELF:<k>[+<k>]");
    return;
  }

  bool isBle = (g_hidLink == HidLink::BLE);
  for (uint8_t i = 0; i + 1 < count; i++) {
    if (isBle) BleKeyboard.press(tokens[i]);
    else       UsbKeyboard.press(tokens[i]);
  }
  uint8_t mainKey = tokens[count - 1];
  if (isBle) BleKeyboard.write((char)mainKey);
  else       UsbKeyboard.write(mainKey);
  delay(20);
  if (isBle) BleKeyboard.releaseAll();
  else       UsbKeyboard.releaseAll();

  LOGS->printf("[OK] HID:SELF via %s\n", hidLinkName(g_hidLink));
}

extern ProtoLink g_protoLink;
void protoTransportSwitch();

// Dideklarasikan di switch_iface.h, tapi diekstern di sini supaya header ini
// tetap bisa dipakai profil yang tidak menyertakan switch_iface.h (mis. sketsh
// tes). Definisi ifaceGo() ada di switch_iface.h - hanya deklarasi.
void ifaceGo(bool toBle);

static bool bleDiagCommand(const String& cmd) {
  if (cmd == "IFACE") {
#if HID_BLE_SUPPORT
    LOGS->printf("IFACE:link=%s,conn=%d,adv=%u,scan=%u,nus_sub=%u,nus_wr=%u\n",
                   hidLinkName(g_hidLink),
                   (int)bleHidConnected(),
                   (unsigned)bleAdvSize,
                   (unsigned)bleScanSize,
                   (unsigned)bleNusSubCount,
                   (unsigned)bleNusWriteCount);
#else
    LOGS->printf("IFACE:link=%s,ble_support=0\n", hidLinkName(g_hidLink));
#endif
    return true;
  }

  // IFACE:USB / IFACE:BLE memindahkan KEDUA sumbu lewat ifaceGo() - sama
  // persis dengan yang dilakukan tombol GPIO0. Sebelumnya command ini hanya
  // memanggil hidLinkSet(), jadi PROTO_LINK tidak ikut berubah dan jawaban
  // protokol tetap lewat medium yang salah.
  //
  // Catatan untuk pemanggil dari companion app: jawaban "[OK]" TIDAK bisa
  // diandreikan lewat SERIAL kalau perintah ini coming dari BLE, karena
  // transport-nya baru saja dipindah. Semua pesan ifaceGo() ditulis lewat
  // LOGS (USB CDC) yang tidak pernah berubah - itu sebabnya pesan di sini
  // tidak "[OK] ..." lewat SERIAL seperti perintah lain.
  if (cmd == "IFACE:USB") {
    ifaceGo(false);
    return true;
  }

  if (cmd == "IFACE:BLE") {
    ifaceGo(true);
    return true;
  }

  // ---- PROTO: sumbu kedua, terpisah dari IFACE ----
  //
  // IFACE:* mengatur ke mana REPORT TOMBOL dikirim (USB HID / BLE HID).
  // PROTO:*  mengatur ke mana PROTOKOL companion app dikirim (CDC / NUS).
  //
  // Dua sumbu terpisah supaya sah saja: tombol ke USB HID sementara
  // companion app berbicara lewat BLE NUS (cable tersambung, keyboard
  // tetap di USB).
  //
  // CATATAN: di langkah F3 ini PROTO:* hanya mengubah flag g_protoLink.
  // Pengarahan baca/tulis transport baru dilakukan di F5. Perintahnya tetap
  // harus ada sekarang supaya F5 bisa diuji tanpa flash ulang.
  if (cmd == "PROTO") {
    LOGS->printf("PROTO:link=%s\n", protoLinkName(g_protoLink));
    return true;
  }

  if (cmd == "PROTO:CDC") {
    g_protoLink = ProtoLink::CDC;
    protoTransportSwitch();
    LOGS->println("[OK] Protokol companion app: USB CDC");
    return true;
  }

  if (cmd == "PROTO:NUS") {
    g_protoLink = ProtoLink::NUS;
    protoTransportSwitch();
    LOGS->println("[OK] Protokol companion app: BLE NUS");
    return true;
  }

  // Membuktikan jalur firmware -> app (notify) tanpa companion app harus
  // terbuka: menulis payload nyata ke characteristic 6e400003.
  if (cmd == "BLE:ECHO") {
#if HID_BLE_SUPPORT
    const char* msg = "EVT:LAYER:0";
    uint16_t h = bleHidConnHandle;
    if (bleNusRx == nullptr) {
      LOGS->println("[ERROR] NUS RX characteristic belum ada");
    } else if (h == BLE_HID_NO_HANDLE) {
      LOGS->println("[ERROR] belum ada koneksi BLE");
    } else if (bleNusSubCount == 0) {
      LOGS->printf("[WARN] NUS: belum ada subscriber; notify akan diabaikan\n");
      bleNusRx->notify((const uint8_t*)msg, strlen(msg), h);
    } else {
      bool ok = bleNusRx->notify((const uint8_t*)msg, strlen(msg), h);
      LOGS->printf("[%s] NUS notify \"%s\"\n", ok ? "OK" : "GAGAL", msg);
    }
#else
    LOGS->println("[ERROR] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
    return true;
  }
  if (cmd.startsWith("HID:SELF:")) { bleDiagSelfTest(cmd.substring(9)); return true; }

  // BLE:STAT - laporan kegagalan notify, satu baris.
  //
  // Inilah data yang tidak pernah ada sebelumnya. "DUMP_END hilang" bisa
  // disebabkan notify yang gagal DAN diabaikan write() - dan tanpa
  // penghitung itu, penyebabnya tidak bisa dibedakan dari dugaan lain
  // (antrean, frame tumpang tindih, parser).
  //
  // Cara membaca:
  //   ntrunc naik  = byte BENAR-BENAR hilang saat notify. Ini penyebabnya.
  //   ntrunc = 0   = tidak ada byte hilang di device. Kalau "DUMP_END hilang"
  //                  tetap muncul, masalahnya ada di sisi app/Rust, bukan
  //                  di device - dan itu kesimpulan, bukan tebakan.
  //
  // Ditulis lewat LOGS (USB CDC) supaya selalu terlihat di Serial Monitor,
  // cukup dengan satu perintah tanpa mengubah medium apa pun.
  if (cmd == "BLE:STAT") {
#if HID_BLE_SUPPORT
    LOGS->printf("STAT:nfail=%u,ntrunc=%u,mtu=%u,ring=%u/%u,drops=%u\n",
                 (unsigned)bleNotifyFailCount,
                 (unsigned)bleNotifyTruncCount,
                 (unsigned)bleNusChunkLimit(),
                 (unsigned)bleNusAvail(),
                 (unsigned)BLE_NUS_RING_SIZE,
                 (unsigned)bleNusDroppedBytes);
#else
    LOGS->println("STAT:ble_support=0");
#endif
    return true;
  }

  if (cmd == "BLE:ADV") {
#if HID_BLE_SUPPORT
    if (!NimBLEDevice::isInitialized()) {
      LOGS->println("[ERROR] BLE belum diinisialisasi");
    } else {
      NimBLEDevice::getAdvertising()->start(0);
      LOGS->println("[OK] Advertising di-restart");
    }
#else
    LOGS->println("[ERROR] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
    return true;
  }

  if (cmd == "BLE:BOND:CLEAR") {
#if HID_BLE_SUPPORT
    if (NimBLEDevice::deleteAllBonds()) LOGS->println("[OK] Semua bond dihapus; hapus juga device di host, lalu pair ulang");
    else                              LOGS->println("[ERROR] Gagal menghapus bond");
#else
    LOGS->println("[ERROR] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
    return true;
  }

  if (cmd == "BLE:RAM") {
    LOGS->printf("RAM:free=%lu,min=%lu\n",
                   (unsigned long)ESP.getFreeHeap(),
                   (unsigned long)ESP.getMinFreeHeap());
    return true;
  }

  // Status ring buffer NUS. Dihitung ulang dari Head/Tail, jadi benar
  // walau penghitung overflow di-reset atau belum ada.
  //
  // dipped=0 berarti TIDAK ADA satu byte pun perintah companion app yang
  // terpotong sejak boot - semua perintah sampai utuh. dipped>0 berarti ada
  // yang hilang, device bisa salah baca perintah, dan itu penyebab paling
  // mungkin dari preset yang "beberapa kali berhasil lalu stuck".
  if (cmd == "BLE:RING") {
    uint16_t used = (uint16_t)((bleNusHead - bleNusTail + BLE_NUS_RING_SIZE) % BLE_NUS_RING_SIZE);
    LOGS->printf("RING:used=%u/%u,dipped=%lu,overflows=%lu\n",
                 (unsigned)used, (unsigned)BLE_NUS_RING_SIZE,
                 (unsigned long)bleNusDroppedBytes,
                 (unsigned long)bleNusPushOverflows);
    return true;
  }

  return false;
}
