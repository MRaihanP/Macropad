// =================== BLE SHARED (definisi bersama) ===================
//
// Header ini berisi definisi yang dibutuhkan oleh ble_hid.h, transport_ble.h,
// hid_link.h, dan ble_diag.h tanpa menyebabkan sirkular include.
//
// Hanya definisi data (handle, UUID, ring buffer), TIDAK ada implementasi
// method yang butuh class TransportBase dll.

#pragma once

#include <Arduino.h>
#include "limits.h"

// Sentinel "tidak ada koneksi"
#define BLE_HID_NO_HANDLE 0xFFFF

// Handle koneksi BLE tunggal. Didefinisikan di ble_hid.h (global),
// dideklarasikan extern di sini agar file lain bisa mengakses.
extern volatile uint16_t bleHidConnHandle;

// UUID Nordic UART Service - jalur PROTOCOL companion app.
#define BLE_NUS_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_NUS_TX_UUID     "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // app -> firmware
#define BLE_NUS_RX_UUID     "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // firmware -> app

// Ring buffer NUS (app -> firmware)
#define BLE_NUS_RING_SIZE  2048
// BLE_NUS_MAX_CHUNK dihapus. Batas chunk sekarang dihitung dari MTU hasil
// negosiasi (lihat ble_shared.h: bleNusChunkLimit()). Hardcode 244 akan
// gagal diam-diam kalau Windows menawar MTU < 247.
extern uint8_t      bleNusRing[];
extern volatile uint16_t bleNusHead;
extern volatile uint16_t bleNusTail;
extern portMUX_TYPE bleNusMux;

inline void bleNusPush(const uint8_t* data, size_t len);
inline int bleNusPop(uint8_t* out);
inline int bleNusAvail();
inline void bleNusClear();

extern volatile uint16_t bleNusSubCount;
extern volatile uint32_t bleNusWriteCount;
extern char bleNusLastWrite[];

// Batas atas chunk notify, dihitung dari MTU hasil negosiasi ATT.
//
// MTU minimum yang dijamin BLE adalah 23 (payload 20 byte). Setelah
// onMTUChange dipanggil, nilainya naik ke MTU yang dinegosiasikan (biasanya
// 247 di Windows, tapi tidak dijamin - bisa lebih kecil).
//
// Dipanggil dari transport_ble.h setiap write(), bukan disimpan sebagai
// konstanta, supaya perubahan MTU langsung berlaku tanpa re-init.
uint16_t bleNusChunkLimit();
extern NimBLECharacteristic* bleNusTx;
extern NimBLECharacteristic* bleNusRx;

// ---- Definisi (bukan extern) ----
uint8_t      bleNusRing[BLE_NUS_RING_SIZE];
volatile uint16_t bleNusHead = 0;
volatile uint16_t bleNusTail = 0;
portMUX_TYPE bleNusMux = portMUX_INITIALIZER_UNLOCKED;

inline void bleNusPush(const uint8_t* data, size_t len) {
  portENTER_CRITICAL(&bleNusMux);
  for (size_t i = 0; i < len; i++) {
    uint16_t next = (uint16_t)((bleNusHead + 1) % BLE_NUS_RING_SIZE);
    if (next == bleNusTail) break;
    bleNusRing[bleNusHead] = data[i];
    bleNusHead = next;
  }
  portEXIT_CRITICAL(&bleNusMux);
}

inline int bleNusPop(uint8_t* out) {
  int got = 0;
  portENTER_CRITICAL(&bleNusMux);
  if (bleNusHead != bleNusTail) {
    *out = bleNusRing[bleNusTail];
    bleNusTail = (uint16_t)((bleNusTail + 1) % BLE_NUS_RING_SIZE);
    got = 1;
  }
  portEXIT_CRITICAL(&bleNusMux);
  return got;
}

inline int bleNusAvail() {
  portENTER_CRITICAL(&bleNusMux);
  int n = (int)((bleNusHead - bleNusTail + BLE_NUS_RING_SIZE) % BLE_NUS_RING_SIZE);
  portEXIT_CRITICAL(&bleNusMux);
  return n;
}

inline void bleNusClear() {
  portENTER_CRITICAL(&bleNusMux);
  bleNusHead = 0;
  bleNusTail = 0;
  portEXIT_CRITICAL(&bleNusMux);
}

volatile uint16_t bleNusSubCount   = 0;
volatile uint32_t bleNusWriteCount = 0;
char bleNusLastWrite[64] = {0};

// ---- NUS characteristic pointers ----
NimBLECharacteristic* bleNusTx = nullptr;
NimBLECharacteristic* bleNusRx = nullptr;