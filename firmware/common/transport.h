// =================== TRANSPORT ABSTRACTION ===================
//
// Memisahkan logika protokol (handleSerialCommand, event output, dll)
// dari medium komunikasi (USB CDC vs BLE).
//
// Setiap profil (PROTOTYPE/FINAL) memilih transport lewat TRANSPORT_USB
// atau TRANSPORT_BLE di limits.h / board_config.h.

#pragma once

#include <Arduino.h>

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

  // Flush buffer output (kalau ada buffering).
  virtual void flush() = 0;

  // Printf-style output untuk event/log ke host.
  // Implementasi default di base class memakai write().
  virtual void printf(const char* format, ...) = 0;

  // Print line with optional format (newline appended by default).
  // Provides Arduino Print::println compatibility for code that uses
  // SERIAL->println("...") throughout macropad_core.h.
  virtual void println(const char* str) = 0;

  // Get transport type.
  virtual TransportType type() const = 0;
};

// Base class dengan implementasi default printf -> write.
class TransportBase : public Transport {
public:
  void printf(const char* format, ...) override {
    char buffer[256];
    va_list args;
    va_start(args, format);
    int len = vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);

    // vsnprintf mengembalikan JUMLAH byte yang AKAN ditulis, bukan yang ditulis.
    // Kalau format menghasilkan 300 byte, isinya dipotong ke 255 + NUL tapi
    // len = 300. write(buffer, 300) lalu membaca 45 byte DI LUAR buffer -
    // isi stack yang tidak gehört, termasuk byte acak yang bisa berisi
    // newline palsu dan membuat baris companion app terbelah di tempat
    // yang salah.
    //
    // Dibatasi ke sizeof(buffer) - 1, sama persis dengan yang benar-benar ada
    // di buffer. Memotong lebih dari itu berarti menghapus isi, yang jauh lebih
    // mudah dilihat daripada menabrak stack.
    if (len > 0) {
      size_t n = (size_t)len;
      if (n >= sizeof(buffer)) {
        n = sizeof(buffer) - 1;
        buffer[n - 1] = '\n';   // baris terpotong tetap berakhir newline
      }
      write((const uint8_t*)buffer, n);
    }
  }

  // Default println: tulis string DAN newline dalam SATU write.
  //
  // Sebelumnya dua write terpisah (string, lalu "\n"). Di serial tidak
  // masalah. lewat BLE tidak: notify adalah fungsi yang bisa gagal (peer
  // belum siap, buffer penuh, link terputus sebentar). Kalau write newline
  // yang gagal, baris jadi tidak pernah diakhiri newline - dan parser
  // companion app yang hanya memproses baris setelah '\n'received akan
  // menunggunya SELAMANYA.
  //
  // Dampak yang diam-diam dan fatal: DUMP_END hilang newline-nya -> flag
  // dumpInProgress tidak pernah turun -> semua baris sesudahnya (HWINFO,
  // BATT, EVT:*) dianggap "isi dump" dan ditolak. Gejalanya: app connect
  // tapi tidak pernah menampilkan apa-apa, tanpa error lain.
  void println(const char* str) override {
    // BUKAN const: nilai ini dipotong di bawah kalau baris terlalu panjang,
    // jadi harus bisa di-assign ulang.
    size_t len = strlen(str);
    // Buffer stack supaya tidak perlu alokasi heap per baris.
    char line[257];
    if (len > sizeof(line) - 2) len = sizeof(line) - 2;
    memcpy(line, str, len);
    line[len] = '\n';
    write((const uint8_t*)line, len + 1);
  }
};

// Global transport instance - dipakai di seluruh core (handleSerialCommand, events, dll).
extern Transport* g_transport;

// =================== RESET PROTOKOL SAAT LINK BERUBAH ===================
//
// Minta lapisan protokol (mode frame + baris teks) dinormalkan kembali.
//
// KENAPA INI ADA
//
// State mode ini milik SESI, bukan milik device. `faMode` di
// frame_proto.h dan `serialLineLen` di macropad_core.h keduanya `static`, dan
// tanpa perintah eksplisit keduanya bertahan melewati disconnect. Akibatnya
// device yang terputus DI TENGAH fast-path frame akan kembali dalam keadaan:
//
//   faMode      = true    -> semua perintah teks (CONTEXT:DEFAULT, INFO, DUMP)
//                             dibuang di frame_asm.h sebelum sampai parser
//   serialLineLen > 0    -> faRoute() tidak lagi mengenali byte 0xA5, jadi
//                             device tidak bisa masuk mode frame lagi sama sekali
//
// Keduanya persis gejala "preset tidak pernah berganti setelah reconnect".
//
// JANGAN dipanggil langsung dari callback NimBLE. Callback itu berjalan di task
// host BLE, sedangkan `faSt` dan `serialLine` dibaca/diubah task loop Arduino -
// memanggil reset dari sana adalah race. Yang dilakukan di sini hanya MENANDAI
// permintaan; Penyusunannya dilakukan di checkSerialInput() yang sudah ada.
extern volatile bool protoLinkResetPending;

// Definisi, bukan extern. transport.h di-include oleh semua backend dan oleh
// macropad_core.h, jadi tepat satu salinan untuk seluruh translation unit.
volatile bool protoLinkResetPending = false;

inline void protoLinkResetRequest() { protoLinkResetPending = true; }

#ifndef PROTO_LINK_RESET
#define PROTO_LINK_RESET()  protoLinkResetRequest()
#endif

// Buang sisa byte inbound yang masih tertinggal di link lama. Kosong di
// profil tanpa BLE; transport_ble.h yang meng-override dengan bleNusClear().
#ifndef PROTO_LINK_DRAIN_RX
#define PROTO_LINK_DRAIN_RX()  do {} while (0)
#endif

// Transport untuk LOG DIAGNOSTIK. SELALU USB CDC, apa pun mode protokol.
//
// Kenapa harus dipisah dari SERIAL:
//
// Begitu NUS menjadi jalur protokol (g_transport = BleNus), setiap baris log
// yang ditulis SERIAL-> akan ikut terkirim ke companion app di stream protokol.
// Parser app punya aturan ketat (mis. ^\[KEY\] (\d+),(\d+),(\d+),(\d+),(.*)$),
// dan `[BLE] Connect (handle=1)` di tengah jawaban DUMP akan menggabungkan
// diri dengan baris protokol - jawaban jadi tidak terbaca dan state app
// menyimpang tanpa error yang jelas.
//
// Sebaliknya, log harus tetap bisa dibaca lewat Serial Monitor pada mode mana
// pun - itulah satu-satunya cara melihat apa yang terjadi tanpa companion app.
//
// Helper makro: ganti semua Serial.xxx jadi g_transport->xxx
// Contoh: Serial.printf(...)  ->  g_transport->printf(...)
//         Serial.write(...)   ->  g_transport->write(...)
//         Serial.available()  ->  g_transport->available()
//         Serial.read()       ->  g_transport->read()
// Catatan: core ESP32 mendefinisikan SERIAL sebagai 0x0 di Arduino.h.
// Karena kita memakai SERIAL sebagai nama objek transport, definisi lama
// harus dibuang dulu agar tidak memicu warning "SERIAL redefined".
#ifdef SERIAL
#undef SERIAL
#endif
#define SERIAL g_transport

// Hanya untuk pesan diagnostik - JANGAN dipakai di macropad_core.h.
// Aturannya: kalau baris itu dapat dibaca companion app, pakai SERIAL.
// Kalau hanya untuk manusia lewat Serial Monitor, pakai LOGS.
extern Transport* g_logTransport;
#define LOGS g_logTransport

// Macro debug: hanya aktif bila DEBUG_COMPILE didefinisikan.
// Semua trace [BLE], [FRAME], [IFACE] akan dibungkus dengan ini
// supaya production build tidak mengirim notifikasi debug yang berlebihan.
#ifdef DEBUG_COMPILE
  #define DBG(fmt, ...) do { LOGS->printf(fmt, ##__VA_ARGS__); } while (0)
#else
  #define DBG(fmt, ...) do {} while (0)
#endif