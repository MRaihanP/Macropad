# Changelog

Semua perubahan penting pada proyek ini dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/),
dan proyek ini memakai [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Rencana lengkap ada di `C:\Users\Raihan\.opencode\plan\macropad-roadmap.md`.

### Added
- **Phase 10 (BLE) - fondasi transport.** Abstraksi transport di firmware supaya
  ganti USB ke BLE cukup mengubah satu `#define`, bukan menyentuh seluruh core:
  - `firmware/common/transport.h` - interface `Transport` (metode yang dibutuhkan
    core: `print`, `println`, `printf`, `available`, `read`, `write`, `flush`).
  - `firmware/common/transport_usb.h` - `UsbTransport`, pembungkus `Serial`.
  - `firmware/common/limits.h` - `TRANSPORT_USB` (0) / `TRANSPORT_BLE` (1) dan
    `TRANSPORT_TYPE` yang default ke `TRANSPORT_USB` demi kompatibilitas mundur.
  - `macropad_core.h` memakainya lewat `extern Transport* g_transport` + macro
    `SERIAL->`, jadi semua `Serial.` berubah jadi `SERIAL->`. Kedua sketsh
    mendefinisikan `g_usbTransport` dan `g_transport`.
- **`src-tauri/src/ble.rs` - modul BLE sisi Rust (317 baris).** Pembungkus WinRT
  GATT: `DeviceWatcher` untuk scan, `BluetoothLEDevice` + `GattSession` untuk
  connect, pencarian characteristic di service NUS
  (`6e400001-b5a3-f393-e0a9-e50e24dcca9e`), write-with-response ke TX
  (`...0002`), dan subscribe notify ke RX (`...0003`). Data notify masuk ke
  `VecDeque<u8>` dan dibaca lewat `ble_read`. Dijalankan pada thread terpisah
  (channel `std::sync::mpsc`) karena WinRT tidak boleh dipanggil dari thread
  Tauri's async runtime.
- **Enam perintah Tauri baru**: `ble_scan`, `ble_connect`, `ble_disconnect`,
  `ble_write`, `ble_read`, `ble_is_connected`, beserta `BleDeviceInfo`.
  **Status: belum dipakai frontend** - masih command berdiri sendiri, sengaja
  supaya bisa diuji terpisah dari UI.
- **Window paint watchdog (`src/paint-watch.js`).** Gejala yang dilaporkan user:
  app ditutup/dibunuh lalu langsung dijalankan lagi, jendela utama muncul PUTIH
  padahal JavaScript di dalamnya berjalan normal (serial connect, log, preset
  switching semua hidup) - renderer WebView2 tidak pernah menghasilkan satu frame.
  Sinyal "apakah JS hidup" tidak bisa dipakai karena JS-nya memang hidup; yang
  bisa dipakai `requestAnimationFrame`, yang callback-nya hanya jalan kalau
  browser benar-benar menghasilkan frame. Menunda 2 detik sebelum melapor
  ke Rust, lalu Rust melakukan reload sendiri. Diimpor paling akhir di
  `main.js` supaya side effect-nya secepat mungkin terjadi.
- **`docs/STATUS-AND-TESTING.md`** - ringkasan posisi pengembangan (sudah /
  belum) plus prosedur pengujian 6 tingkat, dari yang otomatis sampai yang
  butuh hardware.

### Changed
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

### Added
- **Test `a11y-test.js` (40 pemeriksaan, seksi 1-8).** Memverifikasi hal-hal a11y
  yang bisa diperiksa statis dan yang kalau hilang langsung memblokir pengguna
  keyboard/screen reader: elemen interaktif benar-benar bisa difokus, role/label
  masuk akal untuk yang tidak terbaca sebagai teks, perubahan status diumumkan,
  dan focus ring terlihat. Bukan audit WCAG penuh — tidak ada browser headless
  di lingkungan ini, jadi yang diuji adalah syarat-syarat yang bisa dibuktikan.
- **Navigasi sidebar bisa dioperasikan penuh dari keyboard.** `.nav-item` diubah dari
  `<div onclick>` menjadi `<button type="button">`, plus `ArrowLeft/Right/Up/Down`
  untuk memindah fokus antar item. Alasannya teknis: hanya elemen native
  (`<button>`, `<a>`, `<input>`) yang masuk ke tab order dan otomatis bisa
  ditekan Enter/Space — `tabindex` pada `<div>` tetap memerlukan `role` dan
  penangan key sendiri.
- **Focus ring.** Sebelumnya **tidak ada satu pun** aturan `:focus-visible` di
  seluruh aplikasi (`styles.css`), jadi pengguna keyboard tidak punya petunjuk
  sedang berada di kontrol mana. Sekarang ada aturan global untuk `button`,
  `[role="button"]`, `[role="tab"]`, `input`, `select`, `textarea`.
- **Sel grid, baris binding knob, dan tab layer bisa difokus dan diaktifkan
  keyboard.** Helper `makeInteractive()` di `home-page.js` memasang
  `tabindex="0"` + `role="button"` + penangan Enter/Space, dan memasang
  `aria-label` berisi koordinat serta isi binding yang sebenarnya.
  Tab layer mendapat `role="tab"`, `aria-selected`, dan navigasi panah kiri/kanan
  — jalur keyboard untuk mengganti layer, yang sebelumnya hanya bisa lewat mouse
  atau drag.
- **Modal adalah dialog yang sungguhan.** Ditambah `role="dialog"`,
  `aria-modal="true"`, `aria-labelledby="modalTitle"`, plus focus trap
  (Tab/Shift+Tab memutar di dalam dialog) dan **pengembalian fokus ke elemen
  pemicu** saat ditutup. Tanpa itu, fokus jatuh ke `<body>` dan pengguna keyboard
  harus Tab dari awal lagi setiap kali dialog ditutup.
- **Live region untuk perubahan status.** `#statusText` mendapat `role="status"`
  dan `#log` mendapat `role="log" aria-live="polite" aria-relevant="additions"`,
  sehingga perubahan koneksi dan baris log baru diumumkan tanpa memutus apa
  yang sedang dibacakan.

### Changed
- **Phase 10.4 (sebagian) - kontrol koneksi manual disembunyikan, bukan dihapus.**
  Auto-connect USB sudah bekerja sendiri (`tryAutoConnect()` / `pollPorts()` /
  `autoDetect()` di `serial-transport.js`), jadi dropdown COM dan tombol
  Sambung/Putuskan tidak lagi perlu terlihat di header. Header sekarang hanya
  memuat status: titik indikator + teks status + badge profil + baterai.
  - Panel baru **Koneksi manual (advanced)** memakai `<details>`/`<summary>`
    bawaan HTML, bukan tombol + `display:none` buatan sendiri - sudah punya
    semantik disclosure dan bisa dioperasikan keyboard. Tertutup secara
    default.
  - Kontrol **dipindahkan**, bukan dihapus. Satu-satunya cara pulih dari
    auto-connect yang gagal (device boot lambat, port COM berubah, enumerasi
    Windows salah) harus tetap ada.
  - **Panelnya sengaja diletakkan DI LUAR `<div id="app">`.** Ini bukan
    detail penempatan: `setConnected()` menyembunyikan `#app` saat koneksi
    putus, dan semua halaman aplikasi ada di dalam `#app`. Kalau panel manual
    diletakkan di halaman Setting, begitu device tercabut panelnya ikut
    hilang - user kehilangan satu-satunya cara memaksa menyambungkan device
    tepat di saat dia paling membutuhkannya. `manual-connect-test.js` betrayal
    memverifikasi posisi ini secara eksplisit.
  - Tombol `#btnConnect` **tidak memakai `data-i18n`**. Labelnya diubah JS
    antara "Sambung" dan "Putuskan" mengikuti status koneksi; kalau diberi
    `data-i18n`, `applyI18n()` akan menimpanya dengan teks statis setiap ganti
    bahasa dan tombol akan selalu membaca "Sambung" padahal device sedang
    tersambung. Label sekarang punya satu sumber: `updateConnectButton()` di
    `serial-transport.js`, didaftarkan lewat `registerRerender()` supaya ikut
    diterjemahkan tanpa kehilangan status. (`registerRerender` sendiri
    sebelumnya sudah di-`import` di `main.js` tapi belum pernah dipakai.)
  - Kunci i18n baru: `header.manualConnect`, `header.portLabel`,
    `header.manualConnectHint` (ID + EN). `header.connect` sudah ada dan
    dipakai ulang, tidak diduplikasi.

### Added
- **Test `manual-connect-test.js`** (7 seksi, 38 pemeriksaan) untuk Phase 10.4A.
  Yang paling dijaga adalah posisi panel di luar `#app` - kalau panel ikut
  tersembunyi saat disconnect, user terkunci tanpa jalan keluar. Seksi lain:
  kontrol tidak lagi di header tapi masih ada di dokumen, auto-connect tetap
  terpanggil, label tombol tidak bertabrakan dengan i18n, kunci locale lengkap
  dan tidak dobel, serta `focus-visible` pada `<summary>`.
  Diverifikasi dengan **uji negatif**: panel dipindahkan ke dalam `#app`, test
  dipastikan gagal dengan pesan yang tepat, file dipulihkan, test hijau lagi.

### Added
- **Spesifikasi protokol di `README.md`.** Sebelumnya `README.md` masih
  template Tauri bawaan 7 baris - tidak ada spesifikasi protokol di mana pun
  selain implisit di dalam test. Sekarang ditulis sekali sebagai rujukan
  manusia: seluruh perintah app ke device beserta formatnya, seluruh baris
  device ke app, konstanta yang harus cocok dengan firmware, dan tiga batasan
  yang mudah dilanggar (`[KEY]` maksimal 62 byte, `currentLayer` ikut
  tersimpan ke flash, `DUMP:<n>` tidak memindahkan layer aktif).
- **Test `version-test.js`.** Mengunci versi `package.json`, `Cargo.toml`, dan
  `tauri.conf.json` tetap sama. Ketiganya dulu tidak sinkron (0.1.0 vs 0.2.0)
  dan Tauri **tidak** memverifikasi angka ini, jadi penyimpangan bisa terjadi
  diam-diam tanpa build gagal.
- **Test `readme-protocol-test.js`.** Memastikan README tidak berbohong:
  setiap perintah yang didokumentasikan harus ada di firmware, setiap prefix
  yang didokumentasikan harus benar-benar dicetak firmware, dan angka di
  README (`RGB_COUNT`, `APP_SLOTS`, batas 62 byte) dibandingkan langsung dengan
  `limits.h`/`macropad_core.h` - bukan hanya dicek "firmware = 9", karena itu
  tetap hijau kalau README menulis 16.
  Diverifikasi dengan **uji negatif** yang membuat empat kebohongan (README
  kembali jadi template Tauri, perintah fiktif `BLE:SCAN`, angka `[KEY]` salah,
  jumlah RGB slots salah) - keempatnya terdeteksi.

### Changed
- `package.json` 0.1.0 → **0.2.0** agar sama dengan `Cargo.toml` dan
  `tauri.conf.json`.
- README mencatat jujur bahwa firmware hanya bisa diverifikasi secara statis di
  lingkungan build ini (tidak ada toolchain Arduino), dan compile + uji di
  device tetap wajib.

### Notes
- **Koreksi pada test, bukan pada README.** Versi pertama
  `readme-protocol-test.js` salah menghitung panjang baris `[KEY]` sebagai 56
  byte karena kelewatan menghitung prefix literal `"[KEY] "` (6 karakter).
  Test menyimpulkan README salah, padahal README dan `key-event-test.js` yang
  sudah ada sama-sama benar (61 + newline = 62). Test yang diperbaiki sekarang
  menghitung ulang dari format lengkap, sehingga angkanya benar-benar berasal
  dari firmware dan bukan dari tebakan.

### Fixed
- **Preset aktif menimpa pilihan layer user dalam ~120 ms.** `lastDeviceLayerEventAt`
  sudah diisi setiap ada `EVT:LAYER:` sejak lama, tapi **tidak pernah dibaca siapa
  pun** - sudah diverifikasi di seluruh riwayat repo. Akibatnya memutar knob ke
  layer 3 akan langsung ditimpa balik ke layer 0 oleh preset Adaptive yang
  sedang aktif, karena polling window foreground berjalan tiap ~1,2 detik dan
  tidak tahu bahwa user baru saja memilih layer.
  - Auto-switch sekarang ditunda **1,5 detik** setelah `EVT:LAYER:`. Yang
    ditunda hanya perpindahan **otomatis**; klik tab di app tidak ikut ditunda
    karena itu pernyataan langsung dari user.
  - **Auto-switch juga diblokir selama ada dump yang berjalan.** Dump memuat
    ulang seluruh layer dan memanggil `DUMP` untuk masing-masing; auto-switch
    di tengah itu akan menyisipkan perintah ke stream dump yang sedang dibaca.
  - `EVT:LAYER:` yang datang **di tengah dump** sekarang ditunda, bukan
    langsung diterapkan atau diabaikan. Kalau langsung diterapkan,
    `currentLayer` ikut berubah dan `DUMP_END` yang me-resolve waiter memakai
    `currentLayer` sebagai fallback bisa me-resolve waiter yang salah - isi
    preset yang tersimpan ke disk jadi keliru.
  - Urutan di `DUMP_END` penting: `resolveDumpWaiters()` harus dipanggil
    **sebelum** layer tertunda diterapkan. Kalau dibalik, fallback
    `currentLayer` sudah menunjuk layer yang salah saat resolve. **Bug urutan
    ini ditemukan oleh `layer-hold-behaviour-test.js`, bukan oleh test
    berbasis teks** - test regex tidak bisa membedakan `if (x)` dari
    `if (false && x)`, keduanya sama-sama lolos.

### Changed
- **Nilai `lastDeviceLayerEventAt` dipindahkan dari `protocol-parser.js` ke
  `adaptive.js`, dikirim lewat panggilan `noteDeviceLayerEvent()`.**
  Versi pertama meng-`import` `getLastDeviceLayerEventAt()` dari
  `protocol-parser.js` ke `adaptive.js` - itu **membuat siklus import**,
  karena `protocol-parser.js` sudah mengimpor `adaptive.js` (untuk logika
  escape & preset). Kebijakan proyek sejak Phase 8 melarang siklus, jadi arah
  panggilan dibalik ke arah yang memang sudah ada: parser → adaptive.
  `dumpInProgress` tetap di-import langsung dari `serial-transport.js`
  karena modul itu tidak mengimpor `adaptive.js`, jadi tidak membentuk siklus.

### Added
- **`import-cycle-check.mjs`** - membangun graf import seluruh `src/` dan
  mencari siklus dengan DFS. Modularisasi Phase 8 pecah `main.js` jadi 15 modul
  dengan aturan "tidak saling mengimpor balik", tapi aturan itu tidak pernah
  diawasi alat - siklus baru bisa masuk diam-diam. Mengabaikan komentar dulu,
  karena `device-state.js` menyebut `import { ROWS } from './device-state.js'`
  di dalam penjelasan dan akan dilaporkan mengimpor dirinya sendiri.
  Diverifikasi dengan uji negatif yang menyuntikkan `adaptive -> protocol-parser`
  dan memastikan siklus terdeteksi.
- **`layer-hold-test.js`** (6 seksi, 26 pemeriksaan) - bentuk kode: ambang jeda
  terdefinisi, `0` tidak memblokir selamanya, helper benar-benar dipanggil,
  `dumpInProgress` ikut memblokir, dan graf import tetap satu arah.
- **`layer-hold-behaviour-test.js`** - menguji **perilaku**, bukan teks:
  menjalankan ulang alur `DUMP_END` dengan state tiruan dan membuktikan bahwa
  perilaku lama benar-benar merusak (waiter resolve dengan layer 2, bukan 0)
  sementara perilaku baru benar. Inilah test yang menemukan bug urutan di atas.
- Kunci i18n baru `parser.layerDuringDump` (ID + EN) untuk pesan log saat
  perpindahan layer ditunda.

### Fixed
- **Status "belum disimpan" di halaman RGB tidak diumumkan ke screen reader
  (Phase 9.3).** `#rgbSaveState` menampilkan teks "belum disimpan" setiap kali
  RGB diubah. Tanpa live region, teks itu hanya terlihat - screen reader tidak
  mengumumkannya karena teks statis tidak masuk pengumuman otomatis. User
  buta bisa menutup app tanpa pernah tahu perubahan RGB-nya belum tersimpan ke
  device. Sekarang `#rgbSaveState` memakai `role="status"` +
  `aria-live="polite"`, konsisten dengan `#statusText` dan `#log`.
  `polite` (bukan `assertive`) dipilih supaya tidak memotong apa yang sedang
  dibacakan screen reader.
  Live region ini sudah ada di HTML dan hanya diubah lewat `textContent`, jadi
  screen reader punya kesempatan membandingkan "sebelum" vs "sesudah" - kalau
  elemennya baru dibuat saat teks muncul, tidak ada yang diumumkan.

### Added
- **Test `rgb-savestate-a11y-test.js`** (5 seksi, 13 pemeriksaan) plus seksi
  5c di `a11y-test.js`. Yang dijaga bukan hanya atributnya, tapi juga bahwa
  live region **sudah ada sebelum teks berubah** (tidak dibuat lewat
  `createElement`), tidak ditulis lewat `innerHTML`, dan teks yang
  diumumkan selalu berisi informasi bermakna.
  Diverifikasi dengan uji negatif yang mengembalikan `#rgbSaveState` ke span
  biasa - **kedua test mendeteksinya**.

### Fixed
- **Device yang port-nya muncul sebelum firmware siap tidak PERNAH tersambung.**
  Dua hal bertemu dan saling menutup jalan:
  1. `scheduleRetry()` maksimal **2x percobaan** lalu menyerah permanen.
  2. `pollPorts()` hanya melakukan probe kalau ada port **BARU** muncul.

  Device yang di-colok saat Windows sudah start sering punya port yang muncul
  di enumerasi *sebelum* firmware selesai boot, jadi probe pertama gagal. Sesudah
  itu port-nya sudah ada di `knownPorts` sehingga tidak lagi dianggap "baru",
  dan `pollPorts()` early-return setiap 2 detik tanpa melakukan apa pun. Retry
  juga sudah habis di percobaan kedua. Akibatnya app tidak pernah tersambung -
  satu-satunya jalan keluar adalah restart app atau cabut-colok device.

  Diverifikasi dengan simulasi sebelum-dan sesudah: device siap pada detik
  ke-8 tetap `TIDAK TERHUBUNG` dengan kode lama, dan `TERHUBUNG` di poll ke-4
  dengan kode baru.
  - Retry dinaikkan ke **6x percobaan** dengan **backoff**
    (2,5 dtk - 5 dtk - 7,5 dtk - 10 dtk - 12,5 dtk - 15 dtk, dibatasi 20 dtk).
    Backoff naik supaya port yang memang bukan MacroPad tidak di-probe terlalu
    sering, tapi cukup cepat untuk device yang sedang boot.
  - `pollPorts()` sekarang treats port yang **sudah gagal di-probe** sama
    seperti port baru. Inilah jaring pengaman yang membuat app menunggu tanpa
    batas, bukan menyerah - retry 6x hanyalah lapisan pertama.
  - `failedProbes` dibersihkan di tiga tempat supaya tidak basi: saat
    `connect()` berhasil (sekalian membatalkan retry terjadwal), saat
    `handleDeviceLost()` (tak ada probe ke port yang sudah dicabut), dan saat
    `autoDetect()` (tombol ↻ me-reset, jadi probe benar-benar dari awal).
    Tanpa pembersihan ini, port yang tidak bisa dibuka akan di-probe setiap 2
    detik **selamanya**.
  - Yang sengaja tidak berubah: retry tetap berhenti begitu user menekan
    Disconnect (`autoReconnect = false`), dan interval `pollPorts` tetap 2
    detik.

### Added
- **Test `retry-test.js`** (5 seksi, 21 pemeriksaan). Yang paling dijaga adalah
  re-probe port gagal - itu inti perbaikannya - plus ketiga tempat pembersihan
  `failedProbes`. Diverifikasi dengan **uji negatif** yang membuat enam
  regresi: batas retry dikembalikan ke 2x, early-return tanpa `retryable`,
  `targets` tidak memakai `retryable`, penandaan gagal dihapus, pembersihan
  saat connect dihapus, dan backoff dikembalikan ke jeda tetap. **6/6
  terdeteksi.** Kasus "port hantu di-probe selamanya" ikut diuji karena itu
  risiko balik dari perubahan ini - menandai terlalu banyak sama buruknya dengan
  tidak menandai sama sekali.

### Fixed
- **Reconnect kembali ke layer 4, bukan layer 0.** Akar masalahnya di firmware:
  `currentLayer` adalah bagian dari struct `cfg` yang sama persis dengan isi
  flash, jadi `SAVE` di layer 4 menuliskan `currentLayer=4` ke NVS. Setelah
  device dimatikan dan dinyalakan, `INFO:` melaporkan `currentLayer=4`, dan
  `applyInfo()` menerimanya apa adanya - sehingga setiap reconnect user terjebak
  di layer 4.
  - `connect()` sekarang mengirim `LAYER:0` **sebelum** `INFO`. Device sudah
    berada di layer 0 saat `INFO` diproses, jadi `currentLayer` yang dilaporkan
    = 0 dan hanya satu layer yang dimuat.
  - **Urutan itu penting.** Kalau `INFO` dikirim lebih dulu, app akan memuat
    layer 4 ke grid lalu berganti ke layer 0 - grid berkedip menampilkan isi
    yang salah sebelum benar. Ada test yang mengunci urutan ini.
  - Layer 0 selalu valid karena firmware menjamin `layerCount >= 1`
    (`macropad_core.h:293`), jadi perintah ini aman dikirim tanpa harus tahu
    jumlah layer lebih dulu.
  - **Firmware tidak diubah.** Pilihan sadar: tidak memaksa `currentLayer` ke 0
    di sisi firmware, karena `LAYER:` yang diterima saat boot tidak selalu
    berarti "mulai dari awal" - gestur knob (long-press) juga menyentuh
    `currentLayer`, dan memaksa 0 di boot akan menimpaREFERENSI milik user.
   App yang tahu konteks sedang dalam sesi baru, jadi app yang meminta.
  - Fix "preset kembali ke layer terakhir" (commit sebelumnya) tetap utuh dan
    tidak bertabrakan: `openPresetEditor()` mengirim `LAYER:<target>` sendiri
    dan tidak dipaksa ke 0.

### Added
- **Test `reconnect-layer0-test.js`** (5 seksi, 18 pemeriksaan). Menangkap
  urutan perintah di `connect()`, jaminan `layerCount >= 1` di firmware,
  keputusan tidak mengubah firmware, jalur pemuatan `INFO:`, dan memastikan
  fix layer-terakhir-per-preset tidak rusak. Diverifikasi dengan **uji negatif**:
  `LAYER:0` dihapus total, lalu urutannya dibalik (`INFO` dulu) - keduanya
  terdeteksi. Kasus kedua penting karena hanya menimbulkan kedipan singkat,
  bukan kegagalan total, jadi sulit dilaporkan user.

### Fixed
- **Preset selalu terbuka di layer 0.** `openPresetEditor()` mengirim
  `LAYER:0` secara hardcoded, jadi membuka ulang preset yang sama selalu
  melompat kembali ke layer pertama - padahal user mungkin sedang mengedit
  layer 3. Sekarang layer terakhir dicatat per preset dan dipakai lagi saat
  preset yang sama dibuka kembali dalam satu sesi koneksi. Preset yang belum
  pernah dibuka tetap mulai dari layer 0, sesuai permintaan.
  - Peta `lastLayerByPreset` **di-reset tiap koneksi putus**
    (`resetAdaptiveRuntimeState()`), bukan tiap aplikasi ditutup. Alasannya:
    isi RAM device ikut hilang saat koneksi putus, jadi device sedang tidak
    menampilkan preset mana pun. Layer yang tercatat dari sesi lalu sudah tidak
    punya isi - membukanya hanya membuka layer kosong.
  - **Dijepit ke `[0, jumlah layer preset - 1]`.** Tanpa jepit, preset yang
    tadinya punya 5 layer lalu dikecilkan (mis. sebagian layer dihapus) akan
    mengirim `LAYER:4` yang tidak ada - device diam dan grid tampil kosong
    tanpa pesan error apa pun.
  - Dicatat di **dua jalur keluar**: `openPresetEditor()` (sebelum
    `editingPresetId` ditimpa, sehingga lompat langsung dari preset A ke preset B
    juga tercatat) dan `exitPresetEditor()` (jalur Selesai/Batal). Kalau hanya
    satu, layer terakhir hilang untuk jalur yang lain - dan gejalanya baru
    muncul setelah disconnect.

### Added
- **Test `preset-layer-test.js`** (5 seksi, 18 pemeriksaan) untuk fix di atas.
  Yang diuji: tidak adanya lagi `LAYER:0` hardcoded, Default-to-0 untuk preset
  yang belum pernah dibuka, penjepit rentang layer, pencatatan di kedua jalur
  keluar, dan reset per sesi koneksi. Diverifikasi dengan **uji negatif** yang
  sengaja membuat empat regresi - `LAYER:0` hardcoded, penjepit dihapus, reset
  peta dihapus, pencatatan di `exitPresetEditor` dihapus - dan memastikan keempatnya
  **terdeteksi**. Keempatnya adalah bug senyap: tidak melempar error, hanya
  berperilaku salah.

### Fixed
- **Kontrol RGB tanpa nama yang bisa dibaca (Phase 9.4).**
  Dua slider (`#rgbBri`, `#rgbSpeed`) punya `<span>` teks di sebelahnya.
  Terlihat, tapi `<span>` tidak memberi accessible name - screen reader hanya
  membacakan "slider" tanpa nama. Dua color picker (`#rgbColorPicker`,
  `#rgbModeColor`) bahkan tidak punya teks sama sekali di dekatnya, jadi
  keduanya diumumkan sebagai "color picker" telanjang.
  - `<span>` diganti `<label for>` - nama jadi benar dan tetap terlihat.
  - `#rgbColorPicker` dihubungkan ke `#rgbKeyTitle` via `aria-labelledby`.
    Judul itu diisi dinamis di `rgb-page.js` dengan
    `t('rgb.keyColorTitle', { name })`, jadi nama yang terbaca selalu menyebut
    key yang sedang dipilih - tidak ada kunci i18n baru yang bisa basi.
  - `#rgbModeColor` dapat `aria-label` lewat kunci baru `rgb.modeColorLabel`
    (ID + EN), lewat `data-i18n-attr` supaya ikut ganti bahasa.
  - Nilai slider sekarang punya `aria-valuetext` berisi versi persen yang
    sama persis dengan yang tertulis di layar (`78%`), bukan angka mentah
    0-255 yang ada di atribut `value`. Span readout di layar diberi
    `aria-hidden="true"` supaya tidak dibacakan dua kali.
  - Penulisan nilai diringkas ke satu helper `setSliderReadout()` yang
    menulis teks layar dan `aria-valuetext` bersamaan. Sebelumnya ada
    4 titik penulisan terpisah; mengisi salah satu saja akan membuat angka yang
    dibacakan berbeda dari yang terlihat, dan itu tidak akan ketahuan.
  - `styles.css`: selector `.rgb-slider-row > span:first-child` diperluas
    menyertakan `label:first-child`. Tanpa ini label kehilangan lebar tetap
    78px dan slider melebar tidak seragam.

### Fixed
- **Keyboard terkunci saat merekam binding (Phase 9.6).**
  `captureKeyDuringRecording()` memanggil `preventDefault()` pada SETIAP
  `keydown` selama mode rekam aktif. Akibatnya `F5`, `Ctrl+R`, `Ctrl+W`,
  `Ctrl+T` semuanya tertahan, dan satu-satunya cara keluar adalah klik tombol
  Cancel - yang mustahil dijangkau karena keyboard sedang direkam. User
  terkunci sampai app ditutup paksa. (`Alt+Tab` tidak bisa di-`preventDefault()`
  dari webview sama sekali; itu pintasan accelerator sistem, bukan event DOM.)
  - Escape sekarang menjadi jalan keluar: menghentikan rekam, menyembunyikan
    panel editor, dan membersihkan isi editor. Petunjuk di UI (ID & EN)
    menyebutnya supaya tidak sekadar konvensi tersembunyi.
  - Logika "batal" diekstrak jadi satu `cancelEditor()` di `home-page.js`,
    dipakai oleh tombol Cancel **dan** Escape. Sebelumnya logikanya tertulis
    inline di `onclick` tombol Cancel; menyalinnya berarti kedua jalur bisa
    melenceng - dan jalur yang lupa melepas listener perekaman akan mengunci
    keyboard untuk sisa sesi.
  - Tabrakan dengan modal diperbaiki. `ui-modal.js` memasang listener di fase
    *capture* pada `document`, sedangkan perekam keyboard di `window` fase
    *bubble* - jadi modal selalu jalan lebih dulu. Tanpa koordinasi, satu
    tekan Escape akan menutup modal **sekaligus** membatalkan editor. Sekarang
    `ui-modal.js` memanggil `e.preventDefault()` saat menutup, dan perekam
    memeriksa `e.defaultPrevented` lalu mundur. Escape juga tidak lagi jatuh ke
    cabang Enter di `ui-modal.js` (sebelumnya `if (e.key === 'Escape') close(null);`
    tanpa `return`, jadi branch berikutnya ikut dievaluasi).
  - Fungsi `onKey` di `ui-modal.js` sekarang me-return eksplisit di tiap cabang.

### Changed
- **Test `home-page-diff.js` dan `shell-ui-diff.js` diperbarui untuk 9.6.**
  Keduanya adalah diff test "verbatim proof" yang membandingkan hasil ekstraksi
  modul dengan versi lama di commit yang dipin, jadi mereka **wajib** gagal
  saat ada perubahan yang disengaja - itulah gunanya. Baris baru 9.6 di-strip
  lewat daftar `ESCAPE_HATCH` supaya perbandingan tetap ketat terhadap semua
  baris lain, dan keberadaan baris baru itu dibuktikan eksplisit di seksi 4b -
  kalau tidak, strip itu bisa menelan perubahan apa pun tanpa terlihat.
  `shell-ui-diff.js` tidak lagi memakai perbandingan posisional untuk `onKey`
  (bentuknya memang berubah), tapi PERILAKU yang dijanjikan - Escape menutup
  dengan `null` - tetap diuji, ditambah pemeriksaan bahwa Escape me-return
  sebelum cabang Enter.

### Added
- **Test `record-escape-test.js`** (6 seksi) yang mengunci perilaku 9.6:
  Escape ditangani sebelum branch tombol biasa (tidak ikut jadi token),
  `cancelEditor()`EXPORTED dan lengkap, jumlah `addEventListener` ==
  `removeEventListener` (mencegah listener menumpuk setiap kali editor dibuka),
  Contracts `ui-modal` <-> perekam, dan petunjuk UI menyebut Escape di kedua
  bahasa. Test ini diverifikasi **dengan uji negatif**: `preventDefault()` di
  `ui-modal.js` sengaja dihapus sementara, test dipastikan GAGAL, lalu file
  dipulihkan dan test dipastikan hijau lagi. Test yang tidak pernah gagal
  tidak membuktikan apa pun.

### Fixed
- **Perubahan status koneksi dan level baterai tidak bisadidengar screen reader.**
  Indikator baterai berupa SVG, yang isinya tidak bisa dibaca assistive tech —
  sekarang ditandai `role="img"` dan maknanya dipindahkan ke `aria-label` yang
  diisi `battery-ui.js` dari nilai yang sebenarnya, termasuk keadaan "belum ada
  data" (yang kalau dibiarkan kosong akan dibacakan sebagai kosong).
- **Tombol ikon `↻` (pindai ulang port) tanpa nama yang bisa dibacakan.**sekarang
  punya `aria-label`. Tombol `≡` (toggle sidebar) juga, beserta `aria-expanded`
  yang diperbarui setiap kali diklik dan disetel sesuai keadaan awal.
- **`aria-expanded` pada toggle sidebar bisa meleset dari keadaan sebenarnya.**
  Nilai yang disimpan ke `localStorage` sekarang dijamin string boolean
  (`"true"`/`"false"`), bukan objek boolean mentah yang akan jadi `"{}"` saat
  diserialisasi — kunci yang sama dibaca lagi oleh versi berikutnya, jadi
  data lama milik versi lama tetap terbaca.
- **SVG dekoratif dibaca sebagai teks aneh.** Semua SVG di `index.html` kini
  punya `aria-hidden="true"`; satu SVG yang terlewat (ikon bel pada tombol
  "Tes") ditemukan oleh `a11y-test.js` dan diperbaiki.

### Changed
- **`shell-ui-diff.js` dan `home-page-diff.js`: tiga fungsi tidak lagi dibandingkan
  posisional, diganti pembuktian semantik.** Phase 9a mengubah bentuk
  `switchPage()`, toggle sidebar, `showModalBase()`, `renderTabs()`, `renderGrid()`,
  dan `renderEncoderList()` — semuanya mendapat stmt a11y sehingga perbandingan
  baris-per-baris mustahil. Sekarang setiap **efek lama** dibuktikan masih ada
  di kode baru (mis. `switchPage` tetap memakai `navName = navOverride || name`,
  dan `navOverride` tetap **tidak** mempengaruhi halaman mana yang ditampilkan),
  sementara **tambahan a11y-nya** diuji terpisah secara positif. Diff tetap
  ketat terhadap perubahan yang tidak diharapkan.
- **`.nav-item` jadi `<button>`, jadi style bawaannya dinetralkan di `styles.css`**
  (`background: none`, `border: 0`, `font-family: inherit`, `text-align: left`)
  supaya tampilan sidebar tidak berubah sama sekali dari versi `<div>`. Tidak
  dinetralkan, sidebar akan berubah total.

#### Fase 9a (aksesibilitas)
Audit awal menemukan lima masalah nyata, semuanya terkait keyboard:

| Masalah | Akibat bagi pengguna keyboard |
|---|---|
| `.nav-item` = `<div onclick>` | Tidak bisa diakses keyboard sama sekali |
| Modal tanpa `role="dialog"`/focus trap | Screen reader tidak tahu ini dialog; Tab bisa keluar ke belakang |
| `#statusText`, `#log`, meter baterai tanpa live region | Perubahan status tidak diumumkan |
| Sel grid & baris knob = `<div onclick>` | Tidak bisa mengedit binding tanpa mouse |
| Tidak ada `:focus-visible` di seluruh aplikasi | Tidak ada petunjuk sedang berada di kontrol mana |

Yang **sengaja tidak** dikerjakan di Fase 9a: audit kontras warna, audit
`tabindex` positif yang tidak ada, dan pengujian dengan screen reader sungguhan.
Semuanya butuh browser/perangkat nyata, tidak bisa dibuktikan di lingkungan ini.

- **Refactor Tahap 8 (penutup Phase 8): tray & autostart dipindah ke `src/tray.js`**
  (137 baris). `main.js` turun dari 347 ke **252 baris**.
  - Berisi status autostart Windows, dialog "Simpan dulu?" untuk dua jalur (X dan menu
    tray "Keluar"), penangan `onCloseRequested`, listener `tray-quit`, dan jaring
    pengaman render-stalled.
  - Flag "belum tersimpan" disuntikkan lewat `initTray({ isDirty, setDirty })` supaya
    tray.js tidak menyimpan salinannya - dua salinan akan bisa berbeda diam-diam.
  - Loop `requestAnimationFrame` ikut pindah. Ini bukan sekadar hiasan: tanpa loop itu,
    `whenRenderStalled()` selalu resolve dan dialog akan melepas sendiri setelah 3 detik
    walau user belum menjawab. `tray-diff.js` memverifikasi loop dan ambangnya.

#### Ringkasan Phase 8
- `main.js` dari 1864 ke **252 baris** (-86%), tanpa satu baris pun yang bisa dibuktikan
  berubah perilakunya. Total `src/` naik dari 1864 ke 2861 baris karena komentar, test,
  dan penanda batas tanggung jawab ikut menambah - tapi sekarang setiap modul punya satu
  alasan jelas untuk ada.
- 15 modul, digraf.import-nya **bebas siklus** (dicek otomatis, dan grafnya dicetak
  supaya mudah diperiksa manual).
- Empat test "bukti pemindahan": `handleLine-diff.js`, `shell-ui-diff.js`,
  `home-page-diff.js`, `tray-diff.js`. Semuanya membandingkan kode lama dari git
  dengan kode baru modul per modul dan gagal kalau ada selisih. Ini yang membuat
  refactor berikutnya jauh lebih murah diperbaiki.
- `startup-smoke-test.mjs` memuat `main.js` sungguhan, dan `no-lost-functions-test.js`
  membandingkan daftar fungsi/konstanta top-level sebelum vs sesudah. Keduanya dibuat
  setelah bug nyata, bukan karena suspectsi.
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
- **Dua skrip test usang setelah abstraksi transport Phase 10.**
  `key-event-test.js` dan `protocol-contract-test.js` masih mencari literal
  `Serial.printf(`, padahal firmware sekarang memakai macro `SERIAL->printf(`.
  Akibatnya 5 pemeriksaan gagal palsu (`[KEY]`, `RGB_DUMP:`, `RGB_KEY:`,
  `EVT:BATT:`, `HWINFO:` dilaporkan TIDAK ADA) padahal string-nya utuh di
  `macropad_core.h` - hanya nama objeknya yang berubah. Regex-nya sekarang
  menerima keduanya lewat `(?:Serial\.|SERIAL->)printf`. Yang sempat dicurigai
  sebagai regresi cara kerja device ternyata bukan; format barisnya sudah
  diverifikasi masih persis sama.


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

### Phase 10 - BLE (lanjutan)

Yang sudah ada: abstraksi transport di firmware (`TRANSPORT_USB` / `TRANSPORT_BLE`,
default USB), modul WinRT GATT di `src-tauri/src/ble.rs`, dan enam perintah Tauri
(`ble_scan`, `ble_connect`, `ble_disconnect`, `ble_write`, `ble_read`,
`ble_is_connected`) yang sudah kompilasi bersih. Yang belum:

- **Transport BLE di sisi JavaScript.** Frontend masih talking `tauri-plugin-serial`
  secara langsung; belum ada cabang kode yang memilih USB atau BLE.
- **Auto-connect / auto-reconnect.** Belum ada.
- **Hapus dropdown COM + tombol Refresh/Connect**, sisakan status saja. Belum;
  sengaja ditahan sampai auto-connect benar-benar bekerja.
- **Fallback force-connect manual** yang disembunyikan (bukan dihapus) selama 1-2
  rilis pertama setelah auto-connect — belum.
- **`BleTransport` di firmware.** Yang ada baru interface + `UsbTransport`;
  `TRANSPORT_TYPE` masih `TRANSPORT_USB`.
- Enam perintah BLE sengaja **tidak** disambungkan ke state Tauri yang sebenarnya
  dulu, supaya bisa diuji terpisah dari UI. Menyambungkannya adalah langkah
  berikutnya.


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

Sisi Rust dan JavaScript bisa diverifikasi penuh. Status terakhir (setelah Phase 10):

| Yang diuji | Hasil |
|---|---|
| `cargo check` | bersih, 0 error |
| `cargo test --lib` | 9 passed, 0 failed |
| `npx vite build` | sukses, 32 modul |
| 21 skrip uji Node | 21/21 PASS |

Rincian skrip uji: parser protokol, waiter DUMP, kontrak protokol firmware↔app, format
event key, simbol firmware, state machine quadrature encoder, smoke test startup,
a11y, i18n, transport serial, halaman RGB, UI baterai, state device, adaptive contract,
settings, dan 5 skrip diff "verbatim proof" yang membandingkan hasil ekstraksi modul
dengan versi aslinya di commit yang dipin.

Prosedur pengujian lengkap (6 tingkat, dari yang otomatis sampai yang butuh hardware)
ada di `docs/STATUS-AND-TESTING.md`.