# Architecture

This document explains how the repo is organised and how its parts communicate.
For protocol commands, see [PROTOCOL.md](PROTOCOL.md).

## Directory structure

```
firmware/
  common/
    limits.h           # shared constants (pins, limits, RGB, transport type)
    macropad_core.h    # all logic: keymap, protocol, matrix scan, encoder,
                       # gestures, presets, battery
    frame.h            # frame protocol v2 specification (authoritative) + CRC
    frame_asm.h        # on-device frame assembler for FRAMEIN
    frame_proto.h      # frame assembly/parsing, preset upload staging
    cfg_sig.h          # config fingerprint (canonical form, not memcpy)
    rgb_effects.h      # pure RGB effect engine (no hardware access)
    transport.h        # Transport interface (USB CDC vs BLE NUS)
    transport_usb.h    # USB CDC implementation
    transport_ble.h    # BLE NUS implementation
    hid_link.h         # USB vs BLE HID selection
    ble_hid.h, ble_shared.h, ble_diag.h   # BLE HID, shared helpers, BLE diagnostics
    switch_iface.h     # media switch (PROTOTYPE only)
    diag.h, crc32.h
  HID_Keypad_Prototype/HID_Keypad_Prototype.ino   # pins + simulated peripherals
  HID_Keypad_Final/HID_Keypad_Final.ino           # pins + real peripherals

src/                    # frontend, ES modules without a framework
src-tauri/src/          # Rust backend (Tauri commands, WinRT GATT, audio)
  audio/                # audio graph: input, mixer, DSP, output
tests/
  suites/               # Node test suites (static contracts + behaviour)
  vectors/              # golden vectors for frames and config fingerprints
docs/                   # technical docs and status
```

## Frontend modules (`src/`)

| Group | Modules | Responsibility |
|---|---|---|
| Entry point | `main.js` | The only place where all modules are assembled through `initXxx()` |
| Transport | `transport.js` | Facade: every module calls this, never a backend directly |
| | `serial-transport.js`, `ble-transport.js` | USB CDC and BLE NUS backends, each owning its own framing state |
| | `connection-manager.js`, `auto-connect-core.js` | USB <-> BLE auto-connect/failover (USB has priority) |
| Protocol | `protocol-parser.js` | Parses lines from the device (INFO, DUMP, ENC, GEST, EVT, ...) |
| | `frame-codec.js`, `frame-transport.js`, `frame-dispatch.js`, `pong-probe.js` | Binary frame v2 layer on the app side |
| | `device-state.js` | Single source of truth for device state (grid, encoders, gestures, RGB) |
| | `adaptive.js`, `cfg-builder.js`, `cfg-layout.js`, `cfg-sig.js`, `upload-state.js` | Adaptive presets, payload assembly, fingerprints, upload progress |
| UI | `home-page.js`, `rgb-page.js`, `soundboard-page.js`, `audio-panel.js` | Main page and editors |
| | `ui-router.js`, `ui-modal.js`, `ui-notify.js`, `dom.js`, `i18n.js` | Navigation, modals, notifications, DOM helpers, ID/EN translations |
| Other | `battery-ui.js`, `diag-report.js`, `tray.js`, `overlay.js`, `app-picker.js`, `paint-watch.js` | Battery, diagnostics, tray, overlay, app picker, repaint watchdog |

## Import rules

Modules **do not** call each other's functions directly. Everything communicates
through `initXxx({...})` dependency injection. The goal is to avoid import cycles
while keeping every dependency visible.

`main.js` is the only meeting point for these modules.

All transport access goes through `transport.js` (the facade). Importing
`serial-transport.js` directly from another module is a bug: commands would keep
being written to the COM port even after the user selected BLE.

## Data flow at a glance

```
UI (home-page/rgb-page)
  -> transport.sendLine()
     -> serial-transport.js  or  ble-transport.js
        -> firmware (ASCII lines / binary frames)

firmware (ASCII lines / frames)
  -> transport backend (backend-owned line buffer)
     -> protocol-parser.handleLine()
        -> device-state.js  -> UI re-rendered through hooks
```

The firmware never "waits" for the app. Commands are processed when a newline
arrives, and events (`EVT:*`, `[KEY]`) can arrive at any time; the parser must
tolerate events interrupting a dump in progress.

## Four firmware layers

1. **`limits.h`** — pins, row/column/encoder counts, `FW_VERSION`, state structs.
2. **`macropad_core.h`** — behaviour: keymap, encoders, gestures, presets,
   battery, command handler. It does not know which physical pin is used.
3. **Feature headers** (`frame_*`, `cfg_sig`, `rgb_effects`, `transport.h`) — the
   parts cross-checked against the app through golden vectors.
4. **Sketches** (`.ino`) — the only place with the pin map and peripheral
   initialisation. PROTOTYPE and FINAL differ only in this layer.

Adding a new board profile means a new sketch + capability `#define`s, not
duplicating the logic.

## Build & test

See [STATUS-AND-TESTING.md](STATUS-AND-TESTING.md) for the latest verification
status, hardware checklist, and build commands.
