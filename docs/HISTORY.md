# Release notes (archive)

Long-form release notes that used to live in the README. For a per-version
summary, see [CHANGELOG.md](../CHANGELOG.md).

## v0.9.0 — FINAL firmware, per-knob gestures, automatic media

This release turns FINAL from "a prototype with a final label" into real device
firmware.

**FINAL firmware v8.** 2 knobs, a 9-LED RGB strip (serpentine order in
`RGB_INDEX`), a 100k/100k battery divider on `VD` with an `EN_VD` switch,
`VD_VB` cable detection, and charger status. Media is selected automatically:
cable attached → USB, no cable → BLE. The BOOT/GPIO0 button is no longer used.

**Things the pinout notes did not show but that are required** (see CHANGELOG
0.9.0 for details):

- GPIO21 is not an ADC pin on the ESP32-S3 → USB detection must use `digitalRead`.
- FINAL must actually compile BLE (`HID_BLE_SUPPORT 1`).
- A 2-knob preset binary payload needs 6014 bytes; the old 5120-byte staging made
  every binary upload fail and the app silently fell back to the text path.
- `cfgSig()` must arrange encoders canonically per knob, otherwise the preset
  cache never matches.
- RGB off / brightness 0 / black colour must turn off the `EN_RGB` MOSFET.
- `rgb_effects.h` previously did not compile at all (`%` on a float).

**Hold gestures are now per knob** and configured from the app
(`GEST`/`SETGEST`, two tiers, 100–20000 ms), stored in NVS so they are not part
of the preset payload.

**Audio:** a fixed 30 ms buffer + fallback candidates replaces "driver default",
which can be 200–2000 ms on virtual endpoints.

## v0.6.6 (fixes)

### Inconsistent preset switching ("not always working")

The root cause was one misplaced decision in `frame-transport.js`:

```js
if (!r.ok) { frameUsable = false; return null; }   // ordinary timeout
```

Two problems at once:

1. A 2-second timeout — **normal** on a link with `rtt p50=293ms` — immediately
   disabled the fast path.
2. "Disabled" meant **permanently**, until disconnect.

The effect was a chain reaction: fast path disabled → every later switch fell
back to the text path that sends hundreds of `SET:` lines → the link got more
saturated → RTT rose → timeouts became more frequent → the fast path was
disabled more often.

The fix:

- A momentary timeout **no longer** disables the fast path. Only 3 consecutive
  failures, or real evidence (`ERR UNSUPPORTED`), disable it.
- A disabled fast path gets a **4-second pause** and is retried, instead of
  staying off permanently until disconnect.
- The text path (hundreds of `SET:`) has an **8-second cooldown** — so it is no
  longer used as the automatic response to every frame timeout.
- `RTT_MS` 2 → 6 seconds. 2 seconds is too short for a link whose RTT is 293 ms,
  so every reply still in flight was treated as a failure.

### Where the 293 ms RTT came from

The firmware requested `BLE_CONN_INTERVAL_MIN/MAX_MS 50/100`. At that interval
one hop = one connection event = up to 100 ms, and one round trip = 2 hops. The
measured number sits exactly in that range.

The firmware now requests **15/30 ms**. A 10-second supervision timeout leaves
plenty of room for missed connection events, and this device is USB-powered so
the power cost is not felt.

> Note: these numbers are only a *request*; Windows decides. If RTT is still
> ~300 ms after flashing, Windows ignored the request.

### Adaptive PING

A 1500 ms PING is ~80 PING/PONG pairs per 2 minutes — constant traffic on the
same link used for preset uploads. Now: **5 seconds idle** (supervision timeout
is 10 seconds, so keepalive remains safe), **1.5 seconds** for 6 seconds after
activity.

### DIAG: the L5 LOSS layer

`notifyOk` (L4) counts chunks accepted by the device BLE stack, while
`notify_events` (L1) counts notifications that reach the host. They count
**different things**, so they must not be compared — misreading this has been
misleading once already.

L5 LOSS now reports `rx_dropped_bytes`, the only cross-layer number that can
really be trusted: if it is zero, the link is **not** dropping at the host.

## v0.6.6

Protocol migration to **binary frame v2** (Phases 0-5, details in the git
history). Runtime presets are now uploaded through `CFG_BEGIN` /
`CFG_WRITE` / `CFG_COMMIT` with `T_CREDIT` flow control, not hundreds of `SET:`
lines.

**Main changes**

- Binary frame layer on the app side: `frame-codec.js` (encode/decode),
  `frame-dispatch.js` (RX assembler), `frame-transport.js` (queries + bulk
  upload).
- Preset switch fast path: `CFG_SIG` + `CFG_QUERY` + `CFG_ACTIVATE`. If the
  device already has a slot with the same sig, switching takes a single 8-byte
  frame.
- `WHOAMI` now reports `frame=0xA5` as a **capability** (persists across
  disconnects), rather than `proto=frame` which only reflects the current mode.
  The frame-path gate uses the former so a device that wanders into frame mode no
  longer causes a deadlock.
- The `BLE` path was rewritten: `Drop for BleTransport` in Rust,
  disconnect-before-connect, `sendBatch` backpressure, 186ms -> 7ms retry ladder,
  and `onWrite()` no longer blocks in `printf`.
- The firmware protocol session is reset in `onConnect`/`onDisconnect`
  (`PROTO_LINK_RESET`), so a device that reconnects does not silently stay in
  frame mode.

**Fixes**

- Reset protocol state on BLE connect/disconnect (_app_ and firmware).
- Filter `U+FFFD` replacement characters coming from binary frames read as text.
- `CONTEXT:DEFAULT` clamps `currentLayer`, so it no longer points at a missing
  layer after returning to the default preset.
- `handleDeviceLost()` calls `ble_disconnect` so WinRT handles do not pile up on
  every reconnect.

**Known issues (still open)**

- `notifyFail=3` and high radio latency (`RTT p50=175ms`) reported on the Windows
  host. `ringDropped=0` is already healthy, so this is the radio/host side, not
  software.
- Phase 6 (text path cleanup: dump watchdog, `slotTable`, `SET:`) is not done.
  The `0x02 LINE`, `SET:`, `SLOT:`, `DUMP:` paths are still alive as diagnostic
  escape hatches.

**Verification**

The firmware is verified with `arduino-cli` in the build environment (both
sketches compile) and through the static contract suites. On-device testing is
still required for behaviour that cannot be proven statically. See
[STATUS-AND-TESTING.md](STATUS-AND-TESTING.md).
