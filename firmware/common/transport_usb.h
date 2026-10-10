// =================== USB CDC TRANSPORT ===================
//
// Implementasi Transport untuk USB CDC (Serial).
// Dipakai oleh PROTOTYPE dan FINAL saat TRANSPORT_USB dipilih.

#pragma once

#include "transport.h"


// Batas tunggu port CDC dibuka host. Setelah lewat, boot tetap jalan walau
// Serial Monitor tidak dibuka sama sekali - lebih baik log boot kehilangan
// beberapa baris daripada perangkat menggantung.
#define USB_CDC_CONNECT_WAIT_MS 1500

// true kalau port CDC sudah terbuka host saat boot selesai. Dicetak di baris
// banner supaya bisa dipastikan log boot tidak hilang gara-gara enumerate.
static bool usbCdcReadyAtBoot = false;

class UsbTransport : public TransportBase {
public:
  bool begin() override {
    Serial.setRxBufferSize(4096);
    Serial.begin(115200);

    // Tunggu host benar-benar membuka port CDC SEBELUM ada cetakan apa pun.
    //
    // Core ESP32 sudah memanggil Serial.begin() + USB.begin() sendiri di
    // appMain() sebelum setup() jalan, tapi enumerasi USB itu ASINKRON: device
    // baru terdaftar di host beberapa saat setelah USB.begin() selesai. Semua
    // yang dicetak sebelum itu hilang - itulah sebabnya baris "[BLE] adv ok"
    // dan "[IFACE] link awal" kadang tidak pernah terlihat.
    //
    // operator bool() USBCDC mengembalikan flag connected (DTR),
    // yaitu "port sudah dibuka terminal".
    unsigned long t0 = millis();
    while (!isConnected() && (long)(millis() - t0) < USB_CDC_CONNECT_WAIT_MS) {
      delay(10);
    }
    usbCdcReadyAtBoot = isConnected();
    return true;
  }

  bool isConnected() override {
    // USB CDC: (bool)Serial returns connection state on both HWCDC and USBCDC.
    // On ESP32 core 3.x, Serial maps to USBSerial (USBCDC) when
    // ARDUINO_USB_CDC_ON_BOOT is set. operator bool() checks DTR line.
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
