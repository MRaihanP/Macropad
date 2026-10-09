/*
  SPIKE v2: BLE HID keyboard yang SIMPEL & AWET  (THROWAWAY - jangan dipakai produksi)
  ===========================================================================

  Tanggal: 2026-10-09 · Pengganti spike_ble_hid.ino v1
  Versi app: v0.2.0


  MENGAPA v1 GAGAL: "sudah pair, beberapa detik kemudian disconnect sendiri,
  lalu tidak bisa connect lagi"
  ----------------------------------------------------------------------

  v1 forego lima hal. Semuanya DIBUKTI dari source core Arduino ESP32 3.3.11
  yang terpasang di C:\Users\Raihan\AppData\Local\Arduino15, bukan ditebak.

  BUG 1 (INI SEBAB UTAMA): advertising tidak di-restart setelah disconnect.
    BLEServer.cpp:93
        m_advertiseOnDisconnect = false;      // DEFAULT!
    BLEServer.cpp:854-858
        #if !defined(CONFIG_BT_NIMBLE_EXT_ADV)
          if (server->m_advertiseOnDisconnect) {
            server->startAdvertising();
          }
        #endif
    v1 tidak pernah memanggil advertiseOnDisconnect(true) dan tidak punya
    BLEServerCallbacks sama sekali. Efeknya: begitu Windows memutus link,
    perangkat BERHENTI MENGADVERTISE PERMANEN. Perangkat hilang dari daftar
    dan tidak akan pernah ditemukan lagi - persis gejala "tidak bisa connect
    lagi". Bukan Windows yang menolak: perangkatnya yang hilang.

  BUG 2: passkey di-regenerate tiap koneksi, padahal tidak dipakai.
    v1: setCapability(ESP_IO_CAP_NONE)   -> "Just Works", tanpa passkey
        setPassKey(false, random)        -> tetap membuat passkey acak
        regenPassKeyOnConnect(true)      -> diganti tiap koneksi
        setForceAuthentication(true)    -> security dipaksa saat connect
   mitm=false + IO_CAP_NONE berarti pairing TIDAK PERNAH memakai passkey.
    Passkey acak yang berubah tiap koneksi hanya merusak bond: Windows menyimpan
    LTK dari sesi pertama, sedangkan perangkat menagih yang berbeda setiap
    kali connect. Kombinasi inilah yang bikin link terhubung lalu langsung putus.

  BUG 3: service HID dibangun tangan, tanpa characteristic wajib.
    Yang wajib ada di service HID (BLEHIDDevice.cpp:73-76):
        2a4a HID Information     2a4b Report Map
        2a4c HID Control Point   2a4e Protocol Mode
    Plus Report Reference Descriptor (2908) per report (BLEHIDDevice.cpp:170).
    Plus PnP ID 2a50 di Device Information Service.
    v1 hanya membuat 1812 + 2a4d. Windows HOGP butuh semua yang di atas
    untuk menyelesaikan enumerasi; tanpa itu host bisa membatalkan koneksi.

  BUG 4: Report Map bilang Report ID 1, tapi report yang dikirim tidak punya.
    v1 report map: 0x85, 0x10   -> Report ID = 0x10 (16)
    v1 bleSendKey(): uint8_t report[8] = {0x00, keycode, ...}
                      tidak ada byte Report ID sama sekali.
    Panjang Report ID 0x10 + 8 byte data = 9 byte. Host menerima 8 dan
    menggeser semua field -> state HID rusak -> Windows drop koneksi.

  BUG 5: bleSendKey() mencari service & characteristic lewat UUID tiap satu
    ketikan. Alokasi + lookup di tengah koneksi = jank, dan kalau gagal
    diam-diam tidak ada error.


  YANG DIPERBAIKAN DI v2
  ---------------------
  1. Pakai BLEHIDDevice dari library core (bukan bangun sendiri).
     Dipakai persis seperti examples/Server_Gamepad/Server_Gamepad.ino.
  2. server->advertiseOnDisconnect(true)  <- perbaikan wajib.
  3. BLEServerCallbacks dengan log connect/disconnect + watchdog yang
     me-restart advertising setiap 5 detik selama belum terhubung.
  4. "Just Works": tanpa passkey, tanpa regen, tanpa force authentication.
  5. Report ID 1 di map DAN di payload. 9 byte.
  6. Pointer characteristic disimpan sekali di setup, tidak dicari per ketikan.
  7. Nama perangkat pendek & tetap: "MacroPad". Nama panjang dipangkas Windows dan
     membuat cache bond lama tidak cocok.
  8. Perintah Serial untuk diagnosa tanpa perlu flash ulang.


  CARA PAKAI
  ----------
  1. Buka folder ini sebagai sketch di Arduino IDE.
  2. Setting board SAMA dengan firmware produksi:
       Tools > USB Mode        : USB-OTG (TinyUSB)
       Tools > USB CDC On Boot : Enabled
       Tools > Upload Mode     : USB-OTG CDC (TinyUSB)
     Board: ESP32S3 Dev Module
  3. Upload, buka Serial Monitor 115200.
  4. JANGAN pair dulu. Ketik "adv" lalu "scan" - pastikan perangkat terlihat.
  5. Pair di Windows (Settings > Bluetooth & devices > Add device > Bluetooth).
     Device muncul sebagai "MacroPad" dengan ikon keyboard.
     Pairing SEKALI saja. Kalau Windows masih menyimpan bond dari spike v1
     dengan nama "MacroPad BLE Spike", hapus device itu di Windows DULU.
  6. Klik Notepad, tekan GPIO0 di board.
     - Serial monitor menampilkan "[KEY] kirim ..."
     - di Notepad MUNCUL huruf  -> HID BERHASIL
  7. Cabut USB lalu colok lagi dalam 10 detik. Kalau Windows tidak pernah
    ']);
  8. Uji NUS: dari Serial Monitor ketik "echo halo", device membalas "SPIKE-ECHO:halo"
     lewat notify - TAPI hanya kalau app sudah subscribe dulu (lihat "sub").


  PERINTAH SERIAL (ketik di Serial Monitor, lalu Enter)
  ----------------------------------------------------
     help              - daftar perintah
     key a             - kirim huruf 'a' lewat BLE HID
     key ctrl+c        - kirim Ctrl+C
     usbkey a          - kirim 'a' lewat USB HID (bandingkan!)
     adv               - (re)start advertising
     status            - status advertise/connect/peer
     scan              - matikan advertising 10 detik supaya bisa di-scan
     echo <teks>       - uji jalur NUS (balas lewat notify)
     sub on|off        - nyalakan/matikan notifikasi NUS (default off)
     clear             - hapus bond tersimpan di perangkat
     ram               - laporan RAM sekarang

  "sub off" itu default karena notify tanpa subscriber bisa memicu error
  pada stack NimBLE. Nyalakan hanya saat benar-benar mau menguji NUS.


  APA YANG TIDAK DIUJI
  -------------------
  - Scan/connect dari sisi Windows lewat Rust (src-tauri/src/ble.rs). Itu
    diuji terpisah di step 11.
  - USB HID tetap dipertahankan HANYA sebagai pembanding A/B.
*/

#include <Arduino.h>
#include <USB.h>
#include <USBHIDKeyboard.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLEHIDDevice.h>
#include <BLESecurity.h>

// ============================ KONSTANTA ============================

// UUID NUS HARUS SAMA dengan src-tauri/src/ble.rs. Diuji otomatis oleh
// spike2-test.js yang membandingkan string ini dengan file Rust tersebut.
static const char* SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";  // NUS service
static const char* TX_UUID     = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";  // app -> device
static const char* RX_UUID     = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";  // device -> app

// Nama PENDEK dan TETAP. Nama panjang dipangkas Windows sehingga device bisa
// muncul sebagai "MacroPad B..." lalu bond tersimpan tidak cocok saat flash
// ulang dengan nama lain. "MacroPad" persis = 9 karakter, aman.
static const char* DEVICE_NAME = "MacroPad";

// PnP ID: signature 0x02 (USB Implementer Forum), VID/PID.
// 0x1209 = pid.codes (vendor publik, tidak mencuri ID siapa pun).
static const uint16_t PNP_VID = 0x1209;
static const uint16_t PNP_PID = 0x0001;

// Report ID. HARUS sama dengan yang tertulis di report map (0x85, 0x01).
// Bug v1: map menyebut Report ID tapi payload tidak mengirim byte itu.
static const uint8_t REPORT_ID_KEYBOARD = 0x01;

static const int LED_PIN = 12;
static const int BTN_PIN = 0;    // GPIO0 = tombol BOOT

// Report map keyboard 8 tombol. Byte ke-4 adalah Report ID = 0x01.
static uint8_t const kbdReportMap[] = {
  0x05, 0x01,        // Usage Page (Generic Desktop)
  0x09, 0x06,        // Usage (Keyboard)
  0xA1, 0x01,        // Collection (Application)
  0x85, 0x01,        //   Report ID (1)   <-- harus cocok dengan payload
  0x05, 0x07,        //   Usage Page (Key Codes)
  0x19, 0xE0, 0x29, 0xE7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02,   // 8 bit modifier
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01,   // 1 byte reserved
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x01, 0x19, 0x01, 0x29, 0x05,
  0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x05, 0x81, 0x02,   // 5 key + 1 key
  0x05, 0x08, 0x19, 0x01, 0x29, 0x05,
  0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x05, 0x81, 0x02,   // 5 LED
  0x05, 0x08, 0x19, 0x01, 0x29, 0x65,
  0x15, 0x00, 0x25, 0x65, 0x75, 0x08, 0x95, 0x06, 0x81, 0x00,   // 6 byte reserved
  0xC0               // End Collection
};

// 9 byte: 1 Report ID + 8 byte data keyboard.
struct KbdReport {
  uint8_t reportId;
  uint8_t modifiers;
  uint8_t keys[6];
};

// ============================ STATE ============================

static BLEServer*         g_server      = nullptr;
static BLECharacteristic* g_kbdReport   = nullptr;  // HID, diisi SEKALI di setup
static BLECharacteristic* g_nusTx       = nullptr;  // device -> app
static BLECharacteristic* g_nusRx       = nullptr;  // app -> device

static USBHIDKeyboard g_usbKeyboard;

static volatile bool g_connected    = false;
static volatile bool g_nusNotifyOn  = false;  // default OFF: notify tanpa
                                            // subscriber bisa error di NimBLE
static uint32_t      g_advWatchdog  = 0;      // restart advertise tiap 5 dtk
static uint32_t      g_pauseUntil   = 0;      // "scan" mematikan adv sementara
static uint32_t      g_bootMs       = 0;

// Buffer baris perintah Serial. Dideklarasikan DI SINI, bukan di dekat
// loopImpl(): di C++ memakai nama sebelum dideklarasikan adalah compile error,
// dan ini persis kelas kesalahan yang sudah pernah menimpa firmware proyek ini.
static String g_serLine = "";

// ============================ LOG ============================

static void logLine(const char* s) {
  Serial.print("[S2] ");
  Serial.println(s);
}

static void reportRam(const char* when) {
  Serial.printf("[S2] RAM %s: free=%u (%.1f kB) min-free-ever=%u heap=%u largest=%u",
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

// ============================ CALLBACKS ============================

// Bug v1: tidak punya BLEServerCallbacks sama sekali, jadi tidak ada yang
// me-restart advertising dan tidak ada yang memberi tahu kita terjadi apa.
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    g_connected = true;
    logLine("TERHUBUNG ke host.");
    Serial.print("[S2] stack BLE yang dipakai: ");
    Serial.println(BLEDevice::getBLEStackString().c_str());
    reportRam("saat connect");
    // Advertising berhenti dengan sendirai saat ada koneksi. Tidak perlu
    // diapa-apakan; yang penting Advertising akan dinyalakan lagi saat disconnect.
  }

  void onDisconnect(BLEServer* s) override {
    g_connected = false;
    logLine("TERPUTUS dari host. Advertising di-restart.");
    // PENGAMAN LAPIS KEDUA. Lapis pertama sudah advertiseOnDisconnect(true),
    // tapi kalau host yang initiating disconnect, ada momen di mana gap
    // event-nya tidak sampai, dan tanpa panggilan eksplisit di sini
    // perangkat akan hilang diam-diam - persis gejala v1.
    BLEDevice::startAdvertising();
    g_advWatchdog = millis();     // reset jeda watchdog
    reportRam("saat disconnect");
  }
};

// "Just Works": accept semuanya, jangan pernah Print passkey karena tidak ada.
class SecurityCallbacks : public BLESecurityCallbacks {
  bool onSecurityRequest() override { return true; }
  uint32_t onPassKeyRequest() override { return 0; }
  void onPassKeyNotify(uint32_t key) override {}
  bool onConfirmPIN(uint32_t pin) override { return true; }

#if defined(CONFIG_BLUEDROID_ENABLED)
  void onAuthenticationComplete(esp_ble_auth_cmpl_t auth) override {
    Serial.printf("[S2] pairing %s (fail_reason=%d)\n",
                  auth.success ? "BERHASIL" : "GAGAL", auth.fail_reason);
  }
#elif defined(CONFIG_NIMBLE_ENABLED)
  void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
    Serial.printf("[S2] pairing %s (err=%d)\n",
                  desc->sec_state.encrypted ? "BERHASIL" : "GAGAL",
                  (int)desc->sec_state.authenticated);
  }
#endif
};

// Report LED dari host (proof round-trip: Windows benar-benar merespons).
class HidCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String v = ch->getValue();
    Serial.printf("[S2] host kirim output report: len=%d data=", (int)v.length());
    for (size_t i = 0; i < v.length(); i++) Serial.printf("%02X ", (uint8_t)v[i]);
    Serial.println();
  }
};

static HidCallbacks g_hidCallbacks;

// ============================ USB ============================

static void setupUsb() {
  g_usbKeyboard.begin();
  USB.productName("MacroPadSpike");
  USB.manufacturerName("DIY Macropad");
  USB.serialNumber("SPIKE2-001");
  USB.begin();
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 2000) delay(10);
  Serial.println();
  Serial.println("=== SPIKE v2 BLE HID (throwaway) ===");
  logLine("USB: USBHIDKeyboard + USB CDC siap");
  reportRam("setelah USB");
}

// ============================ BLE ============================

static void setupBle() {
  logLine("BLE: inisialisasi...");

  BLEDevice::init(DEVICE_NAME);
  // MTU 517: report HID 9 byte muat tanpa pecah. Kalau host hanya mau MTU
  // lebih kecil, link layer otomatis memotong - aman, jadi tidak perlu
  // dikhawatirkan.
  BLEDevice::setMTU(517);

  // ---- SECURITY: JUST WORKS, TANPA PASSKEY ----
  //
  // Bug v2 yang DIHINDARI (dibanding v1):
  //   v1: setPassKey(false, generateRandomPassKey()) + regenPassKeyOnConnect(true)
  //       + setForceAuthentication(true)
  // Semua itu TIDAK PERLU. mitm=false + IO_CAP_NONE = pairing tidak pernah
  // memakai passkey. Memaksa passkey acak yang berubah tiap koneksi hanya
  // merusak bond sehingga Windows dan perangkat tidak punya kunci yang sama,
  // dan link putus sendiri.
  //
  // Pola ini identik dengan examples/Server_Gamepad yang sudah dipakai luas.
  BLESecurity* sec = new BLESecurity();
  sec->setCapability(ESP_IO_CAP_NONE);      // Just Works - seperti gamepad asli
  sec->setAuthenticationMode(true, false, true);  // bonding, tanpa MITM, dengan SC
  BLEDevice::setSecurityCallbacks(new SecurityCallbacks());
  logLine("BLE: security = Just Works (bonding ya, MITM tidak, passkey tidak dipakai)");

  // ---- Server ----
  g_server = BLEDevice::createServer();
  g_server->setCallbacks(new ServerCallbacks());

  // PERBAIKAN UTAMA v1 -> v2. Default core adalah false (BLEServer.cpp:93),
  // artinya begitu host disconnect perangkat berhenti advertise PERMANEN dan
  // tidak akan pernah ditemukan lagi.
  g_server->advertiseOnDisconnect(true);
  logLine("BLE: advertiseOnDisconnect = true (perbaikan utama vs v1)");

  // ---- HID lewat BLEHIDDevice (service wajib dibuat lengkap otomatis) ----
  BLEHIDDevice* hid = new BLEHIDDevice(g_server);
  hid->manufacturer()->setValue("DIY Macropad");
  hid->pnp(0x02, PNP_VID, PNP_PID, 0x0110);
  hid->hidInfo(0x00, 0x01);
  hid->reportMap((uint8_t*)kbdReportMap, sizeof(kbdReportMap));
  hid->setBatteryLevel(100);

  // Dipanggil SEKALI di sini, hasilnya disimpan. Bug v1: mencari service &
  // characteristic lewat UUID di dalam loop setiap satu ketikan.
  g_kbdReport = hid->inputReport(REPORT_ID_KEYBOARD);
  g_kbdReport->setCallbacks(&g_hidCallbacks);

  // ---- NUS di server yang sama (bukti kedua service cohabit) ----
  BLEService* nus = g_server->createService(BLEUUID(SERVICE_UUID), 12);
  g_nusTx = nus->createCharacteristic(BLEUUID(RX_UUID),
      BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
  g_nusRx = nus->createCharacteristic(BLEUUID(TX_UUID),
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);

  // Memulai device info + HID + battery + NUS sekaligus.
  hid->startServices();

  // ---- Advertising ----
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->setAppearance(0x03C1);            // HID Keyboard: Windows tampilkan sbg keyboard
  adv->addServiceUUID(hid->hidService()->getUUID());
  adv->addServiceUUID(BLEUUID(SERVICE_UUID));
  adv->setScanResponse(true);            // nama device masuk scan response
  adv->setMinPreferred(0x06);            // helps Windows negotiate koneksi
  adv->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();

  logLine("BLE: advertise jalan. Nama = \"MacroPad\" (HID 1812 + NUS 6e400001-...)");
  reportRam("setelah BLE");
}

// ============================ KIRIM KEY ============================

// Usage keycodes HID yang dipakai spike ini. Satu byte per tombol.
static const uint8_t KEY_C = 0x03;
static const uint8_t KEY_A = 0x04;

static void bleSendKey(uint8_t modifiers, const uint8_t* keys, size_t nkeys) {
  if (!g_connected) {
    Serial.println("[KEY] gagal: belum terhubung");
    return;
  }
  if (!g_kbdReport) {
    Serial.println("[KEY] gagal: characteristic HID tidak ada");
    return;
  }

  KbdReport r;
  r.reportId   = REPORT_ID_KEYBOARD;   // byte Report ID - INI YANG V1 HILANG
  r.modifiers  = modifiers;
  memset(r.keys, 0, sizeof(r.keys));
  for (size_t i = 0; i < nkeys && i < 6; i++) r.keys[i] = keys[i];

  g_kbdReport->setValue((uint8_t*)&r, sizeof(r));
  g_kbdReport->notify();

  // Tekan sebentar supaya host sempat mendaftarkan report, lalu lepas.
  // Tanpa jeda, beberapa host menutup connection sebelum sempat membaca.
  delay(40);
  r.modifiers = 0;
  memset(r.keys, 0, sizeof(r.keys));
  g_kbdReport->setValue((uint8_t*)&r, sizeof(r));
  g_kbdReport->notify();

  Serial.printf("[KEY] kirim via BLE: mod=0x%02X key0=0x%02X (%u byte)\n",
                modifiers, nkeys ? keys[0] : 0, (unsigned)sizeof(r));
}

static void bleNotify(const char* msg) {
  if (!g_nusNotifyOn) return;      // subscriber belum aktif -> jangan kirim
  if (!g_connected) return;
  g_nusTx->setValue((uint8_t*)msg, strlen(msg));
  g_nusTx->notify();
}

// ============================ PERINTAH SERIAL ============================

static void cmdKey(const String& arg) {
  String a = arg;
  a.toLowerCase();
  a.trim();
  if (a.startsWith("ctrl+")) {
    bleSendKey(0x01, &KEY_C, 1);          // LeftCtrl + 'c'
  } else if (a.startsWith("shift+")) {
    bleSendKey(0x02, &KEY_A, 1);          // LeftShift + 'a'
  } else if (a.length() == 1) {
    char k = a.charAt(0);
    uint8_t code = (k >= 'a' && k <= 'z') ? (uint8_t)(k - 'a' + 4) : (uint8_t)k;
    bleSendKey(0, &code, 1);
  } else {
    Serial.println("contoh: key a | key ctrl+c | key shift+a");
  }
}

static void cmdStatus() {
  Serial.println("--- status ---");
  Serial.printf("advertise : %s\n", g_connected ? "berhenti (ada koneksi)" : "JALAN");
  Serial.printf("terhubung : %s\n", g_connected ? "ya" : "tidak");
  Serial.printf("notify NUS: %s\n", g_nusNotifyOn ? "ON" : "off");
  Serial.printf("uptime    : %lu dtk\n", (unsigned long)(millis() / 1000));

  auto peers = BLEDevice::getPeerDevices(false);
  Serial.printf("bond tersimpan di perangkat: %d\n", (int)peers.size());
  for (auto& kv : peers) {
    Serial.printf("  peer conn_id=%u status=%d\n", kv.first, (int)kv.second);
  }
  reportRam("status");
}

static void cmdClear() {
  auto peers = BLEDevice::getPeerDevices(false);
  int n = 0;
  for (auto& kv : peers) {
    BLEDevice::removePeerDevice(kv.first, false);
    n++;
  }
  Serial.printf("[S2] %d bond dihapus dari perangkat. Restart juga: %s\n",
                n, "hapus juga device di Windows (Settings > Bluetooth) sebelum pair ulang");
}

static void printHelp() {
  Serial.println("--- perintah ---");
  Serial.println("  help              daftar perintah ini");
  Serial.println("  key a             kirim huruf 'a' lewat BLE HID");
  Serial.println("  key ctrl+c        kirim Ctrl+C");
  Serial.println("  key shift+a       kirim Shift+A");
  Serial.println("  usbkey a          kirim 'a' lewat USB HID (pembanding)");
  Serial.println("  adv               (re)start advertising");
  Serial.println("  status            status advertise/connect/bond");
  Serial.println("  scan              matikan advertise 10 dtk biar bisa di-scan");
  Serial.println("  echo <teks>       uji NUS (balas lewat notify)");
  Serial.println("  sub on|off        notifikasi NUS (default off)");
  Serial.println("  clear             hapus bond di perangkat");
  Serial.println("  ram               laporan RAM");
}

static void handleCommand(String line) {
  line.trim();
  if (line.length() == 0) return;

  // Pecah jadi kata kunci + sisa argumen.
  int sp = line.indexOf(' ');
  String cmd = (sp < 0) ? line : line.substring(0, sp);
  String arg = (sp < 0) ? "" : line.substring(sp + 1);
  cmd.toLowerCase();

  if (cmd == "help" || cmd == "?") {
    printHelp();
  } else if (cmd == "key") {
    cmdKey(arg);
  } else if (cmd == "usbkey") {
    g_usbKeyboard.print(arg.length() ? arg.charAt(0) : 'a');
    Serial.println("[KEY] kirim via USB HID (pembanding)");
  } else if (cmd == "adv") {
    BLEDevice::startAdvertising();
    g_advWatchdog = millis();
    Serial.println("[S2] advertising (re)start");
  } else if (cmd == "status") {
    cmdStatus();
  } else if (cmd == "scan") {
    g_pauseUntil = millis() + 10000;
    BLEDevice::stopAdvertising();
    Serial.println("[S2] advertise dimatikan 10 detik. Pindai dari Windows sekarang.");
  } else if (cmd == "echo") {
    if (!g_connected) {
      Serial.println("[S2] belum terhubung");
    } else if (!g_nusNotifyOn) {
      Serial.println("[S2] notify dimatikan. Ketik \"sub on\" dulu (butuh subscriber di sisi app).");
    } else {
      String reply = String("SPIKE-ECHO:") + arg;
      bleNotify(reply.c_str());
      Serial.printf("[S2] NUS: kirim \"%s\" lewat notify\n", reply.c_str());
    }
  } else if (cmd == "sub") {
    g_nusNotifyOn = (arg.equals("on"));
    Serial.printf("[S2] notifikasi NUS %s\n", g_nusNotifyOn ? "ON" : "off");
  } else if (cmd == "clear") {
    cmdClear();
  } else if (cmd == "ram") {
    reportRam("manual");
  } else {
    Serial.println("perintah tidak dikenal. Ketik \"help\".");
  }
}

// ============================ LOOP ============================

// Badan loop dipanggil dari loop() Arduino. Nama harus beda dari "loop",
// kalau sama Arduino mendefinisikan void loop() sendiri dan hasilnya
// redefinition error.
static void loopImpl() {
  // --- tombol BOOT -> kirim key lewat KEDUA jalur (pembanding A/B) ---
  static bool buttonDown = false;
  bool down = (digitalRead(BTN_PIN) == LOW);
  if (down && !buttonDown) {
    buttonDown = true;
    if (g_connected) {
      bleSendKey(0, &KEY_A, 1);   // usage 0x04 = 'a'
    }
    g_usbKeyboard.print('a');
    Serial.println("[KEY] USB: kirim 'a' (pembanding - harus muncul di Notepad juga)");
  }
  if (!down) buttonDown = false;

  // --- NUS masuk ---
  if (g_nusRx && g_nusRx->getValue().length()) {
    String v = g_nusRx->getValue().c_str();
    g_nusRx->setValue("");
    Serial.printf("[S2] NUS masuk: \"%s\"\n", v.c_str());
    bleNotify(("SPIKE-ECHO:" + v).c_str());
  }

  // --- perintah Serial ---
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { handleCommand(g_serLine); g_serLine = ""; }
    else if (g_serLine.length() < 120) g_serLine += c;   // batasi, jangan tanpa batas
  }

  // --- "scan" selesai: nyalakan advertise lagi ---
  if (g_pauseUntil && millis() >= g_pauseUntil) {
    g_pauseUntil = 0;
    BLEDevice::startAdvertising();
    g_advWatchdog = millis();
    Serial.println("[S2] 10 detik selesai, advertising dinyalakan lagi");
  }

  // --- WATCHDOG: jaring pengaman terakhir ---
  // advertiseOnDisconnect(true) + startAdvertising() di onDisconnect sudah
  // Ideally cukup. Tapi kalau ada kondisi yang tidak kita antimbak (misalnya host
  // yang initiate terminate tanpa gap event, atau stack kehabisan memori GATT),
  // perangkat akan hilang dan tidak pernah ditemukan - gejala v1 yang persis.
  // Jadi setiap 5 detik selama belum ada koneksi, pastikan masih advertise.
  if (!g_connected && g_pauseUntil == 0 && (millis() - g_advWatchdog > 5000)) {
    g_advWatchdog = millis();
    BLEDevice::startAdvertising();
    Serial.println("[S2] watchdog: advertising dipastikan hidup");
  }

  delay(5);
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(BTN_PIN, INPUT_PULLUP);

  setupUsb();
  setupBle();

  g_bootMs = millis();
  g_advWatchdog = millis();

  Serial.println();
  Serial.println("=== LANGKAH TES ===");
  Serial.println(" 1. Ketik 'status' - pastikan advertise JALAN dan belum terhubung.");
  Serial.println(" 2. Pair di Windows (Settings > Bluetooth & devices > Add device).");
  Serial.println("    Hapus dulu device 'MacroPad BLE Spike' versi v1 bila ada.");
  Serial.println(" 3. Ketik 'status' lagi - harus 'terhubung: ya'.");
  Serial.println(" 4. Klik Notepad, tekan GPIO0. Huruf harus muncul DUA kali lewat BLE.");
  Serial.println(" 5. Cabut-colok USB dalam 10 detik. Windows harus connect lagi sendiri.");
  Serial.println(" 6. Kalau step 5 gagal, ketik 'adv' di Serial Monitor - ini bukti");
  Serial.println("    perangkat masih hidup dan advertiseOnDisconnect tidak bekerja.");
  Serial.println();
  printHelp();
}

void loop() { loopImpl(); }