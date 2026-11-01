# Catatan rilis (arsip)

Catatan rilis panjang yang dulu tinggal di README. Untuk ringkasan per versi,
lihat [CHANGELOG.md](../CHANGELOG.md).

## v0.9.0 — firmware FINAL, gesture per knob, media otomatis

Rilis ini mengubah FINAL dari "prototype yang diberi label final" menjadi
firmware perangkat sebenarnya.

**Firmware FINAL v8.** 2 knob, strip RGB 9 LED (urutan serpentine
`RGB_INDEX`), baterai 100k/100k di `VD` dengan switch `EN_VD`, deteksi kabel
`VD_VB`, dan status charger. Media dipilih otomatis: kabel terpasang → USB,
tanpa kabel → BLE. Tombol BOOT/GPIO0 tidak dipakai lagi.

**Yang tidak terlihat dari catatan pinout tapi wajib** (lihat CHANGELOG 0.9.0
untuk detail):

- GPIO21 bukan pin ADC di ESP32-S3 → deteksi USB harus `digitalRead`.
- FINAL harus benar-benar mengompilasi BLE (`HID_BLE_SUPPORT 1`).
- Payload biner preset 2 knob butuh 6014 byte; staging lama 5120 membuat setiap
  upload biner ditolak dan app diam-diam turun ke jalur teks.
- `cfgSig()` harus menyusun encoder kanonik per knob, kalau tidak cache preset
  tidak pernah cocok.
- RGB off / brightness 0 / warna hitam harus mematikan MOSFET `EN_RGB`.
- `rgb_effects.h` sebelumnya tidak bisa dikompilasi sama sekali (`%` pada float).

**Gesture tahan kini per knob** dan diatur dari app (`GEST`/`SETGEST`, dua tier,
100–20000 ms), disimpan di NVS sehingga tidak ikut payload preset.

**Audio:** buffer tetap 30 ms + kandidat fallback menggantikan "default driver"
yang bisa 200–2000 ms di endpoint virtual.

## v0.6.6 (perbaikan)

### Switch preset tidak konsisten ("tidak selalu berhasil")

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

### Di mana RTT 293ms berasal

Firmware meminta `BLE_CONN_INTERVAL_MIN/MAX_MS 50/100`. Pada interval itu satu
hop = satu connection event = sampai 100ms, dan satu round trip = 2 hop. Angka
yang terukur persis di rentang itu.

Firmware sekarang meminta **15/30 ms**. Supervision timeout 10 detik memberi
ruang yang sangat lapang untuk connection event yang hilang, dan perangkat ini
USB-powered sehingga konsekuensi dayanya tidak terasa.

> Catatan: angka ini hanya *permintaan*; Windows yang memutuskan. Kalau setelah
> flash RTT tetap ~300ms, berarti Windows mengabaikan permintaan itu.

### PING adaptif

PING 1500ms adalah ~80 pasang PING/PONG per 2 menit — traffic tetap yang memakai
link yang sama dengan upload preset. Sekarang: **idle 5 detik** (supervision
timeout 10 detik, jadi keepalive tetap aman), **1,5 detik** selama 6 detik
setelah ada aktivitas.

### DIAG: lapis L5 LOSS

`notifyOk` (L4) menghitung chunk yang diterima stack BLE device, sedangkan
`notify_events` (L1) menghitung notifikasi yang sampai di host. Keduanya
menghitung hal **berbeda**, jadi tidak boleh dibandingkan — kesalahan baca ini
sudah menyesatkan sekali.

L5 LOSS sekarang melaporkan `rx_dropped_bytes`, satu-satunya angka lintas-lapis
yang benar-benar bisa dipercaya: kalau nol, link **tidak** dropping di host.

## v0.6.6

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

Firmware diverifikasi dengan `arduino-cli` di lingkungan build (kedua sketsh
dikompilasi) dan lewat suite kontrak statis. Uji di device tetap wajib untuk
perilaku yang tidak bisa dibuktikan statis. Lihat
[STATUS-AND-TESTING.md](STATUS-AND-TESTING.md).

