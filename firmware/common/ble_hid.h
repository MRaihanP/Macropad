// =================== BLE HID (HID over GATT) ===================
//
// Modul INDEPENDEN: tidak memakai Transport/USB sama sekali, jadi bisa
// hidup BERSAMAAN dengan USB CDC + USB HID yang sudah ada di firmware.
//
// Port dari firmware/BLE_Keypad_Test/BLE_Keypad_Test.ino yang sudah terbukti
// connect + mengetik di Windows. Yang dipertahankan persis dari sana:
//   - report map (keyboard report ID 1 + consumer report ID 2)
//   - characteristic 2a4a/2a4b/2a4c/2a4d/2a4e + Report Reference descriptor 2908
//   - PnP ID 2a50 + Battery 180F
//   - notify() WAJIB memakai connection handle eksplisit
//   - handle diambil dari 4 callback, di-reset di onDisconnect
//   - advertiseOnDisconnect(true) -> advertising nyala lagi setelah putus
//   - Just Works: bonding + Secure Connections, IO_CAP_NO_INPUT_OUTPUT
//
// Yang berbeda dari aslinya: modul ini bukan firmware mandiri. Ia hanya
// mengirim report keyboard/consumer HID ke host yang sedang terhubung, dan
// pemilihan backend (USB atau BLE) diatur di hid_link.h.

#pragma once

#include <Arduino.h>
#include <NimBLEDevice.h>

// Untuk tipe fan-out di bawah. Kedua header ini sudah punya guard internal
// (SOC_USB_OTG_SUPPORTED / CONFIG_TINYUSB_HID_ENABLED), jadi aman di-include
// di mana saja.
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"

// SERIAL (makro -> g_transport) dipakai untuk log baris "[BLE] ...".
#include "transport.h"

// Nama device BLE. SENGJA sama dengan "MacroPad3x3" supaya bond di host
// (yang dibuat saat firmware BLE_Keypad_Test masih terpasang) tetap cocok
// setelah flashing firmware ini.
#ifndef BLE_HID_DEVICE_NAME
#define BLE_HID_DEVICE_NAME "MacroPad3x3"
#endif

// Nilai sentinel "tidak ada koneksi". 0xFFFF tidak pernah jadi conn handle
// yang valid, jadi aman dipakai sebagai penanda.
#define BLE_HID_NO_HANDLE 0xFFFF

// Report map: keyboard boot-compatible (Report ID 1) + consumer control
// (Report ID 2). Salinan verbatim dari BLE_Keypad_Test.ino.
static const uint8_t BLE_HID_REPORT_MAP[] = {
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

// ------------------------------------------------------------------
// Peta ASCII -> (modifier, HID usage) untuk Keyboard.print()/write().
// USBHIDKeyboard punya peta internal sendiri; modul BLE butuh salinan
// karena report-nya dikirim lewat notify, bukan lewat TinyUSB.
// Modifier memakai bit yang sama dengan KEY_LEFT_* di USBHIDKeyboard.h:
// 0x02 = LeftShift, 0x04 = LeftControl, 0x08 = LeftAlt, 0x10 = LeftGUI.
// ------------------------------------------------------------------
struct BleAsciiEntry { uint8_t ch; uint8_t mod; uint8_t usage; };

static const BleAsciiEntry BLE_ASCII_MAP[] = {
  {' ', 0x00, 0x2C},
  {'!', 0x02, 0x1E}, {'"', 0x02, 0x34}, {'#', 0x02, 0x20}, {'$', 0x02, 0x21},
  {'%', 0x02, 0x22}, {'&', 0x02, 0x24}, {'\'', 0x00, 0x23}, {'(', 0x02, 0x25},
  {')', 0x02, 0x26}, {'*', 0x02, 0x27}, {'+', 0x02, 0x28}, {',', 0x00, 0x36},
  {'-', 0x00, 0x2D}, {'.', 0x00, 0x37}, {'/', 0x00, 0x38},
  {'0', 0x00, 0x27}, {'1', 0x00, 0x1E}, {'2', 0x00, 0x1F}, {'3', 0x00, 0x20},
  {'4', 0x00, 0x21}, {'5', 0x00, 0x22}, {'6', 0x00, 0x23}, {'7', 0x00, 0x24},
  {'8', 0x00, 0x25}, {'9', 0x00, 0x26},
  {':', 0x02, 0x33}, {';', 0x00, 0x33}, {'<', 0x02, 0x64}, {'=', 0x00, 0x2E},
  {'>', 0x02, 0x64}, {'?', 0x02, 0x38}, {'@', 0x02, 0x1F},
  {'[', 0x00, 0x2F}, {'\\', 0x00, 0x31}, {']', 0x00, 0x30}, {'^', 0x02, 0x23},
  {'_', 0x02, 0x37}, {'`', 0x00, 0x35},
  {'a', 0x00, 0x04}, {'b', 0x00, 0x05}, {'c', 0x00, 0x06}, {'d', 0x00, 0x07},
  {'e', 0x00, 0x08}, {'f', 0x00, 0x09}, {'g', 0x00, 0x0A}, {'h', 0x00, 0x0B},
  {'i', 0x00, 0x0C}, {'j', 0x00, 0x0D}, {'k', 0x00, 0x0E}, {'l', 0x00, 0x0F},
  {'m', 0x00, 0x10}, {'n', 0x00, 0x11}, {'o', 0x00, 0x12}, {'p', 0x00, 0x13},
  {'q', 0x00, 0x14}, {'r', 0x00, 0x15}, {'s', 0x00, 0x16}, {'t', 0x00, 0x17},
  {'u', 0x00, 0x18}, {'v', 0x00, 0x19}, {'w', 0x00, 0x1A}, {'x', 0x00, 0x1B},
  {'y', 0x00, 0x1C}, {'z', 0x00, 0x1D},
  {'{', 0x02, 0x2F}, {'|', 0x02, 0x31}, {'}', 0x02, 0x30}, {'~', 0x02, 0x35},
};

static bool bleAsciiToUsage(char c, uint8_t* mod, uint8_t* usage) {
  uint8_t ch = (uint8_t)c;
  if (ch >= 'a' && ch <= 'z') { *mod = 0x00;             *usage = 0x04 + (ch - 'a'); return true; }
  if (ch >= 'A' && ch <= 'Z') { *mod = 0x02;             *usage = 0x04 + (ch - 'A'); return true; }
  for (const BleAsciiEntry& e : BLE_ASCII_MAP) {
    if (e.ch == ch) { *mod = e.mod; *usage = e.usage; return true; }
  }
  return false;
}

// Control chars yang sering dipakai Keyboard.print()/write():
//   '\n' dan '\r' -> Return, '\t' -> Tab, '\b' -> Backspace, 0x1B -> Esc
static bool bleControlToUsage(char c, uint8_t* mod, uint8_t* usage) {
  *mod = 0x00;
  switch (c) {
    case '\n': case '\r': *usage = 0x28; return true;   // Return
    case '\t':             *usage = 0x2B; return true;   // Tab
    case '\b':             *usage = 0x2A; return true;   // Backspace
    case 0x1B:             *usage = 0x29; return true;   // Esc
    default: return false;
  }
}

// ------------------------------------------------------------------
// Handle koneksi tunggal. Callback NimBLE berjalan di task host, jadi
// variabel ini volatile.
// ------------------------------------------------------------------
static volatile uint16_t bleHidConnHandle = BLE_HID_NO_HANDLE;

static bool     bleAdvOk   = true;
static uint16_t bleAdvSize  = 0;
static uint16_t bleScanSize = 0;

// UUID Nordic UART Service - jalur PROTOCOL companion app. Harus sama persis
// dengan companion app (src-tauri/src/ble.rs).
//
// UUID INI IKUT DIDAFTARKAN di advertising (lihat bleHidInit) karena scanner
// companion app memfilter device berdasarkan service UUID, bukan nama.
#define BLE_NUS_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_NUS_TX_UUID     "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_NUS_RX_UUID     "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

static NimBLECharacteristic* bleNusTx = nullptr;
static NimBLECharacteristic* bleNusRx = nullptr;
static volatile uint16_t      bleNusSubCount   = 0;
static volatile uint32_t      bleNusWriteCount = 0;
static char                   bleNusLastWrite[64] = {0};

// Suffix log, biar jelas baris log itu datang dari BLE atau USB.
static void bleLog(const char* msg) {
  SERIAL->printf("[BLE] %s\n", msg);
}

// 6e400002: app menulis perintah ke sini.
//
// NimBLE 2.x memanggil onWrite TANPA payload - data diambil dari nilai
// characteristic itu sendiri (getValue()). Fase ini belum meneruskan ke parser
// perintah; cukup dicatat supaya jalur app -> firmware terbukti hidup.
class BleNusTxCallbacks : public NimBLECharacteristicCallbacks {
public:
  void onWrite(NimBLECharacteristic* chr, NimBLEConnInfo&) override {
    NimBLEAttValue v = chr->getValue();
    uint16_t len = v.length();
    bleNusWriteCount++;
    uint16_t n = len < sizeof(bleNusLastWrite) - 1 ? len : sizeof(bleNusLastWrite) - 1;
    memcpy(bleNusLastWrite, v.data(), n);
    bleNusLastWrite[n] = '\0';
    SERIAL->printf("[BLE] NUS RX: %u byte, isi=\"%s\"\n", (unsigned)len, bleNusLastWrite);
  }
};

// 6e400003: app men-subscribe notifikasi di sini. Hanya setelah ini notify
// benar-benar sampai ke companion app.
class BleNusRxCallbacks : public NimBLECharacteristicCallbacks {
public:
  void onSubscribe(NimBLECharacteristic*, NimBLEConnInfo&, uint16_t) override {
    bleNusSubCount++;
    SERIAL->printf("[BLE] NUS subscribe (total=%u)\n", (unsigned)bleNusSubCount);
  }
};

static BleNusTxCallbacks bleNusTxCb;
static BleNusRxCallbacks bleNusRxCb;

// NimBLE menolak payload advertising > 31 byte secara DIAM-DIAM:
// NimBLEAdvertisementData::addData() mengembalikan false tanpa laporan ke
// Serial, jadi UUID bisa hilang tanpa jejak kalau nilai balik diabaikan.
static void bleAdvCheck(bool ok, const char* what) {
  if (ok) return;
  bleAdvOk = false;
  SERIAL->printf("[BLE] ADV GAGAL: %s\n", what);
}

static void bleAdvReport() {
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  if (adv == nullptr) return;
  bleAdvSize  = (uint16_t)adv->getAdvertisementData().getPayload().size();
  // CATATAN BUG LIBRARY: NimBLE-Arduino 2.5.1 punya getScanData() yang
  // mengembalikan m_advData, bukan m_scanData (NimBLEAdvertising.cpp:375).
  // Ukuran scan response jadi harus dihitung sendiri: 1 byte length +
  // 1 byte type + isi nama. Fungsionalitasnya tidak terpengaruh.
  bleScanSize = (uint16_t)(2 + strlen(BLE_HID_DEVICE_NAME));
  int sisa = (int)BLE_HS_ADV_MAX_SZ - (int)bleAdvSize;
  SERIAL->printf("[BLE] adv ok: adv=%u/%d (sisa %d) scan=%u/%d%s\n",
                 (unsigned)bleAdvSize, (int)BLE_HS_ADV_MAX_SZ, sisa,
                 (unsigned)bleScanSize, (int)BLE_HS_ADV_MAX_SZ,
                 bleAdvOk ? "" : " ADA YANG GAGAL");
}

class BleHidServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, NimBLEConnInfo& ci) override {
    bleHidConnHandle = ci.getConnHandle();
    SERIAL->printf("[BLE] Connect (handle=%u)\n", bleHidConnHandle);
  }
  void onMTUChange(uint16_t, NimBLEConnInfo& ci) override {
    // Windows tidak selalu memanggil onConnect; event ini sering yang pertama.
    bleHidConnHandle = ci.getConnHandle();
  }
  void onAuthenticationComplete(NimBLEConnInfo& ci) override {
    bleHidConnHandle = ci.getConnHandle();
    SERIAL->printf("[BLE] Pairing selesai (handle=%u, bonded=%d)\n",
                   ci.getConnHandle(), ci.isBonded());
  }
  void onDisconnect(NimBLEServer*, NimBLEConnInfo&, int reason) override {
    bleHidConnHandle = BLE_HID_NO_HANDLE;
    SERIAL->printf("[BLE] Putus (reason=0x%X)\n", reason);
  }
};

class BleHidReportRefCallback : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic*, NimBLEConnInfo& ci, uint16_t) override {
    bleHidConnHandle = ci.getConnHandle();
  }
};

// ------------------------------------------------------------------
// Keyboard HID via BLE. Menyimpan state modifier + 6 slot tombol
// (identik dengan KeyReport pada USBHIDKeyboard) lalu mengirim 8 byte
// lewat notify setiap kali state berubah.
// ------------------------------------------------------------------
class BleHidKeyboard {
public:
  void attach(NimBLECharacteristic* inChar) { _in = inChar; }

  bool connected() const { return _in != nullptr && bleHidConnHandle != BLE_HID_NO_HANDLE; }

  void press(uint8_t k) {
    // WAJIB mengikuti pengkodean USBHIDKeyboard persis, karena core memanggil
    // Keyboard.press(KEY_LEFT_CTRL) / Keyboard.write(KEY_RETURN) dengan konstanta
    // dari USBHIDKeyboard.h:
    //   0x80..0x87 -> modifier, bit = (k - 0x80)
    //   0x88..      -> non-printing key, HID usage = (k - 0x88)
    //   < 0x80      -> ASCII, dipetakan lewat tabel di atas
    if (k >= 0x80 && k <= 0x87) {
      _modifiers |= (uint8_t)(1 << (k - 0x80));
    } else if (k >= 0x88) {
      addKey((uint8_t)(k - 0x88));
    } else {
      uint8_t mod, usage;
      if (!bleControlToUsage((char)k, &mod, &usage) && !bleAsciiToUsage((char)k, &mod, &usage)) return;
      _modifiers |= mod;
      addKey(usage);
    }
    send();
  }

  void releaseAll() {
    _modifiers = 0;
    for (uint8_t i = 0; i < 6; i++) _keys[i] = 0;
    send();
  }

  // Setara Keyboard.write(char): tap - tekan lalu lepas.
  void write(char c) {
    press((uint8_t)c);
    delay(2);
    releaseAll();
  }

  void print(const char* s) {
    while (*s) write(*s++);
  }

  void send() {
    if (!connected()) return;
    uint8_t report[8] = {_modifiers, 0, _keys[0], _keys[1], _keys[2], _keys[3], _keys[4], _keys[5]};
    bleNotify(_in, report, sizeof(report));
  }

private:
  void addKey(uint8_t usage) {
    if (!usage) return;
    for (uint8_t i = 0; i < 6; i++) {
      if (_keys[i] == usage) return;          // sudah ada, jangan dobel
      if (_keys[i] == 0) { _keys[i] = usage; return; }
    }
  }

  // notify() tanpa handle eksplisit diam-diam tidak sampai ke host di Windows.
  // Kalau gagal, coba ulang sekali setelah handle di-refresh.
  static void bleNotify(NimBLECharacteristic* c, const uint8_t* data, size_t len) {
    uint16_t h = bleHidConnHandle;
    if (c == nullptr || h == BLE_HID_NO_HANDLE) return;
    if (!c->notify(data, len, h)) {
      delay(6);
      h = bleHidConnHandle;
      if (h != BLE_HID_NO_HANDLE) c->notify(data, len, h);
    }
  }

  NimBLECharacteristic* _in = nullptr;
  uint8_t _modifiers = 0;
  uint8_t _keys[6] = {0, 0, 0, 0, 0, 0};
};

// ------------------------------------------------------------------
// Consumer control (volume/mute/play) via BLE: report 2 byte, sama
// seperti di BLE_Keypad_Test.ino.
// ------------------------------------------------------------------
class BleHidConsumer {
public:
  void attach(NimBLECharacteristic* inChar) { _in = inChar; }
  bool connected() const { return _in != nullptr && bleHidConnHandle != BLE_HID_NO_HANDLE; }

  void press(uint16_t usage) {
    _usage = usage;
    if (!connected()) return;
    uint8_t r[2] = {(uint8_t)(usage & 0xFF), (uint8_t)(usage >> 8)};
    if (!_in->notify(r, 2, bleHidConnHandle)) {
      delay(6);
      if (bleHidConnHandle != BLE_HID_NO_HANDLE) _in->notify(r, 2, bleHidConnHandle);
    }
  }

  void release() {
    _usage = 0;
    if (!connected()) return;
    uint8_t r[2] = {0, 0};
    if (!_in->notify(r, 2, bleHidConnHandle)) {
      delay(6);
      if (bleHidConnHandle != BLE_HID_NO_HANDLE) _in->notify(r, 2, bleHidConnHandle);
    }
  }

private:
  NimBLECharacteristic* _in = nullptr;
  uint16_t _usage = 0;
};

// ------------------------------------------------------------------
// Inisialisasi GATT. Dipanggil sekali dari setup() lewat PROFILE_HOOK_SETUP.
// ------------------------------------------------------------------
static BleHidServerCallbacks   bleHidSrvCb;
static BleHidReportRefCallback bleHidRefCb;

// Instance global. Satu-satunya definisi di seluruh firmware; hid_link.h hanya
// memakainya. Non-static supaya tidak ada duplikat bila header masuk lewat
// jalur include lain.
BleHidKeyboard BleKeyboard;
BleHidConsumer BleConsumer;

static void bleAddReportRef(NimBLECharacteristic* c, uint8_t id, uint8_t type) {
  NimBLEDescriptor* d = c->createDescriptor("2908",
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC, 2);
  uint8_t ref[2] = {id, type};
  d->setValue(ref, 2);
}

// Hapus semua bond di sisi device. Dipanggil dari gesture boot (tahan tombol).
static void bleHidClearBonds() {
  if (NimBLEDevice::deleteAllBonds()) bleLog("Semua bond dihapus (hapus juga device di host, lalu pair ulang)");
  else                                   bleLog("Gagal menghapus bond");
}

static void bleHidInit() {
  NimBLEDevice::init(BLE_HID_DEVICE_NAME);
  NimBLEDevice::setSecurityAuth(true, false, true);   // bonding + SC, Just Works
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
  NimBLEDevice::setMTU(247);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(&bleHidSrvCb, false);
  server->advertiseOnDisconnect(true);                // wajib, default-nya false

  // Device Information (PnP ID sama dengan versi yang sudah pernah ke-bond)
  NimBLEService* dis = server->createService("180A");
  dis->createCharacteristic("2A29", NIMBLE_PROPERTY::READ)->setValue("DIY Macropad");
  static const uint8_t pnpId[7] = {0x02, 0x3A, 0x30, 0x01, 0x00, 0x01, 0x00};
  dis->createCharacteristic("2A50", NIMBLE_PROPERTY::READ)->setValue(pnpId, 7);

  // Battery (nilai tetap 100%; sesuai isi BLE_Keypad_Test.ino)
  NimBLEService* bat = server->createService("180F");
  static const uint8_t lvl = 100;
  bat->createCharacteristic("2A19", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY)->setValue(&lvl, 1);

  // HID over GATT
  NimBLEService* hid = server->createService("1812");
  static const uint8_t hidInfo[4] = {0x11, 0x01, 0x00, 0x01};
  hid->createCharacteristic("2A4A", NIMBLE_PROPERTY::READ)->setValue(hidInfo, 4);
  hid->createCharacteristic("2A4C", NIMBLE_PROPERTY::WRITE_NR);
  hid->createCharacteristic("2A4B", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC)
     ->setValue(BLE_HID_REPORT_MAP, sizeof(BLE_HID_REPORT_MAP));
  static const uint8_t proto = 1;
  hid->createCharacteristic("2A4E", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE_NR)->setValue(&proto, 1);

  // Report keyboard (Report ID 1) - payload 8 byte TANPA byte report id,
  // persis seperti firmware yang sudah terbukti jalan di Windows.
  static const uint8_t zero8[8] = {0};
  NimBLECharacteristic* kbIn = hid->createCharacteristic("2A4D",
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY);
  kbIn->setValue(zero8, 8);
  kbIn->setCallbacks(&bleHidRefCb);
  bleAddReportRef(kbIn, 1, 1);
  BleKeyboard.attach(kbIn);

  NimBLECharacteristic* kbOut = hid->createCharacteristic("2A4D",
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC |
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE_ENC);
  kbOut->setValue(zero8, 1);
  bleAddReportRef(kbOut, 1, 2);   // Report ID 1, Output (LED)

  // Report consumer control (Report ID 2)
  NimBLECharacteristic* ccIn = hid->createCharacteristic("2A4D",
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::NOTIFY);
  static const uint8_t zero2[2] = {0, 0};
  ccIn->setValue(zero2, 2);
  bleAddReportRef(ccIn, 2, 1);
  BleConsumer.attach(ccIn);

  // NUS - jalur PROTOCOL companion app (EVT:, [KEY], jawaban perintah).
  // Berada di server & koneksi yang sama dengan HID, jadi tidak ada pairing
  // tambahan dan tidak ada link BLE kedua yang harus dijaga.
  //
  // 6e400002 SENGAJA tanpa _ENC: write pertama dari app bisa terjadi sebelum
  // link terenkripsi saat pairing pertama; dengan _ENC write itu ditolak.
  NimBLEService* nus = server->createService(BLE_NUS_SERVICE_UUID);
  static const uint8_t nusIdle[1] = {0};

  bleNusTx = nus->createCharacteristic(BLE_NUS_TX_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  bleNusTx->setCallbacks(&bleNusTxCb);
  bleNusTx->setValue(nusIdle, 1);

  bleNusRx = nus->createCharacteristic(BLE_NUS_RX_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  bleNusRx->setCallbacks(&bleNusRxCb);
  bleNusRx->setValue(nusIdle, 1);

  server->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();

  // ---- URUTAN PENTING ----
  // enableScanResponse(true) HARUS dipanggil SEBELUM setName().
  //
  // Alasannya ada di NimBLE: setName() menaruh nama ke scan response HANYA kalau
  // m_scanResp sudah true, selain itu ke advertising payload. Dan
  // enableScanResponse() hanya menyalakan flag - TIDAK memindahkan data yang
  // sudah terlanjur ada. Jadi kalau urutannya terbalik (seperti versi lama),
  // nama "MacroPad3x3" (13 byte) ikut memakan advertising payload dan menyisakan
  // hanya 7 byte.
  //
  // 7 byte itu tidak cukup untuk UUID NUS 128-bit (18 byte) yang akan
  // ditambahkan di fase berikutnya. Dan NimBLE menolak payload > 31 byte secara
  // diam-diam (NimBLEAdvertisementData::addData() -> return false), sehingga
  // UUID bisa hilang tanpa jejak dan device tidak pernah muncul di daftar.
  adv->enableScanResponse(true);

  // Nilai balik TIDAK BOLEH diabaikan - addData() gagal tanpa suara kalau
  // payload melewati batas, dan urutan salah satu saja sudah cukup untuk
  // membuatnya terjadi.
  bleAdvCheck(adv->setName(BLE_HID_DEVICE_NAME), "name");
  bleAdvCheck(adv->setAppearance(0x03C1), "appearance");   // 0x03C1 = keyboard
  bleAdvCheck(adv->addServiceUUID("1812"), "uuid 1812");

  // UUID NUS ikut advertising karena scanner companion app memfilter
  // berdasarkan service UUID, bukan berdasarkan nama device.
  //
  // Ini yang dulu membuat device tidak pernah ditemukan: 11 + 18 = 29 byte,
  // masih muat di 31 - TAPI hanya karena nama sudah pindah ke scan response.
  // Kalau urutannya salah, payload jadi 24 + 18 = 42 byte, addData() menolak
  // diam-diam, dan UUID hilang tanpa jejak.
  bleAdvCheck(adv->addServiceUUID(BLE_NUS_SERVICE_UUID), "uuid NUS");

  adv->start(0);

  // Laporkan ukuran payload SEBENARNYA, bukan hasil hitungan manual. Ini satu-
  // satu-satunya cara memastikan payload advertising tidak diam-diam kehilangan
  // UUID.
  bleAdvReport();

  bleLog("Advertising sebagai " BLE_HID_DEVICE_NAME " (HID over GATT)");
}

// ------------------------------------------------------------------
// Kontrol sisi BLE untuk hid_link.h dan perintah Serial.
//
// Syarat "IFACE:USB membuat semua fungsi BLE tidak berjalan" dijawab di sini:
//   bleHidStop()  - peer diputus, advertising dimatikan
//   bleHidStart() - advertising dinyalakan lagi
//
// Dispatcher USB<->BLE tidak ada di modul ini; itu tugas hid_link.h.
// ------------------------------------------------------------------

// Diputuskan saat mode USB. Peer diputus supaya Windows tidak menyimpan entri
// keyboard yang tidak akan pernah mengirim apa-apa (hanya bisa hilang lewat
// "Remove device" manual), dan advertising dimatikan supaya device hilang dari
// daftar perangkat Bluetooth.
inline void bleHidStop() {
  if (!NimBLEDevice::isInitialized()) return;

  NimBLEServer* server = NimBLEDevice::getServer();
  uint16_t h = bleHidConnHandle;
  if (server != nullptr && h != BLE_HID_NO_HANDLE) {
    server->disconnect(h);
    bleLog("Peer diputus (mode USB)");
  }
  bleHidConnHandle = BLE_HID_NO_HANDLE;

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr && adv->isAdvertising()) {
    adv->stop();
    bleLog("Advertising dimatikan (mode USB)");
  }
}

// Dipanggil saat mode BLE. Advertising dinyalakan kalau belum jalan, supaya
// device langsung muncul untuk pairing tanpa perlu restart firmware.
inline void bleHidStart() {
  if (!NimBLEDevice::isInitialized()) return;
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  if (adv != nullptr && !adv->isAdvertising()) {
    adv->start(0);
    bleLog("Advertising dinyalakan (mode BLE)");
  }
}

inline bool bleHidAdvertising() {
  if (!NimBLEDevice::isInitialized()) return false;
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  return (adv != nullptr) && adv->isAdvertising();
}

inline bool bleHidConnected() {
  return bleHidConnHandle != BLE_HID_NO_HANDLE;
}
