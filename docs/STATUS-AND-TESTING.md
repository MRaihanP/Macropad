# Ringkasan Developments & Prosedur Pengujian

Dokumen ini berisi dua hal:

1. **Ringkasan perkembangan** — apa yang sudah selesai dan apa yang belum.
2. **Prosedur pengujian** — langkah-langkah memastikan semua fitur aman.

Versi saat dokumen ini diperbarui: **app `0.6.1` / firmware `FW_VERSION 8`**
(tag `app-v0.6.1`, `fw-v8`). Cek firmware yang terpasang lewat `WHOAMI` di
Serial Monitor 115200 — jawabannya harus `fw=8`.

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
- Perintah BLE (`ble_scan`, `ble_connect`, `ble_disconnect`, `ble_write`,
  `ble_read`, `ble_is_connected`) sudah dipakai `src/ble-transport.js`.
- Perintah Tauri: aplikasi, consent, autostart, locale, bindable apps, preset,
  notifikasi, overlay, foreground exe.
- Modul BLE (`src-tauri/src/ble.rs`) sudah ada dan **kompilasi bersih**.

#### Aplikasi (JavaScript)

- Seluruh suite uji Node hijau (35 suite lewat `npm test`).
- `vite build` sukses.
- Aksesibilitas: navigasi sidebar & layer dengan keyboard, modal dengan focus trap
  dan focus restore, live region untuk status & log.
- i18n: ID + EN, deteksi otomatis dari bahasa Windows pada first run,
  pengalih manual di halaman Setting.

### 1.2 Yang belum selesai

#### BLE — sisi firmware & app (selesai, rilis 0.6.1 / `FW_VERSION 8`)

- **Sisi firmware**: `BleTransport` sudah diimplementasikan di
  `firmware/common/transport_ble.h` (notify + ring buffer + guard retry).
  Abstraksi `transport.h` tetap dipakai; `HID_LINK_DEFAULT` masih `HID_LINK_USB`
  dan `PROTO_DEFAULT` masih `PROTO_CDC`, jadi device **selalu boot di USB** —
  perpindahan ke BLE harus diminta eksplisit (tombol BOOT / `IFACE:BLE`).
- **Sisi Rust**: `ble_scan`, `ble_connect`, `ble_disconnect`, `ble_write`,
  `ble_read`, `ble_is_connected` sudah dipakai frontend lewat
  `src/ble-transport.js`.
- **Sisi JavaScript**: ada backend BLE di `src/ble-transport.js` di balik facade
  `src/transport.js`. Auto-connect / auto-reconnect sudah jalan
  (retry berjenjang, device terakhir yang berhasil dicoba lebih dulu).
- Selector USB/BLE ada di panel Koneksi.

Sisa pekerjaan BLE yang **belum** selesai ada di `SUMMARY.md` §6.1: BLE HID
sebagai keyboard Windows (Step 9), harness parity USB↔BLE (Step 14), dan
dukungan firmware FINAL penuh (Step 15–16).

#### Firmware FINAL — mesin efek RGB

`rgbApplyState()` baru menerjemahkan mode menjadi warna per LED, **belum
menganimasikannya** (breathing / rainbow / wave / snake / random / react belum jalan).
Preview di app sudah jalan, tapi device FINAL belum. Butuh hardware.

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

# C. Seluruh skrip uji Node (runner resmi)
npm test                      # harus: "35/35 suite hijau, 0 bermasalah"

# D. Uji negatif (menolak jalan kalau working tree kotor)
npm run test:negative         # commit dulu sebelum menjalankan ini
```

Runner di `tests/runner/run-all.mjs` yang discovering skrip di `tests/suites/`,
jadi skrip baru ikut jalan tanpa perlu didaftarkan manual. Kalau ada suite FAIL,
jangan commit — perbaiki dulu.

> Catatan: kalau kamu menambah skrip uji, cukup taruh di `tests/suites/`.
> Berkas `.cjs` wajib pakai `require`, bukan `import`.

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

### 2.6 Tingkat 6 — Uji firmware (wajib, belum bisa di sini)

Tidak ada toolchain Arduino di lingkungan pengembangan, jadi firmware hanya
diverifikasi **statis** (kurung kurawal seimbang, simbol domain terdefinisi,
region verbatim utuh, kontrak offset protokol firmware↔app).

Sebelum rilis:

- [ ] `arduino-cli compile` untuk **kedua** sketsh (PROTOTYPE & FINAL) tanpa error/warning.
- [ ] Flash ke device dan ulangi seluruh uji di Bagian 2.3.
- [ ] Cek ukuran flash & RAM dipakai tidak mendekati batas.
- [ ] Uji FINAL saat VBUS terpasang → `EVT:CHG:state=0/1/2` (tidak mengisi / mengisi /
      selesai) benar.
- [ ] Uji FINAL tanpa VBUS → `usb=0`, `charging=0`.
- [ ] **Mesin efek RGB FINAL** — setelah diimplementasikan: breathing, rainbow, wave,
      snake, random, react semuanya jalan dan tidak flicker.

### 2.7 Prosedur per-commit

Sebelum setiap commit:

1. `npm test` → semua suite hijau.
2. `npm run build` (atau `npx vite build`) → sukses.
3. `cargo test --lib` → hijau (9 passed).
4. Kalau ada yang menyentuh firmware:
   `arduino-cli compile --fqbn esp32:esp32:esp32s3 --no-color firmware/HID_Keypad_Prototype`
   dan sketsh `HID_Keypad_Final` juga.
5. `git status` — pastikan tidak ada file yang tidak sengaja ikut (mis. `dist/`,
   `target/`, `node_modules/`).
6. Update `CHANGELOG.md`: **Added / Changed / Fixed / Removed**.
7. Kalau versi naik: samakan `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json` (dicek `tests/suites/version-test.cjs`), dan
   `FW_VERSION` di `firmware/common/limits.h` + header kedua sketsh
   (dicek `tests/suites/firmware-compile-guard-test.js`).
8. Commit dengan pesan yang menyebut nomor fase.

Kalau ada regresi setelah commit: `git revert <hash>` (jangan `reset --hard`,
supaya riwayatnya tetap bisa ditelusuri). Untuk rollback total ke checkpoint,
lebih baik pindah ke tag (`checkpoint-*`) daripada menumpuk revert.

---

## 3. Hasil verifikasi terakhir

| Yang diuji | Hasil |
|---|---|
| `cargo check` | Bersih (0 error) |
| `cargo test --lib` | **9 passed**, 0 failed |
| `npm run build` (vite) | Sukses |
| `npm test` | **35/35 suite hijau** |
| `arduino-cli compile` PROTOTYPE | Sukses |
| `arduino-cli compile` FINAL | Sukses |

> Angka di tabel ini berasal dari eksekusi nyata pada rilis 0.6.1 / `FW_VERSION 8`.
> Jalankan ulang seluruh baris di [Bagian 2](#2-prosedur-pengujian) sebelum
> mempercayai tabel ini untuk perubahan berikutnya.

### Yang belum terverifikasi

- Perilaku nyata di device — lingkungan build tidak punya akses ke hardware.
  Yang sudah dilakukan baru uji manual oleh pengguna: `[BLE] DUMP never closed`
  dilaporkan hilang setelah firmware 0.6.1 di-flash.
- Fase FINAL yang butuh charger/VBUS/RGB asli.
- BLE HID sebagai keyboard Windows (Step 9 di `SUMMARY.md` §6.1).
