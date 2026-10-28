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
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
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
    pub noise_gate_hold_ms: f32,
    /// Jarak threshold buka dan tutup (dB). Mencegah gate berkedip.
    pub noise_gate_hysteresis_db: f32,
    /// Redaman saat gate tertutup (dB, negatif). -50 = turun 50 dB.
    pub noise_gate_range_db: f32,
    /// Noise gate strength: 1.0 = gentle, 20.0 = aggressive reduction.
    pub noise_gate_ratio: f32,
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
            noise_gate_attack_ms: 8.0,
            noise_gate_release_ms: 220.0,
            noise_gate_hold_ms: 150.0,
            noise_gate_hysteresis_db: 6.0,
            noise_gate_range_db: -50.0,
            noise_gate_ratio: 10.0,
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

impl MicSettings {
    /// Buang nilai tidak valid dari JSON/UI dan clamp ke rentang DSP.
    /// Dipanggil saat load, saat command dari UI, dan saat preset diterapkan.
    pub fn sanitize(&mut self) {
        let d = MicSettings::default();
        let clean = |value: f32, fallback: f32| {
            if value.is_finite() {
                value
            } else {
                fallback
            }
        };

        // mic_boost masih linear sampai Fase 1 (migrasi ke dB).
        self.mic_boost = clean(self.mic_boost, d.mic_boost).clamp(0.0, 10.0);

        self.noise_gate_threshold = clean(self.noise_gate_threshold, d.noise_gate_threshold)
            .clamp(-80.0, -10.0);
        self.noise_gate_attack_ms = clean(self.noise_gate_attack_ms, d.noise_gate_attack_ms)
            .clamp(1.0, 50.0);
        self.noise_gate_release_ms = clean(self.noise_gate_release_ms, d.noise_gate_release_ms)
            .clamp(10.0, 1000.0);
        self.noise_gate_hold_ms = clean(self.noise_gate_hold_ms, d.noise_gate_hold_ms)
            .clamp(0.0, 500.0);
        self.noise_gate_hysteresis_db =
            clean(self.noise_gate_hysteresis_db, d.noise_gate_hysteresis_db).clamp(0.0, 12.0);
        // Range selalu negatif supaya gate tidak pernah menguatkan noise.
        self.noise_gate_range_db =
            clean(self.noise_gate_range_db, d.noise_gate_range_db).clamp(-80.0, -30.0);
        self.noise_gate_ratio = clean(self.noise_gate_ratio, d.noise_gate_ratio).clamp(1.0, 20.0);

        self.compressor_threshold =
            clean(self.compressor_threshold, d.compressor_threshold).clamp(-60.0, 0.0);
        self.compressor_ratio = clean(self.compressor_ratio, d.compressor_ratio).clamp(1.0, 20.0);
        self.compressor_makeup_gain =
            clean(self.compressor_makeup_gain, d.compressor_makeup_gain).clamp(0.0, 24.0);

        self.limiter_ceiling = clean(self.limiter_ceiling, d.limiter_ceiling).clamp(-6.0, 0.0);

        self.equalizer_low = clean(self.equalizer_low, 0.0).clamp(-12.0, 12.0);
        self.equalizer_mid = clean(self.equalizer_mid, 0.0).clamp(-12.0, 12.0);
        self.equalizer_high = clean(self.equalizer_high, 0.0).clamp(-12.0, 12.0);
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
        Ok(text) => {
            let mut settings: AudioSettings = serde_json::from_str(&text).unwrap_or_else(|e| {
                eprintln!("[audio] audio-settings.json tidak valid: {e}");
                AudioSettings::default()
            });
            settings.mic_pre.sanitize();
            settings
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_menolak_nan_dan_clamp_rentang() {
        let mut s = MicSettings::default();
        s.mic_boost = f32::NAN;
        s.noise_gate_threshold = -200.0;
        s.noise_gate_hold_ms = -5.0;
        s.noise_gate_range_db = 12.0; // positif = salah, harus negatif
        s.noise_gate_hysteresis_db = 99.0;
        s.equalizer_low = 100.0;
        s.limiter_ceiling = 3.0;

        s.sanitize();

        assert_eq!(s.mic_boost, MicSettings::default().mic_boost);
        assert_eq!(s.noise_gate_threshold, -80.0);
        assert_eq!(s.noise_gate_hold_ms, 0.0);
        assert_eq!(s.noise_gate_range_db, -30.0);
        assert_eq!(s.noise_gate_hysteresis_db, 12.0);
        assert_eq!(s.equalizer_low, 12.0);
        assert_eq!(s.limiter_ceiling, 0.0);
    }

    #[test]
    fn sanitize_idempoten() {
        let mut s = MicSettings::default();
        s.sanitize();
        let once = s;
        s.sanitize();
        assert_eq!(once.mic_boost, s.mic_boost);
        assert_eq!(once.noise_gate_range_db, s.noise_gate_range_db);
        assert_eq!(once.noise_gate_hold_ms, s.noise_gate_hold_ms);
    }
}
