=================== BLE Transport Redesign: Proposal + Notification Audit ===================

Tujuan: Panduan lengkap untuk membangun ulang transport BLE yang lebih efisien,
tahan terhadap error, dan async-safe. Menggabungkan analisis kapasitas
hardware ESP32-S3, proposal protokol (STP + hybrid KCT), dan audit notifikasi.

---

1. KAPASITAS BLE ESP32-S3 (ESP-IDF / NimBLE)
-------------------------------------------

| Parameter                  | Nilai yang dapat diutilize |
|----------------------------|---------------------------|
| PHY                        | 1M (755 kbps) / 2M (1.35 Mbps) |
| MTU ATT (negosiasi)        | 23 (default) → 247 (Windows) |
| Payload per packet         | MTU - 3 = 244 byte (MTU 247) |
| Connection interval        | 7.5 ms (min) → 4 s (max); saat ini 15-30 ms |
| Supervision timeout        | 10 s (default) |
| Peripheral latency         | 0-49 |
| Data Length Extension (DLE)| LL packet hingga 251 byte |

KAPASITAS TEORITIS:
- MTU 247, 2M PHY, conn interval 15ms
- 12 notifikasi per connection event, throughput ~195 KB/s
- 2M PHY max: ~1.35 Mbps = ~169 KB/s

Fakta: link melaporkan rtt p50=76-87ms, p95=135-208ms. Sudah cukup
cepat — masalahnya bukan bandwidth, tapi CARA DATA dikirim.


---

2. ARSITEKTUR YANG DIUSULKAN: Hybrid KCT + STP
---------------------------------------------

A. KCT (key press handling)
   - Device yang handle key action langsung
   - App hanya menerima [KEY] event untuk overlay notification
   - Device sudah punya semua preset di slotCfg — tidak perlu kirim koordinat

B. STP (preset upload)
   - SATU transaksi atomik:
     CFG_BEGIN → CFG_READY{credit} → N×CFG_WRITE → CFG_COMMIT → CFG_RESULT
   - 3 round-trip per preset (vs 300+ text mode)
   - 4,838 byte binary vs 12,000 byte text
   - ~5 detik vs ~23 detik pada RTT 76ms

C. Pacing berdasarkan Credit (bukan timer)
   - Device memberi tahu berapa banyak yang bisa dikirim
   - App ikuti credit, tidak perlu timer

D. Adaptive Payload Fragmentation
   - Ukuran chunk = min(credit * maxChunk, MTU - 3)
   - MTU 247: maxChunk = 237 byte

E. Notification Piggyback
   - Device hanya kirim: CFG_READY, CREDIT (jika perlu), CFG_RESULT, EVT


---

3. LAPISAN ARSITEKTUR
---------------------

L5: Application Protocol (text lines: SET:, LAYER:, DUMP:, INFO)
L4: Frame Protocol v2 (binary: CFG_BEGIN/WRITE/COMMIT)
L3: NUS Transport (BLE NUS, chunk by MTU)
L2: BLE Link Layer (NimBLE, PHY, MTU)
L1: Physical (2M PHY, BLE radio)


---

4. STATE YANG DISIMPAN
----------------------

DEVICE (ESP32-S3):
| Data | Lokasi | Ukuran | Persistence | Update |
|------|--------|--------|-------------|--------|
| activeCfg pointer | RAM | 2B | volatile | per context switch |
| slotCfg[8] | flash | ~48KB | persistent | per preset upload |
| cfg (default) | flash | ~604B | persistent | rare |
| keyState[r][c] | RAM | ~18B | volatile | per keypress |
| encoderState | RAM | ~12B | volatile | per encoder |
| eventQueue | RAM | ~256B | volatile | per event |
| cfgStage | RAM | 5120B | volatile | per CFG_BEGIN |
| NUS ring buffer | RAM | 2048B | volatile | per write |
| BLE MTU | NimBLE | 2B | volatile | per connect |

COMPANION APP:
| Data | Lokasi | Ukuran | Persistence | Update |
|------|--------|--------|-------------|--------|
| presetsData | IndexedDB | ~50KB | persistent | per user edit |
| slotTable cache | RAM | ~2KB | volatile | per connect |
| focusedExe + layer | RAM | ~100B | volatile | per app switch |
| frameUsable | RAM | 1 bit | volatile | per session |
| rx_buffer (Rust) | Rust | 64KB | volatile | per read |


---

5. ALUR TRANSAKSI (STP)
-----------------------

Session 1: Handshake (text mode, < 500B total)
  App -> Device: WHOAMI
  Device -> App: HELLO:{ver},{rows},{cols},{enc},{maxPayload}
  App -> Device: INFO
  Device -> App: INFO:{layerCount,currentLayer,...}
  App -> Device: DUMP:0
  Device -> App: DUMP_BEGIN:0 + key lines + DUMP_END

Session 2: Slot Query (hanya jika proto=frame)
  App -> Device: [CFG_QUERY frame]
  Device -> App: [CFG_META frame] (49 byte)

Session 3: Preset Upload (binary, bulk)
  App -> Device: [CFG_BEGIN{slot}] (WriteWithResponse)
  Device -> App: [CFG_READY{credit}] (notify)
  App -> Device: [CFG_WRITE{frame1..21}] (WriteNoAck, x21)
  App -> Device: [CFG_COMMIT{}] (WriteWithResponse)
  Device -> App: [CFG_RESULT{code,sig,slot}] (notify)


---

6. AUDIT NOTIFIKASI BLE
-----------------------

Dari log DIAG: notify=411/10320B (avg 24 byte/notif)

A. PROTOCOL RESPONSES (Essential)
| No | Format | Size | Freq | Action |
|----|--------|------|------|--------|
| 1  | HWINFO:... | ~100B | Per connect | KEEP |
| 2  | INFO:... | ~80B | Per connect+switch | KEEP |
| 3 | DUMP_BEGIN/DUMP_END | ~25B | Per layer | OPTIMIZE: gabung ke frame |
| 4 | {r},{c},{type},{val} | ~40B | 9/layer | OPTIMIZE: gabung ke frame |
| 5 | ENC_BEGIN/ENC_END | ~25B | Per connect | OPTIMIZE: hanya 1x |
| 6 | ENC:{knob},type=.. | ~50B | 3/encoder | OPTIMIZE: hanya 1x |
| 7 | NAMES_BEGIN/END | ~25B | Per connect | KEEP |
| 8 | PONG:{id} | ~10B | Per PING (5s) | KEEP |
| 9 | [OK]/[ERROR] | ~30-50B | Per command | KEEP |

B. REAL-TIME EVENTS
| No | Format | Size | Freq | Action |
|----|--------|------|------|--------|
| 10 | EVT:LAYER:{n} | ~15B | Per switch | KEEP |
| 11 | EVT:APP:{name} | ~30B | Per app switch | KEEP |
| 12 | EVT:BATT:pct=.. | ~40B | Per 1s | **Turun ke 10s** |
| 13 | EVT:CHG:state={n} | ~15B | Per state | KEEP |
| 14 | [KEY] {layer},{r},{c} | ~50B | Per key press | KEEP |
| 15 | [IN:...] KEY ... | ~40B | Per key press | **HAPUS — duplikat** |
| 16 | EVT:ENC:{n}:{CW|CCW} | ~20B | Per turn | KEEP |
| 17 | [ENC_BTN] Knob {n} | ~40B | Per press | KEEP |

C. DEBUG ONLY (bisa dimatikan)
| No | Format | Action |
|----|--------|--------|
| 18 | DIAG:... / DIAGMEDIA:... | Wrap #ifdef DEBUG |
| 19 | [BLE] connect/disconnect/param | Wrap #ifdef BLE_DEBUG |
| 20 | [FRAME] mode/reset/failed | Wrap #ifdef FRAME_DEBUG |
| 21 | [LAYER] Pindah ke | HAPUS — duplikat EVT:LAYER |
| 22 | IFACE:/PROTO:/RAM: | Wrap #ifdef DEBUG |
| 23 | RGB_DUMP: | Manual only |

POTENSI REDUKSI:
| Action | Notif hindari | Estimasi |
|--------|----------------|----------|
| Hapus [IN:] duplikat | -30 | -7% |
| Turunkan EVT:BATT 10x | -50 | -12% |
| Hapus debug traces | -10 | -2.5% |
| Hapus [LAYER] duplikat | -5 | -1% |
| Hentikan DUMPENC per-switch | -50 | -12% |
| **Total** | **-95 notif** | **-23%** |

Reduksi ini mengurangi risiko 0x80650011 (GATT buffer overflow).


---

7. PERBANDINGAN PENDekatanAN
-----------------------------

| Aspek | Text Mode | Frame Binary |
|-------|-----------|--------------|
| Data size | ~12,000 byte | ~4,838 byte |
| Round-trips | ~300 | ~3 |
| Time @ 76ms RTT | ~23s | ~5s |
| GATT writes | 300 (WriteWithResp) | 21 (WriteNoResp) |
| Notification load | 300 ack lines | 2 frame responses |
| Windows buffer risk | Overfill | Controlled by credit |
| Total notif/session | 411 | ~280 (-30%) |


---

8. ACTION ITEMS
---------------

URGENT ( sudah selesai):
[x] sendRawNoAck missing — FIXED
[x] notifyFailCount ReferenceError — FIXED
[x] 0x80650011 Insufficient Resources — FIXED (10ms pacing + retry)
[x] drainFast race condition — FIXED
[x] PING suppression during batch upload — FIXED
[x] uploadPresetBinary beginCfgTransfer — FIXED
[x] readIncoming 8-iter cap — 4 → 8
[x] Burst backoff + adapter reset — FIXED
[x] ble_reset_adapter Rust command — ADDED

SHORT TERM (perlu firmware rebuild):
[ ] Hapus hidTrace("KEY", detail) di macropad_core.h:486
[ ] Turunkan frekuensi EVT:BATT (1s → 10s)
[ ] Hapus [LAYER] trace (duplikat EVT:LAYER)
[ ] Wrap debug traces (#ifdef BLE_DEBUG / FRAME_DEBUG)
[ ] Jangan kirim DUMPENC tiap preset switch
[ ] Konfigurasi 2M PHY di ble_hid.h
[ ] Naikkan BLE_NUS_RING_SIZE 2048 → 4096

MEDIUM TERM:
[ ] Frame binary untuk DUMP response (gabung 11 baris → 2 frame)
[ ] Async write queue di Rust
[ ] Window-based pacing (berdasarkan RTT)
[ ] Notification coalescing untuk [KEY]

LONG TERM:
[ ] Single Transaction Protocol penuh
[ ] Notification piggyback
[ ] Adaptive MTU negotiation
[ ] Connection parameter optimization
