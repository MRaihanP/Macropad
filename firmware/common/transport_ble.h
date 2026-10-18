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

// ---- Lapis media untuk DIAG (L4) ----
//
// Sengaja di sini, bukan di diag.h: angka ini hanya ADA kalau NUS dikompilasi.
// Profil FINAL tidak meng-include transport_ble.h sama sekali, jadi ia
// otomatis memakai default kosong dari diag.h dan tidak perlu stub.
//
// Dua kondisi yang WAJIB bisa dibedakan tanpa menebak:
//   notifyFail naik, ringHigh kecil  -> masalah radio/host (notify ditolak)
//   ringHigh mendekati 2048, drop naik -> device tidak sempat membaca, antrean
//                                        perintah menumpuk di dalam device
// Keduanya pernah Produce gejala yang sama di app: "connect tapi diam".
static void protoDiagMedia() {
  SERIAL->printf("DIAGMEDIA:notifyOk=%lu,notifyFail=%lu,notifyChunks=%lu,"
                 "notifyRetries=%lu,ringDropped=%lu,ringHigh=%u,ringSize=%u,"
                 "mtu=%u,sub=%u,noConn=%lu,noSub=%lu\n",
                 (unsigned long)bleNusNotifyOk,
                 (unsigned long)bleNusNotifyFail,
                 (unsigned long)bleNusNotifyChunk,
                 (unsigned long)bleNusNotifyRetry,
                 (unsigned long)bleNusPushDropped,
                 (unsigned)bleNusRingHigh,
                 (unsigned)BLE_NUS_RING_SIZE,
                 (unsigned)bleNusMtu(),
                 (unsigned)bleNusSubCount,
                 (unsigned long)bleNusWriteNoConn,
                 (unsigned long)bleNusWriteNoSub);
}

static void protoDiagMediaReset() {
  bleNusNotifyOk    = 0;
  bleNusNotifyFail  = 0;
  bleNusNotifyChunk = 0;
  bleNusNotifyRetry = 0;
  bleNusPushDropped = 0;
  bleNusRingHigh    = 0;
  bleNusWriteNoConn = 0;
  bleNusWriteNoSub  = 0;
}

// Hook yang dibaca diag.h. Harus didefinisikan SEBELUM diag.h di-include,
// dan transport_ble.h memang selalu lebih dulu di kedua sketsh.
#define PROTO_DIAG_MEDIA()  protoDiagMedia()
#define PROTO_DIAG_RESET()  protoDiagMediaReset()

// MTU untuk lapisan protokol frame (dibaca frame_proto.h lewat hook ini).
//
// Deklarasi di header ini harus terjadi SEBELUM frame_proto.h di-include,
// dan di kedua sketsh transport_ble.h memang selalu lebih dulu. Kalau tidak,
// profil FINAL akan diam-diam memakai nilai 0 - artinya HELLO melaporkan
// payload maksimum 0 padahal devicenya sebenarnya punya NUS.
#define PROTO_FRAME_MTU()   ((uint32_t)bleNusMtu())

// Buang sisa byte inbound dari link yang sudah tidak berlaku.
//
// Dipanggil dari faResetSession() (frame_proto.h) saat BLE connect/disconnect.
// Hook, karena profil FINAL tidak punya NUS sama sekali dan tidak punya yang
// perlu dikosongkan.
#define PROTO_LINK_DRAIN_RX()  bleNusClear()


// ---- Antrean TX notify (hanya diakses dari task loop Arduino) ----
#define BLE_NUS_TX_RING 4096
static uint8_t  bleNusTxBuf[BLE_NUS_TX_RING];
static uint16_t bleNusTxHead = 0, bleNusTxTail = 0;   // head=tulis, tail=baca

static inline uint16_t bleNusTxUsed() {
  return (uint16_t)((bleNusTxHead - bleNusTxTail + BLE_NUS_TX_RING) % BLE_NUS_TX_RING);
}

static size_t bleNusTxEnqueue(const uint8_t* data, size_t len) {
  if (len == 0) return 0;
  if (len > (size_t)(BLE_NUS_TX_RING - 1 - bleNusTxUsed())) {   // tidak muat -> buang SELURUHNYA
    naikkan(bleNusNotifyFail);
    return 0;
  }
  for (size_t i = 0; i < len; i++) {
    bleNusTxBuf[bleNusTxHead] = data[i];
    bleNusTxHead = (uint16_t)((bleNusTxHead + 1) % BLE_NUS_TX_RING);
  }
  return len;
}

// Kirim paling banyak 3 chunk per panggilan supaya loop() tidak tertahan.
// Chunk yang ditolak TIDAK dibuang: offset tidak maju, dicoba lagi next loop.
static void bleNusTxPump() {
  if (bleNusTxDrop) {                       // sesi berubah: antrean lama tidak berlaku
    bleNusTxDrop = false;
    bleNusTxHead = bleNusTxTail = 0;
    return;
  }
  if (bleNusTxHead == bleNusTxTail) return;
  uint16_t h = bleHidConnHandle;
  if (h == BLE_HID_NO_HANDLE || bleNusSubCount == 0 || bleNusRx == nullptr) {
    bleNusTxHead = bleNusTxTail = 0;        // peer hilang / tidak subscribe
    return;
  }
  const uint16_t chunkMax = bleNusChunkLimit();
  for (uint8_t k = 0; k < 3 && bleNusTxHead != bleNusTxTail; k++) {
    uint16_t n = bleNusTxUsed();
    if (n > chunkMax) n = chunkMax;
    if ((uint16_t)(BLE_NUS_TX_RING - bleNusTxTail) < n) n = (uint16_t)(BLE_NUS_TX_RING - bleNusTxTail);  // jangan lewati ujung ring
    naikkan(bleNusNotifyChunk);
    if (bleNusRx->notify(bleNusTxBuf + bleNusTxTail, n, h)) {
      bleNusTxTail = (uint16_t)((bleNusTxTail + n) % BLE_NUS_TX_RING);
      naikkan(bleNusNotifyOk);
    } else {
      naikkan(bleNusNotifyRetry);           // dicoba lagi di loop berikutnya
      return;
    }
  }
}

// ---- Transport ----
class BleNusTransport : public TransportBase {
public:
  bool begin() override {
    // PENTING: buffer dibersihkan setiap kali mode BLE dinyalakan. Perintah
    // yang terpotong di tengah (mis. app menulis "SET:0:1:1" lalu matikan
    // terputus) akan tinggal di buffer dan terbaca sebagai baris lengkap di
    // sesi berikutnya - perintahsetengah jadi perintah salah.
    bleNusClear();
    bleNusTxHead = bleNusTxTail = 0;
    return true;
  }

  bool isConnected() override { return bleHidConnHandle != BLE_HID_NO_HANDLE; }

  int available() override { return bleNusAvail(); }

  int read() override {
    uint8_t b;
    return bleNusPop(&b) ? (int)b : -1;
  }

// write() HANYA mengantre (satu write = satu baris utuh, atomik). Pengiriman
// sebenarnya dilakukan bleNusTxPump() dari loop(), tanpa delay() blocking.
// Notify yang ditolak (antrean mbuf penuh) dicoba lagi di putaran loop berikutnya
// - setelah satu connection event - bukan setelah 1-4 ms seperti dulu.
// Antrean penuh = SELURUH write dibuang (tidak pernah setengah baris), jadi
// parser app tidak menerima baris yang menempel.
  size_t write(const uint8_t* data, size_t len) override {
    if (!isConnected()) { naikkan(bleNusWriteNoConn); return 0; }
    if (bleNusSubCount == 0) { naikkan(bleNusWriteNoSub); return 0; }
    return bleNusTxEnqueue(data, len);
  }

  void flush() override { bleNusTxPump(); }

  TransportType type() const override { return TransportType::TP_BLE; }
};

// Instance global, supaya hid_link.h bisa menunjuk g_transport ke object ini
// tanpa perlu tahu cara instantiate.
BleNusTransport BleNus;