# Arsitektur

Dokumen ini menjelaskan bagaimana repo ini disusun dan bagaimana bagian-bagiannya
berkomunikasi. Untuk perintah protokol, lihat [PROTOCOL.md](PROTOCOL.md).

## Struktur direktori

```
firmware/
  common/
    limits.h           # konstanta bersama (pin, limit, RGB, tipe transport)
    macropad_core.h    # seluruh logika: keymap, protokol, scan matrix, encoder,
                       # gesture, preset, baterai
    frame.h            # spesifikasi protokol frame v2 (otoritatif) + CRC
    frame_asm.h        # perakit frame di device untuk FRAMEIN
    frame_proto.h      # perakitan/pembongkaran frame, staging upload preset
    cfg_sig.h          # sidik jari konfigurasi (bentuk kanonik, bukan memcpy)
    rgb_effects.h      # mesin efek RGB murni (tanpa akses hardware)
    transport.h        # interface Transport (USB CDC vs BLE NUS)
    transport_usb.h    # implementasi USB CDC
    transport_ble.h    # implementasi BLE NUS
    hid_link.h         # pemilihan HID USB vs BLE
    ble_hid.h, ble_shared.h, ble_diag.h   # HID BLE, helper bersama, diagnosa BLE
    switch_iface.h     # switch media (khusus PROTOTYPE)
    diag.h, crc32.h
  HID_Keypad_Prototype/HID_Keypad_Prototype.ino   # pin + simulasi peripheral
  HID_Keypad_Final/HID_Keypad_Final.ino           # pin + peripheral nyata

src/                    # frontend, ES modules tanpa framework
src-tauri/src/          # backend Rust (command Tauri, WinRT GATT, audio)
  audio/                # graph audio: input, mixer, DSP, output
tests/
  suites/               # suite uji Node (kontrak statis + perilaku)
  vectors/              # golden vector frame & sidik jari config
docs/                   # dokumen teknis dan status
```

## Modul frontend (`src/`)

| Kelompok | Modul | Tanggung jawab |
|---|---|---|
| Titik masuk | `main.js` | Satu-satunya tempat semua modul dirakit lewat `initXxx()` |
| Transport | `transport.js` | Facade: semua modul memanggil ke sini, bukan ke backend langsung |
| | `serial-transport.js`, `ble-transport.js` | Backend USB CDC dan BLE NUS, masing-masing memegang state framing sendiri |
| | `connection-manager.js`, `auto-connect-core.js` | Auto-connect/failover USB ⇄ BLE (USB prioritas) |
| Protokol | `protocol-parser.js` | Mem-parse baris dari device (INFO, DUMP, ENC, GEST, EVT, …) |
| | `frame-codec.js`, `frame-transport.js`, `frame-dispatch.js`, `pong-probe.js` | Lapisan frame biner v2 di sisi app |
| | `device-state.js` | Satu sumber kebenaran state device (grid, encoder, gesture, RGB) |
| | `adaptive.js`, `cfg-builder.js`, `cfg-layout.js`, `cfg-sig.js`, `upload-state.js` | Preset adaptif, penyusunan payload, sidik jari, progres upload |
| UI | `home-page.js`, `rgb-page.js`, `soundboard-page.js`, `audio-panel.js` | Halaman utama dan editor |
| | `ui-router.js`, `ui-modal.js`, `ui-notify.js`, `dom.js`, `i18n.js` | Navigasi, modal, notifikasi, helper DOM, terjemahan ID/EN |
| Lain-lain | `battery-ui.js`, `diag-report.js`, `tray.js`, `overlay.js`, `app-picker.js`, `paint-watch.js` | Baterai, diagnosa, tray, overlay, pemilih aplikasi, pengawas repaint |

## Aturan import

Modul **tidak** saling memanggil fungsi satu sama lain secara langsung. Semua
berkomunikasi lewat `initXxx({...})` yang menyuntikkan dependensi. Tujuannya
menghindari siklus import sekaligus membuat setiap ketergantungan terlihat.

`main.js` adalah satu-satunya titik pertemuan antara modul-modul ini.

Semua akses transport lewat `transport.js` (facade). Impor `serial-transport.js`
langsung dari modul lain adalah bug: perintah akan tetap ditulis ke port COM
walau user sudah memilih BLE.

## Alur data singkat

```
UI (home-page/rgb-page)
  -> transport.sendLine()
     -> serial-transport.js  atau  ble-transport.js
        -> firmware (baris ASCII / frame biner)

firmware (baris ASCII / frame)
  -> backend transport (buffer baris milik backend)
     -> protocol-parser.handleLine()
        -> device-state.js  -> UI di-render ulang lewat hook
```

Firmware tidak pernah "menunggu" app. Perintah diproses saat newline diterima,
dan event (`EVT:*`, `[KEY]`) bisa datang kapan saja; parser harus tahan terhadap
event yang menyela dump yang sedang berjalan.

## Empat lapisan firmware

1. **`limits.h`** — pin, jumlah baris/kolom/encoder, `FW_VERSION`, struktur state.
2. **`macropad_core.h`** — perilaku: keymap, encoder, gesture, preset, baterai,
   handler perintah. Tidak tahu pin fisik mana yang dipakai.
3. **Header fitur** (`frame_*`, `cfg_sig`, `rgb_effects`, `transport.h`) — bagian
   yang diuji silang dengan app lewat golden vector.
4. **Sketsh** (`.ino`) — satu-satunya tempat pin map dan inisialisasi peripheral.
   PROTOTYPE dan FINAL hanya berbeda di lapisan ini.

Menambah profil board baru = sketsh baru + `#define` kapabilitas, bukan
menduplikasi logika.

## Build & uji

Lihat [STATUS-AND-TESTING.md](STATUS-AND-TESTING.md) untuk status verifikasi
terbaru, checklist hardware, dan perintah build.
