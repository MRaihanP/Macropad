// =================== TRANSPORT ABSTRACTION ===================
//
// Memisahkan logika protokol (handleSerialCommand, event output, dll)
// dari medium komunikasi (USB CDC vs BLE).
//
// Setiap profil (PROTOTYPE/FINAL) memilih transport lewat TRANSPORT_USB
// atau TRANSPORT_BLE di limits.h / board_config.h.

#pragma once

#include <Arduino.h>

// Nama enumerator memakai awalan TP_ (TP_USB / TP_BLE), BUKAN TRANSPORT_USB /
// TRANSPORT_BLE. Alasannya ada di limits.h: makro #define dengan nama yang
// sama akan disubstitusikan ke dalam daftar enumerator di bawah, mengubahnya
// jadi "0 = 0" yang tidak bisa dikompilasi. Makro dan enumerator wajib
// berbeda nama.
enum class TransportType : uint8_t {
  TP_USB = 0,    // USB CDC (Serial)
  TP_BLE = 1,    // BLE GATT
};

// Interface transport - semua implementasi WAJIB menyediakan ini.
class Transport {
public:
  virtual ~Transport() = default;

  // Inisialisasi transport. Dipanggil di setup() sebelum begin().
  // Return true kalau sukses.
  virtual bool begin() = 0;

  // Cek apakah transport tersambung ke host.
  // USB: Serial.dtr() atau CDC connected
  // BLE: device connected via GATT
  virtual bool isConnected() = 0;

  // Cek apakah ada data tersedia untuk dibaca.
  virtual int available() = 0;

  // Baca 1 byte (non-blocking). Return -1 kalau tidak ada data.
  virtual int read() = 0;

  // Tulis bytes ke host (non-blocking jika memungkinkan).
  // Return jumlah byte yang tertulis.
  virtual size_t write(const uint8_t* data, size_t len) = 0;

  // Tulis string mentah (tanpa newline).
  virtual void print(const char* s) = 0;

  // Tulis string diikuti newline.
  virtual void println(const char* s) = 0;

  // Flush buffer output (kalau ada buffering).
  virtual void flush() = 0;

  // Printf-style output untuk event/log ke host.
  // Implementasi default di base class memakai write().
  virtual void printf(const char* format, ...) = 0;

  // Get transport type.
  virtual TransportType type() const = 0;
};

// Base class dengan implementasi default print/println/printf -> write.
class TransportBase : public Transport {
public:
  void print(const char* s) override {
    write((const uint8_t*)s, strlen(s));
  }

  void println(const char* s) override {
    print(s);
    write((const uint8_t*)"\n", 1);
  }

  void printf(const char* format, ...) override {
    char buffer[256];
    va_list args;
    va_start(args, format);
    int len = vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    if (len > 0) {
      write((const uint8_t*)buffer, len);
    }
  }
};

// Global transport instance - dipakai di seluruh core (handleSerialCommand, events, dll).
extern Transport* g_transport;

// Helper makro: semua SERIAL->xxx di core berarti g_transport->xxx.
//
// #undef SERIAL WAJIB ada sebelum #define. Core ESP32 mendefinisikan
// `#define SERIAL 0x0` (indeks port HardwareSerial) di Arduino.h, dan
// menimpanya tanpa #undef menghasilkan warning:
//
//   warning: "SERIAL" redefined
//
// Yang ditimpa hanya MAKRO uppercase; objek `Serial` (lowercase) milik core
// tetap utuh dan tetap dipakai langsung di transport_usb.h.
#ifdef SERIAL
#undef SERIAL
#endif
#define SERIAL g_transport
