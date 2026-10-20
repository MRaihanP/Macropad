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
//   BLE:RAM               -> sisa heap
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

  if (cmd == "IFACE:USB") {
    hidLinkSet(HidLink::USB);
    LOGS->println("[OK] Input USB HID");
    return true;
  }

  if (cmd == "IFACE:BLE") {
#if HID_BLE_SUPPORT
    hidLinkSet(HidLink::BLE);
    LOGS->println("[OK] Input BLE HID");
#else
    LOGS->println("[ERROR] BLE HID tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
    return true;
  }

  // ---- MODE:BT / MODE:PC - satu perintah untuk pindah medium, sama seperti
  //      tombol BOOT (ifaceSwitchFull() di sketsh), tapi di sini dipanggil
  //      dari Serial Monitor tanpa perlu menekan GPIO0. ----
  //
  // BT  = pindah ke BLE  (setara satu tekan tombol saat mode USB)
  // PC  = pindah ke USB  (setara satu tekan tombol saat mode BLE)
  //
  // Perintah ini menyelaraskan KEDUA sumbu (HID_LINK + PROTO_LINK) dan
  // memindahkan POWER (mutual exclusion), sama persis dengan tombol BOOT.
  if (cmd == "MODE:BT" || cmd == "MODE:PC") {
    const bool goBle = (cmd == "MODE:BT");
#if HID_BLE_SUPPORT
    ifaceSwitchFull(goBle);
#else
    (void)goBle;
    LOGS->println("[ERROR] BLE tidak dikompilasi (HID_BLE_SUPPORT=0) - hanya MODE:PC");
#endif
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

  return false;
}
