//! Mic DSP chain.
//!
//! Urutan final (lihat docs/mic-dsp-plan.md):
//! `HPF 80 Hz -> Notch -> Denoise -> Gate -> Boost -> EQ -> Compressor -> Limiter`.
//!
//! Modul ini sengaja tidak bergantung pada cpal/Tauri supaya bisa diuji lewat
//! unit test dan contoh offline (`examples/mic_offline.rs`). Semua state
//! dialokasikan saat `MicChain::new()`; `process()` tidak melakukan alokasi.

use crate::audio::settings::MicSettings;
use nnnoiseless::DenoiseState;

/// Sample rate internal engine. Sama dengan `mixer::SAMPLE_RATE`.
pub const SAMPLE_RATE: f32 = 48_000.0;

/// Safety ceiling akhir chain: −0.1 dBFS. Diterapkan setelah limiter (dan juga
/// saat limiter off) supaya output mic tidak pernah menyentuh full-scale.
const SAFETY_CEILING: f32 = 0.988_553;

/// Meter yang dikembalikan per blok. Nilai dB memakai -100.0 sebagai silence.
#[derive(Clone, Copy, Debug)]
pub struct MicMeters {
    pub input_db: f32,
    pub gate_in_db: f32,
    pub gate_open: bool,
    pub gate_gain_db: f32,
    pub comp_gr_db: f32,
    pub limiter_gr_db: f32,
    pub vad: f32,
}

impl Default for MicMeters {
    fn default() -> Self {
        Self {
            input_db: -100.0,
            gate_in_db: -100.0,
            gate_open: false,
            gate_gain_db: 0.0,
            comp_gr_db: 0.0,
            limiter_gr_db: 0.0,
            vad: 0.0,
        }
    }
}

#[inline]
pub fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

/// Amplitude linear ke dBFS dengan floor tertentu. Floor -100 dipakai meter;
/// floor -120 dipakai `gateInDb` supaya "learn noise floor" masih bisa
/// mengukur noise ruangan yang sangat pelan.
#[inline]
pub fn to_db_floor(amplitude: f32, floor: f32) -> f32 {
    if amplitude > 0.0 {
        (20.0 * amplitude.log10()).max(floor)
    } else {
        floor
    }
}

/// Amplitude linear ke dBFS, dengan floor -100 dB supaya log10 tidak -inf.
#[inline]
pub fn to_db(amplitude: f32) -> f32 {
    to_db_floor(amplitude, -100.0)
}

#[inline]
fn one_pole(ms: f32) -> f32 {
    let samples = (ms.max(0.1) / 1000.0 * SAMPLE_RATE).max(1.0);
    (-1.0 / samples).exp()
}

/// Median dari tiga sample. Dipakai de-click: impuls satu-sample (kresek dari
/// jack/konektor) akan diganti nilai tengah tanpa mengubah sinyal normal.
#[inline]
fn median3(a: f32, b: f32, c: f32) -> f32 {
    a.max(b).min(a.min(b).max(c))
}

/// Biquad RBJ transposed direct form II.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        Self::bypass()
    }
}

impl Biquad {
    pub const fn bypass() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn set(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        if !a0.is_finite() || a0.abs() < 1.0e-9 {
            *self = Self::bypass();
            return;
        }
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    /// RBJ high-pass, Q = 0.7071 untuk respons Butterworth.
    pub fn highpass(&mut self, freq: f32, q: f32) {
        let w0 = std::f32::consts::TAU * freq.clamp(10.0, 20_000.0) / SAMPLE_RATE;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.1));
        self.set(
            (1.0 + cos) / 2.0,
            -(1.0 + cos),
            (1.0 + cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        );
    }

    /// RBJ low-pass. Dipakai filter sidechain gate (batas atas 4 kHz).
    pub fn lowpass(&mut self, freq: f32, q: f32) {
        let w0 = std::f32::consts::TAU * freq.clamp(10.0, 20_000.0) / SAMPLE_RATE;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.1));
        self.set(
            (1.0 - cos) / 2.0,
            1.0 - cos,
            (1.0 - cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        );
    }

    /// RBJ notch. Q tinggi = notch sempit.
    pub fn notch(&mut self, freq: f32, q: f32) {
        let w0 = std::f32::consts::TAU * freq.clamp(10.0, 20_000.0) / SAMPLE_RATE;
        let cos = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.1));
        self.set(1.0, -2.0 * cos, 1.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha);
    }

    /// RBJ low-shelf (boost/cut bass). `db` = gain dalam dB.
    pub fn lowshelf(&mut self, freq: f32, db: f32, q: f32) {
        let w0 = std::f32::consts::TAU * freq.clamp(10.0, 20_000.0) / SAMPLE_RATE;
        let cos = w0.cos();
        let sin = w0.sin();
        let a = db_to_linear(db);
        let alpha = sin / (2.0 * (q * (a + 1.0 / a + 2.0).sqrt()));
        let sqrt_a = a.sqrt();
        let b0 = a * ((a + 1.0) - (a - 1.0) * cos + 2.0 * sqrt_a * alpha);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cos - 2.0 * sqrt_a * alpha);
        let a0 = (a + 1.0) + (a - 1.0) * cos + 2.0 * sqrt_a * alpha;
        let a1_val = -2.0 * ((a - 1.0) + (a + 1.0) * cos);
        let a2_val = (a + 1.0) + (a - 1.0) * cos - 2.0 * sqrt_a * alpha;
        self.set(b0, b1, b2, a0, a1_val, a2_val);
    }

    /// RBJ high-shelf (boost/cut treble). `db` = gain dalam dB.
    pub fn highshelf(&mut self, freq: f32, db: f32, q: f32) {
        let w0 = std::f32::consts::TAU * freq.clamp(10.0, 20_000.0) / SAMPLE_RATE;
        let cos = w0.cos();
        let sin = w0.sin();
        let a = db_to_linear(db);
        let alpha = sin / (2.0 * (q * (a + 1.0 / a + 2.0).sqrt()));
        let sqrt_a = a.sqrt();
        let b0 = a * ((a + 1.0) + (a - 1.0) * cos + 2.0 * sqrt_a * alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cos - 2.0 * sqrt_a * alpha);
        let a0 = (a + 1.0) - (a - 1.0) * cos + 2.0 * sqrt_a * alpha;
        let a1_val = 2.0 * ((a - 1.0) - (a + 1.0) * cos);
        let a2_val = (a + 1.0) - (a - 1.0) * cos - 2.0 * sqrt_a * alpha;
        self.set(b0, b1, b2, a0, a1_val, a2_val);
    }

    /// RBJ peaking EQ. `db` = gain, `q` = bandwidth, `freq` = center freq.
    pub fn peak(&mut self, freq: f32, db: f32, q: f32) {
        let w0 = std::f32::consts::TAU * freq.clamp(10.0, 20_000.0) / SAMPLE_RATE;
        let cos = w0.cos();
        let sin = w0.sin();
        let a = db_to_linear(db);
        let alpha = sin / (2.0 * q.max(0.1));
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1_val = -2.0 * cos;
        let a2_val = 1.0 - alpha / a;
        self.set(b0, b1, b2, a0, a1_val, a2_val);
    }
}

/// Panjang satu frame RNNoise (10 ms @ 48 kHz).
const DENOISE_FRAME: usize = 480;
/// Total delay jalur wet: 1 frame buffering + 1 frame lag internal RNNoise.
/// Dry ikut ditunda sebesar ini supaya penjumlahan dry/wet tidak comb-filter.
const DENOISE_LATENCY: usize = DENOISE_FRAME * 2;
/// Level peak target untuk input RNNoise (≈ -10 dBFS, dengan headroom).
const DENOISE_TARGET_PEAK: f32 = 0.30;
/// Batas atas pregain adaptif supaya noise floor tidak ikut dikuatkan.
const DENOISE_MAX_PREGAIN: f32 = 4.0;

/// RNNoise-based noise suppression (Fase 3).
///
/// Frame 480 sample = 10 ms @ 48 kHz. Output frame baru keluar satu frame
/// setelah input (lag internal RNNoise), jadi total delay jalur wet = 2 frame
/// (20 ms); `dry` ditunda sebesar itu juga supaya penjumlahan dry/wet tidak
/// comb-filter.
///
/// Pregain dibuat adaptif: RNNoise memakai skala i16, sehingga input
/// dinormalisasi ke sekitar -10 dBFS peak. Gain tetap +12 dB sebelumnya
/// membuat sinyal di atas -12 dBFS clip dan terdengar sebagai "kresek".
struct Denoise {
    enabled: bool,
    target_mix: f32,
    mix: f32,
    mix_coef: f32,
    state: Option<Box<DenoiseState>>,
    frame_in: [f32; DENOISE_FRAME],
    frame_out: [f32; DENOISE_FRAME],
    fill: usize,
    out_pos: usize,
    ready: bool,
    /// Frame pertama output RNNoise masih berisi state lama → dibuang.
    skip_first: bool,
    /// Dry delay sepanjang latency wet.
    dry_delay: [f32; DENOISE_LATENCY],
    delay_pos: usize,
    /// Envelope peak lambat untuk pregain adaptif.
    env: f32,
    env_release: f32,
    pregain: f32,
    pregain_coef: f32,
    /// Gain pregain per sample untuk frame yang sedang di-encode.
    frame_gain: [f32; DENOISE_FRAME],
    /// Gain per sample untuk frame yang output-nya sedang dibaca.
    decode_gain: [f32; DENOISE_FRAME],
    /// Gain frame sebelumnya (output RNNoise tertinggal satu frame).
    prev_gain: [f32; DENOISE_FRAME],
    /// VAD 0..1 dari frame terakhir, dipakai gate.
    vad: f32,
}

impl Default for Denoise {
    fn default() -> Self {
        Self {
            enabled: false,
            target_mix: 0.8,
            mix: 0.0,
            mix_coef: one_pole(20.0),
            state: None,
            frame_in: [0.0; DENOISE_FRAME],
            frame_out: [0.0; DENOISE_FRAME],
            fill: 0,
            out_pos: 0,
            ready: false,
            skip_first: true,
            dry_delay: [0.0; DENOISE_LATENCY],
            delay_pos: 0,
            env: 0.0,
            env_release: one_pole(300.0),
            pregain: 1.0,
            pregain_coef: one_pole(300.0),
            frame_gain: [1.0; DENOISE_FRAME],
            decode_gain: [1.0; DENOISE_FRAME],
            prev_gain: [1.0; DENOISE_FRAME],
            vad: 0.0,
        }
    }
}

impl Denoise {
    fn active(&self) -> bool {
        self.enabled && self.target_mix > 0.001
    }

    fn configure(&mut self, settings: &MicSettings) {
        let was_active = self.active();
        self.enabled = settings.denoise_enabled;
        self.target_mix = settings.denoise_mix;
        if !self.active() {
            self.mix = 0.0;
            self.vad = 0.0;
        } else if !was_active {
            // State sudah dialokasikan saat chain dibuat. Jangan alokasi di
            // jalur mixer; cukup flush memori internal agar tidak ada sisa
            // audio lama saat denoise baru diaktifkan.
            self.prime();
            self.flush_state();
        }
    }

    /// Pastikan `DenoiseState` sudah ada. Dipanggil sekali dari
    /// `MicChain::new()` supaya toggle denoise tidak pernah alokasi.
    fn ensure_state(&mut self) {
        if self.state.is_none() {
            self.state = Some(DenoiseState::new());
        }
    }

    /// Buang memori internal RNNoise dengan memberi dua frame senyap.
    fn flush_state(&mut self) {
        let Some(ref mut state) = self.state else {
            return;
        };
        let silence = [0.0f32; DENOISE_FRAME];
        let mut out = [0.0f32; DENOISE_FRAME];
        let _ = state.process_frame(&mut out, &silence);
        let _ = state.process_frame(&mut out, &silence);
    }

    fn prime(&mut self) {
        self.fill = 0;
        self.out_pos = 0;
        self.ready = false;
        self.skip_first = true;
        self.mix = 0.0;
        self.vad = 0.0;
        self.env = 0.0;
        self.pregain = 1.0;
        self.frame_gain.fill(1.0);
        self.decode_gain.fill(1.0);
        self.prev_gain.fill(1.0);
        self.frame_in.fill(0.0);
        self.frame_out.fill(0.0);
    }

    fn reset(&mut self) {
        self.prime();
        // Reset perangkat: buang histori delay supaya tidak memutar audio lama.
        self.dry_delay.fill(0.0);
        self.delay_pos = 0;
        self.flush_state();
    }

    /// Proses satu sample. Bila denoise off/mix 0, sample dikembalikan apa
    /// adanya (tanpa delay) dan RNNoise tidak dipanggil sama sekali.
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        // Delay line selalu berjalan (murah) supaya saat denoise diaktifkan
        // di tengah stream, `delayed` sudah berisi audio nyata.
        let delayed = self.dry_delay[self.delay_pos];
        self.dry_delay[self.delay_pos] = x;
        self.delay_pos += 1;
        if self.delay_pos == DENOISE_LATENCY {
            self.delay_pos = 0;
        }

        if !self.active() {
            return x;
        }

        // ---- Pregain adaptif ----
        // Normalisasi ke sekitar -10 dBFS peak. Envelope bereaksi instan saat
        // level naik dan hanya melepas perlahan, jadi mic keras tidak pernah
        // dikuatkan lalu clip. Gain minimal 1.0 supaya sinyal keras tidak
        // diubah; batas atas 4.0 supaya noise floor tidak diblow-up.
        let level = x.abs();
        if level > self.env {
            self.env = level;
        } else {
            self.env += self.env_release * (level - self.env);
        }
        let desired = (DENOISE_TARGET_PEAK / self.env.max(1.0e-4))
            .clamp(1.0, DENOISE_MAX_PREGAIN);
        if desired < self.pregain {
            // Turunkan gain segera supaya tidak ada sample yang clip.
            self.pregain = desired;
        } else {
            self.pregain += self.pregain_coef * (desired - self.pregain);
        }

        // ---- Wet: output frame yang selesai pada blok sebelumnya ----
        let wet_ready = self.ready;
        let wet = if wet_ready {
            let value = self.frame_out[self.out_pos];
            let gain = self.decode_gain[self.out_pos].max(1.0e-3);
            self.out_pos += 1;
            if self.out_pos == DENOISE_FRAME {
                self.out_pos = 0;
                self.ready = false;
            }
            value / 32_768.0 / gain
        } else {
            0.0
        };

        // ---- Encode frame saat ini (skala i16 untuk RNNoise) ----
        // Gain dicatat per sample supaya transient keras di tengah frame tidak
        // ter-clip dan decode memakai gain yang sama persis.
        let gain = self.pregain;
        self.frame_gain[self.fill] = gain;
        self.frame_in[self.fill] = (x * gain * 32_768.0).clamp(-32_768.0, 32_767.0);
        self.fill += 1;

        if self.fill == DENOISE_FRAME {
            self.fill = 0;
            if let Some(ref mut state) = self.state {
                let vad = state.process_frame(&mut self.frame_out, &self.frame_in);
                self.vad = if vad.is_finite() {
                    vad.clamp(0.0, 1.0)
                } else {
                    0.0
                };
            }
            if self.skip_first {
                // Output frame pertama adalah state lama/kosong; buang.
                self.skip_first = false;
            } else {
                // Output frame ini berisi input frame sebelumnya, jadi gain
                // yang dipakai adalah gain frame sebelumnya.
                self.decode_gain.copy_from_slice(&self.prev_gain);
                self.ready = true;
            }
            self.prev_gain.copy_from_slice(&self.frame_gain);
        }

        self.mix += self.mix_coef * (self.target_mix - self.mix);
        if wet_ready {
            delayed * (1.0 - self.mix) + wet * self.mix
        } else {
            // Belum ada frame wet yang valid (awal stream / baru diaktifkan):
            // pakai dry tertunda supaya output tetap kontinu.
            delayed
        }
    }
}

/// Noise gate per sample dengan sidechain level, hysteresis, hold, dan range.
///
/// Detektor memakai sinyal yang sudah difilter 100 Hz–4 kHz supaya rumble dan
/// desis tinggi tidak membuka gate. VAD dari denoise (Fase 3) bisa ikut
/// membuka gate lewat `vad`.
#[derive(Clone, Copy, Debug)]
struct Gate {
    enabled: bool,
    env: f32,
    gain: f32,
    open: bool,
    hold_left: u32,
    hold_samples: u32,
    open_thr: f32,
    close_thr: f32,
    range_gain: f32,
    det_attack: f32,
    det_release: f32,
    gain_attack: f32,
    gain_release: f32,
    /// Sidechain band-pass: HPF 100 Hz lalu LPF 4 kHz.
    sc_hp: Biquad,
    sc_lp: Biquad,
    /// Probabilitas voice 0..1 dari denoise. 0 = belum aktif.
    vad: f32,
}

/// Panjang lookahead limiter (4 ms @ 48 kHz).
const LIMITER_LOOKAHEAD: usize = (SAMPLE_RATE * 0.004) as usize;

/// Lookahead limiter: mencegah clipping dengan lookahead 4 ms.
///
/// Versi sebelumnya menghitung gain dari sample yang sudah ditunda, sehingga
/// tidak ada lookahead sama sekali (peak baru diredam setelah lolos). Sekarang:
///
/// 1. Envelope gain dihitung dari sample **masuk** (instant attack + release).
/// 2. Audio ditunda `LIMITER_LOOKAHEAD` sample.
/// 3. Gain yang dipakai adalah **sliding-min** envelope selama window lookahead.
///
/// Sliding-min membuat peak yang akan keluar beberapa ms kemudian sudah
/// menurunkan gain sejak sekarang. Window `delay + 1` memastikan peak tetap
/// menahan gain sampai sample tersebut benar-benar keluar.
struct LookaheadLimiter {
    /// Buffer audio yang ditunda sebesar lookahead.
    delay: Vec<f32>,
    write_pos: usize,
    /// Riwayat envelope gain untuk sliding-min (delay + 1 sample).
    gain_hist: Vec<f32>,
    gain_pos: usize,
    /// Release per sample (attack selalu instan).
    release_coef: f32,
    /// Envelope gain pada sample masuk (≤ 1.0).
    env: f32,
    /// Lookahead dalam sample (4 ms = 192 sample @ 48 kHz).
    delay_samples: usize,
    release_ms: f32,
}

impl LookaheadLimiter {
    fn new(release_ms: f32) -> Self {
        let delay_samples = LIMITER_LOOKAHEAD;
        Self {
            delay: vec![0.0; delay_samples],
            write_pos: 0,
            gain_hist: vec![1.0; delay_samples + 1],
            gain_pos: 0,
            release_coef: one_pole(release_ms.max(5.0)),
            env: 1.0,
            delay_samples,
            release_ms,
        }
    }

    fn configure(&mut self, release_ms: f32) {
        self.release_ms = release_ms.max(5.0);
        self.release_coef = one_pole(self.release_ms);
    }

    fn reset(&mut self) {
        self.delay.fill(0.0);
        self.write_pos = 0;
        self.gain_hist.fill(1.0);
        self.gain_pos = 0;
        self.env = 1.0;
    }

    /// Proses satu blok. `ceiling` = linear (0.0–1.0). Kembalikan gain reduction
    /// maksimum dalam dB untuk metering.
    #[inline]
    fn process(&mut self, samples: &mut [f32], ceiling: f32) -> f32 {
        let mut max_reduction_db = 0.0f32;
        let ceiling = ceiling.clamp(0.0, 1.0);

        for x in samples.iter_mut() {
            // Baca sample tertua sebelum slot ditimpa sample baru (delay penuh).
            let delayed = self.delay[self.write_pos];
            self.delay[self.write_pos] = *x;
            self.write_pos += 1;
            if self.write_pos == self.delay_samples {
                self.write_pos = 0;
            }

            // Envelope gain dari sample masuk: attack instan, release lambat.
            let level = x.abs();
            let target_gain = if ceiling > 0.0 && level > ceiling {
                ceiling / level
            } else {
                1.0
            };
            if target_gain < self.env {
                self.env = target_gain;
            } else {
                self.env = target_gain + self.release_coef * (self.env - target_gain);
            }
            self.env = self.env.clamp(0.0, 1.0);

            self.gain_hist[self.gain_pos] = self.env;
            self.gain_pos += 1;
            if self.gain_pos == self.gain_hist.len() {
                self.gain_pos = 0;
            }

            // Gain minimum selama window lookahead. Peak yang belum keluar
            // sudah menahan gain sejak sekarang.
            let mut gain = 1.0f32;
            for &history in &self.gain_hist {
                if history < gain {
                    gain = history;
                }
            }

            let reduction_db = if gain > 0.0 {
                -20.0 * gain.log10()
            } else {
                96.0
            };
            if reduction_db > max_reduction_db {
                max_reduction_db = reduction_db;
            }

            // Safety: tidak ada sample yang boleh melewati ceiling.
            let limited = delayed * gain;
            *x = limited.clamp(-ceiling, ceiling);
        }

        max_reduction_db
    }
}

impl Default for LookaheadLimiter {
    fn default() -> Self {
        Self::new(50.0)
    }
}

// ---- Compressor (Fase 5: soft-knee dB, per-sample gain computer) ----

/// Lebar soft-knee total (dB). Kurva kuadratik menghubungkan bagian linear
/// (di bawah threshold) dengan kurva rasio penuh.
const COMP_KNEE_DB: f32 = 6.0;
/// Attack: gain turun cepat saat level naik di atas threshold.
const COMP_ATTACK_MS: f32 = 5.0;
/// Release: gain pulih perlahan supaya tidak pumping.
const COMP_RELEASE_MS: f32 = 50.0;

struct Compressor {
    attack_coef: f32,
    release_coef: f32,
    gain: f32,
}
impl Default for Compressor {
    fn default() -> Self {
        Self {
            attack_coef: one_pole(COMP_ATTACK_MS),
            release_coef: one_pole(COMP_RELEASE_MS),
            gain: 1.0,
        }
    }
}

impl Compressor {
    fn configure(&mut self) {
        self.attack_coef = one_pole(COMP_ATTACK_MS);
        self.release_coef = one_pole(COMP_RELEASE_MS);
    }

    fn reset(&mut self) {
        self.gain = 1.0;
    }

    /// Hitung gain kompresi per-sample. Kembalikan *gain reduction* dalam dB
    /// (untuk metering) dan timpa `samples` in-place dengan gain yang
    /// di-smooth (makeup gain sudah termasuk).
    ///
    /// Kurva statis (dB):
    /// - di bawah `threshold - knee/2`: gain 0 dB
    /// - di dalam knee: `(1/ratio - 1) * (x - threshold + knee/2)^2 / (2*knee)`
    /// - di atas `threshold + knee/2`: `(1/ratio - 1) * (x - threshold)`
    ///
    /// Attack dipakai saat gain **turun**, release saat gain **naik**. Versi
    /// lama memakai koefisien attack untuk gain yang naik (dan sebaliknya),
    /// sehingga kompresor justru "melepas" secepat attack.
    #[inline]
    fn compute_gain(
        &mut self,
        samples: &mut [f32],
        threshold_db: f32,
        ratio: f32,
        makeup_db: f32,
    ) -> f32 {
        let ratio = ratio.max(1.0);
        let makeup_db = makeup_db.clamp(-24.0, 24.0);
        let half_knee = COMP_KNEE_DB * 0.5;
        let slope = 1.0 / ratio - 1.0; // ≤ 0

        let mut max_reduction_db = 0.0f32;

        for x in samples.iter_mut() {
            let level = x.abs();
            let level_db = 20.0 * level.max(1.0e-9).log10();
            let over_db = level_db - threshold_db;

            // Perubahan gain dalam dB (≤ 0 = reduksi).
            let gain_db = if over_db <= -half_knee {
                0.0
            } else if over_db < half_knee {
                let knee_pos = over_db + half_knee;
                slope * knee_pos * knee_pos / (2.0 * COMP_KNEE_DB)
            } else {
                slope * over_db
            };

            let reduction_db = (-gain_db).max(0.0);
            max_reduction_db = max_reduction_db.max(reduction_db);

            let target_gain = db_to_linear(gain_db + makeup_db);
            let coef = if target_gain < self.gain {
                self.attack_coef
            } else {
                self.release_coef
            };
            self.gain = target_gain + coef * (self.gain - target_gain);
            *x *= self.gain;
        }

        max_reduction_db
    }
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            enabled: false,
            env: 0.0,
            gain: 1.0,
            open: true,
            hold_left: 0,
            hold_samples: 0,
            open_thr: 0.0,
            close_thr: 0.0,
            range_gain: 1.0,
            det_attack: 0.0,
            det_release: 0.0,
            gain_attack: 0.0,
            gain_release: 0.0,
            sc_hp: Biquad::bypass(),
            sc_lp: Biquad::bypass(),
            vad: 0.0,
        }
    }
}

impl Gate {
    fn configure(&mut self, settings: &MicSettings) {
        self.enabled = settings.noise_gate_enabled;
        self.open_thr = db_to_linear(settings.noise_gate_threshold);
        self.close_thr = db_to_linear(settings.noise_gate_threshold - settings.noise_gate_hysteresis_db);
        self.range_gain = db_to_linear(settings.noise_gate_range_db);
        self.hold_samples =
            (settings.noise_gate_hold_ms / 1000.0 * SAMPLE_RATE).max(0.0) as u32;

        // Sidechain: buang rumble < 100 Hz dan desis > 4 kHz supaya keputusan
        // buka/tutup mengikuti pita suara.
        self.sc_hp
            .highpass(100.0, std::f32::consts::FRAC_1_SQRT_2);
        self.sc_lp
            .lowpass(4_000.0, std::f32::consts::FRAC_1_SQRT_2);

        // Detektor sidechain: attack cepat, release lambat supaya gate tidak
        // berkedip mengikuti zero-crossing.
        self.det_attack = one_pole(2.0);
        self.det_release = one_pole(50.0);

        // Gain smoothing memakai attack/release dari UI.
        self.gain_attack = one_pole(settings.noise_gate_attack_ms);
        self.gain_release = one_pole(settings.noise_gate_release_ms);

        if !self.enabled {
            self.gain = 1.0;
            self.open = true;
            self.hold_left = self.hold_samples;
        } else if self.hold_left > self.hold_samples {
            self.hold_left = self.hold_samples;
        }
    }

    fn reset(&mut self) {
        self.env = 0.0;
        self.gain = 1.0;
        self.open = true;
        self.hold_left = self.hold_samples;
        self.sc_hp.reset();
        self.sc_lp.reset();
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        // Sidechain tetap dihitung saat gate off supaya `gateInDb` punya arti
        // yang sama (dipakai "learn noise floor" sebelum gate diaktifkan).
        let sidechain = self.sc_lp.process(self.sc_hp.process(x));
        let amplitude = sidechain.abs();
        let coef = if amplitude > self.env {
            self.det_attack
        } else {
            self.det_release
        };
        self.env = amplitude + coef * (self.env - amplitude);

        if !self.enabled {
            self.gain = 1.0;
            self.open = true;
            return x;
        }

        let voiced = self.vad > 0.6;
        if self.env > self.open_thr || voiced {
            self.open = true;
            self.hold_left = self.hold_samples;
        } else if self.env < self.close_thr {
            if self.hold_left > 0 {
                self.hold_left -= 1;
            } else {
                self.open = false;
            }
        }

        let target = if self.open { 1.0 } else { self.range_gain };
        let coef = if target > self.gain {
            self.gain_attack
        } else {
            self.gain_release
        };
        self.gain = target + coef * (self.gain - target);
        x * self.gain
    }
}

pub struct MicChain {
    settings: MicSettings,
    hpf: Biquad,
    /// Hum notch: frekuensi dasar + harmonic 2/3/4 (dengung listrik).
    notches: [Biquad; 4],
    notch_count: usize,
    /// Low-pass anti-hiss untuk desis broadband kabel (sebelum denoise).
    /// Dua stage (4th order) supaya desis > 10 kHz benar-benar turun.
    hiss_lp: Biquad,
    hiss_lp2: Biquad,
    /// Histori median-of-3 untuk de-click impuls jack/konektor.
    declick_prev1: f32,
    declick_prev2: f32,
    noise_filter_enabled: bool,
    denoise: Denoise,
    gate: Gate,
    /// EQ 3-band biquad.
    eq_low: Biquad,
    eq_mid: Biquad,
    eq_high: Biquad,
    /// Compressor (Fase 5).
    compressor: Compressor,
    /// Lookahead limiter (Fase 6): 4 ms lookahead + sliding envelope.
    lookahead_limiter: LookaheadLimiter,
    /// Gain boost yang di-smooth 15 ms supaya slider dB tidak klik.
    boost_gain: f32,
    boost_coef: f32,
}

impl MicChain {
    pub fn new(settings: MicSettings) -> Self {
        let mut chain = Self {
            settings: MicSettings::default(),
            hpf: { let mut b = Biquad::bypass(); b.highpass(80.0, std::f32::consts::FRAC_1_SQRT_2); b },
            notches: [Biquad::bypass(); 4],
            notch_count: 0,
            hiss_lp: Biquad::bypass(),
            hiss_lp2: Biquad::bypass(),
            declick_prev1: 0.0,
            declick_prev2: 0.0,
            noise_filter_enabled: settings.noise_filter_enabled,
            denoise: Denoise::default(),
            gate: Gate::default(),
            eq_low: Biquad::bypass(),
            eq_mid: Biquad::bypass(),
            eq_high: Biquad::bypass(),
            compressor: Compressor::default(),
            lookahead_limiter: LookaheadLimiter::new(settings.limiter_release_ms),
            boost_gain: db_to_linear(settings.mic_boost_db),
            boost_coef: one_pole(15.0),
        };
        chain.set_settings(settings);
        // Alokasi DenoiseState sekali di sini, bukan saat user menyalakan
        // denoise dari mixer thread.
        chain.denoise.ensure_state();
        chain.boost_gain = db_to_linear(chain.settings.mic_boost_db);
        chain.gate.hold_left = chain.gate.hold_samples;
        chain
    }

    /// Terapkan setting baru. Aman dipanggil dari mixer thread: tidak ada
    /// alokasi karena seluruh state sudah dimiliki chain.
    pub fn set_settings(&mut self, mut settings: MicSettings) {
        settings.sanitize();
        self.settings = settings;

        self.hpf.highpass(80.0, std::f32::consts::FRAC_1_SQRT_2);

        // Hum notch: redam frekuensi dasar + harmonic 2/3/4 sekaligus.
        // Sebelumnya hanya satu frekuensi, sehingga dengung 50 Hz masih
        // menyisakan harmonic 100/150/200 Hz.
        let mut notch_count = 0;
        for harmonic in 1..=4usize {
            let freq = settings.hum_notch_hz * harmonic as f32;
            if settings.hum_notch_hz > 0.0 && freq < SAMPLE_RATE * 0.45 {
                self.notches[notch_count].notch(freq, 12.0);
                notch_count += 1;
            }
        }
        for slot in self.notches.iter_mut().skip(notch_count) {
            *slot = Biquad::bypass();
        }
        self.notch_count = notch_count;

        // Filter kabel: low-pass meredam desis broadband, de-click membuang
        // impuls dari jack/konektor yang kurang baik.
        self.noise_filter_enabled = settings.noise_filter_enabled;
        if settings.noise_filter_enabled {
            self.hiss_lp
                .lowpass(9_500.0, std::f32::consts::FRAC_1_SQRT_2);
            self.hiss_lp2
                .lowpass(9_500.0, std::f32::consts::FRAC_1_SQRT_2);
        } else {
            self.hiss_lp = Biquad::bypass();
            self.hiss_lp2 = Biquad::bypass();
            self.declick_prev1 = 0.0;
            self.declick_prev2 = 0.0;
        }

        // EQ 3-band (Fase 4). Bypass otomatis bila semua band 0 dB.
        let eq_active = settings.equalizer_low.abs() > 0.1
            || settings.equalizer_mid.abs() > 0.1
            || settings.equalizer_high.abs() > 0.1;
        if settings.equalizer_enabled && eq_active {
            self.eq_low.lowshelf(120.0, settings.equalizer_low, 0.7);
            self.eq_mid.peak(1_000.0, settings.equalizer_mid, 0.8);
            self.eq_high.highshelf(6_000.0, settings.equalizer_high, 0.7);
        } else {
            self.eq_low = Biquad::bypass();
            self.eq_mid = Biquad::bypass();
            self.eq_high = Biquad::bypass();
        }

        self.denoise.configure(&settings);
        self.gate.configure(&settings);
        self.compressor.configure();
        if !settings.compressor_enabled {
            self.compressor.reset();
        }
        self.lookahead_limiter
            .configure(settings.limiter_release_ms);
    }

    pub fn reset(&mut self) {
        self.hpf.reset();
        for notch in &mut self.notches {
            notch.reset();
        }
        self.hiss_lp.reset();
        self.hiss_lp2.reset();
        self.declick_prev1 = 0.0;
        self.declick_prev2 = 0.0;
        self.eq_low.reset();
        self.eq_mid.reset();
        self.eq_high.reset();
        self.denoise.reset();
        self.gate.reset();
        self.compressor.reset();
        self.lookahead_limiter.reset();
        self.boost_gain = db_to_linear(self.settings.mic_boost_db);
    }

    /// VAD dari denoise (dipakai mulai Fase 3). 0 = tidak ada voice.
    /// Saat denoise belum aktif, mixer tidak memanggil ini dan nilainya 0.
    pub fn set_vad(&mut self, vad: f32) {
        self.gate.vad = if vad.is_finite() {
            vad.clamp(0.0, 1.0)
        } else {
            0.0
        };
    }

    pub fn settings(&self) -> MicSettings {
        self.settings
    }

    /// Proses satu blok mono 48 kHz. Panjang boleh berapa saja; mixer memakai
    /// 480 sample (10 ms).
    pub fn process(&mut self, samples: &mut [f32]) -> MicMeters {
        if samples.is_empty() {
            return MicMeters::default();
        }

        let settings = self.settings;
        let target_boost = db_to_linear(settings.mic_boost_db);

        let mut input_peak = 0.0f32;
        let mut gate_env_peak = 0.0f32;

        for sample in samples.iter_mut() {
            let raw = *sample;
            input_peak = input_peak.max(raw.abs());

            // De-click impuls (median-of-3) sebelum HPF/denoise supaya kresek
            // dari jack tidak dianggap voice oleh RNNoise.
            let mut value = if self.noise_filter_enabled {
                let med = median3(self.declick_prev2, self.declick_prev1, raw);
                self.declick_prev2 = self.declick_prev1;
                self.declick_prev1 = raw;
                med
            } else {
                raw
            };

            value = self.hpf.process(value);
            for index in 0..self.notch_count {
                value = self.notches[index].process(value);
            }
            // Low-pass anti-hiss: buang desis kabel di atas ~10 kHz.
            if self.noise_filter_enabled {
                let filtered = self.hiss_lp.process(value);
                value = self.hiss_lp2.process(filtered);
            }

            // Denoise: 480 sample = 1 RNNoise frame (10 ms @ 48 kHz).
            // Harus sebelum gate supaya VAD bisa drive pembukaan gate.
            value = self.denoise.process(value);
            // Sambungkan VAD denoise ke gate. Saat denoise off, VAD eksternal
            // (set_vad) yang dipakai.
            if self.denoise.active() {
                self.gate.vad = self.denoise.vad;
            }

            // Gate sebelum boost.
            value = self.gate.process(value);
            gate_env_peak = gate_env_peak.max(self.gate.env);

            // Boost di-smooth per sample supaya perubahan slider tidak klik.
            self.boost_gain = target_boost + self.boost_coef * (self.boost_gain - target_boost);
            *sample = value * self.boost_gain;
        }

        // ---- EQ 3-band biquad (Fase 4) ----
        if settings.equalizer_enabled {
            // Auto-bypass: semua band 0 dB = tidak ada processing.
            if settings.equalizer_low.abs() > 0.1
                || settings.equalizer_mid.abs() > 0.1
                || settings.equalizer_high.abs() > 0.1
            {
                for sample in samples.iter_mut() {
                    *sample = self.eq_low.process(*sample);
                }
                for sample in samples.iter_mut() {
                    *sample = self.eq_mid.process(*sample);
                }
                for sample in samples.iter_mut() {
                    *sample = self.eq_high.process(*sample);
                }
            }
        }

        // ---- Compressor (Fase 5: soft-knee, per-sample) ----
        let comp_gr_db = if settings.compressor_enabled {
            self.compressor.compute_gain(
                samples,
                settings.compressor_threshold,
                settings.compressor_ratio,
                settings.compressor_makeup_gain,
            )
        } else {
            0.0
        };

        // ---- Lookahead Limiter (Fase 6: 4 ms lookahead + sliding-min) ----
        let limiter_gr_db = if settings.limiter_enabled {
            self.lookahead_limiter
                .process(samples, db_to_linear(settings.limiter_ceiling))
        } else {
            0.0
        };

        // ---- Safety ceiling (selalu) ----
        // Menjamin output mic ≤ −0.1 dBFS walau limiter dimatikan atau ceiling
        // di-set 0 dBFS. Gain staging setelah chain (mic_gain/master_gain) di
        // mixer hanya 0..1, jadi ceiling ini tetap berlaku sampai output.
        for sample in samples.iter_mut() {
            *sample = sample.clamp(-SAFETY_CEILING, SAFETY_CEILING);
        }

        MicMeters {
            input_db: to_db(input_peak),
            gate_in_db: to_db_floor(gate_env_peak, -120.0),
            gate_open: self.gate.open,
            gate_gain_db: to_db(self.gate.gain),
            comp_gr_db,
            limiter_gr_db,
            vad: self.denoise.vad,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, amplitude: f32, samples: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(samples);
        for i in 0..samples {
            out.push(amplitude * (std::f32::consts::TAU * freq * i as f32 / SAMPLE_RATE).sin());
        }
        out
    }

    fn rms(samples: &[f32]) -> f32 {
        let sum: f32 = samples.iter().map(|s| s * s).sum();
        (sum / samples.len().max(1) as f32).sqrt()
    }

    fn base_settings() -> MicSettings {
        let mut settings = MicSettings::default();
        settings.mic_boost_db = 0.0;
        settings.hum_notch_hz = 0.0;
        settings.noise_gate_enabled = false;
        settings.denoise_enabled = false;
        settings.noise_filter_enabled = false;
        settings.compressor_enabled = false;
        settings.equalizer_enabled = false;
        settings.limiter_enabled = false;
        settings
    }

    #[test]
    fn hpf_aktif_sejak_konstruksi() {
        let mut chain = MicChain::new(base_settings());
        let mut buffer = sine(50.0, 0.5, 48_000);
        let input_rms = rms(&buffer[24_000..]);
        chain.process(&mut buffer);
        let output_rms = rms(&buffer[24_000..]);
        // HPF 80 Hz orde 2 memberi sekitar -9 dB di 50 Hz.
        assert!(
            output_rms < input_rms * 0.6,
            "50 Hz tidak teredam: input {input_rms:.4}, output {output_rms:.4}"
        );
    }

    #[test]
    fn sinyal_1khz_lewat_tanpa_perubahan_saat_semua_efek_off() {
        let mut chain = MicChain::new(base_settings());
        let mut buffer = sine(1_000.0, 0.25, 24_000);
        let input_rms = rms(&buffer[12_000..]);
        chain.process(&mut buffer);
        let output_rms = rms(&buffer[12_000..]);
        let diff = (output_rms / input_rms - 1.0).abs();
        assert!(diff < 0.02, "gain berubah {:.2}%", diff * 100.0);
    }

    #[test]
    fn gate_hold_tidak_48_detik() {
        let mut settings = base_settings();
        settings.noise_gate_enabled = true;
        settings.noise_gate_threshold = -30.0;
        settings.noise_gate_attack_ms = 5.0;
        settings.noise_gate_release_ms = 50.0;
        settings.noise_gate_hold_ms = 100.0;
        settings.noise_gate_range_db = -40.0;

        let mut chain = MicChain::new(settings);
        let mut loud = sine(1_000.0, 0.5, 9_600); // 200 ms
        chain.process(&mut loud);

        // Setelah sinyal berhenti, gate harus tetap terbuka sebentar (hold)
        // lalu menutup. Batas atas longgar karena detektor + gain smoothing
        // ikut memakan waktu.
        let block = vec![0.0f32; 480];
        let mut gain_at_90ms = None;
        let mut closed_at = None;
        for i in 0..120 {
            let mut silence = block.clone();
            let meters = chain.process(&mut silence);
            let ms = (i + 1) * 10;
            if ms == 90 {
                gain_at_90ms = Some(meters.gate_gain_db);
            }
            if meters.gate_gain_db < -20.0 && closed_at.is_none() {
                closed_at = Some(ms);
            }
        }

        assert!(
            gain_at_90ms.unwrap_or(0.0) > -10.0,
            "gate menutup terlalu cepat: {:?} dB di 90 ms",
            gain_at_90ms
        );
        let closed = closed_at.expect("gate tidak pernah menutup");
        assert!(
            (100..=700).contains(&closed),
            "gate menutup di {closed} ms, di luar rentang hold+release"
        );
    }

    #[test]
    fn gate_range_mengikuti_setting_db() {
        let mut settings = base_settings();
        settings.noise_gate_enabled = true;
        settings.noise_gate_threshold = -20.0;
        settings.noise_gate_hold_ms = 0.0;
        settings.noise_gate_release_ms = 20.0;
        settings.noise_gate_range_db = -60.0;

        let mut chain = MicChain::new(settings);
        let mut loud = sine(1_000.0, 0.5, 4_800);
        chain.process(&mut loud);

        let mut silence = vec![0.0f32; 480];
        let mut last = MicMeters::default();
        for _ in 0..300 {
            last = chain.process(&mut silence);
        }
        assert!(
            last.gate_gain_db <= -55.0,
            "range gate hanya {:.1} dB, seharusnya mendekati -60",
            last.gate_gain_db
        );
    }

    #[test]
    fn boost_db_mengikuti_skala_db() {
        let mut unity = sine(1_000.0, 0.05, 24_000);
        MicChain::new(base_settings()).process(&mut unity);

        let mut settings = base_settings();
        settings.mic_boost_db = 20.0;
        let mut boosted = sine(1_000.0, 0.05, 24_000);
        MicChain::new(settings).process(&mut boosted);

        let ratio = rms(&boosted[12_000..]) / rms(&unity[12_000..]);
        assert!(
            (ratio - 10.0).abs() < 0.1,
            "+20 dB seharusnya 10x, hasil {ratio:.3}x"
        );

        // +6 dB ≈ 2x
        let mut settings = base_settings();
        settings.mic_boost_db = 6.0;
        let mut plus_six = sine(1_000.0, 0.05, 24_000);
        MicChain::new(settings).process(&mut plus_six);
        let ratio = rms(&plus_six[12_000..]) / rms(&unity[12_000..]);
        assert!(
            (ratio - 1.9953).abs() < 0.05,
            "+6 dB seharusnya ~2x, hasil {ratio:.3}x"
        );
    }

    #[test]
    fn boost_tidak_klik_saat_setting_berubah() {
        let mut chain = MicChain::new(base_settings());
        let mut block = sine(1_000.0, 0.05, 480);
        chain.process(&mut block);

        // Lompat +20 dB: 5 ms pertama belum boleh mencapai gain penuh
        // (smooth 15 ms).
        let mut settings = base_settings();
        settings.mic_boost_db = 20.0;
        chain.set_settings(settings);
        let mut after = sine(1_000.0, 0.05, 480);
        chain.process(&mut after);
        let early_peak = after[..240].iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(
            early_peak < 0.25,
            "boost melompat terlalu cepat: peak 5 ms pertama {early_peak:.3}"
        );
    }

    #[test]
    fn notch_50hz_teredam_tajam_dan_1khz_aman() {
        let mut settings = base_settings();
        settings.hum_notch_hz = 50.0;
        let mut chain = MicChain::new(settings);

        let mut hum = sine(50.0, 0.5, 48_000);
        let input_rms = rms(&hum[24_000..]);
        chain.process(&mut hum);
        let attenuation = 20.0 * (rms(&hum[24_000..]) / input_rms).log10();
        assert!(
            attenuation <= -15.0,
            "notch 50 Hz hanya {attenuation:.1} dB"
        );

        // Notch tidak boleh ikut memotong pita suara.
        let mut speech_band = sine(1_000.0, 0.25, 24_000);
        let input_rms = rms(&speech_band[12_000..]);
        chain.process(&mut speech_band);
        let diff = (rms(&speech_band[12_000..]) / input_rms - 1.0).abs();
        assert!(diff < 0.05, "1 kHz berubah {:.2}% saat notch aktif", diff * 100.0);
    }

    #[test]
    fn notch_off_tidak_memotong_50hz_lebih_dari_hpf() {
        let mut chain = MicChain::new(base_settings());
        let mut hum = sine(50.0, 0.5, 48_000);
        let input_rms = rms(&hum[24_000..]);
        chain.process(&mut hum);
        let attenuation = 20.0 * (rms(&hum[24_000..]) / input_rms).log10();
        // Hanya HPF 80 Hz orde 2 (sekitar -9 dB di 50 Hz).
        assert!(
            (-15.0..=-4.0).contains(&attenuation),
            "HPF saja seharusnya sekitar -9 dB, hasil {attenuation:.1} dB"
        );
    }

    fn gate_settings(threshold: f32) -> MicSettings {
        let mut settings = base_settings();
        settings.noise_gate_enabled = true;
        settings.noise_gate_threshold = threshold;
        settings.noise_gate_hysteresis_db = 6.0;
        settings.noise_gate_hold_ms = 0.0;
        settings.noise_gate_attack_ms = 5.0;
        settings.noise_gate_release_ms = 20.0;
        settings.noise_gate_range_db = -60.0;
        settings
    }

    #[test]
    fn gate_sidechain_menolak_rumble_40hz() {
        // Threshold -20 (hysteresis 6 → tutup di -26). Rumble 40 Hz setelah
        // HPF chain + HPF sidechain sekitar -34 dB, jadi harus di bawah -26.
        let mut chain = MicChain::new(gate_settings(-20.0));
        let mut rumble = sine(40.0, 0.5, 96_000);
        let meters = chain.process(&mut rumble);

        assert!(!meters.gate_open, "gate terbuka karena rumble 40 Hz");
        assert!(
            meters.gate_gain_db <= -40.0,
            "gate tidak menutup penuh: {:.1} dB",
            meters.gate_gain_db
        );
    }

    #[test]
    fn gate_sidechain_membuka_untuk_pita_suara() {
        let mut chain = MicChain::new(gate_settings(-30.0));
        // 1 kHz -24 dBFS: di atas threshold, sidechain melewatkannya utuh.
        let mut voice = sine(1_000.0, 0.06, 48_000);
        let meters = chain.process(&mut voice);

        assert!(meters.gate_open, "gate tidak terbuka untuk 1 kHz");
        assert!(
            meters.gate_gain_db > -3.0,
            "gain gate belum terbuka penuh: {:.1} dB",
            meters.gate_gain_db
        );
    }

    #[test]
    fn compressor_mengurangi_level_di_atas_threshold() {
        let mut chain = MicChain::new(base_settings());
        chain.set_settings({
            let mut s = base_settings();
            s.compressor_enabled = true;
            s.compressor_threshold = -20.0;
            s.compressor_ratio = 4.0;
            s.compressor_makeup_gain = 0.0;
            s
        });

        // Sinyal 0 dBFS (peak) — nyampek jauh di atas threshold -20 dB.
        let peak = 0.50f32;
        let mut samples = vec![peak; 4_800];
        let input_rms = rms(&samples);
        let meters = chain.process(&mut samples);
        let output_rms = rms(&samples);

        assert!(
            meters.comp_gr_db > 10.0,
            "harus ada reduction > 10 dB, dapat {:.1} dB",
            meters.comp_gr_db
        );
        assert!(
            output_rms < input_rms * 0.5,
            "output harus lebih kecil dari input (reduction), rms ratio {:.2}",
            output_rms / input_rms
        );
    }

    #[test]
    fn compressor_tidak_mengubah_sinyal_kecil() {
        let mut chain = MicChain::new(base_settings());
        chain.set_settings({
            let mut s = base_settings();
            s.compressor_enabled = true;
            s.compressor_threshold = -20.0;
            s.compressor_ratio = 4.0;
            s.compressor_makeup_gain = 0.0;
            s
        });

        // Sinyal kecil 1 kHz (RMS -40 dB) — jauh di bawah threshold -20 dB.
        let mut quiet = sine(1_000.0, 0.01, 192_000);
        let input_rms = rms(&quiet[48_000..]);
        let meters = chain.process(&mut quiet);
        let output_rms = rms(&quiet[48_000..]);

        assert!(
            meters.comp_gr_db < 1.0,
            "tidak boleh ada reduction untuk sinyal kecil: {:.1} dB",
            meters.comp_gr_db
        );
        assert!(
            (output_rms / input_rms - 1.0).abs() < 0.1,
            "level harus hampir tidak berubah: in={input_rms:.6} out={output_rms:.6}, comp_gr_db={:.2}",
            meters.comp_gr_db
        );
    }

    #[test]
    fn vad_membuka_gate_tanpa_sinyal() {
        let mut chain = MicChain::new(gate_settings(-10.0));

        let mut silence = vec![0.0f32; 4_800];
        let closed = chain.process(&mut silence);
        assert!(!closed.gate_open, "gate seharusnya tertutup tanpa sinyal");

        chain.set_vad(1.0);
        let mut silence = vec![0.0f32; 4_800];
        let opened = chain.process(&mut silence);
        assert!(opened.gate_open, "VAD tidak membuka gate");
        assert!(
            opened.gate_gain_db > -3.0,
            "gain gate belum terbuka lewat VAD: {:.1} dB",
            opened.gate_gain_db
        );
    }

    /// Limiter (Fase 6): tidak boleh ada sample melebihi ceiling.
    #[test]
    fn limiter_mencegah_clip_pada_sinyal_20db_di_atas_ceiling() {
        let mut settings = base_settings();
        settings.limiter_enabled = true;
        settings.limiter_ceiling = -1.0; // -1 dBFS
        settings.limiter_release_ms = 50.0;
        let mut chain = MicChain::new(settings);

        // Sinyal +20 dB di atas ceiling (ceiling = 0.891, sinyal = 0.5 = -6 dBFS
        // relatif; kali 10x = +20 dB -> 5.0 linear, jauh di atas ceiling).
        let ceiling_linear = db_to_linear(-1.0);
        let amplitude = ceiling_linear * 10.0; // +20 dB
        let mut samples = vec![amplitude; 9_600]; // 200 ms

        let meters = chain.process(&mut samples);
        let peak = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        let ceiling_db = -1.0;
        assert!(
            peak <= ceiling_linear * 1.05, // toleransi kecil untuk release envelope
            "peak {:.4} ({:.1} dB) melebihi ceiling {:.4} ({:.1} dB)",
            peak,
            to_db(peak),
            ceiling_linear,
            ceiling_db
        );

        // Harus ada reduction yang tercatat di meter (signal +20 dB di atas ceiling
        // -> limiter harus kasih ~20 dB reduction).
        assert!(
            meters.limiter_gr_db > 10.0,
            "harus ada limiter GR > 10 dB, dapat {:.1} dB",
            meters.limiter_gr_db
        );
    }

    /// Limiter off: tidak ada reduction, sinyal tidak berubah (selain HPF/gate).
    #[test]
    fn limiter_off_tidak_mengubah_sinyal() {
        let mut settings = base_settings();
        settings.limiter_enabled = false;
        let mut chain = MicChain::new(settings);

        let mut samples = sine(1_000.0, 0.8, 9_600);
        let input_rms = rms(&samples[4_800..]);
        let meters = chain.process(&mut samples);
        let output_rms = rms(&samples[4_800..]);

        assert!(
            meters.limiter_gr_db < 0.5,
            "limiter off tidak boleh ada GR, dapat {:.1} dB",
            meters.limiter_gr_db
        );
        let diff = (output_rms / input_rms - 1.0).abs();
        assert!(diff < 0.02, "level berubah {:.1}% saat limiter off", diff * 100.0);
    }

    /// Regresi: pregain denoise dulu tetap +12 dB sehingga sinyal > -12 dBFS
    /// clip dan terdengar "kresek" setiap kali bicara.
    #[test]
    fn denoise_pregain_tidak_clip_sinyal_keras() {
        let mut settings = base_settings();
        settings.denoise_enabled = true;
        settings.denoise_mix = 1.0;
        let mut chain = MicChain::new(settings);

        let mut buffer = sine(1_000.0, 0.9, 48_000); // ~ -1 dBFS
        chain.process(&mut buffer);

        assert!(
            chain.denoise.pregain >= 1.0 && chain.denoise.pregain <= DENOISE_MAX_PREGAIN + 0.01,
            "pregain di luar batas: {:.2}",
            chain.denoise.pregain
        );
        let peak = chain
            .denoise
            .frame_in
            .iter()
            .fold(0.0f32, |acc, v| acc.max(v.abs()));
        assert!(peak < 32_767.0, "frame input masih clip: peak {peak}");
        assert!(buffer.iter().all(|s| s.is_finite()));
    }

    /// Dry dan wet harus tertunda sama besar (2 frame = 960 sample). Kalau
    /// dry hanya 1 frame, mix < 1.0 menghasilkan comb filter/echo.
    #[test]
    fn denoise_dry_wet_sejajar_dua_frame() {
        assert_eq!(DENOISE_LATENCY, 960);
        let chain = MicChain::new(base_settings());
        assert_eq!(chain.denoise.dry_delay.len(), DENOISE_LATENCY);
    }

    /// Hum notch sekarang merangkum harmonic, bukan hanya frekuensi dasar.
    #[test]
    fn hum_notch_meredam_harmonisa() {
        let mut settings = base_settings();
        settings.hum_notch_hz = 50.0;
        let mut chain = MicChain::new(settings);

        // Harmonic ke-3 (150 Hz): hanya teredam kalau notch 150 Hz ikut aktif.
        let mut samples = sine(150.0, 0.2, 48_000);
        chain.process(&mut samples);
        let output_rms = rms(&samples[24_000..]);
        assert!(
            output_rms < 0.02,
            "harmonic 150 Hz tidak teredam: rms {output_rms:.4}"
        );
    }

    /// Filter kabel: low-pass meredam desis dan median-of-3 membuang klik.
    #[test]
    fn noise_filter_meredam_desis_dan_klik() {
        let mut settings = base_settings();
        settings.noise_filter_enabled = true;

        let hiss = sine(15_000.0, 0.2, 48_000);
        let input_rms = rms(&hiss[24_000..]);
        let mut chain = MicChain::new(settings);
        assert!(chain.noise_filter_enabled);

        // Uji filter hiss langsung (tanpa de-click) supaya tidak terpengaruh
        // produk aliasing median-of-3 di dekat Nyquist.
        let filtered: Vec<f32> = hiss
            .iter()
            .map(|x| chain.hiss_lp2.process(chain.hiss_lp.process(*x)))
            .collect();
        let output_rms = rms(&filtered[24_000..]);
        assert!(
            output_rms < input_rms * 0.1,
            "desis 15 kHz tidak teredam: in {input_rms:.4} out {output_rms:.4}"
        );

        let mut clicks = vec![0.0f32; 4_800];
        clicks[2_400] = 0.9;
        let mut chain = MicChain::new(settings);
        chain.process(&mut clicks);
        let peak = clicks.iter().fold(0.0f32, |acc, v| acc.max(v.abs()));
        assert!(peak < 0.1, "klik satu-sample masih lolos: peak {peak:.4}");
    }

    /// VAD dari denoise harus benar-benar tersambung ke gate.
    #[test]
    fn vad_denoise_tersambung_ke_gate() {
        let mut settings = base_settings();
        settings.denoise_enabled = true;
        settings.denoise_mix = 1.0;
        settings.noise_gate_enabled = true;
        settings.noise_gate_threshold = -10.0;
        let mut chain = MicChain::new(settings);

        let mut speech = sine(300.0, 0.2, 24_000);
        chain.process(&mut speech);

        assert_eq!(
            chain.gate.vad, chain.denoise.vad,
            "VAD denoise tidak sampai ke gate"
        );
        assert!(
            chain.denoise.vad > 0.0,
            "VAD RNNoise tidak aktif untuk sinyal voice"
        );
    }

    /// Soft-knee: sinyal di dalam knee harus terkompresi bertahap, bukan
    /// "dead zone" yang menghasilkan dB negatif (bug lama).
    #[test]
    fn compressor_soft_knee_bertahap() {
        let mut comp = Compressor::default();
        comp.configure();

        // Threshold −20 dB, knee 6 dB. Level −18 dB = 2 dB di atas threshold,
        // masih di dalam knee atas (0..3 dB).
        let mut in_knee = vec![db_to_linear(-18.0); 48_000];
        let gr_knee = comp.compute_gain(&mut in_knee, -20.0, 4.0, 0.0);
        assert!(
            gr_knee > 1.0 && gr_knee < 2.2,
            "GR di dalam knee harus bertahap (~1.6 dB), dapat {gr_knee:.2} dB"
        );

        // Di bawah knee bawah (threshold − knee/2 = −23 dB) tidak ada reduksi.
        let mut below = Compressor::default();
        below.configure();
        let mut quiet = vec![db_to_linear(-24.0); 48_000];
        let gr_quiet = below.compute_gain(&mut quiet, -20.0, 4.0, 0.0);
        assert!(
            gr_quiet < 0.1,
            "sinyal di bawah knee tidak boleh terkompresi, dapat {gr_quiet:.2} dB"
        );

        // Di atas knee: kurva rasio penuh. −8 dB = 12 dB di atas threshold,
        // 4:1 -> 9 dB reduction.
        let mut above = Compressor::default();
        above.configure();
        let mut loud = vec![db_to_linear(-8.0); 48_000];
        let gr_above = above.compute_gain(&mut loud, -20.0, 4.0, 0.0);
        assert!(
            (gr_above - 9.0).abs() < 0.3,
            "GR di atas knee harus ~9 dB, dapat {gr_above:.2} dB"
        );
    }

    /// Attack (gain turun) harus lebih cepat daripada release (gain naik).
    #[test]
    fn compressor_attack_lebih_cepat_dari_release() {
        let mut comp = Compressor::default();
        comp.configure();
        assert!(
            comp.attack_coef < comp.release_coef,
            "koefisien attack harus lebih kecil (lebih cepat) dari release"
        );

        // Burst keras 100 ms: gain harus sudah turun mendekati target.
        let mut loud = vec![db_to_linear(-6.0); 4_800];
        comp.compute_gain(&mut loud, -30.0, 4.0, 0.0);
        let gain_after_attack = comp.gain;
        assert!(
            gain_after_attack < 0.2,
            "attack terlalu lambat, gain masih {gain_after_attack:.3}"
        );

        // 50 ms senyap: release hanya memulihkan sebagian (bukan instan).
        let mut quiet = vec![1.0e-6f32; 2_400];
        comp.compute_gain(&mut quiet, -30.0, 4.0, 0.0);
        assert!(
            comp.gain > 0.2 && comp.gain < 0.9,
            "release harus bertahap, gain {:.3}",
            comp.gain
        );
    }

    /// True lookahead: gain sudah turun untuk sample yang keluar sebelum peak
    /// (versi lama hanya menunda audio tanpa melihat peak di masa depan).
    #[test]
    fn limiter_lookahead_menahan_gain_sebelum_peak() {
        let ceiling = db_to_linear(-6.0);
        let mut limiter = LookaheadLimiter::new(50.0);

        let mut buffer = vec![0.2f32; 2_000];
        buffer[500] = 2.0; // +6 dB di atas 0 dBFS

        let gr = limiter.process(&mut buffer, ceiling);

        // Output index 500 berasal dari input 308 (level 0.2). Karena peak di
        // index 500 sudah diketahui, gain di index 500 harus sudah turun.
        assert!(
            buffer[500] < 0.1,
            "lookahead tidak menahan gain sebelum peak: out {:.4}",
            buffer[500]
        );
        let peak = buffer.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(
            peak <= ceiling * 1.001,
            "peak {peak:.4} melebihi ceiling {ceiling:.4}"
        );
        assert!(gr > 10.0, "GR limiter terlalu kecil: {gr:.1} dB");
    }

    /// Safety ceiling selalu aktif, termasuk saat limiter dimatikan.
    #[test]
    fn safety_ceiling_menjaga_output_tanpa_limiter() {
        let mut settings = base_settings();
        settings.limiter_enabled = false;
        let mut chain = MicChain::new(settings);

        let mut samples = vec![2.0f32; 4_800];
        chain.process(&mut samples);
        let peak = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(
            peak <= SAFETY_CEILING + 1.0e-6,
            "output {peak:.4} melewati safety ceiling {SAFETY_CEILING:.4}"
        );
    }
}
