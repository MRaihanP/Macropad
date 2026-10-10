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
    SERIAL->println("[ERROR] Format HID:SELF:<k>[+<k>]");
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

  SERIAL->printf("[OK] HID:SELF via %s\n", hidLinkName(g_hidLink));
}

static bool bleDiagCommand(const String& cmd) {
  if (cmd == "IFACE") {
#if HID_BLE_SUPPORT
    SERIAL->printf("IFACE:link=%s,ble_conn=%d,advertising=%d\n",
                   hidLinkName(g_hidLink),
                   (int)bleHidConnected(),
                   (int)bleHidAdvertising());
#else
    SERIAL->printf("IFACE:link=%s,ble_support=0\n", hidLinkName(g_hidLink));
#endif
    return true;
  }

  if (cmd == "IFACE:USB") {
    hidLinkSet(HidLink::USB);
    SERIAL->println("[OK] Input USB HID");
    return true;
  }

  if (cmd == "IFACE:BLE") {
#if HID_BLE_SUPPORT
    hidLinkSet(HidLink::BLE);
    SERIAL->println("[OK] Input BLE HID");
#else
    SERIAL->println("[ERROR] BLE HID tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
    return true;
  }

  if (cmd.startsWith("HID:SELF:")) { bleDiagSelfTest(cmd.substring(9)); return true; }

  if (cmd == "BLE:ADV") {
#if HID_BLE_SUPPORT
    if (!NimBLEDevice::isInitialized()) {
      SERIAL->println("[ERROR] BLE belum diinisialisasi");
    } else {
      NimBLEDevice::getAdvertising()->start(0);
      SERIAL->println("[OK] Advertising di-restart");
    }
#else
    SERIAL->println("[ERROR] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
    return true;
  }

  if (cmd == "BLE:BOND:CLEAR") {
#if HID_BLE_SUPPORT
    if (NimBLEDevice::deleteAllBonds()) SERIAL->println("[OK] Semua bond dihapus; hapus juga device di host, lalu pair ulang");
    else                              SERIAL->println("[ERROR] Gagal menghapus bond");
#else
    SERIAL->println("[ERROR] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
    return true;
  }

  if (cmd == "BLE:RAM") {
    SERIAL->printf("RAM:free=%lu,min=%lu\n",
                   (unsigned long)ESP.getFreeHeap(),
                   (unsigned long)ESP.getMinFreeHeap());
    return true;
  }

  return false;
}
