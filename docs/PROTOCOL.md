# Device protocol

Protocol reference for the firmware and the companion app: ASCII line commands,
the binary frame protocol v2, and the limits both sides must respect.

## Line protocol (primary)

Format: **ASCII, one command per line, terminated by newline**, 115200 baud
(USB CDC). Any value coming from the device can be malformed (`abc` becomes
NaN), so the app always validates before using it.

### Constants that must match the firmware

| App constant | Value | Firmware source |
|---|---|---|
| `APP_SLOTS` | 6 | `slotTable` |
| `MACRO_MAX_LEN` | 47 byte (truncated at whole characters) | `MACRO_MAX_LEN` = 48 including terminator |
| RGB slots | 9 | `RGB_COUNT` |

### Commands (app to device)

| Command | Form | Reply |
|---|---|---|
| `PING` | - | `PONG` |
| `WHOAMI` | - | `WHOAMI:MacroPad:v1:rows=..,cols=..,encoders=..,proto=line\|frame,frame=0xA5` |
| `INFO` | - | `INFO:layerCount=..,currentLayer=..,maxLayers=..,rows=..,cols=..,encoders=..,context=..` |
| `HWINFO` | - | `HWINFO:profile=..,encoders=..,statusLed=..,rgb=..,rgbSlots=..,vdiv=..,chg=..,simulated=..` |
| `BATT` | - | `BATT:pin_mv=..,batt_mv=..,pct=..,charging=..,usb=..` |
| `DUMP:<n>` | read layer `n` | `DUMP_BEGIN:<n>` ... `DUMP_END` |
| `DUMPNAMES` | read layer names | `NAMES_BEGIN` ... `NAMES_END` |
| `DUMPENC` | read encoder bindings | `ENC_BEGIN:count=N` ... `ENC_END` |
| `SET:<layer>:<r>:<c>:<type>:<value>` | write one key | `[OK] Set ...` |
| `GET:<layer>:<r>:<c>` | read one key | `L<n> R<n> C<n> -> type=.. value=..` |
| `SETENC:<idx>:<CW\|CCW\|BTN>:<type>:<value>` | write an encoder binding | `[OK] SetEnc ...` |
| `GEST` | read per-knob hold gestures | `GEST_BEGIN` ... `GEST:<idx>:<t1Type>,<t1Ms>,<t2Type>,<t2Ms>` ... `GEST_END` |
| `SETGEST:<idx>:<1\|2>:<type>:<ms>` | set one knob gesture tier (stored in NVS `gestcfg`) | `[OK] Gesture knob n tier n ...` |
| `ADDLAYER` | add a layer | `[OK] Layer ditambah, total ...` |
| `DELLAYER` | delete the active layer | `[OK] Layer dihapus, ...` |
| `RENAMELAYER:<n>:<name>` | rename a layer | `[OK] Layer <n> diganti nama jadi ...` |
| `MOVELAYER:<LEFT\|RIGHT>` | reorder layers | `[OK] Layer digeser ke posisi ...` |
| `LAYER:<n>` | switch the active layer | `[LAYER] ...` + `EVT:LAYER:<n>` |
| `SAVE` | write to flash | `[OK]` / `[ERROR] SAVE gagal...` |
| `LOAD` | reload from flash | `[OK] Config dimuat ulang` |
| `RESET` | restore defaults (send `SAVE` to persist) | `[OK] Config direset...` |
| `CONTEXT:DEFAULT\|APP:NEW\|APP:RESUME` | switch preset context | `[OK] Context: ...` |
| `SLOT:<n>:NEW\|USE` | cache a preset slot | `[OK] Context: SLOT n (...)` |
| `RGB:ON\|OFF` | turn RGB on/off | `[OK] RGB on/off` |
| `RGB:EN:<0\|1>` | enabled flag | `[OK] RGB ...` |
| `RGB:MODE:<mode>:<random>:<r>:<g>:<b>:<speed>` | mode + colour + speed | `[OK] RGB mode n` |
| `RGB:BRI:<0-255>` | brightness | `[OK] RGB brightness n` |
| `RGB:ALL:<r>:<g>:<b>` | all LEDs one colour | `[OK] RGB semua diset` |
| `RGB:KEY:<r>:<c>:<r>:<g>:<b>` | one key | `[OK] RGB r (Rr Cc) diset` |
| `RGB:DUMP` | read the whole state | `RGB_DUMP:..` + `RGB_KEY:..` ... + `RGB_DUMP_END` |
| `RGB:SAVE` | save to flash | `[OK] RGB disimpan` |
| `RGB:RESET` | restore defaults | `[OK] RGB reset ke default` |
| `DIAG` | four-layer diagnostic report | `DIAG:..` + `DIAGMEDIA:..` |
| `DIAG:ZERO` | reset diagnostic counters | `[OK] DIAG counter direset` |
| `SIG` | fingerprint of the active config | `SIG:%08lX` |
| `SIG:ALL` | fingerprint of every slot | `SIGSLOT:<n>:%08lX,layers=..,active=..` (6 lines) |
| `FRAME` | frame layer counters | `FRAME:mode=..,rx=..,tx=..,txDrop=..,txErr=..,crcErr=..,verErr=..,lenErr=..,unsup=..` |
| `FRAME:LINE` | force line mode again | `[OK] Frame mode dimatikan, kembali ke mode baris` |
| `FRAMEIN:<name>` | device builds a frame itself, then processes it | frame bytes + `ERR`/`EVT` |

`DIAG` answers with two lines: `DIAG:` (protocol layer: parsed lines, overlong
lines, unknown commands, last command, heap) and `DIAGMEDIA:` (media layer:
successful/failed/retried notifications, ring buffer fill, dropped bytes, writes
without connection/subscriber, MTU). The companion app sends `DIAG` every 30
seconds and shows a `=== DIAG ===` block in the log panel plus one verdict
sentence naming the responsible layer. See `src/diag-report.js`.

Action types (`type` on SET/SETENC): `0` none, `1` text, `2` combo,
`3` macro, `4` consumer/media, `5` open application.

Gesture types (`type` on SETGEST): `0` none, `1` next layer, `2` previous layer,
`3` exit preset. A gesture fires while the knob button is held: tier 1 = held
longer than tier 1 `<ms>`, tier 2 = held longer still. A short tap still runs the
`BTN` binding. Valid durations are 100-20000 ms and tier 2 must be longer than
tier 1. This setting is per knob and is not part of the preset payload.

## Frame protocol v2

The device can already speak binary frames alongside text lines, and detects the
mode on its own. The rules are intentionally narrow:

```
line mode + FIRST byte of a line = 0xA5  -> frame mode
frame mode + byte 0x0A while assembler IDLE -> back to line mode
```

Frame format: `[SOF 0xA5][VER 0x02][TYPE][LEN u16 LE][PAYLOAD][CRC16 u16 LE]`,
CRC16/CCITT-FALSE over `TYPE+LEN+PAYLOAD`. The authoritative specification lives
in `firmware/common/frame.h`; golden vectors in `tests/vectors/frames.vec` are
read by three independent runners (C, JS, and cross-checked through `cargo test`).

Frame commands already implemented on the device:

| Frame | Reply |
|---|---|
| `HELLO` (0x01) | `HELLO_RSP` (0x81): fw version, matrix size, encoder count, max payload, slot count, max layers, active slot |
| `CFG_QUERY` (0x13) | `CFG_META` (0x93): active slot + fingerprint and layer count per slot |
| `CFG_ACTIVATE` (0x14) | `CFG_ACT_RSP` (0x94): result code, active fingerprint, slot |
| `LINE` (0x02) | treated as one legacy line command; the reply is emitted as text |
| anything else | `ERR` (0x7F) with code `UNSUPPORTED` - the device says so plainly |

**Serial Monitor can always send commands.** The device reads USB CDC as a second
command path, separate from the protocol path that can move to BLE NUS. Without
this, once the app sends `PROTO:NUS`, Serial Monitor becomes a dead end: typing
anything there produces nothing - not an error, just silence - including the
command to restore the path (`PROTO:CDC`). `contract-logpath-test.cjs` keeps the
core forbidden from **writing** through `LOGS`; only input is read.

Replies to `SIG`, `SIG:ALL`, and `FRAME` are deliberately mirrored to Serial
Monitor because those commands exist to be read by a human. Frame replies
(`HELLO_RSP`, `CFG_META`, `CFG_ACT_RSP`) are not mirrored - they are protocol
replies, and duplicating them would make a device reading both believe there are
two answers for one request.

**Why `LINE` and `FRAMEIN` exist.** Serial Monitor cannot send binary bytes.
Without `FRAMEIN` and the `LINE` frame, the whole frame layer could never be
tested until the app was finished - and the hardest cases to reproduce from the
app (bad CRC, wrong version, monster LEN) are exactly the easiest ones to inspect
from here.

`FRAMEIN` has two forms. **Use the first one:**

```
FRAMEIN:CFG_QUERY           device builds the frame itself, CRC computed on device
FRAMEIN:HELLO
FRAMEIN:CFG_ACTIVATE:3
FRAMEIN:LINE:DIAG           text command wrapped in a LINE frame

FRAMEIN:A5 02 13 00 00 ...  raw bytes as-is - only for testing malformed frames
```

The second form is only useful for deliberately broken frames and requires
manual CRC calculation. The first form cannot be wrong, so if it produces no
frame the cause is certainly on the device - not in the bytes you typed. The
device prints the frame bytes it assembled before processing them, so they can be
compared directly with what the app will send later.

Example:

```
FRAMEIN:CFG_QUERY   -> [FRAME] CFG_QUERY (7 byte): a5 02 13 00 00 xx xx
                       [FRAME] FRAMEIN: 7 byte, mode=frame, rx=1, crcErr=0
FRAME                -> FRAME:mode=frame,rx=1,tx=1,txDrop=0,...,crcErr=0,...
```

If the device cannot leave frame mode, press Enter in Serial Monitor
(0x0A while the assembler is IDLE) or send `FRAME:LINE`.

**`CFG_SIG`.** The configuration fingerprint is computed from a canonical form,
not raw `sizeof(struct)`: only live layers, action values counted at full width,
and every field at fixed width. The reasoning lives in
`firmware/common/cfg_sig.h`. The computation is cross-checked in C and JS from the
same vector file (`tests/vectors/cfg.vec`, generated by
`tools/gen-cfg-vectors.mjs`), because if both sides computed different
fingerprints the app would re-upload presets that are already identical - every
time.

**Encoders are read from the last layer, not the first.** This is not a stylistic
choice. `SETENC` on the firmware writes to `activeCfg->encCW[encIdx]`, which is
global and has no layer index at all. Preset upload sends `SETENC` per layer in
sequence, so the last layer overwrites everything and the device stores one set
of bindings. `cfgSig()` also reads `c.encCW[0]` only once, outside the layer loop.
If the app computed the fingerprint from the first layer, the two numbers would
never match - and a preset that already exists would always be re-uploaded,
exactly the defect CFG_SIG was meant to remove. The test
`tests/suites/frame-transport-test.mjs` pins this behaviour to the `SETENC` lines
that actually exist in the firmware.

## Frame layer on the app side

The app already uses frames for the preset-switch fast path. The files:

| File | Contents |
|---|---|
| `src/frame-codec.js` | binary encoder/decoder; reply type derived from `RESP_BIT`, not a literal |
| `src/cfg-layout.js` | layout constants that **must** match `firmware/common/limits.h` |
| `src/frame-dispatch.js` | persistent decoder + waiter queue per frame type |
| `src/frame-transport.js` | frame conversation: `sendFrame`, `queryFrameSlots`, `activateFrameSlot`, `ensureLineMode` |
| `src/pong-probe.js` | PONG probe registry (single slot) |

**Incoming bytes flow into two paths at once** - the frame assembler and the line
parser. The "switch" model (route every byte to the frame decoder as soon as
something is waiting) is wrong: the device keeps sending **text** events in frame
mode, and the `EVT:LAYER:0` emitted right after `CFG_ACTIVATE` would be lost if
the line parser were switched off. The frame decoder only reacts to `0xA5`, so
text cannot corrupt it.

**Returning to the text path is verified, not assumed.** After a frame finishes,
the app sends a newline and then **`PING` and waits for `PONG`**. The first
version sent an empty line and moved on immediately; if the device had not left
frame mode, `INFO` and `DUMPENC` were read as corrupted frame payloads, `crcErr`
rose, and the grid never filled in.

**The frame format is negotiated, not read from a version number.** `proto=frame`
in the `WHOAMI` reply is only a HINT: the device enters frame mode only after
receiving SOF `0xA5`, so the first `WHOAMI` almost always reports `proto=line`
even on a frame-capable device. Using that reply as a gate would mean the fast
path is never used. The app tries frames; on failure it falls back to the text
path and records the failure per session so it is not repeated.

**`batchUploadInFlight()` is no longer a timing guess.** `markBatchSettling(4000)`
was removed: that fixed 4-second window held the dump watchdog for almost 4
seconds for nothing on small batches, and expired too early for large batches on
slow links - both lied. Its replacement is an explicit flag
(`beginCfgTransfer` / `endCfgTransfer`) plus a window derived from the actual
number of commands.

What **already** exists: `CFG_BEGIN`/`CFG_WRITE`/`CFG_COMMIT` (bulk upload,
Phase 4) and credit flow control (Phase 5). `CFG_BEGIN` -> `CFG_READY{credit u16}`;
`CFG_WRITE` is sent via WriteWithoutResponse (BLE) / sendRaw (serial); the device
sends `CREDIT` to grow staging space. Expect `UNSUPPORTED` if the device does not
recognise one of these types yet.

## Lines from the device

| Prefix | Meaning |
|---|---|
| `INFO:` | device metadata (also used after `RESET`) |
| `HWINFO:` | profile + capabilities; `simulated=1` means battery/RGB values are simulated |
| `BATT:` | reply to `BATT`; `EVT:BATT:` = periodic event |
| `EVT:CHG:state=N` | charger state: 0 not charging, 1 charging, 2 complete |
| `EVT:LAYER:N` | user changed layer on the device (knob long-press) |
| `EVT:ESCAPE` | escape gesture (held 3.5 seconds or more) |
| `EVT:ENC:N:CW\|CCW` | knob rotated |
| `EVT:APP:<name>` | ask the app to open an application; if the companion is not connected, the device types it via Windows Search |
| `DUMP_BEGIN:<n>` ... `DUMP_END` | contents of layer `n`, one `<row>,<col>,<type>,<value>` line per key |
| `IDX:<i>` + `CW\|CCW\|BTN,<type>,<value>` | binding of encoder `i` |
| `NAMES_BEGIN` ... `NAMES_END` | layer names, separated by `\|` |
| `[KEY] <layer>,<row>,<col>,<type>,<value>` | notification for each key press |
| `[ENC_BTN] Knob <i>:` | knob button pressed |
| `[OK] ...` / `[ERROR] ...` | command result |
| `[FLASH] ...` | NVS persistence status |

## Limits to respect

- **`[KEY]` is at most 62 bytes.** `7,2,2,3,` + 47 chars + newline = 62, still
  below the 64-byte `vprintf` stack buffer. A longer verbose format would trigger
  a `malloc` inside `vprintf`.
- **`currentLayer` is persisted to flash** because it lives in the same `cfg`
  struct. Saving on layer 4 makes the device boot on layer 4. The app therefore
  sends `LAYER:0` right after connecting.
- **`DUMP:<n>` does not move the active layer**, so the read path is safe without
  sending `LAYER:`.

---
