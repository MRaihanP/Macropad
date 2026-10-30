//! Audio engine v2.
//!
//! Semua stream cpal dimiliki oleh satu engine thread. UI berkomunikasi lewat
//! command di modul ini; hasil meter/status dikirim sebagai event Tauri.

pub mod decode;
pub mod devices;
pub mod engine;
pub mod mic_dsp;
pub mod mixer;
pub mod output;
pub mod resample;
pub mod ring;
pub mod settings;
pub mod types;

pub use engine::AudioEngine;

use crate::audio::types::{AudioDevices, AudioState, Bus, PlayMode, ToneTarget};
use crate::audio::settings::MicSettings;
use serde::Serialize;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn audio_devices() -> AudioDevices {
    devices::list()
}

#[tauri::command]
pub fn audio_state(engine: State<'_, AudioEngine>) -> AudioState {
    engine.snapshot()
}

#[tauri::command]
pub fn audio_set_output(engine: State<'_, AudioEngine>, device: String) -> Result<(), String> {
    engine.set_output(device)
}

#[tauri::command]
pub fn audio_set_monitor(
    engine: State<'_, AudioEngine>,
    device: String,
    enabled: bool,
    volume: f32,
) -> Result<(), String> {
    engine.set_monitor(device, enabled, volume)
}

#[tauri::command]
pub fn audio_set_monitor_sfx_only(
    engine: State<'_, AudioEngine>,
    only: bool,
) -> Result<(), String> {
    engine.set_monitor_sfx_only(only)
}

#[tauri::command]
pub fn audio_set_mic(
    engine: State<'_, AudioEngine>,
    device: String,
    enabled: bool,
    gain: f32,
) -> Result<(), String> {
    engine.set_mic(device, enabled, gain)
}

#[tauri::command]
pub fn audio_set_mic_pre(
    engine: State<'_, AudioEngine>,
    settings: MicSettings,
) -> Result<(), String> {
    engine.set_mic_pre(settings)
}

#[tauri::command]
pub fn audio_set_gain(
    engine: State<'_, AudioEngine>,
    bus: String,
    value: f32,
) -> Result<(), String> {
    let bus = Bus::parse(&bus).ok_or_else(|| format!("bus tidak dikenal: {bus}"))?;
    engine.set_gain(bus, value)
}

#[tauri::command]
pub fn audio_set_mute(
    engine: State<'_, AudioEngine>,
    bus: String,
    muted: bool,
) -> Result<(), String> {
    let bus = Bus::parse(&bus).ok_or_else(|| format!("bus tidak dikenal: {bus}"))?;
    engine.set_mute(bus, muted)
}

#[tauri::command]
pub fn audio_set_mode(engine: State<'_, AudioEngine>, mode: String) -> Result<(), String> {
    engine.set_mode(PlayMode::parse(&mode))
}

#[tauri::command]
pub fn audio_set_buffer(engine: State<'_, AudioEngine>, ms: u32) -> Result<(), String> {
    engine.set_buffer(ms)
}

#[tauri::command]
pub fn audio_test_tone(
    engine: State<'_, AudioEngine>,
    target: String,
    freq: f32,
    duration_ms: u32,
) -> Result<(), String> {
    engine.test_tone(ToneTarget::parse(&target), freq, duration_ms)
}

#[tauri::command]
pub async fn audio_play(
    app: AppHandle,
    engine: State<'_, AudioEngine>,
    id: String,
) -> Result<(), String> {
    // Baca gain di sini (di luar spawn_blocking) karena entry.volume adalah
    // bagian dari metadata sounds.json, bukan hasil decode. Gain diterapkan
    // di play-time sehingga perubahan volume tidak memicu decode ulang.
    let gain = crate::load_sounds(&app)
        .sounds
        .iter()
        .find(|sound| sound.id == id)
        .map(|entry| entry.volume)
        .unwrap_or(1.0);
    let engine = engine.inner().clone();
    let clip = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let id = id.clone();
        move || decode::load_clip(&app, &id)
    })
    .await
    .map_err(|e| format!("decode task gagal: {e}"))??;
    engine.play(id, clip, gain)
}

#[tauri::command]
pub fn audio_stop(engine: State<'_, AudioEngine>, id: Option<String>) -> Result<(), String> {
    engine.stop(id)
}

// ==================== MIC DSP PRESETS (Fase 7) ====================

/// Satu preset mic DSP. `id` dipakai UI untuk menampilkan dan memilih.
#[derive(Clone, Debug, Serialize)]
pub struct MicPreset {
    id: String,
    name: String,
    settings: MicSettings,
}

/// Tiga preset built-in yang disetujui di docs/mic-dsp-plan.md (Fase 7).
fn mic_presets() -> Vec<MicPreset> {
    let base = MicSettings::default();

    // Podcast/Voice: boost +6, denoise 80%, gate on, EQ +2/+1/+2, comp 3:1 -18
    let podcast = MicPreset {
        id: "podcast".into(),
        name: "Podcast / Voice".into(),
        settings: MicSettings {
            mic_boost_db: 6.0,
            denoise_enabled: true,
            denoise_mix: 0.8,
            noise_gate_enabled: true,
            noise_gate_threshold: -42.0,
            noise_gate_range_db: -50.0,
            equalizer_enabled: true,
            equalizer_low: 2.0,
            equalizer_mid: 1.0,
            equalizer_high: 2.0,
            compressor_enabled: true,
            compressor_threshold: -18.0,
            compressor_ratio: 3.0,
            compressor_makeup_gain: 3.0,
            limiter_enabled: true,
            limiter_ceiling: -0.5,
            ..base
        },
    };

    // Game chat: boost +12, denoise 100%, gate on, EQ -2/+2/0, comp 4:1 -20
    let game = MicPreset {
        id: "game".into(),
        name: "Game chat".into(),
        settings: MicSettings {
            mic_boost_db: 12.0,
            denoise_enabled: true,
            denoise_mix: 1.0,
            noise_gate_enabled: true,
            noise_gate_threshold: -38.0,
            noise_gate_range_db: -60.0,
            equalizer_enabled: true,
            equalizer_low: -2.0,
            equalizer_mid: 2.0,
            equalizer_high: 0.0,
            compressor_enabled: true,
            compressor_threshold: -20.0,
            compressor_ratio: 4.0,
            compressor_makeup_gain: 4.0,
            limiter_enabled: true,
            limiter_ceiling: -0.5,
            ..base
        },
    };

    // Noisy room: boost +9, denoise 100%, gate on, EQ -3/+2/+1, comp 3:1 -18
    let noisy = MicPreset {
        id: "noisy".into(),
        name: "Noisy room".into(),
        settings: MicSettings {
            mic_boost_db: 9.0,
            denoise_enabled: true,
            denoise_mix: 1.0,
            noise_gate_enabled: true,
            noise_gate_threshold: -32.0,
            noise_gate_range_db: -60.0,
            equalizer_enabled: true,
            equalizer_low: -3.0,
            equalizer_mid: 2.0,
            equalizer_high: 1.0,
            compressor_enabled: true,
            compressor_threshold: -18.0,
            compressor_ratio: 3.0,
            compressor_makeup_gain: 3.0,
            limiter_enabled: true,
            limiter_ceiling: -1.0,
            limiter_release_ms: 50.0,
            ..base
        },
    };

    vec![podcast, game, noisy]
}

#[tauri::command]
pub fn audio_mic_presets() -> Vec<MicPreset> {
    mic_presets()
}

/// Terapkan preset ke engine. Frontend memanggil ini setelah user pilih preset.
#[tauri::command]
pub fn audio_apply_mic_preset(engine: State<'_, AudioEngine>, id: String) -> Result<MicSettings, String> {
    let preset = mic_presets()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("preset mic tidak dikenal: {id}"))?;
    engine.set_mic_pre(preset.settings)?;
    Ok(preset.settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mic_presets_sesuai_spec() {
        let presets = mic_presets();
        assert_eq!(presets.len(), 3, "harus ada 3 preset");

        // Podcast / Voice
        let podcast = presets.iter().find(|p| p.id == "podcast").unwrap();
        assert_eq!(podcast.name, "Podcast / Voice");
        let s = &podcast.settings;
        assert_eq!(s.mic_boost_db, 6.0);
        assert!(s.denoise_enabled);
        assert!((s.denoise_mix - 0.8).abs() < 0.01);
        assert!(s.noise_gate_enabled);
        assert!((s.noise_gate_threshold - (-42.0)).abs() < 0.01);
        assert_eq!(s.equalizer_low, 2.0);
        assert_eq!(s.equalizer_mid, 1.0);
        assert_eq!(s.equalizer_high, 2.0);
        assert_eq!(s.compressor_threshold, -18.0);
        assert_eq!(s.compressor_ratio, 3.0);

        // Game chat
        let game = presets.iter().find(|p| p.id == "game").unwrap();
        assert_eq!(game.name, "Game chat");
        let s = &game.settings;
        assert_eq!(s.mic_boost_db, 12.0);
        assert!((s.denoise_mix - 1.0).abs() < 0.01);
        assert!((s.noise_gate_threshold - (-38.0)).abs() < 0.01);
        assert_eq!(s.equalizer_low, -2.0);
        assert_eq!(s.compressor_ratio, 4.0);

        // Noisy room
        let noisy = presets.iter().find(|p| p.id == "noisy").unwrap();
        assert_eq!(noisy.name, "Noisy room");
        let s = &noisy.settings;
        assert_eq!(s.mic_boost_db, 9.0);
        assert!((s.noise_gate_threshold - (-32.0)).abs() < 0.01);
        assert_eq!(s.equalizer_low, -3.0);
        assert_eq!(s.limiter_ceiling, -1.0);
    }
}
