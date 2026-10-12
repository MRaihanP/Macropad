/*
  ESP32-S3 Macro Pad - Firmware v7 - SKETCH PROTOTYPE
  (nomor resmi ada di FW_VERSION, firmware/common/limits.h - jangan diubah
   di sini; nilai header ini hanya catatan, yang dikirim ke app adalah FW_VERSION)
  ==================================================
  Profile: PROTOTYPE - 1 knob, LED status biasa di GPIO12.
  TIDAK punya: RGB (HAS_RGB=0), voltage divider / baterai (HAS_VDIV=0),
  deteksi VBUS, dan knob kedua (NUM_ENCODERS=1).

  Sketch ini hanya berisi hal yang spesifik profil. Seluruh logika bersama
  (struktur keymap, action, protocol serial, scan matrix, encoder) ada di
  ../common/macropad_core.h

  Pairing: firmware/HID_Keypad_Final/HID_Keypad_Final.ino

  Setting Board (Arduino IDE) - SAMA untuk kedua sketsh:
  Tools > USB Mode        : "USB-OTG (TinyUSB)"
  Tools > USB CDC On Boot : "Enabled"
  Tools > Upload Mode     : "USB-OTG CDC (TinyUSB)"

  HID LINK (USB HID <-> BLE HID):
  Input HID hanya dikirim ke SATU backend pada satu waktu, dipilih lewat
  perintah Serial Monitor (115200):

    IFACE         status link aktif + koneksi BLE
    IFACE:USB     semua jalur BLE dihentikan (peer diputus, advertising mati);
                  tombol hanya menghasilkan input USB HID
    IFACE:BLE     input hanya lewat BLE HID, advertising dinyalakan
    HID:SELF:<k>  kirim 1 report ke backend aktif saja, untuk tes
    BLE:ADV / BLE:BOND:CLEAR / BLE:RAM

  Jejak tiap input diberi tag medium-nya: [IN:USB] atau [IN:BLE].
  Device BLE bernama "MacroPad3x3" (HID over GATT, service 1812).

  PINDAH USB <-> BLE (tombol BOOT):
  TEKAN SATU KALI GPIO0 / tombol BOOT untuk memindahkan seluruh device antara
  USB dan BLE. Tidak perlu Serial Monitor, dan tetap bisa dipakai saat
  companion app sudah tidak bisa bicara.

  -> BLE : LED berkedip (interval 200 ms) selama 1 detik
  -> USB : LED menyala terus selama 1 detik, lalu mati

  Indikatornya sesaat, bukan status yang menetap - supaya tidak menguras
  baterai dan tidak menyesatkan setelah device dicabut. Perintah Serial
  IFACE:* / PROTO:* tetap ada untuk yang mau mengaturnya satu sumbu saja.

  Menghapus bond tanpa Serial: TAHAN tombol [0][0] (kiri atas) saat boot.
*/
#include <Arduino.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"
#include <Preferences.h>

// =================== KONFIGURASI HID LINK ===================
// HID_BLE_SUPPORT  : 1 = firmware punya BLE HID. Set 0 untuk binary ramping
//                    tanpa NimBLE.
// HID_LINK_DEFAULT : backend HID setelah boot. Bisa diubah runtime lewat
//                    perintah Serial "IFACE:USB" / "IFACE:BLE".
//
// Mode hanya memilih ke mana report HID dikirim. USB CDC (Serial Monitor)
// tetap hidup di kedua mode supaya debugging selalu mungkin.
#define HID_BLE_SUPPORT  1
#define HID_LINK_DEFAULT HID_LINK_USB

// ---------------------------------------------------------------------------
// Hook profil -> core (menimpa default kosong yang ada di limits.h)
// ---------------------------------------------------------------------------
// Harus ditulis SEBELUM limits.h karena limits.h memakai #ifndef. Badan
// fungsinya ada di bagian bawah berkas ini, setelah semua pin & HID siap.
void profileSetupHook();
void profileLoopHook();
bool profileTryCommand(const String& cmd);
#define PROFILE_HOOK_SETUP()     profileSetupHook()
#define PROFILE_HOOK_LOOP()      profileLoopHook()
#define PROFILE_TRY_COMMAND(cmd) profileTryCommand(cmd)

#include "../common/limits.h"
#include "../common/transport_usb.h"
#include "../common/transport_ble.h"
#include "../common/hid_link.h"
#include "../common/ble_diag.h"
#include "../common/switch_iface.h"

// Global USB transport instance - definisi (bukan extern).
UsbTransport g_usbTransport;

// BLE NUS transport instance - untuk protokol companion app lewat BLE.
BleNusTransport g_bleNusTransport;

// Binding global transport pointer ke instance USB (default).
//
// g_transport = jalur PROTOKOL (jawaban perintah, event, [KEY], EVT:).
//              Diarahkan ke BLE NUS lewat perintah PROTO:NUS, kembali ke USB
//              lewat PROTO:CDC. Pengalihan dilakukan oleh perintah PROTO:* di
//              ble_diag.h melalui fungsi protoTransportSwitch().
// g_logTransport = jalur LOG. SELALU USB CDC, tidak pernah berubah, supaya
//              Serial Monitor tetap hidup di mode mana pun - itu satu-satunya
//              jalan keluar kalau companion app tidak bisa disambung.
Transport* g_transport    = &g_usbTransport;
Transport* g_logTransport = &g_usbTransport;

// Fungsi untuk mengganti transport protokol runtime.
// Dipanggil dari ble_diag.h saat perintah PROTO:CDC/PROTO:NUS diterima.
void protoTransportSwitch() {
  if (g_protoLink == ProtoLink::NUS) {
    g_transport = &g_bleNusTransport;
  } else {
    g_transport = &g_usbTransport;
  }
  LOGS->printf("[PROTO] Transport beralih ke %s\n", protoLinkName(g_protoLink));
}

// ---------------------------------------------------------------------------
// SWITCH VIA TOMBOL BOOT (GPIO0)
// ---------------------------------------------------------------------------
// Satu tekan memindahkan KEDUA sumbu sekaligus: report tombol (HID_LINK) dan
// protokol companion app (PROTO_LINK). Keduanya ditulis berurutan, tidak lewat
// perintah String, supaya tidak perlu Serial Monitor.
//
// PENTING soal urutan: g_hidLink ditulis LEBIH DAHULU dari g_protoLink.
//
//  - Pindah ke BLE: hidLinkSet(BLE) menyalakan advertising + server GATT, jadi
//    kalau protokol diletakkan ke NUS lebih dulu, app bisa menemukan device
//    sebelum keyboard siap.
//  - Pindah ke USB: hidLinkSet(USB) memutus peer BLE dan mematikan advertising
//    (lihat hid_link.h). Kalau protokol diletakkan lebih dulu, jawaban app akan
//    hilang di NUS yang tidak lagi diiklankan.
void ifaceToggleFromButton() {
#if HID_BLE_SUPPORT
  const bool goBle = (g_hidLink != HidLink::BLE);
  if (goBle) {
    hidLinkSet(HidLink::BLE);
    g_protoLink = ProtoLink::NUS;
  } else {
    hidLinkSet(HidLink::USB);
    g_protoLink = ProtoLink::CDC;
  }
  protoTransportSwitch();
  // Indikator: berkedip = BLE, menyala = USB. SELALU lewat LOGS (USB CDC),
  // yang tidak pernah berubah - kalau lewat SERIAL, pesan ini sendiri akan
  // ikut terkirim ke companion app setelah g_transport dipindah ke NUS dan
  // muncul sebagai baris protocol yang tidak dikenal.
  LOGS->printf("[BOOT] pindah ke %s (hid=%s proto=%s)\n",
               goBle ? "BLE" : "USB", hidLinkName(g_hidLink), protoLinkName(g_protoLink));
  switchLedStart(goBle ? SwitchLedPattern::SW_BLINK : SwitchLedPattern::SW_SOLID);
#else
  // Tanpa BLE, tombol tidak boleh diam-diam tidak berpengaruh. Tetap gerakkan
  // LED supaya pengguna tahu tombolnya hidup, dan beri tahu lewat log.
  LOGS->println("[BOOT] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
  switchLedStart(SwitchLedPattern::SW_SOLID);
#endif
}

// =================== PROFIL: PROTOTYPE ===================
// Firmware ini adalah sumber kebenaran profil PROTOTYPE. Tidak ada lagi
// sakelar HW_PROFILE; pindah profil = buka sketsh yang lain.
#define HW_PROFILE_NAME "PROTOTYPE"
#define NUM_ENCODERS    1
#define HAS_STATUS_LED  1
#define HAS_RGB         0
#define HAS_VDIV        0
#define HAS_VBUS_SENSE  0    // prototipe tidak punya divider VBUS
#define HAS_CHG_STAT    0    // prototipe tidak punya charger MCP73831

// Prototipe tidak punya baterai/RGB/charger sungguhan, jadi angka yang dikirim ke
// companion app adalah simulasi. App membaca flag ini lewat HWINFO untuk menampilkan
// badge "SIMULASI" supaya data palsu tidak tertukar dengan data hardware asli.
#define HW_DATA_SIMULATED 1

// ---- Matrix ----
const uint8_t ROW_PINS[ROWS] = {1, 2, 4};
const uint8_t COL_PINS[COLS] = {5, 6, 7};

// ---- Rotary encoder ----
const uint8_t ENC_BTN_PINS[NUM_ENCODERS] = {8};
const uint8_t ENC_B_PINS[NUM_ENCODERS]   = {9};
const uint8_t ENC_A_PINS[NUM_ENCODERS]   = {10};

// ---- LED status biasa ----
const uint8_t STATUS_LED_PIN = 12;

// Objek HID yang dipakai core. Nama "Keyboard"/"ConsumerControl" tetap sama,
// tapi tipenya facade hid_link.h yang mengarahkan report ke backend aktif
// (USB HID atau BLE HID) sesuai g_hidLink. Core tidak berubah satu baris pun.
HidKeyboard   Keyboard;
HidConsumer   ConsumerControl;

Preferences prefs;
// =================== PERIPHERAL: LED STATUS / RGB / VOLTAGE DIVIDER ===================
#if HAS_RGB
Adafruit_NeoPixel strip(RGB_COUNT, RGB_DATA_PIN, NEO_GRB + NEO_KHZ800);
uint32_t rgbBase[RGB_COUNT];
unsigned long rgbFlashUntil[RGB_COUNT];
bool rgbStatusOn = false;
bool rgbPowered = false;
uint8_t rgbBrightness = RGB_DEFAULT_BRIGHTNESS;

void rgbRender() {
  if (!rgbPowered) return;
  for (uint8_t i = 0; i < RGB_COUNT; i++) {
    uint32_t c = rgbStatusOn ? RGB_STATUS_COLOR : (rgbFlashUntil[i] ? RGB_FLASH_COLOR : rgbBase[i]);
    strip.setPixelColor(i, c);
  }
  strip.show();   // ~300us; interrupt encoder bisa tertunda sebentar saat show()
}

void rgbPower(bool on) {
  digitalWrite(RGB_EN_PIN, (on == (RGB_EN_ACTIVE_HIGH != 0)) ? HIGH : LOW);
  rgbPowered = on;
  if (on) { delay(5); rgbRender(); }
}

void rgbInit() {
  pinMode(RGB_EN_PIN, OUTPUT);
  digitalWrite(RGB_EN_PIN, (RGB_EN_ACTIVE_HIGH != 0) ? LOW : HIGH);   // mulai dalam keadaan mati
  strip.begin();
  strip.setBrightness(rgbBrightness);
  for (uint8_t i = 0; i < RGB_COUNT; i++) { rgbBase[i] = RGB_IDLE_COLOR; rgbFlashUntil[i] = 0; }
  rgbPowered = true;
  digitalWrite(RGB_EN_PIN, (RGB_EN_ACTIVE_HIGH != 0) ? HIGH : LOW);
  delay(10);
  // Sweep sesuai urutan rantai kabel (RGB1..RGB9): sekaligus tes MOSFET & urutan LED
  for (uint8_t i = 0; i < RGB_COUNT; i++) {
    strip.clear();
    strip.setPixelColor(i, RGB_STATUS_COLOR);
    strip.show();
    delay(45);
  }
  rgbRender();
}

void rgbKeyFlash(uint8_t r, uint8_t c) {
  if (!rgbPowered) return;
  int8_t i = RGB_INDEX[r][c];
  if (i < 0 || i >= RGB_COUNT) return;
  rgbFlashUntil[i] = millis() + RGB_FLASH_MS;
  if (rgbFlashUntil[i] == 0) rgbFlashUntil[i] = 1;
  rgbRender();
}

void rgbSetStatus(bool on) { rgbStatusOn = on; rgbRender(); }

void updateRgb() {
  if (!rgbPowered) return;
  unsigned long now = millis();
  bool dirty = false;
  for (uint8_t i = 0; i < RGB_COUNT; i++)
    if (rgbFlashUntil[i] && (long)(now - rgbFlashUntil[i]) >= 0) { rgbFlashUntil[i] = 0; dirty = true; }
  if (dirty) rgbRender();
}
#else
static inline void rgbKeyFlash(uint8_t, uint8_t) {}
static inline void updateRgb() {}
#endif

#if HAS_VDIV
void vdivInit() {
  pinMode(VDIV_EN_PIN, OUTPUT);
  digitalWrite(VDIV_EN_PIN, (VDIV_EN_ACTIVE_HIGH != 0) ? LOW : HIGH);   // divider mati = tidak menguras baterai
  pinMode(VDIV_READ_PIN, INPUT);
  analogSetPinAttenuation(VDIV_READ_PIN, ADC_11db);
}

// Hidupkan divider sebentar, rata-rata 16 sampel, matikan lagi. Mengembalikan mV baterai.
uint32_t readBatteryMv(uint32_t* pinMvOut) {
  digitalWrite(VDIV_EN_PIN, (VDIV_EN_ACTIVE_HIGH != 0) ? HIGH : LOW);
  delay(VDIV_SETTLE_MS);
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 16; i++) { sum += analogReadMilliVolts(VDIV_READ_PIN); delayMicroseconds(200); }
  digitalWrite(VDIV_EN_PIN, (VDIV_EN_ACTIVE_HIGH != 0) ? LOW : HIGH);
  uint32_t pinMv = sum / 16;
  if (pinMvOut) *pinMvOut = pinMv;
  return pinMv * (VDIV_R_TOP_OHM + VDIV_R_BOTTOM_OHM) / VDIV_R_BOTTOM_OHM;
}
#endif

void hwPeripheralsInit() {
#if HAS_STATUS_LED
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);
#endif
#if HAS_RGB
  rgbInit();
#endif
#if HAS_VDIV
  vdivInit();
#endif
#if HAS_VBUS_SENSE
  vbusInit();
#endif
#if HAS_CHG_STAT
  chgStatInit();
#endif
}

// ---------------------------------------------------------------------------
// SIMULASI (prototipe)
// ---------------------------------------------------------------------------
// Prototipe tidak punya baterai, charger, maupun deteksi VBUS, tapi companion app
// harus tetap bisa menguji seluruh alur UI. Fungsi di bawah memberi angka dummy
// dengan FORMAT PESAN YANG SAMA PERSIS dengan firmware FINAL, jadi saat board FINAL
// siap dipakai tidak ada perubahan sama sekali di sisi app.
bool usbHostConnected() { return true; }   // prototipe selalu disambung lewat USB

uint32_t readBatteryMv(uint32_t* pinMvOut) {
  static uint32_t mv = 4100;
  static unsigned long lastTick = 0;
  unsigned long now = millis();
  if (lastTick == 0) lastTick = now;
  if ((long)(now - lastTick) >= 60000) {      // turun 10 mV per menit
    lastTick = now;
    if (mv > 3400) mv -= 10;
  }
  if (pinMvOut) *pinMvOut = mv / 2;           // divider 100k/100k -> pin = setengah tegangan
  return mv;
}

// Prototipe tidak punya MCP73831. Nilai di sini membuat app menampilkan status
// "tidak mengecas" seperti board FINAL yang tersambung USB tanpa charger.
// Untuk menguji jalur "sedang mengecas", ganti sementara ke CHARGE_CHARGING.
ChargeState readChargeState() { return CHARGE_COMPLETE; }

// ---------------------------------------------------------------------------
// RGB hooks - prototipe
// ---------------------------------------------------------------------------
// Tidak ada LED fisik pada prototipe, jadi apply hanya menyiapkan state (RGB:DUMP
// tetap melaporkan nilai yang benar). Persist tetap ditulis ke Preferences supaya
// jalur simpan/muat bisa diuji di prototipe sebelum board FINAL ada.
void rgbApplyState() {
  // tidak ada LED fisik pada prototipe
}

bool rgbPersist() {
  if (!prefs.begin("rgbcfg", false)) return false;
  size_t w = prefs.putBytes("state", &rgbState, sizeof(rgbState));
  prefs.end();
  return (w == sizeof(rgbState));
}

void rgbRestore() {
  prefs.begin("rgbcfg", true);
  size_t n = prefs.getBytesLength("state");
  if (n == sizeof(rgbState)) {
    RgbState tmp;
    if (prefs.getBytes("state", &tmp, sizeof(tmp)) == sizeof(tmp)) rgbState = tmp;
  }
  prefs.end();
}

// ---------------------------------------------------------------------------
// BLE HID - hook milik profil
// ---------------------------------------------------------------------------
// Dipanggil dari core lewat PROFILE_HOOK_SETUP()/PROFILE_HOOK_LOOP() di
// limits.h. Hook default-nya kosong, jadi profil FINAL tidak ikut berubah.
#if HID_BLE_SUPPORT

// Tombol yang dipakai gesture "hapus bond saat boot": [0][0] (kiri atas).
#define BLE_CLEAR_ROW 0
#define BLE_CLEAR_COL 0

static unsigned long bleAdvWatchdogAt = 0;
const unsigned long BLE_ADV_WATCHDOG_MS = 5000;

void profileSetupHook() {
  // Siapkan GPIO0 (BOOT) DAN LED indikator. Tombol harus siap SEBELUM
  // hwPeripheralsInit() - lihat catatan pemanggilan di limits.h.
#if HAS_STATUS_LED
  switchLedAttach(STATUS_LED_PIN, true);
#endif
  bootSwitchBegin();

  // Samakan dengan BLE_Keypad_Test: tahan tombol [0][0] saat boot untuk
  // menghapus semua bond (berguna setelah flashing ulang / ganti nama).
  digitalWrite(ROW_PINS[BLE_CLEAR_ROW], LOW);
  delayMicroseconds(50);
  bool clearBonds = (digitalRead(COL_PINS[BLE_CLEAR_COL]) == LOW);
  digitalWrite(ROW_PINS[BLE_CLEAR_ROW], HIGH);

  bleHidInit();

  if (clearBonds) bleHidClearBonds();

  // Advertising TIDAK pernah dimatikan, apa pun mode HID. Kalau dimatikan,
  // device hilang dari daftar Bluetooth dan companion app tidak bisa
  // menemukannya untuk mengirim PROTO:NUS — padahal itulah jalur satu-satunya
  // untuk membuat protokol companion app hidup lewat BLE.
  LOGS->printf("[IFACE] link awal: %s (ganti: IFACE:USB / IFACE:BLE)\n", hidLinkName(g_hidLink));
}

void profileLoopHook() {
  // Switch USB<->BLE lewat tombol BOOT. WAJIB dipanggil SEBELUM return
  // pertama di bawah: animasi LED harus tetap jalan walau device sedang
  // tersambung BLE - justru di mode itu tombol switch paling mungkin dipakai
  // (user harus mencabut kabel dulu, atau sudah tidak punya companion app).
  if (bootSwitchPoll()) ifaceToggleFromButton();
  switchLedTick();

  // Watchdog advertising: jalankan di mode apa pun. Advertising tidak pernah
  // dimatikan (lihat F4), jadi ini hanya safety net kalau advertising
  // berhenti sendiri karena alasan tertentu (mis. Windows BT stack crash).
  if (bleHidConnected()) return;
  if (bleHidAdvertising()) return;

  unsigned long now = millis();
  if ((long)(now - bleAdvWatchdogAt) < 0) return;
  bleAdvWatchdogAt = now + BLE_ADV_WATCHDOG_MS;
  bleHidStart();
}
#endif

// Perintah diagnostik: IFACE, IFACE:USB, IFACE:BLE, HID:SELF, BLE:ADV,
// BLE:BOND:CLEAR, BLE:RAM.
bool profileTryCommand(const String& cmd) {
  return bleDiagCommand(cmd);
}

#include "../common/macropad_core.h"

