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
