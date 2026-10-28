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
