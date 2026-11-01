# Macro Pad Configurator

Companion app untuk macro pad **ESP32-S3**: 3×3 tombol, hingga 2 rotary encoder,
9 LED RGB, dan baterai. Atur keymap, gesture knob, dan efek RGB dari desktop —
semuanya disimpan di perangkat, jadi macro pad tetap berfungsi tanpa app.

[![Release](https://img.shields.io/github/v/release/MRaihanP/Macropad?label=rilis)](https://github.com/MRaihanP/Macropad/releases/latest)

---

## Download

Installer Windows 64-bit tersedia di halaman **[Releases](https://github.com/MRaihanP/Macropad/releases)**:

| File | Keterangan |
|---|---|
| `macropad-configurator_0.9.0_x64-setup.exe` | Installer NSIS — pilihan yang disarankan |
| `macropad-configurator_0.9.0_x64_en-US.msi` | Paket MSI untuk instalasi terkelola |

Unduh, jalankan installer, lalu buka **Macro Pad Configurator** dari Start Menu.
Windows 10/11 64-bit. Bila WebView2 Runtime belum ada, installer akan
menawarkannya.

---

## Fitur

- **Keymap 3×3 sampai 8 layer** — setiap tombol bisa berisi teks, kombinasi
  tombol, macro, tombol media, atau membuka aplikasi.
- **Knob yang bisa diprogram** — putar CW/CCW dan tekan; mendukung 1 atau 2 knob
  tergantung board.
- **Gesture tahan per knob** — tahan untuk pindah layer atau keluar preset,
  durasinya diatur sendiri dari app (100–20000 ms) dan disimpan di device.
- **RGB 9 LED** — warna per tombol, breathing, color cycle, rainbow, wave, snake,
  random, dan react.
- **Baterai & status charger** — persentase, tegangan, dan indikator mengisi
  (khusus board FINAL).
- **USB atau Bluetooth otomatis** — board FINAL berpindah ke BLE saat kabel
  dilepas dan kembali ke USB saat kabel dipasang.
- **Preset adaptif** — konfigurasi mengikuti aplikasi yang sedang aktif.
- **Bahasa Indonesia & English** — mengikuti bahasa Windows saat pertama dibuka.

---

## Dua profil board

Repo ini berisi firmware untuk dua board. Pindah profil = membuka sketsh yang
lain, bukan mengubah sakelar.

| Profil | Isi | Catatan |
|---|---|---|
| **PROTOTYPE** | 1 knob, LED status di GPIO12 | Tanpa RGB, baterai, VBUS, atau charger. Angka baterai & RGB disimulasikan firmware. |
| **FINAL** | 2 knob, 9× SK6812 MINI-E | RGB, pembagi baterai 100k/100k, deteksi VBUS, charger MCP73831, BLE HID. |

---

## Mulai cepat

1. **Install app** dari halaman Releases.
2. **Flash firmware** ke board lewat Arduino IDE. Pengaturan Board yang sama
   untuk kedua sketsh:
   - Tools → USB Mode: `USB-OTG (TinyUSB)`
   - Tools → USB CDC On Boot: `Enabled`
   - Tools → Upload Mode: `USB-OTG CDC (TinyUSB)`
3. **Sambungkan** macro pad lewat USB. App akan mendeteksi port secara otomatis;
   untuk BLE, pilih transport BLE di panel koneksi lalu pilih perangkatnya.
4. **Atur** keymap, knob, dan RGB. Tekan **Save** agar konfigurasi ditulis ke
   flash device dan tetap ada setelah reboot.

---

## Build sendiri

Prasyarat: Node.js, Rust (stable), dan dependensi Tauri untuk Windows.

```bash
npm install
npm run tauri dev      # mode pengembangan
npm run tauri build    # menghasilkan installer di src-tauri/target/release/bundle/
```

Firmware dikompilasi dengan `arduino-cli` (core `esp32` 3.3.8):

```bash
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/HID_Keypad_Final
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/HID_Keypad_Prototype
```

---

## Pengujian

```bash
npm test                           # seluruh suite uji Node
cd src-tauri; cargo test --lib     # test Rust
npx vite build                     # build frontend
```

Hasil terakhir: 84 test Rust hijau, `vite build` sukses, kedua sketsh firmware
terkompilasi, dan 40 dari 44 suite Node hijau (4 suite merah sudah ada sebelum
rilis 0.9.0, lihat [CHANGELOG](CHANGELOG.md)). Uji di device tetap wajib untuk
hal yang tidak bisa dibuktikan statis: polaritas pin enable, arah putaran knob,
dan status charger.

---

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Struktur repo, modul app, aturan import, alur data |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Perintah serial, protokol frame v2, batasan |
| [docs/STATUS-AND-TESTING.md](docs/STATUS-AND-TESTING.md) | Status fitur, prosedur uji, checklist hardware |
| [CHANGELOG.md](CHANGELOG.md) | Riwayat perubahan per versi |
| [docs/HISTORY.md](docs/HISTORY.md) | Catatan rilis panjang (arsip) |

---

## Lisensi

Belum ditetapkan.
