# Macro Pad Configurator

Companion app untuk macro pad ESP32-S3 (matriks 3x3 + rotary encoder), dibangun
dengan Tauri 2 + vanilla JS, ditambah firmware Arduino untuk dua profil board.

| Profil | Isi | Kekhasan |
|---|---|---|
| **PROTOTYPE** | 1 knob, LED status biasa di GPIO12 | Tidak punya RGB, baterai, VBUS, atau charger. Angka baterai & RGB dikirim sebagai **simulasi** dari firmware. |
| **FINAL** | 2 knob, 9x SK6812 MINI-E | Punya RGB, voltage divider baterai 100k/100k, deteksi VBUS, dan status charger MCP73831. |

Pindah profil = membuka sketsh yang lain, bukan mengubah sakelar.

---

## Struktur

```
firmware/
  common/
    limits.h           # konstanta bersama (pin, limit, RGB, transport type)
    macropad_core.h    # seluruh logika: keymap, protocol, scan matrix, encoder
    transport.h        # interface Transport (abstract USB CDC vs BLE)
    transport_usb.h    # implementasi USB CDC
  HID_Keypad_Prototype/HID_Keypad_Prototype.ino   # pin + simulasi
  HID_Keypad_Final/HID_Keypad_Final.ino           # pin + peripheral nyata
src/                    # frontend (ES modules, tanpa framework)
src-tauri/              # backend Rust (Tauri commands, WinRT GATT)
```

### Aturan import

Modul **tidak** saling memanggil fungsi satu sama lain secara langsung. Semua
berkomunikasi lewat `initXxx({...})` yang menyuntikkan dependensi. Tujuannya
menghindari siklus import sekaligus membuat setiap ketergantungan terlihat.

`main.js` adalah satu-satunya titik pertemuan antara modul-modul ini.

---

## Protokol serial

Format: **ASCII, satu baris per perintah, diakhiri newline**, 115200 baud
(USB CDC). Semua nilai yang dikirim device bisa rusak (`abc` jadi NaN) sehingga
app selalu memvalidasinya sebelum dipakai.

### Konstanta yang harus cocok dengan firmware

| Konstanta app | Nilai | Sumber firmware |
|---|---|---|
| `APP_SLOTS` | 6 | `slotTable` |
| `MACRO_MAX_LEN` | 47 byte (dipotong per karakter utuh) | `MACRO_MAX_LEN` = 48 termasuk terminator |
| RGB slots | 9 | `RGB_COUNT` |

### Perintah (app ke device)

| Perintah | Bentuk | Balasan |
|---|---|---|
| `PING` | - | `PONG` |
| `WHOAMI` | - | `WHOAMI:MacroPad:v1:rows=..,cols=..,encoders=..,proto=line\|frame,frame=0xA5` |
| `INFO` | - | `INFO:layerCount=..,currentLayer=..,maxLayers=..,rows=..,cols=..,encoders=..,context=..` |
| `HWINFO` | - | `HWINFO:profile=..,encoders=..,statusLed=..,rgb=..,rgbSlots=..,vdiv=..,chg=..,simulated=..` |
| `BATT` | - | `BATT:pin_mv=..,batt_mv=..,pct=..,charging=..,usb=..` |
| `DUMP:<n>` | baca layer `n` | `DUMP_BEGIN:<n>` ... `DUMP_END` |
| `DUMPNAMES` | baca nama layer | `NAMES_BEGIN` ... `NAMES_END` |
| `DUMPENC` | baca binding encoder | `ENC_BEGIN:count=N` ... `ENC_END` |
| `SET:<layer>:<r>:<c>:<type>:<value>` | tulis satu key | `[OK] Set ...` |
| `GET:<layer>:<r>:<c>` | baca satu key | `L<n> R<n> C<n> -> type=.. value=..` |
| `SETENC:<idx>:<CW\|CCW\|BTN>:<type>:<value>` | tulis binding encoder | `[OK] SetEnc ...` |
| `GEST` | baca gesture tahan per knob | `GEST_BEGIN` ... `GEST:<idx>:<t1Type>,<t1Ms>,<t2Type>,<t2Ms>` ... `GEST_END` |
| `SETGEST:<idx>:<1\|2>:<type>:<ms>` | atur satu tier gesture knob (disimpan di NVS `gestcfg`) | `[OK] Gesture knob n tier n ...` |
| `ADDLAYER` | tambah layer | `[OK] Layer ditambah, total ...` |
| `DELLAYER` | hapus layer aktif | `[OK] Layer dihapus, ...` |
| `RENAMELAYER:<n>:<name>` | ganti nama | `[OK] Layer <n> diganti nama jadi ...` |
| `MOVELAYER:<LEFT\|RIGHT>` | geser urutan | `[OK] Layer digeser ke posisi ...` |
| `LAYER:<n>` | pindah layer aktif | `[LAYER] ...` + `EVT:LAYER:<n>` |
| `SAVE` | tulis ke flash | `[OK]` / `[ERROR] SAVE gagal...` |
| `LOAD` | muat ulang dari flash | `[OK] Config dimuat ulang` |
| `RESET` | kembali ke default (perlu `SAVE` untuk permanen) | `[OK] Config direset...` |
| `CONTEXT:DEFAULT\|APP:NEW\|APP:RESUME` | ganti konteks preset | `[OK] Context: ...` |
| `SLOT:<n>:NEW\|USE` | cache slot preset | `[OK] Context: SLOT n (...)` |
| `RGB:ON\|OFF` | nyalakan/matikan | `[OK] RGB on/off` |
| `RGB:EN:<0\|1>` | status enable | `[OK] RGB ...` |
| `RGB:MODE:<mode>:<random>:<r>:<g>:<b>:<speed>` | mode + warna + kecepatan | `[OK] RGB mode n` |
| `RGB:BRI:<0-255>` | kecerahan | `[OK] RGB brightness n` |
| `RGB:ALL:<r>:<g>:<b>` | semua LED satu warna | `[OK] RGB semua diset` |
| `RGB:KEY:<r>:<c>:<r>:<g>:<b>` | satu key | `[OK] RGB r (Rr Cc) diset` |
| `RGB:DUMP` | baca seluruh state | `RGB_DUMP:..` + `RGB_KEY:..` ... + `RGB_DUMP_END` |
| `RGB:SAVE` | simpan ke flash | `[OK] RGB disimpan` |
| `RGB:RESET` | kembali ke default | `[OK] RGB reset ke default` |
| `DIAG` | laporan diagnosa 4 lapis | `DIAG:..` + `DIAGMEDIA:..` |
| `DIAG:ZERO` | reset penghitung diagnosa | `[OK] DIAG counter direset` |
| `SIG` | sidik jari config aktif | `SIG:%08lX` |
| `SIG:ALL` | sidik jari semua slot | `SIGSLOT:<n>:%08lX,layers=..,active=..` (6 baris) |
| `FRAME` | penghitung lapisan frame | `FRAME:mode=..,rx=..,tx=..,txDrop=..,txErr=..,crcErr=..,verErr=..,lenErr=..,unsup=..` |
| `FRAME:LINE` | paksa kembali ke mode baris | `[OK] Frame mode dimatikan, kembali ke mode baris` |
| `FRAMEIN:<nama>` | device menyusun frame sendiri lalu memprosesnya | byte frame + `ERR`/`EVT` |

`DIAG` menjawab dua baris: `DIAG:` (lapisan protokol: baris yang diparse,
baris terlalu panjang, perintah tak dikenal, perintah terakhir, heap) dan
`DIAGMEDIA:` (lapisan media: notify berhasil/gagal/retry, tinggi air ring
buffer, byte yang dibuang, write tanpa koneksi/subscriber, MTU). Companion app
mengirim `DIAG` tiap 30 detik dan menampilkan blok `=== DIAG ===` di panel log
beserta satu kalimat vonis yang menyebut lapis penyebabnya. Lihat
`src/diag-report.js`.

Tipe aksi (`type` pada SET/SETENC): `0` none, `1` teks, `2` kombinasi,
`3` macro, `4` consumer/media, `5` buka aplikasi.

Tipe gesture (`type` pada SETGEST): `0` tidak ada, `1` layer berikutnya,
`2` layer sebelumnya, `3` keluar preset. Gesture berlaku saat tombol knob
ditahan: tier 1 = tahan lebih lama dari `<ms>` tier 1, tier 2 = lebih lama lagi.
Tap singkat tetap menjalankan binding `BTN`. Durasi valid 100–20000 ms dan tier 2
harus lebih lama dari tier 1. Pengaturan ini per knob dan tidak ikut payload preset.

### Protokol frame v2 (migrasi, belum dipakai app)

Device sudah bisa berbicara dalam frame biner berdampingan dengan baris teks, dan
mendeteksi mode-nya sendiri. Aturannya sesempit mungkin:

```
mode baris + byte PERTAMA baris = 0xA5  -> mode frame
mode frame  + byte 0x0A saat perakit IDLE -> kembali ke mode baris
```

Format frame: `[SOF 0xA5][VER 0x02][TYPE][LEN u16 LE][PAYLOAD][CRC16 u16 LE]`,
CRC16/CCITT-FALSE atas `TYPE+LEN+PAYLOAD`. Specifikasi otoritatif ada di
`firmware/common/frame.h`; golden vectors di `tests/vectors/frames.vec` dibaca
tiga runner independen (C, JS, dan dicocokkan silang lewat `cargo test`).

Perintah frame yang sudah ada di device:

| Frame | Balasan |
|---|---|
| `HELLO` (0x01) | `HELLO_RSP` (0x81): versi fw, ukuran matriks, jumlah encoder, payload maksimum, jumlah slot, layer maksimum, slot aktif |
| `CFG_QUERY` (0x13) | `CFG_META` (0x93): slot aktif + sidik jari & jumlah layer tiap slot |
| `CFG_ACTIVATE` (0x14) | `CFG_ACT_RSP` (0x94): kode hasil, sidik jari yang aktif, slot |
| `LINE` (0x02) | diperlakukan sebagai satu perintah protokol lama, jawabannya keluar sebagai teks |
| lainnya | `ERR` (0x7F) dengan kode `UNSUPPORTED` - device mengatakannya terus terang |

**Serial Monitor selalu bisa mengirim perintah.** Device membaca USB CDC
sebagai jalur perintah kedua, terpisah dari jalur protokol yang bisa pindah ke
BLE NUS. Tanpa ini, begitu app mengirim `PROTO:NUS`, Serial Monitor jadi jalan
buntu: mengetik apa pun di sana tidak menghasilkan apa pun - bukan error,
keheningan - dan termasuk perintahnya sendiri untuk mengembalikan jalur
(`PROTO:CDC`). Test `contract-logpath-test.cjs` menjaga bahwa core tetap
dilarang **menulis** lewat `LOGS`; yang dibaca hanyalah input.

Jawaban `SIG`, `SIG:ALL`, dan `FRAME` sengaja dicerminkan ke Serial Monitor,
karena perintah itu dibuat untuk dibaca manusia. Jawaban frame (`HELLO_RSP`,
`CFG_META`, `CFG_ACT_RSP`) tidak dicerminkan - itu jawaban protokol, dan
menggandakannya akan membuat device yang membaca keduanya mengira ada dua
jawaban untuk satu permintaan.

**Kenapa `LINE` dan `FRAMEIN` ada.** Serial Monitor tidak bisa mengirim byte
biner. Tanpa `FRAMEIN` dan frame `LINE`, seluruh lapisan frame tidak akan pernah
bisa diuji sampai app selesai - dan justru kasus yang paling sulit direproduksi
dari app (CRC salah, versi salah, LEN monster) justru yang paling mudah diperiksa
dari sini.

`FRAMEIN` punya dua bentuk. **Gunakan yang pertama:**

```
FRAMEIN:CFG_QUERY           device menyusun frame-nya sendiri, CRC dihitung di device
FRAMEIN:HELLO
FRAMEIN:CFG_ACTIVATE:3
FRAMEIN:LINE:DIAG           perintah teks dibungkus frame LINE

FRAMEIN:A5 02 13 00 00 ...  byte mentah apa adanya - hanya untuk menguji frame yang salah
```

Bentuk kedua hanya berguna untuk menguji frame yang rusak dengan sengaja, dan
memerlukan hitung CRC manual. Bentuk pertama tidak mungkin salah, jadi kalau
bentuk pertama tidak menghasilkan frame, penyebabnya pasti di device - bukan di
byte yang diketik. Device mencetak byte frame yang disusunnya sebelum memprosesnya,
supaya bisa dibandingkan langsung dengan yang dikirim app nanti.

Contoh:

```
FRAMEIN:CFG_QUERY   -> [FRAME] CFG_QUERY (7 byte): a5 02 13 00 00 xx xx
                       [FRAME] FRAMEIN: 7 byte, mode=frame, rx=1, crcErr=0
FRAME                -> FRAME:mode=frame,rx=1,tx=1,txDrop=0,...,crcErr=0,...
```

Kalau device tidak bisa keluar dari mode frame, tekan Enter di Serial Monitor
(0x0A saat perakit sedang IDLE) atau kirim `FRAME:LINE`.

**`CFG_SIG`.** Sidik jari konfigurasi dihitung dari bentuk kanonik, bukan
`sizeof(struct)` mentah: hanya layer yang hidup, nilai action dihitung seluruh
lebarnya, dan semua field berlebar tetap. Alasannya di `firmware/common/cfg_sig.h`.
Perhitungannya diuji silang di C dan JS dari berkas vektor yang sama
(`tests/vectors/cfg.vec`, dihasilkan `tools/gen-cfg-vectors.mjs`), karena kalau
kedua sisi menghitung sidik jari yang berbeda, app akan mengunggah ulang preset
yang sebenarnya sudah identik - setiap kali.

**Encoder dihitung dari layer terakhir, bukan layer pertama.** Ini bukan pilihan
gaya. `SETENC` di firmware menulis ke `activeCfg->encCW[encIdx]` yang global,
tanpa indeks layer sama sekali. Unggah preset mengirim `SETENC` untuk setiap layer
berurutan, jadi lapisan terakhir menimpa semuanya dan device menyimpan satu set
binding saja. `cfgSig()` juga hanya membaca `c.encCW[0]` satu kali, di luar loop
layer. Kalau app menghitung sidik jari dari layer pertama, kedua angka itu tidak
akan pernah sama - dan preset yang sebenarnya sudah ada akan selalu diunggah
ulang, persis cacat yang seharusnya dihilangkan oleh CFG_SIG. Test
`tests/suites/frame-transport-test.mjs` mengunci perilaku ini ke baris `SETENC`
yang sesungguhnya di firmware.

### Lapisan frame di sisi app (Fase 3)

App sudah memakai frame untuk jalur cepat preset switch. Berkasnya:

| Berkas | Isi |
|---|---|
| `src/frame-codec.js` | encoder/decoder biner; tipe jawaban diturunkan dari `RESP_BIT`, bukan literal |
| `src/cfg-layout.js` | konstanta layout yang **harus** sama dengan `firmware/common/limits.h` |
| `src/frame-dispatch.js` | decoder persisten + antrean penunggu per tipe frame |
| `src/frame-transport.js` | percakapan frame: `sendFrame`, `queryFrameSlots`, `activateFrameSlot`, `ensureLineMode` |
| `src/pong-probe.js` | registry probe PONG (satu slot) |

**Byte masuk dialirkan ke dua jalur sekaligus** - perakit frame dan parser baris.
Model "ganti" (alihkan seluruh byte ke frame decoder begitu ada yang menunggu)
salah: device tetap mengirim event **teks** di mode frame, dan `EVT:LAYER:0` yang
keluar tepat setelah `CFG_ACTIVATE` ikut hilang kalau parser baris dimatikan.
Decoder frame hanya bereaksi pada `0xA5`, jadi teks tidak merusaknya.

**Kembali ke jalur teks diverifikasi, bukan diasumsikan.** Setelah frame
selesai, app mengirim newline lalu **`PING` dan menunggu `PONG`**. Versi pertama
mengirim baris kosong lalu langsung melangkah; kalau device ternyata tidak keluar
dari mode frame, `INFO` dan `DUMPENC` dibaca sebagai payload frame rusak,
`crcErr` naik, dan grid tidak pernah terisi.

**Format frame dinegosiasi, bukan dibaca dari nomor versi.** `proto=frame` pada
jawaban `WHOAMI` hanya PETUNJUK: device baru masuk mode frame setelah menerima
SOF `0xA5`, jadi `WHOAMI` pertama hampir selalu melaporkan `proto=line` bahkan
pada device yang mendukung frame. Kalau jawaban itu dipakai sebagai gerbang,
fast path tidak akan pernah terpakai. App mencoba frame; kalau gagal, jalur teks
dipakai dan kegagalan dicatat per sesi supaya tidak diulang.

**`batchUploadInFlight()` bukan lagi tebakan waktu.** `markBatchSettling(4000)`
dihapus: jendela tetap 4 detik itu menahan watchdog dump hampir 4 detik sia-sia
untuk batch kecil, dan habis terlalu cepat untuk batch besar pada link lambat -
dua-duanya berbohong. Penggantinya flag eksplisit (`beginCfgTransfer` /
`endCfgTransfer`) plus jendela yang diturunkan dari jumlah perintah nyata.

Yang **sudah** ada: `CFG_BEGIN`/`CFG_WRITE`/`CFG_COMMIT` (bulk upload, Fase 4)
dan credit flow control (Fase 5). `CFG_BEGIN` → `CFG_READY{credit u16}`;
`CFG_WRITE` dikirim via WriteWithoutResponse (BLE) / sendRaw (serial); device
mengirim `CREDIT` untuk menambah ruang staging. Minta `UNSUPPORTED` jika device
belum mengenali salah satu tipe ini.

### Baris dari device

| Awalan | Arti |
|---|---|
| `INFO:` | metadata device (dipakai juga setelah `RESET`) |
| `HWINFO:` | profil + kapabilitas; `simulated=1` berarti angka baterai/RGB adalah simulasi |
| `BATT:` | jawaban `BATT`; `EVT:BATT:` = event berkala |
| `EVT:CHG:state=N` | status charger: 0 tidak mengecas, 1 mengecas, 2 selesai |
| `EVT:LAYER:N` | user memindah layer dari device (long-press knob) |
| `EVT:ESCAPE` | gestur escape (tahan 3.5 detik atau lebih) |
| `EVT:ENC:N:CW\|CCW` | knob diputar |
| `EVT:APP:<nama>` | minta app membuka aplikasi; jika companion tidak terhubung, device mengetik lewat Windows Search |
| `DUMP_BEGIN:<n>` ... `DUMP_END` | isi layer `n`, satu baris `<row>,<col>,<type>,<value>` per key |
| `IDX:<i>` + `CW\|CCW\|BTN,<type>,<value>` | binding encoder ke-`i` |
| `NAMES_BEGIN` ... `NAMES_END` | nama layer, dipisah `\|` |
| `[KEY] <layer>,<row>,<col>,<type>,<value>` | notifikasi per key ditekan |
| `[ENC_BTN] Knob <i>:` | tombol knob ditekan |
| `[OK] ...` / `[ERROR] ...` | hasil perintah |
| `[FLASH] ...` | status penyimpanan ke NVS |

### Batasan yang harus dihormati

- **`[KEY]` maksimal 62 byte.** `7,2,2,3,` + 47 char + newline = 62, masih di
  bawah buffer stack 64 byte `vprintf`. Format verbose yang lebih panjang akan
  memicu alokasi `malloc` di dalam `vprintf`.
- **`currentLayer` ikut tersimpan ke flash** karena berada di struct `cfg` yang
  sama. Save di layer 4 membuat device boot kembali di layer 4. App karena itu
  mengirim `LAYER:0` tepat setelah connect.
- **`DUMP:<n>` tidak memindahkan layer aktif**, jadi jalur baca aman tanpa
  mengirim `LAYER:`.

---

## Build

```bash
npm install
npm run tauri dev      # pengembangan
npm run tauri build    # rilis
```

### Firmware

Arduino IDE, dua sketsh terpisah. **Setting Board yang sama untuk keduanya:**

- Tools > USB Mode: `USB-OTG (TinyUSB)`
- Tools > USB CDC On Boot: `Enabled`
- Tools > Upload Mode: `USB-OTG CDC (TinyUSB)`

---

## Pengujian

```powershell
cd src-tauri; cargo test --lib     # test Rust
npx vite build                     # menangkap error yang lolos node --check
# lalu jalankan skrip uji Node
```

Status verifikasi saat ini: `cargo check` bersih, 9 test Rust hijau,
`vite build` sukses, 28 skrip uji Node hijau.

Firmware **tidak** bisa diverifikasi penuh di lingkungan build ini (tidak ada
toolchain Arduino). Pemeriksaan yang dilakukan bersifat statis: kurung kurawal
seimbang, simbol domain terdefinisi, dan kontrak offset protokol di atas.
Compile Arduino dan uji di device tetap wajib.

---

## Changelog

### v0.6.6 (perbaikan)

#### Switch preset tidak konsisten ("tidak selalu berhasil")

Akar masalahnya satu keputusan yang salah tempat di `frame-transport.js`:

```js
if (!r.ok) { frameUsable = false; return null; }   // timeout biasa
```

Dua masalah sekaligus:

1. Timeout 2 detik — hal **normal** di link dengan `rtt p50=293ms` — langsung
   mematikan fast path.
2. "Mati" berarti **permanen** sampai disconnect.

Efeknya berantai: fast path mati → semua switch berikutnya jatuh ke jalur teks
yang mengirim ratusan baris `SET:` → link makin jenuh → RTT naik → timeout makin
sering → fast path makin sering mati.

Perbaikannya:

- Timeout sesaat **tidak lagi** mematikan fast path. Hanya 3 kegagalan
  berturut-turut, atau bukti nyata (`ERR UNSUPPORTED`), yang mematikannya.
- Fast path yang mati diberi **jeda 4 detik** lalu dicoba lagi, bukan mati
  permanen sampai disconnect.
- Jalur teks (ratusan `SET:`) punya **cooldown 8 detik** — jadi tidak lagi
  dipakai sebagai respons otomatis setiap frame timeout.
- `RTT_MS` 2 → 6 detik. 2 detik terlalu pendek untuk link yang RTT-nya 293ms,
  jadi setiap jawaban yang masih dalam perjalanan dianggap gagal.

#### Di mana RTT 293ms berasal

Firmware meminta `BLE_CONN_INTERVAL_MIN/MAX_MS 50/100`. Pada interval itu satu
hop = satu connection event = sampai 100ms, dan satu round trip = 2 hop. Angka
yang terukur persis di rentang itu.

Firmware sekarang meminta **15/30 ms**. Supervision timeout 10 detik memberi
ruang yang sangat lapang untuk connection event yang hilang, dan perangkat ini
USB-powered sehingga konsekuensi dayanya tidak terasa.

> Catatan: angka ini hanya *permintaan*; Windows yang memutuskan. Kalau setelah
> flash RTT tetap ~300ms, berarti Windows mengabaikan permintaan itu.

#### PING adaptif

PING 1500ms adalah ~80 pasang PING/PONG per 2 menit — traffic tetap yang memakai
link yang sama dengan upload preset. Sekarang: **idle 5 detik** (supervision
timeout 10 detik, jadi keepalive tetap aman), **1,5 detik** selama 6 detik
setelah ada aktivitas.

#### DIAG: lapis L5 LOSS

`notifyOk` (L4) menghitung chunk yang diterima stack BLE device, sedangkan
`notify_events` (L1) menghitung notifikasi yang sampai di host. Keduanya
menghitung hal **berbeda**, jadi tidak boleh dibandingkan — kesalahan baca ini
sudah menyesatkan sekali.

L5 LOSS sekarang melaporkan `rx_dropped_bytes`, satu-satunya angka lintas-lapis
yang benar-benar bisa dipercaya: kalau nol, link **tidak** dropping di host.

### v0.6.6

Migrasi protokol ke **frame biner v2** (Fase 0-5 `PLAN_BLE_Migration.md`).
Preset runtime sekarang diunggah lewat `CFG_BEGIN` / `CFG_WRITE` / `CFG_COMMIT`
dengan flow control `T_CREDIT`, bukan ratusan baris `SET:`.

**Perubahan utama**

- Layer frame biner di sisi app: `frame-codec.js` (encode/decode),
  `frame-dispatch.js` (perakit RX), `frame-transport.js` (soal + upload bulk).
- Fast path perpindahan preset: `CFG_SIG` + `CFG_QUERY` + `CFG_ACTIVATE`.
  Kalau device sudah punya slot dengan sig yang sama, perpindahan cukup satu
  frame 8 byte.
- `WHOAMI` sekarang melaporkan `frame=0xA5` sebagai **kemampuan** (bertahan
  melewati disconnect), bukan `proto=frame` yang hanya mencerminkan mode
  sesaat. Gate frame-path memakai yang former supaya device yang tersesat ke
  mode frame tidak lagi membuat deadlock.
- Jalur `BLE` ditulis ulang: `Drop for BleTransport` di Rust,
  disconnect-before-connect, backpressure `sendBatch`, retry ladder
  186ms -> 7ms, dan `onWrite()` tidak lagi `printf` blocking.
- Sesi protokol firmware di-reset di `onConnect`/`onDisconnect`
  (`PROTO_LINK_RESET`), jadi device yang kembali connect tidak diam-diam
  tertinggal dalam mode frame.

**Perbaikan**

- Reset state protokol saat BLE connect/disconnect (_app_ dan firmware).
- Filter karakter pengganti `U+FFFD` yang berasal dari frame biner yang ikut
  dibaca sebagai teks.
- `CONTEXT:DEFAULT` di-clamp `currentLayer`, jadi tidak lagi menunjuk layer
  yang tidak ada setelah kembali ke default preset.
- `handleDeviceLost()` memanggil `ble_disconnect` supaya handle WinRT tidak
  menumpuk pada setiap reconnect.

**Known issues (masih terbuka)**

- `notifyFail=3` dan latensi radio tinggi (`RTT p50=175ms`) dilaporkan pada
  host Windows. `ringDropped=0` sudah sehat, jadi ini sisi radio/host, bukan
  software.
- Fase 6 (pembersihan jalur teks: watchdog dump, `slotTable`, `SET:`) belum
  dikerjakan. Jalur `0x02 LINE`, `SET:`, `SLOT:`, `DUMP:` masih hidup sebagai
  diagnostic escape hatch.

**Verifikasi**

Firmware belum bisa diverifikasi penuh di lingkungan build ini (tidak ada
toolchain Arduino). Compile Arduino dan uji di device tetap wajib.

---

## Lisensi

Belum ditetapkan.
