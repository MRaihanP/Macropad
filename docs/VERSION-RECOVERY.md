# Recovery & Versi

Dokumen ini supaya tidak perlu menghafal komit berhex.

## Nama Versi

Ada tiga tag yang perlu diingat:

| Tag | Arti |
|---|---|
| `app-v0.7.0` | Companion app versi 0.7.0 - auto-connect memulihkan diri sendiri |
| `fw-v9` | Firmware versi 9 - ring NUS 4 KB, overflow tercatat, BLE:RING |
| `checkpoint-app0.7.0-fw9` | Titik kembali stabil: auto-connect BLE memulihkan diri sendiri |

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
git checkout checkpoint-app0.7.0-fw9
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
| `[BLE] NUS RX` | Perintah dari app sampai ke firmware |

Kalau baris `[BLE] NUS RX` **tidak muncul** padahal app sudah mengirim
perintah, masalahnya di jalur app → BLE → firmware, bukan di pengiriman
jawaban.

## Masalah yang Belum Selesai

`[BLE] DUMP never closed (terminator lost)` masih muncul kadang.

Penyebabnya belum diketahui. Ada dua kemungkinan yang sampai sekarang belum
bisa dibedakan:

1. Firmware tidak pernah mengirim `DUMP_END`.
2. Firmware mengirimnya, tapi hilang di antara device dan app.

Keduanya menghasilkan gejala yang identik. Upaya menambahkan log untuk
membedakannya justru menambah baris ke stream USB dan mengganggu — sudah
dikembalikan di checkpoint ini.

Cara membedakannya **tanpa mengubah kode**: reproduce masalahnya sambil
Serial Monitor terbuka, lalu cari `[BLE] NUS RX` tepat sebelum error muncul.
Kalau ada, perintahnya sampai dan masalahnya di jalur jawaban (2). Kalau
tidak ada, perintahnya tidak sampai (1).
