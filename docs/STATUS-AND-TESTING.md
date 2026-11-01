# Ringkasan Developments & Prosedur Pengujian

Dokumen ini berisi dua hal:

1. **Ringkasan perkembangan** — apa yang sudah selesai dan apa yang belum.
2. **Prosedur pengujian** — langkah-langkah memastikan semua fitur aman.

Status verifikasi terakhir: **SEMUA HIJAU** (lihat [Bagian 3](#3-hasil-verifikasi-terakhir)).

---

## 1. Ringkasan perkembangan

### 1.1 Yang sudah selesai

Semua perubahan sudah di-commit satu per satu dengan entri CHANGELOG, jadi
setiap tahap bisa di-revert.

| Commit | Tahap | Isi |
|---|---|---|
| `604c3b4` | Phase 0 | Baseline repo + CHANGELOG |
| `3c020d2` | Phase 1 | Quick wins: overlay build, parsing indeks, escaping, styling |
| `d2215c8` | Phase 2 | Firmware PROTOTYPE dan FINAL dipisah |
| `77f6ae7` | Phase 3 | Data baterai & RGB berasal dari firmware, bukan app |
| `6106dcf` | Phase 4 | Transport reliability: listener bocor, buffer tak terbatas, parser tahan data rusak |
| `88cade1` | Phase 5 | Waiter DUMP per-layer dengan timeout; pisahkan baca vs ganti layer |
| `7693615` | Phase 6 | Hilangkan bekuannya firmware (blink, gestur app, log key) |
| `d2c97f6` | Phase 7 | Hardening: CSP, izin Tauri, `eval` → event, file atomik, test Rust |
| `9b9dcd0` … `d508acb` | Phase 8 | `main.js` 1864 → 263 baris, dipecah jadi 15 modul |
| `e8cf630` | Phase 9a | Aksesibilitas: navigasi keyboard, modal, focus trap, `aria-*` |
| `8b9c956` | Phase 9b-1 | Fondasi i18n: deteksi locale Windows, tabel ID/EN, pengalih di Setting |
| `71bd1c9` | Phase 9b-2 | Semua string runtime (~200 kunci) diterjemahkan |

#### Firmware

- Terpisah: `firmware/HID_Keypad_Prototype/` dan `firmware/HID_Keypad_Final/`,
  berbagi `firmware/common/macropad_core.h`.
- Data baterai & RGB dibaca dari firmware (`HWINFO:`, `EVT:BATT:`, `EVT:CHG:state=`,
  `RGB_DUMP:`, `RGB_KEY:`). App tidak menebak-nebak lagi.
- Encoder memakai state machine quadrature (arah tidak lagi terbalik).
- Transport sudah di abstraksi: `firmware/common/transport.h` (interface `Transport`)
  + `transport_usb.h` (`UsbTransport`). Core memakai macro `SERIAL->`.
  `TRANSPORT_USB` / `TRANSPORT_BLE` di `limits.h`, default `TRANSPORT_USB`.
  Mengganti ke BLE nanti cukup mengubah satu `#define`.

#### Aplikasi (Rust)

- 9 unit test hijau, termasuk pembacaan locale Windows asli.
- Perintah Tauri: aplikasi, consent, autostart, locale, bindable apps, preset,
  notifikasi, overlay, foreground exe.
- Modul BLE (`src-tauri/src/ble.rs`) sudah ada dan **kompilasi bersih**.

#### Aplikasi (JavaScript)

- 21 skrip uji Node, semua hijau.
- `vite build` sukses.
- Aksesibilitas: navigasi sidebar & layer dengan keyboard, modal dengan focus trap
  dan focus restore, live region untuk status & log.
- i18n: ID + EN, deteksi otomatis dari bahasa Windows pada first run,
  pengalih manual di halaman Setting.

### 1.2 Yang belum selesai

#### Phase 10 — BLE (sedang berjalan, belum di-commit)

- **Sisi firmware**: abstraksi transport sudah siap, `TRANSPORT_TYPE` masih `TRANSPORT_USB`.
  Belum ada implementasi `BleTransport` di firmware.
- **Sisi Rust**: `ble_scan`, `ble_connect`, `ble_disconnect`, `ble_write`, `ble_read`,
  `ble_is_connected` sudah terdaftar di `generate_handler!` dan bisa dikompilasi,
  tapi **belum dipakai frontend** — masih command yang berdiri sendiri.
- **Sisi JavaScript**: belum ada transport BLE. Dropdown COM (`#portSelect`),
  tombol Refresh (`#btnRefreshPorts`) dan Connect (`#btnConnect`) masih ada.
- Belum ada auto-connect / auto-reconnect.
- Fallback force-connect manual harus disembunyikan (bukan dihapus) selama 1–2 rilis.

#### Firmware FINAL — media otomatis, baterai, RGB (v8)

Sudah diimplementasikan di `firmware/HID_Keypad_Final/HID_Keypad_Final.ino`:

- **BLE HID aktif** (`HID_BLE_SUPPORT 1`). Media dipilih otomatis dari VD_VB:
  HIGH (USB) -> HID/protokol USB + BLE dimatikan; LOW (baterai) -> BLE + USB
  di-de-enumerasi. Debounce ~0,9 detik supaya cross-coupling capacitor tidak
  memicu switch palsu. Tidak ada lagi tombol BOOT/GPIO0 di FINAL.
- **VD_VB dibaca digital** (GPIO21 bukan pin ADC di ESP32-S3). ADC 8 sampel
  per loop yang lama (~2 ms blocking) diganti satu `digitalRead` per 500 ms.
- **Battery sense asli**: `EN_VD` HIGH -> settle 5 ms -> 16 sampel ADC -> `EN_VD`
  LOW, dilaporkan tiap 10 detik (bukan tiap detik/loop).
- **RGB off benar-benar mematikan MOSFET**: `RGB:EN:0`, brightness 0, atau warna
  hitam -> `rgbPower(false)`. `rgbInit()` tidak lagi melakukan sweep saat state
  tersimpan off.
- **Mesin efek RGB terpasang** (`rgb_effects.h`): breathing, color cycle,
  rainbow, waves, snake, random, react. Mode 0/1 tetap statis.
- **Gesture knob bisa diatur**: per knob, dua tier, tipe dan durasi dari app
  (`GEST` / `SETGEST`), disimpan di NVS. Default: knob 1 pindah layer 2 dtk,
  keluar preset 3 dtk; knob 2 tanpa gesture.
- **Payload biner 2 knob**: `CFG_STAGING_SIZE` 6144 (payload maksimum 6014),
  `needLen` dihitung dari `NUM_ENCODERS`, `cfgSig()` menyusun encoder dalam
  urutan kanonik CW,CCW,BTN per knob.

Yang masih perlu hardware: verifikasi polaritas `EN_RGB`/`EN_VD`, arah putaran
knob (bisa dibalik lewat `ENC_DIR_INVERT`), dan pembacaan charger sebenarnya.

#### Phase 6.1 — ditunda dengan sengaja

Memindahkan scan matrix + serial ke task FreeRTOS terpisah. Setelah Phase 6.2–6.4,
satu-satunya blocking tersisa `Keyboard.print()` (~1 ms/karakter). Pindah ke task
terpisah menuntut `Keyboard`, `Adafruit_NeoPixel`, `Preferences` jadi thread-safe
— tidak satu pun thread-safe. Melakukan refactor itu tanpa bisa compile dan tanpa
hardware berisiko menghasilkan-hasil lebih buruk daripada masalah aslinya.

#### Planned work (masih Ideas)

- **Filter waktu untuk rotary encoder.** State machine quadrature sudah menangani
  bounce pada detent, tapi noise acak yang mengubah A/B secara acak tetap terlihat
  identik dengan putaran nyata. Butuh filter berbasis waktu (abaikan transisi < 2 ms
  setelah transisi sebelumnya). Gejalanya: langkah acak saat knob diam.
- **Pause auto-switch setelah user pindah layer.** `lastDeviceLayerEventAt` sudah diisi
  setiap ada `EVT:LAYER:` tapi belum pernah dibaca. Rencana: hentikan auto-switch
  sesaat setelah user pindah layer lewat knob, supaya preset tidak langsung menimpa.
  Belum diputuskan apa yang terjadi kalau `fetchAllLayersForPacking()` sedang berjalan
  dan user memindah layer di tengah dump.

---

## 2. Prosedur pengujian

### 2.1 Tingkat 1 — Otomatis (jalan setiap sebelum commit)

Jalankan dari root repo. Semua harus hijau.

```powershell
# A. Unit test Rust
cd src-tauri
cargo test --lib            # harus: 9 passed; 0 failed
cargo check                 # harus: tidak ada error
cd ..

# B. Build frontend (menangkap error yang tidak ditangkap node --check)
npx vite build              # harus: "built in ..." tanpa error

# C. 21 skrip uji Node
$dir = 'C:\Users\Raihan\AppData\Local\Temp\opencode'
$names = @(
  'a11y-test.js','adaptive-contract-test.js','dump-waiter-test.js',
  'encoder-quadrature-test.js','firmware-symbol-check.js','handleLine-diff.js',
  'home-page-diff.js','key-event-test.js','no-lost-functions-test.js',
  'parser-wiring-test.js','protocol-contract-test.js','settings-test.js',
  'shell-ui-diff.js','tray-diff.js','device-state-test.mjs','i18n-test.mjs',
  'protocol-parser-test.mjs','rgb-page-test.mjs','serial-transport-test.mjs',
  'startup-smoke-test.mjs','battery-ui-test.mjs'
)
foreach ($n in $names) {
  $out = & node "$dir\$n" 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Write-Output "FAIL $n"; Write-Output $out }
  else { Write-Output "PASS $n" }
}
```

**Semua 21 harus PASS.** Kalau ada FAIL, jangan commit — perbaiki dulu.

> Catatan: skrip diff meng-*pin* commit tertentu, bukan `HEAD`. Kalau Phase berikutnya
> mengubah bentuk fungsi, skrip diff harus di-update (ada langkah de-translate untuk
> memetakan `t('key', ...)` kembali ke literal lama).

### 2.2 Tingkat 2 — Build & jalankan app

```powershell
npm run tauri dev
```

Periksa:

- [ ] Jendela utama muncul, **tidak putih**. (Bila putih: `src/paint-watch.js` melakukan
      reload otomatis lewat `requestAnimationFrame` — biarkan bekerja sekali lalu cek log.)
- [ ] Tray icon muncul di system tray.
- [ ] Dropdown COM terisi daftar port serial.
- [ ] Tidak ada error di log `#log` maupun di DevTools console.

### 2.3 Tingkat 3 — Uji manual dengan hardware PROTOTYPE

> **Prasyarat**: firmware sudah di-flash. Static check **tidak** menggantikan ini.

#### Koneksi

- [ ] Pilih port yang benar di dropdown COM → klik **Connect**.
- [ ] Status berubah "Not connected" → "Connected".
- [ ] Matikan colok USB → status jadi disconnected, app **tidak** crash.
- [ ] Colok lagi → hubungkan ulang, tidak perlu restart app.

#### Info perangkat

- [ ] Kolom **HWINFO** terisi: profile, encoders, statusLed, rgb, rgbSlots, vdiv, chg.
- [ ] `profile` = `P` untuk PROTOTYPE (FINAL = `F`).
- [ ] Baterai menampilkan **angka persen** yang berubah-ubah.
- [ ] Ikon baterai punya `aria-label` yang menyebut persentase (cek di DevTools →
      Accessibility Tree).
- [ ] Ada peringatan jelas di UI bahwa pada PROTOTYPE angka baterai & RGB itu
      **simulasi** (`simulated=1` di HWINFO).

#### Grid & layer

- [ ] Tekan setiap tombol → **app** (bukan OS) yang menerima aksi, sesuai tipe:
      teks, kombinasi, macro, aplikasi, consumer/media.
- [ ] Notifikasi per key muncul di app (`[KEY] layer,row,col,type,value`).
- [ ] `+ Layer` / `- Delete` / `Rename` bekerja; `Load` mengambil isi layer dari device.
- [ ] `Save` menulis ke flash; **matikan dan nyalakan device** → konfigurasi tetap.
- [ ] `Reset` mengembalikan ke default.
- [ ] Macro panjang (47 karakter) tidak membuat device gagal. Perhatikan log.

#### Rotary encoder

- [ ] Putar knob searah jarum jam → layer naik. Searah jarum jam → turun. **Tidak terbalik.**
- [ ] Knob diam → **tidak ada** langkah acak (filter waktu belum ada, jadi kalau muncul
     aba-ababa, catat sebagai bug — jangan dianggap normal).
- [ ] Tekan knob → `[ENC_BTN] Knob i:` muncul di log.
- [ ] Tahan Escape ≥ 3.5 detik → `[EVT:ESCAPE]`.
- [ ] Tahan layer switch ≥ 1 detik → `[EVT:LAYER:N]`.

#### Adaptive Key Bind

- [ ] Scan daftar aplikasi; aplikasi yang sedang foreground terdeteksi.
- [ ] Ikan .exe custom bisa ditambah/dihapus.
- [ ] Preset bisa diaktifkan; preset yang berebut aplikasi yang sama otomatis dimatikan
      dan diberi tahu.
- [ ] Key yang ter-preset berubah otomatis saat pindah aplikasi.
- [ ] `masterEnabled` bisa dimatikan → semua binding berhenti.

#### RGB Setting

- [ ] Slider enable, brightness, speed, warna, mode, random — semua diterima device
      (`[OK] ...` di log).
- [ ] `Save` → `RGB:SAVE`; matikan-nyalakan device → efek tersimpan.
- [ ] `Dump` → app menampilkan 9 slot sesuai isi device.
- [ ] Garis `[KEY]` 62 byte terburuk — pastikan device **tidak** reset saat macro
      terisi penuh.

#### Setting

- [ ] Autostart: hidupkan → restart Windows → app jalan sendiri.
- [ ] **Bahasa**: ganti ke English → **seluruh** UI berubah, termasuk pesan di log
      dan notifikasi. Ganti balik ke Indonesia.
- [ ] **Deteksi otomatis**: hapus pilihan bahasa dari localStorage, ganti bahasa
      Windows, restart app → bahasa mengikuti bahasa Windows.
- [ ] Setelah memilih manual, ganti bahasa Windows → **tidak boleh** berubah
      (pilihan manual menang).

### 2.4 Tingkat 4 — Uji aksesibilitas (Phase 9)

- [ ] `Tab` bisa menjangkau sidebar, tiap layer, grid, knob, tombol.
- [ ] `ArrowUp`/`ArrowDown` memindah fokus antar-item sidebar; `Enter` mengaktifkan.
- [ ] `ArrowLeft`/`ArrowRight` ganti layer di tab bar.
- [ ] Modal: fokus masuk ke modal, **terjebak** di dalam (Tab tidak keluar), fokus
      kembali ke pemicu setelah ditutup.
- [ ] `Esc` menutup modal.
- [ ] Focus ring terlihat di semua elemen interaktif (`:focus-visible`).
- [ ] `role="status"` dan `role="log"` dibaca screen reader (uji dengan NVDA).

### 2.5 Tingkat 5 — Uji ketahanan (sudah otomatis, tapi tetap sadari)

- [ ] **Data rusak**: paste baris acak ke parser (test `protocol-parser-test.mjs`
      sudah mengcovernya).
- [ ] **Device mati saat dump**: `DUMP_END` tidak pernah datang → waiter harus
      timeout, app tidak menggantung.
- [ ] **Buffer tidak terbatas**: data mengalir terus → tidak boleh memory naik
      tanpa batas.
- [ ] **Jendela putih**: tutup app paksa lalu jalankan lagi → harus normal
      (watchdog `paint-watch.js`).

### 2.6 Tingkat 6 — Uji firmware

Toolchain Arduino tersedia (`arduino-cli` + core esp32 3.3.8). Kedua sketsh
sudah dikompilasi untuk `esp32:esp32:esp32s3`:

| Sketsh | Flash | RAM statis |
| --- | --- | --- |
| FINAL v8 | 716.369 B (54%) | 112.364 B (34%) |
| PROTOTYPE v8 | 700.857 B (53%) | 110.676 B (33%) |

Verifikasi statis tetap dijalankan lewat suite Node
(`firmware-compile-guard-test.js`, `firmware-final-contract-test.cjs`,
`firmware-switch-iface-test.cjs`).

Sebelum rilis ke device:

- [x] `arduino-cli compile` untuk **kedua** sketsh (PROTOTYPE & FINAL) tanpa error.
- [x] Cek ukuran flash & RAM dipakai tidak mendekati batas.
- [ ] Flash ke device dan ulangi seluruh uji di Bagian 2.3.
- [ ] Uji FINAL saat VBUS terpasang -> `EVT:CHG:state=0/1/2` (tidak mengisi / mengisi /
      selesai) benar.
- [ ] Uji FINAL tanpa VBUS -> `usb=0`, `charging=0`, dan media otomatis pindah ke BLE
      (`IFACE:link=ble`), lalu kembali ke USB saat kabel dipasang.
- [ ] Verifikasi polaritas `EN_RGB` (GPIO15) dan `EN_VD` (GPIO17).
- [ ] Verifikasi arah putaran kedua knob; kalau terbalik set `ENC_DIR_INVERT 1`
      di sketsh FINAL (jangan mengubah tabel quadrature bersama).
- [ ] Mesin efek RGB FINAL: breathing, rainbow, wave, snake, random, react jalan
      dan tidak flicker; RGB off/brightness 0/warna hitam mematikan rail (ukur arus).
- [ ] Gesture: pindah tier 1/tier 2 di app benar-benar mengubah knob dan durasinya,
      dan tersimpan setelah reboot.

### 2.7 Prosedur per-commit

Sebelum setiap commit:

1. `cargo test --lib` + `cargo check` → hijau.
2. `npx vite build` → sukses.
3. 21 skrip uji Node → semua PASS.
4. `git status` — pastikan tidak ada file yang tidak sengaja ikut (mis. `dist/`,
   `target/`, `node_modules/`).
5. Update `CHANGELOG.md`: **Added / Changed / Fixed / Removed**.
6. Commit dengan pesan yang menyebut nomor fase.

Kalau ada regresi setelah commit: `git revert <hash>` (jangan `reset --hard`,
supaya riwayatnya tetap bisa ditelusuri).

---

## 3. Hasil verifikasi terakhir

| Yang diuji | Hasil |
|---|---|
| `cargo check` | Bersih (0 error) |
| `cargo test --lib` | **9 passed**, 0 failed |
| `npx vite build` | Sukses, 32 modul |
| 21 skrip uji Node | **21/21 PASS** |

Dua skrip sempat gagal setelah Phase 10 karena masih mencari `Serial.printf(`,
padahal firmware sekarang memakai macro `SERIAL->printf(`. Itu **test usang, bukan
regresi** — regex-nya sudah diperbaiki, dan sekarang menerima keduanya.

### Yang belum terverifikasi

- Compile Arduino (tidak ada toolchain).
- Perilaku nyata di device (tidak ada akses ke device dari lingkungan ini).
- Fase FINAL yang butuh charger/VBUS/RGB asli.
- BLE end-to-end (masih dalam pengerjaan).
