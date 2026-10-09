// =================== USB CDC TRANSPORT ===================
//
// Implementasi Transport untuk USB CDC (Serial).
// Dipakai oleh PROTOTYPE dan FINAL saat TRANSPORT_USB dipilih.

#pragma once

#include "transport.h"

class UsbTransport : public TransportBase {
public:
  bool begin() override {
    Serial.setRxBufferSize(4096);
    Serial.begin(115200);
    delay(300);
    return true;
  }

  bool isConnected() override {
    // USB CDC: bagaimana cara tahu host membuka port?
    //
    // DULU: `Serial.dtr()`. itu tidak bisa dipakai. Pada core ESP32 3.3.x,
    // kelas USBCDC mendefinisikan `bool dtr;` sebagai member PROTECTED -
    // bukan fungsi. Panggilannya jadi dua error sekaligus:
    //   error: 'bool USBCDC::dtr' is protected within this context
    //   error: expression cannot be used as a function
    //
    // Yang dipakai sekarang: `operator bool()` yang memang disediakan core
    // untuk USBCDC/HWCDC dan menyatakan "ada host yang membuka port".
    // Ditambah cek buffer RX: mungkin ada host yang sudah membuka port tapi
    // belum mengirim apa pun (mis. companion app baru dijalankan).
    if (Serial) return true;
    return Serial.available() > 0;
  }

  int available() override { return Serial.available(); }

  int read() override { return Serial.read(); }

  size_t write(const uint8_t* data, size_t len) override {
    return Serial.write(data, len);
  }

  void flush() override { Serial.flush(); }

  TransportType type() const override { return TransportType::TP_USB; }
};

// Global instance untuk transport USB.
extern UsbTransport g_usbTransport;

#define TRANSPORT_INSTANCE g_usbTransport
