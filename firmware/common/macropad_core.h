// ==================================================================
//  LOGIKA BERSAMA - firmware PROTOTYPE dan FINAL
// ==================================================================
// Diekstrak verbatim dari HID_Keypad.ino (v5) pada Phase 2 pemisahan firmware.
// Tidak ada Serial/HID/pin spesifik profil di sini. Bagian hardware tiap profil
// ada di folder sketchnya masing-masing.
// ==================================================================

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
// Buffer baris didefinisikan di dekat checkSerialInput() (bagian bawah berkas ini).

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

// ---- Kedipan indikator non-blocking ----
// Dulu blinkLedTimes() memakai delay(120) dua kali per kedipan. Pada 8 layer itu
// 8 x 240ms = 1,92 detik firmware buta, dan karena scanMatrix() hanya MENGAMBIL
// sampel (bukan mengantre), setiap penekanan tombol selama periode itu hilang
// tanpa jejak. Sekarang dijalankan bertahap dari loop() lewat serviceLedBlink().
#define LED_BLINK_STEP_MS 120
#define LED_BLINK_MAX     4      // pola hanya perlu memberitahu "layer berapa"

uint8_t ledBlinkRemaining = 0;
unsigned long ledBlinkNextAt = 0;
bool ledBlinkOn = false;

void blinkLedTimes(uint8_t times) {
  if (times > LED_BLINK_MAX) times = LED_BLINK_MAX;   // jangan menambah buta tanpa informasi baru
  ledBlinkRemaining = times;
  ledBlinkOn = false;
  ledBlinkNextAt = millis();
}

void serviceLedBlink() {
  if (ledBlinkRemaining == 0) return;
  if ((long)(millis() - ledBlinkNextAt) < 0) return;
  if (ledBlinkOn) {
    statusLed(false);
    ledBlinkOn = false;
    if (--ledBlinkRemaining == 0) return;
  } else {
    statusLed(true);
    ledBlinkOn = true;
  }
  ledBlinkNextAt = millis() + LED_BLINK_STEP_MS;
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
// Return true bila benar-benar tersimpan. Dulu nilai balik diabaikan dan "[FLASH]
// Config tersimpan" dicetak tanpa syarat, padahal putBytes() mengembalikan 0 saat
// NVS penuh atau error - app lalu menganggap SAVE sukses dan membersihkan dirty flag,
// sehingga edit user hilang tanpa jejak.
bool saveConfigToFlash() {
  if (!prefs.begin("macropad", false)) {
    Serial.println("[ERROR] SAVE gagal: tidak bisa membuka partisi NVS");
    return false;
  }
  size_t w = prefs.putBytes("cfg", &cfg, sizeof(cfg));
  prefs.end();
  if (w != sizeof(cfg)) {
    Serial.printf("[ERROR] SAVE gagal: hanya %u dari %u byte tersimpan\n",
                  (unsigned)w, (unsigned)sizeof(cfg));
    return false;
  }
  Serial.println("[FLASH] Config tersimpan");
  return true;
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

// ---- Gestur "buka aplikasi" (Win+Search -> ketik -> Enter) ----
// Dijalankan BERTAHAP dari loop() lewat serviceOpenApp(), bukan blocking.
// Versi lama memakai delay(80) + 450 + 450ms = ~1 detik beku total. Selama itu
// scanMatrix() tetap berjalan, tetapi karena ia hanya mengambil sampel,
// penekanan tombol yang jatuh di tengah gestur hilang tanpa jejak - persis
// keluhan "macropad-nya gak responsif saat macro jalan".
//
// Sisa blocking hanya Keyboard.print() di dalam library HID (~1ms per karakter),
// bukan ratusan milidetik seperti sebelumnya.
enum OpenAppStep : uint8_t { OA_IDLE = 0, OA_WAIT_SEARCH, OA_WAIT_TYPE };
OpenAppStep openAppStep = OA_IDLE;
unsigned long openAppNextAt = 0;
char openAppName[MACRO_MAX_LEN];

// ---- Kedipan panjang saat gestur escape ----
// 1 tahap: LED menyala lama sebagai penanda "context dilepas". Non-blocking.
uint8_t escapeBlinkStage = 0;   // 0 = tidak aktif, 1 = nyalakan, 2 = padamkan
unsigned long escapeBlinkNextAt = 0;

void serviceEscapeBlink() {
  if (escapeBlinkStage == 0) return;
  if ((long)(millis() - escapeBlinkNextAt) < 0) return;
  if (escapeBlinkStage == 1) {
    statusLed(true);
    escapeBlinkStage = 2;
    escapeBlinkNextAt = millis() + 300;
  } else {
    statusLed(false);
    escapeBlinkStage = 0;
  }
}

void executeOpenApp(const char* appName) {
  if (openAppStep != OA_IDLE) return;   // abaikan gesture yang belum selesai
  strncpy(openAppName, appName, MACRO_MAX_LEN - 1);
  openAppName[MACRO_MAX_LEN - 1] = '\0';
  Keyboard.press(KEY_LEFT_GUI);
  Keyboard.releaseAll();
  openAppStep = OA_WAIT_SEARCH;
  openAppNextAt = millis() + WIN_SEARCH_OPEN_DELAY_MS;
}

void serviceOpenApp() {
  if (openAppStep == OA_IDLE) return;
  if ((long)(millis() - openAppNextAt) < 0) return;
  if (openAppStep == OA_WAIT_SEARCH) {
    Keyboard.print(openAppName);
    openAppStep = OA_WAIT_TYPE;
    openAppNextAt = millis() + WIN_SEARCH_TYPE_DELAY_MS;
  } else {
    Keyboard.write(KEY_RETURN);
    openAppStep = OA_IDLE;
  }
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
          // Event penekanan key. WAJIB selalu dikirim: companion app memakainya untuk
          // notifikasi overlay per key (notifyBoundAction). Formatnya sengaja ringkas
          // karena Print::vprintf memakai buffer stack 64 byte lalu malloc untuk output
          // yang lebih panjang; versi lama "Layer %d, R%d C%d -> type=%d val=%s" bisa
          // melewati batas itu dan kena alokasi heap pada setiap penekanan tombol.
          //
          // Panjang terburuk: "[KEY] 7,2,2,3," + 47 char + newline = 62 byte, masih di
          // bawah 64. Jangan tambah field tanpa menghitung ulang.
          Serial.printf("[KEY] %d,%d,%d,%d,%s\n", activeCfg->currentLayer, r, c, action.type, action.value);
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
        // (currentLayer appCfg sudah tidak relevan, sebentar lagi dibuang companion).
        // Dijalankan non-blocking lewat serviceEscapeBlink(); sebelumnya delay(100)
        // + delay(300) membekukan loop selama 400ms.
        statusLed(false);
        escapeBlinkStage = 1;
        escapeBlinkNextAt = millis() + 100;
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
// =================== RGB: STATE + LAPORAN BATERAI (bersama) ===================
RgbState rgbState;

void rgbStateReset() {
  rgbState.enabled = true;
  rgbState.mode    = 0;
  rgbState.random  = 0;
  rgbState.speed   = 128;
  rgbState.bri     = 200;
  rgbState.color[0] = 0x10; rgbState.color[1] = 0x60; rgbState.color[2] = 0x5A;
  for (uint8_t r = 0; r < ROWS; r++)
    for (uint8_t c = 0; c < COLS; c++) {
      rgbState.keys[r][c][0] = 0x10;
      rgbState.keys[r][c][1] = 0x60;
      rgbState.keys[r][c][2] = 0x5A;
    }
  rgbState.dirty = false;
}

void rgbDump() {
  Serial.printf("RGB_DUMP:enabled=%d,mode=%d,random=%d,bri=%d,speed=%d,color=%d:%d:%d,dirty=%d\n",
                rgbState.enabled ? 1 : 0, rgbState.mode, rgbState.random, rgbState.bri, rgbState.speed,
                rgbState.color[0], rgbState.color[1], rgbState.color[2], rgbState.dirty ? 1 : 0);
  for (uint8_t r = 0; r < ROWS; r++)
    for (uint8_t c = 0; c < COLS; c++)
      Serial.printf("RGB_KEY:%d,%d,%d:%d:%d\n", r, c,
                    rgbState.keys[r][c][0], rgbState.keys[r][c][1], rgbState.keys[r][c][2]);
  Serial.println("RGB_DUMP_END");
}

uint8_t battPercentFromMv(uint32_t mv) {
  static const uint16_t mvTab[]  = {4200, 4100, 4000, 3900, 3800, 3700, 3600, 3400};
  static const uint8_t  pctTab[] = { 100,   90,   80,   65,   50,   30,   15,    0};
  const uint8_t n = sizeof(mvTab) / sizeof(mvTab[0]);
  if (mv >= mvTab[0]) return 100;
  for (uint8_t i = 0; i + 1 < n; i++) {
    if (mv >= mvTab[i + 1]) {
      uint32_t span = mvTab[i] - mvTab[i + 1];
      uint32_t into = mv - mvTab[i + 1];
      if (span == 0) return pctTab[i];
      return (uint8_t)(pctTab[i + 1] + (into * (pctTab[i] - pctTab[i + 1])) / span);
    }
  }
  return 0;
}

const unsigned long BATT_REPORT_INTERVAL_MS = 5000;
unsigned long lastBattReportMs = 0;
ChargeState lastChargeState = CHARGE_NONE;
bool battStateValid = false;

// Laporkan baterai + status charger. Nilai diambil lewat antarmuka profil, jadi
// PROTOTYPE mengirim angka simulasi dan FINAL mengirim angka hardware dengan
// format pesan yang sama persis.
void reportBatt() {
  ChargeState cs = readChargeState();
  bool chargeChanged = !battStateValid || (cs != lastChargeState);
  unsigned long now = millis();
  if (!chargeChanged && (long)(now - lastBattReportMs) < (long)BATT_REPORT_INTERVAL_MS) return;

  lastBattReportMs = now;
  lastChargeState = cs;
  battStateValid = true;

  uint32_t pinMv = 0;
  uint32_t battMv = readBatteryMv(&pinMv);
  Serial.printf("EVT:BATT:pct=%d,mv=%lu,charging=%d,usb=%d,profile=%s\n",
                battPercentFromMv(battMv), (unsigned long)battMv,
                (cs == CHARGE_CHARGING) ? 1 : 0,
                usbHostConnected() ? 1 : 0, HW_PROFILE_NAME);
  if (chargeChanged)
    Serial.printf("EVT:CHG:state=%d\n", (int)cs);
}

ActionType parseActionType(const String& s) {
  if (s == "KEY") return ACTION_KEY;
  if (s == "COMBO") return ACTION_COMBO;
  if (s == "TEXT") return ACTION_TEXT;
  if (s == "CONSUMER") return ACTION_CONSUMER;
  if (s == "APP") return ACTION_APP;
  return ACTION_NONE;
}

// Parse integer secara ketat. String::toInt() Arduino mengembalikan 0 untuk teks
// non-numerik ("abc" -> 0) dan nilai besar terpotong diam-diam saat di-cast ke
// uint8_t (256 -> 0). Akibatnya indeks salah bisa lolos validasi dan menulis ke
// layer/key/knob yang keliru tanpa error. Fungsi ini menolak teks non-angka,
// overflow, dan nilai di luar [minV, maxV].
bool parseIntRange(const String &s, long minV, long maxV, long &out) {
  int len = s.length();
  if (len == 0) return false;
  int i = 0;
  bool neg = false;
  if (s[0] == '-' || s[0] == '+') {
    neg = (s[0] == '-');
    i = 1;
    if (len == 1) return false;
  }
  long v = 0;
  for (; i < len; i++) {
    char c = s[i];
    if (c < '0' || c > '9') return false;
    v = v * 10 + (c - '0');
    if (v > 100000000L) return false;   // guard overflow
  }
  if (neg) v = -v;
  if (v < minV || v > maxV) return false;
  out = v;
  return true;
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

// cmd tidak pernah dimutasi di dalam fungsi ini (semua pemakaiannya hanya ==,
// startsWith, indexOf, substring, c_str), jadi diambil lewat const reference untuk
// cmd tidak pernah dimutasi di dalam fungsi ini (semua pemakaiannya hanya ==,
// startsWith, indexOf, substring, c_str), jadi diambil lewat const reference untuk
// memangkas satu alokasi String per perintah.
void handleSerialCommand(const String& cmd) {
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
    long nL;
    if (!parseIntRange(cmd.substring(5, c2), 0, APP_SLOTS - 1, nL)) { Serial.println("[ERROR] Slot di luar batas"); return; }
    int n = (int)nL;
    String op = cmd.substring(c2 + 1);
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

    long encIdxL;
    if (!parseIntRange(cmd.substring(7, idx1), 0, NUM_ENCODERS - 1, encIdxL)) { Serial.println("[ERROR] Index encoder di luar batas"); return; }
    uint8_t encIdx = (uint8_t)encIdxL;
    String which = cmd.substring(idx1 + 1, idx2);
    String typeStr = cmd.substring(idx2 + 1, idx3);
    String value = cmd.substring(idx3 + 1);

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
    long layerL;
    if (!parseIntRange(cmd.substring(12, idx1), 0, activeCfg->layerCount - 1, layerL)) { Serial.println("[ERROR] Layer index tidak valid"); return; }
    uint8_t layer = (uint8_t)layerL;
    String name = cmd.substring(idx1 + 1);
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
    long lL;
    if (!parseIntRange(cmd.substring(6), 0, activeCfg->layerCount - 1, lL)) { Serial.println("[ERROR] Layer index tidak valid"); return; }
    activeCfg->currentLayer = (uint8_t)lL;
    Serial.printf("[LAYER] Pindah manual ke layer %d\n", activeCfg->currentLayer);
    broadcastLayerChanged();
    return;
  }

  if (cmd.startsWith("DUMP:")) {
    long layerL;
    if (!parseIntRange(cmd.substring(5), 0, activeCfg->layerCount - 1, layerL)) { Serial.println("[ERROR] Layer index tidak valid"); return; }
    uint8_t layer = (uint8_t)layerL;
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

    long layerL, rowL, colL;
    if (!parseIntRange(cmd.substring(4, idx1), 0, activeCfg->layerCount - 1, layerL) ||
        !parseIntRange(cmd.substring(idx1 + 1, idx2), 0, ROWS - 1, rowL) ||
        !parseIntRange(cmd.substring(idx2 + 1, idx3), 0, COLS - 1, colL)) {
      Serial.println("[ERROR] Index di luar batas"); return;
    }
    uint8_t layer = (uint8_t)layerL, row = (uint8_t)rowL, col = (uint8_t)colL;
    String typeStr = cmd.substring(idx3 + 1, idx4);
    String value  = cmd.substring(idx4 + 1);

    activeCfg->layerMap[layer][row][col].type = parseActionType(typeStr);
    strncpy(activeCfg->layerMap[layer][row][col].value, value.c_str(), MACRO_MAX_LEN - 1);
    activeCfg->layerMap[layer][row][col].value[MACRO_MAX_LEN - 1] = '\0';

    Serial.printf("[OK] Set L%d R%d C%d -> %s : %s\n", layer, row, col, typeStr.c_str(), value.c_str());
    return;
  }

  if (cmd.startsWith("GET:")) {
    int idx1 = cmd.indexOf(':', 4), idx2 = cmd.indexOf(':', idx1 + 1);
    if (idx1 < 0 || idx2 < 0) { Serial.println("[ERROR] Format GET tidak lengkap"); return; }

    long layerL, rowL, colL;
    if (!parseIntRange(cmd.substring(4, idx1), 0, activeCfg->layerCount - 1, layerL) ||
        !parseIntRange(cmd.substring(idx1 + 1, idx2), 0, ROWS - 1, rowL) ||
        !parseIntRange(cmd.substring(idx2 + 1), 0, COLS - 1, colL)) {
      Serial.println("[ERROR] Index di luar batas"); return;
    }
    uint8_t layer = (uint8_t)layerL, row = (uint8_t)rowL, col = (uint8_t)colL;

    KeyAction a = activeCfg->layerMap[layer][row][col];
    Serial.printf("L%d R%d C%d -> type=%d value=%s\n", layer, row, col, a.type, a.value);
    return;
  }

  if (cmd == "HWINFO") {
    // rgbSlots tetap RGB_COUNT di kedua profil: di FINAL itu jumlah LED fisik,
    // di PROTOTYPE itu jumlah key yang disimulasikan. App memakai angka yang sama
    // untuk menandai "RGB 1".."RGB 9" di kedua board.
    Serial.printf("HWINFO:profile=%s,encoders=%d,statusLed=%d,rgb=%d,rgbSlots=%d,vdiv=%d,chg=%d,simulated=%d\n",
                  HW_PROFILE_NAME, NUM_ENCODERS, HAS_STATUS_LED, HAS_RGB, RGB_COUNT,
                  HAS_VDIV, HAS_CHG_STAT, HW_DATA_SIMULATED);
    return;
  }

  if (cmd == "BATT") {
    uint32_t pinMv = 0;
    uint32_t battMv = readBatteryMv(&pinMv);
    ChargeState cs = readChargeState();
    Serial.printf("BATT:pin_mv=%lu,batt_mv=%lu,pct=%d,charging=%d,usb=%d\n",
                  (unsigned long)pinMv, (unsigned long)battMv, battPercentFromMv(battMv),
                  (cs == CHARGE_CHARGING) ? 1 : 0, usbHostConnected() ? 1 : 0);
    return;
  }

  if (cmd.startsWith("RGB:")) {
    if (cmd == "RGB:ON")  { rgbState.enabled = true;  rgbApplyState(); Serial.println("[OK] RGB on");  return; }
    if (cmd == "RGB:OFF") { rgbState.enabled = false; rgbApplyState(); Serial.println("[OK] RGB off"); return; }

    if (cmd.startsWith("RGB:EN:")) {
      long en;
      if (!parseIntRange(cmd.substring(7), 0, 1, en)) { Serial.println("[ERROR] Format RGB:EN:0|1"); return; }
      rgbState.enabled = (en == 1);
      rgbState.dirty = true;
      rgbApplyState();
      Serial.printf("[OK] RGB %s\n", rgbState.enabled ? "on" : "off");
      return;
    }
    if (cmd.startsWith("RGB:BRI:")) {
      long bL;
      if (!parseIntRange(cmd.substring(8), 0, 255, bL)) { Serial.println("[ERROR] Brightness 0-255"); return; }
      rgbState.bri = (uint8_t)bL;
      rgbState.dirty = true;
      rgbApplyState();
      Serial.printf("[OK] RGB brightness %d\n", rgbState.bri);
      return;
    }
    if (cmd.startsWith("RGB:ALL:")) {
      int r, g, b;
      if (sscanf(cmd.c_str() + 8, "%d:%d:%d", &r, &g, &b) != 3 || r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) { Serial.println("[ERROR] Format RGB:ALL:r:g:b"); return; }
      rgbState.color[0] = (uint8_t)r; rgbState.color[1] = (uint8_t)g; rgbState.color[2] = (uint8_t)b;
      for (uint8_t rr = 0; rr < ROWS; rr++)
        for (uint8_t cc = 0; cc < COLS; cc++) {
          rgbState.keys[rr][cc][0] = (uint8_t)r;
          rgbState.keys[rr][cc][1] = (uint8_t)g;
          rgbState.keys[rr][cc][2] = (uint8_t)b;
        }
      rgbState.dirty = true;
      rgbApplyState();
      Serial.println("[OK] RGB semua diset");
      return;
    }
    if (cmd.startsWith("RGB:KEY:")) {
      int row, col, r, g, b;
      if (sscanf(cmd.c_str() + 8, "%d:%d:%d:%d:%d", &row, &col, &r, &g, &b) != 5 || row < 0 || row >= ROWS || col < 0 || col >= COLS ||
          r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) { Serial.println("[ERROR] Format RGB:KEY:row:col:r:g:b"); return; }
      rgbState.keys[row][col][0] = (uint8_t)r;
      rgbState.keys[row][col][1] = (uint8_t)g;
      rgbState.keys[row][col][2] = (uint8_t)b;
      rgbState.dirty = true;
      rgbApplyState();
      Serial.printf("[OK] RGB %d (R%d C%d) diset\n", (int)RGB_INDEX[row][col] + 1, row, col);
      return;
    }
    if (cmd.startsWith("RGB:MODE:")) {
      // Format: RGB:MODE:<mode>:<random>:<r>:<g>:<b>:<speed>
      int mode, rnd, r, g, b, speed;
      if (sscanf(cmd.c_str() + 9, "%d:%d:%d:%d:%d:%d", &mode, &rnd, &r, &g, &b, &speed) != 6 ||
          mode < 0 || mode > 8 || (rnd != 0 && rnd != 1) ||
          r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255 || speed < 0 || speed > 255) {
        Serial.println("[ERROR] Format RGB:MODE:mode:random:r:g:b:speed"); return;
      }
      rgbState.mode   = (uint8_t)mode;
      rgbState.random = (uint8_t)rnd;
      rgbState.color[0] = (uint8_t)r; rgbState.color[1] = (uint8_t)g; rgbState.color[2] = (uint8_t)b;
      rgbState.speed = (uint8_t)speed;
      rgbState.dirty = true;
      rgbApplyState();
      Serial.printf("[OK] RGB mode %d\n", rgbState.mode);
      return;
    }
    if (cmd == "RGB:SAVE") {
      if (rgbPersist()) {
        rgbState.dirty = false;
        Serial.println("[OK] RGB disimpan");
      } else {
        Serial.println("[ERROR] RGB gagal disimpan");
      }
      return;
    }
    if (cmd == "RGB:RESET") {
      rgbStateReset();
      rgbApplyState();
      rgbPersist();
      rgbDump();
      Serial.println("[OK] RGB reset ke default");
      return;
    }
    if (cmd == "RGB:DUMP") { rgbDump(); return; }
    Serial.println("[ERROR] Command RGB tidak dikenal");
    return;
  }

  Serial.println("[ERROR] Command tidak dikenal");
}

// Buffer baris serial.
//
// Sebelumnya dipakai Arduino String yang tumbuh tanpa batas dan O(n^2): tiap byte
// memicu realloc, dan baris yang tidak pernah diakhiri newline akan menumpuk sampai
// kehabisan heap (Arduino ESP32 memanggil abort(), bukan return NULL, saat malloc
// gagal - perangkat mati dan reload config berjalan). Ahora itu, queue RX USB CDC
// hanya 4096 byte dan checkSerialInput tidak berjalan saat ada blokir, jadi saat
// upload batch preset byte bisa hilang dan baris berikutnya menempel ke baris
// terpotong -> desync protokol.
#define SERIAL_LINE_MAX 512
char serialLine[SERIAL_LINE_MAX];
uint16_t serialLineLen = 0;
bool serialOverflow = false;

void serialLineReset() { serialLineLen = 0; serialOverflow = false; }

void checkSerialInput() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (serialOverflow) {
        Serial.println("[ERROR] Baris terlalu panjang, dilewati");
      } else if (serialLineLen > 0) {
        serialLine[serialLineLen] = '\0';
        handleSerialCommand(String(serialLine));
      }
      serialLineReset();
    } else if (c != '\r') {
      if (serialLineLen < SERIAL_LINE_MAX - 1) {
        serialLine[serialLineLen++] = c;
      } else {
        serialOverflow = true;   // buang diam-diam sampai newline berikutnya
      }
    }
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
  USB.serialNumber("MACROPAD-" HW_PROFILE_NAME);
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
  rgbStateReset();
  rgbRestore();
  rgbApplyState();
}

void loop() {
  scanMatrix();
  checkEncoder();
  checkSerialInput();
  // Langkah non-blocking: kedipan LED dan gestur buka aplikasi. Keduanya
  // sebelumnya memakai delay() sehingga loop beku dan penekanan tombol hilang.
  serviceLedBlink();
  serviceOpenApp();
  serviceEscapeBlink();
  updateLed();
  updateRgb();
  reportBatt();
}
