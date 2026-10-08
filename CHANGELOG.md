# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Rencana lengkap ada di `C:\Users\Raihan\.opencode\plan\macropad-roadmap.md`.

### Fixed
- **Arah rotary encoder kadang terbalik satu langkah** ("diputar ke kiri kadang
  terbaca kanan"). Penyebabnya ISR lama hanya bereaksi saat pin A LOW lalu membaca B
  pada saat itu juga. Saat pantulan (bounce) pada detent, B sudah berubah ketika A LOW
  untuk kedua kalinya, sehingga satu putaran terbaca sebagai arah yang terbalik.
  Diganti **state machine quadrature penuh**: setiap perubahan A/B disimpan sebagai
  state 2-bit, arah diambil dari tabel transisi, transisi tidak valid (A dan B berubah
  bersamaan) diabaikan, dan langkah baru baru diumumkan setelah 4 transisi searah
  (= 1 detent). ISR sekarang dipasang pada **kedua pin** A dan B; sebelumnya hanya
  pin A sehingga separuh transisi quadrature tidak pernah terlihat. Arah CW sengaja
  dibuat sama dengan cara lama (A LOW + B HIGH = CW) supaya tidak perlu membalik
  kiri/kanan pada knob mana pun.
- `applyName()` sempat diekspor tetapi belum dipasang di `main.js` — ditemukan oleh
  test wiring sebelum commit.

### Changed
- **Refactor Tahap 1: state device dipindah ke `src/device-state.js`.**
- **Refactor Tahap 1: state device dipindah ke `src/device-state.js`.** `main.js` punya
  77 `let`/`const` global, dan keadaan yang dilaporkan device (`ROWS`, `COLS`,
  `NUM_ENCODERS`, `currentLayer`, `layerCount`, `maxLayers`, `mapping`, `layerNames`,
  `encConfig`) ditulis dari lima tempat berbeda sekaligus. Semuanya kini hidup di satu
  modul dengan **mutator tervalidasi**:
  - `applyInfo()` — field numerik `INFO:` dibatasi rentang; nilai buruk dilaporkan, bukan
    ditelan. Perubahan dimensi juga mengalokasikan ulang `mapping`.
  - `applyDumpRow()` — indeks layer/baris/kolom/tipe divalidasi; nilai ber-koma tetap
    utuh karena field terakhir adalah sisa baris.
  - `applyEncRow()` — allowlist kunci `CW`/`CCW`/`BTN` (menutup prototype pollution).
  - `applyName()`, `applyLayerEvent()`, `applyEncCount()`, `applyEncIdx()`.
  - `reorderLayer()` — nama layer dan keymap digeser bersama, tidak terpisah.
  Nilai diekspor sebagai **live binding**, jadi kode yang hanya membaca tidak berubah;
  kode yang menulis memakai setter. `main.js` turun dari 1864 ke 1841 baris dan dari 77
  ke 69 global.

### Added
- **Test modul `device-state.js` yang meng-import-nya secara langsung** (sebelumnya test
  harus menyalin potongan kode keluar dari `main.js` sebagai teks). Karena itu validasi
  indeks device akhirnya bisa diuji menyeluruh, termasuk kasus yang belum pernah diuji:
  indeks negatif, `Infinity`, `1.5`, nilai non-numerik, dan percobaan prototype pollution
  lewat `__proto__` dan `constructor`.
- Test wiring parser: memastikan `main.js` meneruskan semua baris device ke mutator dan
  **tidak** menulis langsung ke `mapping`/`encConfig` dari output serial.

### Fixed
- `applyName()` sempat diekspor tetapi belum dipasang di `main.js` — ditemukan oleh test
  wiring sebelum commit.
- Notifikasi **baterai lemah** (`batt-low`, ≤20%) dan **baterai kritis** (`batt-crit`, ≤10%).
  Sebelumnya tidak ada sama sekali padahal toggle "Notifikasi baterai" sudah menjanjikan
  "Battery Low". Notifikasi hanya dibunyikan saat ambang baru dilewati, bukan tiap `EVT:BATT`
  yang datang setiap 5 detik; ambang direset saat baterai naik atau mulai mengecas supaya
  bisa berbunyi lagi di siklus berikutnya.
- Warna khusus untuk notifikasi baterai di overlay (`charge`, `charge-done`, `batt-low`,
  `batt-crit`) supaya tidak tertukar dengan notifikasi dasar.

### Changed
- **Default semua aktif**: Adaptive Key Bind (`presetsData.masterEnabled`), notifikasi per
  key, dan notifikasi baterai. Ketiganya sudah punya persistensi — notifikasi lewat
  `localStorage` (`macropad.settings`), Adaptive lewat `presets.json` — jadi pilihan user
  bertahan setelah app ditutup.

### Fixed
- **Notifikasi baterai sebenarnya tidak dikendalikan toggle "Notifikasi baterai".** Handler
  `EVT:CHG` mengirim dengan kind `'batt'`, yang tidak ada di daftar filter `notify()` —
  sehingga jatuh ke cabang "dasar" dan ikut mati saat toggle Notifikasi dasar dimatikan.
  Sekarang memakai kind `charge` / `charge-done` yang memang dibaca filter.
- Teks petunjuk toggle "Notifikasi baterai" menyebut "CHARGE NOW" yang tidak pernah ada;
  diganti sesuai perilaku sebenarnya.
- `presets_save` dari toggle Adaptive di halaman Home memakai `.catch(()=>{})` sehingga
  kegagalan penyimpanan tidak kelihatan — user mengira toggle tersimpan padahal akan
  kembali ke nilai lama setelah app ditutup. Sekarang errornya dicatat.

### Added
#### Fase sebelumnya
- Unit test Rust untuk `find_app()` (6 test). Ini test pertama di repo ini; sebelumnya
  tidak punya test sama sekali.
- Capability terpisah `capabilities/overlay.json` untuk jendela notifikasi, dengan izin
  seminimal mungkin (`core:event:allow-listen`). Sebelumnya jendela overlay tidak punya
  capability apa pun — aman hanya secara kebetulan.

#### Phase 6 — kurangi bekuannya firmware
- **`blinkLedTimes()` jadi non-blocking** (`serviceLedBlink()`), jumlah kedipan dibatasi 4.
  Dulu 8 layer = 8 × 240ms = **1,92 detik buta**; karena `scanMatrix()` hanya mengambil
  sampel (bukan mengantre), setiap penekanan tombol pada periode itu hilang tanpa jejak.
- **Gestur "buka aplikasi" jadi bertahap** (`serviceOpenApp()`). Dulu
  `delay(80) + 450 + 450ms` ≈ 1 detik beku total; sekarang hanya `Keyboard.print()` di
  library HID yang masih blocking (~1ms per karakter).
- **Kedipan escape jadi non-blocking** (`serviceEscapeBlink()`), menggantikan
  `delay(100) + delay(300)`.
- Semua fungsi `service*` dipanggil dari `loop()`.

#### Fase 3–5 — data dari device, transport, kontrak protokol
- State RGB dipindahkan ke **core** (`RgbState` di `common/limits.h`) dengan tiga hook per
  profil (`rgbApplyState`/`rgbPersist`/`rgbRestore`), sehingga `RGB:DUMP` bisa melaporkan
  state aktif dan PROTOTYPE maupun FINAL memakai protocol identik.
- `EVT:BATT` periodik (5 detik) + `EVT:CHG` saat status charger berubah;
  `battPercentFromMv()` dengan kurva LiPo bertingkat.
- `EVT:BATT:`, `EVT:CHG:`, `RGB_DUMP:`, `RGB_KEY:`, `HWINFO:` (dengan `rgbSlots`, `chg`,
  `simulated`) kini diparse app; badge **SIMULASI** di header menandai angka firmware
  prototipe agar tidak tertukar dengan data hardware asli.
- Waiter `DUMP` dipetakan per layer dengan timeout 3 detik.
- Batas panjang `lineBuffer` (64 KB) plus resync dari newline terakhir.

### Changed

#### Fase 7
- **CSP dikunci.** `tauri.conf.json` sebelumnya `"csp": null` — tidak ada pembatasan
  sama sekali. Sekarang `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `connect-src` dibatasi ke diri sendiri + kanal IPC Tauri. Diverifikasi aman: tidak ada
  inline script maupun inline event handler, dan 17 atribut `style` + 31 property
  `.style` sudah tertutup `style-src 'unsafe-inline'`.
- `withGlobalTauri` → `false`. Tidak ada pemakaian `window.__TAURI__` di app.
- Izin Tauri dipangkas: `opener:default`, `core:window:allow-destroy`, dan
  `core:window:allow-close` **dihapus** (tidak pernah dipakai); `serialplugin:default`
  diganti 9 izin eksplisit (sebelumnya ~30 izin termasuk operasi biner, kontrol sinyal
  modem, dan `close-all`).
- `dragDropEnabled: false` pada jendela utama — app sudah punya drag-drop sendiri dengan
  Pointer Events untuk mengurutkan tab, sebelumnya bertabrakan dengan drag-drop bawaan.
- Fitur `windows` crate yang tak terpakai dibuang: `Foundation`,
  `Foundation_Collections`, `Devices_Bluetooth`, `Devices_Bluetooth_GenericAttributeProfile`,
  `Devices_Enumeration`, `Storage_Streams`. `cargo check` tetap lolos tanpa warning;
  akan ditambahkan kembali saat BLE dikerjakan.
- `loadLayer(l)` kini **hanya membaca**; `switchLayer(l)` terpisah untuk klik tab.
  Firmware bisa mendump layer mana pun tanpa berpindah layer dan `SET:<layer>:...` menyebut
  nomornya eksplisit, jadi jalur baca tidak perlu mengirim `LAYER:` — yang selama ini
  justru memindahkan layer aktif milik user.
- Sisa `delay()` di firmware hanya dua: `delay(15)` (jeda modifier di `executeCombo`)
  dan `delay(300)` di `setup()`.
- Indikator baterai: angka dummy yang turun 1% tiap 2 detik lalu reset ke 100% **dihapus**.
- Firmware RGB: label key di halaman RGB app diganti dari `R<row> C<col>` menjadi
  `RGB 1`..`RGB 9` mengikuti **urutan rantai LED fisik**. Balasan serial firmware ikut
  menyesuaikan: `[OK] RGB 6 (R1 C0) diset`.
- Preview animasi RGB page digerakkan Web Animations API (JS), bukan CSS `animation`,
  agar tidak bisa dimatikan oleh rule stylesheet maupun `prefers-reduced-motion`.
- Firmware: `USB.serialNumber()` memakai `HW_PROFILE_NAME`, bukan hardcoded
  `"MACROPAD-proto"` — board FINAL tidak lagi menyamar sebagai prototipe.
- Selector sleep timeout dikunci dengan penjelasan; sebelumnya aktif tapi tanpa handler.
- Firmware dinormalkan ke line ending LF sesuai `.gitattributes`.

#### Infrastruktur
- **Firmware dipisah per profil** (Phase 2). Pindah profil berarti membuka sketsh yang
  lain, bukan mengubah `#define HW_PROFILE`.
  - `firmware/common/limits.h` — konstanta bersama, enum `ChargeState`/`RgbState`.
  - `firmware/common/macropad_core.h` — logika bersama kedua board.
  - `firmware/HID_Keypad_Prototype/HID_Keypad_Prototype.ino` — 1 knob, LED status GPIO12.
  - `firmware/HID_Keypad_Final/HID_Keypad_Final.ino` — 2 knob, RGB SK6812, divider baterai
    100k/100k, divider VBUS 68k/100k, charger MCP73831.
- `.gitattributes` untuk normalisasi line ending.
- `parseIntRange()` di firmware: parser integer ketat yang menolak teks non-angka,
  overflow, dan nilai di luar rentang.
- Sinyal hardware firmware FINAL: deteksi **VBUS via divider 68k/100k di GPIO21** dan
  **status charger MCP73831 via pin STAT di GPIO18**, digabung agar tiga kondisi terbedakan
  (tidak mengecas / sedang mengecas / cas selesai) — STAT saja tidak bisa membedakan
  "cas selesai" dari "charger tidak terpasang". `usbHostConnected()` jadi sumber kebenaran
  "USB tersambung" untuk kebijakan hemat baterai BLE.
- **Simulasi di firmware PROTOTYPE** untuk `readBatteryMv()` dan `readChargeState()`
  dengan format pesan identik FINAL, sehingga saat board FINAL siap dipakai **app tidak
  perlu diubah sama sekali**.

### Fixed

#### Fase 7
- **Notifikasi overlay menerima teks lewat `Window::eval()`** — Rust menyusun statement
  JavaScript dengan `format!` lalu menyuntikkannya, padahal teksnya berasal dari nilai
  macro di flash device. Sekarang lewat channel event resmi `overlay-notify` + `listen`,
  dengan antrean di Rust (dibatasi 16 entri) untuk notifikasi yang datang sebelum halaman
  siap.
- **`launch_app` terdaftar dua kali** di `generate_handler!` — arm duplikat yang tidak pernah
  ditinjau sejak pertama.
- **`load_data`/`save_data` tanpa lock**: dua command bisa menulis `apps.json` bersamaan
  dan satu menimpa yang lain. Sekarang memakai mutex.
- **Penulisan file tidak atomik**: power loss di tengah `std::fs::write` meninggalkan
  `presets.json` terpotong yang berikutnya dibaca sebagai default — seluruh preset hilang.
  Sekarang tulis ke `.tmp` lalu `rename` (atomik di NTFS). `apps.json` yang sudah rusak
  dicadangkan sebagai `apps.json.corrupt`.
- Error `save_data` yang dibuang dengan `let _ =` — dicatat di 7 titik pemanggilan.
- **`find_app()` menebak aplikasi dari prefix tanpa batas**: `EVT:APP:sl` cocok dengan
  Slack sekaligus Spotify sekaligus Slackmate, dan apa pun yang bisa menulis baris ke port
  COM membuat PC menjalankan program yang tidak pernah dipilih user. Sekarang prefix
  minimal 4 karakter **dan** harus unik; kalau ambigu, gagal dengan pesan yang menyebut
  kandidatnya. Cocokkan persis tetap menang, dan workaround nama terpotong (batas 47
  karakter) tetap berfungsi untuk prefix panjang yang unik.

#### Fase 6 dan sebelumnya
- **Firmware FINAL gagal compile**: `RGB_DEFAULT_BRIGHTNESS` hilang setelah pemisahan
  firmware karena ikut terpotong dari blok profil RGB.
- **Notifikasi overlay mati total di rilis**: `src/overlay.html` tidak pernah ikut ter-build
  karena `vite.config.js` hanya mendeklarasikan `index.html` sebagai entry Rollup, padahal
  `lib.rs` membukanya lewat `WebviewUrl::App("overlay.html")`.
- **Parsing indeks firmware bisa menulis ke target yang keliru**: `String::toInt()`
  mengembalikan `0` untuk teks non-numerik dan nilai besar terpotong diam-diam saat di-cast
  ke `uint8_t` (`SETENC:256:` menjadi `0`), sehingga lolos validasi batas dan menimpa knob
  yang salah. Delapan titik parsing kini memakai `parseIntRange()`.
- **Desync protokol setelah reconnect**: `disconnect()` manual tidak pernah me-reset parser
  state, sehingga byte pertama device berikutnya menempel pada baris parsial.
- **Listener serial bocor**: handle unlisten dari `port.listen()` dibuang, sehingga setiap
  reconnect/probe menambah listener dan satu chunk device diproses N kali.
- **`TypeError` di dalam callback serial mematikan parser**: indeks di luar jangkauan dari
  device membuat assignment melempar di dalam callback yang ditelan plugin, sehingga semua
  baris berikutnya dimakan sebagai payload DUMP — desync permanen sampai reconnect. Semua
  indeks kini divalidasi, dan kunci encoder memakai allowlist (`CW`/`CCW`/`BTN`) sehingga
  `__proto__` tidak lagi menjadi prototype assignment.
- **Nilai macro ber-spasi terpotong**: `cmd.trim()` dihapus (wajib setelah `const String&`).
- `serialLine[512]` menggantikan `String serialBuffer` yang tumbuh tanpa batas dan O(n²).
- `saveConfigToFlash()`/`rgbPersist()` mengembalikan `bool` dan mengecek `putBytes()`.
- **Preset setengah jadi tersimpan**: waiter `DUMP` satu slot global dipakai bersama, dan
  dump latar belakang yang selesai lebih dulu me-resolve waiter packer.
- **Waiter DUMP tergantikan menggantung selamanya** — ditemukan oleh pengujian; tiap layer
  kini memakai `Set` waiter.
- Key bertipe `APP` tidak punya styling sehingga tampak sama dengan key kosong.
- `escapeHtml()` sekarang juga meng-escape tanda kutip tunggal.
- Preview animasi RGB sebelumnya tidak terlihat karena ikut dilumpuhkan
  `animation: none !important`.
- **Notifikasi per key ikut hilang** setelah Phase 6 karena app menjadikannya andal pada
  baris `[KEY]` dari firmware. Baris itu kini selalu dikirim dalam format ringkas
  `layer,row,col,type,value` (62 byte terburuk, masih di bawah buffer stack 64 byte
  `vprintf` sehingga tidak kena `malloc`), dan regex app disesuaikan.

### Removed
- `firmware/HID_Keypad/HID_Keypad.ino` (monolit 1056 baris). Digantikan berkas-berkas di
  atas; salinan utuh tersimpan di git pada commit `3c020d2` dan dapat dipulihkan dengan
  `git show 3c020d2:firmware/HID_Keypad/HID_Keypad.ino`.
- Logika dari `src/overlay.html` dipindah ke `src/overlay.js` sebagai module terpisah —
  dynamic import di dalam `<script>` biasa dianggap path relatif oleh plugin HTML Vite.

## Belum dikerjakan

### Firmware FINAL
- **Mesin efek RGB** (breathing/rainbow/wave/snake/random/react). `rgbApplyState()` baru
  menerjemahkan mode ke warna per LED, belum menganimasikannya. Preview di app sudah
  jalan, tapi device FINAL belum. Item ini besar dan tidak bisa diuji tanpa hardware.
- **Kebijakan BLE** — `usbHostConnected()` sudah tersedia sebagai sumber kebenaran, tinggal
  dipakai untuk menyalakan/mematikan BLE (menunggu Phase 10).

### Phase 6 — ditunda dengan sengaja
- **Memindahkan scan matrix + serial ke task FreeRTOS terpisah.** Setelah 6.2–6.4,
  satu-satunya blocking tersisa hanya `Keyboard.print()` di library HID (~1ms/karakter).
  Pindah ke task terpisah menuntut `Keyboard`, `strip` (Adafruit_NeoPixel), `prefs`, dan
  `cfg` jadi thread-safe — tidak satu pun dari library itu thread-safe. Melakukan refactor
  itu tanpa bisa compile dan tanpa hardware berisiko menghasilkan korupsi data sesekali,
  yang jauh lebih buruk daripada masalah aslinya.

## Planned work

- **Filter waktu untuk rotary encoder.** State machine quadrature sudah menangani
  bounce pada detent (sumber gejala arah terbalik), tetapi noise acak yang mengubah A/B
  secara acak tetap terlihat identik dengan putaran nyata — state machine bekerja tanpa
  informasi waktu. Menolaknya butuh filter berbasis waktu (abaikan transisi yang terjadi
  < 2 ms setelah transisi sebelumnya, memakai penghitung siklus IRAM-safe). Belum
  ditambahkan karena tidak bisa diuji tanpa hardware. Gejalanya: langkah acak saat knob
  diam.

## Catatan verifikasi

Tidak ada toolchain Arduino di lingkungan pengembangan ini, jadi firmware diverifikasi secara
statis: kurung kurawal seimbang, simbol domain terdefinisi, region verbatim utuh, dan kontrak
offset protokol firmware↔app. **Compile Arduino dan uji di device tetap wajib dilakukan** —
static check tidak menangkap everything.

Sisi Rust dan JavaScript bisa diverifikasi penuh: `cargo test` (6 test) dan 5 skrip uji
Node yang menguji kode app yang benar-benar berjalan (parser, waiter DUMP, kontrak protokol,
format event key, simbol firmware).
