// Konstanta yang dipakai bersama firmware PROTOTYPE dan FINAL.
// Diekstrak verbatim dari HID_Keypad.ino agar tidak ada konstanta terduplikasi
// di antara kedua sketsh.

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

