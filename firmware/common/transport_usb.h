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
    // CATATAN: jeda CDC yang dulu ada di sini (delay(300)) dipindah ke
    // setup(), SESUDAH USB.begin().
    //
    // Urutan di file ini: begin() dipanggil SERIAL->begin() lebih dulu, dan
    // USB.begin() baru jalan setelahnya. Jadi jeda di dalam begin() hanya
    // menunggu sesuatu yang belum dimulai - USB stack-nya sendiri belum
    // diinisialisasi. Akibatnya banner boot dicetak ke port yang belum
    // benar-benar siap, dan baris pertama hilang atau terpotong.
    return true;
  }

  bool isConnected() override {
    // USB CDC: (bool)Serial returns connection state on both HWCDC and USBCDC.
    // On ESP32 core 3.x, Serial maps to USBSerial (USBCDC) when
    // ARDUINO_USB_CDC_ON_BOOT is set. operator bool() checks DTR line.
    //
    // JANGAN "memperbaiki" ini jadi Serial.dtr(): pada core ESP32 3.3.11 dtr()
    // adalah member PROTECTED di USBCDC/HWCDC, jadi memanggilnya = compile error.
    // Yang publik dan setara adalah operator bool() di atas - inilah alasannya
    // checked oleh firmware-compile-guard-test.
    //
    // OR available() > 0: port yang sudah dilepas host masih bisa menyisakan byte
    // terakhir di buffer RX. Tanpa ini, byte itu dibaca lalu device dilaporkan
    // putus walau app masih menunggu jawaban.
    return (bool)Serial || Serial.available() > 0;
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
