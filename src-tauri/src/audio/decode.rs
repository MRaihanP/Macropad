//! Decode file soundboard menjadi PCM stereo f32 48 kHz.
//!
//! Decode dilakukan sekali saat pertama diputar, lalu di-cache di memori.
//! Cache dibatasi supaya soundboard dengan banyak file tidak menghabiskan RAM.

use crate::audio::resample::{resample_interleaved, ENGINE_SAMPLE_RATE};
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

const CACHE_LIMIT_BYTES: usize = 128 * 1024 * 1024;

pub struct Clip {
    /// Interleaved stereo 48 kHz.
    pub samples: Arc<Vec<f32>>,
    /// Gain diterapkan di play-time (engine.play), bukan di decode-time.
    /// Nilai ini selalu 1.0 karena gain dihitung di mixer dari entry.volume
    /// yang dibaca di audio_play. Ini memungkinkan mengubah volume tanpa
    /// decode ulang clip yang dicache.
    pub gain: f32,
}

impl Clip {
    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }
}

fn cache() -> &'static Mutex<HashMap<String, Arc<Clip>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Clip>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_bytes(map: &HashMap<String, Arc<Clip>>) -> usize {
    map.values()
        .map(|clip| clip.samples.len() * std::mem::size_of::<f32>())
        .sum()
}

pub fn invalidate(id: &str) {
    if let Ok(mut map) = cache().lock() {
        map.remove(id);
    }
}

/// Ambil clip dari cache, atau decode dari disk.
///
/// Gain diterapkan di play-time, bukan di sini. `decode_file` selalu dipanggil
/// dengan gain = 1.0 sehingga clip yang dicache bersih dan dapat dipakai kembali
/// walaupun entry.volume berubah. Engine.play() yang kemudian menerima gain
/// terpisah dari entry.volume dan meneruskan ke mixer.
pub fn load_clip(app: &tauri::AppHandle, id: &str) -> Result<Arc<Clip>, String> {
    if let Ok(map) = cache().lock() {
        if let Some(clip) = map.get(id) {
            return Ok(Arc::clone(clip));
        }
    }

    let data = crate::load_sounds(app);
    let entry = data
        .sounds
        .iter()
        .find(|sound| sound.id == id)
        .ok_or_else(|| format!("suara \"{id}\" tidak ditemukan"))?;

    let dir = crate::sounds_dir(app).ok_or("folder sounds tidak tersedia")?;
    let path = dir.join(&entry.rel_path);
    // Gain = 1.0: gain diterapkan di engine.play() dari entry.volume.
    let clip = decode_file(&path, 1.0, entry.trim_start_ms, entry.trim_end_ms)?;
    let clip = Arc::new(clip);

    if let Ok(mut map) = cache().lock() {
        if cache_bytes(&map) > CACHE_LIMIT_BYTES {
            map.clear();
        }
        map.insert(id.to_string(), Arc::clone(&clip));
    }

    Ok(clip)
}

fn decode_file(
    path: &Path,
    gain: f32,
    trim_start_ms: u32,
    trim_end_ms: u32,
) -> Result<Clip, String> {
    let file = File::open(path).map_err(|e| format!("gagal buka {}: {e}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("format audio tidak dikenali: {e}"))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "file tidak punya track audio".to_string())?;
    let track_id = track.id;
    let source_rate = track.codec_params.sample_rate.unwrap_or(ENGINE_SAMPLE_RATE);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("codec tidak didukung: {e}"))?;

    let mut interleaved: Vec<f32> = Vec::new();
    let mut decoded_frames = 0usize;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(err) => return Err(format!("gagal membaca audio: {err}")),
        };
        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let channels = spec.channels.count().max(1);
                let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buffer.copy_interleaved_ref(decoded);
                let samples = buffer.samples();
                let frames = samples.len() / channels;
                interleaved.reserve(frames * 2);
                for frame in 0..frames {
                    let left = samples[frame * channels];
                    let right = if channels > 1 {
                        samples[frame * channels + 1]
                    } else {
                        left
                    };
                    interleaved.push(left);
                    interleaved.push(right);
                }
                decoded_frames += frames;
            }
            Err(Error::DecodeError(err)) => {
                eprintln!("[audio] decode packet dilewati: {err}");
                continue;
            }
            Err(err) => return Err(format!("gagal decode audio: {err}")),
        }
    }

    if decoded_frames == 0 {
        return Err("tidak ada sample audio yang berhasil didecode".into());
    }

    let mut samples = resample_interleaved(&interleaved, 2, source_rate, ENGINE_SAMPLE_RATE)?;

    // Trim non-destruktif (berbasis waktu, setelah resample ke 48 kHz).
    let total_frames = samples.len() / 2;
    let start_frame = ((trim_start_ms as u64 * ENGINE_SAMPLE_RATE as u64) / 1000)
        .min(total_frames as u64) as usize;
    let end_frame = if trim_end_ms == 0 {
        total_frames
    } else {
        ((trim_end_ms as u64 * ENGINE_SAMPLE_RATE as u64) / 1000).min(total_frames as u64) as usize
    };
    if end_frame > start_frame {
        samples = samples[start_frame * 2..end_frame * 2].to_vec();
    } else if start_frame > 0 {
        samples.clear();
    }

    Ok(Clip {
        samples: Arc::new(samples),
        gain: gain.clamp(0.0, 4.0),
    })
}

/// Durasi file dalam milidetik, tanpa menyimpan hasil decode ke cache.
///
/// Jalur cepat memakai metadata container (`n_frames` + `time_base`); kalau
/// tidak tersedia (mis. sebagian MP3), file di-decode sekali untuk menghitung
/// frame. Hasilnya dipakai UI trim dan ditampilkan di kartu library.
pub fn probe_duration_ms(path: &Path) -> Result<u32, String> {
    let file = File::open(path).map_err(|e| format!("gagal buka {}: {e}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("format audio tidak dikenali: {e}"))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "file tidak punya track audio".to_string())?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let sample_rate = params.sample_rate.unwrap_or(ENGINE_SAMPLE_RATE).max(1) as u64;

    if let (Some(frames), Some(time_base)) = (params.n_frames, params.time_base) {
        if time_base.denom > 0 {
            let seconds = frames as f64 * time_base.numer as f64 / time_base.denom as f64;
            if seconds.is_finite() && seconds > 0.0 {
                let ms = (seconds * 1000.0).round();
                if ms >= 1.0 {
                    return Ok((ms as u64).min(u32::MAX as u64) as u32);
                }
            }
        }
    }

    // Fallback: hitung frame hasil decode. Tidak di-resample karena durasi
    // tidak berubah oleh resampling.
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| format!("codec tidak didukung: {e}"))?;
    let mut frames = 0u64;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(err) => return Err(format!("gagal membaca audio: {err}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => frames += decoded.frames() as u64,
            Err(Error::DecodeError(_)) => continue,
            Err(Error::IoError(err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(err) => return Err(format!("gagal decode audio: {err}")),
        }
    }

    if frames == 0 {
        return Err("tidak ada sample audio yang berhasil dibaca".into());
    }
    let ms = frames.saturating_mul(1000) / sample_rate;
    Ok(ms.min(u32::MAX as u64) as u32)
}
