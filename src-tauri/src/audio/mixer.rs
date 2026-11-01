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
// Mixer mengisi dua blok sekaligus (20 ms stereo) tiap iterasi agar refill
// lebih "flat" dan tidak bursty akibat sleep 1 ms yang terlalu pendek relatif.
const RENDER_QUANTUM: usize = 2;
const RENDER_QUANTUM_MS: usize = RENDER_QUANTUM * BLOCK_FRAMES * 1000 / SAMPLE_RATE;
const TONE_FADE_FRAMES: u64 = 480;

/// Prefill minimum. Ring harus selalu ≥ buffer output + satu render quantum,
/// kalau tidak callback cpal meminta lebih banyak data daripada yang tersedia
/// dan terjadi underrun. Nilai 0/terlalu kecil tidak dipakai.
fn prefill_ms_for(buffer_ms: u32) -> usize {
    (buffer_ms as usize).max(30) + RENDER_QUANTUM_MS
}

fn prefill_samples_for(buffer_ms: u32) -> usize {
    SAMPLE_RATE * 2 * prefill_ms_for(buffer_ms) / 1000
}

// Monitor drift correction. Fade pendek (2 ms) dipakai saat menyisipkan /
// membuang sample supaya clock monitor yang sedikit melenceng tidak
// menghasilkan klik akibat splice blok 20 ms utuh.
const DRIFT_FADE_FRAMES: usize = 96; // 2 ms stereo

/// Batas backlog mic. Kalau mixer sempat stall, ring bisa menumpuk ratusan ms
/// audio lama; sebelum diputar, sisanya dibuang supaya output tetap near-real-
/// time (bukan memutar percakapan yang sudah lewat).
const MIC_BACKLOG_LIMIT_MS: usize = 80;
const MIC_BACKLOG_TARGET_MS: usize = 30;

/// Mode koreksi drift jam monitor terhadap mixer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DriftMode {
    /// Kecepatan cocok: tulis blok apa adanya.
    Normal,
    /// Monitor kekurangan data: sisipkan ~2 ms supaya tidak starvation.
    Stretch,
    /// Monitor kelebihan data: buang ~2 ms supaya tidak overflow.
    Shrink,
}

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
    /// Ubah target prefill setelah ukuran buffer output berubah.
    SetBuffer { ms: u32 },
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
    /// Ukuran buffer output/input yang dipakai stream. Menentukan prefill.
    pub buffer_ms: u32,
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
    /// Target isi ring output (stereo sample). Dihitung dari `buffer_ms`.
    prefill_samples: usize,

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
            prefill_samples: prefill_samples_for(settings.buffer_ms),
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
        // Buffer susun drift monitor (dipakai ulang) + frame terakhir yang
        // sudah ditulis, untuk menjaga crossfade kontinu antar blok.
        let mut monitor_scratch: Vec<f32> = Vec::with_capacity(BLOCK_FRAMES * 4);
        let mut monitor_prev = [0.0f32; 2];

        loop {
            if !self.drain_commands() {
                break;
            }

            let cable_on = self.cable_active.load(Ordering::Acquire);
            let monitor_on = self.monitor_active.load(Ordering::Acquire) && self.monitor_enabled;
            if !cable_on && !monitor_on {
                // Monitor baru mati: reset frame terakhir supaya saat dinyalakan
                // lagi crossfade dimulai dari senyap, bukan sample basi.
                monitor_prev = [0.0, 0.0];
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }

            // Render hanya bila ADA satu ring yang masih di bawah prefill.
            // Sebelumnya hanya `cable_ring` yang dicek, sehingga saat cable
            // penuh tapi monitor kosong, monitor kehabisan data (underrun).
            let cable_fill = if cable_on {
                self.cable_ring.len()
            } else {
                self.prefill_samples
            };
            let monitor_fill = if monitor_on {
                self.monitor_ring.len()
            } else {
                self.prefill_samples
            };
            if cable_fill >= self.prefill_samples && monitor_fill >= self.prefill_samples {
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
                    // Koreksi drift jam monitor dengan crossfade pendek, bukan
                    // splice blok 20 ms utuh (yang menimbulkan klik).
                    let fill = self.monitor_ring.len();
                    let low = self.prefill_samples / 2;
                    let high = self.prefill_samples * 3 / 2;
                    let mode = if fill < low {
                        DriftMode::Stretch
                    } else if fill > high {
                        DriftMode::Shrink
                    } else {
                        DriftMode::Normal
                    };
                    monitor_prev = build_monitor_block(
                        monitor_prev,
                        &monitor_out,
                        mode,
                        &mut monitor_scratch,
                    );
                    let _ = self.monitor_ring.push(&monitor_scratch);
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
            MixerCommand::SetBuffer { ms } => {
                self.prefill_samples = prefill_samples_for(ms);
            }
            MixerCommand::PrefillMonitor => {
                if self.monitor_ring.len() < self.prefill_samples {
                    let silence = vec![0.0f32; self.prefill_samples - self.monitor_ring.len()];
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

        // Kalau mixer sempat stall (CPU sibuk / stream dibangun ulang), ring mic
        // bisa berisi ratusan ms audio lama. Buang kelebihannya sebelum diputar
        // supaya output tidak tertinggal dari ucapan user.
        let backlog_limit = SAMPLE_RATE * MIC_BACKLOG_LIMIT_MS / 1000;
        if self.mic_ring.len() > backlog_limit {
            let target = SAMPLE_RATE * MIC_BACKLOG_TARGET_MS / 1000;
            self.mic_ring.trim_to(target);
        }

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

/// Susun satu blok stereo monitor dengan koreksi drift yang mulus.
///
/// - `Normal`  : tulis `block` apa adanya.
/// - `Stretch` : sisipkan `DRIFT_FADE_FRAMES` hasil crossfade `prev -> block[0]`
///   sebelum blok (durasi +~2 ms). Ujung crossfade mendekati
///   `block[0]`, sehingga sambungan ke blok tetap kontinu.
/// - `Shrink`  : buang `DRIFT_FADE_FRAMES` pertama dari blok, lalu crossfade
///   `prev -> rest[0]` (durasi −~2 ms).
///
/// `prev` adalah frame stereo terakhir yang sudah ditulis ke ring. Fungsi
/// mengembalikan frame stereo terakhir yang tertulis untuk iterasi berikutnya.
/// `out` dipakai ulang (sudah cukup capacity) supaya tidak alokasi per blok.
fn build_monitor_block(
    prev: [f32; 2],
    block: &[f32],
    mode: DriftMode,
    out: &mut Vec<f32>,
) -> [f32; 2] {
    out.clear();
    let frames = block.len() / 2;
    let fade = DRIFT_FADE_FRAMES.min(frames.saturating_sub(1)).max(1);

    match mode {
        DriftMode::Normal => {
            out.extend_from_slice(block);
        }
        DriftMode::Stretch => {
            let first = [block[0], block[1]];
            for i in 0..fade {
                let t = (i + 1) as f32 / (fade as f32 + 1.0);
                out.push(prev[0] + (first[0] - prev[0]) * t);
                out.push(prev[1] + (first[1] - prev[1]) * t);
            }
            out.extend_from_slice(block);
        }
        DriftMode::Shrink => {
            let skip = (fade * 2).min(block.len().saturating_sub(2));
            let rest = &block[skip..];
            if rest.len() < 2 {
                return prev;
            }
            for i in 0..rest.len() / 2 {
                if i < fade {
                    let t = (i + 1) as f32 / (fade as f32 + 1.0);
                    out.push(prev[0] + (rest[i * 2] - prev[0]) * t);
                    out.push(prev[1] + (rest[i * 2 + 1] - prev[1]) * t);
                } else {
                    out.push(rest[i * 2]);
                    out.push(rest[i * 2 + 1]);
                }
            }
        }
    }

    let len = out.len();
    if len >= 2 {
        [out[len - 2], out[len - 1]]
    } else {
        prev
    }
}

#[inline]
fn soft_clip(sample: f32) -> f32 {
    // Hanya hard-clip ketika sample melebihi 0 dBFS. Soft-clip dengan knee
    // di 0.95/0.85 sebelumnya menyebabkan distorsi harmonik "gelembung pecah"
    // pada sound effect yang hampir clip, terutama bila master_gain>1.
    // Hard clip di 1.0 hanya berdampak pada sinyal yang benar-benar melampaui
    // ceiling digital — untuk sfx yang sudah within range, tanpa distorsi.
    sample.clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::settings::AudioSettings;

    /// Sinyal kontinu (ramp) untuk mendeteksi klik: setiap sample naik +0.001.
    fn ramp_block(frames: usize, start: f32) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let v = start + i as f32 * 0.001;
            out.push(v);
            out.push(v);
        }
        out
    }

    /// Lonjakan maksimum antar sample bertetangga (klik = lonjakan besar).
    fn max_step(samples: &[f32]) -> f32 {
        let frames = samples.as_chunks::<2>().0;
        frames
            .iter()
            .zip(frames.iter().skip(1))
            .map(|(a, b)| (b[0] - a[0]).abs().max((b[1] - a[1]).abs()))
            .fold(0.0f32, f32::max)
    }

    #[test]
    fn drift_normal_tidak_mengubah_blok() {
        let block = ramp_block(BLOCK_FRAMES, 0.0);
        let mut out = Vec::new();
        let prev = build_monitor_block([0.0, 0.0], &block, DriftMode::Normal, &mut out);
        assert_eq!(out, block);
        assert_eq!(prev, [block[block.len() - 2], block[block.len() - 1]]);
    }

    #[test]
    fn drift_stretch_menambah_durasi_tanpa_klik() {
        // prev kontinu dengan awal blok (sinyal nyata tidak pernah lompat),
        // sehingga crossfade seharusnya mulus.
        let block = ramp_block(BLOCK_FRAMES, 1.0);
        let prev = [1.0 - 0.001, 1.0 - 0.001];
        let mut out = Vec::new();
        let new_prev = build_monitor_block(prev, &block, DriftMode::Stretch, &mut out);

        let added = out.len() - block.len();
        assert_eq!(added, DRIFT_FADE_FRAMES * 2, "stretch harus menambah ~2 ms");

        let mut joined = Vec::with_capacity(out.len() + 2);
        joined.extend_from_slice(&prev);
        joined.extend_from_slice(&out);
        assert!(
            max_step(&joined) < 0.05,
            "crossfade stretch menimbulkan klik: step {:.4}",
            max_step(&joined)
        );
        assert_eq!(
            new_prev,
            [out[out.len() - 2], out[out.len() - 1]],
            "prev harus berupa frame terakhir yang tertulis"
        );
    }

    #[test]
    fn drift_shrink_mengurangi_durasi_tanpa_klik() {
        let block = ramp_block(BLOCK_FRAMES, 1.0);
        let prev = [0.999, 0.999];
        let mut out = Vec::new();
        build_monitor_block(prev, &block, DriftMode::Shrink, &mut out);

        let removed = block.len() - out.len();
        assert_eq!(removed, DRIFT_FADE_FRAMES * 2, "shrink harus mengurangi ~2 ms");

        let mut joined = Vec::with_capacity(out.len() + 2);
        joined.extend_from_slice(&prev);
        joined.extend_from_slice(&out);
        assert!(
            max_step(&joined) < 0.05,
            "crossfade shrink menimbulkan klik: step {:.4}",
            max_step(&joined)
        );
    }

    #[test]
    fn drift_blok_kecil_tidak_panik() {
        let block = ramp_block(2, 0.0);
        let mut out = Vec::new();
        for mode in [DriftMode::Normal, DriftMode::Stretch, DriftMode::Shrink] {
            let _ = build_monitor_block([0.0, 0.0], &block, mode, &mut out);
        }
    }

    #[test]
    fn monitor_sfx_only_dibaca_dari_settings_bukan_hardcoded() {
        // Regression: engine dulu selalu mengirim `monitor_sfx_only: false` ke
        // MixerSettings meskipun settings menyimpan `true`.
        let settings = AudioSettings {
            monitor_sfx_only: true,
            ..Default::default()
        };
        assert!(settings.monitor_sfx_only);

        // AudioState yang dipublish juga harus membawa nilai yang sama.
        let state = crate::audio::engine::state_from_settings(&settings);
        assert!(state.monitor_sfx_only);
    }

    #[test]
    fn prefill_selalu_di_atas_buffer_output() {
        // Callback cpal meminta `buffer_ms` data sekaligus. Kalau prefill lebih
        // kecil, setiap callback pasti underrun. Prefill juga harus menyisakan
        // satu render quantum untuk refill.
        for buffer_ms in [10, 20, 30, 40, 60, 80, 120] {
            let prefill = prefill_ms_for(buffer_ms);
            assert!(
                prefill >= buffer_ms as usize + RENDER_QUANTUM_MS,
                "buffer {buffer_ms} ms: prefill {prefill} ms terlalu kecil"
            );
        }
    }

    #[test]
    fn prefill_samples_mengikuti_buffer_ms() {
        assert_eq!(
            prefill_samples_for(30),
            SAMPLE_RATE * 2 * (30 + RENDER_QUANTUM_MS) / 1000
        );
        // Buffer 0 dinormalisasi ke minimum, bukan default driver.
        assert_eq!(prefill_samples_for(0), prefill_samples_for(30));
    }
}
