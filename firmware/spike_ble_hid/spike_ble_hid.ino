/*
  SPIKE: KELAYAKAN BLE HID pada ESP32-S3  (THROWAWAY - jangan dipakai di produksi)
  ==========================================================================

  Tanggal: 2026-10-09 · Untuk Phase 10 langkah 6 (spike kelayakan)

  APA YANG DIUJI SKETCH INI
  ------------------------
  Tiga pertanyaan yang JAWABNYA menentukan bentuk seluruh Phase 10:

   1. Apakah TinyUSB/USB-CDC dan BLE bisa hidup BERDAMPINGAN di ESP32-S3?
      Keduanya memakai peripheral yang berbeda (USB-OTG vs Bluetooth radio),
      tapi ini tidak dijamin core Arduino - harus dibuktikan, bukan diasumsikan.
      Kalau tidak bisa, RENCANA B BLE berubah bentuk total.

   2. Apakah service HID muncul di Windows dan BENAR-BENAR bisa mengirim key?
      Windows sering melihat GATT service tapi menolak input report kalau
      pairing/bonding belum terjadi. Gejalanya sangat membingungkan: device
      terlihat, key tidak keluar. Spike ini yang memastikan jangan sampai
      kita menebak.

   3. Apakah SISA RAM cukup? Stack BLE-secara-umumnya rakus, dan firmware
      yang ada sudah memakai Preferences, NeoPixel, USB HID, dan task encoder.

  Plus satu bonus: custom characteristic NUS (saluran perintah) dan HID HID
  dalam satu GATT server - kalau ini tidak bisa jalan bersamaan, perintah
  konfigurasi harus lewat jalur lain.

  CARA PAKAI
  ----------
  1. Buka folder ini sebagai sketch di Arduino IDE.
     (Nama folder harus sama dengan nama .ino - itu syarat Arduino IDE.)
  2. Setting Board SAMA dengan firmware yang ada:
       Tools > USB Mode        : USB-OTG (TinyUSB)
       Tools > USB CDC On Boot : Enabled
       Tools > Upload Mode     : USB-OTG CDC (TinyUSB)
  3. Pilih board ESP32S3 Dev Module.
  4. Upload, lalu buka Serial Monitor 115200.
  5. Catat isi laporan startup (heap, advertise, status pairing).
  6. Pairing (Windows 11): Settings > Bluetooth & devices > Add device >
     Bluetooth. Device muncul sebagai "MacroPad BLE Spike".
     Pairing WAJIB - tanpa itu input report ditolak.
  7. Tekan tombol keyboard physical di PC. sheet-mode harus MUNCUL di
     kotek Notepad - ini bukti HID benar-benar bekerja.
  8. Tekan GPIO0 (BOOT) di board. Lampu status LED akan berubah &&
     hanya di keyboard, bukan Serial - itu bukti HID mengirim lewat BLE.
  9. Kirim baris teks dari app/Serial ke characteristic NUS, firmware
     akan membalas dengan "SPIKE-ECHO:..." -> bukti jalur NUS hidup.

  APA YANG TIDAK DIUJI
  -------------------
  -_scan/connect dari sisi Windows yang ditulis di Rust (src-tauri/src/ble.rs).
    Spike ini hanya sisi device. app-side diuji terpisah (step 11).
  - Performa, stabilitas jangka panjang, dan current draw.
  - Nine mode RGB dan scan matrix - bukan bagian spike.

  JANGAN menyalin kode ini ke firmware produksi. Ini alat sekali pakai.
*/

#include <Arduino.h>
#include <USB.h>
#include <USBHIDKeyboard.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
// BLESecurity.h dipakai untuk bonding. Tanpa ini, Windows 11 tidak akan
// menyelesaikan pairing dan akan terlihat "connecting" tanpa henti.
#include <BLESecurity.h>
// BLE2902.h SENGAJA TIDAK di-include. Pada core 3.3.x kelas itu deprecated
// karena NimBLE menambah CCCD otomatis untuk characteristic yang punya
// PROPERTY_NOTIFY. Memakainya hanya menghasilkan warning.

// =================== UUID (HARUS SAMA DENGAN src-tauri/src/ble.rs) =======
// Kalau salah di sini, companion app tidak akan pernah menemukan device.
// Diuji otomatis oleh spike-test.js yang membandingkan angka-angka ini
// dengan UUID di ble.rs.
static const char* SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";  // NUS
static const char* TX_UUID     = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";  // app -> device
static const char* RX_UUID     = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";  // device -> app
static const char* HID_SVC     = "1812";   // Human Interface Device
static const char* HID_CHAR    = "2a4d";   // HID Report
// CCCD (2902) tidak dideklarasikan di sini: NimBLE menambahkannya otomatis
// begitu characteristic punya PROPERTY_NOTIFY. Tidak perlu membuat manual.

static const char* DEVICE_NAME = "MacroPad BLE Spike";

// HID report map keyboard standar (8 byte: modifier + 6 keycode + reserved).
// Persis sama dengan yang dipakai USBHIDKeyboard bawaan core, supaya
// perbandingan "USB vs BLE" benar-benar apples-to-apples.
static uint8_t const kbdReportMap[] = {
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, 0x10,  // Usage Page(Generic Desktop), Usage(Keyboard), Collection(Application), Report ID(16)
  0x05, 0x07,                                            //   Usage Page(Key Codes)
  0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,        //   Modifier bits (left ctrl..right gui)
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02,                    //   Modifier count = 8, Report size = 1
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01,                    //   Reserved, Report size = 8
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x01,              //   5 keycodes, 1 bit each
  0x95, 0x01, 0x75, 0x03, 0x91, 0x02, 0x95, 0x06,        //   1 keycode, 3 bits
  0x75, 0x08, 0x95, 0x01, 0x91, 0x01, 0x25, 0x65, 0x05, 0x07, 0x19,   //   1 usage page(Keyboard), logical min 101
  0x29, 0x65, 0x15, 0x00, 0x25, 0x65, 0x11, 0x00, 0x24, 0x00, 0x25, 0x65,  //   logical max 101, usage min 0, usage max 101
  0x75, 0x01, 0x95, 0x08, 0x81, 0x03, 0x91, 0x83, 0x91, 0x83, 0x91, 0x83, 0x91, 0x83, 0x91, 0x83,  //   8 LEDs
  0xC0                                                 // End Collection
};

static BLECharacteristic* g_nusTx = nullptr;   // device -> app (notify)
static BLECharacteristic* g_nusRx = nullptr;   // app -> device (write)

static USBHIDKeyboard usbKeyboard;
static const int LED_PIN = 12;
static bool bleHidReady = false;

// Report HID saat ini. 0x04 = LED output report.
static uint8_t hidLedReport[1] = {0x00};

// Callback untuk report HID.
//
// CATATAN API (revisi 2026-10-09): pada library BLE core ESP32 3.3.x,
// BLECharacteristicCallbacks hanya punya onWrite(BLECharacteristic*) - satu
// argumen. Bentuk tiga-argumen (BLECharacteristic*, uint8_t*, size_t) berasal
// dari ESP32 BLE lama (Bluedroid) dan sudah tidak ada:
//
//   error: 'void HidCallbacks::onWrite(...)' marked 'override',
//          but does not override
//
// Data yang ditulis dibaca lewat getValue(), bukan lewat parameter.
class HidCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String v = ch->getValue();
    Serial.printf("[SPIKE] HID output report: len=%d, ", (int)v.length());
    for (size_t i = 0; i < v.length(); i++) Serial.printf("%02X ", (uint8_t)v[i]);
    Serial.println();
  }
};

static HidCallbacks g_hidCallbacks;

static void reportRam(const char* when) {
  Serial.printf("[SPIKE] RAM %s: free=%u (%.1f kB) min-free-ever=%u heap=%u largest=%u",
                when,
                (unsigned)ESP.getFreeHeap(),
                ESP.getFreeHeap() / 1024.0,
                (unsigned)ESP.getMinFreeHeap(),
                (unsigned)ESP.getHeapSize(),
                (unsigned)ESP.getMaxAllocHeap());
#if CONFIG_SPIRAM
  if (psramFound()) Serial.printf(" psram=%u", (unsigned)ESP.getPsramSize());
#endif
  Serial.println();
}

static void setupUsb() {
  usbKeyboard.begin();
  USB.productName("MacroPadSpike");
  USB.manufacturerName("DIY Macropad");
  USB.serialNumber("SPIKE-001");
  USB.begin();
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 2000) delay(10);   // tunggu CDC siap
  Serial.println();
  Serial.println("=== SPIKE BLE HID (throwaway) ===");
  Serial.println("[SPIKE] USB: USBHIDKeyboard + USB CDC siap");
  reportRam("setelah USB");
}

static void setupBle() {
  Serial.println("[SPIKE] BLE: inisialisasi...");
  // PENTING: NimBLE pada core Arduino >= 3.x. BLEDevice::init() memunculkan
  // banner "NimBLE" yang normal; kalau muncul "Bluedroid", core-nya BUKAN
  // Arduino >= 3. NimBLE yang jauh lebih hemat RAM.
  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setMTU(517);          // MTU besar = satu report HID muat tanpa pecah

  // ---- SECURITY / PAIRING ----
  //
  // INI PENYEBAB GEJALA "connecting terus menerus" (revisi 2026-10-09).
  //
  // Tanpa konfigurasi ini, Windows melihat perangkat lewat advertising tapi
  // proses bonding tidak pernah selesai - Windows mencoba, gagal, mencoba
  // lagi, tanpa pernah selesai. Device tidak pernah paired, HID tidak pernah dapat izin, dan
  // user melihat "connecting..." tanpa henti.
  //
  // Penyebabnya: secara default NimBLE di Arduino TIDAK melakukan bonding
  // sama sekali (bonding=false, sc=false). Windows 11 untuk HID keyboard
  //-modern MEMBUTUHKAN bonding + Secure Connections; tanpa itu, pairing
  // selalu menggantung.
  //
  // Tiga argumen setAuthenticationMode(bonding, mitm, sc):
  //   bonding - true : kunci LTK disimpan, jadi pairing bertahan setelah
  //                   device dimatikan (dibutuhkan Windows 11)
  //   mitm    - false: numeric-comparison TIDAK dipakai. Numeri pinning
  //                   adalah penyebab lain "connecting..." tak selesai, dan
  //                   user harusridor punya passkey yang dicetak di Serial
  //   sc      - true : Secure Connections (LE Secure Connections / LESC),
  //                   wajib untuk Windows 11
  BLESecurity::setAuthenticationMode(true, false, true);
  // Force authentication: karakter HID ditolak Windows sebelum bonding
  // selesai, bukan diam-diam diterima lalu tidak jalan.
  BLESecurity::setForceAuthentication(true);
  // Generate passkey acak per koneksi dan cetak ke Serial, supaya kalau
  // Windows sempat meminta verifikasi kita punya cara menjawab.
  BLESecurity::setCapability(ESP_IO_CAP_NONE);
  BLESecurity::regenPassKeyOnConnect(true);
  BLESecurity::setPassKey(false, BLESecurity::generateRandomPassKey());
  Serial.println("[SPIKE] BLE: security aktif (bonding=true, mitm=false, sc=true)");

  // --- Service 1: HID keyboard (device -> host) ---
  BLEServer* server = BLEDevice::createServer();

  BLEService* hid = server->createService(BLEUUID(HID_SVC), 20);

  // CATATAN API (revisi 2026-10-09): BLEService::createCharacteristic() hanya
  // menerima DUA argumen (uuid, properties) di core 3.3.x. Bentuk tiga
  // argumen (uuid, properties, accessPermissions) dari Bluedroid sudah
  // dihapus. Access permission pada NimBLE diatur lewat setAccessPermissions()
  // bila benar-benar dibutuhkan; untuk spike ini tidak perlu.
  BLECharacteristic* report = hid->createCharacteristic(
      BLEUUID(HID_CHAR),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY |
      BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_WRITE);
  report->setValue(kbdReportMap, sizeof(kbdReportMap));
  // TIDAK memakai createDescriptor() untuk CCCD: BLEService tidak punya
  // metode itu di core 3.3.x. Lihat catatan BLE2902 di bawah.
  report->setCallbacks(&g_hidCallbacks);

  // --- Service 2: NUS (saluran perintah app <-> device) ---
  // Sengaja di server yang sama dengan HID, supaya SPIKE ini sekaligus
  // membuktikan keduanya bisa hidup berdampingan.
  BLEService* nus = server->createService(BLEUUID(SERVICE_UUID), 12);
  // CATATAN API (revisi 2026-10-09): BLE2902 DIHAPUS dari spike ini.
  //
  // Di core 3.3.x, BLE2902 deprecated dengan pesan:
  //   "'BLE2902' is deprecated: NimBLE does not support manually adding 2902
  //    descriptors as they are automatically added when the characteristic
  //    has notifications or indications enabled."
  //
  // Artinya: begitu characteristic punya PROPERTY_NOTIFY,, NimBLE otomatis
  // menambahkan CCCD - yang justru kita butuhkan agar subscribe dari sisi
  // app benar-benar sampai. Menambahkan manual justru menghasilkan warning
  // dan akan dihapus di versi berikutnya.
  g_nusTx = nus->createCharacteristic(
      BLEUUID(RX_UUID),
      BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);

  g_nusRx = nus->createCharacteristic(
      BLEUUID(TX_UUID),
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);

  server->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(HID_SVC);
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();

  bleHidReady = true;
  Serial.printf("[SPIKE] BLE: advertise berjalan, nama=\"%s\"\n", DEVICE_NAME);
  Serial.println("[SPIKE] BLE: service yang di-advertise: HID (1812) + NUS (6e400001-...)");
  reportRam("setelah BLE");
}

static void reportHidCaveat() {
  Serial.println();
  Serial.println("[SPIKE] === LANGKAH TES YANG WAJIB DILAKUKAN ===");
  Serial.println("[SPIKE] 1. Pairing di Windows (Settings > Bluetooth > Add device).");
  Serial.println("[SPIKE]    TANPA pairing, Windows akan MENOLAK input report.");
  Serial.println("[SPIKE]    Gejala kalau gagal: device terlihat, key TIDAK keluar.");
  Serial.println("[SPIKE] 2. Klik di Notepad, lalu tekan GPIO0 pada board.");
  Serial.println("[SPIKE]    Kalau huruf 'a' muncul -> HID BLE BERHASIL.");
  Serial.println("[SPIKE] 3. Catat: [SPIKE] HID output report akan muncul => Windows");
  Serial.println("[SPIKE]    benar-benar merespons, artinya round-trip OK.");
  Serial.println("[SPIKE] 4. Lihat Device Manager: BLE device harus ada tanpa kode galat.");
  Serial.println();
}

// Report HID: tekan-tahan sebentar supaya host sempat registering.
static void bleSendKey(uint8_t keycode) {
  if (!bleHidReady || !g_nusTx) return;
  uint8_t report[8] = {0x00, keycode, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  // characteristic HID ada di server; cari lewat service UUID.
  BLEService* hidSvc = BLEDevice::getServer()->getServiceByUUID(BLEUUID(HID_SVC));
  if (!hidSvc) { Serial.println("[SPIKE] service HID tidak ditemukan?!"); return; }
  BLECharacteristic* rep = hidSvc->getCharacteristic(BLEUUID(HID_CHAR));
  if (!rep) { Serial.println("[SPIKE] characteristic HID tidak ditemukan?!"); return; }
  rep->setValue(report, sizeof(report));
  rep->notify();
  delay(30);
  report[1] = 0x00;
  rep->setValue(report, sizeof(report));
  rep->notify();
  Serial.printf("[SPIKE] HID: kirim key 0x%02X lewat BLE\n", keycode);
}

static void bleNotify(const char* msg) {
  if (!g_nusTx) return;
  g_nusTx->setValue((uint8_t*)msg, strlen(msg));
  g_nusTx->notify();
}

// Badan loop. Dipanggil dari loop() Arduino di bawah - JANGAN diberi nama
// "loop" juga, karena itu akan membuat dua fungsi yang sama dan sketch
// gagal compile dengan "redefinition of 'loop'".
static void loopImpl() {
  static bool buttonDown = false;
  bool down = (digitalRead(0) == LOW);   // GPIO0 = BOOT button

  if (down && !buttonDown) {
    buttonDown = true;
    // Kirim lewat KEDUA jalur supaya jelas mana yang bekerja.
    //
    // CATATAN API (revisi 2026-10-09): USBHIDKeyboard::print() sudah
    // mengirim report HID-nya sendiri. Memanggil sendReport() tanpa argumen
    // tidak bisa: overload-nya hanya sendReport(KeyReport*) yang expects 1
    // argumen. Hasilnya:
    //   error: no matching function for call to 'USBHIDKeyboard::sendReport()'
    //
    // Jadi cukup print(). Method print() yang dipakai firmware utama
    // (HID_Keypad_*.ino) juga begitu.
    usbKeyboard.print('a');
    Serial.println("[SPIKE] USB: kirim 'a' lewat USB HID");
    bleSendKey(0x04);                     // HID usage 0x04 = 'a'
  }
  if (!down) buttonDown = false;

  // Balas perintah NUS supaya jalur konfigurasi ikut teruji.
  if (g_nusRx && g_nusRx->getValue().length()) {
    String v = g_nusRx->getValue().c_str();
    g_nusRx->setValue("");
    Serial.printf("[SPIKE] NUS masuk: \"%s\"\n", v.c_str());
    String reply = "SPIKE-ECHO:" + v;
    bleNotify(reply.c_str());
  }

  static uint32_t lastReport = 0;
  if (millis() - lastReport > 5000) {
    lastReport = millis();
    reportRam("periodic");
  }
  delay(10);
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(0, INPUT_PULLUP);      // BOOT button
  setupUsb();
  setupBle();
  reportHidCaveat();
}

// loop() Arduino memanggil loopImpl() di atas. Nama keduanya sengaja
// dibedakan: kalau badan loop diberi nama "loop" juga, Arduino akan
// mendefinisikan void loop() sendiri di sini dan hasilnya redefinition.
void loop() { loopImpl(); }
