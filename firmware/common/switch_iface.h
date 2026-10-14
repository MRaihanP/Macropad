// =================== SWITCH TRANSPORT VIA TOMBOL BOOT ===================
//
// GPIO0 (tombol BOOT) satu kali tekan untuk memindahkan device antara USB dan
// BLE. Berdampingan dengan perintah Serial IFACE:* / PROTO:* yang sudah ada -
// tombol ini jalur cepat tanpa perlu Serial Monitor, dan tetap berfungsi saat
// companion app sudah tidak bisa bicara (mis. mode BLE aktif tapi app mati).
//
// YANG DIPINDAHKAN
//
// Firmware punya DUA sumbu terpisah (lihat limits.h):
//
//   HID_LINK   - ke mana report tombol dikirim    (USB HID  | BLE HID)
//   PROTO_LINK - ke mana jawaban perintah dikirim  (USB CDC  | BLE NUS)
//
// Tombol ini memindahkan KEDUA sumbu sekaligus, karena untuk pengguna "pindah
// ke USB / BLE" artinya satu hal: seluruh device pindah medium. Menyisakan satu
// sumbu di mode lama menghasilkan keadaan membingungkan - tombol ke USB tapi
// companion app membaca lewat NUS - yang tidak berguna untuk pemakaian normal
// dan hanya mungkin sebagai pemeriksaan diagnostik (masih bisa lewat IFACE:* /
// PROTO:* lewat Serial Monitor).
//
// POLA LED (indikator sesaat, bukan status)
//
//   -> BLE : berkedip, interval 200 ms, total 1 detik
//   -> USB : menyala terus, total 1 detik, lalu mati
//
// Sifatnya sengaja tidak menetap. Menetap akan menguras baterai, dan LED
// yang menyala setelah device dicabut adalah informasi yang salah. Yang perlu
// diketahui pengguna hanya "tekan saya masuk mode mana", itu selesai dalam
// 1 detik.
//
// Animasi berjalan TANPA delay(). delay(1000) di sini akan membekukan scan
// matrix, encoder, dan loop BLE selama 1 detik penuh - tombol yang ditekan
// selama berkedip akan hilang begitu saja.
//
// GPIO0 = BOOT
//
// GPIO0 adalah pin strap download di ESP32-S3, aktif-LOW dengan pull-up
// internal. Sifat yang dipakai di sini:
//  - Tahan saat power-on = masuk mode download. Boot strap dibaca oleh ROM SEBELUM
//    Arduino setup() jalan, jadi tidak bentrok dengan tekan yang disengaja
//    setelah device sudah hidup.
//  - Cukup pull-up internal; tidak perlu resistor eksternal.
//  - Debounce wajib.
//
// CATATAN: header ini tidak memakai variabel yang didefinisikan di .ino
// (seperti STATUS_LED_PIN). Semua pin dikonfigurasi lewat parameter fungsi
// supaya file ini bisa dipakai profil mana pun tanpa edit - FINAL tidak punya
// LED status sama sekali (GPIO12 dipakai knob 2).

#pragma once

#include <Arduino.h>
#include "limits.h"

#ifndef BOOT_SWITCH_PIN
#define BOOT_SWITCH_PIN 0
#endif

// 40 ms cukup untuk tombol yang disentuh jari, dan tidak menahan tekan ganda
// yang memang disengaja.
#ifndef BOOT_SWITCH_DEBOUNCE_MS
#define BOOT_SWITCH_DEBOUNCE_MS 40
#endif

// Abaikan tekan di detik pertama setelah boot: pin strap masih "bersih" dari
// tekanan saat menyalakan, dan rampasan di awal bisa memicu switch yang tidak
// diminta pengguna.
#ifndef BOOT_SWITCH_IGNORE_MS
#define BOOT_SWITCH_IGNORE_MS 1200
#endif

#ifndef SWITCH_LED_BLINK_MS
#define SWITCH_LED_BLINK_MS 200
#endif
#ifndef SWITCH_LED_TOTAL_MS
#define SWITCH_LED_TOTAL_MS 1000
#endif

enum class SwitchLedPattern : uint8_t { SW_NONE = 0, SW_BLINK = 1, SW_SOLID = 2 };

// Catatan: ifaceGo() DITEMPATKAN di bawah switchLedStart(), bukan di sini -
// ia memanggil fungsi itu, jadi harus lihat definisinya dulu.

// ---- State LED indikator ----
// Nol berarti "profil ini tidak punya LED status"; semua fungsi di bawah
// menjadi no-op dan switch tombol tetap berfungsi.
static uint8_t g_switchLedPin = 0xFF;
static bool g_switchLedActiveHigh = true;
static bool g_switchLedUsable = false;

static SwitchLedPattern g_switchLedPattern = SwitchLedPattern::SW_NONE;
static unsigned long g_switchLedUntil = 0;
static unsigned long g_switchLedNextToggle = 0;
static bool g_switchLedLevel = false;

// ---- State tombol BOOT ----
static unsigned long g_bootBtnStableSince = 0;
static bool g_bootBtnLastRaw = false;
static bool g_bootBtnArmed = false;   // sudah poignant tekan sebelumnya

inline void switchLedAttach(uint8_t pin, bool activeHigh = true) {
  pinMode(pin, OUTPUT);
  digitalWrite(pin, activeHigh ? LOW : HIGH);
  g_switchLedPin = pin;
  g_switchLedActiveHigh = activeHigh;
  g_switchLedUsable = true;
  g_switchLedPattern = SwitchLedPattern::SW_NONE;
  g_switchLedLevel = false;
}

inline void switchLedStart(SwitchLedPattern pattern) {
  const unsigned long now = millis();
  g_switchLedPattern = pattern;
  g_switchLedUntil = now + SWITCH_LED_TOTAL_MS;
  if (pattern == SwitchLedPattern::SW_BLINK) {
    g_switchLedLevel = true;
    g_switchLedNextToggle = now + SWITCH_LED_BLINK_MS;
  } else if (pattern == SwitchLedPattern::SW_SOLID) {
    g_switchLedLevel = true;
    g_switchLedNextToggle = 0;
  } else {
    g_switchLedLevel = false;
  }
  if (g_switchLedUsable) {
    digitalWrite(g_switchLedPin, (g_switchLedActiveHigh == g_switchLedLevel) ? HIGH : LOW);
  }
}

// =================== PINDAH USB <-> BLE (SATU-SATUNYA IMPLEMENTASI) ===================
//
// Fungsi INI yang dipakai command IFACE:USB/IFACE:BLE (ble_diag.h) DAN tombol
// GPIO0 (profileLoopHook). Sebelumnya keduanya punya kode sendiri dan hasilnya
// BERBEDA:
//
//   command  -> hidLinkSet() saja. PROTO_LINK tidak disentuh dan transport
//               protokol tidak dipindah. Jadi "pindah ke BLE" lewat command
//               hanya memindahkan report TOMBOL ke BLE; jawaban protokol masih
//               lewat USB CDC. Setengah jalan - keadaan yang membingungkan.
//   tombol   -> dua sumbu + transport + LED. Benar.
//
// Sekarang hanya ada satu implementasi, jadi command dan tombol tidak mungkin
// lagi berbeda.
//
// URUTAN WAJIB. g_hidLink ditulis LEBIH DAHULU dari g_protoLink:
//   - ke BLE: hidLinkSet(BLE) menyalakan advertising + server GATT. Kalau
//     protokol diletakkan ke NUS lebih dulu, companion app bisa menemukan
//     device sebelum keyboard siap.
//   - ke USB: hidLinkSet(USB) memutus peer BLE dan mematikan advertising. Kalau
//     protokol diletakkan lebih dulu, jawaban app hilang di NUS yang sudah
//     tidak diiklankan.
//
// PESAN SELALU lewat LOGS (USB CDC) yang tidak pernah berubah. Kalau lewat
// SERIAL, pesan ini ikut terkirim ke companion app setelah g_transport dipindah
// ke NUS, dan muncul sebagai baris protokol yang tidak dikenal.
inline void ifaceGo(bool toBle) {
#if HID_BLE_SUPPORT
  hidLinkSet(toBle ? HidLink::BLE : HidLink::USB);
  g_protoLink = toBle ? ProtoLink::NUS : ProtoLink::CDC;
  protoTransportSwitch();
  LOGS->printf("[IFACE] pindah ke %s (hid=%s proto=%s)\n",
               toBle ? "BLE" : "USB", hidLinkName(g_hidLink), protoLinkName(g_protoLink));
  switchLedStart(toBle ? SwitchLedPattern::SW_BLINK : SwitchLedPattern::SW_SOLID);
#else
  (void)toBle;
  LOGS->println("[IFACE] BLE tidak dikompilasi (HID_BLE_SUPPORT=0)");
  switchLedStart(SwitchLedPattern::SW_SOLID);
#endif
}

// Panggil dari loop profil tiap iterasi. Non-blocking.
inline void switchLedTick() {
  if (!g_switchLedUsable) return;
  const unsigned long now = millis();
  // Perbandingan signed supaya aman saat millis() melewati batas 2^32
  // (rollover ~49,7 hari) - device bisa menyala berminggu-minggu.
  if (g_switchLedPattern != SwitchLedPattern::SW_NONE &&
      (long)(now - g_switchLedUntil) >= 0) {
    g_switchLedPattern = SwitchLedPattern::SW_NONE;
    g_switchLedLevel = false;
  } else if (g_switchLedPattern == SwitchLedPattern::SW_BLINK &&
             (long)(now - g_switchLedNextToggle) >= 0) {
    g_switchLedLevel = !g_switchLedLevel;
    g_switchLedNextToggle = now + SWITCH_LED_BLINK_MS;
  }
  digitalWrite(g_switchLedPin, (g_switchLedActiveHigh == g_switchLedLevel) ? HIGH : LOW);
}

// Siapkan GPIO0 untuk dibaca. Panggil sekali dari setup profil.
inline void bootSwitchBegin() {
  pinMode(BOOT_SWITCH_PIN, INPUT_PULLUP);
  g_bootBtnLastRaw = digitalRead(BOOT_SWITCH_PIN) == LOW;
  g_bootBtnStableSince = millis();
  g_bootBtnArmed = !g_bootBtnLastRaw;   //armed kalau tombol sedang tidak ditekan
}

// Hasil pemindaian tombol: true pada TEKAN YANG SAH (satu kali per penekanan).
inline bool bootSwitchPoll() {
  const bool raw = digitalRead(BOOT_SWITCH_PIN) == LOW;
  const unsigned long now = millis();

  if (raw != g_bootBtnLastRaw) {
    // Transisi mentah (tekan ATAUPAscoba lepas): mulai hitung ulang stabilitas.
    g_bootBtnLastRaw = raw;
    g_bootBtnStableSince = now;
    return false;
  }

  // Sudah stabil >= debounce ms.
  if ((long)(now - g_bootBtnStableSince) < BOOT_SWITCH_DEBOUNCE_MS) return false;

  // Abaikan fase awal boot.
  if (now < BOOT_SWITCH_IGNORE_MS) return false;

  if (raw && g_bootBtnArmed) {
    // Baru ditekan DAN armed: kembalikan latch supaya satu penekanan panjang
    // hanya menghasilkan SATU perpindahan. Tanpa latch, tombol yang ditahan
    // akan memicu switch berulang tiap debounce.
    g_bootBtnArmed = false;
    return true;
  }
  if (!raw) {
    // Dilepas: siap untuk penekanan berikutnya.
    g_bootBtnArmed = true;
  }
  return false;
}
