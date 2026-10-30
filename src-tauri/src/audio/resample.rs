//! Resampling memakai rubato.
//!
//! - Decode soundboard: satu file penuh, planar → interleaved stereo.
//! - Mic: streaming, 1024-frame chunk, mono.
//!
//! Semua pemanggilan terjadi di thread non-callback (decode/worker), jadi
//! alokasi di sini aman.

use rubato::{FftFixedIn, Resampler};

pub const ENGINE_SAMPLE_RATE: u32 = 48_000;

const CHUNK: usize = 1024;
const SUB_CHUNKS: usize = 2;

/// Resample interleaved buffer secara offline.
pub fn resample_interleaved(
    input: &[f32],
    channels: usize,
    in_rate: u32,
    out_rate: u32,
) -> Result<Vec<f32>, String> {
    if input.is_empty() || channels == 0 || in_rate == 0 || out_rate == 0 {
        return Ok(Vec::new());
    }
    if in_rate == out_rate {
        return Ok(input.to_vec());
    }

    let frames = input.len() / channels;
    let mut resampler = FftFixedIn::<f32>::new(
        in_rate as usize,
        out_rate as usize,
        CHUNK,
        SUB_CHUNKS,
        channels,
    )
    .map_err(|e| format!("gagal membuat resampler: {e}"))?;

    let input_chunk = resampler.input_frames_next();
    let mut out: Vec<f32> = Vec::with_capacity(
        ((frames as f64 * out_rate as f64 / in_rate as f64).ceil() as usize) * channels + 4096,
    );

    let mut pos = 0usize;
    while pos < frames {
        let n = (frames - pos).min(input_chunk);
        let mut planar = vec![vec![0.0f32; input_chunk]; channels];
        for (c, channel) in planar.iter_mut().enumerate() {
            for i in 0..n {
                channel[i] = input[(pos + i) * channels + c];
            }
        }
        let processed = resampler
            .process(&planar, None)
            .map_err(|e| format!("resample gagal: {e}"))?;
        let out_frames = processed.first().map(Vec::len).unwrap_or(0);
        for i in 0..out_frames {
            for channel in processed.iter().take(channels) {
                out.push(channel[i]);
            }
        }
        pos += n;
        if n < input_chunk {
            break;
        }
    }

    let expected_frames = (frames as f64 * out_rate as f64 / in_rate as f64).round() as usize;
    out.truncate(expected_frames * channels);
    Ok(out)
}

/// Resampler streaming untuk mic. Feed sample mono f32, ambil hasil 48 kHz.
pub struct StreamResampler {
    inner: Option<FftFixedIn<f32>>,
    channels: usize,
    input_chunk: usize,
    pending: Vec<f32>,
    scratch: Vec<Vec<f32>>,
}

impl StreamResampler {
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Result<Self, String> {
        if in_rate == out_rate {
            return Ok(Self {
                inner: None,
                channels,
                input_chunk: CHUNK,
                pending: Vec::with_capacity(CHUNK * channels * 2),
                scratch: Vec::new(),
            });
        }

        let inner = FftFixedIn::<f32>::new(
            in_rate as usize,
            out_rate as usize,
            CHUNK,
            SUB_CHUNKS,
            channels,
        )
        .map_err(|e| format!("gagal membuat resampler mic: {e}"))?;
        let input_chunk = inner.input_frames_next();
        Ok(Self {
            inner: Some(inner),
            channels,
            input_chunk,
            pending: Vec::with_capacity(input_chunk * channels * 2),
            scratch: vec![vec![0.0f32; input_chunk]; channels],
        })
    }

    pub fn push(&mut self, input: &[f32]) {
        self.pending.extend_from_slice(input);
        // Jaga supaya tidak tumbuh tanpa batas kalau consumer tersendat.
        let max = self.input_chunk * self.channels * 8;
        if self.pending.len() > max {
            let drop = self.pending.len() - max;
            self.pending.drain(0..drop);
        }
    }

    pub fn process(&mut self) -> Result<Vec<f32>, String> {
        let Some(inner) = self.inner.as_mut() else {
            return Ok(std::mem::take(&mut self.pending));
        };

        let need = self.input_chunk * self.channels;
        let mut out = Vec::new();
        while self.pending.len() >= need {
            for i in 0..self.input_chunk {
                for c in 0..self.channels {
                    self.scratch[c][i] = self.pending[i * self.channels + c];
                }
            }
            self.pending.drain(0..need);
            let processed = inner
                .process(&self.scratch, None)
                .map_err(|e| format!("resample mic gagal: {e}"))?;
            let frames = processed.first().map(Vec::len).unwrap_or(0);
            for i in 0..frames {
                for channel in processed.iter().take(self.channels) {
                    out.push(channel[i]);
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| (std::f32::consts::TAU * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    /// Perkiraan frekuensi dari jumlah zero-crossing naik, hanya pada bagian
    /// tengah sinyal. Awal output resampler berisi ~320 sample senyap
    /// (latensi internal FFT) yang kalau ikut dihitung akan menambah
    /// crossing palsu dari noise numerik.
    fn freq_from_crossings(samples: &[f32], rate: u32) -> f32 {
        let start = samples.len() / 8;
        let end = samples.len() * 7 / 8;
        let mid = &samples[start..end];
        let crossings = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        crossings as f32 * rate as f32 / mid.len().max(1) as f32
    }

    /// QA Fase 7: input mic 44.1 kHz di-resample ke 48 kHz tanpa mengubah
    /// durasi maupun pitch.
    #[test]
    fn offline_44100_ke_48000_mempertahankan_durasi_dan_pitch() {
        let input = sine(440.0, 44_100, 44_100); // 1 detik
        let out = resample_interleaved(&input, 1, 44_100, ENGINE_SAMPLE_RATE).unwrap();

        assert!(
            out.len().abs_diff(ENGINE_SAMPLE_RATE as usize) <= 32,
            "panjang {} tidak mendekati 48000",
            out.len()
        );
        let freq = freq_from_crossings(&out, ENGINE_SAMPLE_RATE);
        assert!(
            (freq - 440.0).abs() < 3.0,
            "pitch bergeser: {freq:.1} Hz"
        );
        // Amplitudo di tengah sinyal harus tetap ~0.707 RMS (sine penuh).
        let mid = &out[out.len() / 4..out.len() * 3 / 4];
        let rms = (mid.iter().map(|s| s * s).sum::<f32>() / mid.len() as f32).sqrt();
        assert!(
            (rms - 0.707).abs() < 0.05,
            "amplitudo berubah: rms {rms:.3}"
        );
        assert!(out.iter().all(|s| s.is_finite()), "output mengandung NaN");
    }

    /// Input 48 kHz tidak boleh diubah sama sekali (fast path).
    #[test]
    fn offline_48000_ke_48000_passthrough() {
        let input = sine(1_000.0, 48_000, 2_400);
        let out = resample_interleaved(&input, 1, 48_000, 48_000).unwrap();
        assert_eq!(out, input);
    }

    /// StreamResampler dipakai MicWorker; feeding chunk kecil harus
    /// menghasilkan total frame sesuai rasio 44.1 → 48 kHz.
    #[test]
    fn stream_44100_ke_48000_total_frame_sesuai_rasio() {
        let input = sine(440.0, 44_100, 44_100);
        let mut resampler = StreamResampler::new(44_100, ENGINE_SAMPLE_RATE, 1).unwrap();

        let mut out = Vec::new();
        for chunk in input.chunks(350) {
            resampler.push(chunk);
            out.extend(resampler.process().unwrap());
        }

        let expected = ENGINE_SAMPLE_RATE as usize;
        assert!(
            out.len().abs_diff(expected) <= 2_048,
            "output {} frame, harap ~{expected}",
            out.len()
        );
        let freq = freq_from_crossings(&out, ENGINE_SAMPLE_RATE);
        assert!(
            (freq - 440.0).abs() < 5.0,
            "pitch bergeser setelah streaming: {freq:.1} Hz"
        );
    }

    /// Rate sama: StreamResampler harus meneruskan data apa adanya.
    #[test]
    fn stream_rate_sama_passthrough() {
        let input = sine(1_000.0, 48_000, 1_024);
        let mut resampler = StreamResampler::new(48_000, ENGINE_SAMPLE_RATE, 1).unwrap();
        resampler.push(&input);
        let out = resampler.process().unwrap();
        assert_eq!(out, input);
    }
}
