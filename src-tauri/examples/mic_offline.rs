//! Harness offline untuk mic DSP chain.
//!
//! Membaca WAV (mono/stereo, 8/16/24/32-bit int atau f32), downmix ke mono,
//! resample ke 48 kHz, memproses lewat `MicChain`, lalu menulis WAV f32 dan
//! mencetak metrik. Dipakai untuk A/B per fase tanpa harus membuka app.
//!
//! Contoh:
//! ```text
//! cargo run --manifest-path src-tauri/Cargo.toml --example mic_offline -- \
//!   tests/audio/speech_noise.wav out.wav --gate -40 --hold 150 --release 220
//! ```

use macropad_configurator_lib::audio::{
    mic_dsp::{to_db, MicChain},
    resample::resample_interleaved,
    settings::MicSettings,
};
use std::path::Path;
use std::time::Instant;

const ENGINE_RATE: u32 = 48_000;
const BLOCK: usize = 480;

fn usage() {
    eprintln!(
        "usage: mic_offline <in.wav> <out.wav> [opsi]\n\
         opsi:\n\
           --gate <db>       aktifkan gate dengan threshold dBFS (mis. -40)\n\
           --hold <ms>       hold gate (default dari MicSettings)\n\
           --release <ms>    release gate\n\
           --range <db>      redaman gate saat tertutup (mis. -50)\n\
           --boost <db>      mic boost dalam dB (0 = unity, 20 = 10x)\n\
           --notch <hz>      hum notch: 0/50/100/150\n\
           --comp            aktifkan compressor\n\
           --no-limiter      matikan limiter\n\
           --json            cetak metrik sebagai satu baris JSON"
    );
}

fn read_wav(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("gagal buka {}: {e}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;

    let mut mono: Vec<f32> = Vec::new();
    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => {
            let mut frame = 0.0f32;
            for (index, sample) in reader.samples::<f32>().enumerate() {
                frame += sample.map_err(|e| e.to_string())?;
                if (index + 1) % channels == 0 {
                    mono.push(frame / channels as f32);
                    frame = 0.0;
                }
            }
        }
        (hound::SampleFormat::Int, 16) => {
            let mut frame = 0.0f32;
            for (index, sample) in reader.samples::<i16>().enumerate() {
                frame += sample.map_err(|e| e.to_string())? as f32 / 32_768.0;
                if (index + 1) % channels == 0 {
                    mono.push(frame / channels as f32);
                    frame = 0.0;
                }
            }
        }
        (hound::SampleFormat::Int, 8) => {
            let mut frame = 0.0f32;
            for (index, sample) in reader.samples::<i8>().enumerate() {
                frame += sample.map_err(|e| e.to_string())? as f32 / 128.0;
                if (index + 1) % channels == 0 {
                    mono.push(frame / channels as f32);
                    frame = 0.0;
                }
            }
        }
        (hound::SampleFormat::Int, bits @ (24 | 32)) => {
            let scale = (1u64 << (bits - 1)) as f32;
            let mut frame = 0.0f32;
            for (index, sample) in reader.samples::<i32>().enumerate() {
                frame += sample.map_err(|e| e.to_string())? as f32 / scale;
                if (index + 1) % channels == 0 {
                    mono.push(frame / channels as f32);
                    frame = 0.0;
                }
            }
        }
        other => return Err(format!("format WAV belum didukung: {other:?}")),
    }

    if mono.is_empty() {
        return Err("file tidak punya sample".into());
    }
    Ok((mono, spec.sample_rate))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        usage();
        std::process::exit(2);
    }

    let input_path = Path::new(&args[0]);
    let output_path = Path::new(&args[1]);
    let mut settings = MicSettings::default();
    // Harness mengukur chain, bukan preset app: boost default 0 dB supaya
    // perbandingan input/output langsung terlihat.
    settings.mic_boost_db = 0.0;
    let mut json = false;

    let mut index = 2;
    while index < args.len() {
        let flag = args[index].as_str();
        let mut next_value = |name: &str| -> Result<f32, String> {
            index += 1;
            args.get(index)
                .ok_or_else(|| format!("{name} butuh nilai"))?
                .parse::<f32>()
                .map_err(|e| format!("{name} tidak valid: {e}"))
        };
        let result: Result<(), String> = (|| {
            match flag {
                "--gate" => {
                    settings.noise_gate_enabled = true;
                    settings.noise_gate_threshold = next_value("--gate")?;
                }
                "--hold" => settings.noise_gate_hold_ms = next_value("--hold")?,
                "--release" => settings.noise_gate_release_ms = next_value("--release")?,
                "--range" => settings.noise_gate_range_db = next_value("--range")?,
                "--boost" => settings.mic_boost_db = next_value("--boost")?,
                "--notch" => settings.hum_notch_hz = next_value("--notch")?,
                "--comp" => settings.compressor_enabled = true,
                "--no-limiter" => settings.limiter_enabled = false,
                "--json" => json = true,
                other => return Err(format!("opsi tidak dikenal: {other}")),
            }
            Ok(())
        })();

        if let Err(error) = result {
            eprintln!("{error}");
            usage();
            std::process::exit(2);
        }
        index += 1;
    }
    settings.sanitize();

    let (input, sample_rate) = match read_wav(input_path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };

    let input = if sample_rate == ENGINE_RATE {
        input
    } else {
        match resample_interleaved(&input, 1, sample_rate, ENGINE_RATE) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("resample gagal: {error}");
                std::process::exit(1);
            }
        }
    };

    let duration_secs = input.len() as f64 / ENGINE_RATE as f64;
    let input_rms = rms(&input);
    let input_peak = peak(&input);

    let mut chain = MicChain::new(settings);
    let mut output = input.clone();
    let mut comp_gr_max = 0.0f32;
    let mut limiter_gr_max = 0.0f32;
    let mut gate_open_blocks = 0usize;
    let mut block_count = 0usize;
    let mut last_gate_gain_db = 0.0f32;

    let started = Instant::now();
    for block in output.chunks_mut(BLOCK) {
        let meters = chain.process(block);
        comp_gr_max = comp_gr_max.max(meters.comp_gr_db);
        limiter_gr_max = limiter_gr_max.max(meters.limiter_gr_db);
        last_gate_gain_db = meters.gate_gain_db;
        if meters.gate_open {
            gate_open_blocks += 1;
        }
        block_count += 1;
    }
    let elapsed = started.elapsed().as_secs_f64();

    if let Err(error) = write_wav(output_path, &output) {
        eprintln!("{error}");
        std::process::exit(1);
    }

    let output_rms = rms(&output);
    let output_peak = peak(&output);
    let attenuation = attenuation_db(output_rms, input_rms);
    // Abaikan bagian awal: gate sengaja mulai terbuka dengan hold penuh dan
    // butuh waktu release. Untuk uji noise-only, kuartal terakhir adalah
    // kondisi steady-state.
    let steady_start = output.len() * 3 / 4;
    let steady_attenuation = attenuation_db(
        rms(&output[steady_start..]),
        rms(&input[steady_start..]),
    );
    let rtf = if duration_secs > 0.0 {
        elapsed / duration_secs
    } else {
        0.0
    };
    let gate_ratio = if block_count > 0 {
        gate_open_blocks as f64 / block_count as f64
    } else {
        0.0
    };

    if json {
        println!(
            "{{\"inputRmsDb\":{:.2},\"inputPeakDb\":{:.2},\"outputRmsDb\":{:.2},\"outputPeakDb\":{:.2},\"attenuationDb\":{:.2},\"overallAttenuationDb\":{:.2},\"compGrMaxDb\":{:.2},\"limiterGrMaxDb\":{:.2},\"gateOpenRatio\":{:.3},\"gateGainDb\":{:.2},\"rtf\":{:.4},\"seconds\":{:.3}}}",
            to_db(input_rms),
            to_db(input_peak),
            to_db(output_rms),
            to_db(output_peak),
            steady_attenuation,
            attenuation,
            comp_gr_max,
            limiter_gr_max,
            gate_ratio,
            last_gate_gain_db,
            rtf,
            duration_secs
        );
    } else {
        println!("input : rms {:>7.2} dBFS  peak {:>7.2} dBFS", to_db(input_rms), to_db(input_peak));
        println!("output: rms {:>7.2} dBFS  peak {:>7.2} dBFS", to_db(output_rms), to_db(output_peak));
        println!("attenuation steady (kuartal terakhir): {:.2} dB", steady_attenuation);
        println!("attenuation overall: {:.2} dB", attenuation);
        println!("gate open: {:.1}%  comp GR max: {:.2} dB  limiter GR max: {:.2} dB",
            gate_ratio * 100.0, comp_gr_max, limiter_gr_max);
        println!("rtf: {:.4} ({:.1}x realtime, {:.2} s audio)", rtf, if rtf > 0.0 { 1.0 / rtf } else { 0.0 }, duration_secs);
        println!("output: {}", output_path.display());
    }
}

fn write_wav(path: &Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: ENGINE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("gagal tulis {}: {e}", path.display()))?;
    for sample in samples {
        writer.write_sample(*sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    (sum / samples.len() as f32).sqrt()
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()))
}

/// Rasio RMS dalam dB, tanpa floor -100 dB milik meter. Dipakai untuk
/// mengukur atenuasi gate yang bisa mencapai -80 dB.
fn attenuation_db(output: f32, input: f32) -> f32 {
    if input <= 1.0e-9 {
        0.0
    } else {
        (20.0 * (output / input).log10()).max(-120.0)
    }
}
