// ==================== AUDIO MANAGER (Fase 2A-2C: device enumeration, WASAPI routing + mixing) ===================
//
// Isolasi maksimal: cpal WASAPI streams hanya di-init ketika user mengaktifkan
// VB-Cable routing / mikrofon — bukan di startup. Stream !Send hidup di dalam
// worker thread scope; kontrol via Arc<AtomicBool>. BLE tokio worker + Web Audio
// tidak tersentuh karena semua WASAPI I/O terisolasi di thread terpisah.
//
// Dual-path mixing:
//   - Soundboard PCM  → ring_buffer (via audio_enqueue, dari Web Audio thread)
//   - Mic input       → mic_buffer  (via WASAPI capture worker thread)
//   - Mixing          → render callback (ring_buffer + mic_buffer, scaled by volume)
//   - Output          → WASAPI render stream → CABLE Input (untuk Discord)

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

/// Device audio yang terdeteksi oleh cpal.
#[derive(Serialize, Clone, Debug)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_input: bool, // true = mic/input, false = output (speaker / vb-cable output)
}

/// Konfigurasi mixing audio.
#[derive(Serialize, Clone, Default, Debug)]
pub struct AudioMixConfig {
    pub output_device_id: String,
    pub mic_device_id: String,
    pub mic_volume: f32,
    pub sound_volume: f32,
    pub include_mic: bool,
    pub vb_cable_routing: bool,      // Fase 2B: toggle route ke CABLE Input
}

/// Ring buffer: Arc<Mutex<VecDeque<i16>>>.
type RingBuffer = Arc<Mutex<VecDeque<i16>>>;



/// State manager untuk audio config + WASAPI worker thread (thread-safe & Send).
pub struct AudioManager {
    pub config: Mutex<AudioMixConfig>,
    pub ring_buffer: RingBuffer,
    pub mic_buffer: RingBuffer,
    pub routing_active: Arc<AtomicBool>,
    pub capture_active: Arc<AtomicBool>,
    /// Fase 2E: monitor device hotplug, auto-reconnect VB-Cable.
    pub device_monitoring: Arc<AtomicBool>,
    pub last_output_device: Mutex<Option<String>>,
}

impl AudioManager {
    pub fn new() -> Self {
        AudioManager {
            config: Mutex::new(AudioMixConfig::default()),
            ring_buffer: Arc::new(Mutex::new(VecDeque::with_capacity(44100 * 2))),
            mic_buffer: Arc::new(Mutex::new(VecDeque::with_capacity(44100 * 2))),
            routing_active: Arc::new(AtomicBool::new(false)),
            capture_active: Arc::new(AtomicBool::new(false)),
            device_monitoring: Arc::new(AtomicBool::new(false)),
            last_output_device: Mutex::new(None),
        }
    }

    /// Fase 2B: spawn WASAPI output worker thread ke device_name (CABLE Input).
    /// cpal::Stream !Send, jadi stream + cpal device + render closures semuanya
    /// berada di dalam thread scope (Send + 'static tidak diperlukan cross-thread).
    ///
    /// Fase 2E: juga spawn device hotplug monitor — tiap 2 detik cek VB-Cable
    /// availability; jika hilang set flag false (stream exit), jika kembali
    /// re-init stream otomatis.
    pub fn init_wasapi_output_stream(&self, device_name: String) -> Result<(), String> {
        let ring_buf: RingBuffer = Arc::clone(&self.ring_buffer);
        let mic_buf: RingBuffer = Arc::clone(&self.mic_buffer);
        let routing_flag: Arc<AtomicBool> = Arc::clone(&self.routing_active);
        let capture_flag: Arc<AtomicBool> = Arc::clone(&self.capture_active);
        let cfg: Arc<Mutex<AudioMixConfig>> = Arc::new(Mutex::new(
            self.config.lock().unwrap().clone(),
        ));

        let dev = device_name.clone();
        std::thread::Builder::new()
            .name("wasapi-output-worker".into())
            .spawn(move || {
                if let Err(e) = run_wasapi_output_loop(&dev, ring_buf, mic_buf, routing_flag, capture_flag, cfg) {
                    eprintln!("[audio] WASAPI output worker exited: {}", e);
                }
            })
            .map_err(|e| format!("Gagal spawn WASAPI worker thread: {}", e))?;

        // Fase 2E: device hotplug monitor.
        *self.last_output_device.lock().unwrap() = Some(device_name.clone());
        self.routing_active.store(true, Ordering::SeqCst);
        self.device_monitoring.store(true, Ordering::SeqCst);

        let monitor_ring = Arc::clone(&self.ring_buffer);
        let monitor_mic = Arc::clone(&self.mic_buffer);
        let monitor_routing = Arc::clone(&self.routing_active);
        let monitor_capture = Arc::clone(&self.capture_active);
        let monitor_cfg: Arc<Mutex<AudioMixConfig>> = Arc::new(Mutex::new(
            self.config.lock().unwrap().clone(),
        ));
        let monitor_device = device_name.clone();
        let monitor_flag = Arc::clone(&self.device_monitoring);
        let monitor_last = Arc::clone(
            &Arc::new(Mutex::new(self.last_output_device.lock().unwrap().clone())),
        );

        std::thread::Builder::new()
            .name("wasapi-device-monitor".into())
            .spawn(move || {
                eprintln!("[audio] device hotplug monitor started for: {}", monitor_device);
                while monitor_flag.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(2000));

                    let present = device_present_in_system(&monitor_device);
                    let prev_present = {
                        let g = monitor_last.lock().unwrap();
                        g.as_ref().map(|d| d == &monitor_device).unwrap_or(true)
                    };

                    if !present && prev_present {
                        eprintln!("[audio] device '{}' hilang — hentikan stream", monitor_device);
                        monitor_routing.store(false, Ordering::SeqCst);
                        *monitor_last.lock().unwrap() = None;
                    } else if present && !prev_present {
                        eprintln!("[audio] device '{}' kembali — re-init stream", monitor_device);
                        *monitor_last.lock().unwrap() = Some(monitor_device.clone());
                        let dev_clone = monitor_device.clone();
                        let rb = Arc::clone(&monitor_ring);
                        let mb = Arc::clone(&monitor_mic);
                        let rf = Arc::clone(&monitor_routing);
                        let cf = Arc::clone(&monitor_capture);
                        let cg = Arc::clone(&monitor_cfg);
                        if let Err(e) = run_wasapi_output_loop(&dev_clone, rb, mb, rf, cf, cg) {
                            eprintln!("[audio] re-init stream gagal: {}", e);
                            *monitor_last.lock().unwrap() = None;
                        }
                    }
                }
                eprintln!("[audio] device hotplug monitor stopped");
            })
            .map_err(|e| format!("Gagal spawn device monitor thread: {}", e))?;

        eprintln!("[audio] WASAPI output stream initialized to: {}", device_name);
        Ok(())
    }

    /// Cleanup: set flag false agar worker thread + device monitor stop, flush buffers.
    pub fn cleanup_stream(&self) {
        self.routing_active.store(false, Ordering::SeqCst);
        self.capture_active.store(false, Ordering::SeqCst);
        self.device_monitoring.store(false, Ordering::SeqCst);
        let mut buf = self.ring_buffer.lock().unwrap();
        buf.clear();
        let mut mic = self.mic_buffer.lock().unwrap();
        mic.clear();
    }

    /// Fase 2C: spawn WASAPI input (capture) worker thread ke mikrofon device.
    pub fn init_wasapi_capture_stream(&self, device_name: String) -> Result<(), String> {
        let mic_buf: RingBuffer = Arc::clone(&self.mic_buffer);
        let capture_flag: Arc<AtomicBool> = Arc::clone(&self.capture_active);

        let dev = device_name.clone();
        std::thread::Builder::new()
            .name("wasapi-capture-worker".into())
            .spawn(move || {
                if let Err(e) = run_wasapi_capture_loop(&dev, mic_buf, capture_flag) {
                    eprintln!("[audio] WASAPI capture worker exited: {}", e);
                }
            })
            .map_err(|e| format!("Gagal spawn WASAPI capture worker thread: {}", e))?;

        eprintln!("[audio] WASAPI capture stream initialized from: {}", device_name);
        Ok(())
    }
}

// === TAUCHI COMMANDS ===
// Fase 2A: hanya enum + config update. Tidak ada stream init di sini.

#[tauri::command]
pub fn audio_devices() -> Vec<AudioDeviceInfo> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let mut devices = Vec::new();

    // Input devices (mikrofon)
    if let Ok(iter) = host.input_devices() {
        for dev in iter {
            if let Ok(name) = dev.name() {
                // cpal 0.15: Device tidak punya id() langsung, gunakan name
                // sebagai identifier (Windows device name sudah unik dan stabil).
                let id = name.clone();
                devices.push(AudioDeviceInfo {
                    id,
                    name,
                    is_input: true,
                });
            }
        }
    }

    // Output devices (speaker / vb-cable output)
    if let Ok(iter) = host.output_devices() {
        for dev in iter {
            if let Ok(name) = dev.name() {
                let id = name.clone();
                devices.push(AudioDeviceInfo {
                    id,
                    name,
                    is_input: false,
                });
            }
        }
    }

    devices
}

#[tauri::command]
pub fn set_audio_output(state: State<AudioManager>, device_id: String) -> Result<(), String> {
    // Fase 2B: jika device ini adalah CABLE Input, init WASAPI output stream ke sana
    let lower = device_id.to_lowercase();
    if lower.contains("cable") && lower.contains("input") {
        state.cleanup_stream();
        state.init_wasapi_output_stream(device_id.clone())?;
        state.routing_active.store(true, Ordering::SeqCst);
        {
            let mut cfg = state.config.lock().unwrap();
            cfg.output_device_id = device_id.clone();
            cfg.vb_cable_routing = true;
        }
        eprintln!("[audio] VB-Cable routing enabled -> {}", device_id);
    } else {
        state.cleanup_stream();
        state.routing_active.store(false, Ordering::SeqCst);
        {
            let mut cfg = state.config.lock().unwrap();
            cfg.output_device_id = device_id.clone();
            cfg.vb_cable_routing = false;
        }
        eprintln!("[audio] VB-Cable routing disabled");
    }

    Ok(())
}

#[tauri::command]
pub fn audio_set_mic(
    state: State<AudioManager>,
    device_id: String,
    volume: f32,
    enabled: bool,
) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();

    if enabled {
        if device_id.is_empty() {
            return Err("Device ID kosong".into());
        }
        cfg.mic_device_id = device_id.clone();
    } else {
        cfg.mic_device_id.clear();
    }

    cfg.mic_volume = volume.clamp(0.0, 1.0);
    cfg.include_mic = enabled;
    drop(cfg);

    // Fase 2C: lazy-init WASAPI capture stream ke mikrofon device.
    if enabled && !device_id.is_empty() {
        state.init_wasapi_capture_stream(device_id.clone())?;
    } else {
        state.capture_active.store(false, Ordering::SeqCst);
        eprintln!("[audio] WASAPI capture stream disabled");
    }

    eprintln!(
        "[audio] mic {}: device={}, volume={}",
        if enabled { "ON" } else { "OFF" },
        device_id,
        volume
    );

    Ok(())
}

#[tauri::command]
pub fn audio_set_mix_levels(
    state: State<AudioManager>,
    mic_volume: f32,
    sound_volume: f32,
) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.mic_volume = mic_volume.clamp(0.0, 1.0);
    cfg.sound_volume = sound_volume.clamp(0.0, 1.0);
    // Mixing akan berjalan di WASAPI worker thread (Fase 2B)
    Ok(())
}

/// Push PCM mono i16 chunk ke ring buffer (dual-path export di playSound).
#[tauri::command]
pub fn audio_enqueue(state: State<AudioManager>, pcm_chunk: Vec<i16>) {
    let mut buf = state.ring_buffer.lock().unwrap();
    buf.extend(pcm_chunk);
}

/// Fase 2E: cek apakah device (by exact name) tersedia di sistem.
/// cpal 0.15 tidak punya device-change event listener, jadi kita poll.
fn device_present_in_system(device_name: &str) -> bool {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    if let Ok(iter) = host.output_devices() {
        for d in iter {
            if d.name().map(|n| n == device_name).unwrap_or(false) {
                return true;
            }
        }
    }
    false
}

// === WASAPI OUTPUT STREAM (lazy init, lazy cleanup) ===

/// WASAPI output loop dijalankan di worker thread (cpal::Stream !Send tapi Send di thread).
/// Mixing: gabungkan mono PCM dari ring_buf (soundboard) + mic_buf (capture)
/// dengan volume multiplier sebelum render ke output device.
fn run_wasapi_output_loop(
    device_name: &str,
    ring_buf: RingBuffer,
    mic_buf: RingBuffer,
    routing_flag: Arc<AtomicBool>,
    _capture_flag: Arc<AtomicBool>,
    cfg: Arc<Mutex<AudioMixConfig>>,
) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat;

    let host = cpal::default_host();
    let device = host
        .output_devices()
        .map_err(|e| format!("Gagal enumerasi output device: {}", e))
        .and_then(|mut iter| {
            iter.find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
                .ok_or_else(|| format!("Device tidak ditemukan: {}", device_name))
        })?;

    let sample_rate = 44100;
    let channels = 1;

    let config = device
        .default_output_config()
        .map_err(|e| format!("Gagal dapat config device: {}", e))?;

    let err_fn = |err: cpal::StreamError| {
        eprintln!("[audio] WASAPI stream error: {}", err);
    };

    let stream = match config.sample_format() {
        SampleFormat::I16 => device
            .build_output_stream(
                &cpal::StreamConfig { channels, sample_rate: cpal::SampleRate(sample_rate), buffer_size: cpal::BufferSize::Default },
                { let rb = Arc::clone(&ring_buf); let mb = Arc::clone(&mic_buf); let rf = Arc::clone(&routing_flag); let cg = Arc::clone(&cfg); move |data: &mut [i16], _: &cpal::OutputCallbackInfo| { render_callback_i16(data, channels, &rb, &mb, &rf, &cg); } },
                err_fn,
                None,
            )
            .map_err(|e| format!("Gagal build i16 stream: {}", e))?,
        SampleFormat::U16 => device
            .build_output_stream(
                &cpal::StreamConfig { channels, sample_rate: cpal::SampleRate(sample_rate), buffer_size: cpal::BufferSize::Default },
                { let rb = Arc::clone(&ring_buf); let mb = Arc::clone(&mic_buf); let rf = Arc::clone(&routing_flag); let cg = Arc::clone(&cfg); move |data: &mut [u16], _: &cpal::OutputCallbackInfo| { render_callback_u16(data, channels, &rb, &mb, &rf, &cg); } },
                err_fn,
                None,
            )
            .map_err(|e| format!("Gagal build u16 stream: {}", e))?,
        SampleFormat::F32 => device
            .build_output_stream(
                &cpal::StreamConfig { channels, sample_rate: cpal::SampleRate(sample_rate), buffer_size: cpal::BufferSize::Default },
                { let rb = Arc::clone(&ring_buf); let mb = Arc::clone(&mic_buf); let rf = Arc::clone(&routing_flag); let cg = Arc::clone(&cfg); move |data: &mut [f32], _: &cpal::OutputCallbackInfo| { render_callback_f32(data, channels, &rb, &mb, &rf, &cg); } },
                err_fn,
                None,
            )
            .map_err(|e| format!("Gagal build f32 stream: {}", e))?,
        _ => return Err("Unsupported sample format".into()),
    };

    routing_flag.store(true, Ordering::SeqCst);
    stream.play().map_err(|e| format!("Gagal play WASAPI stream: {}", e))?;
    eprintln!("[audio] WASAPI output stream playing to: {}", device_name);

    // Block worker thread sampai routing dimatikan.
    while routing_flag.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    // stream akan drop otomatis saat keluar scope
    Ok(())
}

/// WASAPI input (capture) loop: baca PCM mono i16 dari mikrofon, push ke mic_buf.
fn run_wasapi_capture_loop(
    device_name: &str,
    mic_buf: RingBuffer,
    capture_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat;

    let host = cpal::default_host();
    let device = host
        .input_devices()
        .map_err(|e| format!("Gagal enumerasi input device: {}", e))
        .and_then(|mut iter| {
            iter.find(|d| d.name().map(|n| n == device_name).unwrap_or(false))
                .ok_or_else(|| format!("Device tidak ditemukan: {}", device_name))
        })?;

    let sample_rate = 44100;
    let channels = 1;

    let config = device
        .default_input_config()
        .map_err(|e| format!("Gagal dapat config input device: {}", e))?;

    let err_fn = |err: cpal::StreamError| {
        eprintln!("[audio] WASAPI capture stream error: {}", err);
    };

    let stream = match config.sample_format() {
        SampleFormat::I16 => device
            .build_input_stream(
                &cpal::StreamConfig { channels, sample_rate: cpal::SampleRate(sample_rate), buffer_size: cpal::BufferSize::Default },
                { let mb = Arc::clone(&mic_buf); let cf = Arc::clone(&capture_flag); move |data: &[i16], _: &cpal::InputCallbackInfo| { capture_callback_i16(data, &mb, &cf); } },
                err_fn,
                None,
            )
            .map_err(|e| format!("Gagal build i16 capture stream: {}", e))?,
        SampleFormat::U16 => device
            .build_input_stream(
                &cpal::StreamConfig { channels, sample_rate: cpal::SampleRate(sample_rate), buffer_size: cpal::BufferSize::Default },
                { let mb = Arc::clone(&mic_buf); let cf = Arc::clone(&capture_flag); move |data: &[u16], _: &cpal::InputCallbackInfo| { capture_callback_u16(data, &mb, &cf); } },
                err_fn,
                None,
            )
            .map_err(|e| format!("Gagal build u16 capture stream: {}", e))?,
        SampleFormat::F32 => device
            .build_input_stream(
                &cpal::StreamConfig { channels, sample_rate: cpal::SampleRate(sample_rate), buffer_size: cpal::BufferSize::Default },
                { let mb = Arc::clone(&mic_buf); let cf = Arc::clone(&capture_flag); move |data: &[f32], _: &cpal::InputCallbackInfo| { capture_callback_f32(data, &mb, &cf); } },
                err_fn,
                None,
            )
            .map_err(|e| format!("Gagal build f32 capture stream: {}", e))?,
        _ => return Err("Unsupported sample format".into()),
    };

    capture_flag.store(true, Ordering::SeqCst);
    stream.play().map_err(|e| format!("Gagal play WASAPI capture stream: {}", e))?;
    eprintln!("[audio] WASAPI capture stream listening from: {}", device_name);

    // Block sampai capture dimatikan.
    while capture_flag.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    Ok(())
}

/// Mixing helper: pop satu sample mono dari ring buffer, kali dengan volume.
fn pop_sound(ring_buf: &RingBuffer, sound_volume: f32) -> i16 {
    let mut buf = ring_buf.lock().unwrap();
    buf.pop_front().map(|s| (s as f32 * sound_volume) as i16).unwrap_or(0)
}

/// Mixing helper: pop satu sample mono dari mic buffer, kali dengan volume.
fn pop_mic(mic_buf: &RingBuffer, mic_volume: f32) -> i16 {
    let mut buf = mic_buf.lock().unwrap();
    buf.pop_front().map(|s| (s as f32 * mic_volume) as i16).unwrap_or(0)
}

fn render_callback_i16(
    output: &mut [i16],
    channels: u16,
    ring_buf: &RingBuffer,
    mic_buf: &RingBuffer,
    routing_flag: &Arc<AtomicBool>,
    cfg: &Arc<Mutex<AudioMixConfig>>,
) {
    if !routing_flag.load(Ordering::SeqCst) {
        output.fill(0);
        return;
    }
    let c = cfg.lock().unwrap();
    let sv = c.sound_volume;
    let mv = c.mic_volume;
    let include = c.include_mic;
    drop(c);

    for frame in output.chunks_mut(channels as usize) {
        let s = pop_sound(ring_buf, sv);
        let m = if include { pop_mic(mic_buf, mv) } else { 0 };
        let mixed = (s as i32 + m as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        for slot in frame.iter_mut() {
            *slot = mixed;
        }
    }
}

fn render_callback_u16(
    output: &mut [u16],
    channels: u16,
    ring_buf: &RingBuffer,
    mic_buf: &RingBuffer,
    routing_flag: &Arc<AtomicBool>,
    cfg: &Arc<Mutex<AudioMixConfig>>,
) {
    if !routing_flag.load(Ordering::SeqCst) {
        output.fill(32768);
        return;
    }
    let c = cfg.lock().unwrap();
    let sv = c.sound_volume;
    let mv = c.mic_volume;
    let include = c.include_mic;
    drop(c);

    for frame in output.chunks_mut(channels as usize) {
        let s = pop_sound(ring_buf, sv);
        let m = if include { pop_mic(mic_buf, mv) } else { 0 };
        let mixed = ((s as i32 + m as i32).clamp(i16::MIN as i32, i16::MAX as i32) + 32768) as u16;
        for slot in frame.iter_mut() {
            *slot = mixed;
        }
    }
}

fn render_callback_f32(
    output: &mut [f32],
    channels: u16,
    ring_buf: &RingBuffer,
    mic_buf: &RingBuffer,
    routing_flag: &Arc<AtomicBool>,
    cfg: &Arc<Mutex<AudioMixConfig>>,
) {
    if !routing_flag.load(Ordering::SeqCst) {
        output.fill(0.0);
        return;
    }
    let c = cfg.lock().unwrap();
    let sv = c.sound_volume;
    let mv = c.mic_volume;
    let include = c.include_mic;
    drop(c);

    for frame in output.chunks_mut(channels as usize) {
        let s = pop_sound(ring_buf, sv);
        let m = if include { pop_mic(mic_buf, mv) } else { 0 };
        let mixed = ((s as i32 + m as i32).clamp(i16::MIN as i32, i16::MAX as i32) as f32) / 32768.0;
        for slot in frame.iter_mut() {
            *slot = mixed;
        }
    }
}

fn capture_callback_i16(data: &[i16], mic_buf: &RingBuffer, _capture_flag: &Arc<AtomicBool>) {
    let mut buf = mic_buf.lock().unwrap();
    for &s in data {
        buf.push_back(s);
    }
}

fn capture_callback_u16(data: &[u16], mic_buf: &RingBuffer, _capture_flag: &Arc<AtomicBool>) {
    let mut buf = mic_buf.lock().unwrap();
    for &s in data {
        buf.push_back((s as i32 - 32768) as i16);
    }
}

fn capture_callback_f32(data: &[f32], mic_buf: &RingBuffer, _capture_flag: &Arc<AtomicBool>) {
    let mut buf = mic_buf.lock().unwrap();
    for &s in data {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        buf.push_back(v);
    }
}
