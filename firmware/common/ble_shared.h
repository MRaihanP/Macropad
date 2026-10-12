// =================== BLE SHARED (definisi bersama) ===================
//
// Header ini berisi definisi yang dibutuhkan oleh ble_hid.h, transport_ble.h,
// hid_link.h, dan ble_diag.h tanpa menyebabkan sirkular include.
//
// Hanya definisi data (handle, UUID, ring buffer), TIDAK ada implementasi
// method yang butuh class TransportBase dll.

#pragma once

#include <Arduino.h>
#include <NimBLEDevice.h>
#include "limits.h"
// LOGS dipakai di bleNusPush() untuk mencatat byte yang dibuang. Header ini
// bisa di-include tanpa transport.h (mis. lewat BLE_Keypad_Test), jadi
// g_logTransport dideklarasikan di sini juga supaya tidak gagal compile di
// jalur mana pun. Definisinya tetap milik transport.h.
extern Transport* g_logTransport;

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
//
// 4096, bukan 2048. Alasannya bukan sekadar "lebih besar lebih aman":
// satu batch preset berisi ratusan perintah SET yang totalnya bisa >1,5 KB
// (SET per tombol + RENAMELAYER + SETENC per layer). Kalau buffer 2 KB dan
// firmware sedang sibuk mengirim jawaban DUMP (11 baris notify beruntun),
// loop utama tidak sempat menguras ring - dan byte dipotong DI TENGAH
// perintah. Perintah korup itu dibaca sebagai perintah lain, atau gagal
//dihitung, dan device masuk state yang tidak sesuai.
//
// Gejalanya persis seperti yang dilaporkan: berpindah preset BERJAYA
// beberapa kali, lalu STUCK - dan baru bergerak setelah ada perintah kecil
// yang muat, karena byte pertama baris itu kebetulan bisa masuk.
#define BLE_NUS_RING_SIZE  4096

// Berapa byte yang gagal masuk ring buffer sejak boot.Dibaca lewat perintah
// BLE:RING supaya bisa dicek dari Serial Monitor tanpa menambah apa pun ke
// stream protokol.
extern uint32_t bleNusDroppedBytes;
extern uint32_t bleNusPushOverflows;
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
  size_t dropped = 0;
  for (size_t i = 0; i < len; i++) {
    uint16_t next = (uint16_t)((bleNusHead + 1) % BLE_NUS_RING_SIZE);
    // Penuh: byte LANJUTAN dibuang, termasuk kalau ada di tengah baris
    // perintah. Versi lama melakukan ini tanpa catatan apa pun, jadi perintah
    // korup yang dihasilkan tidak pernah terlihat dari mana pun.
    if (next == bleNusTail) { dropped++; continue; }
    bleNusRing[bleNusHead] = data[i];
    bleNusHead = next;
  }
  bleNusDroppedBytes += (uint32_t)dropped;
  if (dropped) bleNusPushOverflows++;
  portEXIT_CRITICAL(&bleNusMux);

  // Log di LUAR critical section: menulis ke USB CDC dari dalam
  // portENTER_CRITICAL bisa memblokir dan memperburuk keadaan yang sedang
  // dicoba didiagnosis.
  if (dropped) {
    LOGS->printf("[BLE] ring PENUH: %u byte dibuang (total %u, kejadian %u) - "
                 "perintah dari companion app kemungkinan korup\n",
                 (unsigned)dropped, (unsigned)bleNusDroppedBytes,
                 (unsigned)bleNusPushOverflows);
  }
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
// Penghitung overflow ring buffer. Nol = tidak ada satu byte pun yang
// terpotong sejak boot, jadi semua perintah yang diterima utuh.
uint32_t bleNusDroppedBytes  = 0;
uint32_t bleNusPushOverflows = 0;
volatile uint32_t bleNusWriteCount = 0;
char bleNusLastWrite[64] = {0};

// ---- NUS characteristic pointers ----
NimBLECharacteristic* bleNusTx = nullptr;
NimBLECharacteristic* bleNusRx = nullptr;
