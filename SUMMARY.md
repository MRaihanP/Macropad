# SUMMARY.md — Milestone Ringkasan Proyek

**Proyek:** Macro Pad Configurator (companion app + firmware)
**Lokasi aktif:** `E:\05_Finish_projects\macropad-configurator`
**Salinan lama:** `D:\03_DevBox\Projects\firmware\app\macropad-configurator` (sudah dimigrasikan, **jangan diedit lagi**)
**HEAD:** `9e02312 wip: spike security config (belum diverifikasi di device)`
**Branch:** `master`, tanpa remote. Working tree **bersih**.
**Tanggal ringkasan:** 2026-10-09

---

## 1. Apa produk ini

Aplikasi desktop (Tauri 2 + vanilla JS + Rust) untuk mengonfigurasi macro pad
ESP32-S3 (matriks tombol 3×3 + rotary encoder) lewat **USB CDC serial 115200**,
dipasangkan dengan **firmware Arduino untuk dua profil board**:

| Profil | Isi | Kekhasan |
|---|---|---|
| **PROTOTYPE** | 1 knob, LED status biasa di GPIO12 | Tidak punya RGB, baterai, VBUS, charger. Angka baterai & RGB dikirim firmware sebagai **simulasi** (`simulated=1`), supaya seluruh alur UI bisa diuji. |
| **FINAL** | 2 knob, 9× SK6812 MINI-E | Punya RGB, voltage divider baterai 100k/100k, deteksi VBUS, status charger MCP73831. |

Ganti profil = membuka sketsh yang lain, bukan mengubah sakelar.

---

## 2. Cara kerja (arsitektur)

```
firmware/  ──serial ASCII per baris──>  src-tauri (Rust)  ──IPC invoke/event──>  src/ (JS)
   ▲                                                                                  │
   └────────────────────────── device (USB CDC / NUS BLE) ◄────────── HID keyboard ────┘
```

### 2.1 Alur runtime aplikasi

1. **Start** → `main.js` mengimpor semua modul, menyuntikkan dependensi lewat
   `initXxx({...})` (aturan proyek: modul tidak saling memanggil fungsi langsung
   agar bebas siklus import), menginisialisasi i18n → router → halaman → tray →
   transport, lalu mulai **paint-watchdog** terakhir.
2. **Koneksi** → `serial-transport.js` melakukan **auto-connect** ( polling
   daftar port 2 detik, retry 6× dengan backoff, re-probe port yang gagal).
   Kontrol COM manual dipindah ke panel `<details>` "Koneksi manual (advanced)"
   yang **sengaja di luar `#app`** supaya tetap bisa diakses saat device putus.
   Saat connect, app mengirim `LAYER:0` **sebelum** `INFO` agar tidak nyangkut
   di layer yang tersimpan di flash.
3. **Handshake** → `PING`/`WHOAMI`/`HWINFO`/`INFO`, isi device hidrasi lewat
   `applyInfo`/`applyDumpRow`/dll (semua indeks dari device divalidasi).
4. **Parsing** → satu baris device = satu aksi di `protocol-parser.js`
   (`handleLine`). App **tidak pernah** menulis state langsung dari output serial;
   semuanya lewat mutator tervalidasi di `device-state.js`.
5. **Adaptive Key Bind** → `adaptive.js` mem-poll aplikasi foreground
   (±1,2 detik), pindah layer otomatis bila preset aktif, dengan **jeda 1,5
   detik** setiap ada `EVT:LAYER:` (supaya preset tidak menimpa pilihan user)
   dan **blokir penuh saat dump berjalan**.
6. **Notifikasi** → `ui-notify.js` meneruskan ke Rust, yang manages jendela
   overlay always-on-top (dibuat runtime 3 detik setelah start, ada pemulihan
   reload/hilang).
7. **Keluar** → dialog "Simpan dulu?" untuk event X maupun menu tray; tray juga
   menyediakan autostart Windows dan hide-to-tray.

### 2.2 Struktur folder

```
firmware/common/     limits.h, macropad_core.h (1132 b), transport.h,
                     transport_usb.h, rgb_effects.h
firmware/HID_Keypad_Prototype/, HID_Keypad_Final/
firmware/spike_ble_hid/          (throwaway, tidak ikut build produksi)
src/                              15 modul JS + index.html + overlay.html + styles.css
src-tauri/src/                   lib.rs (1287 b) + ble.rs (283 b)
dist/                            hasil vite build (2 entry: index + overlay)
```

### 2.3 Modul `src/` (sudah dipecah di Phase 8, `main.js` 1864 → 269 baris)

| Modul | Baris | Tugas |
|---|---|---|
| `main.js` | 269 | Composition root: menyuntik hook ke semua modul, memegang flag "belum tersimpan", wiring tombol |
| `device-state.js` | 172 | Satu-satunya pemilik model device + mutator tervalidasi (anti NaN/prototype pollution) |
| `serial-transport.js` | 401 | Port, connect/disconnect, auto-connect + retry backoff, line buffer, kirim perintah |
| `protocol-parser.js` | 268 | Kontrak app↔firmware dalam satu fungsi reduktor yang bisa diuji tanpa browser |
| `adaptive.js` | 571 | App Preset: CRUD, editor, poll foreground app, cache slot firmware, hold auto-switch |
| `rgb-page.js` | 251 | Halaman RGB: grid 9 key, mode/brightness/warna/kecepatan, preview animasi WAAPI |
| `home-page.js` | 375 | Tab layer (drag-reorder), grid tombol, daftar binding knob, panel editor, rekam keyboard |
| `app-picker.js` | 108 | Pemilih aplikasi terinstal (consent + TTL + cache lokal) |
| `battery-ui.js` | 95 | Indikator baterai/charger, notifikasi ambang 20%/10%, badge SIMULASI |
| `tray.js` | 132 | Tray icon, autostart, konfirmasi belum-tersimpan |
| `ui-router.js` / `ui-modal.js` / `ui-notify.js` | 81/108/55 | Routing halaman, modal (focus trap), preferensi notifikasi + `notify()` |
| `i18n.js` + `locales/` | 229 + ~270 tiap | ID/EN, deteksi locale Windows, `data-i18n`, pelacakan kunci hilang |
| `overlay.js` / `paint-watch.js` / `dom.js` | 83/29/28 | Jendela notifikasi, watchdog jendela putih, helper DOM |

### 2.4 Backend Rust (`src-tauri/src/lib.rs`)

29 perintah Tauri terdaftar, dikelompokkan:
- **Aplikasi:** `apps_get/set_consent/set_ttl/rescan/pick_exe/add_custom/remove_custom`,
  `launch_app`, `get_foreground_exe`, `scan_bindable_apps`
- **Preset:** `presets_get`, `presets_save` (tulis atomik + backup file korup)
- **Jendela/tray:** `show_main_window`, `hide_to_tray`, `quit_app`
- **Autostart & locale:** `autostart_status`, `autostart_set`, `system_locale`
- **Overlay & watchdog:** `notify`, `overlay_ready`, `paint_script_ran`, `paint_first_frame`
- **BLE (Phase 10):** `ble_scan`, `ble_connect`, `ble_disconnect`, `ble_write`, `ble_read`, `ble_is_connected`

Konfigurasi: window utama 1000×720 (min 400×720), `visible: false` (ditampilkan dari Rust
kecuali mode `--autostart`), CSP ketat, drag-drop dimatikan, `--disable-gpu`.
Capability dipisah dua: `default.json` (window `main`) dan `overlay.json`
(window `overlay`, hanya `core:event:allow-listen`).
Jendela overlay **tidak** ada di `tauri.conf.json` — dibangun runtime oleh
`build_overlay()` (480×90, transparan, always-on-top, ignore cursor, WebView2
data dir terpisah).

### 2.5 Protokol (ASCII, satu baris per perintah, `\n` di akhir)

Perintah app→device utama: `PING`, `WHOAMI`, `INFO`, `HWINFO`, `BATT`,
`SET/GET`, `SETENC`, `DUMP/DUMPNAMES/DUMPENC`, `ADDLAYER/DELLAYER/RENAMELAYER/MOVELAYER`,
`LAYER:<n>`, `SAVE/LOAD/RESET`, `CONTEXT:*`, `SLOT:*`, `RGB:ON/OFF/EN/MODE/BRI/ALL/KEY/DUMP/SAVE/RESET`.
Baris device→app: `INFO:`, `HWINFO:`, `BATT:`, `EVT:BATT:`, `EVT:CHG:state=`,
`EVT:LAYER:n`, `EVT:ESCAPE`, `EVT:ENC:n:CW|CCW`, `EVT:APP:<nama>`,
`DUMP_BEGIN/DUMP_END`, `NAMES_BEGIN/NAMES_END`, `IDX:`, `RGB_DUMP:/RGB_KEY:`,
`[KEY]`, `[ENC_BTN]`, `[OK]`, `[ERROR]`, `[FLASH]`, `[LAYER]`.
Spesifikasi lengkap (termasuk konstanta & 3 batasan yang mudah dilanggar) ada di
`README.md` §Protokol serial.

Tiga batasan penting:
- **`[KEY]` maksimal 62 byte** (buffer stack `vprintf` 64 byte).
- **`currentLayer` ikut tersimpan ke flash** (bagian struct `cfg` yang sama) →
  app kirim `LAYER:0` saat connect.
- **`DUMP:<n>` tidak memindahkan layer aktif** → jalur baca aman tanpa `LAYER:`.

### 2.6 Firmware

`macropad_core.h` memegang seluruh logika bersama: keymap, config flash
(`CONFIG_VERSION=5`), scan matrix (debounce 30 ms), encoder quadrature state
machine (4 langkah/detent), gestur (ganti layer ≥1 detik, escape ≥3,5 detik),
eksekusi aksi, parser perintah, laporan baterai. `limits.h` memuat konstanta
(`ROWS/COLS=3`, `MAX_LAYERS=8`, `MACRO_MAX_LEN=48`, `RGB_COUNT=9`, `APP_SLOTS=6`,
`RGB_INDEX` 3×3, pin per profil).
Transport sudah diabstraksi (`transport.h` interface + `transport_usb.h`), core
memakai makro `SERIAL->`; `TRANSPORT_TYPE` di `limits.h` default `TRANSPORT_USB`.
`rgb_effects.h` adalah **mesin efek RGB 9 mode sebagai fungsi murni** (tanpa
Arduino, tanpa `millis()`, tanpa global) — bisa dijalankan di Node.

---

## 3. Fitur yang sudah ada (sudah berfungsi)

**Dasar**
- Koneksi USB CDC dengan **auto-connect + auto-reconnect + backoff**, deteksi
  device hilang, panel connect manual sebagai jaring pengaman.
- Jendela overlay notifikasi always-on-top, tray icon, autostart Windows,
  hide-to-tray, dialog "simpan dulu?".
- Multi-bahasa **Indonesia/English** (auto-deteksi dari bahasa Windows saat
  first run + pengalih manual di Setting).
- Watchdog jendela putih (`paint-watch.js` → reload otomatis).

**Grid & layer**
- 3×3 grid, 5 tipe aksi: **teks, kombinasi tombol, macro, consumer/media, buka aplikasi**.
- Rekam keyboard beruntun (Enter/Space/Backspace/Delete), Escape jadi jalan keluar
  yang terdokumentasi (fix keyboard terkunci).
- Layer: tambah, hapus, rename, geser urutan, drag-reorder tab, max 8 layer.
- Save/Load/Reset ke flash, dengan indikator "belum tersimpan" di tray & app.

**Rotary encoder**
- Binding per encoder untuk CW / CCW / tombol, multi-knob (FINAL 2 knob).
- Ganti layer & gestur escape dari device.

**Adaptive Key Bind**
- Preset per aplikasi: pemindaian aplikasi terinstal (dengan consent), tambah
  `.exe` manual, aktif/nonaktifkan preset, konflik preset ditangani otomatis.
- Auto layer switch + **hold 1,5 detik** setelah user pindah layer + blokir saat dump.
- Slot cache di firmware (`CONTEXT:*`, `SLOT:*`) agar layer switch cepat.

**Baterai & chargER**
- Persentase, mV, status charger (tidak mengecas / mengecas / selesai), notifikasi
  ambang lemah & kritis, badge **SIMULASI** untuk PROTOTYPE.

**RGB**
- 9 mode efek, brightness, warna per key, kecepatan, enable, save/reset, dump,
  preview animasi di app.

**Aksesibilitas (Phase 9)**
- Navigasi sidebar/grid/layer/knob penuh dari keyboard, `role="dialog"` + focus
  trap + focus restore, focus ring global, live region untuk status/log/status
  RGB, label & `aria-valuetext` untuk slider & color picker.

**Hardening (Phase 7)**
- CSP ketat, capability dipisah & diminimalkan, `withGlobalTauri: false`,
  `Window::eval` diganti event, tulis file atomik, backoff command blocking ke
  thread terpisah, allowlist aplikasi.

---

## 4. Riwayat fase (dari `CHANGELOG.md`)

| Fase | Isi | Status |
|---|---|---|
| 0 | Safety net: `git init`, baseline commit, `CHANGELOG.md` | Selesai |
| 1 | Quick wins: overlay masuk build, validasi index, escaping, CSS, dead code | Selesai |
| 2 | Pisah firmware PROTOTYPE/FINAL + `common/` | Selesai |
| 3 | Data baterai & RGB dari firmware (bukan dummy app) + badge SIMULASI | Selesai |
| 4 | Transport reliability: unlisten bocor, buffer tak terbatas, parser tahan data rusak | Selesai |
| 5 | Kontrak protokol: waiter DUMP per-layer + timeout, pisahkan read vs switch layer | Selesai |
| 6 | Hilangkan bekuan firmware: blink dibatasi, gestur app, log key (6.1 ditunda) | Selesai |
| 7 | Hardening: CSP, izin Tauri, `eval`→event, file atomik, test Rust | Selesai |
| 8 | Refactor `main.js` 1864 → 263 baris jadi 15 modul bebas siklus | Selesai |
| 9a | Aksesibilitas | Selesai |
| 9b | i18n ID/EN | Selesai |
| 10.x | Fondasi BLE: abstraksi transport firmware + modul WinRT GATT (`ble.rs`) + sembunyikan kontrol COM + spike kelayakan | **Belum tuntas** |

---

## 5. Hasil verifikasi (dijalankan ulang hari ini, 2026-10-09)

| Yang diuji | Perintah | Hasil |
|---|---|---|
| Unit test Rust | `cargo test --lib` (di `src-tauri`) | **9 passed**, 0 failed (1 warning `unused_imports`) |
| Build frontend | `npx vite build` | Sukses, 32 modul, `index.html` + `overlay.html` |
| Skrip uji Node | `node %TEMP%\opencode\run-all-tests.mjs` | **30/30 suite hijau** |

Rincian 30 skrip uji: `a11y-test`, `adaptive-contract-test`, `battery-ui-test`,
`device-state-test`, `dump-waiter-test`, `encoder-quadrature-test`,
`firmware-compile-guard-test`, `i18n-test`, `import-cycle-check`, `key-event-test`,
`layer-hold-test`, `layer-hold-behaviour-test`, `manual-connect-test`,
`no-lost-functions-test`, `parser-wiring-test`, `preset-layer-test`,
`protocol-contract-test`, `protocol-parser-test`, `readme-protocol-test`,
`reconnect-layer0-test`, `record-escape-test`, `retry-test`, `rgb-effects-test`,
`rgb-page-test`, `rgb-savestate-a11y-test`, `serial-transport-test`,
`settings-test`, `spike-test`, `spike2-test`, `startup-smoke-test`, `version-test`.

> ⚠️ **Penting:** skrip uji **tidak berada di dalam repo**. Semuanya di
> `C:\Users\Raihan\AppData\Local\Temp\opencode\` bersama runner
> `run-all-tests.mjs`. Kalau folder temp itu dibersihkan, seluruh jaringan
> pengujian hilang tanpa jejak di git. **Langkah berikutnya: pindahkan ke
> `tests/` di dalam repo** dan tambahkan `npm test`.

---

## 6. Yang belum selesai

### 6.1 Fase 10 — BLE (target utama yang sedang berjalan)

Rencana (`C:\Users\Raihan\.opencode\plan\ble-hid-plan.md`, rev 1) mengubah
target BLE dari "saluran konfigurasi (NUS)" menjadi **HID sungguhan**: device
mencetak key ke Windows seperti keyboard biasa, **sambil** NUS tetap melayani
protokol konfigurasi — keduanya dari satu GATT server.

- [x] Step 1–5 (Fase A): selaraskan versi, spesifikasi protokol di README,
      `aria-live` status RGB, pause auto-switch, RGB engine step 1 (fungsi murni)
- [x] Step 6: spike kelayakan BLE HID — **v1 gagal di device** ("pair berhasil,
      beberapa detik kemudian disconnect sendiri, tidak bisa connect lagi").
      Penyebabnya dibuktikan dari source core Arduino 3.3.11: advertising
      mati permanen setelah disconnect (`m_advertiseOnDisconnect = false`
      default), passkey acak yang merusak bond, service HID tidak lengkap,
      Report ID tidak cocok, dan lookup characteristic per ketikan.
      **v2 sudah ditulis** (`spike_ble_hid2.ino`) dengan 8 perbaikan —
      menunggu di-flash dan diuji.
- [ ] Step 7: `iface` masuk `HWINFO`
- [ ] Step 8: `firmware/common/transport_ble.h` (jalur NUS)
- [ ] Step 9: **BLE HID keyboard** (device muncul sebagai keyboard di Windows)
- [ ] Step 10: runtime interface switch `IFACE:BLE` / `IFACE:USB`
- [ ] Step 11: app — handler BLE (scan/connect/reconnect/notify)
- [ ] Step 12: app — pengecualian prototipe (baca `iface`, connect BLE)
- [ ] Step 13: app — switch COM↔BLE di panel Advanced
- [ ] Step 14: harness parity (satu skrip perintah di USB & BLE, diff ternormalisasi)
- [ ] Step 15: firmware FINAL tanpa bypass BLE + **RGB engine step 2** (9 mode animasi)
- [ ] Step 16: app mendukung firmware FINAL (hapus bypass prototipe)

Status sekarang: 6 perintah BLE Rust **terdaftar dan kompilasi**, tapi **belum
dipakai frontend** sama sekali. Yang masih terpasang adalah dropdown COM +
tombol Refresh/Connect di panel advanced.

### 6.2 RGB engine step 2 (butuh hardware FINAL)

`rgb_effects.h` sudah menjadi fungsi murni yang benar dan sudah diuji, tapi
**belum dipakai firmware**: tidak ada sketsh yang meng-include-nya, dan
`rgbApplyState()` di FINAL hanya menerjemahkan mode menjadi **warna statis**
(mode selain 1 = satu warna rata untuk 9 LED) lalu `rgbRender()`. Belum ada
counter phase, jadi breathing/rainbow/wave/snake/random/react belum beranimasi.
Di PROTOTYPE `rgbApplyState()` kosong (tidak ada LED fisik).

### 6.3 Utang teknis & ide

- **Firmware belum pernah di-verifikasi di device.** Tidak ada toolchain Arduino
  di lingkungan ini; pemeriksaan hanya statis. `STATUS-AND-TESTING.md` §2.6
  memuat checklist wajib sebelum rilis (compile kedua sketsh, flash, ulangi
  semua uji manual, cek `EVT:CHG` dengan/tanpa VBUS, cek 9 mode RGB).
- **Filter waktu untuk rotary encoder** — state machine quadrature sudah
  menangani bounce di detent, tapi noise acak masih bisa terlihat sebagai
  putaran nyata. Gejala: langkah acak saat knob diam.
- **Phase 6.1** (pindahkan scan matrix + serial ke task FreeRTOS) **ditunda
  dengan sengaja** — `Keyboard`, `Adafruit_NeoPixel`, `Preferences` belum
  thread-safe, dan refactor itu tidak bisa diuji tanpa hardware.
- **Bonding/pairing BLE** — masalah masih terbuka; ada ide murah yang belum
  dicoba: advertise sebagai *non-bondable device* (biaya ±5 menit) sebelum
 PlatformIO.
- **PlatformIO** — ruminasi, belum diputuskan. Tradeoff yang harus disadari: `platform =
  espressif32` memakai core ESP32 **2.x**, sedangkan Arduino memakai **3.3.11**
  (perbedaan startup BLE & API `BLESecurity`).

---

## 7. Catatan penting tentang salinan di D:

`D:\03_DevBox\Projects\firmware\app\macropad-configurator` masih ada dengan
HEAD yang sama, tapi working copy-nya **berisi perubahan yang lebih tua dan
merusak** — working tree D: terlihat seperti regressive/snapshot sebelum
beberapa fix penting, antara lain:

- `transport.h` mengembalikan enumerator ke `TRANSPORT_USB/BLE` (bentrok dengan
  makro `#define` → **firmware tidak bisa dikompilasi**) dan menghapus
  `#undef SERIAL`;
- `transport_usb.h` mengembalikan `Serial.dtr()` (tidak bisa dikompilasi di core 3.3.x);
- `lib.rs` kehilangan `#[cfg(test)]` pada beberapa fn, menambah blok stub BLE yang
  **duplikat** dengan `ble.rs`, dan memakai `unsafe`/`from_utf16_lossy` yang tak perlu;
- `locales/*.js` menambah kunci duplikat (`editor.recordHint` tertulis dua kali).

**Kesimpulan:** repo E: adalah sumber kebenaran. Semua travaille berikutnya harus
di E:. Setelah E: terverifikasi (sudah — 9/9 Rust, 29/29 Node, build sukses),
salinan D: **boleh dihapus** untuk hemat ruang (D: tinggal ~2,9 GB).

---

## 8. Rekomendasi langkah berikutnya (untuk discussion)

1. **Amankan dulu (murah, preventative):** pindahkan 29 skrip uji dari folder temp
   ke `tests/` dalam repo + `npm test` + tambahkan `tests/` ke docs. Saat ini
   seluruh jaringan pengujian proyek ini tidak ada di git.
2. **Konfirmasi spike (blocking):** sudahkah `spike_ble_hid.ino` di-flash dan
   diuji di device? Jawaban menentukan apakah Fase B BLE dilanjutkan apa adanya
   atau perlu pivot. Ini satu-satunya pertanyaan yang tidak bisa dijawab dari repo.
3. **Jika spike OK → RGB engine step 2** (`rgbApplyState()` memanggil
   `rgbFrame()` + counter phase) karena itu pekerjaan firmware yang bisa
   diselesaikan tanpa menunggu BLE dan ada test deterministiknya sudah siap.
4. **Jika spike GAGAL → kembali ke USB**, perbaiki `HWINFO iface` + bersihkan
   `Cargo.toml` yang belum dipakai, lalu fokus ke checklist rilis firmware.

Sebelum langkah mana pun: `cargo test --lib`, `npx vite build`, `run-all-tests.mjs`
— semua hijau; lalu update `CHANGELOG.md` dan satu commit per perubahan.

---

## 9. Referensi dokumen

| Berkas | Isi |
|---|---|
| `README.md` | Struktur, aturan import, **spesifikasi protokol lengkap**, build, pengujian |
| `docs/STATUS-AND-TESTING.md` | Ringkasan perkembangan + prosedur uji 6 tingkat (otomatis → hardware) |
| `CHANGELOG.md` | Riwayat sangat detail per fase, termasuk uji negatif yang dilakukan |
| `SUMMARY.md` | dokumen ini |
| `%USERPROFILE%\.opencode\plan\macropad-roadmap.md` | Roadmap Fase 0–10 (revisi 2) + temuan awal |
| `%USERPROFILE%\.opencode\plan\ble-hid-plan.md` | Rencana BLE HID Fase A/B step 1–16 (revisi 1) |
| `%TEMP%\opencode\plan-migrasi.md` | Rencana & hasil migrasi repo D: → E: |
| `%TEMP%\opencode\spike2-test.js` | Verifikasi statis spike v2 (69 pemeriksaan) |
| `%TEMP%\opencode\negative-spike2.mjs` | Uji negatif 24 mutasi untuk spike2-test |