//! Mixer thread: satu-satunya tempat yang melakukan mixing.
//!
//! Thread ini memiliki voice bank, gain, mute, tone generator, dan meter.
//! Callback cpal hanya membaca ring buffer, sehingga tidak ada lock/alokasi
//! di jalur real-time.

use crate::audio::mic_dsp::MicChain;
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
// 60 ms stereo cukup untuk menampung 3 iterasi mixer (masing-masing 20 ms)
// sehingga cpal callback tidak kehabisan saat thread mixer terlepas sekilas.
// 240 ms sebelumnya berlebihan dan menambah delay 180 ms pada mic monitoring.
const PREFILL_SAMPLES: usize = SAMPLE_RATE * 2 * 60 / 1000; // 60 ms stereo
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
    SetMonitorSfxOnly(bool),
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
    pub monitor_sfx_only: bool,
    pub monitor_enabled: bool,
    pub mode: PlayMode,
    pub mic_pre: MicSettings,
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
    monitor_sfx_only: bool,
    monitor_enabled: bool,
    mode: PlayMode,

    mic_chain: MicChain,

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
            monitor_sfx_only: settings.monitor_sfx_only,
            monitor_enabled: settings.monitor_enabled,
            mode: settings.mode,
            mic_chain: MicChain::new(settings.mic_pre),
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
            MixerCommand::SetMonitorSfxOnly(only) => {
                self.monitor_sfx_only = only;
            }
            MixerCommand::SetMicPre(settings) => {
                self.mic_chain.set_settings(settings);
            }
            MixerCommand::PrefillMonitor => {
                if self.monitor_ring.len() < PREFILL_SAMPLES {
                    let silence = vec![0.0f32; PREFILL_SAMPLES - self.monitor_ring.len()];
                    let _ = self.monitor_ring.push(&silence);
                }
            }
            MixerCommand::ResetMic => {
                self.mic_ring.clear();
                self.mic_chain.reset();
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
        // Terapkan mic DSP (HPF/denoise/gate/boost/EQ/comp/limiter) sebelum
        // gain diterapkan di loop mixing di bawah.
        let mic_meters = self.mic_chain.process(mic);

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
                // Jika monitor_sfx_only: kirim hanya sfx ke speaker (tanpa mic),
                // tapi cable tetap dapat mic + sfx untuk Discord.
                let (mon_l, mon_r) = if self.monitor_sfx_only {
                    (sfx_l, sfx_r)
                } else {
                    (program_l, program_r)
                };
                monitor_out[i * 2] =
                    soft_clip((mon_l + tone_monitor) * master_gain) * monitor_volume;
                monitor_out[i * 2 + 1] =
                    soft_clip((mon_r + tone_monitor) * master_gain) * monitor_volume;
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
                mic_in_db: mic_meters.input_db,
                gate_in_db: mic_meters.gate_in_db,
                gate_open: mic_meters.gate_open,
                gate_gain_db: mic_meters.gate_gain_db,
                comp_gr_db: mic_meters.comp_gr_db,
                limiter_gr_db: mic_meters.limiter_gr_db,
                vad: mic_meters.vad,
            };
            let _ = self.app.emit("audio:levels", frame);
        }
    }
}

#[inline]
fn soft_clip(sample: f32) -> f32 {
    // Hanya hard-clip ketika sample melebihi 0 dBFS. Soft-clip dengan knee
    // di 0.95/0.85 sebelumnya menyebabkan distorsi harmonik "gelembung pecah"
    // pada sound effect yang hampir clip, terutama bila master_gain>1.
    // Hard clip di 1.0 hanya berdampak pada sinyal yang benar-benar melampaui
    // ceiling digital — untuk sfx yang sudah within range, tanpa distorsi.
    if sample > 1.0 {
        1.0
    } else if sample < -1.0 {
        -1.0
    } else {
        sample
    }
}
