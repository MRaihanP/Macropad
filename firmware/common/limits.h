// Konstanta yang dipakai bersama firmware PROTOTYPE dan FINAL.
// Diekstrak verbatim dari HID_Keypad.ino agar tidak ada konstanta terduplikasi
// di antara kedua sketsh.
//
// #pragma once wajib: berkas ini mendefinisikan variabel (RGB_INDEX) dan tipe
// (ChargeState, RgbState), dan sekarang bisa masuk lewat jalur include berbeda
// (sketsh langsung, lalu hid_link.h) sehingga tanpa guard akan jadi
// "multiple definition".
#pragma once

// =================== HID LINK SELECTION ===================
//
// Ke mana report HID dikirim: USB HID atau BLE HID.
//
//   HID_BLE_SUPPORT  - kemampuan, compile-time. 0 = BLE HID tidak dikompilasi
//                      sama sekali (NimBLE tidak masuk binary).
//   HID_LINK_DEFAULT - mode awal setelah boot. Bisa diubah runtime lewat
//                      perintah Serial IFACE:USB / IFACE:BLE.
//
// CATATAN: `TRANSPORT_TYPE` di bawah TIDAKrelated ke switch ini. Yang itu jalur
// PROTOCOL companion app (USB CDC vs BLE NUS, belum ada). Dua hal berbeda.
#define HID_LINK_USB 0
#define HID_LINK_BLE 1

#ifndef HID_BLE_SUPPORT
#define HID_BLE_SUPPORT 1
#endif

#ifndef HID_LINK_DEFAULT
#define HID_LINK_DEFAULT HID_LINK_USB
#endif

// State runtime: backend HID yang SEDANG aktif. Didefinisikan di hid_link.h.
enum class HidLink : uint8_t { USB = 0, BLE = 1 };

// =================== TRANSPORT SELECTION ===================
// Pilih media komunikasi: USB CDC (Serial) atau BLE.
//
// CATATAN: ini jalur PROTOCOL companion app (USB CDC vs BLE NUS), BUKAN switch
// HID. Switch HID ada di blok "HID LINK SELECTION" di atas. Dua sumbu terpisah
// supaya keputusan companion app tidak mengunci keputusan HID.
//
// CATATAN NAMA (revisi 2026-10-09): nama enum di transport.h sengaja memakai
// awalan TP_ (TP_USB / TP_BLE), BUKAN TRANSPORT_USB / TRANSPORT_BLE.
//
// Alasannya: makro di bawah adalah #define biasa yang substituted di SELURUH
// token berikutnya, termasuk di dalam definisi enum. Dengan nama yang sama,
// baris
//     #define TRANSPORT_USB 0
//     enum class TransportType { TRANSPORT_USB = 0, ... }
// akan membuat preprocessor mengubah enumerator jadi angka:
//
//     enum class TransportType { 0 = 0, 1 = 1, ... }
//     error: expected identifier before numeric constant
//
// Jadi makro dan enumerator HARUS punya nama berbeda. Makro tetap
// TRANSPORT_USB/TRANSPORT_BLE (dipakai #if di Firmware); enumerator jadi
// TP_USB/TP_BLE.
#define TRANSPORT_USB  0
#define TRANSPORT_BLE  1

// Default ke USB untuk kompatibilitas mundur. Ganti di sini (atau di
// board_config.h profil) saat BLE siap dipakai.
#ifndef TRANSPORT_TYPE
#define TRANSPORT_TYPE TRANSPORT_USB
#endif

// =================== HOOK PERIL (opsional) ===================
// Dua titik ekstensi kecil supaya tiap sketsh bisa menambah-own kode
// tanpa mengubah core. Default-nya kosong (tidak ada biaya runtime),
// jadi profil yang tidak memakai BLE HID tidak ikut berubah.
//
//   PROFILE_HOOK_SETUP()  -> dipanggil di akhir setup() core
//   PROFILE_HOOK_LOOP()   -> dipanggil di akhir loop() core
//   PROFILE_TRY_COMMAND(cmd)-> dipanggil core sebagai baris terakhir
//                              handleSerialCommand(), sebelum "[ERROR]
//                              Command tidak dikenal". Reply true kalau
//                              command sudah ditangani profil.
//
// Definisi ulang harus dipasang SEBELUM #include "../common/macropad_core.h".
#ifndef PROFILE_HOOK_SETUP
#define PROFILE_HOOK_SETUP() do {} while (0)
#endif
#ifndef PROFILE_HOOK_LOOP
#define PROFILE_HOOK_LOOP() do {} while (0)
#endif
#ifndef PROFILE_TRY_COMMAND
#define PROFILE_TRY_COMMAND(cmd) (false)
#endif

// =================== KONFIGURASI DASAR ===================
#define ROWS 3
#define COLS 3
#define MAX_LAYERS 8       // hard cap PER preset (Default maupun App, masing-masing instance sendiri)
#define MACRO_MAX_LEN 48
#define NAME_LEN 16
#define CONFIG_VERSION 5   // TIDAK berubah — struct MacroConfig sendiri tidak berubah ukuran
#define WIN_SEARCH_OPEN_DELAY_MS 450
#define WIN_SEARCH_TYPE_DELAY_MS 450
#define ENC_PRIMARY 0   // index knob yang pegang gesture dasar (long-press ganti layer, escape)

// Jumlah slot RGB. Ini adalah jumlah key (3x3), bukan jumlah LED fisik,
// sehingga FINAL (strip 9 LED) dan PROTOTYPE (simulasi) memakai angka sama
// dan app bisa menampilkan RGB 1..RGB 9 di kedua board.
#define RGB_COUNT               9
#define RGB32(r,g,b) (((uint32_t)(r) << 16) | ((uint32_t)(g) << 8) | (uint32_t)(b))
#define RGB_IDLE_COLOR   RGB32(0x10, 0x60, 0x5A)
#define RGB_FLASH_COLOR  RGB32(0xFF, 0xFF, 0xFF)
#define RGB_STATUS_COLOR RGB32(0x4E, 0xCD, 0xC4)
// Urutan rantai LED terhadap posisi tombol [row][col] -> index LED (0 = RGB1 ... 8 = RGB9)
const int8_t RGB_INDEX[ROWS][COLS] = {
  {0, 1, 2},   // R0: RGB1, RGB2, RGB3
  {5, 4, 3},   // R1: RGB6, RGB5, RGB4
  {6, 7, 8}    // R2: RGB7, RGB8, RGB9
};
#define APP_SLOTS 6

// Status baterai/charger. Dibaca firmware FINAL dari VBUS (divider) + STAT MCP73831.
// Profil PROTOTYPE memakai nilai simulasi lewat fungsi yang sama, sehingga app
// menerima format pesan identik tanpa perubahan saat hardware FINAL siap.
enum ChargeState : uint8_t {
  CHARGE_NONE = 0,     // charger tidak terpasang / tidak mengecas
  CHARGE_CHARGING,     // sedang mengecas
  CHARGE_COMPLETE      //Cas selesai (VBUS ada, STAT high-Z)
};

// Antarmuka yang harus disediakan setiap profil. Definisi implementasi ada di
// sketsh masing-masing (FINAL: hardware; PROTOTYPE: simulasi).
uint32_t readBatteryMv(uint32_t* pinMvOut);
ChargeState readChargeState();
bool usbHostConnected();   // true bila device tersambung ke PC (VBUS ada)

// ---------------------------------------------------------------------------
// State RGB - dimiliki CORE, bukan backend hardware.
// ---------------------------------------------------------------------------
// Alasannya: RGB:DUMP harus bisa melaporkan state yang sedang aktif apa pun, dan
// firmware PROTOTYPE (tanpa LED) maupun FINAL (strip nyata) harus memakai protocol
// yang persis sama. Backend hardware tiap profil hanya mengimplementasikan tiga
// hook di bawah; selebihnya diurus di core.
struct RgbState {
  bool    enabled;
  uint8_t mode;      // 0..8, lihat tabel mode di companion app
  uint8_t random;    // 1 = warna acak tiap siklus
  uint8_t speed;     // 0..255
  uint8_t bri;       // 0..255
  uint8_t color[3];  // warna global untuk mode non per-key
  uint8_t keys[ROWS][COLS][3];  // warna per tombol (mode 1)
  bool    dirty;     // ada perubahan yang belum disimpan ke flash
};

extern RgbState rgbState;

// Hook yang WAJIB diimplementasikan oleh setiap sketsh profil (setelah #include core).
void rgbApplyState();   // pushes state di atas ke hardware LED
bool rgbPersist();      // simpan ke flash; false bila gagal
void rgbRestore();      // muat dari flash saat boot

// Konversi tegangan baterai ke persen memakai kurva LiPo kasar.
uint8_t battPercentFromMv(uint32_t mv);

