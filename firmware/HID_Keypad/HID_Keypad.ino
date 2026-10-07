/*
  ESP32-S3 Macro Pad — Firmware v5 (profil hardware: PROTOTYPE / FINAL)
  ===================================
  Perubahan v5:
  - Satu switch `HW_PROFILE` (di bawah) memilih konfigurasi pin & fitur:
      HW_PROTOTYPE : 1 knob, LED status biasa di GPIO12, tanpa RGB/voltage divider
      HW_FINAL     : 2 knob, 9x SK6812 MINI-E (GPIO14 + enable GPIO15), voltage divider (GPIO16 + enable GPIO17)
  - Abstraksi LED: statusLed() = LED biasa (prototype) ATAU semua RGB (final). Pola hold/layer/escape tetap sama.
  - RGB: sweep saat boot (urutan kabel), flash LED tombol yang ditekan. Command: RGB:ON|OFF|BRI|ALL|KEY, HWINFO, BATT.
  - Config flash otomatis jatuh ke default kalau ukuran struct berubah (mis. pindah 1 -> 2 knob).

  Dependensi (hanya saat HW_FINAL): library "Adafruit NeoPixel" (Library Manager).

  CATATAN FITUR YANG BELUM ADA (menunggu detail dari pemilik proyek)
  - [RGB] mode/efek (idle, per-layer, per-preset, breathing, dll), simpan warna ke flash, kontrol dari app, protokol serial final.
  - [RGB] polaritas pin enable MOSFET (diasumsikan aktif HIGH), batas brightness/arus final, perlu level shifter 3.3V->5V atau tidak.
  - [BATT] nilai resistor pembagi tegangan (placeholder 100k/100k), polaritas enable (diasumsikan aktif HIGH),
           kalibrasi ADC, ambang low-battery, laporan periodik ke app (EVT:BATT), indikator di RGB, deteksi charging.
  - [KNOB 2] fungsi khusus knob 2 (sekarang hanya aksi CW/CCW/tekan biasa, belum ada gesture long-press), arah putar perlu dicek di PCB final.
  - [POWER] deep/light sleep, wake-up dari tombol, perilaku saat USB dicabut.
  - [APP] UI RGB & baterai di companion (halaman RGB Setting masih placeholder).

  Perubahan dari v3:
  - Arsitektur Preset: Default Preset (cfg, flash-backed) + App Preset (appCfg, RAM-only).
    Semua command edit (SET/GET/DUMP/ADDLAYER/DELLAYER/MOVELAYER/RENAMELAYER/LAYER/DUMPNAMES/INFO)
    sekarang beroperasi lewat pointer `activeCfg`, bukan langsung ke `cfg`.
  - Command baru: CONTEXT:DEFAULT, CONTEXT:APP:NEW
  - SAVE/LOAD tetap SELALU ke `cfg` langsung (Default Preset), tidak pernah ke appCfg.
  - Encoder long-press (1 detik) cycle layer SEKARANG scoped ke activeCfg (tidak nyasar
    ke layer Default Preset saat lagi di App Preset).
  - Gestur ESCAPE: tahan terus sampai 3.5 detik (lewat dari threshold cycle 1 detik) ->
    kirim EVT:ESCAPE. Tidak ada keystroke yang terkirim ke OS selama proses ini (cycle-layer
    itu silent), jadi aman di-"buang" begitu companion switch context balik ke Default.

  Setting Board (Arduino IDE) — SAMA seperti sebelumnya:
  Tools > USB Mode        : "USB-OTG (TinyUSB)"
  Tools > USB CDC On Boot : "Enabled"
  Tools > Upload Mode     : "USB-OTG CDC (TinyUSB)"
*/

#include <Arduino.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"
#include <Preferences.h>

USBHIDKeyboard Keyboard;
USBHIDConsumerControl ConsumerControl;
Preferences prefs;

// =================== KONFIGURASI DASAR ===================
#define ROWS 3
#define COLS 3
#define MAX_LAYERS 8       // hard cap PER preset (Default maupun App, masing-masing instance sendiri)
#define MACRO_MAX_LEN 48
#define NAME_LEN 16
#define CONFIG_VERSION 5   // TIDAK berubah — struct MacroConfig sendiri tidak berubah ukuran
#define WIN_SEARCH_OPEN_DELAY_MS 450
#define WIN_SEARCH_TYPE_DELAY_MS 450

// =================== PROFIL HARDWARE ===================
#define HW_PROTOTYPE 0
#define HW_FINAL     1
#define HW_PROFILE   HW_PROTOTYPE   // <<< GANTI ke HW_FINAL saat flash ke PCB final

#if HW_PROFILE == HW_FINAL
  #define HW_PROFILE_NAME "FINAL"
  #define NUM_ENCODERS    2
  #define HAS_STATUS_LED  0    // GPIO12 dipakai knob 2; indikator pakai RGB
  #define HAS_RGB         1
  #define HAS_VDIV        1
#else
  #define HW_PROFILE_NAME "PROTOTYPE"
  #define NUM_ENCODERS    1
  #define HAS_STATUS_LED  1
  #define HAS_RGB         0
  #define HAS_VDIV        0
#endif

#if HAS_RGB
  #include <Adafruit_NeoPixel.h>
#endif

#define ENC_PRIMARY 0   // index knob yang pegang gesture dasar (long-press ganti layer, escape)

// ---- Matrix ----
const uint8_t ROW_PINS[ROWS] = {1, 2, 4};
const uint8_t COL_PINS[COLS] = {5, 6, 7};

// ---- Rotary encoder ----
// Penamaan A/B di kode mengikuti penyesuaian prototype (A = pin pemicu interrupt, B = pin pembaca arah),
// yaitu kebalikan dari label skematik (skematik knob 1: A=GPIO9, B=GPIO10). Knob 2 mengikuti konvensi sama.
// Kalau arah putar suatu knob terbalik: tukar angka pin A dan B knob itu di sini.
#if HW_PROFILE == HW_FINAL
const uint8_t ENC_BTN_PINS[NUM_ENCODERS] = {8, 11};
const uint8_t ENC_B_PINS[NUM_ENCODERS]   = {9, 12};
const uint8_t ENC_A_PINS[NUM_ENCODERS]   = {10, 13};
#else
const uint8_t ENC_BTN_PINS[NUM_ENCODERS] = {8};
const uint8_t ENC_B_PINS[NUM_ENCODERS]   = {9};
const uint8_t ENC_A_PINS[NUM_ENCODERS]   = {10};
#endif

// ---- LED status biasa (prototype) ----
#if HAS_STATUS_LED
const uint8_t STATUS_LED_PIN = 12;
#endif

// ---- RGB SK6812 MINI-E (final) ----
#if HAS_RGB
#define RGB_DATA_PIN            14
#define RGB_EN_PIN              15     // gate MOSFET power RGB
#define RGB_EN_ACTIVE_HIGH      1      // TODO: konfirmasi polaritas
#define RGB_COUNT               9
#define RGB_DEFAULT_BRIGHTNESS  40     // 0-255, sengaja rendah untuk membatasi arus
#define RGB_FLASH_MS            150
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
#endif

// ---- Voltage divider baterai (final) ----
#if HAS_VDIV
#define VDIV_READ_PIN        16
#define VDIV_EN_PIN          17
#define VDIV_EN_ACTIVE_HIGH  1         // TODO: konfirmasi polaritas
#define VDIV_R_TOP_OHM       100000UL  // TODO: isi nilai resistor sebenarnya (placeholder)
#define VDIV_R_BOTTOM_OHM    100000UL  // TODO: isi nilai resistor sebenarnya (placeholder)
#define VDIV_SETTLE_MS       5
#endif

// =================== STRUKTUR KEY MAPPING ===================
enum ActionType : uint8_t {
  ACTION_NONE = 0,
  ACTION_KEY,
  ACTION_COMBO,
  ACTION_TEXT,
  ACTION_CONSUMER,
  ACTION_APP
};

struct KeyAction {
  ActionType type;
  char value[MACRO_MAX_LEN];
};

// =================== STRUKTUR CONFIG UTUH ===================
struct MacroConfig {
  uint8_t version;
  uint8_t layerCount;
  uint8_t currentLayer;
  KeyAction layerMap[MAX_LAYERS][ROWS][COLS];
  KeyAction encCW[NUM_ENCODERS];
  KeyAction encCCW[NUM_ENCODERS];
  KeyAction encBtn[NUM_ENCODERS];
  char layerNames[MAX_LAYERS][NAME_LEN];
};

MacroConfig cfg;              // Default Preset — flash-backed, selalu ada
MacroConfig appCfg;           // App Preset aktif — RAM only, dibuang tiap ganti context
MacroConfig* activeCfg = &cfg; // Semua command & eksekusi matrix/encoder lewat pointer ini

// Cache App Preset di RAM (adaptive switch): upload sekali, ganti konteks cukup 1 command.
#define APP_SLOTS 6
MacroConfig slotCfg[APP_SLOTS];

// =================== STATE MATRIX ===================
const unsigned long KEY_DEBOUNCE_MS = 30;
bool keyRawState[ROWS][COLS];
bool keyDebouncedState[ROWS][COLS];
unsigned long keyLastChangeTime[ROWS][COLS];

// =================== STATE ENCODER ROTASI (per index) ===================
volatile bool encMoved[NUM_ENCODERS]       = { false };
volatile bool encDirCW[NUM_ENCODERS]       = { true };
volatile uint8_t lastEncAState[NUM_ENCODERS];

// =================== STATE ENCODER BUTTON (per index; index ENC_PRIMARY pakai
// gesture lengkap di checkEncoder(), index lain cuma tap sederhana) ===================
bool encBtnRawState[NUM_ENCODERS]        = { false };
bool encBtnDebouncedState[NUM_ENCODERS]  = { false };
unsigned long encBtnLastChangeTime[NUM_ENCODERS] = { 0 };
const unsigned long ENC_BTN_DEBOUNCE_MS = 30;

unsigned long encBtnPressStart = 0;
bool layerSwitchTriggered = false;   // true setelah threshold 1s tercapai (masih ditahan)
bool escapeTriggered = false;        // true setelah threshold 3.5s tercapai (masih ditahan)
bool encoderLedActive = false;
unsigned long holdBlinkLast = 0;
bool holdBlinkState = false;
const unsigned long LONG_PRESS_MS   = 1000;  // cycle layer (scoped ke activeCfg)
const unsigned long ESCAPE_HOLD_MS  = 3500;  // tahan lebih lama lagi -> escape ke Default Preset
const unsigned long HOLD_BLINK_INTERVAL_MS = 150;
const unsigned long ESCAPE_BLINK_INTERVAL_MS = 80; // kedip lebih cepat di zona escape

// =================== STATE LED HEARTBEAT ===================
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL_MS = 1000;
bool ledHeartbeatState = false;
unsigned long ledFlashUntil = 0;
const unsigned long LED_FLASH_DURATION_MS = 150;

// =================== SERIAL COMMAND BUFFER ===================
String serialBuffer = "";

// =================== ISR ENCODER (satu fungsi untuk semua knob, dibedakan lewat arg) ===================
void IRAM_ATTR handleEncoderISR(void* arg) {
  uint8_t i = (uint8_t)(uintptr_t)arg;
  uint8_t stateA = digitalRead(ENC_A_PINS[i]);
  if (stateA != lastEncAState[i]) {
    uint8_t stateB = digitalRead(ENC_B_PINS[i]);
    if (stateA == LOW) {
      encDirCW[i] = (stateB == HIGH);
      encMoved[i] = true;
    }
    lastEncAState[i] = stateA;
  }
}

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
}

// LED status generik: LED biasa (prototype) dan/atau seluruh RGB (final).
void statusLed(bool on) {
#if HAS_STATUS_LED
  digitalWrite(STATUS_LED_PIN, on ? HIGH : LOW);
#endif
#if HAS_RGB
  rgbSetStatus(on);
#endif
}

void flashLed() {
#if HAS_STATUS_LED   // di profil FINAL tombol memakai rgbKeyFlash(), bukan menyalakan semua LED
  ledFlashUntil = millis() + LED_FLASH_DURATION_MS;
  statusLed(true);
#endif
}

void broadcastLayerChanged() {
  Serial.printf("EVT:LAYER:%d\n", activeCfg->currentLayer);
}

void blinkLedTimes(uint8_t times) {
  for (uint8_t i = 0; i < times; i++) {
    statusLed(true);
    delay(120);
    statusLed(false);
    delay(120);
  }
}

// =================== DEFAULT CONFIG (Default Preset) ===================
void setDefaultAction(uint8_t l, uint8_t r, uint8_t c, ActionType type, const char* val) {
  if (l >= MAX_LAYERS || r >= ROWS || c >= COLS) return;
  cfg.layerMap[l][r][c].type = type;
  strncpy(cfg.layerMap[l][r][c].value, val, MACRO_MAX_LEN - 1);
  cfg.layerMap[l][r][c].value[MACRO_MAX_LEN - 1] = '\0';
}

void setDefaultConfig() {
  memset(&cfg, 0, sizeof(cfg));
  cfg.version = CONFIG_VERSION;
  cfg.layerCount = 4;
  cfg.currentLayer = 0;

  for (uint8_t l = 0; l < MAX_LAYERS; l++)
    snprintf(cfg.layerNames[l], NAME_LEN, "Layer %d", l);

  for (uint8_t r = 0; r < ROWS; r++) {
    for (uint8_t c = 0; c < COLS; c++) {
      uint8_t idx = r * COLS + c;
      char label[2] = {0, 0};
      if (idx < 9) label[0] = '1' + idx;
      else if (idx < 9 + 26) label[0] = 'a' + (idx - 9);
      else continue;
      setDefaultAction(0, r, c, ACTION_KEY, label);
    }
  }

  setDefaultAction(1, 0, 0, ACTION_COMBO, "CTRL+C");
  setDefaultAction(1, 0, 1, ACTION_COMBO, "CTRL+V");
  setDefaultAction(1, 0, 2, ACTION_COMBO, "CTRL+X");
  setDefaultAction(1, 1, 0, ACTION_COMBO, "CTRL+Z");
  setDefaultAction(1, 1, 1, ACTION_COMBO, "CTRL+S");
  setDefaultAction(1, 1, 2, ACTION_COMBO, "CTRL+A");
  setDefaultAction(1, 2, 0, ACTION_TEXT,  "hello world");

  cfg.encCW[ENC_PRIMARY]  = {ACTION_CONSUMER, "VOLUP"};
  cfg.encCCW[ENC_PRIMARY] = {ACTION_CONSUMER, "VOLDOWN"};
  cfg.encBtn[ENC_PRIMARY] = {ACTION_CONSUMER, "MUTE"};
}

// =================== APP PRESET (RAM only) ===================
// Dipanggil tiap kali companion mulai bangun App Preset baru (baik untuk runtime
// saat app dapat fokus, maupun saat user buka editor "Adaptive Key Bind").
void resetCfgStruct(MacroConfig& c) {
  memset(&c, 0, sizeof(c));
  c.version = CONFIG_VERSION;
  c.layerCount = 1;
  c.currentLayer = 0;
  snprintf(c.layerNames[0], NAME_LEN, "Layer 0");
  // layerMap & encCW/encCCW/encBtn sudah ACTION_NONE semua dari memset — App Preset
  // selalu mulai blank, TIDAK mewarisi apapun dari Default Preset.
}

void resetAppCfg() { resetCfgStruct(appCfg); }

// =================== PENYIMPANAN FLASH (NVS) — SELALU ke cfg, tidak lewat activeCfg ===================
void saveConfigToFlash() {
  prefs.begin("macropad", false);
  prefs.putBytes("cfg", &cfg, sizeof(cfg));
  prefs.end();
  Serial.println("[FLASH] Config tersimpan");
}

void loadConfigFromFlash() {
  prefs.begin("macropad", true);
  bool exists = prefs.isKey("cfg");
  size_t len = exists ? prefs.getBytesLength("cfg") : 0;

  if (exists && len == sizeof(cfg)) {
    prefs.getBytes("cfg", &cfg, sizeof(cfg));
    prefs.end();
    if (cfg.version != CONFIG_VERSION) {
      Serial.println("[FLASH] Versi config lama, pakai default");
      setDefaultConfig();
    } else {
      Serial.println("[FLASH] Config dimuat dari flash");
    }
  } else {
    prefs.end();
    Serial.println("[FLASH] Tidak ada config valid, pakai default");
    setDefaultConfig();
  }

  if (cfg.layerCount < 1) cfg.layerCount = 1;
  if (cfg.layerCount > MAX_LAYERS) cfg.layerCount = MAX_LAYERS;
  if (cfg.currentLayer >= cfg.layerCount) cfg.currentLayer = 0;
}

// =================== EKSEKUSI ACTION ===================
void executeCombo(const char* combo) {
  char buffer[MACRO_MAX_LEN];
  strncpy(buffer, combo, MACRO_MAX_LEN);
  buffer[MACRO_MAX_LEN - 1] = '\0';

  char* tokens[6];
  uint8_t tokenCount = 0;
  char* tok = strtok(buffer, "+");
  while (tok != NULL && tokenCount < 6) { tokens[tokenCount++] = tok; tok = strtok(NULL, "+"); }
  if (tokenCount == 0) return;

  for (uint8_t i = 0; i < tokenCount - 1; i++) {
    if (strcasecmp(tokens[i], "CTRL") == 0)  Keyboard.press(KEY_LEFT_CTRL);
    else if (strcasecmp(tokens[i], "SHIFT") == 0) Keyboard.press(KEY_LEFT_SHIFT);
    else if (strcasecmp(tokens[i], "ALT") == 0)   Keyboard.press(KEY_LEFT_ALT);
    else if (strcasecmp(tokens[i], "GUI") == 0 || strcasecmp(tokens[i], "WIN") == 0) Keyboard.press(KEY_LEFT_GUI);
  }
  char* mainKey = tokens[tokenCount - 1];
  if (strlen(mainKey) == 1) {
    // Library HID menambah Shift otomatis untuk huruf kapital ('C' => Shift+C).
    // Shift hanya boleh datang dari token SHIFT eksplisit, jadi huruf dipaksa kecil.
    char k = mainKey[0];
    if (k >= 'A' && k <= 'Z') k = k - 'A' + 'a';
    Keyboard.press(k);
  }
  delay(15);
  Keyboard.releaseAll();
}

void executeOpenApp(const char* appName) {
  Keyboard.press(KEY_LEFT_GUI);
  delay(80);
  Keyboard.releaseAll();
  delay(WIN_SEARCH_OPEN_DELAY_MS);
  Keyboard.print(appName);
  delay(WIN_SEARCH_TYPE_DELAY_MS);
  Keyboard.write(KEY_RETURN);
}

void sendAppEvent(const char* appName) {
  Serial.printf("EVT:APP:%s\n", appName);
}

const unsigned long HOST_TIMEOUT_MS = 4000;
unsigned long lastHostSeenMs = 0;

bool companionConnected() {
  return lastHostSeenMs != 0 && (millis() - lastHostSeenMs < HOST_TIMEOUT_MS);
}

void openApp(const char* appName) {
  if (companionConnected()) {
    sendAppEvent(appName);
  } else {
    Serial.println("[APP] Companion tidak terhubung, fallback Windows Search");
    executeOpenApp(appName);
  }
}

void executeConsumer(const char* name) {
  if (strcasecmp(name, "VOLUP") == 0) { ConsumerControl.press(CONSUMER_CONTROL_VOLUME_INCREMENT); ConsumerControl.release(); }
  else if (strcasecmp(name, "VOLDOWN") == 0) { ConsumerControl.press(CONSUMER_CONTROL_VOLUME_DECREMENT); ConsumerControl.release(); }
  else if (strcasecmp(name, "MUTE") == 0) { ConsumerControl.press(CONSUMER_CONTROL_MUTE); ConsumerControl.release(); }
  else if (strcasecmp(name, "PLAYPAUSE") == 0) { ConsumerControl.press(CONSUMER_CONTROL_PLAY_PAUSE); ConsumerControl.release(); }
  else if (strcasecmp(name, "NEXT") == 0) { ConsumerControl.press(CONSUMER_CONTROL_SCAN_NEXT); ConsumerControl.release(); }
  else if (strcasecmp(name, "PREV") == 0) { ConsumerControl.press(CONSUMER_CONTROL_SCAN_PREVIOUS); ConsumerControl.release(); }
}

void executeAction(KeyAction action) {
  switch (action.type) {
    case ACTION_KEY:      if (strlen(action.value) > 0) Keyboard.write(action.value[0]); break;
    case ACTION_COMBO:    executeCombo(action.value); break;
    case ACTION_TEXT:     Keyboard.print(action.value); break;
    case ACTION_CONSUMER: executeConsumer(action.value); break;
    case ACTION_APP:      if (strlen(action.value) > 0) openApp(action.value); break;
    default: break;
  }
}

// =================== SCAN MATRIX — sekarang lewat activeCfg ===================
void scanMatrix() {
  unsigned long now = millis();
  for (uint8_t r = 0; r < ROWS; r++) {
    for (uint8_t rr = 0; rr < ROWS; rr++) digitalWrite(ROW_PINS[rr], rr == r ? LOW : HIGH);
    delayMicroseconds(20);

    for (uint8_t c = 0; c < COLS; c++) {
      bool rawPressed = (digitalRead(COL_PINS[c]) == LOW);
      if (rawPressed != keyRawState[r][c]) { keyRawState[r][c] = rawPressed; keyLastChangeTime[r][c] = now; }

      if ((now - keyLastChangeTime[r][c] >= KEY_DEBOUNCE_MS) && (keyRawState[r][c] != keyDebouncedState[r][c])) {
        keyDebouncedState[r][c] = keyRawState[r][c];
        if (keyDebouncedState[r][c]) {
          KeyAction action = activeCfg->layerMap[activeCfg->currentLayer][r][c];
          executeAction(action);
          Serial.printf("[KEY] Layer %d, R%d C%d -> type=%d val=%s\n", activeCfg->currentLayer, r, c, action.type, action.value);
          flashLed();
          rgbKeyFlash(r, c);
        }
      }
    }
  }
  for (uint8_t rr = 0; rr < ROWS; rr++) digitalWrite(ROW_PINS[rr], HIGH);
}

// =================== CEK ENCODER — semua knob + gesture lengkap di ENC_PRIMARY ===================
void checkEncoder() {
  unsigned long now = millis();

  // ---- Putaran: semua knob jalan lewat aksi terkonfigurasi di context aktif ----
  for (uint8_t i = 0; i < NUM_ENCODERS; i++) {
    if (encMoved[i]) {
      noInterrupts();
      bool dirCW = encDirCW[i];
      encMoved[i] = false;
      interrupts();
      executeAction(dirCW ? activeCfg->encCW[i] : activeCfg->encCCW[i]);
      Serial.printf("EVT:ENC:%d:%s\n", i, dirCW ? "CW" : "CCW");
      flashLed();
    }
  }

  // ---- Tombol knob TAMBAHAN (bukan ENC_PRIMARY): tap sederhana, tanpa long-press/escape ----
  for (uint8_t i = 0; i < NUM_ENCODERS; i++) {
    if (i == ENC_PRIMARY) continue;
    bool rawPressed = (digitalRead(ENC_BTN_PINS[i]) == LOW);
    if (rawPressed != encBtnRawState[i]) { encBtnRawState[i] = rawPressed; encBtnLastChangeTime[i] = now; }
    if ((now - encBtnLastChangeTime[i] >= ENC_BTN_DEBOUNCE_MS) && (encBtnRawState[i] != encBtnDebouncedState[i])) {
      encBtnDebouncedState[i] = encBtnRawState[i];
      if (!encBtnDebouncedState[i]) { // eksekusi saat dilepas
        executeAction(activeCfg->encBtn[i]);
        Serial.printf("[ENC_BTN] Knob %d: aksi terkonfigurasi dijalankan\n", i);
        flashLed();
      }
    }
  }

  // ---- Tombol knob ENC_PRIMARY: gesture dasar (cycle layer, escape) — SAMA seperti sebelumnya ----
  const uint8_t p = ENC_PRIMARY;
  bool rawPressed = (digitalRead(ENC_BTN_PINS[p]) == LOW);
  if (rawPressed != encBtnRawState[p]) { encBtnRawState[p] = rawPressed; encBtnLastChangeTime[p] = now; }

  if ((now - encBtnLastChangeTime[p] >= ENC_BTN_DEBOUNCE_MS) && (encBtnRawState[p] != encBtnDebouncedState[p])) {
    encBtnDebouncedState[p] = encBtnRawState[p];

    if (encBtnDebouncedState[p]) {
      encBtnPressStart = now;
      layerSwitchTriggered = false;
      escapeTriggered = false;
      encoderLedActive = true;
      holdBlinkLast = now;
      holdBlinkState = false;
    } else {
      // Baru dilepas
      if (escapeTriggered) {
        // Pola beda sengaja: 1 kedipan panjang, bukan N-kali-sesuai-layer
        // (currentLayer appCfg sudah tidak relevan, sebentar lagi dibuang companion)
        statusLed(false);
        delay(100);
        statusLed(true);
        delay(300);
        statusLed(false);
        escapeTriggered = false;
        layerSwitchTriggered = false;
      } else if (layerSwitchTriggered) {
        statusLed(false);
        blinkLedTimes(activeCfg->currentLayer + 1);
        layerSwitchTriggered = false;
      } else {
        executeAction(activeCfg->encBtn[p]);
        Serial.println("[ENC_BTN] Aksi terkonfigurasi dijalankan");
        flashLed();
      }
      encoderLedActive = false;
      lastHeartbeat = now;
    }
  }

  // ---- State machine LED selama tombol ENC_PRIMARY ditahan (3 tier) ----
  if (encBtnDebouncedState[p]) {
    unsigned long elapsed = now - encBtnPressStart;

    if (!layerSwitchTriggered && elapsed < LONG_PRESS_MS) {
      if (now - holdBlinkLast >= HOLD_BLINK_INTERVAL_MS) {
        holdBlinkLast = now;
        holdBlinkState = !holdBlinkState;
        statusLed(holdBlinkState);
      }
    } else if (!layerSwitchTriggered && elapsed >= LONG_PRESS_MS) {
      layerSwitchTriggered = true;
      activeCfg->currentLayer = (activeCfg->currentLayer + 1) % activeCfg->layerCount;
      Serial.printf("[LAYER] Pindah ke layer %d\n", activeCfg->currentLayer);
      broadcastLayerChanged();
      statusLed(true); // solid
    } else if (layerSwitchTriggered && !escapeTriggered && elapsed >= ESCAPE_HOLD_MS) {
      escapeTriggered = true;
      activeCfg = &cfg;           // paksa balik ke Default SEKARANG JUGA, tidak nunggu companion
      Serial.println("EVT:ESCAPE");
      broadcastLayerChanged();    // broadcast currentLayer Default yang sebenarnya, menimpa EVT:LAYER tadi
    } else if (escapeTriggered) {
      if (now - holdBlinkLast >= ESCAPE_BLINK_INTERVAL_MS) {
        holdBlinkLast = now;
        holdBlinkState = !holdBlinkState;
        statusLed(holdBlinkState);
      }
    }
  }
}

// =================== SERIAL COMMAND PARSER ===================
ActionType parseActionType(const String& s) {
  if (s == "KEY") return ACTION_KEY;
  if (s == "COMBO") return ACTION_COMBO;
  if (s == "TEXT") return ACTION_TEXT;
  if (s == "CONSUMER") return ACTION_CONSUMER;
  if (s == "APP") return ACTION_APP;
  return ACTION_NONE;
}

void dumpEncoderConfig() {
  Serial.printf("ENC_BEGIN:count=%d\n", NUM_ENCODERS);
  for (uint8_t i = 0; i < NUM_ENCODERS; i++) {
    Serial.printf("IDX:%d\n", i);
    Serial.printf("CW,%d,%s\n", activeCfg->encCW[i].type, activeCfg->encCW[i].value);
    Serial.printf("CCW,%d,%s\n", activeCfg->encCCW[i].type, activeCfg->encCCW[i].value);
    Serial.printf("BTN,%d,%s\n", activeCfg->encBtn[i].type, activeCfg->encBtn[i].value);
  }
  Serial.println("ENC_END");
}

void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  lastHostSeenMs = millis();

  if (cmd == "WHOAMI") {
    Serial.printf("WHOAMI:MacroPad:v1:rows=%d,cols=%d,encoders=%d\n", ROWS, COLS, NUM_ENCODERS);
    return;
  }

  if (cmd == "PING") { Serial.println("PONG"); return; }

  if (cmd == "INFO") {
    Serial.printf("INFO:layerCount=%d,currentLayer=%d,maxLayers=%d,rows=%d,cols=%d,encoders=%d,context=%s\n",
                  activeCfg->layerCount, activeCfg->currentLayer, MAX_LAYERS, ROWS, COLS, NUM_ENCODERS,
                  (activeCfg == &cfg) ? "DEFAULT" : "APP");
    return;
  }

  // SAVE/LOAD SELALU ke Default Preset (cfg), TIDAK PERNAH ke appCfg — terlepas context aktif
  if (cmd == "SAVE") { saveConfigToFlash(); return; }
  if (cmd == "LOAD") { loadConfigFromFlash(); Serial.println("[OK] Config dimuat ulang"); return; }

  if (cmd == "RESET") {
    setDefaultConfig();
    Serial.println("[OK] Config direset ke default (ketik SAVE untuk permanen)");
    return;
  }

  // ---- Context switching: App Preset ----
  if (cmd == "CONTEXT:DEFAULT") {
    activeCfg = &cfg;
    Serial.println("[OK] Context: DEFAULT");
    return;
  }
  if (cmd == "CONTEXT:APP:NEW") {
    resetAppCfg();
    activeCfg = &appCfg;
    Serial.println("[OK] Context: APP (baru, blank)");
    return;
  }

  // ---- Slot App Preset (cache RAM) ----
  if (cmd.startsWith("SLOT:")) {
    int c2 = cmd.indexOf(':', 5);
    if (c2 < 0) { Serial.println("[ERROR] Format SLOT tidak lengkap"); return; }
    int n = cmd.substring(5, c2).toInt();
    String op = cmd.substring(c2 + 1);
    if (n < 0 || n >= APP_SLOTS) { Serial.println("[ERROR] Slot di luar batas"); return; }
    if (op == "NEW") resetCfgStruct(slotCfg[n]);
    else if (op != "USE") { Serial.println("[ERROR] Op SLOT harus NEW/USE"); return; }
    slotCfg[n].currentLayer = 0;
    activeCfg = &slotCfg[n];
    Serial.printf("[OK] Context: SLOT %d (%s)\n", n, op.c_str());
    return;
  }

  if (cmd == "CONTEXT:APP:RESUME") {
    activeCfg = &appCfg;
    Serial.println("[OK] Context: APP (resume, data dipertahankan)");
    return;
  }

  if (cmd == "ADDLAYER") {
    if (activeCfg->layerCount >= MAX_LAYERS) { Serial.println("[ERROR] Sudah mencapai jumlah layer maksimum"); return; }
    for (uint8_t r = 0; r < ROWS; r++)
      for (uint8_t c = 0; c < COLS; c++)
        activeCfg->layerMap[activeCfg->layerCount][r][c] = {ACTION_NONE, ""};
    snprintf(activeCfg->layerNames[activeCfg->layerCount], NAME_LEN, "Layer %d", activeCfg->layerCount);
    activeCfg->layerCount++;
    Serial.printf("[OK] Layer ditambah, total sekarang %d\n", activeCfg->layerCount);
    return;
  }

  if (cmd == "DELLAYER") {
    if (activeCfg->layerCount <= 1) { Serial.println("[ERROR] Minimal harus ada 1 layer"); return; }
    uint8_t idx = activeCfg->currentLayer;
    for (uint8_t l = idx; l < activeCfg->layerCount - 1; l++) {
      for (uint8_t r = 0; r < ROWS; r++)
        for (uint8_t c = 0; c < COLS; c++)
          activeCfg->layerMap[l][r][c] = activeCfg->layerMap[l + 1][r][c];
      strncpy(activeCfg->layerNames[l], activeCfg->layerNames[l + 1], NAME_LEN);
    }
    activeCfg->layerCount--;
    if (activeCfg->currentLayer >= activeCfg->layerCount) activeCfg->currentLayer = activeCfg->layerCount - 1;
    Serial.printf("[OK] Layer %d dihapus, total sekarang %d, currentLayer=%d\n", idx, activeCfg->layerCount, activeCfg->currentLayer);
    broadcastLayerChanged();
    return;
  }

  if (cmd == "DUMPENC") { dumpEncoderConfig(); return; }

  if (cmd.startsWith("SETENC:")) {
    // Format: SETENC:<idx>:<CW|CCW|BTN>:<type>:<value>
    int idx1 = cmd.indexOf(':', 7);
    int idx2 = cmd.indexOf(':', idx1 + 1);
    int idx3 = cmd.indexOf(':', idx2 + 1);
    if (idx1 < 0 || idx2 < 0 || idx3 < 0) { Serial.println("[ERROR] Format SETENC tidak lengkap"); return; }

    uint8_t encIdx = cmd.substring(7, idx1).toInt();
    String which = cmd.substring(idx1 + 1, idx2);
    String typeStr = cmd.substring(idx2 + 1, idx3);
    String value = cmd.substring(idx3 + 1);

    if (encIdx >= NUM_ENCODERS) { Serial.println("[ERROR] Index encoder di luar batas"); return; }

    KeyAction newAction;
    newAction.type = parseActionType(typeStr);
    strncpy(newAction.value, value.c_str(), MACRO_MAX_LEN - 1);
    newAction.value[MACRO_MAX_LEN - 1] = '\0';

    if (which == "CW") activeCfg->encCW[encIdx] = newAction;
    else if (which == "CCW") activeCfg->encCCW[encIdx] = newAction;
    else if (which == "BTN") activeCfg->encBtn[encIdx] = newAction;
    else { Serial.println("[ERROR] Target SETENC harus CW/CCW/BTN"); return; }

    Serial.printf("[OK] SetEnc %d/%s -> %s : %s\n", encIdx, which.c_str(), typeStr.c_str(), value.c_str());
    return;
  }

  if (cmd.startsWith("MOVELAYER:")) {
    String dir = cmd.substring(10);
    int16_t target;
    if (dir == "LEFT") target = (int16_t)activeCfg->currentLayer - 1;
    else if (dir == "RIGHT") target = (int16_t)activeCfg->currentLayer + 1;
    else { Serial.println("[ERROR] Arah harus LEFT atau RIGHT"); return; }

    if (target < 0 || target >= activeCfg->layerCount) { Serial.println("[ERROR] Tidak bisa digeser, sudah di ujung"); return; }

    for (uint8_t r = 0; r < ROWS; r++)
      for (uint8_t c = 0; c < COLS; c++) {
        KeyAction tmp = activeCfg->layerMap[activeCfg->currentLayer][r][c];
        activeCfg->layerMap[activeCfg->currentLayer][r][c] = activeCfg->layerMap[target][r][c];
        activeCfg->layerMap[target][r][c] = tmp;
      }
    char tmpName[NAME_LEN];
    strncpy(tmpName, activeCfg->layerNames[activeCfg->currentLayer], NAME_LEN);
    strncpy(activeCfg->layerNames[activeCfg->currentLayer], activeCfg->layerNames[target], NAME_LEN);
    strncpy(activeCfg->layerNames[target], tmpName, NAME_LEN);

    activeCfg->currentLayer = (uint8_t)target;
    Serial.printf("[OK] Layer digeser ke posisi %d\n", activeCfg->currentLayer);
    broadcastLayerChanged();
    return;
  }

  if (cmd.startsWith("RENAMELAYER:")) {
    int idx1 = cmd.indexOf(':', 12);
    if (idx1 < 0) { Serial.println("[ERROR] Format RENAMELAYER tidak lengkap"); return; }
    uint8_t layer = cmd.substring(12, idx1).toInt();
    String name = cmd.substring(idx1 + 1);
    if (layer >= activeCfg->layerCount) { Serial.println("[ERROR] Layer index tidak valid"); return; }
    strncpy(activeCfg->layerNames[layer], name.c_str(), NAME_LEN - 1);
    activeCfg->layerNames[layer][NAME_LEN - 1] = '\0';
    Serial.printf("[OK] Layer %d diganti nama jadi \"%s\"\n", layer, activeCfg->layerNames[layer]);
    return;
  }

  if (cmd == "DUMPNAMES") {
    Serial.println("NAMES_BEGIN");
    for (uint8_t l = 0; l < activeCfg->layerCount; l++) Serial.printf("%d,%s\n", l, activeCfg->layerNames[l]);
    Serial.println("NAMES_END");
    return;
  }

  if (cmd.startsWith("LAYER:")) {
    uint8_t l = cmd.substring(6).toInt();
    if (l < activeCfg->layerCount) {
      activeCfg->currentLayer = l;
      Serial.printf("[LAYER] Pindah manual ke layer %d\n", activeCfg->currentLayer);
      broadcastLayerChanged();
    } else Serial.println("[ERROR] Layer index tidak valid");
    return;
  }

  if (cmd.startsWith("DUMP:")) {
    uint8_t layer = cmd.substring(5).toInt();
    if (layer >= activeCfg->layerCount) { Serial.println("[ERROR] Layer index tidak valid"); return; }
    Serial.printf("DUMP_BEGIN:%d\n", layer);
    for (uint8_t r = 0; r < ROWS; r++)
      for (uint8_t c = 0; c < COLS; c++) {
        KeyAction a = activeCfg->layerMap[layer][r][c];
        Serial.printf("%d,%d,%d,%s\n", r, c, a.type, a.value);
      }
    Serial.println("DUMP_END");
    return;
  }

  if (cmd.startsWith("SET:")) {
    int idx1 = cmd.indexOf(':', 4), idx2 = cmd.indexOf(':', idx1 + 1);
    int idx3 = cmd.indexOf(':', idx2 + 1), idx4 = cmd.indexOf(':', idx3 + 1);
    if (idx1 < 0 || idx2 < 0 || idx3 < 0 || idx4 < 0) { Serial.println("[ERROR] Format SET tidak lengkap"); return; }

    uint8_t layer = cmd.substring(4, idx1).toInt();
    uint8_t row   = cmd.substring(idx1 + 1, idx2).toInt();
    uint8_t col   = cmd.substring(idx2 + 1, idx3).toInt();
    String typeStr = cmd.substring(idx3 + 1, idx4);
    String value  = cmd.substring(idx4 + 1);

    if (layer >= activeCfg->layerCount || row >= ROWS || col >= COLS) { Serial.println("[ERROR] Index di luar batas"); return; }

    activeCfg->layerMap[layer][row][col].type = parseActionType(typeStr);
    strncpy(activeCfg->layerMap[layer][row][col].value, value.c_str(), MACRO_MAX_LEN - 1);
    activeCfg->layerMap[layer][row][col].value[MACRO_MAX_LEN - 1] = '\0';

    Serial.printf("[OK] Set L%d R%d C%d -> %s : %s\n", layer, row, col, typeStr.c_str(), value.c_str());
    return;
  }

  if (cmd.startsWith("GET:")) {
    int idx1 = cmd.indexOf(':', 4), idx2 = cmd.indexOf(':', idx1 + 1);
    if (idx1 < 0 || idx2 < 0) { Serial.println("[ERROR] Format GET tidak lengkap"); return; }

    uint8_t layer = cmd.substring(4, idx1).toInt();
    uint8_t row   = cmd.substring(idx1 + 1, idx2).toInt();
    uint8_t col   = cmd.substring(idx2 + 1).toInt();

    if (layer >= activeCfg->layerCount || row >= ROWS || col >= COLS) { Serial.println("[ERROR] Index di luar batas"); return; }

    KeyAction a = activeCfg->layerMap[layer][row][col];
    Serial.printf("L%d R%d C%d -> type=%d value=%s\n", layer, row, col, a.type, a.value);
    return;
  }

  if (cmd == "HWINFO") {
    Serial.printf("HWINFO:profile=%s,encoders=%d,statusLed=%d,rgb=%d,rgbCount=%d,vdiv=%d\n", HW_PROFILE_NAME, NUM_ENCODERS,
                  HAS_STATUS_LED, HAS_RGB,
#if HAS_RGB
                  RGB_COUNT,
#else
                  0,
#endif
                  HAS_VDIV);
    return;
  }

  if (cmd == "BATT") {
#if HAS_VDIV
    uint32_t pinMv = 0;
    uint32_t battMv = readBatteryMv(&pinMv);
    Serial.printf("BATT:pin_mv=%lu,batt_mv=%lu\n", (unsigned long)pinMv, (unsigned long)battMv);
#else
    Serial.println("[ERROR] Voltage divider tidak ada di profil " HW_PROFILE_NAME);
#endif
    return;
  }

  if (cmd.startsWith("RGB:")) {
#if HAS_RGB
    if (cmd == "RGB:ON")  { rgbPower(true);  Serial.println("[OK] RGB on");  return; }
    if (cmd == "RGB:OFF") { rgbPower(false); Serial.println("[OK] RGB off"); return; }
    if (cmd.startsWith("RGB:BRI:")) {
      int b = cmd.substring(8).toInt();
      if (b < 0 || b > 255) { Serial.println("[ERROR] Brightness 0-255"); return; }
      rgbBrightness = (uint8_t)b; strip.setBrightness(rgbBrightness); rgbRender();
      Serial.printf("[OK] RGB brightness %d\n", b);
      return;
    }
    if (cmd.startsWith("RGB:ALL:")) {
      int r, g, b;
      if (sscanf(cmd.c_str() + 8, "%d:%d:%d", &r, &g, &b) != 3 || r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) { Serial.println("[ERROR] Format RGB:ALL:r:g:b"); return; }
      for (uint8_t i = 0; i < RGB_COUNT; i++) rgbBase[i] = RGB32(r, g, b);
      rgbRender();
      Serial.println("[OK] RGB semua diset");
      return;
    }
    if (cmd.startsWith("RGB:KEY:")) {
      int row, col, r, g, b;
      if (sscanf(cmd.c_str() + 8, "%d:%d:%d:%d:%d", &row, &col, &r, &g, &b) != 5 || row < 0 || row >= ROWS || col < 0 || col >= COLS ||
          r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) { Serial.println("[ERROR] Format RGB:KEY:row:col:r:g:b"); return; }
      rgbBase[RGB_INDEX[row][col]] = RGB32(r, g, b);
      rgbRender();
      Serial.printf("[OK] RGB %d (R%d C%d) diset\n", (int)RGB_INDEX[row][col] + 1, row, col);
      return;
    }
    Serial.println("[ERROR] Command RGB tidak dikenal");
#else
    Serial.println("[ERROR] RGB tidak ada di profil " HW_PROFILE_NAME);
#endif
    return;
  }

  Serial.println("[ERROR] Command tidak dikenal");
}

void checkSerialInput() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { handleSerialCommand(serialBuffer); serialBuffer = ""; }
    else if (c != '\r') serialBuffer += c;
  }
}

// =================== LED HEARTBEAT ===================
void updateLed() {
  if (encoderLedActive) return;

  unsigned long now = millis();
  if (ledFlashUntil != 0 && now < ledFlashUntil) return;
  if (ledFlashUntil != 0 && now >= ledFlashUntil) { ledFlashUntil = 0; statusLed(false); }
}

// =================== SETUP ===================
void setup() {
  Serial.setRxBufferSize(4096); // harus sebelum begin(); batch upload preset bisa beberapa KB
  Serial.begin(115200);
  delay(300);
  USB.productName("MacroPad3x3");
  USB.manufacturerName("DIY Macropad");
  USB.serialNumber("MACROPAD-proto");
  USB.begin();
  Keyboard.begin();
  ConsumerControl.begin();

  Serial.println("=== ESP32-S3 Macro Pad Firmware v5 ===");
  Serial.printf("[HW] Profil: %s, knob=%d\n", HW_PROFILE_NAME, NUM_ENCODERS);
  loadConfigFromFlash();
  for (uint8_t i = 0; i < APP_SLOTS; i++) resetCfgStruct(slotCfg[i]);
  resetAppCfg(); // siapkan appCfg kosong dari awal (belum dipakai sampai ada CONTEXT:APP:NEW)

  for (uint8_t i = 0; i < ROWS; i++) { pinMode(ROW_PINS[i], OUTPUT); digitalWrite(ROW_PINS[i], HIGH); }
  for (uint8_t i = 0; i < COLS; i++) pinMode(COL_PINS[i], INPUT_PULLUP);
  for (uint8_t r = 0; r < ROWS; r++)
    for (uint8_t c = 0; c < COLS; c++) { keyRawState[r][c] = false; keyDebouncedState[r][c] = false; keyLastChangeTime[r][c] = 0; }

  for (uint8_t i = 0; i < NUM_ENCODERS; i++) {
    pinMode(ENC_BTN_PINS[i], INPUT_PULLUP);
    pinMode(ENC_A_PINS[i], INPUT_PULLUP);
    pinMode(ENC_B_PINS[i], INPUT_PULLUP);
    lastEncAState[i] = digitalRead(ENC_A_PINS[i]);
    attachInterruptArg(digitalPinToInterrupt(ENC_A_PINS[i]), handleEncoderISR, (void*)(uintptr_t)i, CHANGE);
  }

  hwPeripheralsInit();
}

void loop() {
  scanMatrix();
  checkEncoder();
  checkSerialInput();
  updateLed();
  updateRgb();
}
