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
| `WHOAMI` | - | `WHOAMI:MacroPad:v1:rows=..,cols=..,encoders=..` |
| `INFO` | - | `INFO:layerCount=..,currentLayer=..,maxLayers=..,rows=..,cols=..,encoders=..,context=..` |
| `HWINFO` | - | `HWINFO:profile=..,encoders=..,statusLed=..,rgb=..,rgbSlots=..,vdiv=..,chg=..,simulated=..` |
| `BATT` | - | `BATT:pin_mv=..,batt_mv=..,pct=..,charging=..,usb=..` |
| `DUMP:<n>` | baca layer `n` | `DUMP_BEGIN:<n>` ... `DUMP_END` |
| `DUMPNAMES` | baca nama layer | `NAMES_BEGIN` ... `NAMES_END` |
| `DUMPENC` | baca binding encoder | `ENC_BEGIN:count=N` ... `ENC_END` |
| `SET:<layer>:<r>:<c>:<type>:<value>` | tulis satu key | `[OK] Set ...` |
| `GET:<layer>:<r>:<c>` | baca satu key | `L<n> R<n> C<n> -> type=.. value=..` |
| `SETENC:<idx>:<CW\|CCW\|BTN>:<type>:<value>` | tulis binding encoder | `[OK] SetEnc ...` |
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

Tipe aksi (`type` pada SET/SETENC): `0` none, `1` teks, `2` kombinasi,
`3` macro, `4` consumer/media, `5` buka aplikasi.

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

## Lisensi

Belum ditetapkan.
