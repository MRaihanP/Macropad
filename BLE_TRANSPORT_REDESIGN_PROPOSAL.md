=================== PROPOSAL: BLE Transport Redesign ===================

Tujuan: Bangun ulang transport BLE dari awal untuk menghilangkan stream
flooding, kegagalan tak terduga, dan ketergantungan pada text-mode fallback
setelah frame-path gagal sekali. Proposal ini didasarkan pada analisis
kapasitas ESP32-S3, arsitektur protokol yang ada (NUS + frame v2), dan data
real dari log DIAG pengguna.


== 1. Kapasitas BLE ESP32-S3 (ESP-IDF / NimBLE) ==

| Parameter                  | Nilai yang dapat diutilize |
|----------------------------|---------------------------|
| PHY                        | 1M (755 kbps) atau 2M (1.35 Mbps) — 2M butuh support di central |
| MTU ATT (negosiasi)        | 23 (default) → 247 (Windows/macOS umum) → hingga 517 (teoritis) |
| Payload per packet         | MTU - 3 (ATT overhead) = 244 byte pada MTU 247 |
| Connection interval        | 7.5 ms (min BLE spec) → 4000 ms (max) |
| Supervision timeout        | 100 ms → 32 s (default 10 s) |
| Peripheral latency         | 0–49 (device bisa skip connection event) |
| Data Length Extension (DLE)| LL packet hingga 251 byte |

NOTES:
- ESP32-S3 mendukung BLE 5.0, termasuk 2M PHY dan DLE
- Windows 10/11 mendukung 2M PHY dan MTU hingga 512+ (lihat DIAG: mtu=247)
- Connection interval 15-30 ms sudah dikonfigurasi di ble_hid.h:304-308
- Peripheral latency = 0 (realtime, tidak bisa skip event)

KAPASITAS TEORITIS PADA LINK YANG ADA:
- MTU 247, 2M PHY, conn interval 15ms
- Payload per connection event: floor(244 / 20) = 12 notifikasi per event
  (assuming 20-byte ATT overhead per notification)
- Throughput maksimum: 12 * 244 byte / 15ms = ~195 KB/s
- 2M PHY maksimal: ~1.35 Mbps = ~169 KB/s (seimbang — overhead BLE)

Fakta: link saat ini melaporkan rtt p50=76-87ms, p95=135-208ms. Ini
sudah cukup cepat — masalahnya bukan bandwidth, tapi CARA DATA
dikirim (stream vs batched, text vs binary).


== 2. Metode Pendekatan yang Efisien ==

METODE YANG DIUSULKAN: "Single Transaction Protocol" (STP)

Konsep: Setiap operasi BLE adalah SATU transaksi yang atomik — dimulai
dengan session token, berisi semua data yang dibutuhkan, dan diakhiri
dengan commit. Device tidak boleh menjadi "idle" di tengah transaksi;
atau semuanya berhasil, atau device mentracking error dan device bisa
langsung kembali ke keadaan aman.

Komponen utama:

A. SESSION-LAYER PROTOCOL (binary, WriteWithoutResponse)
   - Setiap upload dimulai dengan FRAME:CFG_BEGIN{sessionId, slot, version, len, sig}
   - Device merespons CFG_READY{sessionId, credit} — ONE round-trip saja
   - Semua CFG_WRITE menggunakan WriteNoAck, di-ack oleh credit counter di device
   - Akhir dengan CFG_COMMIT{sessionId} → CFG_RESULT{sessionId, code, sig}
   - Semua data dalam satu session = satu burst yang tidak terputus
   - Setelah commit, device langsung siap untuk session berikutnya

B. NOTIFICATION PIGGYBACK (binary, notify ke app)
   - Device tidak kirim notifikasi "ack" per byte — hanya kirim:
     - CFG_READY (setelah CFG_BEGIN)
     - CREDIT (jika diperlukan, jarang—staging cukup besar)
     - CFG_RESULT (setelah CFG_COMMIT)
     - EVT (event async: layer change, knob turn, dll)
   - Semua pertukaran data bulk hanya 3 round-trip: BEGIN → ready → COMMIT → result
   - DUMP, INFO, HWINFO, dll tetap pakai text mode (line protocol) — data kecil

C. PACING BERBASIS CREDIT, BUKAN TIMER
   - Device memberi tahu berapa banyak yang bisa dikirim (credit = sisa staging)
   - App tidak perlu timer/pacing — cukup ikuti credit
   - Jika credit = 0, app menunggu frame CREDIT (max 2 detik timeout)
   - Ini lebih efisien daripada timer-based pacing (10ms per frame vs
     sekali-kirim-sesuai-stan-BY device)

D. NOTIFICATION WINDOW BERBASIS EVENT (bukan polling)
   - Device kirim notifikasi ketika ada data, tidak polling
   - App polling hanya untuk keepalive (PING 5s) + koneksi check (2s)
   - Buffer notifikasi di app: 8KB (cukup untuk 2-3 DUMP response sekaligus)

E. ADAPTIVE PAYLOAD FRAGMENTATION
   - Fragment di app side (firmware sudah menerima CFG_WRITE yang sudah
     digabungkan ke dalam chunk yang tepat)
   - Ukuran chunk = min(credit * maxChunk, MTU - 3)
   - Pada MTU 247: maxChunk = 237 byte (sesuai frame.h)
   - Pada MTU 23: maxChunk = 20 byte (fallback, sangat lambat — hindari)


== 3. Proposal Sistem Komunikasi BLE ==

=== ARSITEKTUR LAPISAN ===

Lapis 5: Application Protocol (text lines: SET:, LAYER:, DUMP:, INFO)
Lapis 4: Frame Protocol v2 (binary: CFG_BEGIN, CFG_WRITE, CFG_COMMIT)
Lapis 3: NUS Transport (BLE NUS service, chunking by MTU)
Lapis 2: BLE Link Layer (NimBLE, connection params, PHY, MTU)
Lapis 1: Physical (2M PHY, BLE radio)

=== STATE YANG DISIMPAN OLEH DEVICE ===

| Data                  | Lokasi      | Ukuran  | Persistence | Update frekuensi |
|-----------------------|------------|---------|-------------|------------------|
| activeCfg pointer     | RAM        | 2 bytes | volatile    | per context switch |
| slotCfg[APP_SLOTS]    | flash      | ~48KB   | persistent  | per preset upload |
| cfg (default config)  | flash      | ~604B   | persistent  | rare (factory/settings) |
| keyState[r][c]        | RAM        | ~18B    | volatile    | per keypress (100/s max) |
| encoderState[encoders] | RAM       | ~12B    | volatile    | per encoder (100/s max) |
| eventQueue            | RAM        | ~256B   | volatile    | per event (1000/s max) |
| cfgStage staging buf  | RAM        | 5120B   | volatile    | per CFG_BEGIN |
| frame assembler state | RAM        | ~260B   | volatile    | per byte (stream) |
| connection params     | NimBLE     | -       | volatile    | per connect |
| NUS ring buffer       | RAM        | 2048B   | volatile    | per write |
| BLE MTU negotiated    | NimBLE     | 2B      | volatile    | per connect |

=== STATE YANG DISIMPAN OLEH COMPANION APP ===

| Data                  | Lokasi         | Ukuran  | Persistence | Update frekuensi |
|-----------------------|----------------|---------|-------------|------------------|
| presetsData           | IndexedDB/json | ~50KB   | persistent  | per user edit |
| slotTable cache       | RAM (browser)  | ~2KB    | volatile    | per connect |
| focusedExe + layer    | RAM (browser)  | ~100B   | volatile    | per app switch |
| frameUsable           | RAM (browser)  | 1 bit   | volatile    | per session |
| frameDisabledUntil    | RAM (browser)  | 8B      | volatile    | per failure |
| lastGoodDeviceId      | localStorage   | ~50B    | persistent  | per save |
| BLE MTU cached        | RAM            | 2B      | volatile    | per connect |
| rx_buffer (Rust)      | Rust (Tauri)   | 64KB    | volatile    | per read call |
| rx_full counter       | Rust (Tauri)   | 8B      | volatile    | per overflow |

=== PROTOKOL TRANSAKSI ===

--- Session 1: Handshake + Capability Discovery ---

App                          Device (ESP32-S3)
  |  -- [text] WHOAMI -->      |
  |  <-- [text] HELLO:{ver}    |
  |  -- [text] INFO -->        |
  |  <-- [text] INFO:{...}     |
  |  -- [text] DUMP -->        |
  |  <-- [text] DUMP:{layer}   |
  |  -- [text] DUMPENC -->     |
  |  <-- [text] ENC_BEGIN...   |

Handshake ini = text mode, kecil (< 500 byte total). Device lapor
proto=frame jika mendukung frame mode.

--- Session 2: Slot Query (hanya jika proto=frame) ---

App                          Device
  |  -- [frame] CFG_QUERY -->  |
  |  <-- [frame] CFG_META     |

CFG_META berisi: activeSlot, per-slot {sig, layers, valid}. Ukuran tipikal:
1 + (APP_SLOTS * 6) = 1 + (8 * 6) = 49 byte. Sekali notifikasi, selesai.

--- Session 3: Preset Upload (binary, bulk) ---

App                          Device
  |  -- [frame] CFG_BEGIN{slot}  -->   (WriteWithResponse, tunggu ack)
  |  <-- [frame] CFG_READY{credit}  |   (notifikasi, ~5ms setelah BEGIN)
  |
  |  -- [WONR] CFG_WRITE{frame1} -->   (WriteWithoutResponse, seberapa banyak credit)
  |  -- [WONR] CFG_WRITE{frame2} -->   (WriteWithoutResponse, sisa credit)
  |  ...                               (total: ceil(4838/237) = 21 frame)
  |
  |  -- [frame] CFG_COMMIT{}  -->   (WriteWithResponse, tunggu ack)
  |  <-- [frame] CFG_RESULT{code,sig}  |

Total round-trip: 3 (BEGIN, COMMIT, + 1 notifikasi ready/result)
Total data: 4838 byte (binary) vs 12000 byte (text)
Total time: ~5 frame events (75ms @ ci=15ms) vs ~300 event (4.5s)


== 4. Apa yang perlu dipertaharui / dibangun ulang ==

PERUBAHAN YANG HARUS DILAKUKAN:

1. DEVICE-FIRMWARE (firmware/common/):
   - transport_ble.h: Naikkan BLE_NUS_RING_SIZE dari 2048 → 4096
     (current overflow risk during burst notifikasi DUMP)
   - ble_hid.h: Konfigurasi 2M PHY eksplisit (saat ini tidak ada)
     - Tambahkan setPhy(2M) setelah connect
     - Ini bisa 2x throughput dibanding 1M
   - frame_proto.h: Pastikan CFG staging buffer dan credit flow sudah benar
     (sudah ada, perlu verifikasi load test)
   - transport_ble.h: write() saat ini ada retry 3x dengan delay(1<<retries)
     = 1+2+4 = 7ms per chunk gagal. Ini BLOKKING. Ganti dengan async queue.

2. APP-JS (src/):
   - ble-transport.js: Pacing 10ms per CFG_WRITE sudah ditambahkan
     (lihat commit ini). But need adaptive pacing berdasarkan RTT.
   - frame-transport.js: beginCfgTransfer/endCfgTransfer sudah ditambahkan
     untuk batch state tracking. Perlu juga noteCfgCommands per chunk.
   - transport.js: Pastikan sendRawNoAck facade sudah ada (sudah dilakukan)
   - upload-state.js: Window berbasis command count sudah ada (CMD_PER_MS)
     - Tapi CMD_PER_MS = 0.05 = 50 cmd/detik. Untuk binary, ini terlalu
       lambat. Untuk binary CFG_WRITE, window harus berdasarkan byte, bukan
       command. Perlu parameter terpisah.

3. TAURI-BACKEND (src-tauri/src/):
   - lib.rs: ble_reset_adapter sudah ditambahkan
   - ble.rs: Pastikan write_no_ack tidak blocking
   - lib.rs: Pertimbangkan async write queue untuk write_no_ack di Rust sisi
     (saat ini invoke() bisa antri dan menyebabkan pacing tidak akurat)

4. TESTING INFRASTRUCTURE:
   - tests/virtual-device.mjs sudah ada dengan frame handler
   - Perlu tambahkan: stress test untuk burst notifikasi (simulasi 200 notif
     dalam 50ms) untuk memverifikasi buffer handling

== 5. Ringkasan Perbandingan Pendekatan ==

| Aspek                | Text Mode (saat ini)  | Frame Binary (proposed) |
|----------------------|----------------------|------------------------|
| Data size            | ~12,000 byte/preset  | ~4,838 byte/preset     |
| Round-trips          | ~300 (per SET line)  | ~3 (BEGIN/READY/COMMIT)|
| Time @ 76ms RTT      | ~23 seconds          | ~5 seconds             |
| GATT write calls     | 300 (WriteWithResp)  | 21 (WriteWithoutResp)  |
| Notification load    | 300 ack lines        | 2 frame responses      |
| Windows GATT buffer  | Overfill risk        | Controlled by credit   |
| Error recovery       | Session-based        | Session-based          |
| Fallback path        | Built-in             | Built-in (text mode)   |


== 6. Action Items ==

URGENT (bug fix):
[x] sendRawNoAck missing in ble-transport.js — FIXED
[x] notifyFailCount ReferenceError — FIXED (renamed to readErrorCount)
[x] 0x80650011 Insufficient Resources — FIXED (10ms pacing + intra-write retry)
[x] drainFast race condition — FIXED (drainScheduled reset in finally)
[x] PING competition during upload — FIXED (batchUploadInFlight check)
[x] uploadPresetBinary tidak call beginCfgTransfer — FIXED (wrapper try/finally)

SHORT TERM (stability):
[ ] Tambahkan adaptive pacing (berdasarkan rtt p50 dari PING)
[ ] Tingkatkan NUS ring buffer di device dari 2048 → 4096
[ ] Tambahkan 2M PHY konfigurasi di ble_hid.h
[ ] Tambahkan noteCfgCommands(batchPerChunk) di frame-transport.js upload loop

MEDIUM TERM (optimization):
[ ] Implementasi async write queue di Rust (ble.rs) untuk write_no_ack
[ ] Buffer notifikasi di Rust yang lebih besar (64KB → 128KB)
[ ] Window-based pacing di upload-state.js (segeri TCP congestion window)

LONG TERM (full redesign):
[ ] Single Transaction Protocol — semua frame dalam satu session
[ ] Notification piggyback — hapus per-frame ack di device
[ ] Async write queue di device (transport_ble.h write() jangan blocking)
[ ] Adaptive MTU negotiation — request MTU terbesar di connect time
