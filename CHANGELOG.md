# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Phase 3 — data baterai & RGB berasal dari firmware, bukan dari app
- State RGB dipindahkan ke **core** (`RgbState` di `common/limits.h`), bukan lagi milik
  backend hardware. Karena itu `RGB:DUMP` bisa melaporkan state aktif apa pun, dan
  PROTOTYPE maupun FINAL memakai protocol yang identik.
- Tiga hook yang wajib diimplementasikan tiap profil: `rgbApplyState()`, `rgbPersist()`,
  `rgbRestore()`. FINAL menerjemahkan state ke strip SK6812; PROTOTYPE menyimpan ke
  Preferences tanpa menyalakan LED, sehingga jalur simpan/muat tetap bisa diuji.
- Command RGB yang dulu ditolak firmware kini diterima: `RGB:EN:`, `RGB:MODE:`,
  `RGB:SAVE`, `RGB:RESET`, `RGB:DUMP`. Blok `RGB:` tidak lagi dibungkus `#if HAS_RGB`.
- `BATT` tidak lagi dibungkus `#if HAS_VDIV`, dan menambah field `pct`/`charging`/`usb`.
- `EVT:BATT:` dikirim periodik (tiap 5 detik) berisi `pct`, `mv`, `charging`, `usb`,
  dan `profile`. `EVT:CHG:` dikirim hanya saat status charger berubah, agar tidak
  membanjiri log.
- `battPercentFromMv()` dengan kurva LiPo bertingkat (4200 mV = 100% ... 3400 mV = 0%).
- `HWINFO` kini melaporkan `rgbSlots`, `chg`, dan `simulated`.
- App: kirim `HWINFO`, `BATT`, dan `RGB:DUMP` saat connect; parse `HWINFO:`,
  `EVT:BATT:`, `EVT:CHG:`, `RGB_DUMP:`, `RGB_KEY:`; badge profil hardware di header
  (`#hwProfileBadge`) yang menandai **`SIMULASI`** bila firmware mengirim angka palsu;
  indikator baterai menampilkan `--` sebelum data pertama masuk.
- App: status "tersimpan" RGB sekarang berasal dari `RGB_DUMP:dirty=` milik device,
  bukan lagi asumsi lokal setelah menekan Simpan.

#### Sinyal hardware firmware FINAL
- Deteksi VBUS via voltage divider **68k/100k di GPIO21** — dasar kebijakan hemat
  baterai, yaitu menentukan kapan BLE perlu dinyalakan.
- Status charger **MCP73831 via pin STAT di GPIO18**, dikombinasikan dengan VBUS agar
  tiga kondisi dapat dibedakan: tidak mengecas / sedang mengecas / cas selesai.
  Kombinasi ini perlu karena STAT saja tidak bisa membedakan "cas selesai" dari
  "charger tidak terpasang".
- `usbHostConnected()` sebagai sumber kebenaran "USB tersambung".
- `ChargeState` enum (`CHARGE_NONE` / `CHARGE_CHARGING` / `CHARGE_COMPLETE`) di
  `common/limits.h`, beserta deklarasi antarmuka `readBatteryMv()`, `readChargeState()`,
  dan `usbHostConnected()` yang harus disediakan setiap profil.
- **Implementasi simulasi di firmware PROTOTYPE** untuk `readBatteryMv()` (turun 10 mV per
  menit mulai 4100 mV) dan `readChargeState()`. Prototipe tidak punya baterai maupun
  charger, tetapi companion app tetap harus bisa menguji seluruh alur UI. Format pesan
  sengaja dibuat identik dengan firmware FINAL agar saat board FINAL siap dipakai
  **tidak ada perubahan sama sekali di sisi app**.

#### Infrastruktur & pemisahan firmware
- `.gitattributes` untuk normalisasi line ending (firmware dipaksa LF).
- `CHANGELOG.md` sebagai catatan perubahan proyek.
- `parseIntRange()` di firmware: parser integer ketat yang menolak teks non-angka,
  overflow, dan nilai di luar rentang.
- **Firmware dipisah per profil.** Struktur baru:
  - `firmware/common/limits.h` — konstanta bersama
    (ROWS/COLS/MAX_LAYERS/`RGB_COUNT`/`RGB_INDEX`/APP_SLOTS/`ChargeState`/`RgbState`).
  - `firmware/common/macropad_core.h` — logika yang sama untuk kedua board
    (keymap, action, protocol serial, scan matrix, encoder, storage).
  - `firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino` — 1 knob, LED status GPIO12.
  - `firmware/HID_Keypad_Final/HID_Keypad_Final.ino` — 2 knob, RGB SK6812, divider
    baterai 100k/100k, divider VBUS 68k/100k, charger MCP73831.

  Pergantian profil kini berarti membuka sketsh yang lain, bukan mengubah
  `#define HW_PROFILE`.

### Fixed
- **Firmware FINAL gagal compile**: `RGB_DEFAULT_BRIGHTNESS` hilang setelah pemisahan
  firmware karena ikut terpotong dari blok profil RGB. Sudah dikembalikan.
- **Notifikasi overlay mati total di rilis**: `src/overlay.html` tidak pernah ikut ter-build
  karena `vite.config.js` hanya mendeklarasikan `index.html` sebagai entry Rollup, padahal
  `lib.rs` membukanya lewat `WebviewUrl::App("overlay.html")`. Sekarang `dist/` berisi
  `overlay.html`.
- **Parsing indeks firmware bisa menulis ke target yang keliru**: `String::toInt()`
  mengembalikan `0` untuk teks non-numerik dan nilai besar terpotong diam-diam saat di-cast
  ke `uint8_t` (`SETENC:256:` menjadi `0`), sehingga lolos validasi batas dan menimpa knob
  yang salah. Delapan titik parsing kini memakai `parseIntRange()`:
  `SLOT`, `SETENC`, `RENAMELAYER`, `LAYER`, `DUMP`, `SET`, `GET`, `RGB:BRI`.
- Halaman RGB: preview animasi per mode lighting sebelumnya tidak terlihat karena
  ikut dilumpuhkan oleh `animation: none !important`.
- Key bertipe `APP` tidak punya styling sehingga tampak sama dengan key kosong.
  Ditambah `--type-app` plus `.cell.type-app` dan `.enc-row.type-app`.
- `escapeHtml()` sekarang juga meng-escape tanda kutip tunggal dan menerima non-string.
- Dibuang blok debug yang dikomentari di akhir `main.js`.

### Changed
- Indikator baterai: angka dummy yang turun 1% tiap 2 detik lalu reset ke 100% **dihapus**.
  Data sekarang dibaca dari `EVT:BATT:`; `charging` juga disetel lewat `EVT:CHG:`
  (sebelumnya tidak pernah aktif).
- Firmware dinormalkan ke line ending LF (semula CRLF dari penulisan PowerShell),
  sesuai aturan `.gitattributes` `firmware/** text eol=lf`.
- Firmware RGB: label key di halaman RGB app diganti dari `R<row> C<col>` menjadi
  `RGB 1`..`RGB 9` mengikuti **urutan rantai LED fisik** (cermin `RGB_INDEX` di
  firmware). Balasan serial firmware ikut menyesuaikan: `[OK] RGB 6 (R1 C0) diset`.
- Preview animasi RGB page digerakkan Web Animations API (JS), bukan CSS `animation`,
  agar tidak bisa dimatikan oleh rule stylesheet maupun `prefers-reduced-motion`.
- Kontrol warna mode RGB tidak lagi memanggil `renderRgbAll()` di tiap event `oninput`,
  sehingga `RGB:MODE:` tidak dikirim per-pixel dan fase animasi tidak reset.
- Firmware: `USB.serialNumber()` memakai `HW_PROFILE_NAME` alih-alih hardcoded
  `"MACROPAD-proto"`, sehingga board FINAL tidak lagi menyamar sebagai prototipe.
- `RGB_COUNT` dan `RGB_INDEX` dipindah ke `common/limits.h` karena menggambarkan jumlah
  key dan urutan rantai, bukan properti hardware board tertentu.
- Selector sleep timeout dikunci (`disabled`) dengan penjelasan, karena firmware belum
  punya perintah sleep. Sebelumnya aktif tapi tanpa handler.

### Removed
- `firmware/HID_Keypad/HID_Keypad.ino` (monolit 1056 baris). Digantikan berkas-berkas di
  atas; salinan utuh tersimpan di git pada commit `3c020d2` dan dapat dipulihkan dengan
  `git show 3c020d2:firmware/HID_Keypad/HID_Keypad.ino`.

## Catatan status

Repo ini baru memakai git mulai Phase 0 roadmap. Rincian temuan, rencana, dan
urutan pengerjaan ada di `C:\Users\Raihan\.opencode\plan\macropad-roadmap.md`.

Verifikasi firmware tetap perlu compile di Arduino IDE — tidak ada toolchain Arduino
di lingkungan pengembangan ini, jadi pemeriksaan statis (simbol terdefinisi, kurung
kurawal seimbang, region verbatim utuh, kontrak offset protokol) adalah batas utmost
yang bisa dijamin tanpa hardware.

### Yang belum dikerjakan di firmware FINAL
- Mesin efek RGB (breathing/rainbow/wave/snake/random/react). `rgbApplyState()` di
  firmware FINAL baru menerjemahkan mode ke warna per LED, belum menganimasikannya.
- `usbHostConnected()` sudah tersedia sebagai sumber kebenaran, tetapi kebijakan
  menyalakan/mematikan BLE belum diimplementasikan (menunggu Phase 10).