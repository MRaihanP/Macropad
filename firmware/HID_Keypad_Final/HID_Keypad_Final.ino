/*
  ESP32-S3 Macro Pad - Firmware v8 - SKETCH FINAL
  (nomor resmi ada di FW_VERSION, firmware/common/limits.h - jangan diubah
   di sini; nilai header ini hanya catatan, yang dikirim ke app adalah FW_VERSION)
  ==============================================
  Profile: FINAL - 2 knob, 9x SK6812 MINI-E (GPIO14 data + GPIO15 enable),
  voltage divider baterai 100k/100k (GPIO16 read + GPIO17 enable),
  transport sense dari VBUS 68k/100k (GPIO21), charger MCP73831 (GPIO18).

  Sketch ini hanya berisi hal yang spesifik profil. Seluruh logika bersama
  (struktur keymap, action, protocol serial, scan matrix, encoder, gesture)
  ada di ../common/macropad_core.h

  Pairing: firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino

  Dependensi: library "Adafruit NeoPixel" (Library Manager).

  Setting Board (Arduino IDE) - SAMA untuk kedua sketsh:
  Tools > USB Mode        : "USB-OTG (TinyUSB)"
  Tools > USB CDC On Boot : "Enabled"
  Tools > Upload Mode     : "USB-OTG CDC (TinyUSB)"

  PERILAKU MEDIA (FINAL)
  ----------------------
  Tidak ada tombol BOOT yang dipakai untuk pindah media. Keputusan diambil dari
  VD_VB (GPIO21, divider 68k/100k):

    VD_VB HIGH (USB tersambung)  -> HID + protokol lewat USB, BLE DIMATIKAN
    VD_VB LOW  (hanya baterai)   -> HID + protokol lewat BLE, USB di-de-enumerasi

  Perpindahan terjadi otomatis saat kabel dicabut/dipasang, dengan debounce
  ~1 detik supaya capacitor cross-coupling tidak memicu switch palsu.
  Perintah Serial IFACE:* / PROTO:* / MODE:BT / MODE:PC tetap tersedia untuk
  diagnostik manual, tapi auto-switch akan mengoreksinya sesuai VD_VB.

  Battery sense: EN_VD dinyalakan -> tunggu settle 5 ms -> 16 sampel -> EN_VD
  dimatikan. Pembacaan hanya tiap 10 detik (BATT_REPORT_INTERVAL_MS di core),
  bukan tiap loop.
*/

#include <Arduino.h>
#include <math.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"
#include <Preferences.h>

// =================== KONFIGURASI HID LINK ===================
// FINAL WAJIB punya BLE: saat kabel dicabut device harus tetap bisa dipakai.
#define HID_BLE_SUPPORT  1

// Mode awal BLE. profileSetupHook() langsung mengoreksi ke USB bila VD_VB
// mendeteksi kabel, jadi nilai ini hanya menentukan advertising sudah siap
// sebelum pengecekan pertama.
#define HID_LINK_DEFAULT HID_LINK_BLE
#define PROTO_DEFAULT    PROTO_NUS

// ---------------------------------------------------------------------------
// Hook profil -> core (menimpa default kosong di limits.h)
// ---------------------------------------------------------------------------
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
#include "../common/rgb_effects.h"

// Global transport instances - definisi (bukan extern).
UsbTransport g_usbTransport;
BleNusTransport g_bleNusTransport;

// g_transport = jalur PROTOKOL (jawaban perintah, event, [KEY], EVT:).
// g_logTransport = jalur LOG, SELALU USB CDC supaya Serial Monitor tetap bisa
// dipakai walau protokol sudah pindah ke NUS.
Transport* g_transport    = &g_usbTransport;
Transport* g_logTransport = &g_usbTransport;

void protoTransportSwitch() {
  g_transport = (g_protoLink == ProtoLink::NUS) ? (Transport*)&g_bleNusTransport
                                                : (Transport*)&g_usbTransport;
  LOGS->printf("[PROTO] Transport beralih ke %s\n", protoLinkName(g_protoLink));
}

// ---------------------------------------------------------------------------
// PINDAH MEDIA PENUH (auto dari VD_VB, atau manual MODE:BT / MODE:PC)
// ---------------------------------------------------------------------------
// Menyelaraskan KEDUA sumbu (HID + protokol), memindahkan power (mutual
// exclusion), dan mengarahkan g_transport.
//
// Urutan penting: sisi BLE dikerjakan lebih dulu dari USB.
//   -> BLE : advertising nyala dulu, baru USB di-de-enumerasi
//   -> USB : BLE diputus+dimatikan dulu, baru USB dihidupkan
void ifaceSwitchFull(bool goBle) {
#if HID_BLE_SUPPORT
  if (goBle) {
    hidLinkSet(HidLink::BLE);
    g_protoLink = ProtoLink::NUS;
  } else {
    hidLinkSet(HidLink::USB);
    g_protoLink = ProtoLink::CDC;
  }
  protoTransportSwitch();
  LOGS->printf("[IFACE] pindah ke %s (hid=%s proto=%s)\n",
               goBle ? "BLE" : "USB", hidLinkName(g_hidLink), protoLinkName(g_protoLink));
  usbDevicePower(!goBle);
#else
  (void)goBle;
  LOGS->println("[IFACE] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
#endif
}

// =================== PROFIL: FINAL ===================
#define HW_PROFILE_NAME "FINAL"
#define NUM_ENCODERS    2
#define HAS_STATUS_LED  0    // GPIO12 dipakai knob 2; indikator pakai RGB
#define HAS_RGB         1
#define HAS_VDIV        1
#define HAS_VBUS_SENSE  1    // deteksi USB via divider 68k/100k (GPIO21)
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
// ENC_A/ENC_B mengikuti tabel pinout user: RE1_A=GPIO9, RE1_B=GPIO10,
// RE2_A=GPIO12, RE2_B=GPIO13. (Versi lama menamainya terbalik; yang penting
// pasangan pin-nya sama, tapi nama sekarang cocok dengan skema.)
const uint8_t ENC_BTN_PINS[NUM_ENCODERS] = {8, 11};
const uint8_t ENC_A_PINS[NUM_ENCODERS]   = {9, 12};
const uint8_t ENC_B_PINS[NUM_ENCODERS]   = {10, 13};

// ---- RGB SK6812 MINI-E ----
#if HAS_RGB
#define RGB_DATA_PIN            14
#define RGB_EN_PIN              15     // gate MOSFET power RGB
#define RGB_EN_ACTIVE_HIGH      1      // MOSFET P-channel + pull-up: HIGH = hidup
#define RGB_FLASH_MS            150
#define RGB_DEFAULT_BRIGHTNESS  40     // 0-255, sengaja rendah untuk membatasi arus
#define RGB_FRAME_INTERVAL_MS   40     // ~25 fps; cukup halus, tidak membebani loop
#endif

// ---- Voltage divider baterai 100k/100k ----
#if HAS_VDIV
#define VDIV_READ_PIN        16
#define VDIV_EN_PIN          17
#define VDIV_EN_ACTIVE_HIGH  1         // HIGH = divider tersambung
#define VDIV_R_TOP_OHM       100000UL
#define VDIV_R_BOTTOM_OHM    100000UL
#define VDIV_SETTLE_MS       5
#endif

// ---- Transport sense: VBUS ada / tidak ----
// Divider 68k atas / 100k bawah -> VBUS 5 V menjadi ~2,98 V di pin.
//
// PENTING: GPIO21 BUKAN pin ADC pada ESP32-S3 (ADC1 = GPIO1..10,
// ADC2 = GPIO11..20). analogReadMilliVolts(21) tidak pernah mengukur apa pun,
// jadi kode lama yang memakai ADC di sini membuat deteksi USB/charger tidak
// pernah benar. Karena yang dibutuhkan hanya "ada tegangan" vs "tidak ada",
// pembacaan digital sudah cukup - dan justru lebih tahan noise daripada ADC
// yang saturasi di ~3,1 V.
#if HAS_VBUS_SENSE
#define VBUS_READ_PIN 21
#endif

// ---- Charger MCP73831: pin STATUS ----
#if HAS_CHG_STAT
#define CHG_STAT_PIN 18
#endif

// Facade dari hid_link.h: report HID diarahkan ke USB atau BLE sesuai g_hidLink.
HidKeyboard   Keyboard;
HidConsumer   ConsumerControl;
Preferences prefs;

// =================== PERIPHERAL: RGB ===================
#if HAS_RGB
Adafruit_NeoPixel strip(RGB_COUNT, RGB_DATA_PIN, NEO_GRB + NEO_KHZ800);
uint32_t rgbBase[RGB_COUNT];
unsigned long rgbFlashUntil[RGB_COUNT];
bool rgbStatusOn = false;
bool rgbPowered = false;
uint8_t rgbBrightness = RGB_DEFAULT_BRIGHTNESS;
uint16_t rgbPhase = 0;
unsigned long rgbNextFrameAt = 0;

// Seed untuk mode yang memakai warna acak. Diturunkan dari phase, bukan
// millis(), supaya hasilnya deterministik dan tidak berubah tiap frame.
static uint32_t rgbSeed() {
  if (!rgbState.random) return 0x1234567u;
  return (uint32_t)(rgbPhase / 256u) + 1u;
}

void rgbRender() {
  if (!rgbPowered) return;
  for (uint8_t i = 0; i < RGB_COUNT; i++) {
    uint32_t c = rgbStatusOn ? RGB_STATUS_COLOR : (rgbFlashUntil[i] ? RGB_FLASH_COLOR : rgbBase[i]);
    strip.setPixelColor(i, c);
  }
  strip.show();   // ~300us; interrupt encoder bisa tertunda sebentar saat show()
}

void rgbPower(bool on) {
  if (on == rgbPowered) {
    if (on) rgbRender();
    return;
  }
  digitalWrite(RGB_EN_PIN, (on == (RGB_EN_ACTIVE_HIGH != 0)) ? HIGH : LOW);
  rgbPowered = on;
  if (on) { delay(5); rgbRender(); }   // beri waktu rail RGB stabil
}

// Apakah state saat ini benar-benar menghasilkan cahaya? Dipakai supaya
// "brightness 0" dan "warna hitam" benar-benar mematikan MOSFET, bukan hanya
// mengirim warna (0,0,0) ke LED yang tetap menyala.
bool rgbStateHasLight() {
  if (!rgbState.enabled || rgbState.bri == 0) return false;
  switch (rgbState.mode) {
    case 1:   // per key
      for (uint8_t r = 0; r < ROWS; r++)
        for (uint8_t c = 0; c < COLS; c++)
          if (rgbState.keys[r][c][0] || rgbState.keys[r][c][1] || rgbState.keys[r][c][2]) return true;
      return false;
    case 2:   // breathing  - menghasilkan warna sendiri
    case 3:   // color cycle
    case 4:   // rainbow
    case 7:   // random
      return true;
    case 5:   // waves  - color[2] = value HSV
    case 6:   // snake  - color[2] = value HSV
      return rgbState.color[2] > 0;
    default:  // 0 static, 8 react
      return rgbState.color[0] || rgbState.color[1] || rgbState.color[2];
  }
}

// Isi rgbBase dari mesin efek murni (rgb_effects.h). Mode 0/1/8 statis,
// mode 2..7 dianimasikan oleh updateRgb().
void rgbBuildFrame() {
  rgbFrame(rgbState.mode, rgbState.speed, rgbState.color, rgbState.keys,
           rgbPhase, rgbSeed(), rgbBase);
}

void rgbInit() {
  pinMode(RGB_EN_PIN, OUTPUT);
  digitalWrite(RGB_EN_PIN, (RGB_EN_ACTIVE_HIGH != 0) ? LOW : HIGH);   // mulai mati
  strip.begin();
  strip.setBrightness(rgbBrightness);
  for (uint8_t i = 0; i < RGB_COUNT; i++) { rgbBase[i] = RGB_IDLE_COLOR; rgbFlashUntil[i] = 0; }
  rgbPowered = false;

  // Hormati state tersimpan: kalau user sudah mematikan RGB (atau brightness 0),
  // jangan nyalakan MOSFET dan jangan jalankan sweep sama sekali.
  if (rgbStateHasLight()) {
    rgbPower(true);
    delay(10);
    // Sweep sesuai urutan rantai kabel (RGB1..RGB9): tes MOSFET & urutan LED.
    for (uint8_t i = 0; i < RGB_COUNT; i++) {
      strip.clear();
      strip.setPixelColor(i, RGB_STATUS_COLOR);
      strip.show();
      delay(45);
    }
    rgbRender();
  }
}

void rgbKeyFlash(uint8_t r, uint8_t c) {
  if (!rgbPowered) return;
  int8_t i = RGB_INDEX[r][c];
  if (i < 0 || i >= RGB_COUNT) return;
  rgbFlashUntil[i] = millis() + RGB_FLASH_MS;
  if (rgbFlashUntil[i] == 0) rgbFlashUntil[i] = 1;
  rgbRender();
}

void rgbSetStatus(bool on) {
  if (!rgbPowered && on) return;   // RGB dimatikan user: jangan paksa nyala
  rgbStatusOn = on;
  rgbRender();
}

void updateRgb() {
  if (!rgbPowered) return;
  unsigned long now = millis();
  bool dirty = false;

  // Lepas flash putih yang sudah kedaluwarsa.
  for (uint8_t i = 0; i < RGB_COUNT; i++)
    if (rgbFlashUntil[i] && (long)(now - rgbFlashUntil[i]) >= 0) { rgbFlashUntil[i] = 0; dirty = true; }

  // Animasi mode 2..7: hitung frame baru pada interval tetap.
  if (rgbState.enabled && rgbState.mode >= 2 && rgbState.mode <= 7) {
    if ((long)(now - rgbNextFrameAt) >= 0) {
      rgbNextFrameAt = now + RGB_FRAME_INTERVAL_MS;
      rgbPhase++;
      rgbBuildFrame();
      dirty = true;
    }
  }
  if (dirty) rgbRender();
}
#else
static inline void rgbKeyFlash(uint8_t, uint8_t) {}
static inline void updateRgb() {}
#endif

// =================== PERIPHERAL: BATERAI ===================
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

// =================== PERIPHERAL: TRANSPORT SENSE ===================
#if HAS_VBUS_SENSE
void vbusInit() { pinMode(VBUS_READ_PIN, INPUT); }

// Divider selalu tersambung (tanpa pin enable). 5 V -> ~2,98 V = HIGH,
// tanpa USB -> 0 V lewat 100k = LOW. Tidak ada ADC di GPIO21.
bool vbusPresent() { return digitalRead(VBUS_READ_PIN) == HIGH; }

bool usbHostConnected() { return vbusPresent(); }
#endif

// =================== PERIPHERAL: CHARGER ===================
#if HAS_CHG_STAT
void chgStatInit() {
  // MCP73831 STAT adalah open-drain: LOW saat charging, high-Z saat selesai
  // (dibaca HIGH lewat pull-up internal).
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
// RGB hooks - FINAL
// ---------------------------------------------------------------------------
// Menerjemahkan RgbState ke strip sungguhan, termasuk efek animasi dari
// rgb_effects.h. Dipanggil core setiap ada perintah RGB:*.
void rgbApplyState() {
#if HAS_RGB
  rgbBrightness = rgbState.bri;
  strip.setBrightness(rgbBrightness);

  // Mulai efek dari awal supaya perubahan mode terlihat langsung.
  rgbPhase = 0;
  rgbNextFrameAt = millis() + RGB_FRAME_INTERVAL_MS;

  // Matikan MOSFET kalau state memang tidak menghasilkan cahaya. Ini yang
  // membuat "RGB off", "brightness 0", dan "warna hitam" benar-benar 0 arus.
  if (!rgbStateHasLight()) {
    rgbPower(false);
    return;
  }

  rgbBuildFrame();
  rgbPower(true);
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

// ---------------------------------------------------------------------------
// BLE HID + AUTO TRANSPORT SWITCH
// ---------------------------------------------------------------------------
#if HID_BLE_SUPPORT

// Tombol yang dipakai gesture "hapus bond saat boot": [0][0] (kiri atas).
// Tidak ada tombol BOOT di FINAL, jadi ini satu-satunya jalan menghapus bond
// tanpa companion app.
#define BLE_CLEAR_ROW 0
#define BLE_CLEAR_COL 0

static unsigned long bleAdvWatchdogAt = 0;
const unsigned long BLE_ADV_WATCHDOG_MS = 5000;

// Polling VD_VB. 300 ms x 3 bacaan stabil = ~0,9 dtk sebelum switch, cukup
// untuk menahan ripple dari rangkaian cross-coupling capacitor saat kabel
// dicabut/dipasang, tanpa terasa lambat oleh user.
const unsigned long TRANSPORT_POLL_MS = 300;
const uint8_t       TRANSPORT_STABLE_N = 3;
unsigned long transportPollAt = 0;
uint8_t transportStable = 0;
bool transportLastRead = false;

void pollTransportSense() {
  unsigned long now = millis();
  if ((long)(now - transportPollAt) < 0) return;
  transportPollAt = now + TRANSPORT_POLL_MS;

  bool usb = vbusPresent();
  if (usb != transportLastRead) {
    transportLastRead = usb;
    transportStable = 0;
    return;
  }
  if (transportStable < TRANSPORT_STABLE_N) {
    transportStable++;
    if (transportStable < TRANSPORT_STABLE_N) return;
  }

  bool wantBle = !usb;                          // tidak ada USB -> hidupkan BLE
  bool isBle   = (g_hidLink == HidLink::BLE);
  if (wantBle == isBle) return;

  LOGS->printf("[TRANSPORT] VD_VB %s -> pindah ke %s\n",
               usb ? "HIGH (USB)" : "LOW (baterai)", wantBle ? "BLE" : "USB");
  ifaceSwitchFull(wantBle);
}

void profileSetupHook() {
  // Sinkronkan state auto-switch dengan kondisi kabel saat boot.
  bool usb = vbusPresent();
  transportLastRead = usb;
  transportStable = TRANSPORT_STABLE_N;   // kondisi awal dianggap sudah stabil
  transportPollAt = millis() + TRANSPORT_POLL_MS;

  // Hapus bond: tahan [0][0] saat boot (pin matrix sudah disiapkan core).
  digitalWrite(ROW_PINS[BLE_CLEAR_ROW], LOW);
  delayMicroseconds(50);
  bool clearBonds = (digitalRead(COL_PINS[BLE_CLEAR_COL]) == LOW);
  digitalWrite(ROW_PINS[BLE_CLEAR_ROW], HIGH);

  bleHidInit();
  if (clearBonds) bleHidClearBonds();

  // Terapkan media sesuai kabel. ifaceSwitchFull(false) memanggil
  // hidLinkSet(USB) -> bleHidStop(), jadi advertising yang baru dinyalakan
  // bleHidInit() ikut dimatikan.
  ifaceSwitchFull(!usb);

  LOGS->printf("[IFACE] media awal: %s (VD_VB=%s)\n",
               usb ? "USB" : "BLE", usb ? "HIGH" : "LOW");
}

void profileLoopHook() {
  // Kuras antrean notify BLE dan jalankan conn-param tertunda. WAJIB sebelum
  // return awal di bawah.
  bleNusTxPump();
  bleHidServiceDeferred();

  // Auto switch USB <-> BLE berdasarkan VD_VB.
  pollTransportSense();

  // Watchdog advertising hanya di mode BLE. Saat mode USB, BLE dimatikan total
  // dan tidak boleh dinyalakan kembali (mutual exclusion).
  if (g_hidLink != HidLink::BLE) return;

  if (bleHidConnected()) return;
  if (bleHidAdvertising()) return;

  unsigned long now = millis();
  if ((long)(now - bleAdvWatchdogAt) < 0) return;
  bleAdvWatchdogAt = now + BLE_ADV_WATCHDOG_MS;
  bleHidStart();
}
#endif

// Perintah diagnostik: IFACE, IFACE:USB, IFACE:BLE, HID:SELF, MODE:BT/PC,
// BLE:ADV, BLE:BOND:CLEAR, BLE:RAM.
bool profileTryCommand(const String& cmd) {
  return bleDiagCommand(cmd);
}
