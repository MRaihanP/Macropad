# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `.gitattributes` untuk normalisasi line ending (firmware dipaksa LF).
- `CHANGELOG.md` sebagai catatan perubahan proyek.
- `parseIntRange()` di firmware: parser integer ketat yang menolak teks non-angka,
  overflow, dan nilai di luar rentang.
- **Firmware dipisah per profil** (Phase 2). Struktur baru:
  - `firmware/common/limits.h` — konstanta bersama (ROWS/COLS/MAX_LAYERS/`RGB_COUNT`/`RGB_INDEX`/APP_SLOTS).
  - `firmware/common/macropad_core.h` — seluruh logika yang sama untuk kedua board
    (keymap, action, protocol serial, scan matrix, encoder, storage).
  - `firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino` — 1 knob, LED status GPIO12.
  - `firmware/HID_Keypad_Final/HID_Keypad_Final.ino` — 2 knob, RGB SK6812, divider 100k/100k.

  Pergantian profil kini berarti membuka sketsh yang lain, bukan mengubah
  `#define HW_PROFILE`. Blok hardware yang tetap sama
  (RGB/vdiv/`hwPeripheralsInit`) dipakai verbatim di kedua sketsh dan dibedakan
  oleh guard `#if HAS_*`, sehingga tidak ada logika profil yang terduplikasi.
- `RGB_COUNT` dan `RGB_INDEX` dipindah ke `common/limits.h` karena menggambarkan
  jumlah key dan urutan rantai, bukan properti hardware board tertentu.

### Removed
- `firmware/HID_Keypad/HID_Keypad.ino` (monolit 1056 baris). Digantikan tiga file di atas;
  salinan utuh tersimpan di git pada commit `3c020d2` dan dapat dipulihkan dengan
  `git show 3c020d2:firmware/HID_Keypad/HID_Keypad.ino`.

### Changed
- Firmware RGB: label key di halaman RGB app diganti dari `R<row> C<col>` menjadi
  `RGB 1`..`RGB 9` mengikuti **urutan rantai LED fisik** (cermin `RGB_INDEX` di
  firmware). Balasan serial firmware ikut menyesuaikan: `[OK] RGB 6 (R1 C0) diset`.
- Preview animasi RGB page digerakkan Web Animations API (JS), bukan CSS
  `animation`, agar tidak bisa dimatikan oleh rule stylesheet maupun
  `prefers-reduced-motion`.
- Kontrol warna mode RGB tidak lagi memanggil `renderRgbAll()` di tiap event
  `oninput`, sehingga `RGB:MODE:` tidak dikirim per-pixel dan fase animasi tidak reset.
- Firmware: `USB.serialNumber()` sekarang memakai `HW_PROFILE_NAME` alih-alih
  hardcoded `"MACROPAD-proto"`, sehingga board FINAL tidak lagi menyamar sebagai prototipe.
- Selector sleep timeout kini dikunci (`disabled`) dengan penjelasan, karena firmware
  belum punya perintah sleep. Sebelumnya aktif tapi tanpa handler.

### Fixed
- **Notifikasi overlay mati total di rilis**: `src/overlay.html` tidak pernah ikut ter-build
  karena `vite.config.js` hanya mendeklarasikan `index.html` sebagai entry Rollup, padahal
  `lib.rs` membukanya lewat `WebviewUrl::App("overlay.html")`.(build -> `dist/` sekarang
  berisi `overlay.html`).
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

## Catatan status

Repo ini baru memakai git mulai Phase 0 roadmap. Rincian temuan, rencana, dan
urutan pengerjaan ada di `C:\Users\Raihan\.opencode\plan\macropad-roadmap.md`.