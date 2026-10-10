// =================== BLE PROTOCOL TRANSPORT (NUS) ===================
//
// Transport kedua untuk protokol companion app (EVT:, [KEY], jawaban perintah
// PING/WHOAMI/INFO/SET/DUMP/...). Berada di BLE HID yang sudah ada lewat SERVER
// DAN KONEKSI YANG SAMA - tidak ada pairing tambahan, tidak ada link kedua.
//
// UUID sama persis dengan companion app (src-tauri/src/ble.rs):
//   Service  6e400001-b5a3-f393-e0a9-e50e24dcca9e
//   TX (write dari app)  6e400002-...   -> firmware terima
//   RX (notify ke app)  6e400003-...   -> firmware kirim
//
// FASE 4 (saat ini): hanya arah app -> firmware. Arah firmware -> app
// (notify) menyusul di fase 5, jadi write() sengaja belum diimplementasi.
//
// kenapa ring buffer + portMUX: onWrite() dipanggil dari task host NimBLE
// sedangkan available()/read() dipanggil dari loop Arduino - dua task yang
// berbeda, jadi butuh sinkronisasi.
//
// kenapa ada batas 244 byte (MTU 247 - 3): satu baris protokol yang panjang -
// misalnya jawaban DUMP: untuk 9 tombol - bisa melewati batas satu notifikasi
// ATT. Pada fase 5 write() wajib memecah payload menjadi potongan <= 244 byte.

#pragma once

#include <Arduino.h>
#include "transport.h"
#include "limits.h"
#include "ble_shared.h"

// ---- Transport ----
class BleNusTransport : public TransportBase {
public:
  bool begin() override {
    // PENTING: buffer dibersihkan setiap kali mode BLE dinyalakan. Perintah
    // yang terpotong di tengah (mis. app menulis "SET:0:1:1" lalu matikan
    // terputus) akan tinggal di buffer dan terbaca sebagai baris lengkap di
    // sesi berikutnya - perintahsetengah jadi perintah salah.
    bleNusClear();
    return true;
  }

  bool isConnected() override { return bleHidConnHandle != BLE_HID_NO_HANDLE; }

  int available() override { return bleNusAvail(); }

  int read() override {
    uint8_t b;
    return bleNusPop(&b) ? (int)b : -1;
  }

  // Belum diimplementasi - arrive di fase 5 bersama pemecahan chunk 244 byte.
  size_t write(const uint8_t*, size_t) override { return 0; }

  void flush() override {}

  TransportType type() const override { return TransportType::TP_BLE; }
};

// Instance global, supaya hid_link.h bisa menunjuk g_transport ke object ini
// tanpa perlu tahu cara instantiate.
BleNusTransport BleNus;
