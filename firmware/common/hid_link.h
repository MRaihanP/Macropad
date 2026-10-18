// =================== HID LINK (USB HID <-> BLE HID) ===================
//
// Pemisahan backend HID. Core (macropad_core.h) tidak tahu-menahu soal BLE:
// ia tetap memanggil objek bernama "Keyboard" dan "ConsumerControl", persis
// seperti sebelumnya. Yang menentukan mau diterima USB atau BLE adalah
// `g_hidLink` di berkas ini.
//
// ATURAN: tepat SATU backend menerima report pada satu waktu. Kalau USB HID
// dan BLE HID sama-sama menerimanya, host Windows mencatat DUA karakter untuk
// satu penekanan tombol.
//
//   IFACE:USB  -> g_hidLink = USB. Semua jalur BLE dihentikan: peer di-disconnect,
//                 advertising dimatikan. Tombol hanya menghasilkan input USB.
//   IFACE:BLE  -> g_hidLink = BLE. USB HID dibiarkan hidup tapi TIDAK menerima
//                 report. Tombol hanya menghasilkan input BLE.

#pragma once

#include <Arduino.h>
#include "limits.h"
#include "transport.h"   // SERIAL (makro -> g_transport)
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"

#if HID_BLE_SUPPORT
#include "ble_hid.h"
#endif

// ---- Variabel switch ----
HidLink g_hidLink = (HidLink)HID_LINK_DEFAULT;

// hidLinkName() TIDAK didefinisikan di sini tapi di limits.h, karena
// macropad_core.h juga memakainya untuk baris HWINFO (iface=usb|ble) dan
// core tidak boleh meng-include header ini.
//
// Perhatikan nilainya sekarang lowercase ("usb"/"ble"), sebelumnya "USB"/"BLE".
// Huruf besar hanya untuk tampilan log; yang masuk ke protokol harus lowercase
// supaya companion app bisa membandingkannya dengan string apa adanya.

// ---- Objek backend ----
// USB HID didefinisikan di sini. Instance BLE HID milik ble_hid.h.
USBHIDKeyboard        UsbKeyboard;
USBHIDConsumerControl UsbConsumerControl;

// ---- Facade keyboard ----
// API identik dengan yang dipakai core dari USBHIDKeyboard, jadi call site di
// macropad_core.h tidak berubah.
class HidKeyboard {
public:
  void begin() {
    // USB HID selalu di-begin(), termasuk saat mode BLE: kalau HID-nya tidak
    // pernah terdaftar di TinyUSB, switch ke USB tidak bisa instan. Device
    // USB yang ter-enumerasi selama mode BLE bersifat bisu - tidak menerima
    // report - jadi tidak menghasilkan input apa pun.
    UsbKeyboard.begin();
  }

  void press(uint8_t k) {
    if (g_hidLink == HidLink::BLE) {
#if HID_BLE_SUPPORT
      BleKeyboard.press(k);
#endif
    } else {
      UsbKeyboard.press(k);
    }
  }

  void releaseAll() {
    // Kedua backend, tanpa syarat. Ini yang mencegah tombol nyangkut di host
    // yang baru saja ditinggalkan saat IFACE:* mengganti mode.
    UsbKeyboard.releaseAll();
#if HID_BLE_SUPPORT
    BleKeyboard.releaseAll();
#endif
  }

  void print(const char* s) {
    if (g_hidLink == HidLink::BLE) {
#if HID_BLE_SUPPORT
      BleKeyboard.print(s);
#endif
    } else {
      UsbKeyboard.print(s);
    }
  }

  void write(uint8_t k) {
    if (g_hidLink == HidLink::BLE) {
#if HID_BLE_SUPPORT
      BleKeyboard.write((char)k);
#endif
    } else {
      UsbKeyboard.write(k);
    }
  }
};

// ---- Facade consumer control (volume/mute/play) ----
class HidConsumer {
public:
  void begin() { UsbConsumerControl.begin(); }

  void press(uint16_t usage) {
    if (g_hidLink == HidLink::BLE) {
#if HID_BLE_SUPPORT
      BleConsumer.press(usage);
#endif
    } else {
      UsbConsumerControl.press(usage);
    }
  }

  void release() {
    if (g_hidLink == HidLink::BLE) {
#if HID_BLE_SUPPORT
      BleConsumer.release();
#endif
    } else {
      UsbConsumerControl.release();
    }
  }
};

// Jejak input: memberi tahu lewat Serial Monitor medium mana yang MEMENERIMA
// report. Format prefix `[IN:...]` sengaja terpisah dari baris `[KEY]` yang
// dipakai companion app, karena app mem-parsanya dengan regex ketat
// (^\[KEY\] (\d+),(\d+),(\d+),(\d+),(.*)$) dan tidak boleh berubah.
inline void hidTrace(const char* what, const char* detail) {
  LOGS->printf("[IN:%s] %s %s\n", hidLinkName(g_hidLink), what, detail);
}

// Ganti backend aktif.
inline void hidLinkSet(HidLink next) {
  if (next == g_hidLink) return;

  HidLink prev = g_hidLink;

  // 1. Lepas semua tombol di kedua backend lebih dulu. Kalau tidak, tombol
  //    yang sedang ditahan di host yang ditinggalkan akan nyangkut.
  UsbKeyboard.releaseAll();
  UsbConsumerControl.release();
#if HID_BLE_SUPPORT
  BleKeyboard.releaseAll();
  BleConsumer.release();
#endif

  g_hidLink = next;

  // 2. Jalankan seluruh sisi BLE sesuai mode tujuan.
#if HID_BLE_SUPPORT
  if (next == HidLink::USB) {
    // Semua fungsi BLE berhenti: peer diputus (Windows tidak lagi menyimpan
    // keyboard yang tidak akan pernah mengirim apa-apa) dan advertising
    // dimatikan supaya device tidak muncul di daftar.
    bleHidStop();
  } else {
    // Masuk mode BLE: pastikan link siap, advertising dinyalakan.
    bleHidStart();
  }
#endif

  DBG("[IFACE] link %s -> %s\n", hidLinkName(prev), hidLinkName(next));
  DBG("[IFACE] input %s dipakai, %s DINONAKTIFKAN\n",
                 hidLinkName(next), hidLinkName(prev));
}
