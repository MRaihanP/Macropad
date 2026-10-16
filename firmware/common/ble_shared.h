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

// MTU ATT yang sedang berlaku. Fungsi, bukan konstanta, supaya DIAG selalu
// melaporkan nilai terbaru setelah onMTUChange - angka MTU yang dicetak saat
// boot akan basi begitu negosiasi selesai.
uint16_t bleNusMtu();
extern NimBLECharacteristic* bleNusTx;
extern NimBLECharacteristic* bleNusRx;

// ---- Definisi (bukan extern) ----
uint8_t      bleNusRing[BLE_NUS_RING_SIZE];
volatile uint16_t bleNusHead = 0;
volatile uint16_t bleNusTail = 0;
portMUX_TYPE bleNusMux = portMUX_INITIALIZER_UNLOCKED;

// =================== PENGHITUNG LAPIS MEDIA (L4) ===================
//
// Semua yang di bawah ini SEBELUMNYE hilang tanpa jejak.
//
// bleNusPush() dulu memakai `if (next == bleNusTail) break;` - jadi saat ring
// buffer penuh, byte langsung dibuang tanpa satu pun counter yang naik.
// Akibatnya companion app hanya melihat jawaban device yang "berhenti di
// tengah" dan tidak pernah bisa tahu apakah itu karena radio, host yang
// lambat, atau ring buffer device yang penuh. Ketiganya punya tindakan
// berbeda, jadi tidak boleh dicampur jadi satu gejala.
//
// Sekarang semuanya dihitung, lalu dicetak oleh perintah DIAG (diag.h).
// Tidak ada perilaku transfer yang berubah - hanya jadi terlihat.
//
// bleNusRingHigh (tinggi air isi ring) yang paling berguna: kalau ini
// menyentuh atau mendekati BLE_NUS_RING_SIZE, penyebabnya sudah pasti BUKAN
// radio, melainkan device terlalu lambat membaca atau app mengirim terlalu
// cepat. Nilai kecil sementara notify gagal berulang = masalah radio/host.
//
// PENTING: deklarasi ini HARUS sebelum bleNusPush() - inline function di
// header ini diproses saat didefinisikan, bukan saat dipanggil.
volatile uint32_t bleNusPushDropped = 0;   // byte yang TIDAK masuk ring (penuh)
volatile uint16_t bleNusRingHigh    = 0;   // tinggi air isi ring, dalam byte
volatile uint32_t bleNusNotifyOk    = 0;   // chunk notify berhasil
volatile uint32_t bleNusNotifyFail  = 0;   // chunk notify gagal setelah semua retry
volatile uint32_t bleNusNotifyChunk = 0;   // total chunk notify yang dicoba
volatile uint32_t bleNusNotifyRetry = 0;   // total percobaan ulang (backoff)

// Dua kasus yang tadinya return 0 TANPA JEJAK. Keduanya terlihat dari sisi app
// persis sama - "connect berhasil tapi device diam" - padahal penyebabnya
// berbeda dan perbaikannya juga berbeda:
//   writeNoConn: link belum naik / device sudah tidur
//   writeNoSub : GATT nyambung, tapi companion app belum subscribe notify
// Yang kedua adalah penyebab paling sering dari "app connect tapi tidak ada
// apa-apa", jadi harus bisa dibedakan tanpa menebak.
volatile uint32_t bleNusWriteNoConn = 0;
volatile uint32_t bleNusWriteNoSub  = 0;

inline void bleNusPush(const uint8_t* data, size_t len) {
  uint16_t dropped = 0;
  portENTER_CRITICAL(&bleNusMux);
  for (size_t i = 0; i < len; i++) {
    uint16_t next = (uint16_t)((bleNusHead + 1) % BLE_NUS_RING_SIZE);
    // Penting: drop TETAP terjadi (mengubahnya jadi blocking akan menahan
    // task host NimBLE dan mematikan BLE), tapi sekarang DIHITUNG.
    //
    // Nilai byte yang hilang disimpan, bukan cuma flag - supaya DIAG bisa
    // melaporkan "n byte hilang", yang langsung membedakan "sedikit" dari
    // "ring buffer penuh terus-menerus".
    if (next == bleNusTail) { dropped++; continue; }
    bleNusRing[bleNusHead] = data[i];
    bleNusHead = next;
  }
  const uint16_t used =
      (uint16_t)((bleNusHead - bleNusTail + BLE_NUS_RING_SIZE) % BLE_NUS_RING_SIZE);
  portEXIT_CRITICAL(&bleNusMux);

  // Di luar critical section: counter ini dibaca dari loop Arduino, bukan
  // dari dalam mux.
  if (dropped) bleNusPushDropped += dropped;
  if (used > bleNusRingHigh) bleNusRingHigh = used;
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

// Snapshot perintah terakhir yang masuk, untuk log diagnostik. Harus ada: log
// "NUS RX" di ble_hid.h memakainya, dan tanpa definisi ini kompilasi gagal
// dengan "incomplete type 'char []'".
volatile uint16_t bleNusSubCount   = 0;
volatile uint32_t bleNusWriteCount = 0;
char bleNusLastWrite[64] = {0};

// ---- NUS characteristic pointers ----
NimBLECharacteristic* bleNusTx = nullptr;
NimBLECharacteristic* bleNusRx = nullptr;
