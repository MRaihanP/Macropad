# Plan: Soundboard + Mic Mixing for Discord/Streaming (No Voicemeeter)

Status: **Rencana pengembangan** — belum diimplementasi.

## Gambaran Singkat

Soundboard saat ini bisa output ke system default audio device via Web Audio API. Untuk Discord/streaming yang membutuhkan **mikrofon + soundboard digabung dalam satu stream audio**, kita perlu satu kabel virtual saja (VB-Cable) dan semua mixing dilakukan di companion app (Rust WASAPI backend).

**Alur:** Soundboard audio + Mikrofon input → mixed di Rust WASAPI mixer → VB-Cable output → Discord input.

---

## Fase 1: Instalasi & Setup VB-Cable (Manual)

### 1.1. Download & Install VB-Cable
- **Untuk Windows:** Download VB-Cable dari [vb-audio.com](https://www.vb-audio.com/Cable/) (gratis, versi Virtual Only)
- **Driver yang terpasang:**
  - `CABLE Output` — muncul sebagai speaker/headphone device
  - `CABLE Input` — muncul sebagai microphone device
- **License:** Versi gratis sudah cukup untuk kebutuhan ini

### 1.2. Verifikasi instalasi
Di `Sound Settings` (Windows) → semua perangkat harus muncul:
```
Output (Speaker): 
- Headphones (Realtek USB)
- CABLE Output

Input (Mic):
- Microphone (Realtek USB)
- CABLE Input
```

### 1.3. Konfigurasi Discord (one-time setup)
1. Buka Discord → Settings → Voice & Video
2. Input Device → pilih **"CABLE Output"** (ini yang akan menerima mixed audio)
3. Output Device → biarkan "Headphones" atau pilih speaker biasa
4. Test: klik "Let's test" — dengar suara echo dari CABLE (ini expected, berarti routing sudah benar)

---

## Fase 2: Pengembangan Companion App (Rust WASAPI Backend)

### 2.1. Dependencies Cargo (`src-tauri/Cargo.toml`)

```toml
# Tambahkan ini di seksi [dependencies]
cpal = "0.15"          # Cross-platform audio (Windows: WASAPI, dukung low-latency)
# ATAU pakai wasapi-rs langsung jika butuh full control:
# wasapi = { version = "0.1", optional = true }
```

### 2.2. Implementasi Backend (`src-tauri/src/audio.rs` file baru)

```rust
use serde::{Serialize, Deserialize};
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize, Clone)]
pub struct AudioDeviceInfo {
    id: String,
    name: String,
    is_input: bool,   // true = mic/input device, false = output device
}

#[derive(Serialize, Clone, Default)]
pub struct AudioMixConfig {
    output_device_id: String,
    mic_device_id: String,
    mic_volume: f32,       // 0.0 - 1.0
    sound_volume: f32,     // 0.0 - 1.0
    include_mic: bool,
}

pub struct AudioManager {
    config: Mutex<AudioMixConfig>,
    // WASAPI streams akan disimpan di sini nanti
}

impl AudioManager {
    pub fn new() -> Self {
        AudioManager {
            config: Mutex::new(AudioMixConfig::default()),
        }
    }
}

// === TAUCHI COMMANDS ===

#[tauri::command]
fn audio_devices() -> Vec<AudioDeviceInfo> {
    // Gunakan cpal::traits::HostTrait untuk enum semua device
    let host = cpal::default_host();
    let mut devices = Vec::new();

    // Input devices (mikrofon)
    for dev in host.input_devices().flatten() {
        if let Ok(name) = dev.name() {
            devices.push(AudioDeviceInfo {
                id: dev.id().to_string(),
                name,
                is_input: true,
            });
        }
    }

    // Output devices (speaker/ VB-Cable)
    for dev in host.output_devices().flatten() {
        if let Ok(name) = dev.name() {
            devices.push(AudioDeviceInfo {
                id: dev.id().to_string(),
                name,
                is_input: false,
            });
        }
    }

    devices
}

#[tauri::command]
fn set_audio_output(state: State<AudioManager>, device_id: String) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.output_device_id = device_id;

    // TODO: (Re)initialize WASAPI render stream ke device baru
    // Ini akan trigger re-mix semua soundboard audio ke device ini

    Ok(())
}

#[tauri::command]
fn audio_set_mic(state: State<AudioManager>, device_id: String, volume: f32, enabled: bool) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();

    if enabled {
        if device_id.is_empty() {
            return Err("Device ID kosong".into());
        }
        cfg.mic_device_id = device_id;
    } else {
        cfg.mic_device_id.clear();
    }

    cfg.mic_volume = volume.clamp(0.0, 1.0);
    cfg.include_mic = enabled;

    // TODO: (Re)initialize WASAPI capture stream
    // Jika disable, hapus capture stream dan hanya kirim soundboard audio

    Ok(())
}

#[tauri::command]
fn audio_set_mix_levels(state: State<AudioManager>, mic_volume: f32, sound_volume: f32) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.mic_volume = mic_volume.clamp(0.0, 1.0);
    cfg.sound_volume = sound_volume.clamp(0.0, 1.0);
    // Mixing sudah berjalan di WASAPI worker thread — ini hanya update level
    Ok(())
}
```

### 2.3. Registrasi di `lib.rs`

```rust
mod audio;          // tambahkan
use audio::AudioManager;

// Di generate_handler():
audio_devices,
set_audio_output,
audio_set_mic,
audio_set_mix_levels,

// Di setup():
let audio_mgr = AudioManager::new();
tauri::async_runtime::spawn_blocking(move || {
    // Initialize WASAPI streams saat app start
    if let Err(e) = init_audio(&audio_mgr) {
        eprintln!("[audio] init gagal: {}", e);
    }
});
```

### 2.4. WASAPI Worker Thread Logic (konsep)

```rust
// Di audio.rs — ini worker thread yang menghubungkan:
// 1. Soundboard PCM bytes (dari soundboard_read)
// 2. Mikrofon PCM bytes (dari WASAPI capture)
// 3. Output ke CABLE Input atau device lain via WASAPI render

fn init_wasapi_render(target_device_id: &str) -> Result<(), String> {
    let host = cpal::default_host();
    let dev = host.output_device().map_err(|e| e.to_string())?;
    let cfg = dev.default_output_config().map_err(|e| e.to_string())?;

    let stream = dev.build_output_stream(
        &config.into(),
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            // Fill this buffer by mixing:
            //   - Pull soundboard PCM dari ring buffer (Rust-side)
            //   - Pull mic PCM dari capture buffer (Rust-side)
            //   - Apply volume multipliers
            //   - Write ke `data`
        },
        |err, _| eprintln!("audio err: {}", err),
        None,
    )?;

    Ok(())
}
```

### 2.5. Frontend Wiring (`soundboard.js` + `index.html`)

Di panel Settings → tambahan tab/section baru:

```javascript
// soundboard.js — export baru
export async function getAudioDevices() {
  return await invoke('audio_devices');
}

export async function setAudioOutput(id) {
  await invoke('set_audio_output', { deviceId: id });
}

export async function setMic(deviceId, volume, enabled) {
  await invoke('audio_set_mic', { deviceId, volume, enabled });
}

export async function setMixLevels(micVolume, soundVolume) {
  await invoke('audio_set_mix_levels', { micVolume, soundVolume });
}
```

#### HTML di `index.html` (di Settings page):

```html
<!-- Ditambahkan di <div id="page-settings"> -->
<div class="panel">
  <h2 data-i18n="settings.audio">Audio Output</h2>

  <!-- Pilih output device -->
  <div class="setting-row">
    <div>
      <div class="setting-name" data-i18n="settings.audioOutput">Audio Output Device</div>
      <div class="hint" data-i18n="settings.audioOutputHint">Pilih perangkat output. Untuk Discord, pilih "CABLE Output (VB-Cable)".</div>
    </div>
    <select id="audioOutputSelect"></select>
  </div>

  <!-- Include Mic toggle -->
  <div class="setting-row">
    <div>
      <div class="setting-name" data-i18n="settings.includeMic">Include Microphone</div>
      <div class="hint" data-i18n="settings.includeMicHint">Aktifkan untuk menggabungkan mikrofon dengan soundboard.</div>
    </div>
    <label class="toggle-switch"><input type="checkbox" id="micIncludeToggle"><span class="toggle-slider"></span></label>
  </div>

  <!-- Mikrofon device -->
  <div id="micDeviceRow" style="display:none;">
    <div class="setting-row">
      <div>
        <div class="setting-name" data-i18n="settings.micDevice">Microphone Device</div>
      </div>
      <select id="micDeviceSelect"></select>
    </div>

    <!-- Volume sliders -->
    <div class="setting-row">
      <label for="micVolume" data-i18n="settings.micVolume">Mic Volume</label>
      <input type="range" id="micVolume" min="0" max="100" value="70">
      <span id="micVolumeVal">70%</span>
    </div>
    <div class="setting-row">
      <label for="sfxVolume" data-i18n="settings.sfxVolume">Soundboard Volume</label>
      <input type="range" id="sfxVolume" min="0" max="100" value="90">
      <span id="sfxVolumeVal">90%</span>
    </div>
  </div>
</div>
```

#### I18n strings (en.js + id.js)

```javascript
'settings.audio': 'Audio Output',
'settings.audioOutput': 'Output Device',
'settings.audioOutputHint': 'Choose where the mixed audio goes. For Discord, select "CABLE Output (VB-Cable)".',
'settings.includeMic': 'Include Microphone',
'settings.includeMicHint': 'Mix your mic with soundboard audio into one stream.',
'settings.micDevice': 'Microphone Device',
'settings.micVolume': 'Mic Volume',
'settings.sfxVolume': 'Soundboard Volume',
'settings.vcableMissing': 'VB-Cable tidak terdeteksi. Instal dulu dari https://vb-audio.com/Cable/',
'audio.initError': 'Gagal inisialisasi audio device: {err}',
```

```javascript
'settings.audio': 'Keluaran Audio',
'settings.audioOutput': 'Perangkat Output',
'settings.audioOutputHint': 'Pilih ke mana mixed audio dikirim. Untuk Discord, pilih "CABLE Output (VB-Cable)".',
'settings.includeMic': 'Sertakan Mikrofon',
'settings.includeMicHint': 'Campurkan mikrofon dengan suara soundboard.',
'settings.micDevice': 'Perangkat Mikrofon',
'settings.micVolume': 'Volume Mic',
'settings.sfxVolume': 'Volume Soundboard',
'settings.vcableMissing': 'VB-Cable tidak terdeteksi. Instal dulu dari https://vb-audio.com/Cable/',
'audio.initError': 'Gagal inisialisasi audio device: {err}',
```

---

## Fase 3: CSS Styling (`src/styles.css`)

Tambahkan styling untuk volume sliders dan device selector di Settings page:

```css
/* Di styles.css tambahkan */
.setting-row input[type="range"] {
  flex: 1;
  margin: 0 8px;
  accent-color: var(--accent);
}

.setting-row input[type="range"] + span {
  min-width: 48px;
  text-align: right;
}
```

---

## Fase 4: Testing & Verification

### 4.1. Unit Test (Rust)
Bisa ditambahkan di `tests/` jika sudah implementasi — test device enumeration dan config update logic.

### 4.2. Manual Testing Flow
1. Install VB-Cable
2. Jalankan app, buka Settings → Audio Output
3. Output device dropdown harus list semua speaker + CABLE Output
4. Klik "Include Mic" → muncul mic device list + sliders
5. Pilih mikrofon input device + atur volume
6. Buka sound picker, pilih sound, tekan preview
7. Buka Discord → pilih "CABLE Output" sebagai input
8. Tekan tombol sound di device → dengar suara di Discord
9. Bicara ke mikrofon → dengar suara di Discord

### 4.3. Error Cases
| Kasus | Perilaku |
|---|---|
| VB-Cable tidak terinstall | Warning di Settings: "VB-Cable tidak terdeteksi. Instal dulu dari vb-audio.com/Cable/" |
| Mikrofon tidak terdeteksi | Dropdown mic kosong, disable "Include Mic" |
| Tidak ada soundboard files | Player tetap bisa di-set output, hanya tidak ada suara |
| App crash / restart | Semua setting persisten di localStorage + Rust config file |

---

## Urutan Implementasi (Timeline)

| Fase | Task | Estimasi | Keterbatasan |
|---|---|---|---|
| Week 1 | Instalasi VB-Cable, UI skeleton di Settings | 2 hari | Perlu dependency cpal |
| Week 2 | WASAPI backend (enum + render stream) | 3 hari | Latency tuning |
| Week 3 | WASAPI capture + mixing logic | 3 hari | Buffer management |
| Week 4 | UI wiring + sliders + testing | 2 hari | Manual test only |

---

## Catatan Teknis

- **Latency target:** render + capture < 50ms total agar tidak noticeable saat live streaming
- **Sample format:** Pakailah selalu `f32 48kHz stereo` untuk semua stream — ini standard Discord
- **Mutex usage:** Semua config (device ID, volume) harus thread-safe antara UI thread dan WASAPI worker thread
- **Fallback:** Jika tidak ada VB-Cable, arahkan output langsung ke Headphones (user bisa manual route di Windows Sound Settings)

## Dependencies (tambahan yang perlu diinstall user)

| Komponen | Link | Free/Paid |
|---|---|---|
| VB-Cable | https://vb-audio.com/Cable/ | Gratis |
| cpal crate | di Cargo.toml | Gratis |

**Total dependency eksternal: 1 (VB-Cable saja, install sekali).**

Semua mixing logic, device enumeration, dan kontrol volume akan ben-benar ter-integrasi di companion app.
