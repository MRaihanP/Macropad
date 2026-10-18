=================== BLE NOTIFICATION AUDIT ===================

Audit lengkap semua baris notifikasi yang dikirim device ke companion app,
dikelompokkan berdasarkan urgensi dan apakah bersifat real-time, debug,
atau protocol. Berdasarkan log DIAG dari pengguna:
  notify=411/10320B  →  411 baris notifikasi per sesi BLE


== 1. SEMUA NOTIFIKASI YANG DIKIRIM DEVICE ==

### A. PROTOCOL RESPONSE (Wajib — app meminta)
| No | Format                        | Trigger                 | Ukuran | Frekuensi       |
|----|-------------------------------|-------------------------|--------|-----------------|
| 1  | HWINFO:profile=...,proto=...  | HWINFO command          | ~100B  | Per connect     |
| 2  | INFO:layerCount=...,current...| INFO command            | ~80B   | Per connect + per switch |
| 3  | DUMP_BEGIN:{layer}            | DUMP:{layer} command    | ~15B   | Per layer load  |
| 4  | {row},{col},{type},{value}    | DURING DUMP response    | ~30-50B| 9-27 per layer  |
| 5  | DUMP_END                      | End of DUMP response    | ~10B   | Per layer load  |
| 6  | ENC_BEGIN:count=N             | DUMPENC command         | ~25B   | Per connect     |
| 7  | ENC:{knob},type={type},value  | DURING ENC dump         | ~50B   | 3 per encoder   |
| 8  | ENC_END                       | End of encoder dump     | ~10B   | Per connect     |
| 9  | NAMES_BEGIN                   | DUMPNAMES command       | ~15B   | Per connect     |
| 10 | {slot},{sig},{layers},{valid} | DURING names dump       | ~30B   | 0-8 per connect |
| 11 | NAMES_END                     | End of names dump       | ~10B   | Per connect     |
| 12 | PONG:{id}                     | PING command            | ~10B   | Per PING (5s)   |
| 13 | [OK] {response}              | SET:/CONTEXT:/LAYER cmd | ~30B   | Per command     |
| 14 | [ERROR] {message}            | Invalid command/error   | ~50B   | Rare            |

### B. REAL-TIME EVENTS (Wajib — user interaction feedback)
| No | Format                        | Trigger                 | Ukuran | Frekuensi       |
|----|-------------------------------|-------------------------|--------|-----------------|
| 15 | EVT:LAYER:{n}                 | User layer change       | ~15B   | Per layer switch|
| 16 | EVT:APP:{name}                | App foreground detect   | ~30B   | Per app switch  |
| 17 | EVT:BATT:pct=..,mv=..,chg=..  | Battery report timer    | ~40B   | Per ~1s (period)|
| 18 | EVT:CHG:state={n}             | Charge state change     | ~15B   | Per state change|
| 19 | [KEY] {layer},{row},{col},{type},{value} | Key press | ~40-70B  | Per key press   |
| 20 | [IN:usb/ble] KEY L..R..C..    | Key press trace         | ~40B   | Per key press   |
| 21 | EVT:ENC:{knob}:{CW|CCW}       | Encoder turn            | ~20B   | Per encoder turn|
| 22 | [ENC_BTN] Knob {n}:...        | Encoder button press    | ~40B   | Per button press|

### C. FRAME MODE RESPONSES (Wajib — binary protocol)
| No | Frame type          | Trigger         | Ukuran    | Frekuensi       |
|----|---------------------|-----------------|-----------|-----------------|
| 23 | HELLO_RSP           | HELLO frame     | ~20B      | Per probe       |
| 24 | CFG_READY{credit}   | CFG_BEGIN frame | ~5B       | Per upload      |
| 25 | CREDIT{credit u16}  | Async (rare)    | ~5B       | Only if buffering |
| 26 | CFG_RESULT{code,sig,slot} | CFG_COMMIT | ~8B       | Per upload      |
| 27 | ERR{code}           | On error        | ~2-3B     | On error only   |

### D. DEBUG / DEVELOPMENT ONLY (Bisa dimatikan)
| No | Format                        | Trigger                 | Ukuran | Frekuensi       |
|----|-------------------------------|-------------------------|--------|-----------------|
| 28 | DIAG:lines=..,cmds=..,heap   | DIAG command            | ~120B  | Manual (debug)  |
| 29 | DIAGMEDIA:notifyOk=..         | DIAG command            | ~120B  | Manual (debug)  |
| 30 | [BLE] Connect (handle=...)    | BLE connect event       | ~30B   | Debug trace     |
| 31 | [BLE] Putus (reason=0x...)    | BLE disconnect event    | ~30B   | Debug trace     |
| 32 | [BLE] NUS subscribe (...)     | NUS subscribe           | ~40B   | Debug trace     |
| 33 | [BLE] param diminta: ...      | Conn params request     | ~60B   | Debug trace     |
| 34 | [BLE] ADV GAGAL: ...          | Advertising error       | ~50B   | Debug (errors)  |
| 35 | [FRAME] mode frame/baris      | Frame mode transition   | ~30B   | Debug trace     |
| 36 | [FRAME] reset sesi protokol   | Session reset           | ~35B   | Debug trace     |
| 37 | [FRAME] gagal encode ...      | Frame encode error      | ~40B   | Debug (errors)  |
| 38 | [FRAME] ... gagal terkirim    | Frame send error        | ~50B   | Debug (errors)  |
| 39 | IFACE:link=..conn=..n..       | DIAG command            | ~70B   | Manual (debug)  |
| 40 | PROTO:link=..                 | DIAG command            | ~20B   | Manual (debug)  |
| 41 | RAM:free=..min=..             | DIAG command            | ~30B   | Manual (debug)  |
| 42 | [OK] HID:SELF via ...         | HID config command      | ~20B   | Manual (debug) |
| 43 | [KEY] ... (key press output)  | Key press — DUPLICATE   | ~50B   | Real-time!      |


== 2. ANALISIS: MANFAAT vs NOISE ==

### NOTIFIKASI YANG HARUS DIPERTAHANKAN (PRODUCTION)

**Protocol responses (A):** Semua WAJIB — app butuh ini untuk sync state.
Tapi optimasi: DUMP response bisa digabung menjadi satu frame biner (Fase 5
frame mode), mengurangi 13 baris (DUMP_BEGIN + 9 key + DUMP_END) menjadi
1 frame biner.

**Real-time events (B):** 
- EVT:LAYER (15): Wajib — app perlu tahu layer berubah
- EVT:APP (16): Wajib — app perlu tahu app foreground untuk auto-switch
- EVT:BATT (17): **Bisa dioptimasi** — saat ini kirim tiap ~1s. Turunkan
  ke tiap ~10s, atau hanya saat perubahan signifikan (>5%). App bisa
  polling BATT: command setiap 30s sekalinya.
- EVT:CHG (18): Wajib — state change adalah infrequent
- [KEY] (19): Wajib — app butuh untuk overlay notification
- [IN:...] (20): **DEBUG ONLY** — ini duplikat dari [KEY]. [IN:] adalah
  trace HID, [KEY] adalah protocol event. Keduanya dikirim per key press
  sehingga notifikasi dua kali lipat. Hapus [IN:] di production build.
- EVT:ENC (21): Wajib — encoder turn
- [ENC_BTN] (22): Wajib — encoder button

**Frame responses (C):** Wajib — protokol biner butuh ini

### NOTIFIKASI YANG BISA DIMATIKAN DI PRODUCTION

**Debug traces (D):** Semua bisa dimatikan. Saat ini mereka mengirim
sebanyak notifikasi sekaligus:
- [BLE] Connect/Putus/ADV param — trace startup/teardown
- [FRAME] mode reset/failed — trace frame protocol
- DIAG: dan DIAGMEDIA: — perintah manual debug
- IFACE:/PROTO:/RAM: — perintah manual debug

**Duplikat (43):** [KEY] dan [IN:...] keduanya dikirim untuk setiap
key press. [IN:] adalah HID trace yang sama sekali tidak perlu di
production. Ini DOUBLES key press notification traffic.

**RGB_DUMP (624):** Serialisasi RGB state — ini 1 baris panjang (~100B).
Hanya dipanggil oleh komando DUMPRGB di Serial Monitor. Bukan notifikasi
otomatis. Tapi bila device mengirim RGB_DUMP saat RGB berubah, itu adalah
notifikasi yang tidak perlu — app bisa polling.


== 3. STATUS NOTIFIKASI BERDASARKAN PATTERN DI LOG DIAG ==

Dari log: `notify=411/10320B` — rata-rata 24 byte per notifikasi.

Perkiraan breakdown (berdasarkan kode firmware):
- Handshake (HWINFO+INFO+DUMP+[KEY]*0+DUMPENC+ENC+54 key):
  - 4 lines (HWINFO, INFO, DUMP_BEGIN, DUMP_END for layer 0)
  - 9 DUMP lines (9 keys for 3x3)
  - 1 ENC_BEGIN + 3 ENC lines + 1 ENC_END = 5
  - Total handshake: ~20 lines, ±500B
- Real-time events per session:
  - EVT:BATT: ~60x (1/menit, ~60 menit session)
  - [KEY]+([IN:]): ~30x (user interaksi) × 2 = 60 lines
  - [LAYER]/[EVT:LAYER]: ~10x (layer switching)
  - PONG: ~10x (PING tiap 5s, session ~50s)
- Preset switching:
  - Per switch: DUMP_BEGIN + 9 DUMP + DUMP_END = 11 lines
  - DUMPENC: ENC_BEGIN + 3 ENC + ENC_END = 5 lines (per switch? atau per connect?)
  - EVT:LAYER: 1 line
  - [LAYER]: 1 line (device logs layer change)
- Debug traces:
  - [BLE] connect/disconnect: 2 lines per session
  - [FRAME] traces: 0-few
  - DIAG command: 2 lines (manual)

PERHITUNGAN:
- Handshake: 20 lines
- Real-time (60 BATT + 30 KEY×2 + 10 LAYER + 10 PONG): 110 lines
- Per preset switch: 11 (DUMP) + 5 (ENC) + 2 (LAYER) = 18 lines
- If 10 preset switches: 180 lines
- Debug: 5-10 lines

Total perkiraan: 20 + 110 + 180 + 10 = 320 lines

Faktik: 411 notifikasi. Gap of ~90 — ini dari:
1. [IN:] duplikat di setiap key press (30 × 2 = +30 tambahan)
2. [BLE] connect trace (per reconnect)
3. DUMPENC yang dikirim tiap switch (bukan hanya per connect)
4. [KEY] juga dikirim saat dump berjalan (interleaved)

OPTIMIZATION POTENTIAL:
- Hapus [IN:] trace: -30 notifikasi (-7%)
- Turunkan EVT:BATT frekuensi: -50 notifikasi (-12%)
- Hapus debug traces: -10 notifikasi (-2.5%)
- Gabung DUMP ke frame biner: -8 notifikasi per switch (-4% per switch)
- Total potensi: ~100 notifikasi terhindar dari 411 = 25% reduksi

== 4. REKOMENDASI SPECIFIK ==

### Immediate (tanpa firmware change)
1. **Hapus [IN:] trace** — ini HID trace, duplikat [KEY], tidak dipakai app
   File: macropad_core.h:480-487 (hidTrace call setelah [KEY])
   → Hapus hidTrace("KEY", detail) di scanMatrix, biarkan [KEY] tetap

2. **Turunkan EVT:BATT frekuensi** — saat ini setiap ~1s (60/menit)
   File: macropad_core.h:670 (EVT:BATT di timer)
   → Ubah interval dari 1000ms → 10000ms (10x lebih jarang)

3. **Jangan kirim [LAYER] di production** — ini trace, EVT:LAYER sudah cukup
   File: macropad_core.h:585, 936
   → Wrap dengan #ifdef DEBUG_TRACE_LEVEL_2 atau flag runtime

4. **Hapus [BLE] debug traces** — semua LOGS->printf di ble_hid.h
   → Wrap semua dengan #ifdef BLE_DEBUG atau flag runtime

5. **Hapus [FRAME] traces** — frame_proto.h
   → Wrap dengan #ifdef FRAME_DEBUG

6. **Jangan kirim DUMPENC tiap switch** — encoder config statis, kirim sekali
   di afterConnectHandshake dengan guard !dumpInProgress
   File: frame_proto.h / protocol-parser.js

### Short term (perlu firmware rebuild)
7. **Gabung DUMP response ke frame biner** — gunakan frame_proto.h:faDumpLayer()
   atau versi binernya untuk kirim semua key sekaligus (9 key × 30B = 270B
   dalam 2 frame, vs 11 baris text). Ini butuh implementasi di firmware.

8. **Batch EVT:BATT** — kirim tiap 30s, atau trigger saat perubahan >5%
   atau saat charging state berubah (EVT:CHG sudah ada untuk itu)

9. **Hindari notifikasi saat tidak ter-subscribe** — device sudah cek
   bleNusSubCount, tapi pastikan semua LOGS->printf juga dicek.

10. **Gunakan notification coalescing** — buffer beberapa [KEY] event
    dan kirim batch per 50ms, bukan per key press. Ini mengurangi
    notifikasi overhead pada burst key press (macro).


== 5. STATUS SUMMARY ==

| Kategori           | Total | Essential | Optimizable | Debug |
|--------------------|-------|-----------|-------------|--------|
| Protocol response  | 14    | 14        | 0           | 0      |
| Real-time events   | 8     | 6         | 2           | 0      |
| Frame responses    | 5     | 5         | 0           | 0      |
| Debug traces       | 15+   | 0         | 0           | 15+    |
| Duplikat           | 1*    | 0         | 0           | 1*     |

* [IN:] adalah duplikat [KEY], dikirim bersamaan

Total notifikasi yang dihitung: 411
Total yang essential: ~27 (handshake + real-time events + frame responses)
Total yang optimizable: ~2-3 (BATT frequency, DUMPENC timing)
Total yang debug-only: ~10-15 per session

Reduksi yang mungkin: 100-130 notifikasi per session (25-30%)
Dari itu, 30 notifikasi (7%) adalah [IN:] duplikat yang paling mudah dihapus —
ini saja akan mengurangi notifikasi saat key press burst yang justru paling
sering menyebabkan GATT buffer overflow.
