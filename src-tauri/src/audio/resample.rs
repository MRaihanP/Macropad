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
