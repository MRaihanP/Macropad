# Macro Pad Configurator

Companion app for an **ESP32-S3** macro pad: 3×3 keys, up to 2 rotary encoders,
9 RGB LEDs, and a battery. Configure the keymap, knob gestures, and RGB effects
from your desktop — everything is stored on the device, so the macro pad keeps
working without the app.

[![Release](https://img.shields.io/github/v/release/MRaihanP/Macropad?label=release)](https://github.com/MRaihanP/Macropad/releases/latest)

---

## Download

A Windows 64-bit installer is available on the **[Releases](https://github.com/MRaihanP/Macropad/releases)** page:

| File | Description |
|---|---|
| `macropad-configurator_0.9.0_x64-setup.exe` | NSIS installer — recommended |
| `macropad-configurator_0.9.0_x64_en-US.msi` | MSI package for managed installs |

Download it, run the installer, then open **Macro Pad Configurator** from the
Start Menu. Windows 10/11 64-bit. If the WebView2 Runtime is missing, the
installer offers to install it.

---

## Features

- **3×3 keymap with up to 8 layers** — every key can hold text, a key combo, a
  macro, a media key, or launch an application.
- **Programmable knob** — rotate CW/CCW and press; supports 1 or 2 knobs
  depending on the board.
- **Per-knob hold gestures** — hold to change layer or leave a preset, with a
  duration you set in the app (100–20000 ms) and stored on the device.
- **9-LED RGB** — per-key colour, breathing, colour cycle, rainbow, wave, snake,
  random, and react.
- **Battery & charger status** — percentage, voltage, and charging indicator
  (FINAL board only).
- **Automatic USB or Bluetooth** — the FINAL board switches to BLE when the cable
  is unplugged and back to USB when it is plugged in.
- **Adaptive presets** — configuration follows the currently active application.
- **Indonesian & English** — follows the Windows language on first launch.

---

## Two board profiles

The repo contains firmware for two boards. Switching profiles means opening the
other sketch — not flipping a switch.

| Profile | Contents | Notes |
|---|---|---|
| **PROTOTYPE** | 1 knob, status LED on GPIO12 | No RGB, battery, VBUS, or charger. Battery & RGB values are simulated by the firmware. |
| **FINAL** | 2 knobs, 9× SK6812 MINI-E | RGB, 100k/100k battery divider, VBUS detection, MCP73831 charger, BLE HID. |

---

## Quick start

1. **Install the app** from the Releases page.
2. **Flash the firmware** to the board with the Arduino IDE. The same Board
   settings apply to both sketches:
   - Tools → USB Mode: `USB-OTG (TinyUSB)`
   - Tools → USB CDC On Boot: `Enabled`
   - Tools → Upload Mode: `USB-OTG CDC (TinyUSB)`
3. **Connect** the macro pad over USB. The app detects the port automatically;
   for BLE, pick the BLE transport in the connection panel and select the device.
4. **Configure** the keymap, knobs, and RGB. Press **Save** so the configuration
   is written to the device flash and survives a reboot.

---

## Build it yourself

Prerequisites: Node.js, Rust (stable), and the Tauri dependencies for Windows.

```bash
npm install
npm run tauri dev      # development mode
npm run tauri build    # produces an installer in src-tauri/target/release/bundle/
```

The firmware is compiled with `arduino-cli` (`esp32` core 3.3.8):

```bash
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/HID_Keypad_Final
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/HID_Keypad_Prototype
```

---

## Testing

```bash
npm test                           # all Node test suites
cd src-tauri; cargo test --lib     # Rust tests
npx vite build                     # frontend build
```

Latest results: 84 Rust tests green, `vite build` succeeds, both firmware sketches
compile, and 40 of 44 Node suites are green (the 4 red suites predate the 0.9.0
release, see [CHANGELOG](CHANGELOG.md)). On-device testing is still required for
what cannot be proven statically: enable-pin polarity, knob rotation direction,
and charger status.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Repo structure, app modules, import rules, data flow |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Serial commands, frame protocol v2, limits |
| [docs/STATUS-AND-TESTING.md](docs/STATUS-AND-TESTING.md) | Feature status, test procedures, hardware checklist |
| [CHANGELOG.md](CHANGELOG.md) | Change history per version (Indonesian) |
| [docs/HISTORY.md](docs/HISTORY.md) | Long-form release notes (archive) |

---

## License

Not set yet.
