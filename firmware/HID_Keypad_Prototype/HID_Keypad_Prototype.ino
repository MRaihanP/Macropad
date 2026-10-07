/*
  ESP32-S3 Macro Pad - Firmware v5 - SKETCH PROTOTYPE
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
*/

#include <Arduino.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"
#include <Preferences.h>

#include "../common/limits.h"

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

USBHIDKeyboard Keyboard;
USBHIDConsumerControl ConsumerControl;
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

#include "../common/macropad_core.h"

