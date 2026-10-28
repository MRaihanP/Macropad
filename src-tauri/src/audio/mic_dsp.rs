//! Mic DSP chain.
//!
//! Urutan final (lihat docs/mic-dsp-plan.md):
//! `HPF 80 Hz -> Notch -> Denoise -> Gate -> Boost -> EQ -> Compressor -> Limiter`.
//!
//! Modul ini sengaja tidak bergantung pada cpal/Tauri supaya bisa diuji lewat
//! unit test dan contoh offline (`examples/mic_offline.rs`). Semua state
//! dialokasikan saat `MicChain::new()`; `process()` tidak melakukan alokasi.

use crate::audio::settings::MicSettings;

/// Sample rate internal engine. Sama dengan `mixer::SAMPLE_RATE`.
pub const SAMPLE_RATE: f32 = 48_000.0;

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
    notch: Biquad,
    gate: Gate,
    /// Gain boost yang di-smooth 15 ms supaya slider dB tidak klik.
    boost_gain: f32,
    boost_coef: f32,
}

impl MicChain {
    pub fn new(settings: MicSettings) -> Self {
        let mut chain = Self {
            settings: MicSettings::default(),
            hpf: Biquad::bypass(),
            notch: Biquad::bypass(),
            gate: Gate::default(),
            boost_gain: db_to_linear(settings.mic_boost_db),
            boost_coef: one_pole(15.0),
        };
        chain.set_settings(settings);
        // `set_settings` melakukan sanitize; ambil nilai final supaya boost
        // pertama tidak memakai nilai mentah (mis. NaN dari file lama).
        chain.boost_gain = db_to_linear(chain.settings.mic_boost_db);
        // Beri hold penuh di awal supaya kata pertama tidak terpotong saat
        // gate baru diaktifkan di tengah stream.
        chain.gate.hold_left = chain.gate.hold_samples;
        chain
    }

    /// Terapkan setting baru. Aman dipanggil dari mixer thread: tidak ada
    /// alokasi karena seluruh state sudah dimiliki chain.
    pub fn set_settings(&mut self, mut settings: MicSettings) {
        settings.sanitize();
        self.settings = settings;

        // HPF selalu aktif, termasuk sebelum settings pertama diubah.
        self.hpf.highpass(80.0, std::f32::consts::FRAC_1_SQRT_2);

        if settings.hum_notch_hz > 0.0 {
            // Q=10: notch sempit supaya hanya hum yang kena, bukan suara.
            self.notch.notch(settings.hum_notch_hz, 10.0);
        } else {
            self.notch = Biquad::bypass();
        }

        self.gate.configure(&settings);
    }

    /// Reset state filter/gate tanpa mengubah setting. Dipakai saat stream mic
    /// dibangun ulang supaya sample lama tidak bocor ke device baru.
    pub fn reset(&mut self) {
        self.hpf.reset();
        self.notch.reset();
        self.gate.reset();
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

            let mut value = self.hpf.process(raw);
            value = self.notch.process(value);

            // Gate sebelum boost: threshold dan "learn noise floor" tidak
            // bergeser saat user mengubah boost.
            value = self.gate.process(value);
            gate_env_peak = gate_env_peak.max(self.gate.env);

            // Boost di-smooth per sample supaya perubahan slider tidak klik.
            self.boost_gain = target_boost + self.boost_coef * (self.boost_gain - target_boost);
            *sample = value * self.boost_gain;
        }

        // ---- EQ (sementara: implementasi lama, diganti biquad di Fase 4) ----
        if settings.equalizer_enabled {
            let low = db_to_linear(settings.equalizer_low);
            let mid = db_to_linear(settings.equalizer_mid);
            let high = db_to_linear(settings.equalizer_high);
            let n = samples.len();
            let low_end = (n as f32 * 0.2) as usize;
            let high_start = (n as f32 * 0.8) as usize;
            for (i, sample) in samples.iter_mut().enumerate() {
                if i < low_end {
                    *sample *= low;
                } else if i >= high_start {
                    *sample *= high;
                } else {
                    *sample *= mid;
                }
            }
        }

        // ---- Compressor (sementara, diganti Fase 5) ----
        let mut comp_gr_db = 0.0f32;
        if settings.compressor_enabled {
            let threshold = db_to_linear(settings.compressor_threshold);
            let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
            let rms = (sum_sq / samples.len() as f32).sqrt();
            if rms > threshold && threshold > 0.0 {
                let over_db = 20.0 * (rms / threshold).log10();
                let reduction_db = over_db * (1.0 - 1.0 / settings.compressor_ratio.max(1.0));
                comp_gr_db = reduction_db.max(0.0);
                let gain = db_to_linear(-reduction_db + settings.compressor_makeup_gain);
                for sample in samples.iter_mut() {
                    *sample *= gain;
                }
            }
        }

        // ---- Limiter (sementara: clamp keras, diganti Fase 6) ----
        let mut limiter_gr_db = 0.0f32;
        if settings.limiter_enabled {
            let ceiling = db_to_linear(settings.limiter_ceiling);
            for sample in samples.iter_mut() {
                let magnitude = sample.abs();
                if magnitude > ceiling && ceiling > 0.0 {
                    limiter_gr_db = limiter_gr_db.max(20.0 * (magnitude / ceiling).log10());
                    *sample = sample.clamp(-ceiling, ceiling);
                }
            }
        }

        MicMeters {
            input_db: to_db(input_peak),
            // Envelope detektor, sama dengan yang dipakai gate. Dipakai UI
            // untuk "learn noise floor" supaya ambang yang dihitung cocok
            // dengan cara gate mengambil keputusan.
            gate_in_db: to_db_floor(gate_env_peak, -120.0),
            gate_open: self.gate.open,
            gate_gain_db: to_db(self.gate.gain),
            comp_gr_db,
            limiter_gr_db,
            vad: self.gate.vad,
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
}
