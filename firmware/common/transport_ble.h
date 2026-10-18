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
  size_t write(const uint8_t* data, size_t len) override {
    if (!isConnected()) { naikkan(bleNusWriteNoConn); return 0; }
    if (bleNusSubCount == 0) { naikkan(bleNusWriteNoSub); return 0; }  // tanpa subscriber notify diabaikan

    uint16_t h = bleHidConnHandle;
    if (h == BLE_HID_NO_HANDLE) return 0;

    const uint16_t chunkMax = bleNusChunkLimit();

    size_t sent = 0;
    while (sent < len) {
      size_t n = len - sent;
      if (n > chunkMax) n = chunkMax;

      // Retry notify dengan backoff eksponensial.
      //
      // Batas keras waktu yang boleh diSpend di sini, bukan jumlah percobaan.
      // Setiap percobaan gagal memakai delay() BLOKKING, dan ini dipanggil dari
      // loop() - jadi selama backoff berjalan, loop() buta: matriks tidak
      // discan, encoder tidak dibaca, dan perintah inbound tidak diproses.
      //
      // Versi lama memakai 5 percobaan dengan delay(6 << retry), yaitu
      // 6+12+24+48+96 = 186 ms PER CHUNK. Untuk satu dump yang terpecah jadi
      // banyak chunk, totalnya bisa detik - dan itu salah satu alasan device
      // sering hilang tepat saat companion app sedang mengirim data paling
      // banyak (ganti preset).
      //
      // Jadi sekarang: paling banyak 3 percobaan, jeda pendek. Notify yang
      // gagal dicatat lewat bleNusNotifyFail / bleNusNotifyRetry dan dilaporkan
      // di DIAGMEDIA, jadi angka yang dipangkas bukan informasi yang hilang -
      // dan sisa payload tetap dikembalikan ke caller lewat nilai balik,
      // bukan di-drop diam-diam.
      const uint8_t BLE_NOTIFY_MAX_RETRY = 3;
      uint8_t retries = 0;
      bool sentOk = false;
      naikkan(bleNusNotifyChunk);
      while (retries < BLE_NOTIFY_MAX_RETRY) {
        if (bleNusRx->notify(data + sent, n, h)) {
          sentOk = true;
          break;
        }
        // Gagal: delay backoff pendek (1, 2, 4 ms).
        naikkan(bleNusNotifyRetry);
        delay(1 << retries);
        retries++;
        h = bleHidConnHandle;
        // Peer hilang = tidak akan pernah berhasil. Retry lagi hanya menambah
        // loop() buta tanpa peluang sukses.
        if (h == BLE_HID_NO_HANDLE) break;
      }

      if (!sentOk) {
        // Semua retry gagal: catat log, return byte yg sudah terkirim.
        // PENTING: JANGAN break diam-diam - sisa data (incl DUMP_END) tidak akan terkirim
        // tapi setidaknya caller tahu ada masalah lewat return value < len.
        naikkan(bleNusNotifyFail);
        LOGS->printf("[BLE] notify gagal total setelah %ux retry, %u byte tertinggal\n",
                     (unsigned)BLE_NOTIFY_MAX_RETRY, (unsigned)(len - sent));
        return sent;  // return byte yang sukses, caller bisa cek return < len
      }

      naikkan(bleNusNotifyOk);
      sent += n;
    }
    return sent;
  }

  void flush() override {}

  TransportType type() const override { return TransportType::TP_BLE; }
};

// Instance global, supaya hid_link.h bisa menunjuk g_transport ke object ini
// tanpa perlu tahu cara instantiate.
BleNusTransport BleNus;
