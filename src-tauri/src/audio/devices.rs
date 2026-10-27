//! Enumerasi dan pencarian device. Semua matching berbasis nama karena
//! cpal 0.15 di Windows tidak mengekspos endpoint ID yang stabil.

use crate::audio::types::{AudioDevices, DeviceInfo};
use cpal::traits::{DeviceTrait, HostTrait};

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
        let lower = name.to_lowercase();
        if !lower.contains("cable") {
            continue;
        }
        // Endpoint capture tidak boleh dipakai sebagai output.
        if lower.contains("cable output") || lower.contains("cable-a output") {
            continue;
        }
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
    find_cable_output().is_some()
}

pub fn output_present(device_name: &str) -> bool {
    find_output(device_name).is_some()
}

pub fn input_present(device_name: &str) -> bool {
    find_input(device_name).is_some()
}
