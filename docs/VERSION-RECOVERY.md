# Recovery & Versi

Dokumen ini supaya tidak perlu menghafal komit berhex.

## Nama Versi

Ada tiga tag yang perlu diingat:

| Tag | Arti |
|---|---|
| `app-v0.6.0` | Companion app versi 0.6.0 |
| `fw-v7` | Firmware versi 7 (untuk board PROTOTYPE / FINAL) |
| `checkpoint-app0.6.0-fw7` | Titik kembali yang stabil, keduanya sekaligus |

Cara cek versi yang sedang dipakai:

```bash
git describe --tags --abbrev=0
```

## Cara Memastikan Firmware Mana yang Terpasang

**Jangan menebak dari perilaku.** Firmware melaporkan nomornya sendiri lewat
perintah `WHOAMI`.

Di **Serial Monitor** (115200), ketik `WHOAMI` lalu Enter. Balasannya:

```
WHOAMI:MacroPad:v1:fw=7,rows=3,cols=3,encoders=1
              ^^^^^^  versi protokol  ^^^^^ versi firmware
```

Kalau `fw=7` → firmware terbaru. Kalau angkanya lebih kecil → firmware lama
yang masih terpasang, dan perlu di-flash ulang.

Nomor itu dikirim juga ke companion app setiap kali connect (bagian dari
handshake `WHOAMI`).

## Kapan Nomor Versi Firmware Dinaikkan

Naikkan `FW_VERSION` di `firmware/common/limits.h` setiap kali firmware
**mengubah perilaku** (bukan setiap commit). Perubahan kecil tidak perlu
menaikkan. Kalau FW_VERSION naik, header kedua sketsh juga harus ikut -
ada test yang menjaga keduanya tetap cocok.

Versi app dinaikkan di **tiga** berkas sekaligus (`package.json`,
`src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`). Test juga menjaga
ketiganya tidak berbeda.

## Cara Kembali ke Checkpoint

```bash
git checkout checkpoint-app0.6.0-fw7
```

Itu hanya memindahkan posisi folder - tidak menghapus apa pun. Untuk kembali
ke `master` (versi tanpa BLE sama sekali):

```bash
git checkout master
```

## Cara Baca Error BLE

Pakai Serial Monitor **bersamaan** dengan app. Beberapa pesan hanya muncul di
satu tempat:

| Prefix | Arti |
|---|---|
| `[BLE] NUS RX` | Perintah dari app **sampai** ke firmware |
| `[BLE] Connect` / `[BLE] Putus` | Status koneksi BLE |
| `[DUMP] ...` | Masih ada di firmware ini (dihapus di checkpoint ini) |

Kalau baris `[BLE] NUS RX` **tidak muncul** padahal app sudah mengirim
perintah, masalahnya di jalur app → BLE → firmware, bukan di pengiriman
jawaban.

## Masalah yang Belum Selesai

`[BLE] DUMP never closed (terminator lost)` masih muncul kadang.

### Kasus yang sudah dipecahkan (sebagian besar)

Setelah switch preset app lewat BLE secara konsisten muncul error ini.
Penyebabnya bukan firmware atau jalur BLE, tapi **window settling yang habis
sebelum DUMP response sampai**:

- `activatePresetRuntime()` mengirim ratusan perintah SET dalam satu batch,
  lalu segera memanggil `markBatchSettling(4000)` dan `loadActiveLayerDump()`
  (kirim `DUMP:<layer>`).
- Device tidak merespons DUMP sampai semua perintah SET diproses selesai —
  pada preset besar berarti > 4000ms.
- Setelah 4000ms, `batchUploadInFlight()` kembali false, watchdog dump sudah
  tidak lagi tahan. Jika DUMP response datang setelah itu, watchdog bisa tembak
  di tengahnya — melaporkan frame sehat sebagai "hilang".

**Perbaikan**: `markBatchSettling(6000)` dipanggil lagi setelah
`loadActiveLayerDump()` mengirim DUMP, memanjang window hingga response
benar-benar sampai.

Sebagai lapisan keamanan tambahan:
- Watchdog yang tembak tidak langsung membuang lineBuffer — sisa parsial
  disimpan dan re-parse, jadi DUMP_END yang tertuang sebentar setelah
  tembakan masih bisa diselesaikan.
- Backoff eksponensial pada watchdog: jika sudah tembak berulang, jeda
  sebelum tembakan berikutnya bertambah secara progresif.
- `loadLayer()` tidak lagi mengosongkan grid sebelum DUMP_BEGIN diterima —
  mapping lama tetap terlihat sampai device benar-benar mulai merespons.

### Sisa kasus yang belum teridentified

Penyebab lain masih mungkin ada. Dua kemungkinan yang sampai sekarang belum
bisa dibedakan:

1. Firmware tidak pernah mengirim `DUMP_END`.
2. Firmware mengirimnya, tapi hilang di antara device dan app.

Keduanya menghasilkan gejala yang identis.
