//! Engine thread: pemilik semua `cpal::Stream` dan penerjemah command UI.
//!
//! UI tidak pernah menyentuh cpal. Semua perubahan device/stream diproses di
//! thread ini supaya `cpal::Stream` (!Send) tidak pernah berpindah thread.

use crate::audio::decode::Clip;
use crate::audio::devices;
use crate::audio::mixer::{Counters, Mixer, MixerCommand, MixerSettings};
use crate::audio::output::{self, InputHandle, OutputHandle};
use crate::audio::resample::{StreamResampler, ENGINE_SAMPLE_RATE};
use crate::audio::ring::SpscRing;
use crate::audio::settings::{self, AudioSettings, MicSettings};
use crate::audio::types::{AudioState, Bus, PlayMode, StreamStatus, ToneTarget};
use crossbeam_channel::{bounded, Receiver, Sender};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// Set higher thread scheduling priority so the audio engine + mixer threads
// are not preempted by the OS scheduler under load (browser / Discord).
// On Windows we call SetThreadPriority(THREAD_PRIORITY_ABOVE_NORMAL) via FFI,
// avoiding winapi/windows-sys dependency. No-op on non-Windows.
#[cfg(windows)]
fn boost_thread_priority() {
    extern "system" {
        fn GetCurrentThread() -> usize;
        fn SetThreadPriority(handle: usize, priority: i32) -> i32;
        fn SetThreadPriorityBoost(handle: usize, disable: i32) -> i32;
    }
    // THREAD_PRIORITY_ABOVE_NORMAL = 1
    unsafe {
        let t = GetCurrentThread();
        let _ = SetThreadPriority(t, 1); // ABOVE_NORMAL
        // Disable priority boosting — prevents lower-priority boosts from jittering us
        let _ = SetThreadPriorityBoost(t, 1i32);
    }
}

#[cfg(not(windows))]
fn boost_thread_priority() {}

pub enum EngineCommand {
    SetOutput {
        device: String,
        reply: Sender<Result<(), String>>,
    },
    SetMonitor {
        device: String,
        enabled: bool,
        volume: f32,
        reply: Sender<Result<(), String>>,
    },
    SetMonitorSfxOnly {
        only: bool,
    },
    SetMic {
        device: String,
        enabled: bool,
        gain: f32,
        reply: Sender<Result<(), String>>,
    },
    SetMicPre(MicSettings),
    SetGain {
        bus: Bus,
        value: f32,
    },
    SetMute {
        bus: Bus,
        muted: bool,
    },
    SetMode(PlayMode),
    SetBuffer {
        ms: u32,
        reply: Sender<Result<(), String>>,
    },
    TestTone {
        target: ToneTarget,
        freq: f32,
        duration_ms: u32,
    },
    Play {
        id: String,
        clip: Arc<Clip>,
        /// Gain tambahan dari entry.volume, diterapkan di mixer.
        /// Dipisahkan dari clip.gain (yang selalu 1.0) sehingga
        /// mengubah volume tidak memicu decode ulang cache.
        gain: f32,
        reply: Sender<Result<(), String>>,
    },
    Stop {
        id: Option<String>,
    },
    Shutdown,
}

pub struct AudioEngine {
    tx: Sender<EngineCommand>,
    state: Arc<Mutex<AudioState>>,
    /// Hanya instance asli (yang di-manage Tauri) yang boleh mengirim Shutdown
    /// saat di-drop. Clone dipakai untuk command async dan tidak boleh
    /// mematikan engine saat clone itu selesai.
    owner: bool,
}

impl Clone for AudioEngine {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            state: Arc::clone(&self.state),
            owner: false,
        }
    }
}

impl AudioEngine {
    pub fn new(app: AppHandle) -> Self {
        let settings = settings::load(&app);
        eprintln!(
            "[audio] buffer tetap {} ms (mic: {}, cable: {})",
            settings.buffer_ms,
            settings.mic_device,
            if settings.cable_device.is_empty() {
                "auto".to_string()
            } else {
                settings.cable_device.clone()
            }
        );
        let initial = state_from_settings(&settings);
        let state = Arc::new(Mutex::new(initial));
        let (tx, rx) = crossbeam_channel::unbounded();

        let thread_state = Arc::clone(&state);
        let thread_app = app.clone();
        std::thread::Builder::new()
            .name("audio-engine".into())
            .spawn(move || {
                boost_thread_priority();
                run(thread_app, rx, thread_state, settings)
            })
            .expect("gagal spawn audio engine thread");

        Self {
            tx,
            state,
            owner: true,
        }
    }

    pub fn snapshot(&self) -> AudioState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| state_from_settings(&AudioSettings::default()))
    }

    fn request<F>(&self, build: F) -> Result<(), String>
    where
        F: FnOnce(Sender<Result<(), String>>) -> EngineCommand,
    {
        let (reply_tx, reply_rx) = bounded(1);
        self.tx
            .send(build(reply_tx))
            .map_err(|_| "audio engine tidak berjalan".to_string())?;
        reply_rx
            .recv_timeout(Duration::from_secs(8))
            .map_err(|_| "audio engine tidak merespons".to_string())?
    }

    pub fn set_output(&self, device: String) -> Result<(), String> {
        self.request(|reply| EngineCommand::SetOutput { device, reply })
    }

    pub fn set_monitor(&self, device: String, enabled: bool, volume: f32) -> Result<(), String> {
        self.request(|reply| EngineCommand::SetMonitor {
            device,
            enabled,
            volume,
            reply,
        })
    }

    pub fn set_monitor_sfx_only(&self, only: bool) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetMonitorSfxOnly { only })
            .map_err(|_| "audio engine tidak berjalan".to_string())?;
        Ok(())
    }

    pub fn set_mic(&self, device: String, enabled: bool, gain: f32) -> Result<(), String> {
        self.request(|reply| EngineCommand::SetMic {
            device,
            enabled,
            gain,
            reply,
        })
    }

    pub fn set_mic_pre(&self, settings: MicSettings) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetMicPre(settings))
            .map_err(|_| "audio engine tidak berjalan".to_string())
    }

    pub fn set_buffer(&self, ms: u32) -> Result<(), String> {
        self.request(|reply| EngineCommand::SetBuffer { ms, reply })
    }

    pub fn set_gain(&self, bus: Bus, value: f32) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetGain { bus, value })
            .map_err(|_| "audio engine tidak berjalan".to_string())
    }

    pub fn set_mute(&self, bus: Bus, muted: bool) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetMute { bus, muted })
            .map_err(|_| "audio engine tidak berjalan".to_string())
    }

    pub fn set_mode(&self, mode: PlayMode) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetMode(mode))
            .map_err(|_| "audio engine tidak berjalan".to_string())
    }

    pub fn test_tone(&self, target: ToneTarget, freq: f32, duration_ms: u32) -> Result<(), String> {
        self.tx
            .send(EngineCommand::TestTone {
                target,
                freq,
                duration_ms,
            })
            .map_err(|_| "audio engine tidak berjalan".to_string())
    }

    /// Gain diterapkan di play-time dari entry.volume, bukan di decode-time.
    /// Ini memungkinkan mengubah volume tanpa dekode ulang clip yang dicache.
    pub fn play(&self, id: String, clip: Arc<Clip>, gain: f32) -> Result<(), String> {
        self.request(|reply| EngineCommand::Play { id, clip, gain, reply })
    }

    pub fn stop(&self, id: Option<String>) -> Result<(), String> {
        self.tx
            .send(EngineCommand::Stop { id })
            .map_err(|_| "audio engine tidak berjalan".to_string())
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        if self.owner {
            let _ = self.tx.send(EngineCommand::Shutdown);
        }
    }
}

pub(crate) fn state_from_settings(settings: &AudioSettings) -> AudioState {
    AudioState {
        cable_device: settings.cable_device.clone(),
        cable_auto: settings.cable_device.trim().is_empty(),
        cable_present: devices::cable_present(),
        monitor_device: settings.monitor_device.clone(),
        monitor_enabled: settings.monitor_enabled,
        monitor_volume: settings.monitor_volume,
        monitor_sfx_only: settings.monitor_sfx_only,
        mic_device: settings.mic_device.clone(),
        mic_enabled: settings.mic_enabled,
        mic_gain: settings.mic_gain,
        sfx_gain: settings.sfx_gain,
        master_gain: settings.master_gain,
        mic_muted: settings.mic_muted,
        sfx_muted: settings.sfx_muted,
        mode: settings.mode.clone(),
        buffer_ms: settings.buffer_ms,
        mic_pre: settings.mic_pre,
        streams: vec![
            StreamStatus::stopped("cable", None),
            StreamStatus::stopped("monitor", None),
            StreamStatus::stopped("mic", None),
        ],
    }
}

struct MicWorker {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

/// Batas backlog ring mic mentah (sebelum resample). Ring ini menampung
/// 65 536 sample (~1.4 s @ 48 kHz). Kalau thread worker sempat stall, audio
/// lama akan terus diputar dan delay-nya persisten — persis gejala 1–2 detik.
/// Buang kelebihannya supaya jalur mic selalu near-real-time.
const MIC_RAW_BACKLOG_LIMIT_MS: usize = 80;
const MIC_RAW_BACKLOG_TARGET_MS: usize = 20;

impl MicWorker {
    fn spawn(raw: Arc<SpscRing>, output: Arc<SpscRing>, input_rate: u32) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop);
        let backlog_limit = input_rate as usize * MIC_RAW_BACKLOG_LIMIT_MS / 1000;
        let backlog_target = input_rate as usize * MIC_RAW_BACKLOG_TARGET_MS / 1000;
        let handle = std::thread::Builder::new()
            .name("audio-mic-resample".into())
            .spawn(move || {
                boost_thread_priority();
                let mut resampler = match StreamResampler::new(input_rate, ENGINE_SAMPLE_RATE, 1) {
                    Ok(value) => value,
                    Err(err) => {
                        eprintln!("[audio] {err}");
                        return;
                    }
                };
                let mut chunk = vec![0.0f32; 4096];
                let mut last_trim_log = Instant::now() - Duration::from_secs(10);
                while !stop_flag.load(Ordering::Acquire) {
                    // Consumer-side trim: kalau ring menumpuk (worker sempat
                    // tidak dijadwalkan), buang audio paling lama. Tanpa ini
                    // backlog 1 detik akan terus diputar tertinggal.
                    if raw.len() > backlog_limit {
                        raw.trim_to(backlog_target);
                        if last_trim_log.elapsed() >= Duration::from_secs(1) {
                            eprintln!(
                                "[audio] backlog mic dibuang ke {} ms",
                                MIC_RAW_BACKLOG_TARGET_MS
                            );
                            last_trim_log = Instant::now();
                        }
                    }
                    let count = raw.pop(&mut chunk);
                    if count == 0 {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    resampler.push(&chunk[..count]);
                    match resampler.process() {
                        Ok(samples) if !samples.is_empty() => {
                            // Kalau consumer tersendat, buang sample baru
                            // daripada menambah latency tanpa batas.
                            if output.len() < output.capacity() / 2 {
                                output.push(&samples);
                            }
                        }
                        Ok(_) => {}
                        Err(err) => eprintln!("[audio] {err}"),
                    }
                }
            })
            .map_err(|e| format!("gagal spawn mic worker: {e}"))?;

        Ok(Self {
            stop,
            handle: Some(handle),
        })
    }
}

impl Drop for MicWorker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct Engine {
    app: AppHandle,
    rx: Receiver<EngineCommand>,
    state: Arc<Mutex<AudioState>>,
    settings: AudioSettings,

    mixer_tx: Sender<MixerCommand>,
    mixer_handle: Option<JoinHandle<()>>,

    cable_ring: Arc<SpscRing>,
    monitor_ring: Arc<SpscRing>,
    mic_raw_ring: Arc<SpscRing>,
    mic48_ring: Arc<SpscRing>,
    cable_active: Arc<AtomicBool>,
    monitor_active: Arc<AtomicBool>,
    counters: Arc<Counters>,

    cable_out: Option<OutputHandle>,
    monitor_out: Option<OutputHandle>,
    mic_in: Option<InputHandle>,
    mic_worker: Option<MicWorker>,

    cable_status: StreamStatus,
    monitor_status: StreamStatus,
    mic_status: StreamStatus,
    /// Hasil deteksi terakhir. Dipakai `publish()` supaya tidak melakukan
    /// enumerasi device setiap command UI.
    cable_present: bool,

    dirty: bool,
    last_save: Instant,
    last_check: Instant,
}

impl Engine {
    fn new(
        app: AppHandle,
        rx: Receiver<EngineCommand>,
        state: Arc<Mutex<AudioState>>,
        settings: AudioSettings,
    ) -> Self {
        let cable_ring = Arc::new(SpscRing::new(1 << 18));
        let monitor_ring = Arc::new(SpscRing::new(1 << 18));
        let mic_raw_ring = Arc::new(SpscRing::new(1 << 16));
        // Ring mic 48 kHz sengaja kecil (~170 ms mono). Ring besar (1.36 s)
        // membuat audio lama bisa ikut diputar kalau mixer sempat stall.
        let mic48_ring = Arc::new(SpscRing::new(1 << 13));
        let cable_active = Arc::new(AtomicBool::new(false));
        let monitor_active = Arc::new(AtomicBool::new(false));
        let counters = Arc::new(Counters::default());

        let (mixer_tx, mixer_rx) = crossbeam_channel::unbounded();
        let mixer = Mixer::new(
            app.clone(),
            mixer_rx,
            Arc::clone(&cable_ring),
            Arc::clone(&monitor_ring),
            Arc::clone(&mic48_ring),
            Arc::clone(&cable_active),
            Arc::clone(&monitor_active),
            Arc::clone(&counters),
            MixerSettings {
                mic_gain: settings.mic_gain,
                sfx_gain: settings.sfx_gain,
                master_gain: settings.master_gain,
                monitor_volume: settings.monitor_volume,
                mic_muted: settings.mic_muted,
                sfx_muted: settings.sfx_muted,
                monitor_sfx_only: settings.monitor_sfx_only,
                monitor_enabled: settings.monitor_enabled,
                mode: PlayMode::parse(&settings.mode),
                mic_pre: settings.mic_pre,
                buffer_ms: settings.buffer_ms,
            },
        );
        let mixer_handle = std::thread::Builder::new()
            .name("audio-mixer".into())
            .spawn(move || {
                boost_thread_priority();
                mixer.run()
            })
            .ok();

        Self {
            app,
            rx,
            state,
            settings,
            mixer_tx,
            mixer_handle,
            cable_ring,
            monitor_ring,
            mic_raw_ring,
            mic48_ring,
            cable_active,
            monitor_active,
            counters,
            cable_out: None,
            monitor_out: None,
            mic_in: None,
            mic_worker: None,
            cable_status: StreamStatus::stopped("cable", None),
            monitor_status: StreamStatus::stopped("monitor", None),
            mic_status: StreamStatus::stopped("mic", None),
            cable_present: devices::cable_present(),
            dirty: false,
            last_save: Instant::now(),
            last_check: Instant::now(),
        }
    }

    fn start(&mut self) {
        // CABLE: auto-deteksi kalau belum pernah dipilih.
        if self.settings.cable_device.trim().is_empty() {
            if let Some((_, name)) = devices::find_cable_output() {
                self.settings.cable_device = name;
                self.dirty = true;
            }
        }
        if !self.settings.cable_device.trim().is_empty() {
            if let Err(err) = self.rebuild_cable(&self.settings.cable_device.clone()) {
                self.cable_status = StreamStatus::stopped("cable", Some(err));
            }
        } else {
            self.cable_status = StreamStatus::stopped(
                "cable",
                Some("CABLE Input tidak ditemukan. Install VB-Cable lalu refresh.".into()),
            );
        }

        if self.settings.monitor_enabled {
            let device = self.settings.monitor_device.clone();
            if let Err(err) = self.rebuild_monitor(&device) {
                self.monitor_status = StreamStatus::stopped("monitor", Some(err));
            }
        }

        if self.settings.mic_enabled {
            let device = self.settings.mic_device.clone();
            let gain = self.settings.mic_gain;
            if let Err(err) = self.rebuild_mic(&device, true, gain) {
                self.mic_status = StreamStatus::stopped("mic", Some(err));
            }
        }

        self.publish(true);
    }

    fn run(&mut self) {
        self.start();
        eprintln!("[audio] engine thread siap");
        loop {
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(command) => {
                    if !self.handle(command) {
                        break;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }

            // Periksa kehadiran device tiap 5 detik: enumerasi cpal di Windows
            // bisa blocking 100-500 ms, jadi jangan dilakukan tiap command UI.
            // Nama device juga di-cache 2 detik di devices.rs.
            if self.last_check.elapsed() >= Duration::from_secs(5) {
                self.last_check = Instant::now();
                self.check_devices();
            }

            if self.dirty && self.last_save.elapsed() >= Duration::from_millis(500) {
                if let Err(err) = settings::save(&self.app, &self.settings) {
                    eprintln!("[audio] gagal simpan setting: {err}");
                }
                self.dirty = false;
                self.last_save = Instant::now();
            }
        }

        // Cleanup urutan: hentikan mixer, lalu stream.
        let _ = self.mixer_tx.send(MixerCommand::Shutdown);
        if let Some(handle) = self.mixer_handle.take() {
            let _ = handle.join();
        }
        self.mic_worker = None;
        self.mic_in = None;
        self.monitor_out = None;
        self.cable_out = None;
        self.cable_active.store(false, Ordering::Release);
        self.monitor_active.store(false, Ordering::Release);
        let _ = settings::save(&self.app, &self.settings);
        eprintln!("[audio] engine thread berhenti");
    }

    fn handle(&mut self, command: EngineCommand) -> bool {
        match command {
            EngineCommand::SetOutput { device, reply } => {
                if !device.trim().is_empty() {
                    self.settings.cable_device = device.clone();
                }
                let result = self.rebuild_cable(&device);
                self.dirty = true;
                self.publish(true);
                let _ = reply.send(result);
            }
            EngineCommand::SetMonitor {
                device,
                enabled,
                volume,
                reply,
            } => {
                self.settings.monitor_device = device.clone();
                self.settings.monitor_enabled = enabled;
                self.settings.monitor_volume = volume.clamp(0.0, 1.0);
                let _ = self.mixer_tx.send(MixerCommand::SetMonitorEnabled(enabled));
                let _ = self.mixer_tx.send(MixerCommand::SetGain {
                    bus: Bus::Monitor,
                    value: volume,
                });
                let result = if enabled {
                    self.rebuild_monitor(&device)
                } else {
                    self.stop_monitor();
                    Ok(())
                };
                self.dirty = true;
                self.publish(true);
                let _ = reply.send(result);
            }
            EngineCommand::SetMonitorSfxOnly { only } => {
                self.settings.monitor_sfx_only = only;
                let _ = self.mixer_tx.send(MixerCommand::SetMonitorSfxOnly(only));
                self.dirty = true;
            }
            EngineCommand::SetMic {
                device,
                enabled,
                gain,
                reply,
            } => {
                self.settings.mic_gain = gain.clamp(0.0, 4.0);
                let result = self.rebuild_mic(&device, enabled, gain);
                self.dirty = true;
                self.publish(true);
                let _ = reply.send(result);
            }
            EngineCommand::SetGain { bus, value } => {
                let value = match bus {
                    Bus::Mic | Bus::Sfx | Bus::Master => value.clamp(0.0, 4.0),
                    Bus::Monitor => value.clamp(0.0, 1.0),
                };
                match bus {
                    Bus::Mic => self.settings.mic_gain = value,
                    Bus::Sfx => self.settings.sfx_gain = value,
                    Bus::Master => self.settings.master_gain = value,
                    Bus::Monitor => self.settings.monitor_volume = value,
                }
                let _ = self.mixer_tx.send(MixerCommand::SetGain { bus, value });
                self.dirty = true;
                self.publish(false);
            }
            EngineCommand::SetMute { bus, muted } => {
                match bus {
                    Bus::Mic => self.settings.mic_muted = muted,
                    Bus::Sfx => self.settings.sfx_muted = muted,
                    _ => {}
                }
                let _ = self.mixer_tx.send(MixerCommand::SetMute { bus, muted });
                self.dirty = true;
                // Emit langsung: UI dan soundboard butuh tahu status mute
                // segera (mis. peringatan "soundboard sedang mute").
                self.publish(true);
            }
            EngineCommand::SetMode(mode) => {
                self.settings.mode = mode.as_str().to_string();
                let _ = self.mixer_tx.send(MixerCommand::SetMode(mode));
                self.dirty = true;
                self.publish(true);
            }
            EngineCommand::SetBuffer { ms, reply } => {
                // 0 = "default driver" adalah sumber delay; normalisasi ke
                // buffer tetap. Batas atas mencegah prefill/ring membengkak.
                let ms = settings::normalize_buffer_ms(ms);
                self.settings.buffer_ms = ms;
                let _ = self.mixer_tx.send(MixerCommand::SetBuffer { ms });
                let cable = self.settings.cable_device.clone();
                let monitor = self.settings.monitor_device.clone();
                let mic = self.settings.mic_device.clone();
                let mic_enabled = self.settings.mic_enabled;
                let mic_gain = self.settings.mic_gain;
                let mut result = Ok(());
                if !cable.trim().is_empty() {
                    result = self.rebuild_cable(&cable);
                }
                if result.is_ok() && self.settings.monitor_enabled {
                    result = self.rebuild_monitor(&monitor);
                }
                if result.is_ok() && mic_enabled {
                    result = self.rebuild_mic(&mic, true, mic_gain);
                }
                self.dirty = true;
                self.publish(true);
                let _ = reply.send(result);
            }
            EngineCommand::TestTone {
                target,
                freq,
                duration_ms,
            } => {
                let _ = self.mixer_tx.send(MixerCommand::Tone {
                    target,
                    freq,
                    duration_ms,
                });
            }
            EngineCommand::Play { id, clip, gain: play_gain, reply } => {
                // clip.gain selalu 1.0 (gain diterapkan di play-time).
                // Kombinasikan clip.gain (1.0) dengan play_gain (entry.volume).
                let gain = play_gain;
                let _ = self.mixer_tx.send(MixerCommand::Play {
                    id,
                    samples: Arc::clone(&clip.samples),
                    gain,
                });
                let _ = reply.send(Ok(()));
            }
            EngineCommand::Stop { id } => {
                let _ = self.mixer_tx.send(MixerCommand::Stop { id });
            }
            EngineCommand::SetMicPre(mut settings) => {
                settings.sanitize();
                self.settings.mic_pre = settings;
                let _ = self.mixer_tx.send(MixerCommand::SetMicPre(settings));
                self.dirty = true;
                // UI memakai snapshot ini untuk hidrasi; tanpa publish nilainya
                // hanya berubah di engine dan panel bisa menampilkan state lama.
                self.publish(true);
            }
            EngineCommand::Shutdown => return false,
        }
        true
    }

    fn check_devices(&mut self) {
        self.cable_present = devices::cable_present();
        let cable_lost =
            self.cable_out.is_some() && !devices::output_present(&self.cable_status.device);
        if cable_lost {
            eprintln!("[audio] CABLE hilang, menunggu device kembali");
            self.stop_cable();
        } else if self.cable_out.is_none() && self.cable_present {
            let device = self.settings.cable_device.clone();
            if let Err(err) = self.rebuild_cable(&device) {
                self.cable_status = StreamStatus::stopped("cable", Some(err));
            }
        }

        let monitor_lost =
            self.monitor_out.is_some() && !devices::output_present(&self.monitor_status.device);
        if monitor_lost {
            self.stop_monitor();
        } else if self.monitor_out.is_none() && self.settings.monitor_enabled {
            let device = self.settings.monitor_device.clone();
            // Jangan retry kalau monitor memang diarahkan ke endpoint CABLE.
            let same_as_cable = self.cable_out.is_some()
                && !device.is_empty()
                && device == self.cable_status.device;
            if !same_as_cable {
                let _ = self.rebuild_monitor(&device);
            }
        }

        if self.settings.mic_enabled
            && self.mic_in.is_none()
            && (self.settings.mic_device.trim().is_empty()
                || devices::input_present(&self.settings.mic_device))
        {
            let device = self.settings.mic_device.clone();
            let gain = self.settings.mic_gain;
            let _ = self.rebuild_mic(&device, true, gain);
        }

        // Publish periodik: menyegarkan hitungan underrun dan status device
        // tanpa membanjiri UI (2 detik sekali).
        self.publish(true);
    }

    fn rebuild_cable(&mut self, requested: &str) -> Result<(), String> {
        self.cable_active.store(false, Ordering::Release);
        self.cable_out = None;
        self.cable_ring.clear();

        // Jangan fallback ke speaker kalau device CABLE yang dipilih hilang:
        // audio bisa bocor ke output yang salah.
        let resolved = if requested.trim().is_empty() {
            devices::find_cable_output()
        } else {
            devices::find_output(requested)
        };
        let Some((device, name)) = resolved else {
            self.cable_present = false;
            self.cable_status =
                StreamStatus::stopped("cable", Some("output device tidak ditemukan".into()));
            return Err("output device tidak ditemukan".into());
        };

        self.cable_present = true;
        self.settings.cable_device = name.clone();
        let handle = output::build_output(
            "cable",
            device,
            name,
            Arc::clone(&self.cable_ring),
            Arc::clone(&self.cable_active),
            Arc::clone(&self.counters.cable_underruns),
            self.settings.buffer_ms,
        )?;
        self.cable_status = handle.status.clone();
        self.cable_out = Some(handle);
        Ok(())
    }

    fn stop_cable(&mut self) {
        self.cable_active.store(false, Ordering::Release);
        self.cable_out = None;
        self.cable_ring.clear();
        self.cable_present = false;
        self.cable_status = StreamStatus::stopped("cable", Some("menunggu device".into()));
    }

    fn rebuild_monitor(&mut self, requested: &str) -> Result<(), String> {
        self.monitor_active.store(false, Ordering::Release);
        self.monitor_out = None;
        self.monitor_ring.clear();

        let resolved = if requested.trim().is_empty() {
            devices::default_output()
        } else {
            devices::find_output(requested)
        };
        let Some((device, name)) = resolved else {
            self.monitor_status =
                StreamStatus::stopped("monitor", Some("output device tidak ditemukan".into()));
            return Err("monitor device tidak ditemukan".into());
        };

        // Hindari dua stream ke endpoint yang sama.
        if name == self.cable_status.device && self.cable_out.is_some() {
            self.monitor_status =
                StreamStatus::stopped("monitor", Some("sama dengan output Discord".into()));
            return Err("monitor tidak boleh sama dengan output Discord".into());
        }

        self.settings.monitor_device = name.clone();
        let handle = output::build_output(
            "monitor",
            device,
            name,
            Arc::clone(&self.monitor_ring),
            Arc::clone(&self.monitor_active),
            Arc::clone(&self.counters.monitor_underruns),
            self.settings.buffer_ms,
        )?;
        self.monitor_status = handle.status.clone();
        self.monitor_out = Some(handle);
        let _ = self.mixer_tx.send(MixerCommand::PrefillMonitor);
        Ok(())
    }

    fn stop_monitor(&mut self) {
        self.monitor_active.store(false, Ordering::Release);
        self.monitor_out = None;
        self.monitor_ring.clear();
        self.monitor_status = StreamStatus::stopped("monitor", None);
    }

    fn rebuild_mic(&mut self, requested: &str, enabled: bool, gain: f32) -> Result<(), String> {
        self.mic_worker = None;
        self.mic_in = None;
        self.mic_raw_ring.clear();
        // mic48 dikonsumsi mixer; minta mixer yang membersihkannya supaya
        // tidak ada dua thread yang menulis posisi tail bersamaan.
        let _ = self.mixer_tx.send(MixerCommand::ResetMic);

        self.settings.mic_enabled = enabled;
        self.settings.mic_gain = gain.clamp(0.0, 4.0);
        self.settings.mic_device = requested.to_string();
        let _ = self.mixer_tx.send(MixerCommand::SetGain {
            bus: Bus::Mic,
            value: gain,
        });

        if !enabled {
            self.mic_status = StreamStatus::stopped("mic", None);
            return Ok(());
        }

        let resolved = if requested.trim().is_empty() {
            devices::default_input()
        } else {
            devices::find_input(requested)
        };
        let Some((device, name)) = resolved else {
            self.mic_status =
                StreamStatus::stopped("mic", Some("mic device tidak ditemukan".into()));
            return Err("mic device tidak ditemukan".into());
        };

        self.settings.mic_device = name.clone();
        let handle = output::build_input(
            device,
            name,
            Arc::clone(&self.mic_raw_ring),
            self.settings.buffer_ms,
        )?;

        let worker = MicWorker::spawn(
            Arc::clone(&self.mic_raw_ring),
            Arc::clone(&self.mic48_ring),
            handle.sample_rate,
        )?;

        self.mic_status = handle.status.clone();
        self.mic_in = Some(handle);
        self.mic_worker = Some(worker);
        Ok(())
    }

    fn live_status(&self, base: &StreamStatus, counter: Option<&Arc<AtomicU64>>) -> StreamStatus {
        let mut status = base.clone();
        if let Some(counter) = counter {
            status.underruns = counter.load(Ordering::Relaxed);
        }
        if status.state == "running" {
            status.error = if status.sample_rate != ENGINE_SAMPLE_RATE {
                Some(format!(
                    "resample {} → {} Hz",
                    status.sample_rate, ENGINE_SAMPLE_RATE
                ))
            } else {
                None
            };
        }
        status
    }

    fn publish(&self, emit: bool) {
        let state = AudioState {
            cable_device: self.settings.cable_device.clone(),
            cable_auto: self.settings.cable_device.trim().is_empty(),
            cable_present: self.cable_present,
            monitor_device: self.settings.monitor_device.clone(),
            monitor_enabled: self.settings.monitor_enabled,
            monitor_volume: self.settings.monitor_volume,
            monitor_sfx_only: self.settings.monitor_sfx_only,
            mic_device: self.settings.mic_device.clone(),
            mic_enabled: self.settings.mic_enabled,
            mic_gain: self.settings.mic_gain,
            sfx_gain: self.settings.sfx_gain,
            master_gain: self.settings.master_gain,
            mic_muted: self.settings.mic_muted,
            sfx_muted: self.settings.sfx_muted,
            mode: self.settings.mode.clone(),
            buffer_ms: self.settings.buffer_ms,
            mic_pre: self.settings.mic_pre,
            streams: vec![
                self.live_status(&self.cable_status, Some(&self.counters.cable_underruns)),
                self.live_status(&self.monitor_status, Some(&self.counters.monitor_underruns)),
                self.live_status(&self.mic_status, None),
            ],
        };

        if let Ok(mut slot) = self.state.lock() {
            *slot = state.clone();
        }
        if emit {
            let _ = self.app.emit("audio:status", state);
        }
    }
}

fn run(
    app: AppHandle,
    rx: Receiver<EngineCommand>,
    state: Arc<Mutex<AudioState>>,
    settings: AudioSettings,
) {
    let mut engine = Engine::new(app, rx, state, settings);
    engine.run();
}
