# Development status & testing procedures

This document covers two things:

1. **Development summary** — what is done and what is not.
2. **Testing procedure** — the steps that prove every feature is safe.

Latest verification status: **84 Rust tests green, `vite build` succeeds, both
firmware sketches compile**, and 40 of 44 Node suites are green. The four red
suites were already red before the 0.9.0 release and are unrelated to the FINAL
firmware (`ble-transport-test.mjs`, `contract-chunk-test.cjs`,
`diag-report-test.mjs`, and one text-path assertion in
`frame-transport-test.mjs`). See [Section 3](#3-latest-verification-results).

---

## 1. Development summary

### 1.1 Completed

Every change was committed one step at a time with a CHANGELOG entry, so each
stage can be reverted.

| Commit | Phase | Contents |
|---|---|---|
| `604c3b4` | Phase 0 | Repo baseline + CHANGELOG |
| `3c020d2` | Phase 1 | Quick wins: overlay build, index parsing, escaping, styling |
| `d2215c8` | Phase 2 | PROTOTYPE and FINAL firmware split |
| `77f6ae7` | Phase 3 | Battery & RGB data come from firmware, not the app |
| `6106dcf` | Phase 4 | Transport reliability: leaked listeners, unbounded buffer, parser resilient to bad data |
| `88cade1` | Phase 5 | Per-layer DUMP waiter with timeout; separate read from layer switch |
| `7693615` | Phase 6 | Remove firmware freezes (blink, app gesture, key log) |
| `d2c97f6` | Phase 7 | Hardening: CSP, Tauri permissions, `eval` → events, atomic files, Rust tests |
| `9b9dcd0` … `d508acb` | Phase 8 | `main.js` 1864 → 263 lines, split into 15 modules |
| `e8cf630` | Phase 9a | Accessibility: keyboard navigation, modals, focus trap, `aria-*` |
| `8b9c956` | Phase 9b-1 | i18n foundation: Windows locale detection, ID/EN tables, Settings switcher |
| `71bd1c9` | Phase 9b-2 | Every runtime string (~200 keys) translated |

#### Firmware

- Split into `firmware/HID_Keypad_Prototype/` and `firmware/HID_Keypad_Final/`,
  sharing `firmware/common/macropad_core.h`.
- Battery & RGB data are read from firmware (`HWINFO:`, `EVT:BATT:`,
  `EVT:CHG:state=`, `RGB_DUMP:`, `RGB_KEY:`). The app no longer guesses.
- Encoders use a quadrature state machine (direction is no longer inverted).
- Transport is abstracted: `firmware/common/transport.h` (the `Transport`
  interface), `transport_usb.h` (`UsbTransport`), `transport_ble.h`
  (`BleTransport`). Core code uses the `SERIAL->` macro.
- FINAL enables BLE HID (`HID_BLE_SUPPORT 1`) and switches media automatically
  from `VD_VB`.

#### App (Rust)

- 84 unit tests green, including reading the real Windows locale.
- Tauri commands: application, consent, autostart, locale, bindable apps, preset,
  notifications, overlay, foreground exe.
- BLE module (`src-tauri/src/ble.rs`) is implemented and **compiles clean**, and
  is used by the frontend through the transport facade.

#### App (JavaScript)

- 40 of 44 Node suites green (the 4 red suites predate this and are recorded as
  known issues in CHANGELOG 0.9.0).
- `vite build` succeeds.
- Accessibility: keyboard navigation for the sidebar & layers, modals with focus
  trap and focus restore, live regions for status & log.
- i18n: ID + EN, automatic detection from the Windows language on first run, a
  manual switcher on the Settings page.

### 1.2 Not yet done

#### Phase 10 — BLE (completed in 0.9.0)

The transport abstraction, the Rust BLE commands, the JavaScript BLE backend, the
auto-connect/failover coordinator, and the FINAL BLE HID stack are all in place.
The remaining work is hardware validation, listed in Section 2.6.

#### FINAL firmware — automatic media, battery, RGB (v8)

Implemented in `firmware/HID_Keypad_Final/HID_Keypad_Final.ino`:

- **BLE HID enabled** (`HID_BLE_SUPPORT 1`). Media is chosen automatically from
  VD_VB: HIGH (USB) -> USB HID/protocol + BLE off; LOW (battery) -> BLE + USB
  de-enumerated. ~0.9 s debounce so the cross-coupling capacitor cannot trigger a
  false switch. No more BOOT/GPIO0 button in FINAL.
- **VD_VB is read digitally** (GPIO21 is not an ADC pin on the ESP32-S3). The old
  8-sample ADC read per loop (~2 ms blocking) is replaced by one `digitalRead`
  every 500 ms.
- **Real battery sense**: `EN_VD` HIGH -> 5 ms settle -> 16 ADC samples -> `EN_VD`
  LOW, reported every 10 seconds (not every second/loop).
- **RGB off really turns the MOSFET off**: `RGB:EN:0`, brightness 0, or black
  colour -> `rgbPower(false)`. `rgbInit()` no longer sweeps when the saved state
  is off.
- **RGB effect engine wired in** (`rgb_effects.h`): breathing, color cycle,
  rainbow, waves, snake, random, react. Modes 0/1 stay static.
- **Configurable knob gestures**: per knob, two tiers, type and duration from the
  app (`GEST` / `SETGEST`), stored in NVS. Defaults: knob 1 next layer at 2 s,
  exit preset at 3 s; knob 2 without gestures.
- **2-knob binary payload**: `CFG_STAGING_SIZE` 6144 (max payload 6014),
  `needLen` derived from `NUM_ENCODERS`, `cfgSig()` arranges encoders in the
  canonical CW,CCW,BTN order per knob.

Still needs hardware: verifying `EN_RGB`/`EN_VD` polarity, knob rotation direction
(can be flipped with `ENC_DIR_INVERT`), and the real charger reading.

#### Phase 6.1 — deliberately deferred

Moving matrix scan + serial into a separate FreeRTOS task. After Phases 6.2–6.4,
the only blocking left is `Keyboard.print()` (~1 ms/character). Moving to a
separate task requires `Keyboard`, `Adafruit_NeoPixel`, and `Preferences` to be
thread-safe — none of them are. Doing that refactor without being able to compile
and without hardware risks producing worse results than the original problem.

#### Planned work (still ideas)

- **Time filter for the rotary encoder.** The quadrature state machine already
  handles bounce at the detent, but random noise flipping A/B at random still
  looks identical to a real rotation. A time-based filter is needed (ignore
  transitions < 2 ms after the previous one). Symptom: random steps while the
  knob is still.
- **Pause auto-switch after the user changes layer.** `lastDeviceLayerEventAt` is
  set on every `EVT:LAYER:` but never read. Plan: stop auto-switch briefly after
  the user changes layer from the knob, so a preset does not immediately override
  it. What should happen when `fetchAllLayersForPacking()` is running and the user
  changes layer mid-dump is still undecided.

---

## 2. Testing procedure

### 2.1 Level 1 — Automated (run before every commit)

Run from the repo root. Everything must be green.

```powershell
# A. Rust unit tests
cd src-tauri
cargo test --lib            # must be: 84 passed; 0 failed
cargo check                 # must report no errors
cd ..

# B. Frontend build (catches errors `node --check` does not)
npx vite build              # must print "built in ..." without errors

# C. Node test suites
npm test                    # must be 40/44 green (4 known issues)
```

**All four red suites are pre-existing and tracked in CHANGELOG.** If a NEW suite
fails, do not commit — fix it first.

### 2.2 Level 2 — Build & run the app

```powershell
npm run tauri dev
```

Check:

- [ ] The main window appears, **not white**. (If white: `src/paint-watch.js`
      reloads automatically through `requestAnimationFrame` — let it work once,
      then check the log.)
- [ ] A tray icon appears in the system tray.
- [ ] The COM dropdown is filled with the serial port list.
- [ ] No errors in the `#log` panel or the DevTools console.

### 2.3 Level 3 — Manual testing with PROTOTYPE hardware

> **Prerequisite**: firmware is already flashed. Static checks **do not** replace
> this.

#### Connection

- [ ] Select the correct port in the COM dropdown → click **Connect**.
- [ ] Status changes from "Not connected" to "Connected".
- [ ] Unplug USB → status becomes disconnected, the app does **not** crash.
- [ ] Plug it back in → reconnect, no app restart needed.

#### Device info

- [ ] The **HWINFO** fields are filled: profile, encoders, statusLed, rgb,
      rgbSlots, vdiv, chg.
- [ ] `profile` = `P` for PROTOTYPE (FINAL = `F`).
- [ ] Battery shows a **percentage** that changes over time.
- [ ] The battery icon has an `aria-label` mentioning the percentage (check in
      DevTools → Accessibility Tree).
- [ ] There is a clear warning in the UI that on PROTOTYPE the battery & RGB
      numbers are **simulated** (`simulated=1` in HWINFO).

#### Grid & layers

- [ ] Pressing each key → the **app** (not the OS) receives the action, matching
      its type: text, combo, macro, application, consumer/media.
- [ ] Per-key notifications appear in the app (`[KEY] layer,row,col,type,value`).
- [ ] `+ Layer` / `- Delete` / `Rename` work; `Load` fetches the layer from the
      device.
- [ ] `Save` writes to flash; **power-cycle the device** → the config persists.
- [ ] `Reset` restores defaults.
- [ ] A long macro (47 characters) does not make the device fail. Watch the log.

#### Rotary encoder

- [ ] Rotating the knob clockwise → layer up. Counter-clockwise → layer down.
      **Not inverted.**
- [ ] Knob still → **no** random steps (the time filter does not exist yet, so if
      jitter appears, record it as a bug — do not treat it as normal).
- [ ] Pressing the knob → `[ENC_BTN] Knob i:` appears in the log.
- [ ] Hold Escape ≥ 3.5 s → `[EVT:ESCAPE]`.
- [ ] Hold the layer switch ≥ 1 s → `[EVT:LAYER:N]`.

#### Adaptive key bind

- [ ] Scan the application list; the foreground application is detected.
- [ ] A custom .exe can be added/removed.
- [ ] Presets can be activated; presets competing for the same application are
      disabled automatically and the user is told.
- [ ] Preset-bound keys change automatically when switching applications.
- [ ] `masterEnabled` can be turned off → all bindings stop.

#### RGB settings

- [ ] Enable, brightness, speed, colour, mode, random sliders — all accepted by
      the device (`[OK] ...` in the log).
- [ ] `Save` → `RGB:SAVE`; power-cycle the device → the effect persists.
- [ ] `Dump` → the app shows 9 slots matching the device contents.
- [ ] The worst-case 62-byte `[KEY]` line — make sure the device does **not**
      reset when a macro is full.

#### Settings

- [ ] Autostart: enable it → restart Windows → the app starts by itself.
- [ ] **Language**: switch to English → the **entire** UI changes, including log
      messages and notifications. Switch back to Indonesian.
- [ ] **Automatic detection**: remove the language choice from localStorage,
      change the Windows language, restart the app → the language follows Windows.
- [ ] After choosing manually, change the Windows language → it must **not**
      change (the manual choice wins).

### 2.4 Level 4 — Accessibility testing (Phase 9)

- [ ] `Tab` reaches the sidebar, each layer, the grid, knobs, and buttons.
- [ ] `ArrowUp`/`ArrowDown` move focus between sidebar items; `Enter` activates.
- [ ] `ArrowLeft`/`ArrowRight` change layers in the tab bar.
- [ ] Modal: focus moves into the modal and is **trapped** inside (Tab does not
      escape), then returns to the trigger after closing.
- [ ] `Esc` closes the modal.
- [ ] A focus ring is visible on every interactive element (`:focus-visible`).
- [ ] `role="status"` and `role="log"` are read by a screen reader (test with
      NVDA).

### 2.5 Level 5 — Resilience testing (automated, but stay aware)

- [ ] **Corrupt data**: paste random lines into the parser (the
      `protocol-parser-test.mjs` suite already covers this).
- [ ] **Device dies during a dump**: `DUMP_END` never arrives → the waiter must
      time out and the app must not hang.
- [ ] **Unbounded buffer**: data keeps flowing → memory must not grow without
      bound.
- [ ] **White window**: force-close the app then run it again → it must be normal
      (the `paint-watch.js` watchdog).

### 2.6 Level 6 — Firmware testing

The Arduino toolchain is available (`arduino-cli` + esp32 core 3.3.8). Both
sketches have been compiled for `esp32:esp32:esp32s3`:

| Sketch | Flash | Static RAM |
| --- | --- | --- |
| FINAL v8 | 716,369 B (54%) | 112,364 B (34%) |
| PROTOTYPE v8 | 700,857 B (53%) | 110,676 B (33%) |

Static verification still runs through Node suites
(`firmware-compile-guard-test.js`, `firmware-final-contract-test.cjs`,
`firmware-switch-iface-test.cjs`).

Before releasing to a device:

- [x] `arduino-cli compile` for **both** sketches (PROTOTYPE & FINAL) without
      errors.
- [x] Check that flash & RAM usage is nowhere near the limit.
- [ ] Flash to the device and repeat every test in Section 2.3.
- [ ] Test FINAL with VBUS attached -> `EVT:CHG:state=0/1/2` (not charging /
      charging / complete) is correct.
- [ ] Test FINAL without VBUS -> `usb=0`, `charging=0`, and media switches
      automatically to BLE (`IFACE:link=ble`), then back to USB when the cable is
      plugged in.
- [ ] Verify `EN_RGB` (GPIO15) and `EN_VD` (GPIO17) polarity.
- [ ] Verify the rotation direction of both knobs; if inverted, set
      `ENC_DIR_INVERT 1` in the FINAL sketch (do not change the shared quadrature
      table).
- [ ] FINAL RGB effect engine: breathing, rainbow, wave, snake, random, react run
      without flicker; RGB off / brightness 0 / black colour turn the rail off
      (measure current).
- [ ] Gestures: changing tier 1/tier 2 in the app really changes the knob and its
      duration, and persists across a reboot.

### 2.7 Per-commit procedure

Before every commit:

1. `cargo test --lib` + `cargo check` → green.
2. `npx vite build` → succeeds.
3. `npm test` → no new failures (40/44 is the current known baseline).
4. `git status` — make sure no stray files are included (e.g. `dist/`, `target/`,
   `node_modules/`).
5. Update `CHANGELOG.md`: **Added / Changed / Fixed / Removed**.
6. Commit with a message that names the phase number.

If a regression appears after committing: `git revert <hash>` (never
`reset --hard`, so history stays traceable).

---

## 3. Latest verification results

| What was tested | Result |
|---|---|
| `cargo check --lib` | Clean (0 errors) |
| `cargo test --lib` | **84 passed**, 0 failed, 1 ignored |
| `npx vite build` | Succeeds |
| Node test suites | **40/44 green** (4 pre-existing known issues) |
| `arduino-cli compile` FINAL v8 | 716,369 B flash (54%), 112,364 B RAM (34%) |
| `arduino-cli compile` PROTOTYPE v8 | 700,857 B flash (53%), 110,676 B RAM (33%) |

The four remaining red Node suites were already red before 0.9.0 and are unrelated
to the FINAL firmware changes: `ble-transport-test.mjs` (4 assertions),
`contract-chunk-test.cjs`, `diag-report-test.mjs`, and one "full text-path upload"
assertion in `frame-transport-test.mjs`.

### Not yet verified

- Real behaviour on the device (no device access from this environment).
- `EN_RGB` (GPIO15) and `EN_VD` (GPIO17) polarity.
- Rotation direction of both knobs (`ENC_DIR_INVERT` if inverted).
- The actual MCP73831 charger status, including telling "complete" apart from
  "no battery" (both are high-Z on the STAT pin).
