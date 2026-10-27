//! Membangun stream output/input cpal dan callback real-time.
//!
//! Callback HANYA melakukan:
//!   pop dari SpscRing → konversi format → tulis ke buffer device
//! Tidak ada Mutex, tidak ada alokasi, tidak ada logging per sample.

use crate::audio::mixer::SAMPLE_RATE;
use crate::audio::ring::SpscRing;
use crate::audio::types::StreamStatus;
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

pub struct OutputHandle {
    /// Stream harus hidup di thread yang membuatnya (`cpal::Stream` adalah !Send).
    _stream: Stream,
    pub status: StreamStatus,
}

pub struct InputHandle {
    _stream: Stream,
    pub status: StreamStatus,
    pub sample_rate: u32,
}

fn status(
    role: &str,
    device: &str,
    sample_rate: u32,
    channels: u16,
    format: SampleFormat,
) -> StreamStatus {
    StreamStatus {
        role: role.to_string(),
        device: device.to_string(),
        sample_rate,
        channels,
        format: format!("{format:?}"),
        state: "running".into(),
        underruns: 0,
        buffer_ms: None,
        error: None,
    }
}

pub fn build_output(
    role: &str,
    device: cpal::Device,
    device_name: String,
    ring: Arc<SpscRing>,
    active: Arc<AtomicBool>,
    underruns: Arc<AtomicU64>,
    buffer_ms: u32,
) -> Result<OutputHandle, String> {
    let default_config = device
        .default_output_config()
        .map_err(|e| format!("gagal baca config {}: {e}", device_name))?;
    let sample_format = default_config.sample_format();
    let mut config: StreamConfig = default_config.into();

    if buffer_ms > 0 {
        let frames = (config.sample_rate.0 as u64 * buffer_ms as u64 / 1000).max(64) as u32;
        config.buffer_size = BufferSize::Fixed(frames);
    }

    let try_build = |config: &StreamConfig| -> Result<Stream, String> {
        match sample_format {
            SampleFormat::F32 => build_output_typed::<f32>(
                &device,
                config,
                Arc::clone(&ring),
                Arc::clone(&active),
                Arc::clone(&underruns),
            ),
            SampleFormat::I16 => build_output_typed::<i16>(
                &device,
                config,
                Arc::clone(&ring),
                Arc::clone(&active),
                Arc::clone(&underruns),
            ),
            SampleFormat::U16 => build_output_typed::<u16>(
                &device,
                config,
                Arc::clone(&ring),
                Arc::clone(&active),
                Arc::clone(&underruns),
            ),
            SampleFormat::I32 => build_output_typed::<i32>(
                &device,
                config,
                Arc::clone(&ring),
                Arc::clone(&active),
                Arc::clone(&underruns),
            ),
            other => Err(format!("format sample belum didukung: {other:?}")),
        }
    };

    let mut used_buffer_ms = buffer_ms;
    let stream = match try_build(&config) {
        Ok(stream) => stream,
        Err(first_error) if config.buffer_size != BufferSize::Default => {
            eprintln!(
                "[audio] buffer {} ms ditolak ({}), fallback ke default",
                buffer_ms, first_error
            );
            config.buffer_size = BufferSize::Default;
            used_buffer_ms = 0;
            try_build(&config)?
        }
        Err(error) => return Err(error),
    };

    stream
        .play()
        .map_err(|e| format!("gagal memulai stream {}: {e}", device_name))?;
    active.store(true, Ordering::Release);

    let mut info = status(
        role,
        &device_name,
        config.sample_rate.0,
        config.channels,
        sample_format,
    );
    info.buffer_ms = if used_buffer_ms > 0 {
        Some(used_buffer_ms)
    } else {
        None
    };
    if info.sample_rate != SAMPLE_RATE as u32 {
        info.error = Some(format!(
            "device {} Hz; di-resample dari {} Hz",
            info.sample_rate, SAMPLE_RATE
        ));
    }

    Ok(OutputHandle {
        _stream: stream,
        status: info,
    })
}

fn build_output_typed<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    ring: Arc<SpscRing>,
    active: Arc<AtomicBool>,
    underruns: Arc<AtomicU64>,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate.0;
    let mut resampler = LinearResampler::new(sample_rate);

    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                if !active.load(Ordering::Acquire) {
                    for sample in data.iter_mut() {
                        *sample = T::from_sample(0.0f32);
                    }
                    return;
                }
                let underrun = write_output(data, channels, sample_rate, &ring, &mut resampler);
                if underrun {
                    underruns.fetch_add(1, Ordering::Relaxed);
                }
            },
            |err| eprintln!("[audio] output stream error: {err}"),
            None,
        )
        .map_err(|e| format!("gagal build output stream: {e}"))
}

struct LinearResampler {
    ratio: f64,
    pos: f64,
    cur_l: f32,
    cur_r: f32,
    next_l: f32,
    next_r: f32,
    primed: bool,
}

impl LinearResampler {
    fn new(device_rate: u32) -> Self {
        Self {
            ratio: SAMPLE_RATE as f64 / device_rate.max(1) as f64,
            pos: 0.0,
            cur_l: 0.0,
            cur_r: 0.0,
            next_l: 0.0,
            next_r: 0.0,
            primed: false,
        }
    }

    fn pull(&mut self, ring: &SpscRing) -> bool {
        let mut frame = [0.0f32; 2];
        if ring.pop(&mut frame) == 2 {
            self.next_l = frame[0];
            self.next_r = frame[1];
            true
        } else {
            self.next_l = 0.0;
            self.next_r = 0.0;
            false
        }
    }
}

/// Return true kalau terjadi underrun.
fn write_output<T>(
    data: &mut [T],
    channels: usize,
    sample_rate: u32,
    ring: &SpscRing,
    resampler: &mut LinearResampler,
) -> bool
where
    T: Sample + FromSample<f32>,
{
    let frames = data.len() / channels.max(1);
    if frames == 0 {
        return false;
    }

    if sample_rate == SAMPLE_RATE as u32 {
        const CHUNK_FRAMES: usize = 512;
        let mut scratch = [0.0f32; CHUNK_FRAMES * 2];
        let mut underrun = false;
        let mut frame_index = 0usize;
        while frame_index < frames {
            let count = (frames - frame_index).min(CHUNK_FRAMES);
            let wanted = count * 2;
            let got = ring.pop(&mut scratch[..wanted]);
            if got < wanted {
                underrun = true;
                scratch[got..wanted].fill(0.0);
            }
            for i in 0..count {
                write_frame(
                    &mut data[(frame_index + i) * channels..],
                    channels,
                    scratch[i * 2],
                    scratch[i * 2 + 1],
                );
            }
            frame_index += count;
        }
        return underrun;
    }

    // Device tidak mendukung 48 kHz: resample linear dari ring 48 kHz.
    let mut underrun = false;
    if !resampler.primed {
        if !resampler.pull(ring) {
            underrun = true;
        }
        resampler.cur_l = resampler.next_l;
        resampler.cur_r = resampler.next_r;
        if !resampler.pull(ring) {
            underrun = true;
        }
        resampler.primed = true;
    }

    for frame in data.chunks_mut(channels) {
        while resampler.pos >= 1.0 {
            resampler.cur_l = resampler.next_l;
            resampler.cur_r = resampler.next_r;
            if !resampler.pull(ring) {
                underrun = true;
            }
            resampler.pos -= 1.0;
        }
        let t = resampler.pos as f32;
        let left = resampler.cur_l + (resampler.next_l - resampler.cur_l) * t;
        let right = resampler.cur_r + (resampler.next_r - resampler.cur_r) * t;
        write_frame(frame, channels, left, right);
        resampler.pos += resampler.ratio;
    }
    underrun
}

#[inline]
fn write_frame<T>(frame: &mut [T], channels: usize, left: f32, right: f32)
where
    T: Sample + FromSample<f32>,
{
    match channels {
        0 => {}
        1 => {
            frame[0] = T::from_sample((left + right) * 0.5);
        }
        _ => {
            frame[0] = T::from_sample(left);
            frame[1] = T::from_sample(right);
            for sample in frame.iter_mut().skip(2) {
                *sample = T::from_sample(0.0f32);
            }
        }
    }
}

pub fn build_input(
    device: cpal::Device,
    device_name: String,
    raw_ring: Arc<SpscRing>,
    buffer_ms: u32,
) -> Result<InputHandle, String> {
    let default_config = device
        .default_input_config()
        .map_err(|e| format!("gagal baca config mic {}: {e}", device_name))?;
    let sample_format = default_config.sample_format();
    let mut config: StreamConfig = default_config.into();
    if buffer_ms > 0 {
        let frames = (config.sample_rate.0 as u64 * buffer_ms as u64 / 1000).max(64) as u32;
        config.buffer_size = BufferSize::Fixed(frames);
    }

    let try_build = |config: &StreamConfig| -> Result<Stream, String> {
        match sample_format {
            SampleFormat::F32 => build_input_typed::<f32>(&device, config, Arc::clone(&raw_ring)),
            SampleFormat::I16 => build_input_typed::<i16>(&device, config, Arc::clone(&raw_ring)),
            SampleFormat::U16 => build_input_typed::<u16>(&device, config, Arc::clone(&raw_ring)),
            SampleFormat::I32 => build_input_typed::<i32>(&device, config, Arc::clone(&raw_ring)),
            other => Err(format!("format sample mic belum didukung: {other:?}")),
        }
    };

    let mut used_buffer_ms = buffer_ms;
    let stream = match try_build(&config) {
        Ok(stream) => stream,
        Err(first_error) if config.buffer_size != BufferSize::Default => {
            eprintln!(
                "[audio] buffer mic {} ms ditolak ({}), fallback ke default",
                buffer_ms, first_error
            );
            config.buffer_size = BufferSize::Default;
            used_buffer_ms = 0;
            try_build(&config)?
        }
        Err(error) => return Err(error),
    };

    stream
        .play()
        .map_err(|e| format!("gagal memulai stream mic {}: {e}", device_name))?;

    let mut info = status(
        "mic",
        &device_name,
        config.sample_rate.0,
        config.channels,
        sample_format,
    );
    info.buffer_ms = if used_buffer_ms > 0 {
        Some(used_buffer_ms)
    } else {
        None
    };

    Ok(InputHandle {
        _stream: stream,
        status: info,
        sample_rate: config.sample_rate.0,
    })
}

fn build_input_typed<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    raw_ring: Arc<SpscRing>,
) -> Result<Stream, String>
where
    T: SizedSample + Sample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if channels == 0 {
                    return;
                }
                const CHUNK_FRAMES: usize = 512;
                let mut mono = [0.0f32; CHUNK_FRAMES];
                let frames = data.len() / channels;
                let mut offset = 0usize;
                while offset < frames {
                    let count = (frames - offset).min(CHUNK_FRAMES);
                    for (i, slot) in mono.iter_mut().enumerate().take(count) {
                        let base = (offset + i) * channels;
                        let mut sum = 0.0f32;
                        for channel in 0..channels {
                            sum += f32::from_sample(data[base + channel]);
                        }
                        *slot = sum / channels as f32;
                    }
                    raw_ring.push(&mono[..count]);
                    offset += count;
                }
            },
            |err| eprintln!("[audio] input stream error: {err}"),
            None,
        )
        .map_err(|e| format!("gagal build input stream: {e}"))
}
