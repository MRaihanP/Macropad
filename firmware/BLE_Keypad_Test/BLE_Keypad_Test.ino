/*
  BLE Keypad — ESP32-S3 Macro Pad 3x3 (versi ringkas)
  ===================================================
  - Keyboard BLE "MacroPad3x3", 9 tombol matrix 3x3 -> angka 1..9
  - Notify selalu memakai conn handle eksplisit (wajib agar jalan di Windows)
  - Serial 115200. Perintah: c = hapus semua bond
  - Hapus bond tanpa Serial: tahan tombol "1" saat reset/boot

  Dependensi: arduino-esp32 core 3.x, NimBLE-Arduino (h2zero) 2.x
  Setelah mengubah GATT/security: hapus bond di ESP32 dan "Remove device" di host, lalu pair ulang.
*/

#include <Arduino.h>
#include <NimBLEDevice.h>

#define BLE_DEVICE_NAME "MacroPad3x3"
#define NO_HANDLE       0xFFFF

#define ROWS 3
#define COLS 3
const uint8_t ROW_PINS[ROWS] = {1, 2, 4};
const uint8_t COL_PINS[COLS] = {5, 6, 7};
const unsigned long KEY_DEBOUNCE_MS = 30;

// Usage HID '1'..'9' = 0x1E..0x26
const uint8_t KEY_USAGE[ROWS][COLS] = {
  {0x1E, 0x1F, 0x20},
  {0x21, 0x22, 0x23},
  {0x24, 0x25, 0x26}
};

// Report map: keyboard (ID 1) + consumer control (ID 2, untuk tombol media/volume jika nanti dibutuhkan)
static const uint8_t HID_REPORT_MAP[] = {
  0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x85, 0x01,
  0x05, 0x07, 0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02,
  0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
  0xC0,
  0x05, 0x0C, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x02,
  0x15, 0x00, 0x26, 0xFF, 0x03, 0x19, 0x00, 0x2A, 0xFF, 0x03, 0x75, 0x10, 0x95, 0x01, 0x81, 0x00,
  0xC0
};

// =================== STATE ===================
static NimBLECharacteristic* bleKbIn = nullptr;
static volatile uint16_t     bleConnHandle = NO_HANDLE;   // satu-satunya penanda "ada koneksi"

bool keyRaw[ROWS][COLS]       = {};
bool keyDebounced[ROWS][COLS] = {};
unsigned long keyChangedAt[ROWS][COLS] = {};

// =================== BLE ===================
// onConnect tidak selalu terpanggil di Windows, jadi handle juga diambil dari callback lain.
class SrvCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo& ci) override { bleConnHandle = ci.getConnHandle(); }
  void onMTUChange(uint16_t, NimBLEConnInfo& ci) override { bleConnHandle = ci.getConnHandle(); }
  void onAuthenticationComplete(NimBLEConnInfo& ci) override {
    bleConnHandle = ci.getConnHandle();
    Serial.printf("[BLE] Pairing selesai (handle=%u, bonded=%d)\n", ci.getConnHandle(), ci.isBonded());
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int reason) override {
    bleConnHandle = NO_HANDLE;
    Serial.printf("[BLE] Putus (reason=0x%X)\n", reason);
  }
};
static SrvCb srvCb;

class KbCb : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic*, NimBLEConnInfo& ci, uint16_t) override { bleConnHandle = ci.getConnHandle(); }
};
static KbCb kbCb;

static void addReportRef(NimBLECharacteristic* c, uint8_t id, uint8_t type) {
  NimBLEDescriptor* d = c->createDescriptor("2908", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC, 2);
  uint8_t ref[2] = {id, type};
  d->setValue(ref, 2);
}

void bleStart() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setSecurityAuth(true, false, true);            // bonding + SC, just works
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  NimBLEDevice::setMTU(247);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(&srvCb, false);
  server->advertiseOnDisconnect(true);

  // Device Information
  NimBLEService* dis = server->createService("180A");
  dis->createCharacteristic("2A29", NIMBLE_PROPERTY::READ)->setValue("DIY Macropad");
  static const uint8_t pnpId[7] = {0x02, 0x3A, 0x30, 0x01, 0x00, 0x01, 0x00};
  dis->createCharacteristic("2A50", NIMBLE_PROPERTY::READ)->setValue(pnpId, 7);

  // Battery (dummy 100%)
  NimBLEService* bat = server->createService("180F");
  static const uint8_t lvl = 100;
  bat->createCharacteristic("2A19", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY)->setValue(&lvl, 1);

  // HID over GATT
  NimBLEService* hid = server->createService("1812");
  static const uint8_t hidInfo[4] = {0x11, 0x01, 0x00, 0x01};
  hid->createCharacteristic("2A4A", NIMBLE_PROPERTY::READ)->setValue(hidInfo, 4);
  hid->createCharacteristic("2A4C", NIMBLE_PROPERTY::WRITE_NR);
  hid->createCharacteristic("2A4B", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC)
     ->setValue(HID_REPORT_MAP, sizeof(HID_REPORT_MAP));
  static const uint8_t proto = 1;                              // report protocol
  hid->createCharacteristic("2A4E", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE_NR)->setValue(&proto, 1);

  static const uint8_t zero8[8] = {0};
  bleKbIn = hid->createCharacteristic("2A4D", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY);
  bleKbIn->setValue(zero8, 8);
  bleKbIn->setCallbacks(&kbCb);
  addReportRef(bleKbIn, 1, 1);                                 // ID 1, Input

  NimBLECharacteristic* kbOut = hid->createCharacteristic("2A4D",
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC |
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE_ENC);
  kbOut->setValue(zero8, 1);
  addReportRef(kbOut, 1, 2);                                   // ID 1, Output (LED)

  NimBLECharacteristic* ccIn = hid->createCharacteristic("2A4D",
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY);
  static const uint8_t zero2[2] = {0, 0};
  ccIn->setValue(zero2, 2);
  addReportRef(ccIn, 2, 1);                                    // ID 2, Input (consumer)

  server->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setName(BLE_DEVICE_NAME);
  adv->setAppearance(0x03C1);                                  // keyboard
  adv->addServiceUUID("1812");
  adv->enableScanResponse(true);
  adv->start(0);
  Serial.println("[BLE] Advertising sebagai " BLE_DEVICE_NAME);
}

// Kirim report keyboard; handle eksplisit wajib. Tanpa koneksi -> dilewati.
void sendReport() {
  uint16_t h = bleConnHandle;
  if (!bleKbIn || h == NO_HANDLE) return;
  uint8_t r[8] = {0};
  uint8_t n = 0;
  for (uint8_t i = 0; i < ROWS; i++)
    for (uint8_t j = 0; j < COLS; j++)
      if (keyDebounced[i][j] && n < 6) r[2 + n++] = KEY_USAGE[i][j];
  if (!bleKbIn->notify(r, 8, h)) {
    delay(6);
    h = bleConnHandle;
    if (h != NO_HANDLE) bleKbIn->notify(r, 8, h);
  }
  delay(8);   // beri waktu host memproses saat mengetik cepat
}

// =================== MATRIX ===================
void scanMatrix() {
  unsigned long now = millis();
  bool changed = false;
  for (uint8_t r = 0; r < ROWS; r++) {
    for (uint8_t rr = 0; rr < ROWS; rr++) digitalWrite(ROW_PINS[rr], rr == r ? LOW : HIGH);
    delayMicroseconds(20);
    for (uint8_t c = 0; c < COLS; c++) {
      bool raw = (digitalRead(COL_PINS[c]) == LOW);
      if (raw != keyRaw[r][c]) { keyRaw[r][c] = raw; keyChangedAt[r][c] = now; }
      if ((now - keyChangedAt[r][c] >= KEY_DEBOUNCE_MS) && (keyRaw[r][c] != keyDebounced[r][c])) {
        keyDebounced[r][c] = keyRaw[r][c];
        changed = true;
        Serial.printf("[KEY] %d %s\n", r * COLS + c + 1, keyDebounced[r][c] ? "down" : "up");
      }
    }
  }
  for (uint8_t rr = 0; rr < ROWS; rr++) digitalWrite(ROW_PINS[rr], HIGH);
  if (changed) sendReport();
}

// =================== SETUP / LOOP ===================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("=== BLE Keypad ===");

  for (uint8_t i = 0; i < ROWS; i++) { pinMode(ROW_PINS[i], OUTPUT); digitalWrite(ROW_PINS[i], HIGH); }
  for (uint8_t i = 0; i < COLS; i++) pinMode(COL_PINS[i], INPUT_PULLUP);

  bleStart();

  // Tahan tombol "1" saat boot => hapus semua bond
  digitalWrite(ROW_PINS[0], LOW);
  delayMicroseconds(50);
  bool clearReq = (digitalRead(COL_PINS[0]) == LOW);
  digitalWrite(ROW_PINS[0], HIGH);
  if (clearReq) {
    NimBLEDevice::deleteAllBonds();
    Serial.println("[BLE] Semua bond dihapus (tombol 1 ditahan saat boot)");
  }
}

void loop() {
  scanMatrix();
  while (Serial.available()) {
    if (Serial.read() == 'c') {
      NimBLEDevice::deleteAllBonds();
      Serial.println("[BLE] Semua bond dihapus. Hapus juga 'MacroPad3x3' di host, lalu pair ulang.");
    }
  }
  delay(1);
}