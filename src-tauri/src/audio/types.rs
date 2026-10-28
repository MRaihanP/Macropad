//! DTO yang dipakai lintas thread dan dikirim ke UI (serde).

use crate::audio::settings::MicSettings;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub is_input: bool,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct AudioDevices {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StreamStatus {
    pub role: String,
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: String,
    pub state: String,
    pub underruns: u64,
    pub buffer_ms: Option<u32>,
    pub error: Option<String>,
}

impl StreamStatus {
    pub fn stopped(role: &str, error: Option<String>) -> Self {
        Self {
            role: role.to_string(),
            device: String::new(),
            sample_rate: 0,
            channels: 0,
            format: String::new(),
            state: "stopped".into(),
            underruns: 0,
            buffer_ms: None,
            error,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    pub cable_device: String,
    pub cable_auto: bool,
    pub cable_present: bool,
    pub monitor_device: String,
    pub monitor_enabled: bool,
    pub monitor_volume: f32,
    pub mic_device: String,
    pub mic_enabled: bool,
    pub mic_gain: f32,
    pub sfx_gain: f32,
    pub master_gain: f32,
    pub mic_muted: bool,
    pub sfx_muted: bool,
    pub mode: String,
    pub buffer_ms: u32,
    /// Setting mic pre yang benar-benar dipakai engine. UI memakai ini untuk
    /// hidrasi awal supaya nilai tersimpan tidak tertimpa nilai hardcoded.
    pub mic_pre: MicSettings,
    pub streams: Vec<StreamStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelFrame {
    pub mic: f32,
    pub sfx: f32,
    pub master: f32,
    pub voices: u32,
    pub cable_underruns: u64,
    pub monitor_underruns: u64,
    /// Peak input mic sebelum chain (dBFS, -100 = silence).
    pub mic_in_db: f32,
    /// Envelope detektor gate (post-notch, sidechain 100 Hz–4 kHz, pre-gate).
    /// Dipakai UI untuk "learn noise floor".
    pub gate_in_db: f32,
    pub gate_open: bool,
    /// Gain gate saat ini (dB, 0 = terbuka penuh).
    pub gate_gain_db: f32,
    /// Gain reduction compressor (dB, >= 0).
    pub comp_gr_db: f32,
    /// Gain reduction limiter (dB, >= 0).
    pub limiter_gr_db: f32,
    /// Probabilitas voice dari RNNoise (0 = belum aktif).
    pub vad: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayMode {
    Interrupt,
    Mix,
}

impl PlayMode {
    pub fn as_str(self) -> &'static str {
        match self {
            PlayMode::Interrupt => "interrupt",
            PlayMode::Mix => "mix",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "mix" => PlayMode::Mix,
            _ => PlayMode::Interrupt,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bus {
    Mic,
    Sfx,
    Master,
    Monitor,
}

impl Bus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "mic" => Some(Bus::Mic),
            "sfx" => Some(Bus::Sfx),
            "master" => Some(Bus::Master),
            "monitor" => Some(Bus::Monitor),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToneTarget {
    Cable,
    Monitor,
    Both,
}

impl ToneTarget {
    pub fn parse(value: &str) -> Self {
        match value {
            "monitor" => ToneTarget::Monitor,
            "both" => ToneTarget::Both,
            _ => ToneTarget::Cable,
        }
    }
    pub fn cable(self) -> bool {
        matches!(self, ToneTarget::Cable | ToneTarget::Both)
    }
    pub fn monitor(self) -> bool {
        matches!(self, ToneTarget::Monitor | ToneTarget::Both)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_frame_serializes_camel_case_untuk_ui() {
        let frame = LevelFrame {
            mic: 0.5,
            sfx: 0.25,
            master: 0.75,
            voices: 1,
            cable_underruns: 2,
            monitor_underruns: 3,
            mic_in_db: -20.0,
            gate_in_db: -35.0,
            gate_open: true,
            gate_gain_db: 0.0,
            comp_gr_db: 3.5,
            limiter_gr_db: 1.5,
            vad: 0.9,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"micInDb\":-20.0"), "{json}");
        assert!(json.contains("\"gateOpen\":true"), "{json}");
        assert!(json.contains("\"compGrDb\":3.5"), "{json}");
        assert!(json.contains("\"limiterGrDb\":1.5"), "{json}");
        assert!(json.contains("\"cableUnderruns\":2"), "{json}");
    }
}
