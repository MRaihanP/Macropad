# PLAN: Migrasi Protokol Companion App → Frame Biner (A) + CFG_SIG (B) + Credit Flow Control (C)

Status: **Fase 3 SELESAI** (2026-10-17). Fase 0–3 beres; jalur cepat frame hidup
dan sudah diverifikasi di perangkat. Fase 4 (bulk upload) berikutnya.
Target repo: `E:\05_Finish_projects\macropad-configurator`

### Hasil Fase 3 (di repo)

- `src/cfg-layout.js` — konstanta layout yang WAJIB sama dengan
  `firmware/common/limits.h`. Dihasilkan supaya tidak ada angka magis (dulu
  `version: 5` ditulis langsung di `frame-transport.js`, dan `T_CFG_META = 0x93`
  ditulis sebagai literal padahal di firmware diturunkan dari `FA_RESP_BIT`).
  `tests/suites/frame-transport-test.mjs` membandingkannya dengan `limits.h`.
- `src/frame-dispatch.js` — decoder persisten + antrean penunggu per tipe frame.
  Menggantikan model "ganti" yang mematikan parser baris saat ada yang menunggu
  frame, dan menghapus `_pendingFrameData` global yang membuat dua permintaan
  tumpang tindih saling menimpa.
- `src/frame-transport.js` — `sendFrame`, `queryFrameSlots`, `activateFrameSlot`,
  `ensureLineMode`, `presetSig`, `findMatchingSlot`, `findEmptySlot`.
- `src/pong-probe.js` — registry probe PONG, supaya `ensureLineMode()` punya
  bukti nyata device sudah keluar dari mode frame.
- `src/upload-state.js` — `markBatchSettling(4000)` dihapus. Diganti
  `beginCfgTransfer` / `endCfgTransfer` / `noteCfgCommands` dengan jendela
  jawaban yang diturunkan dari jumlah perintah.
- `src/adaptive.js` — fast path: CFG_QUERY → cari slot cocok → CFG_ACTIVATE,
  dengan fallback ke jalur teks yang sudah dirapikan (`activatePresetRuntimeText`).
- `tests/suites/frame-transport-test.mjs` — 93 assertion. Negative test sudah
  dijalankan: mengembalikan bug encoder ke layer pertama, mengembalikan model
  "ganti", dan mengubah `RESP_BIT` masing-masing membuat test gagal.

Bug nyata yang ditemukan test ini (bukan saat menulis, tapi saat menguji):

- `presetSig()` mengumpulkan encoder di dalam loop layer, jadi untuk preset
  beberapa layer hanya entri pertama (layer 0) yang terhitung. Firmware menyimpan
  encoder secara GLOBAL — `SETENC` menulis `activeCfg->encCW[encIdx]` tanpa indeks
  layer, dan `buildPresetLines()` mengirimnya untuk setiap layer berurutan, jadi
  layer TERAKHIR yang menimpa. Akibatnya app menghitung sidik jari dari layer 0
  sementara device melaporkan dari layer terakhir: preset yang sebenarnya sudah
  ada akan selalu dianggap baru. Persis cacat yang CFG_SIG harus hilangkan.

Penyimpangan dari plan yang perlu dicatat:

- Plan menyebut "backend ketiga" di `src/transport.js`. Kenyataannya tidak ada:
  pilihan USB/BLE tetap milik pengguna, dan yang dinegosiasi otomatis adalah
  FORMAT (apakah device bisa frame), lewat percobaan nyata — bukan lewat membaca
  nomor versi firmware. Alasannya tercatat di `frame-transport.js`.
- Plan menyebut `batchUploadInFlight()` jadi "credit-based". Credit flow control
  sendiri adalah Fase 5, dan CFG_RESULT yang menandai transfer selesai juga
  Fase 4. Jadi di Fase 3 yang bisa dihilangkan adalah tebakan waktu konstanta,
  diganti state eksplisit + jendela yang diturunkan dari pekerjaan nyata. Sisa
  ketidakpastian itu dicatat terbuka di header `src/upload-state.js`.
- `tests/virtual-device.mjs` dan `tools/ble-diag.js` (bagian 3 dan 6 strategi
  testing) BELUM ada.

### Hasil Fase 0 (yang sudah ada di repo)

- `firmware/common/diag.h` (baru) — penghitung L3 + perintah `DIAG` / `DIAG:ZERO`.
- `firmware/common/ble_shared.h` — counter `bleNusPushDropped`, `bleNusRingHigh`, `bleNusNotifyOk/Fail/Chunk/Retry`, `bleNusWriteNoConn/NoSub`, `bleNusMtu()`. `bleNusPush()` tidak lagi membuang byte diam-diam.
- `firmware/common/transport_ble.h` — `protoDiagMedia()` (baris `DIAGMEDIA:`) + hook `PROTO_DIAG_MEDIA/RESET`.
- `firmware/common/ble_hid.h` — `bleNusMtu()`.
- `firmware/common/macropad_core.h` — counter L3, `protoLastCmd`, `DIAG` dicek sebelum `PROFILE_TRY_COMMAND`.
- `src-tauri/src/ble.rs` — `BleStats` (notify/read/write/rx_dropped/overflow), overflow dilaporkan bukan dibuang diam-diam, `stats()`.
- `src-tauri/src/lib.rs` — command `ble_stats`.
- `src/diag-report.js` (baru) — modul murni: `parseKV`, `num`, `rttSummary`, `diagVerdict`, `renderDiag`, `diagHasFailure`.
- `src/ble-transport.js` — sadar `DIAG:`/`DIAGMEDIA:`/`PONG`, kirim `DIAG` tiap 30 s, cetak blok + vonis di panel log.
- `tests/suites/diag-report-test.mjs` (baru) — 10 kasus fault injection + kontrak firmware/Rust/JS.
- `README.md` — dokumentasi `DIAG`.

Verifikasi: `npm test` 36/36 hijau · `cargo test` 9/9 lolos · `arduino-cli compile` kedua profil sukses.

## Prinsip utama

1. **Jangan ganti transport.** NUS + NimBLE + WinRT sudah benar. Yang dibongkar hanya formatnya.
2. **Deteksi dulu, baru memperbaiki.** Fase 0 hanya menambah penghitung dan laporan berlapis — tidak mengubah perilaku apa pun. Semua keputusan fase berikutnya diambil dari data fase 0.
3. **Setiap lapis bisa diuji tanpa hardware**, dan setiap alarm punya *negative test* yang membuktikan alarm itu benar-benar menyala saat fault disuntikkan. Jadi "tidak ada alarm" berarti sesuatu, bukan "tes tidak jalan".

---

## Fase 0 — Instrumentasi & laporan berlapis (tidak mengubah protokol)

Tujuan: setiap fault dapat ditentukan lapis mana penyebabnya, pada kode yang sekarang.

| File | Perubahan |
|---|---|
| `firmware/common/ble_diag.h` | Penghitung: `notifyFail`, `crcErr`(0), `seqGap`(0), `rxOverrun`, `lineTooLong`, `mtuNow`, `creditStall`(0) |
| `firmware/common/macropad_core.h` | Perintah baru `DIAG` → `DIAG:mtu=…,notify_ok=…,notify_fail=…,rxOverrun=…,lineTooLong=…,heap=…` |
| `firmware/common/ble_shared.h` | `bleNusAvailHighWater()`, `bleNusPushDropped()` — push gagal (ring penuh) dihitung, bukan `break` diam-diam |
| `src-tauri/src/ble.rs` | `RX_BUFFER_MAX` tidak lagi membuang byte tertua diam-diam → counter + flag, dilaporkan ke frontend |
| `src-tauri/src/lib.rs` | Command baru `ble_stats` |
| `src/ble-transport.js` | Blok "Diagnostik" di panel log; kirim `DIAG` tiap 30 detik saat polling |

Format laporan:

```
=== DIAG 2026-10-16 14:22:07 ===
L0 RADIO   rtt p50=18ms p99=41ms  mtu=247  reconnect=0
L1 LINK    write=1.204  notifyRx=9.831  rxOverflow=1 (20.480B DIBUANG, dilaporkan)
L2 FRAME   framesRx=1.204  crcErr=0  seqGap=0  overlong=0     <- belum ada, selalu 0 di fase ini
L3 PROTO   lines=9.831  lineTooLong=0  parseErr=0  resync=0
L4 DEVICE  notifyFail=3  mtuDrop=0  heap=112.480  lastCmd=WHOAMI
```

---

## Fase 1 — Codec frame + golden vectors (tanpa perubahan kabel)

```
[SOF 0xA5][VER 0x02][TYPE u8][LEN u16][PAYLOAD …][CRC16 u16]   CRC16/CCITT-FALSE
```

Payload maks = `MTU-3-7` ≈ 237 B.

| Kode | Frame | Arah |
|---|---|---|
| `0x01` | `HELLO{proto u8, fw u8, maxPayload u16}` → `HELLO_RSP` | app→fw |
| `0x02` | `LINE{}` escape hatch (protokol lama tetap bisa lewat) | dua arah |
| `0x10` | `CFG_BEGIN{slot u8, layerCount u8, totalLen u32}` | app→fw |
| `0x11` | `CFG_WRITE{seq u16, bytes …}` | app→fw |
| `0x12` | `CFG_COMMIT{crc32 u32}` → `CFG_RESULT{code u8, appliedSig u32}` | app→fw |
| `0x13` | `CFG_QUERY{}` → `CFG_META{slotTable[6]{sig u32, layers u8, valid u8}, currentLayer u8}` | app→fw |
| `0x14` | `CFG_ACTIVATE{slot u8}` → `CFG_ACT_RSP{appliedSig u32}` | app→fw |
| `0x20` | `EVT{kind u8, …}` pengganti `EVT:*`/`[KEY]`/`[LAYER]` | fw→app |
| `0x7F` | `ERR{code u8, where u8}` | dua arah |

Kode error wajib: `BAD_SOF`, `BAD_VER`, `BAD_CRC`, `LEN_OVERFLOW`, `SEQ_GAP`, `SEQ_DUP`, `NO_SESSION`, `CREDIT_EXHAUSTED`, `STAGING_FULL`, `CRC32_MISMATCH`, `UNSUPPORTED`.

Berkas baru:
- `firmware/common/frame.h` — header + CRC16, murni tanpa Arduino (bisa diuji native di host)
- `firmware/common/frame_asm.c` — state machine perakit: `faFeed(byte)`, `faNextFrame()`, emit event dengan nilai konkret
- `src/frame-codec.js` — decoder JS mirror
- `src-tauri/src/frame.rs` — decoder Rust mirror
- `tools/gen-vectors.mjs` — **satu-satunya sumber kebenaran** → `tests/vectors/frames.jsonl`

`CFG_SIG` = **CRC-32/ISO-HDLC (zlib)** atas representasi kanonik config, bukan raw struct (padding). Sama persis di JS, Rust, C++.

---

## Fase 2 — Firmware dual-mode + CFG_SIG (bagian B)

Berkas: `macropad_core.h`, `ble_hid.h`, kedua `.ino`.

- Auto-detect: byte pertama `0xA5` + `VER 0x02` → mode frame; selain itu jalur `checkSerialInput()` sekarang.
- `WHOAMI` menambah `proto=v2`.
- `CFG_QUERY` mengembalikan tanda tangan 6 slot; `CFG_ACTIVATE{slot}` mengembalikan `appliedSig`.
- `cfgSig(activeCfg)` = CRC32 atas kanonik (`layerCount`, nama layer, semua `type`+`value` ternormalisasi, encoder, `currentLayer`).

Markup B di app: hapus `slotTable` + `presetSig` di `adaptive.js` (~baris 500–563). `activatePresetRuntime()` → `CFG_QUERY` → cari slot cocok → `CFG_ACTIVATE`, kalau tidak upload ke slot LRU.
Fallback: `proto=v1` → kembali ke `buildPresetLines()`.

### Status Fase 2b — SELESAI (2026-10-17)

Firmware (Fase 2): sudah ada sejak commit `cd2f31a` — dual-mode parser, `WHOAMI` dengan `proto=frame|line`, `CFG_QUERY`→`CFG_META`, `CFG_ACTIVATE`→`CFG_ACT_RSP`, `cfgSig()` CRC32/ISO-HDLC.

App (Markup B — apa yang diselesaikan):

| Berkas | Perubahan |
|---|---|
| `src/frame-codec.js` | Decoder frame v2: `encode()`, `FrameDecoder` (push bytes, emit events) |
| `src/frame-dispatch.js` (baru) | Registry handler data biner — putihkan dependency cycle: `transport.js → serial/ble → frame-transport.js → transport.js` |
| `src/frame-transport.js` (baru) | `sendFrame()`, `queryFrameSlots()`, `activateFrameSlot()`, `presetSig()`, `findMatchingSlot()`, `findEmptySlot()`, `deviceSupportsFrame()`. Pakai single-shot decoder + timeout 2 s per request |
| `src/transport.js` | Facade export `sendRaw`, `isConnected`, lifecycle hooks (`setOnLine`, `setFrameDataHandler` via `frame-dispatch.js`) |
| `src/serial-transport.js` | Parse `onLine` → check `getFrameDataHandler()` → route byte ke decoder frame; `sendRaw` mengganti `writeRaw`; `writeRaw` dipertahankan sebagai alias backward-compat |
| `src/ble-transport.js` | Sama — `writeRaw`→`sendRaw`, alias `writeRaw = sendRaw` |
| `src/protocol-parser.js` | Parse `proto=` dan `frame=` dari WHOAMI ke `deviceProfile` |
| `src/adaptive.js` | `activatePresetRuntime()` cek `deviceSupportsFrame` → fast path `CFG_QUERY`→`findMatchingSlot`→`CFG_ACTIVATE`; fallback ke `buildPresetLines()` text mode |
| `src/main.js` | `getDeviceProfile: () => deviceProfile` di hooks `initAdaptive` |
| `src/locales/en.js`, `src/locales/id.js` | String i18n: `adaptive.cache`, `adaptive.frameActivateFail`, `adaptive.frameQueryFail`, `adaptive.presetActiveLog`, `adaptive.presetNotif` |

Fallback teks utuh: jika `proto=line` atau query/activate gagal, `activatePresetRuntime()` secara otomatis turun ke jalur `buildPresetLines()` + `sendBatch()` yang sudah ada sebelumnya. Device tidak pernah terjebak di mode frame — `sendLine('')` kirimkan setelah `CFG_ACTIVATE` sukses untuk switch kembali ke line mode.

Verifikasi: `npm test` 40/40 hijau termasuk `frame-codec-test`, `layer-hold-test`, `no-lost-functions-test`, `parser-wiring-test`, `serial-transport-test`, `ble-transport-test`.

---

## Fase 3 — Fast path & pembuktian lewat signature

- `src/frame-transport.js` — kontrak `transport.js` yang sama, berbasis frame
- `src/transport.js` — backend ketiga; pemilihan backend jadi **negosiasi** (`HELLO` → fallback), bukan tebakan
- `src/adaptive.js` — fast path; hapus `markBatchSettling(4000)` dan accommodation antrean
- `src/upload-state.js` — `batchUploadInFlight()` berubah makna: dari "antrean belum selesai" → "transfer CFG berjalan" (credit-based, bukan tebakan waktu)

---

## Fase 4 — Bulk upload (bagian A)

Layout payload (LE, tanpa padding):

```
u8 version, u8 layerCount
× layer: char name[16]
         × 9 key: u8 type, char value[48]
         × NUM_ENCODERS: {CW, CCW, BTN} → u8 type + char value[48]
u32 crc32 (dari seluruh byte sebelumnya)
```

Ukuran: 1 encoder ≈ **4,8 KB**, 3 encoder ≈ **7,2 KB** → **32 frame** @237 B.
Jalur lama: ~600 baris `SET:` ≈ 21 KB keluar **+ 21 KB `[OK]` kembali = ~42 KB**. Reduksi **~20×**, tanpa `[OK]` per tombol.

Firmware: staging buffer (`heap_caps_malloc`, 8 KB) + state `STAGING`. `CFG_COMMIT` verifikasi CRC32 → wajib `CFG_ACTIVATE` sebelum aktif. Disconnect/boot di tengah transfer → staging dibuang (tidak ada config setengah jadi). `SAVE`/`LOAD`/`RESET` tetap.

App: builder payload biner + validasi CRC sebelum `CFG_COMMIT`.

---

## Fase 5 — Credit flow control (bagian C)

- `CFG_BEGIN` → `CFG_READY{credit u16}` (staging 8 KB + buffer coalisi)
- Tiap `CREDIT(bytes u16)` menambah jatah; `creditStall` kalau gap ack > 500 ms
- `CFG_WRITE` dikirim **WriteWithoutResponse**; frame kontrol tetap **WriteWithResponse**
- Credit hanya naik saat ruang staging benar-benar ada (kalau tidak → penumpukan diam-diam di device)

---

## Fase 6 — Pembersihan

Hapus `buildPresetLines`, `slotTable`, watchdog `DUMP_STUCK_MS`, pathway `SET:` dari app. Jalur line tetap di firmware sebagai diagnostic escape hatch (`0x02 LINE`). Update dokumentasi protokol di README + `tests/suites/readme-protocol-test.cjs`.

---

# Strategi testing: memastikan di bagian mana masalahnya

## 1. Codec lintas bahasa (L0)
`tests/vectors/frames.jsonl` dibaca tiga runner: `tests/suites/frame-codec-test.mjs`, `#[test]` di `src-tauri/src/frame.rs`, `tests/suites/frame-asm-native-test.js` (kompilasi `frame_asm.c` di host — pola `firmware-compile-guard-test.js`). Vektor valid + vektor harus-ditolak dengan kode error tertentu. Verdict identik di ketiganya.

## 2. Codec fuzz (L0)
200k byte acak, bit-flip, truncasi, frame terpotong di tengah `LEN`/`CRC`. Decoder wajib menolak dengan `BAD_CRC`/`LEN_OVERFLOW` — tidak boleh diam-diam menghasilkan payload.

## 3. Transport loopback + fault injection (L1–L3)
`tests/virtual-device.mjs` — perangkat BLE simulasi yang benar-benar menjalankan `frame_asm` (bukan mock asal balas).

| `--inject` | Alarm yang HARUS menyala |
|---|---|
| `drop-notify` | L1 → `notifyRx` turun, `CFG_COMMIT` timeout (bukan blamed ke frame) |
| `corrupt-byte` | L2 → `crcErr` pada frame/seq tertentu |
| `reorder` | L2 → `seqGap`/`seqDup` |
| `stall-credit` | L3 → `creditStall`, host berhenti (bukan menumpuk) |
| `small-mtu` | L1 → chunk dipecah berbeda, tes batas payload |
| `slow-device` | L1 → latensi, tes handshake/watchdog |

Setiap fault punya negative test yang asserts alarm menyala.

## 4. Rust unit test tanpa hardware (L1)
Trait GATT fake: `write_chunking_uses_negotiated_mtu`, `read_bulk_never_drops_bytes`, `rx_overflow_is_reported_not_silent` (regresi "buang byte tertua"), `disconnect_clears_cccd`, `is_connected_reads_live_status`.

## 5. Firmware assembler native (L2/L3)
`frame_asm.c` bebas Arduino → diuji di host: frame terbelah di setiap byte, frame glued, credit habis di tengah, CRC rusak, `LEN` monster.

## 6. Diagnostik on-device
`node tools/ble-diag.js --scenario=full-preset` → tabel verdict per lapis, menyebut frame/urutan byte pertama yang gagal:

```
L0 RADIO   OK    rtt p50=18 p99=41   mtu=247
L1 LINK    OK    write=1.204 notify=9.831 rxOverflow=0
L2 FRAME   FAIL  crcErr=1  pada frame #44 seq=44 (payload 237B, byte ke 118)
L3 PROTO   SKIP  tidak dijalankan karena L2 FAIL
L4 DEVICE  WARN  notifyFail=0 heap=112.480
```
`--inject=<nama>` memverifikasi tiap detektor benar-benar bisa menyala.

## 7. End-to-end pada device nyata (opsional, butuh perangkat)
Satu skenario per lapis. Syarat lulus: tidak ada alarm di semua lapis selama 50 siklus penuh.

---

## Mitigasi risiko

| Risiko | Mitigasi |
|---|---|
| Breaking device lama | Dual-mode auto-detect + `proto=` di `WHOAMI`; jalur lama selalu ada |
| Regresi upload cepat | `CFG_FASTPATH=0` build flag + fallback otomatis di app |
| CRC32 berbeda antar bahasa | Golden vectors; test silang wajib hijau |
| Firmware rewel | `firmware-compile-guard-test.js` menjaga; jangan dihapus |
| Device lama masih dipakai user | Fase A/B/C bertahap; tidak ada yang menghapus jalur lama sampai fase 6 |

Estimasi: fase 0–1 ≈ 2 hari · fase 2–3 ≈ 3 hari · fase 4 ≈ 2 hari · fase 5 ≈ 1–2 hari · fase 6 + dokumentasi ≈ 1 hari.
