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
  // ---- Antrean TX non-blocking ----
  //
  // Kenapa tidak ada delay() di sini:
  //
  // notify() yang gagal TIDAK selalu berarti link radio rusak. Notify gagal
  // juga saat buffer host penuh atau notify dipanggil terlalu cepat - dan
  // itu的后果 yang paling berbahaya adalah notify berikutnya jadi lebih
  // lambat lagi.
  //
  // Versi lama memakai delay(6 * (1 << retries)) = 6/12/24/48/96 ms per chunk,
  // total 186 ms. Handshake ±1300 byte ≈ 6 chunk, jadi loop Arduino bisa
  // tertahan lebih dari satu detik. Selama loop tertahan, firmware tidak
  // sempat merespons koneksi radio, dan link lolos supervision timeout.
  //
  // Gejalanya persis yang tercatat di Serial Monitor:
  //     [BLE] Putus (reason=0x208)
  // 0x208 = BLE_HS_ERR_HCI_BASE (0x200) + 0x08, dan 0x08 adalah HCI
  // "Connection Timeout" -Artinya link supervision timeout kadaluarsa karena
  // kedua sisi berhenti hears satu sama lain.
  //
  // Jadiakibatnya: notify gagal -> delay() panjang -> link makin lama diam ->
  // notify berikutnya makin lambat -> gagal lagi. Lingkaran yang making
  // reconnect butuh banyak percobaan.
  //
  // Perbaikannya: JANGAN pernah menahan loop di sini. Data yang gagal dikirim
  // disimpan, lalu dicoba lagi di siklus loop BERIKUTNYA. Loop Arduino tetap
  // responsif, jadi radio tetap hears Windows.

  static constexpr size_t TX_PENDING_MAX = 4096;
  uint8_t txPending_[TX_PENDING_MAX];
  size_t  txPendingLen_ = 0;

  // Dipanggil dari loop() SETIAP iterasi. Mengirim sebanyak mungkin tanpa
  // memblokir, lalu kembali seketika.
  void servicePending() override {
    if (txPendingLen_ == 0) return;
    if (!isConnected() || bleNusSubCount == 0 || bleHidConnHandle == BLE_HID_NO_HANDLE) {
      // Peer hilang. Buang - tidak ada yang bisa menerima, dan membawanya ke
      // koneksi berikutnya akan mengutus jawaban basi ke app yang baru.
      txPendingLen_ = 0;
      return;
    }

    const uint16_t chunkMax = bleNusChunkLimit();
    // Satu chunk per panggilan supaya loop tetap cepet. Sisanya dicoba
    // pada iterasi loop berikutnya.
    size_t n = txPendingLen_;
    if (n > chunkMax) n = chunkMax;

    if (!bleNusRx->notify(txPending_, n, bleHidConnHandle)) {
      // Gagal lagi. Sengaja TANPA delay dan TANPA retry langsung - balik ke
      // loop supaya scan matrix, encoder, dan radio tetap jalan.
      return;
    }

    txPendingLen_ -= n;
    if (txPendingLen_ > 0) {
      memmove(txPending_, txPending_ + n, txPendingLen_);
    }
  }

  size_t queuePending(const uint8_t* data, size_t len) {
    if (txPendingLen_ + len > TX_PENDING_MAX) {
      // Antrean penuh: link sudah bermasalah jauh sebelum titik ini.
      return 0;
    }
    memcpy(txPending_ + txPendingLen_, data, len);
    txPendingLen_ += len;
    return len;
  }

  size_t write(const uint8_t* data, size_t len) override {
    if (!isConnected()) return 0;
    if (bleNusSubCount == 0) return 0;   // tanpa subscriber notify diabaikan
    if (bleHidConnHandle == BLE_HID_NO_HANDLE) return 0;

    if (queuePending(data, len) != len) {
      // Dicatat, bukan dibuang diam-diam - supaya ini kelihatan di Serial
      // Monitor kalau link sudah tidak sehat sejak sebelumnya.
      LOGS->printf("[BLE] antrean TX penuh, %u byte dibuang\n", (unsigned)len);
      return 0;
    }
    servicePending();
    return len;
  }

  void flush() override {}

  TransportType type() const override { return TransportType::TP_BLE; }
};

// Instance global, supaya hid_link.h bisa menunjuk g_transport ke object ini
// tanpa perlu tahu cara instantiate.
BleNusTransport BleNus;
