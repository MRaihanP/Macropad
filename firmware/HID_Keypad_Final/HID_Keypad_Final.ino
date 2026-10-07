/*
  ESP32-S3 Macro Pad - Firmware v5 - SKETCH FINAL
  ==============================================
  Profile: FINAL - 2 knob, 9x SK6812 MINI-E (GPIO14 data + GPIO15 enable),
  voltage divider baterai 100k/100k (GPIO16 read + GPIO17 enable).

  Sketch ini hanya berisi hal yang spesifik profil. Seluruh logika bersama
  (struktur keymap, action, protocol serial, scan matrix, encoder) ada di
  ../common/macropad_core.h

  Pairing: firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino

  Dependensi: library "Adafruit NeoPixel" (Library Manager).

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

// =================== PROFIL: FINAL ===================
#define HW_PROFILE_NAME "FINAL"
#define NUM_ENCODERS    2
#define HAS_STATUS_LED  0    // GPIO12 dipakai knob 2; indikator pakai RGB
#define HAS_RGB         1
#define HAS_VDIV        1
#define HAS_VBUS_SENSE  1    // deteksi USB tersambung via divider 68k/100k (GPIO21)
#define HAS_CHG_STAT    1    // status charger MCP73831 (GPIO18)

// Semua angka yang dikirim ke companion app di board ini berasal dari hardware sungguhan.
#define HW_DATA_SIMULATED 0

#if HAS_RGB
  #include <Adafruit_NeoPixel.h>
#endif

// ---- Matrix ----
const uint8_t ROW_PINS[ROWS] = {1, 2, 4};
const uint8_t COL_PINS[COLS] = {5, 6, 7};

// ---- Rotary encoder ----
const uint8_t ENC_BTN_PINS[NUM_ENCODERS] = {8, 11};
const uint8_t ENC_B_PINS[NUM_ENCODERS]   = {9, 12};
const uint8_t ENC_A_PINS[NUM_ENCODERS]   = {10, 13};

// ---- RGB SK6812 MINI-E ----
#if HAS_RGB
#define RGB_DATA_PIN            14
#define RGB_EN_PIN              15     // gate MOSFET power RGB
#define RGB_EN_ACTIVE_HIGH      1      // TODO: konfirmasi polaritas
#define RGB_FLASH_MS            150
#define RGB_DEFAULT_BRIGHTNESS  40     // 0-255, sengaja rendah untuk membatasi arus
#endif

// ---- Voltage divider baterai 100k/100k ----
#if HAS_VDIV
#define VDIV_READ_PIN        16
#define VDIV_EN_PIN          17
#define VDIV_EN_ACTIVE_HIGH  1         // TODO: konfirmasi polaritas
#define VDIV_R_TOP_OHM       100000UL
#define VDIV_R_BOTTOM_OHM    100000UL
#define VDIV_SETTLE_MS       5
#endif

// ---- Deteksi VBUS: USB tersambung atau tidak ----
// Dipakai untuk memutuskan apakah BLE perlu dinyalakan (hemat baterai), dan
// sebagai penentu bersama status charger.
#if HAS_VBUS_SENSE
#define VBUS_READ_PIN             21
#define VBUS_R_TOP_OHM            68000UL
#define VBUS_R_BOTTOM_OHM         100000UL
#define VBUS_PRESENT_THRESHOLD_MV 2000     // 5V USB -> ~2,98V di pin; tanpa USB -> ~0V
#endif

// ---- Charger MCP73831: pin STATUS ----
// STAT open-drain: LOW saat charging, high-Z (HIGH lewat pull-up) saat selesai.
#if HAS_CHG_STAT
#define CHG_STAT_PIN 18
#endif

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

#if HAS_VBUS_SENSE
void vbusInit() {
  // Divider VBUS selalu tersambung (tanpa pin enable), jadi cukup set pin analog.
  pinMode(VBUS_READ_PIN, INPUT);
  analogSetPinAttenuation(VBUS_READ_PIN, ADC_11db);
}

// 68k atas / 100k bawah -> VBUS 5V jadi ~2,98V di pin. Itu menyentuh batas rentang
// ADC 11dB (~3,1V) sehingga pembacaan bisa saturate pada VBUS tinggi.
// Untuk deteksi "USB tersambung atau tidak" itu tidak masalah: yang dibutuhkan hanya
// membedakan ~0V dari ~3V, bukan pengukuran akurat.
// TODO: bila nanti butuh tegangan VBUS yang akurat, turunkan resistor bawah atau
// tambahkan pin enable agar divider bisa dimatikan (beban kontinu ~30 uA sekarang).
uint32_t readVbusMv() {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 8; i++) { sum += analogReadMilliVolts(VBUS_READ_PIN); delayMicroseconds(200); }
  uint32_t pinMv = sum / 8;
  return pinMv * (VBUS_R_TOP_OHM + VBUS_R_BOTTOM_OHM) / VBUS_R_BOTTOM_OHM;
}

bool vbusPresent() { return readVbusMv() >= VBUS_PRESENT_THRESHOLD_MV; }

// Sumber kebenaran "USB tersambung". Nanti dipakai untuk menyalakan/mematikan BLE
// sesuai kebijakan hemat baterai.
bool usbHostConnected() { return vbusPresent(); }
#endif

#if HAS_CHG_STAT
void chgStatInit() {
  // MCP73831 STAT adalah open-drain: saat charging pin ini di-tarik LOW, saat charge
  // selesai pin dilepas (high-Z) lalu dibaca HIGH lewat pull-up.
  pinMode(CHG_STAT_PIN, INPUT_PULLUP);
}

ChargeState readChargeState() {
  // VBUS dan STAT dipakai bersama karena STAT saja tidak bisa membedakan
  // "charge selesai" dari "charger tidak terpasang".
  if (!vbusPresent()) return CHARGE_NONE;
  return (digitalRead(CHG_STAT_PIN) == LOW) ? CHARGE_CHARGING : CHARGE_COMPLETE;
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

#include "../common/macropad_core.h"

// ---------------------------------------------------------------------------
// RGB hooks - FINAL (meny cairkan state RGB ke strip SK6812 sungguhan)
// ---------------------------------------------------------------------------
// Mesine efek animasi (breathing/rainbow/wave/snake) belum ada; yang di sini baru
// menerjemahkan mode ke warna per LED. Ditandai TODO agar tidak disalahpahami
// sebagai "efek sudah selesai".
void rgbApplyState() {
#if HAS_RGB
  if (!rgbPowered) rgbPower(true);
  rgbBrightness = rgbState.bri;
  strip.setBrightness(rgbBrightness);

  if (rgbState.mode == 1) {
    for (uint8_t r = 0; r < ROWS; r++)
      for (uint8_t c = 0; c < COLS; c++) {
        int8_t i = RGB_INDEX[r][c];
        if (i < 0 || i >= RGB_COUNT) continue;
        rgbBase[i] = RGB32(rgbState.keys[r][c][0], rgbState.keys[r][c][1], rgbState.keys[r][c][2]);
      }
  } else {
    uint32_t flat = RGB32(rgbState.color[0], rgbState.color[1], rgbState.color[2]);
    for (uint8_t i = 0; i < RGB_COUNT; i++) rgbBase[i] = flat;
  }
  rgbRender();
#else
  // profil ini tidak punya RGB
#endif
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

