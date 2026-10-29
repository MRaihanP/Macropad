//! Persistensi konfigurasi audio ke app_data_dir/audio-settings.json.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// Versi skema file settings. Naikkan setiap kali arti field berubah.
///
/// - 0 (file lama tanpa `version`): `micPre.micBoost` masih linear.
/// - 1: `micPre.micBoostDb` (dB) + `micPre.humNotchHz`.
/// - 2: `micPre.limiterReleaseMs` (default 50 ms).
/// - 3: `micPre.noiseFilterEnabled` (de-click + low-pass hiss, default aktif).
pub const SETTINGS_VERSION: u32 = 3;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    /// Versi skema. File lama tidak punya field ini dan dibaca sebagai 0.
    pub version: u32,
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
    /// Boost dalam dB (0…+20). 0 = unity, +6 dB ≈ 2×.
    pub mic_boost_db: f32,
    /// Hum notch: 0 = off, 50/100/150 Hz. Nilai lain di-snap saat sanitize.
    pub hum_notch_hz: f32,
    /// Denoise RNNoise. Mix 0..1 = wet/dry.
    pub denoise_enabled: bool,
    pub denoise_mix: f32,
    /// Filter kabel/konektor sebelum denoise: de-click impulsif + low-pass
    /// untuk meredam desis (hiss) broadband.
    pub noise_filter_enabled: bool,
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
    /// Release limiter dalam ms. Semakin cepat = lebih agresif.
    pub limiter_release_ms: f32,
    /// 3-band EQ (low/mid/high) dalam dB.
    pub equalizer_enabled: bool,
    pub equalizer_low: f32,
    pub equalizer_mid: f32,
    pub equalizer_high: f32,
}

impl Default for MicSettings {
    fn default() -> Self {
        Self {
            mic_boost_db: 6.0,
            hum_notch_hz: 50.0,
            denoise_enabled: true,
            denoise_mix: 1.0,
            noise_filter_enabled: true,
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
            limiter_release_ms: 50.0,
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

        // Boost dalam dB: 0 = unity, +20 dB = 10×.
        self.mic_boost_db = clean(self.mic_boost_db, d.mic_boost_db).clamp(0.0, 20.0);
        // Notch hanya punya tiga frekuensi; nilai lain di-snap ke yang terdekat.
        self.hum_notch_hz = match clean(self.hum_notch_hz, 0.0) {
            hz if hz <= 0.0 => 0.0,
            hz if hz < 75.0 => 50.0,
            hz if hz < 125.0 => 100.0,
            _ => 150.0,
        };
        // Mix denoise datang dari JSON/UI; NaN atau nilai di luar 0..1 bisa
        // membuat sinyal wet/dry tidak seimbang.
        self.denoise_mix = clean(self.denoise_mix, d.denoise_mix).clamp(0.0, 1.0);

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
        self.limiter_release_ms = clean(self.limiter_release_ms, d.limiter_release_ms).clamp(5.0, 500.0);

        self.equalizer_low = clean(self.equalizer_low, 0.0).clamp(-12.0, 12.0);
        self.equalizer_mid = clean(self.equalizer_mid, 0.0).clamp(-12.0, 12.0);
        self.equalizer_high = clean(self.equalizer_high, 0.0).clamp(-12.0, 12.0);
    }
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
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

/// Migrasi file lama ke skema terbaru, dilakukan pada `serde_json::Value`
/// supaya field deprecated tidak perlu hidup di struct.
///
/// Versi 0: `micPre.micBoost` linear → `micPre.micBoostDb` (dB).
/// Versi 1: tidak ada perubahan skema — hanya versi ditulis.
/// Versi 2: `micPre.limiterReleaseMs` (default 50 ms).
fn migrate(value: &mut serde_json::Value) {
    let from = value
        .get("version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;

    if from < 1 {
        if let Some(mic) = value.get_mut("micPre").and_then(|m| m.as_object_mut()) {
            if !mic.contains_key("micBoostDb") {
                // 20*log10(linear); linear 0/negatif tidak punya arti → unity.
                let db = mic
                    .get("micBoost")
                    .and_then(|v| v.as_f64())
                    .filter(|linear| *linear > 0.0)
                    .map(|linear| (20.0 * linear.log10()).clamp(0.0, 20.0))
                    .unwrap_or(6.0);
                mic.insert("micBoostDb".into(), serde_json::json!(db));
            }
            mic.remove("micBoost");
        }
    }

    if from < 2 {
        if let Some(mic) = value.get_mut("micPre").and_then(|m| m.as_object_mut()) {
            if !mic.contains_key("limiterReleaseMs") {
                mic.insert("limiterReleaseMs".into(), serde_json::json!(50.0));
            }
        }
    }

    if let Some(object) = value.as_object_mut() {
        object.insert("version".into(), serde_json::json!(SETTINGS_VERSION));
    }
}

pub fn load(app: &tauri::AppHandle) -> AudioSettings {
    let Some(path) = settings_path(app) else {
        return AudioSettings::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return AudioSettings::default();
    };

    let mut value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[audio] audio-settings.json tidak valid: {error}");
            return AudioSettings::default();
        }
    };
    migrate(&mut value);

    let mut settings: AudioSettings = match serde_json::from_value(value) {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("[audio] audio-settings.json tidak bisa dipakai: {error}");
            AudioSettings::default()
        }
    };
    settings.mic_pre.sanitize();
    settings
}

pub fn save(app: &tauri::AppHandle, settings: &AudioSettings) -> Result<(), String> {
    let path = settings_path(app).ok_or("path app data tidak tersedia")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Selalu tulis versi terbaru, apa pun nilai di struct.
    let mut value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    if let Some(object) = value.as_object_mut() {
        object.insert("version".into(), serde_json::json!(SETTINGS_VERSION));
    }
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
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
        s.mic_boost_db = f32::NAN;
        s.hum_notch_hz = 77.0;
        s.noise_gate_threshold = -200.0;
        s.noise_gate_hold_ms = -5.0;
        s.noise_gate_range_db = 12.0; // positif = salah, harus negatif
        s.noise_gate_hysteresis_db = 99.0;
        s.equalizer_low = 100.0;
        s.limiter_ceiling = 3.0;

        s.sanitize();

        assert_eq!(s.mic_boost_db, MicSettings::default().mic_boost_db);
        assert_eq!(s.hum_notch_hz, 100.0);
        assert_eq!(s.noise_gate_threshold, -80.0);
        assert_eq!(s.noise_gate_hold_ms, 0.0);
        assert_eq!(s.noise_gate_range_db, -30.0);
        assert_eq!(s.noise_gate_hysteresis_db, 12.0);
        assert_eq!(s.equalizer_low, 12.0);
        assert_eq!(s.limiter_ceiling, 0.0);
    }

    #[test]
    fn sanitize_memilih_notch_terdekat() {
        let mut s = MicSettings::default();

        s.hum_notch_hz = -10.0;
        s.sanitize();
        assert_eq!(s.hum_notch_hz, 0.0);

        s.hum_notch_hz = 60.0;
        s.sanitize();
        assert_eq!(s.hum_notch_hz, 50.0);

        s.hum_notch_hz = 200.0;
        s.sanitize();
        assert_eq!(s.hum_notch_hz, 150.0);
    }

    #[test]
    fn sanitize_idempoten() {
        let mut s = MicSettings::default();
        s.sanitize();
        let once = s;
        s.sanitize();
        assert_eq!(once.mic_boost_db, s.mic_boost_db);
        assert_eq!(once.hum_notch_hz, s.hum_notch_hz);
        assert_eq!(once.noise_gate_range_db, s.noise_gate_range_db);
        assert_eq!(once.noise_gate_hold_ms, s.noise_gate_hold_ms);
    }

    #[test]
    fn migrasi_boost_linear_ke_db() {
        // File Fase 0: micBoost linear 2.0, tanpa `version`.
        let mut value = serde_json::json!({
            "micPre": { "micBoost": 2.0, "noiseGateThreshold": -45.0 }
        });

        migrate(&mut value);

        let db = value["micPre"]["micBoostDb"].as_f64().unwrap();
        assert!((db - 6.0206).abs() < 0.01, "micBoostDb = {db}");
        assert_eq!(value["version"].as_u64(), Some(SETTINGS_VERSION as u64));
        assert!(value["micPre"].get("micBoost").is_none());
    }

    #[test]
    fn migrasi_tidak_menimpa_mic_boost_db() {
        let mut value = serde_json::json!({
            "version": 2,
            "micPre": { "micBoostDb": 12.5 }
        });

        migrate(&mut value);

        assert_eq!(value["micPre"]["micBoostDb"].as_f64(), Some(12.5));
        assert_eq!(value["version"].as_u64(), Some(SETTINGS_VERSION as u64));
    }

    #[test]
    fn sanitize_denoise_mix_di_clamp_0_sampai_1() {
        let mut s = MicSettings::default();

        s.denoise_mix = f32::NAN;
        s.sanitize();
        assert_eq!(s.denoise_mix, MicSettings::default().denoise_mix);

        s.denoise_mix = 4.0;
        s.sanitize();
        assert_eq!(s.denoise_mix, 1.0);

        s.denoise_mix = -2.0;
        s.sanitize();
        assert_eq!(s.denoise_mix, 0.0);
    }

    #[test]
    fn migrasi_file_baru_tanpa_mic_pre_memakai_default() {
        let mut value = serde_json::json!({ "masterGain": 0.5 });

        migrate(&mut value);

        assert_eq!(value["version"].as_u64(), Some(SETTINGS_VERSION as u64));
        let settings: AudioSettings = serde_json::from_value(value).unwrap();
        assert_eq!(settings.mic_pre.mic_boost_db, 6.0);
        assert_eq!(settings.mic_pre.hum_notch_hz, 50.0);
    }

    #[test]
    fn file_fase_0_lengkap_terbaca_setelah_migrasi() {
        let mut value = serde_json::json!({
            "monitorEnabled": false,
            "micPre": {
                "micBoost": 3.0,
                "noiseGateEnabled": true,
                "noiseGateThreshold": -50.0,
                "noiseGateAttackMs": 5.0,
                "noiseGateReleaseMs": 30.0,
                "noiseGateHoldMs": 100.0,
                "noiseGateRatio": 10.0
            }
        });

        migrate(&mut value);
        let metrics: AudioSettings = serde_json::from_value(value).unwrap();

        assert!(!metrics.monitor_enabled);
        assert!((metrics.mic_pre.mic_boost_db - 9.5424).abs() < 0.001);
        assert!(metrics.mic_pre.noise_gate_enabled);
        // Field baru yang tidak ada di file lama memakai default.
        assert_eq!(metrics.mic_pre.noise_gate_hysteresis_db, 6.0);
        assert_eq!(metrics.mic_pre.noise_gate_range_db, -50.0);
    }

    #[test]
    fn default_hum_notch_50hz_menekan_buzz_listrik() {
        // 50 Hz notch default: file lama tanpa humNotchHz memetekan 50 Hz.
        let s = MicSettings::default();
        assert_eq!(s.hum_notch_hz, 50.0, "notch 50 Hz harus default untuk filter buzz listrik");
    }
}
