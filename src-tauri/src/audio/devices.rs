//! Enumerasi dan pencarian device. Semua matching berbasis nama karena
//! cpal 0.15 di Windows tidak mengekspos endpoint ID yang stabil.

use crate::audio::types::{AudioDevices, DeviceInfo};
use cpal::traits::{DeviceTrait, HostTrait};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Cache nama device. Enumerasi WASAPI bisa blocking 100–500 ms; kalau
/// dipanggil dari `publish()` setiap command UI, engine thread bisa tersendat.
/// Cache pendek tetap mendeteksi hot-plug dalam hitungan detik.
const NAME_CACHE_TTL: Duration = Duration::from_secs(2);

struct NameCache {
    at: Instant,
    inputs: Vec<String>,
    outputs: Vec<String>,
}

fn name_cache() -> &'static Mutex<Option<NameCache>> {
    static CACHE: OnceLock<Mutex<Option<NameCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_names() -> (Vec<String>, Vec<String>) {
    let mut slot = name_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cache) = slot.as_ref() {
        if cache.at.elapsed() < NAME_CACHE_TTL {
            return (cache.inputs.clone(), cache.outputs.clone());
        }
    }

    let host = cpal::default_host();
    let mut inputs = Vec::new();
    if let Ok(iter) = host.input_devices() {
        for device in iter {
            if let Ok(name) = device.name() {
                inputs.push(name);
            }
        }
    }
    let mut outputs = Vec::new();
    if let Ok(iter) = host.output_devices() {
        for device in iter {
            if let Ok(name) = device.name() {
                outputs.push(name);
            }
        }
    }

    *slot = Some(NameCache {
        at: Instant::now(),
        inputs: inputs.clone(),
        outputs: outputs.clone(),
    });
    (inputs, outputs)
}

/// Samakan dengan aturan `find_output`/`find_input`: exact dulu, lalu contains.
fn name_matches(candidate: &str, target: &str) -> bool {
    let target = target.trim().to_lowercase();
    if target.is_empty() {
        return false;
    }
    let candidate = candidate.to_lowercase();
    candidate == target || candidate.contains(&target)
}

/// Endpoint playback VB-Cable ("CABLE Input"), bukan endpoint capture
/// ("CABLE Output") yang dipakai Discord.
fn is_cable_playback_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    if !lower.contains("cable") {
        return false;
    }
    if lower.contains("cable output") || lower.contains("cable-a output") {
        return false;
    }
    true
}

pub fn list() -> AudioDevices {
    let host = cpal::default_host();
    let default_out = host.default_output_device().and_then(|d| d.name().ok());
    let default_in = host.default_input_device().and_then(|d| d.name().ok());

    let mut inputs = Vec::new();
    if let Ok(iter) = host.input_devices() {
        for device in iter {
            if let Ok(name) = device.name() {
                inputs.push(DeviceInfo {
                    is_default: default_in.as_deref() == Some(name.as_str()),
                    is_input: true,
                    name,
                });
            }
        }
    }

    let mut outputs = Vec::new();
    if let Ok(iter) = host.output_devices() {
        for device in iter {
            if let Ok(name) = device.name() {
                outputs.push(DeviceInfo {
                    is_default: default_out.as_deref() == Some(name.as_str()),
                    is_input: false,
                    name,
                });
            }
        }
    }

    AudioDevices { inputs, outputs }
}

/// Cari output/playback device. Urutan: exact name, contains, lalu tidak ada.
pub fn find_output(device_name: &str) -> Option<(cpal::Device, String)> {
    let host = cpal::default_host();
    let iter = host.output_devices().ok()?;
    let target = device_name.trim().to_lowercase();
    if target.is_empty() {
        return None;
    }

    let mut contains: Option<(cpal::Device, String)> = None;
    for device in iter {
        let Ok(name) = device.name() else { continue };
        let lower = name.to_lowercase();
        if lower == target {
            return Some((device, name));
        }
        if contains.is_none() && lower.contains(&target) {
            contains = Some((device, name));
        }
    }
    contains
}

/// Cari input/capture device dengan aturan yang sama.
pub fn find_input(device_name: &str) -> Option<(cpal::Device, String)> {
    let host = cpal::default_host();
    let iter = host.input_devices().ok()?;
    let target = device_name.trim().to_lowercase();
    if target.is_empty() {
        return None;
    }

    let mut contains: Option<(cpal::Device, String)> = None;
    for device in iter {
        let Ok(name) = device.name() else { continue };
        let lower = name.to_lowercase();
        if lower == target {
            return Some((device, name));
        }
        if contains.is_none() && lower.contains(&target) {
            contains = Some((device, name));
        }
    }
    contains
}

/// Cari endpoint playback "CABLE Input" milik VB-Audio.
///
/// Catatan penting Windows: "CABLE Input" adalah *playback* endpoint (tempat
/// aplikasi menulis), sedangkan "CABLE Output" adalah *recording* endpoint yang
/// ditangkap Discord. Jangan tertukar.
pub fn find_cable_output() -> Option<(cpal::Device, String)> {
    let host = cpal::default_host();
    let iter = host.output_devices().ok()?;
    let mut fallback: Option<(cpal::Device, String)> = None;

    for device in iter {
        let Ok(name) = device.name() else { continue };
        if !is_cable_playback_name(&name) {
            continue;
        }
        let lower = name.to_lowercase();
        if lower.contains("input") || lower.contains("vb-audio") || lower.contains("virtual") {
            return Some((device, name));
        }
        if fallback.is_none() {
            fallback = Some((device, name));
        }
    }
    fallback
}

pub fn default_output() -> Option<(cpal::Device, String)> {
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let name = device.name().ok()?;
    Some((device, name))
}

pub fn default_input() -> Option<(cpal::Device, String)> {
    let host = cpal::default_host();
    let device = host.default_input_device()?;
    let name = device.name().ok()?;
    Some((device, name))
}

pub fn cable_present() -> bool {
    let (_, outputs) = cached_names();
    outputs.iter().any(|name| is_cable_playback_name(name))
}

pub fn output_present(device_name: &str) -> bool {
    let (_, outputs) = cached_names();
    outputs
        .iter()
        .any(|name| name_matches(name, device_name))
}

pub fn input_present(device_name: &str) -> bool {
    let (inputs, _) = cached_names();
    inputs
        .iter()
        .any(|name| name_matches(name, device_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_matches_exact_dan_contains() {
        assert!(name_matches("CABLE Input (VB-Audio Virtual Cable)", "cable input"));
        assert!(name_matches("Microphone (High Definition Audio Device)", "High Definition"));
        assert!(!name_matches("Speakers", "Microphone"));
        assert!(!name_matches("Speakers", "   "));
    }

    #[test]
    fn cable_playback_tidak_menganggap_endpoint_capture() {
        assert!(is_cable_playback_name("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(is_cable_playback_name("CABLE-A Input (VB-Audio Cable A)"));
        assert!(!is_cable_playback_name("CABLE Output (VB-Audio Virtual Cable)"));
        assert!(!is_cable_playback_name("CABLE-A Output (VB-Audio Cable A)"));
        assert!(!is_cable_playback_name("Speakers (Realtek)"));
    }
}
