//! Persistensi konfigurasi audio ke app_data_dir/audio-settings.json.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    /// Nama device output Discord (CABLE Input). Kosong = auto-deteksi.
    pub cable_device: String,
    /// Nama device monitor (speaker). Kosong = default output Windows.
    pub monitor_device: String,
    pub monitor_enabled: bool,
    pub monitor_volume: f32,
    pub mic_device: String,
    pub mic_enabled: bool,
    pub mic_gain: f32,
    /// Mic preprocessing filter — setiap filter bisa di-toggle & diatur kekuatannya.
    pub mic_pre: MicSettings,
    pub sfx_gain: f32,
    pub master_gain: f32,
    pub mic_muted: bool,
    pub sfx_muted: bool,
    pub mode: String,
    /// 0 = pakai default device. Selain itu = target buffer dalam ms.
    pub buffer_ms: u32,
}

/// Mic pre-processing filter settings.
/// Each filter can be toggled independently and its strength adjusted
/// for flexibility across different microphone hardware.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MicSettings {
    /// Amplifikasi dasar (1.0 = no boost, 5.0 = 5× gain).
    pub mic_boost: f32,
    /// Noise gate: filter out low-level noise when mic is idle.
    pub noise_gate_enabled: bool,
    /// Threshold dalam dBFS di bawah mana sinyal dianggap noise.
    pub noise_gate_threshold: f32,
    /// Attack/release dalam ms.
    pub noise_gate_attack_ms: f32,
    pub noise_gate_release_ms: f32,
    /// Compressor: perkecil dinamika untuk menjaga level konsisten.
    pub compressor_enabled: bool,
    /// Threshold dalam dBFS di atas mana kompresi diterapkan.
    pub compressor_threshold: f32,
    /// Ratio (2.0 = 2:1, 4.0 = 4:1, dst).
    pub compressor_ratio: f32,
    /// Makeup gain otomatis setelah kompresi (dB).
    pub compressor_makeup_gain: f32,
    /// Limiter: mencegah clipping digital.
    pub limiter_enabled: bool,
    /// Ceiling maksimum output (dBFS, biasanya 0.0 atau -0.5).
    pub limiter_ceiling: f32,
    /// 3-band EQ (low/mid/high) dalam dB.
    pub equalizer_enabled: bool,
    pub equalizer_low: f32,
    pub equalizer_mid: f32,
    pub equalizer_high: f32,
}

impl Default for MicSettings {
    fn default() -> Self {
        Self {
            mic_boost: 2.0,
            noise_gate_enabled: false,
            noise_gate_threshold: -45.0,
            noise_gate_attack_ms: 5.0,
            noise_gate_release_ms: 30.0,
            compressor_enabled: false,
            compressor_threshold: -25.0,
            compressor_ratio: 4.0,
            compressor_makeup_gain: 3.0,
            limiter_enabled: true,
            limiter_ceiling: -0.5,
            equalizer_enabled: false,
            equalizer_low: 0.0,
            equalizer_mid: 0.0,
            equalizer_high: 0.0,
        }
    }
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            cable_device: String::new(),
            monitor_device: String::new(),
            monitor_enabled: true,
            monitor_volume: 1.0,
            mic_device: String::new(),
            mic_enabled: false,
            mic_gain: 1.0,
            mic_pre: MicSettings::default(),
            sfx_gain: 1.0,
            master_gain: 1.0,
            mic_muted: false,
            sfx_muted: false,
            mode: "interrupt".into(),
            buffer_ms: 0,
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("audio-settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> AudioSettings {
    let Some(path) = settings_path(app) else {
        return AudioSettings::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("[audio] audio-settings.json tidak valid: {e}");
            AudioSettings::default()
        }),
        Err(_) => AudioSettings::default(),
    }
}

pub fn save(app: &tauri::AppHandle, settings: &AudioSettings) -> Result<(), String> {
    let path = settings_path(app).ok_or("path app data tidak tersedia")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
