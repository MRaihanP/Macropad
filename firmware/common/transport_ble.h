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

// Dikirim lewat notify ke 6e400003 (RX characteristic). WAJIB chunking:
// satu baris protokol yang panjang - misalnya jawaban DUMP: untuk 9 tombol
// atau RGB:DUMP - bisa melebihi batas satu notifikasi ATT.
//
// Batas chunk diambil dari bleNusChunkLimit() (MTU hasil negosiasi - 3),
// BUKAN konstanta 244. Kalau Windows menawar MTU < 247, notify dengan
// 244 byte akan gagal diam-diam dan jawaban terpotong.
  // Berapa kali satu chunk notify dicoba ulang sebelum menyerah.
//
// Kenapa perlu: notify BLE gagal secara NORMAL, bukan hanya saat error. Buffer
// peer penuh, connection interval sedang sibuk, atau radio sedang handle
// operasi lain - semuanya kondisi sehari-hari yang hilang sendiri dalam hitungan
// milidetik. Versi lama mencoba tepat DUA kali lalu `break`, membuang sisa
// payload tanpa satu baris log pun.
//
// Akibatnya penutup frame (DUMP_END, ENC_END, NAMES_END) hilang - dan karena
// itu penutup selalu jadi yang hilang, bukan data acak di tengah. Companion app
// lalu menunggu penutup yang tidak akan pernah datang.
#define BLE_NOTIFY_MAX_ATTEMPTS 6

size_t write(const uint8_t* data, size_t len) override {
    if (!isConnected()) return 0;
    if (bleNusSubCount == 0) return 0;   // tanpa subscriber notify diabaikan

    const uint16_t chunkMax = bleNusChunkLimit();

    size_t sent = 0;
    uint16_t lostChunks = 0;
    uint16_t retriesUsed = 0;

    while (sent < len) {
      size_t n = len - sent;
      if (n > chunkMax) n = chunkMax;

      bool delivered = false;
      for (uint8_t attempt = 0; attempt < BLE_NOTIFY_MAX_ATTEMPTS; attempt++) {
        // Handle dibaca ULANG tiap percobaan: peer bisa putus di tengah retry.
        uint16_t h = bleHidConnHandle;
        if (h == BLE_HID_NO_HANDLE) break;   // peer putus, retry tidak ada artinya
        if (bleNusRx->notify(data + sent, n, h)) { delivered = true; break; }
        retriesUsed++;
        // Jeda yang makin lama. Buffer peer yang penuh butuh waktu untuk
        // dikuras oleh stack BT, jadi hammer langsung tidak menolong - hanya
        // memperpanjang kondisi "penuh".
        delay(5 + (uint16_t)attempt * 15);
      }

      if (!delivered) {
        lostChunks++;
        // Peer benar-benar putus: tidak ada gunanya lanjut.
        if (bleHidConnHandle == BLE_HID_NO_HANDLE) break;
        // Masih terhubung tapi chunk ini tidak mau keluar. Putus di sini
        // SEBENARNYA: sisa payload akan sampai tanpa penutupnya, dan companion
        // app akan menunggu penutup yang tidak pernah datang. Putus berarti
        // ia bisa mendeteksi dan pulih.
        LOGS->printf("[BLE] NOTIFY gagal %u x - sisa %u byte dibuang "
                     "(peer masih tersambung, payload jadi tidak lengkap)\n",
                     (unsigned)BLE_NOTIFY_MAX_ATTEMPTS,
                     (unsigned)(len - sent));
        break;
      }
      sent += n;
    }

    // Ringkasan: berapa yang hilang, supaya mudah dilihat di Serial Monitor.
    if (retriesUsed > 0 || lostChunks > 0) {
      LOGS->printf("[BLE] notify selesai: %u/%u byte, retry=%u, gagal=%u\n",
                   (unsigned)sent, (unsigned)len,
                   (unsigned)retriesUsed, (unsigned)lostChunks);
    }
    return sent;
  }

  void flush() override {}

  TransportType type() const override { return TransportType::TP_BLE; }
};

// Instance global, supaya hid_link.h bisa menunjuk g_transport ke object ini
// tanpa perlu tahu cara instantiate.
BleNusTransport BleNus;
