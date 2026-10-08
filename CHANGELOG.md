# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Rencana lengkap ada di `C:\Users\Raihan\.opencode\plan\macropad-roadmap.md`.

### Added
- **Pemeriksaan di `startup-smoke-test.mjs` bahwa setiap fungsi `init*` benar-benar
  dipanggil.** Dua kali dalam Phase 8 ada fungsi yang diekstrak ke modul tapi tidak
  pernah dipanggil - `initAdaptivePage()` (polling auto-switch mati) dan
  `initSidebar()` (toggle sidebar mati). Keduanya lolos build dan lolos 13 suite test,
  karena tidak ada yang memanggil app-nya. Sekarang setiap `init*` yang dipisah ke
  modul harus muncul sebagai pemanggilan di `main.js`, dan test gagal kalau tidak.
- **Test `protocol-parser.js` yang mengurai baris device sungguhan** (15 seksi, format
  baris disalin persis dari `firmware/common/macropad_core.h`). Sekarang yang bisa
  diuji: `INFO:` dengan nilai di luar rentang ditolak tanpa jadi `NaN`, isi `DUMP:`
  masuk ke layer yang disebut dan bukan `currentLayer`, nilai ber-koma tetap utuh,
  target layer di-reset di `DUMP_END` sehingga blok berikutnya tidak menulis ke layer
  yang salah, indeks korup dari device dilewati tanpa melempar, kunci encoder di luar
  allowlist ditolak (anti prototype pollution), `NAMES_BEGIN/END` dengan nama ber-koma
  dan ber-spasi, `HWINFO:` termasuk flag `simulated`, serta notifikasi event hardware.
- **`handleLine-diff.js`**: membuktikan pemindahan `handleLine` bersifat verbatim dengan
  membandingkannya langsung terhadap versi di HEAD, lalu membandingkannya lagi setelah
  normalisasi whitespace dan komentar. Hasilnya identik kecuali prefiks `hooks.`. Ini
  menutup celah paling berbahaya - refactor yang diam-diam mengubah satu baris kondisi
  tidak bisa lagi lolos tanpa terlihat.
- **Test kontrak Adaptive** (`adaptive-contract-test.js`) yang membandingkan perintah serial
  dan perintah bertemplate yang dikirim blok Adaptive versi lama (diambil dari `git show`)
  dengan `src/adaptive.js` sekarang. Tujuannya menangkap `await sendLine(...)` yang hilang
  diam-diam saat pemindahan kode — tidak ada error build yang akan memberi tahu.
  Test ini juga memverifikasi tidak ada fungsi global `main.js` yang bocor ke `adaptive.js`.
- **Test `battery-ui.js`** (63 pemeriksaan) yang mengimpor modul sungguhan dengan stub DOM.
  Fokusnya logika ambang: `EVT:BATT` datang tiap 5 detik, jadi notifikasi hanya boleh
  berbunyi saat ambang **baru** dil-crossing. Diuji juga batas 20%/10%, reset ambang saat
  baterai naik atau mulai mengecas, pemisahan `EVT:CHG` (charging) dari `EVT:BATT`,
  badge SIMULASI prototipe, dan penolakan nilai tidak valid dari device.
- **Test modul `serial-transport.js` yang mengimpor modul sungguhan** dengan stub plugin
  serial (dipasang lewat `node:module` `registerHooks`, tanpa mengubah berkas sumber).
  Sekarang alur yang tadinya mustahil diuji bisa diperiksa: urutan handshake saat connect,
  pemotongan baris di tengah potongan, pelepasan listener saat disconnect, `clearDirty`
  hanya pada jalur device hilang, dan connect gagal tidak meninggalkan state setengah jadi.
- **Test modul `device-state.js` yang meng-import-nya secara langsung** (sebelumnya test
  harus menyalin potongan kode keluar dari `main.js` sebagai teks). Karena itu validasi
  indeks device akhirnya bisa diuji menyeluruh, termasuk kasus yang belum pernah diuji:
  indeks negatif, `Infinity`, `1.5`, nilai non-numerik, dan percobaan prototype pollution
  lewat `__proto__` dan `constructor`.
- Test wiring parser: memastikan `main.js` meneruskan semua baris device ke mutator dan
  **tidak** menulis langsung ke `mapping`/`encConfig` dari output serial.
- Unit test Rust untuk `find_app()` (6 test). Ini test pertama di repo ini; sebelumnya
  tidak punya test sama sekali.
- Capability terpisah `capabilities/overlay.json` untuk jendela notifikasi, dengan izin
  seminimal mungkin (`core:event:allow-listen`). Sebelumnya jendela overlay tidak punya
  capability apa pun — aman hanya secara kebetulan.

### Changed
- **Refactor Tahap 7: halaman Home dan daftar aplikasi dipisah** - `src/home-page.js`
  (340 baris) dan `src/app-picker.js` (113 baris). `main.js` turun dari 727 ke 347 baris.
  - `home-page.js` memegang tab layer (dengan drag-reorder), grid tombol, daftar binding
    knob, panel editor, dan perekaman keyboard. Ketiganya **sengaja satu modul**:
    klik sel -> `openEditor()` -> mulai rekam -> `recordTokens` -> apply, dan tab ->
    `switchLayer()` -> `loadLayer()` -> `renderGrid()`. Dipisah tiga modul akan muncul
    siklus import. Test memverifikasi graf import `src/` bebas siklus.
  - `app-picker.js` tidak butuh dependency injection sama sekali - semua yang
    dibutuhkannya (Rust invoke, modal, DOM) bisa diimpor langsung.
  - `selected` diekspor sebagai live binding; `main.js` tidak boleh menulisnya langsung
    karena `import` tidak bisa di-assign, jadi ada `clearSelection()`.
  - Konstanta `ENC_LABELS`, `MEDIA_MAP`, `MODIFIER_KEYS`, `MODIFIER_NAMES` ikut pindah
    ke `home-page.js`; `MARK_DIRTY` disuntikkan lewat `initHomePage({ markDirty })`
    supaya flag "belum tersimpan" tetap milik app.
- **`home-page-diff.js`**: 17 fungsi di blok Home dan daftar aplikasi dibandingkan satu per
  satu dengan versi `c46f5cb` dan hasilnya identik semua. Test juga mencetak graf import
  `src/` supaya mudah diperiksa manual.
- **Refactor Tahap 6: shell UI dipisah jadi tiga modul** - `src/ui-notify.js` (61 baris,
  notifikasi overlay + setting), `src/ui-modal.js` (74 baris, `showModalBase` /
  `showPromptModal` / `showConfirmModal` + `clipUtf8`), dan `src/ui-router.js` (50 baris,
  `switchPage` + sidebar). `main.js` turun dari 833 ke 727 baris.
  - `settings` dan `saveSettings()` pindah ke `ui-notify.js`; halaman Setting dan parser
    protokol membacanya dari sana.
  - Pen-klik sidebar **sengaja diubah**: di `main.js` lama nav-item memanggil
    `editingPresetId` dan `confirmLeavePresetEditor()` secara langsung, yang membuat
    router bergantung pada adaptive. Sekarang keduanya jadi hook lewat `initRouter()`.
    Ini satu-satunya bagian yang bukan perpindahan verbatim, dan test membuktikannya
    secara semantik.
- **`shell-ui-diff.js`**: membuktikan blok shell UI di `main.js` versi `885aac7` identik
  dengan isi modul baru - `switchPage`, toggle sidebar, `showModalBase`,
  `showPromptModal`, `showConfirmModal`, `clipUtf8`, `describeAction`, dan
  `notifyBoundAction` semuanya identik setelah normalisasi; `notify()` identik setelah
  spasi diratakan (penulisan ulang indentasi saja). Test juga memverifikasi kunci
  `localStorage`, daftar kind yang difilter, dan default hold tidak berubah.
- **`handleLine-diff.js` dan `shell-ui-diff.js` kini memakai commit eksplisit**, bukan
  `HEAD`. Kalau pakai `HEAD`, begitu ekstraksi di-commit blok lama sudah tidak ada di
  sana dan test akan salah melaporkan "blok tidak ditemukan" pada commit berikutnya.
- **Refactor Tahap 5: parser protokol (handleLine) dipindah ke src/protocol-parser.js**
  (246 baris). Kontrak app<->firmware sekarang ada di satu modul yang bisa diuji tanpa
  browser. main.js turun dari 988 ke 833 baris.
  - Parser hanya menyentuh layar lewat initProtocolParser({ notify, notifyBoundAction,
    renderDeviceProfileBadge, renderTabs, renderGrid, renderEncoderList, loadLayer }).
    device-state, transport, adaptive, rgb, dan battery ia impor langsung.
  - deviceProfile (isi HWINFO:) pindah ke parser sebagai live binding; badge di
    main.js membacanya, dan 
esetDeviceProfile()dipakai hook onDisconnected.
  - dumpParseLayer (layer target untuk DUMP_BEGIN:<n>) pindah ke parser - hanya
    dia yang memakainya.
  - handleLine **dibuktikan verbatim**: handleLine-diff.js membandingkan body fungsi
    di HEAD dengan yang di modul baru dan membandingkan lagi setelah normalisasi
    whitespace serta komentar. Hasilnya identik, kecuali prefiks hooks.. Jadi
    ekstraksi ini tidak mengubah satu baris pun perilaku parser.
- lastDeviceLayerEventAt ditandai jelas sebagai **tulis-tanpa-baca**: di seluruh riwayat
  repo nilainya pernah diisi tapi tidak pernah dibaca. Ini sisa rencana *pause
  auto-switch* yang belum jadi. Sengaja tidak dihapus supaya niatnya tidak hilang, tapi
  sekarang deklarasinya jujur soal itu (lihat Planned work).
- Lima test lama diperbarui karena handleLine pindah: key-event-test,
  parser-wiring-test, protocol-contract-test, 
gb-page-test, dan
  daptive-contract-test. parser-wiring-test sekarang memeriksa main.js **dan**
  protocol-parser.js untuk penulisan state langsung, karena output serial bisa masuk
  dari dua berkas dan salah satunya bisa membuka jalur tulis-langsung yang lolos.
- **Refactor Tahap 4: Adaptive Key Bind dipindah ke `src/adaptive.js`** (554 baris) dan
  indikator baterai ke `src/battery-ui.js` (99 baris). `main.js` turun dari 1465 ke 988 baris.
  - `adaptive.js` memegang seluruh fitur App Preset: manajemen (buat, ubah nama, hapus,
    aktif/nonaktif, editor) plus runtime auto-switch (polling window foreground, cache slot
    firmware, gestur escape) dan waiter `DUMP` per-layer.
  - `battery-ui.js` sebelumnya terselip di tengah blok runtime Adaptive padahal tidak ada
    hubungan sama sekali dengan preset. Sekarang terpisah, dan angka dari device divalidasi.
  - `TYPE_NAMES` pindah ke `device-state.js` karena dipakai editor di `main.js` maupun
    uploader preset di `adaptive.js`; dua salinan berisiko berbeda diam-diam.
- Modul baru tidak memanggil fungsi `main.js` secara langsung. Semuanya lewat
  `initAdaptive({ switchPage, showConfirmModal, showPromptModal, showModalBase, notify,
  resetEditorState, isDirty, setDirty })`. Test kontrak memverifikasi tidak ada satu pun
  fungsi global `main.js` yang bocor ke `adaptive.js`.
- `initBatteryUi(notify)` menyuntikkan fungsi notifikasi ke `battery-ui.js` supaya ambang
  `batt-low`/`batt-crit` tetap berbunyi tanpa `main.js` yang harus mengimbal modul.
- **Refactor Tahap 3: seluruh urusan port serial dipindah ke `src/serial-transport.js`**
  (364 baris). Isinya: buka/tutup port, enumerasi & dropdown COM, probe `WHOAMI`,
  auto-connect/reconnect beserta retry terbatas, polling daftar port, ping, framing baris
  (pisah newline + batas 64 KB), serta pengiriman `sendLine`/`sendBatch`.
  `main.js` turun dari 1733 ke 1465 baris.
- Transport **tidak tahu apa pun soal isi config, layer, atau preset** dan tidak memanggil
  fungsi `main.js` secara langsung. Semua sisi aplikasi disuntikkan lewat satu titik,
  `initTransport({ onLine, onConnected, onDisconnected, onDeviceLost, clearDirty, notify })`,
  sehingga tidak ada siklus import dan ketergantungan dua arah terlihat jelas di satu tempat.
- Flag framing (`dumpInProgress`, `dumpEncInProgress`, `namesInProgress`) pindah ke transport
  sebagai live binding, ditulis lewat setter karena `import` tidak bisa di-assign dari luar modul.
- `connect()` kini menerima path opsional (`connect('COM7')`) alih-alih selalu membaca
  dropdown. `tryAutoConnect` sudah mengisi dropdown sebelum memanggilnya, jadi hasilnya sama,
  tapi sekarang tidak bergantung pada urutan penulisan elemen DOM.
- Objek `port` tidak lagi terekspos ke `main.js`; pemeriksaan koneksi memakai `isConnected()`.
  Tombol Connect memakai `isAutoBusy()` dan `enableAutoReconnect()`.
- **Refactor Tahap 2: halaman RGB dipindah ke `src/rgb-page.js`** dan helper DOM ke
  `src/dom.js` (`el`, `log`, `escapeHtml`) supaya tidak diduplikasi di setiap modul.
  Transport serial disuntikkan lewat `setRgbTransport()` untuk menghindari siklus import
  antara `main.js` dan `rgb-page.js`. Parser `RGB_DUMP`/`RGB_KEY` pindah ke `handleRgbLine()`.
  `main.js` turun dari 1841 ke 1733 baris.
- `dom.js`: `logBox` kini dicari saat dipakai, bukan di level modul, sehingga modul bisa
  diimpor di luar browser (test Node) tanpa perlu stub DOM saat import.
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
- **Default semua aktif**: Adaptive Key Bind (`presetsData.masterEnabled`), notifikasi per
  key, dan notifikasi baterai. Ketiganya sudah punya persistensi — notifikasi lewat
  `localStorage` (`macropad.settings`), Adaptive lewat `presets.json` — jadi pilihan user
  bertahan setelah app ditutup.

### Fixed
- **App tidak bisa start sama sekali: tidak ada port COM yang terlihat.** Fungsi
  `resetEditorState()` ikut terhapus saat ekstraksi transport (Phase 8 tahap 3, commit
  `ad8ae07`). Fungsi itu berdiri di **tengah** region yang dihapus - di antara
  `autoDetect()` dan `handleDeviceLost()` - jadi ia ikut terbawa tanpa disadari.
  Karena `resetEditorState` dirujuk di `initAdaptive({...})` yang dievaluasi saat
  modul dimuat, hasilnya `ReferenceError: resetEditorState is not defined` - seluruh
  `main.js` gagal dimuat, jadi tidak ada `autoDetect()`, tidak ada polling, dan
  dropdown COM kosong. `vite build` tetap hijau karena ini error runtime, bukan error
  build. Fungsi dikembalikan ke seksi rekam keyboard, tempat ia sebenarnya milik.
- **Dua test baru yang menutup kelas bug 'fungsi hilang diam-diam':**
  - `startup-smoke-test.mjs` benar-benar **memuat `src/main.js`** di Node dengan stub
    `@tauri-apps/*` dan plugin serial, lalu memastikan `available_ports()` dipanggil
    dan dropdown COM terisi. Inilah test yang langsung menemukan `resetEditorState`.
  - `no-lost-functions-test.js` membandingkan seluruh daftar fungsi dan konstanta
    top-level di `main.js` sebelum Phase 8 dengan yang ada di `src/*.js` sekarang,
    memeriksa 102 nama import benar-benar di-export berkasnya, lalu menjalankan smoke
    test. Nama yang hilang harus punya penjelasan tertulis di dalam test - kalau tidak,
    test gagal. Ini yang akan menangkap bystander berikutnya.
- **Angka baterai dari device bisa membuat UI menampilkan "NaN%".** `parseInt("abc")`
  menghasilkan `NaN`, dan `NaN !== null` sehingga lolos pemeriksaan "belum ada data".
  Akibatnya indikator menulis `NaN%` dan — lebih buruk — `NaN <= 20` selalu `false`,
  jadi peringatan baterai lemah **tidak akan pernah berbunyi** selama device mengirim
  satu nilai rusak saja. Sekarang ditolak di gerbang masuk (`setBatteryFromKv`), dengan
  batas 0..100 untuk persentase; nilai buruk diabaikan dan nilai valid terakhir
  dipertahankan.
- **Render pertama indikator baterai hilang** setelah ekstraksi ke `battery-ui.js`
  (`setTimeout(updateBatteryUI, 0)` berada di baris paling akhir blok lama).
  Indikator akan kosong sampai `EVT:BATT` pertama arrive.
- **Meter baterai dan badge profil tidak lagi kosong saat device terputus.** Semula
  `setConnected(false)` di `main.js` ikut membersihkan `battUI`; saat ekstraksi itu hilang
  dari hook `onDisconnected`, sehingga tegangan dan persen baterai terakhir tetap terpakai
  di UI seolah device masih hidup.
- **Perubahan "belum disimpan" tidak lagi hilang saat Disconnect ditekan manual.** Flag
  `dirty` sempat ikut dibersihkan di jalur manual, padahal pada disconnect manual device
  tidak dicabut dan RAM device masih memegang perubahan yang belum disimpan ke flash.
  Menyambung ulang ke device yang sama akan membuat app mengira tidak ada yang perlu
  disimpan. `clearDirty` kini hanya dipanggil di `handleDeviceLost()`, di sana device
  benar-benar hilang sehingga isinya ikut hilang.
- **Warna RGB dari device tidak pernah ter-parse dengan benar.** Kode memakai
  `.split(':').map(parseInt)`, dan `map` meneruskan **index sebagai argumen kedua** — yang
  oleh `parseInt(value, radix)` dibaca sebagai basis. Jadi `"20:30"` diparse dengan radix 1
  dan 2 (tidak valid) dan menghasilkan `NaN`, sehingga `RGB_DUMP:...color=...` dan
  `RGB_KEY:...` mengisi warna dengan `[10, NaN, NaN]`. Gejalanya diam-diam: warna yang dibaca
  dari device tidak pernah terpakai. Diganti `parseRgbTriple()` yang memakai radix 10 dan
  menolak nilai di luar 0..255.
- **Arah rotary encoder kadang terbalik satu langkah** ("diputar ke kiri kadang terbaca
  kanan"). Penyebabnya ISR lama hanya bereaksi saat pin A LOW lalu membaca B pada saat itu
  juga. Saat pantulan (bounce) pada detent, B sudah berubah ketika A LOW untuk kedua
  kalinya, sehingga satu putaran terbaca sebagai arah yang terbalik. Diganti **state machine
  quadrature penuh**: setiap perubahan A/B disimpan sebagai state 2-bit, arah diambil dari
  tabel transisi, transisi tidak valid (A dan B berubah bersamaan) diabaikan, dan langkah
  baru baru diumumkan setelah 4 transisi searah (= 1 detent). ISR sekarang dipasang pada
  **kedua pin** A dan B; sebelumnya hanya pin A sehingga separuh transisi quadrature tidak
  pernah terlihat. Arah CW sengaja dibuat sama dengan cara lama (A LOW + B HIGH = CW)
  supaya tidak perlu membalik kiri/kanan pada knob mana pun.
- `applyName()` sempat diekspor tetapi belum dipasang di `main.js` — ditemukan oleh test
  wiring sebelum commit.
- **Notifikasi baterai lemah** (`batt-low`, ≤20%) dan **baterai kritis** (`batt-crit`, ≤10%)
  ditambahkan. Sebelumnya tidak ada sama sekali padahal toggle "Notifikasi baterai" sudah
  menjanjikan "Battery Low". Notifikasi hanya dibunyikan saat ambang baru dilewati, bukan
  tiap `EVT:BATT` yang datang setiap 5 detik; ambang direset saat baterai naik atau mulai
  mengecas supaya bisa berbunyi lagi di siklus berikutnya.
- Warna khusus untuk notifikasi baterai di overlay (`charge`, `charge-done`, `batt-low`,
  `batt-crit`) supaya tidak tertukar dengan notifikasi dasar.
- **Notifikasi baterai sebenarnya tidak dikendalikan toggle "Notifikasi baterai".** Handler
  `EVT:CHG` mengirim dengan kind `'batt'`, yang tidak ada di daftar filter `notify()` —
  sehingga jatuh ke cabang "dasar" dan ikut mati saat toggle Notifikasi dasar dimatikan.
  Sekarang memakai kind `charge` / `charge-done` yang memang dibaca filter.
- Teks petunjuk toggle "Notifikasi baterai" menyebut "CHARGE NOW" yang tidak pernah ada;
  diganti sesuai perilaku sebenarnya.
- `presets_save` dari toggle Adaptive di halaman Home memakai `.catch(()=>{})` sehingga
  kegagalan penyimpanan tidak kelihatan — user mengira toggle tersimpan padahal akan kembali
  ke nilai lama setelah app ditutup. Sekarang errornya dicatat.

### Added
#### Fase sebelumnya
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
- **Pause auto-switch sesaat setelah user pindah layer.** `lastDeviceLayerEventAt` sudah
  diisi setiap ada `EVT:LAYER:` sejak lama, tapi belum pernah dibaca siapa pun - sudah
  diverifikasi di seluruh riwayat repo. Rencana aslinya: begitu user pindah layer lewat
  knob, auto-switch otomatis harus berhenti sesaat, supaya perubahan layer manual tidak
  langsung ditimpa preset karena polling melihat window yang sama. Tanpa ini, hal yang
  bisa terjadi: user memutar knob ke layer 3, 120 ms kemudian preset aktif memaksa
  balik ke layer 1. Perlu diputuskan juga apa yang terjadi saat `fetchAllLayersForPacking()`
  sedang berjalan - memindahkan layer di tengah dump akan menyisipkan `DUMP:<n>` baru
  ke tengah stream dump yang sedang berjalan.

## Catatan verifikasi

Tidak ada toolchain Arduino di lingkungan pengembangan ini, jadi firmware diverifikasi secara
statis: kurung kurawal seimbang, simbol domain terdefinisi, region verbatim utuh, dan kontrak
offset protokol firmware↔app. **Compile Arduino dan uji di device tetap wajib dilakukan** —
static check tidak menangkap everything.

Sisi Rust dan JavaScript bisa diverifikasi penuh: `cargo test` (6 test) dan 5 skrip uji
Node yang menguji kode app yang benar-benar berjalan (parser, waiter DUMP, kontrak protokol,
format event key, simbol firmware).