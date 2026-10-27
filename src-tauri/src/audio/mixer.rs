//! Mixer thread: satu-satunya tempat yang melakukan mixing.
//!
//! Thread ini memiliki voice bank, gain, mute, tone generator, dan meter.
//! Callback cpal hanya membaca ring buffer, sehingga tidak ada lock/alokasi
//! di jalur real-time.

use crate::audio::ring::SpscRing;
use crate::audio::settings::MicSettings;
use crate::audio::types::{Bus, LevelFrame, PlayMode, ToneTarget};
use crossbeam_channel::{Receiver, TryRecvError};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;

pub const SAMPLE_RATE: usize = 48_000;
const BLOCK_FRAMES: usize = 480; // 10 ms
const MAX_VOICES: usize = 8;
// Diperluas ke 240 ms stereo supaya cpal callback tidak kehabisan antar refill.
// 120 ms sebelumnya terlalu tipis: satu iterasi mixer yang tersendat (command drain)
// langsung bikin underrun. Lihat bug "gelembung pecah / terputus-putus".
const PREFILL_SAMPLES: usize = SAMPLE_RATE * 2 * 240 / 1000; // 240 ms stereo
// Mixer mengisi dua blok sekaligus (20 ms stereo) tiap iterasi agar refill
// lebih "flat" dan tidak bursty akibat sleep 1 ms yang terlalu pendek relatif.
const RENDER_QUANTUM: usize = 2;
const TONE_FADE_FRAMES: u64 = 480;

pub struct Counters {
    pub cable_underruns: Arc<AtomicU64>,
    pub monitor_underruns: Arc<AtomicU64>,
}

impl Default for Counters {
    fn default() -> Self {
        Self {
            cable_underruns: Arc::new(AtomicU64::new(0)),
            monitor_underruns: Arc::new(AtomicU64::new(0)),
        }
    }
}

pub enum MixerCommand {
    SetGain {
        bus: Bus,
        value: f32,
    },
    SetMute {
        bus: Bus,
        muted: bool,
    },
    SetMonitorEnabled(bool),
    /// Update mic preprocessing filter settings (gain, noise gate, dll).
    SetMicPre(MicSettings),
    /// Isi ring monitor dengan silence sampai level prefill (dipakai setelah
    /// stream monitor dibangun ulang supaya tidak langsung underrun).
    PrefillMonitor,
    /// Kosongkan buffer mic 48 kHz dari sisi consumer (mixer), aman walau
    /// stream mic sedang dibangun ulang.
    ResetMic,
    SetMode(PlayMode),
    Play {
        id: String,
        samples: Arc<Vec<f32>>,
        gain: f32,
    },
    Stop {
        id: Option<String>,
    },
    Tone {
        target: ToneTarget,
        freq: f32,
        duration_ms: u32,
    },
    Shutdown,
}

pub struct MixerSettings {
    pub mic_gain: f32,
    pub sfx_gain: f32,
    pub master_gain: f32,
    pub monitor_volume: f32,
    pub mic_muted: bool,
    pub sfx_muted: bool,
    pub monitor_enabled: bool,
    pub mode: PlayMode,
    pub mic_pre: MicSettings,
}

/// Mic pre-processing: boost, noise gate, compressor, limiter, EQ.
/// Diletakkan setelah mic_ring.pop di render() dan sebelum gain diterapkan.
#[derive(Clone)]
pub struct MicProcessor {
    settings: MicSettings,
    /// RMS envelope untuk noise gate (attack/release smoothing).
    rms_envelope: f32,
    /// State gain gate terakhir (untuk UI visualisasi).
    gate_gain: f32,
}

impl MicProcessor {
    pub fn new(settings: MicSettings) -> Self {
        Self {
            settings,
            // Init ke threshold_lin supaya gate terbuka sejak frame pertama.
            // Jika init ke 0.0, gate akan menutup total selama envelope
            // follower belum naik ke threshold — ini bisa terasa seperti
            // "mic tidak masuk" di awal.
            rms_envelope: 0.1,
            gate_gain: 1.0, // default pass-through (gate terbuka)
        }
    }

    pub fn update(&mut self, settings: MicSettings) {
        self.settings = settings;
    }

    /// dB ke linear amplitude.
    #[inline]
    fn db_to_linear(db: f32) -> f32 {
        10.0_f32.powf(db / 20.0)
    }

    /// RMS power dari frame (untuk noise gate & compressor sidechain).
    #[inline]
    fn rms(samples: &[f32]) -> f32 {
        let sum: f32 = samples.iter().map(|s| s * s).sum();
        (sum / samples.len() as f32).sqrt()
    }

    /// Proses satu frame mono mic. `samples` berisi BLOCK_FRAMES sampel.
    pub fn process(&mut self, samples: &mut [f32]) {
        let pre = &self.settings;
        let n = samples.len();

        // 1. Mic boost (amplifikasi dasar)
        if pre.mic_boost != 1.0 {
            for s in samples.iter_mut() {
                *s *= pre.mic_boost;
            }
        }

        // 2. Noise gate (envelope follower + hard gate)
        if pre.noise_gate_enabled {
            let threshold_lin = Self::db_to_linear(pre.noise_gate_threshold);
            let rms_now = Self::rms(samples);
            // Envelope follower: track RMS kecepatan attack cepat, release lambat.
            // Ini mencegah gate bereaksi pada transient kecil (gemerisik).
            let attack_coef = (-1.0 / ((pre.noise_gate_attack_ms / 1000.0 * SAMPLE_RATE as f32).max(1.0))).exp();
            let release_coef = (-1.0 / ((pre.noise_gate_release_ms / 1000.0 * SAMPLE_RATE as f32).max(1.0))).exp();
            if rms_now > self.rms_envelope {
                self.rms_envelope = attack_coef * self.rms_envelope + (1.0 - attack_coef) * rms_now;
            } else {
                self.rms_envelope = release_coef * self.rms_envelope + (1.0 - release_coef) * rms_now;
            }
            // Hard gate: jika envelope di bawah threshold → zerokan total.
            // Jika di atas → pass-through penuh (gain = 1.0, tidak ada attenuation).
            let gate_gain = if self.rms_envelope < threshold_lin {
                0.0 // gate tertutup total — hilangkan noise & gemerisik
            } else {
                1.0 // gate terbuka penuh — tidak ada attenuasi pada sinyal jelas
            };
            if gate_gain == 0.0 {
                samples.fill(0.0);
            } else {
                for s in samples.iter_mut() {
                    *s *= gate_gain;
                }
            }
            self.gate_gain = gate_gain; // simpan untuk visualisasi di UI
        }

        // 3. Compressor (soft-knee)
        if pre.compressor_enabled {
            let threshold_lin = Self::db_to_linear(pre.compressor_threshold);
            let rms_now = Self::rms(samples);
            if rms_now > threshold_lin {
                let over_db = 20.0 * (rms_now / threshold_lin).log10();
                let reduction_db = over_db * (1.0 - 1.0 / pre.compressor_ratio.max(1.0));
                let comp_gain = Self::db_to_linear(-reduction_db + pre.compressor_makeup_gain);
                for s in samples.iter_mut() {
                    *s *= comp_gain;
                }
            }
        }

        // 4. Limiter (hard ceiling)
        if pre.limiter_enabled {
            let ceiling = Self::db_to_linear(pre.limiter_ceiling); // nilai positif (mis. 0.99)
            let neg_ceiling = -ceiling;
            for s in samples.iter_mut() {
                *s = s.clamp(neg_ceiling, ceiling);
            }
        }

        // 5. 3-band EQ (simple shelving: low boost/cut, mid, high)
        if pre.equalizer_enabled {
            // Simple implementation: apply fixed-frequency shelf multipliers
            // berdasarkan posisi sample (low = bass, high = treble).
            // Untuk mono voice, gunakan static filter coefficients.
            // Implementasi sederhana: apply overall gain per band berdasarkan dB.
            let low_lin = Self::db_to_linear(pre.equalizer_low);
            let mid_lin = Self::db_to_linear(pre.equalizer_mid);
            let high_lin = Self::db_to_linear(pre.equalizer_high);
            // Simple 3-band: 0-20% low, 20-80% mid, 80-100% high (per sample position)
            let low_end = (n as f32 * 0.2) as usize;
            let high_start = (n as f32 * 0.8) as usize;
            for (i, s) in samples.iter_mut().enumerate() {
                if i < low_end {
                    *s *= low_lin;
                } else if i >= high_start {
                    *s *= high_lin;
                } else {
                    *s *= mid_lin;
                }
            }
        }
    }
}

struct Voice {
    id: String,
    samples: Arc<Vec<f32>>,
    pos: usize,
    gain: f32,
}

struct Tone {
    freq: f32,
    phase: f32,
    total_frames: u64,
    played_frames: u64,
    target: ToneTarget,
}

pub struct Mixer {
    app: tauri::AppHandle,
    cmd_rx: Receiver<MixerCommand>,
    cable_ring: Arc<SpscRing>,
    monitor_ring: Arc<SpscRing>,
    mic_ring: Arc<SpscRing>,
    cable_active: Arc<AtomicBool>,
    monitor_active: Arc<AtomicBool>,
    counters: Arc<Counters>,

    mic_gain: f32,
    sfx_gain: f32,
    master_gain: f32,
    monitor_volume: f32,
    mic_muted: bool,
    sfx_muted: bool,
    master_muted: bool,
    monitor_muted: bool,
    monitor_enabled: bool,
    mode: PlayMode,

    mic_processor: MicProcessor,

    voices: [Option<Voice>; MAX_VOICES],
    next_slot: usize,
    tone: Option<Tone>,
    last_level_at: Instant,
}

impl Mixer {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: tauri::AppHandle,
        cmd_rx: Receiver<MixerCommand>,
        cable_ring: Arc<SpscRing>,
        monitor_ring: Arc<SpscRing>,
        mic_ring: Arc<SpscRing>,
        cable_active: Arc<AtomicBool>,
        monitor_active: Arc<AtomicBool>,
        counters: Arc<Counters>,
        settings: MixerSettings,
    ) -> Self {
        Self {
            app,
            cmd_rx,
            cable_ring,
            monitor_ring,
            mic_ring,
            cable_active,
            monitor_active,
            counters,
            mic_gain: settings.mic_gain,
            sfx_gain: settings.sfx_gain,
            master_gain: settings.master_gain,
            monitor_volume: settings.monitor_volume,
            mic_muted: settings.mic_muted,
            sfx_muted: settings.sfx_muted,
            master_muted: false,
            monitor_muted: false,
            monitor_enabled: settings.monitor_enabled,
            mode: settings.mode,
            mic_processor: MicProcessor::new(settings.mic_pre.clone()),
            voices: std::array::from_fn(|_| None),
            next_slot: 0,
            tone: None,
            last_level_at: Instant::now(),
        }
    }

    pub fn run(mut self) {
        let mut block = vec![0.0f32; BLOCK_FRAMES * 2];
        let mut mic = vec![0.0f32; BLOCK_FRAMES];
        let mut cable_out = vec![0.0f32; BLOCK_FRAMES * 2];
        let mut monitor_out = vec![0.0f32; BLOCK_FRAMES * 2];

        loop {
            if !self.drain_commands() {
                break;
            }

            let cable_on = self.cable_active.load(Ordering::Acquire);
            let monitor_on = self.monitor_active.load(Ordering::Acquire) && self.monitor_enabled;
            if !cable_on && !monitor_on {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }

            let fill = if cable_on {
                self.cable_ring.len()
            } else {
                self.monitor_ring.len()
            };
            if fill >= PREFILL_SAMPLES {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            }

            // Render RENDER_QUANTUM blok (20 ms stereo) per iterasi agar
            // refill lebih flat dan tidak bursty.
            for _ in 0..RENDER_QUANTUM {
                self.render(
                    &mut block,
                    &mut mic,
                    &mut cable_out,
                    &mut monitor_out,
                    cable_on,
                    monitor_on,
                );

                if cable_on {
                    let _ = self.cable_ring.push(&cable_out);
                }
                if monitor_on {
                    // Koreksi drift jam monitor: buang blok kalau terlalu penuh,
                    // duplikasi blok kalau hampir kosong.
                    let fill = self.monitor_ring.len();
                    if fill < PREFILL_SAMPLES * 3 / 2 {
                        let _ = self.monitor_ring.push(&monitor_out);
                        if fill < PREFILL_SAMPLES / 4 {
                            let _ = self.monitor_ring.push(&monitor_out);
                        }
                    }
                }

                // Reset buffer untuk iterasi berikutnya.
                cable_out.fill(0.0);
                monitor_out.fill(0.0);
            }

            // Sleep pendek (0.5 ms) agar cpal callback tidak kehabiran.
            // 1 ms sebelumnya relatif lama untuk audio real-time pada 10 ms boundary.
            // Durasi mikro sleep tidak tersedia portably, gunakan 1 ms minimum
            // tapi kurangi beban dengan render quantum 2x.
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Kembalikan false kalau mixer harus berhenti.
    fn drain_commands(&mut self) -> bool {
        loop {
            match self.cmd_rx.try_recv() {
                Ok(command) => {
                    if !self.apply(command) {
                        return false;
                    }
                }
                Err(TryRecvError::Empty) => return true,
                Err(TryRecvError::Disconnected) => return false,
            }
        }
    }

    /// Kembalikan false kalau mixer harus berhenti.
    fn apply(&mut self, command: MixerCommand) -> bool {
        match command {
            MixerCommand::SetGain { bus, value } => {
                let value = value.clamp(0.0, 4.0);
                match bus {
                    Bus::Mic => self.mic_gain = value,
                    Bus::Sfx => self.sfx_gain = value,
                    Bus::Master => self.master_gain = value,
                    Bus::Monitor => self.monitor_volume = value,
                }
            }
            MixerCommand::SetMute { bus, muted } => match bus {
                Bus::Mic => self.mic_muted = muted,
                Bus::Sfx => self.sfx_muted = muted,
                Bus::Master => self.master_muted = muted,
                Bus::Monitor => self.monitor_muted = muted,
            },
            MixerCommand::SetMonitorEnabled(enabled) => {
                self.monitor_enabled = enabled;
            }
            MixerCommand::SetMicPre(settings) => {
                self.mic_processor.update(settings);
            }
            MixerCommand::PrefillMonitor => {
                if self.monitor_ring.len() < PREFILL_SAMPLES {
                    let silence = vec![0.0f32; PREFILL_SAMPLES - self.monitor_ring.len()];
                    let _ = self.monitor_ring.push(&silence);
                }
            }
            MixerCommand::ResetMic => {
                self.mic_ring.clear();
            }
            MixerCommand::SetMode(mode) => self.mode = mode,
            MixerCommand::Play { id, samples, gain } => self.play(id, samples, gain),
            MixerCommand::Stop { id } => self.stop(id.as_deref()),
            MixerCommand::Tone {
                target,
                freq,
                duration_ms,
            } => {
                self.tone = Some(Tone {
                    freq: freq.clamp(20.0, 20_000.0),
                    phase: 0.0,
                    total_frames: (SAMPLE_RATE as u64 * duration_ms.max(50) as u64) / 1000,
                    played_frames: 0,
                    target,
                });
            }
            MixerCommand::Shutdown => return false,
        }
        true
    }

    fn play(&mut self, id: String, samples: Arc<Vec<f32>>, gain: f32) {
        match self.mode {
            PlayMode::Interrupt => {
                self.voices = std::array::from_fn(|_| None);
                self.next_slot = 0;
                self.voices[0] = Some(Voice {
                    id,
                    samples,
                    pos: 0,
                    gain,
                });
                self.next_slot = 1;
            }
            PlayMode::Mix => {
                if let Some(voice) = self
                    .voices
                    .iter_mut()
                    .flatten()
                    .find(|voice| voice.id == id)
                {
                    voice.pos = 0;
                    voice.gain = gain;
                    voice.samples = samples;
                    return;
                }
                let slot = self.find_free_slot();
                self.voices[slot] = Some(Voice {
                    id,
                    samples,
                    pos: 0,
                    gain,
                });
                self.next_slot = (slot + 1) % MAX_VOICES;
            }
        }
    }

    fn find_free_slot(&mut self) -> usize {
        if let Some(index) = self.voices.iter().position(Option::is_none) {
            return index;
        }
        let slot = self.next_slot % MAX_VOICES;
        self.voices[slot] = None;
        slot
    }

    fn stop(&mut self, id: Option<&str>) {
        match id {
            Some(id) => {
                for voice in self.voices.iter_mut() {
                    if voice.as_ref().is_some_and(|voice| voice.id == id) {
                        *voice = None;
                    }
                }
            }
            None => self.voices = std::array::from_fn(|_| None),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render(
        &mut self,
        block: &mut [f32],
        mic: &mut [f32],
        cable_out: &mut [f32],
        monitor_out: &mut [f32],
        cable_on: bool,
        monitor_on: bool,
    ) {
        block.fill(0.0);
        mic.fill(0.0);

        // Mic: pop sebanyak yang tersedia; sisanya silence.
        let _ = self.mic_ring.pop(mic);
        // Terapkan mic pre-processing (boost/noise gate/compressor/limiter/EQ)
        // sebelum gain diterapkan di loop mixing di bawah.
        self.mic_processor.process(mic);

        // Voice soundboard.
        let mut active_voices = 0u32;
        for slot in self.voices.iter_mut() {
            let Some(voice) = slot.as_mut() else { continue };
            let total_frames = voice.samples.len() / 2;
            if voice.pos >= total_frames {
                *slot = None;
                continue;
            }
            let available = total_frames - voice.pos;
            let frames = available.min(BLOCK_FRAMES);
            for i in 0..frames {
                let source = (voice.pos + i) * 2;
                block[i * 2] += voice.samples[source] * voice.gain;
                block[i * 2 + 1] += voice.samples[source + 1] * voice.gain;
            }
            voice.pos += frames;
            if voice.pos >= total_frames {
                *slot = None;
            }
            active_voices += 1;
        }

        let mic_gain = if self.mic_muted { 0.0 } else { self.mic_gain };
        let sfx_gain = if self.sfx_muted { 0.0 } else { self.sfx_gain };
        let master_gain = if self.master_muted {
            0.0
        } else {
            self.master_gain
        };
        let monitor_volume = if self.monitor_muted {
            0.0
        } else {
            self.monitor_volume
        };

        let mut peak_mic = 0.0f32;
        let mut peak_sfx = 0.0f32;
        let mut peak_master = 0.0f32;

        // Tone dihitung per sample ke buffer kecil supaya frekuensinya benar
        // (bukan satu sample per blok, yang akan terdengar seperti buzz).
        let mut tone_block = [0.0f32; BLOCK_FRAMES];
        let mut tone_target = None;
        let mut tone_finished = false;
        if let Some(tone) = self.tone.as_mut() {
            tone_target = Some(tone.target);
            for slot in tone_block.iter_mut() {
                if tone.played_frames >= tone.total_frames {
                    break;
                }
                let fade_in = (tone.played_frames as f32 / TONE_FADE_FRAMES as f32).min(1.0);
                let remaining = tone.total_frames - tone.played_frames;
                let fade_out = (remaining as f32 / TONE_FADE_FRAMES as f32).min(1.0);
                let envelope = fade_in.min(fade_out);
                *slot = (tone.phase.sin() * 0.3 * envelope).clamp(-1.0, 1.0);
                tone.phase += std::f32::consts::TAU * tone.freq / SAMPLE_RATE as f32;
                if tone.phase >= std::f32::consts::TAU {
                    tone.phase -= std::f32::consts::TAU;
                }
                tone.played_frames += 1;
            }
            if tone.played_frames >= tone.total_frames {
                tone_finished = true;
            }
        }
        if tone_finished {
            self.tone = None;
        }

        for i in 0..BLOCK_FRAMES {
            let mic_sample = mic[i] * mic_gain;
            let sfx_l = block[i * 2] * sfx_gain;
            let sfx_r = block[i * 2 + 1] * sfx_gain;
            let program_l = mic_sample + sfx_l;
            let program_r = mic_sample + sfx_r;

            peak_mic = peak_mic.max(mic_sample.abs());
            peak_sfx = peak_sfx.max(sfx_l.abs().max(sfx_r.abs()));

            let master_l = soft_clip(program_l * master_gain);
            let master_r = soft_clip(program_r * master_gain);
            peak_master = peak_master.max(master_l.abs().max(master_r.abs()));

            if cable_on {
                let tone_cable = if tone_target.is_some_and(ToneTarget::cable) {
                    tone_block[i]
                } else {
                    0.0
                };
                cable_out[i * 2] = soft_clip((program_l + tone_cable) * master_gain);
                cable_out[i * 2 + 1] = soft_clip((program_r + tone_cable) * master_gain);
            }

            if monitor_on {
                let tone_monitor = if tone_target.is_some_and(ToneTarget::monitor) {
                    tone_block[i]
                } else {
                    0.0
                };
                monitor_out[i * 2] =
                    soft_clip((program_l + tone_monitor) * master_gain) * monitor_volume;
                monitor_out[i * 2 + 1] =
                    soft_clip((program_r + tone_monitor) * master_gain) * monitor_volume;
            }
        }

        if self.last_level_at.elapsed() >= Duration::from_millis(33) {
            self.last_level_at = Instant::now();
            let frame = LevelFrame {
                mic: peak_mic.clamp(0.0, 1.0),
                sfx: peak_sfx.clamp(0.0, 1.0),
                master: peak_master.clamp(0.0, 1.0),
                voices: active_voices,
                cable_underruns: self.counters.cable_underruns.load(Ordering::Relaxed),
                monitor_underruns: self.counters.monitor_underruns.load(Ordering::Relaxed),
            };
            let _ = self.app.emit("audio:levels", frame);
        }
    }
}

#[inline]
fn soft_clip(sample: f32) -> f32 {
    // KNEE dinaikkan dari 0.85 ke 0.95 sehingga lebih sedikit sample masuk
    // zona kompresi. Pada 0.85, hampir setengah waveform (jika gain > 1.0)
    // masuk ke zona non-linear yang bisa menghasilkan harmoni pecah / clipping
    // yang terdengar seperti "gelembung pecah". Knee 0.95 hampir linear sampai
    // -0.8 dB, yang jauh lebih alami untuk sound effect.
    const KNEE: f32 = 0.95;
    let magnitude = sample.abs();
    if magnitude <= KNEE {
        return sample;
    }
    let over = (magnitude - KNEE) / (1.0 - KNEE);
    // Gunakan kurva tanh yang lebih halus pada kneel area sehingga transisi
    // dari linear ke kompresi tidak menyentuh (derivative discontinuity di 0.85
    // sebelumnya bisa menghasilkan "klik").
    let limited = KNEE + (1.0 - KNEE) * (over / (1.0 + over));
    sample.signum() * limited
}
