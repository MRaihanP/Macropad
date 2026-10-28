# Plan: Mic DSP Chain (Production)

Status: disetujui 2026-10-28. Eksekusi per fase dengan checkpoint commit.

## Keputusan final

| Topik | Keputusan |
|---|---|
| Urutan chain | `HPF 80 Hz → Notch (off/50/100/150) → RNNoise → Gate → Boost (dB) → EQ → Compressor → Limiter → safety clamp` |
| Target latensi | DSP < 20 ms. Prefill output 240 ms dipertahankan; end-to-end diukur terpisah |
| Checkpoint | Commit + acceptance test di akhir setiap fase, lalu tes manual |
| Default | Gate off, Denoise off, Limiter on, Boost +6 dB, HPF selalu on |
| Arsitektur | DSP di mixer thread (bukan callback cpal), parameter lewat crossbeam, tanpa alokasi di `process()` |

## Bug yang diperbaiki lebih dulu (Fase 0)

| Bug | Lokasi | Perbaikan |
|---|---|---|
| HPF tidak aktif sampai settings pertama diubah | `mixer.rs` `MicProcessor::new` | Hitung koefisien di constructor |
| Hold gate 480x terlalu lama | `mixer.rs` `hold_left -= 1` per blok | Hitung per sample |
| Gate range hardcoded 0.01 (-40 dB) | `mixer.rs` | Ambil dari `noiseGateRangeDb` |
| Boost sebelum gate membuat threshold bergeser | `mixer.rs` | Boost setelah gate |
| EQ berbasis posisi sample dalam blok | `mixer.rs` | Diganti biquad di Fase 4 |
| Compressor tanpa attack/release/knee | `mixer.rs` | Diganti di Fase 5 |
| Limiter = clamp keras | `mixer.rs` | Lookahead di Fase 6 |
| `AudioState` tidak punya `micPre` | `types.rs`, `engine.rs` | Tambah field + publish |
| UI menimpa setting tersimpan dengan nilai hardcoded | `audio-panel.js` | Model `micPre` tunggal |

## Arsitektur

```
cpal input (device rate)
  → mono downmix + SpscRing          (sudah ada)
  → MicWorker resample → 48 kHz      (sudah ada)
  → mic_ring
  → MicChain::process(&mut [f32])    (mic_dsp.rs, mixer thread)
      HPF → Notch → Denoise → Gate → Boost → EQ → Comp → Limiter
  → mic_gain / mute
  → mix soundboard → Cable + Monitor
```

Aturan real-time:

- Semua state dialokasikan di `MicChain::new()`; `process()` tidak alokasi.
- `MicSettings` hanya berisi `f32`/`bool`/`u8` (Copy) supaya update tidak alokasi.
- Smoothing parameter 10–20 ms; biquad dihitung ulang per blok dari nilai smooth.
- Compressor/limiter control-rate 32 sample, interpolasi per sample.
- `MixerCommand::ResetMic` juga me-reset state DSP (biquad, delay, denoise, gate).

## Spesifikasi stage

| Stage | Algoritma | Parameter | Default |
|---|---|---|---|
| HPF | RBJ high-pass 80 Hz Q=0.707 | selalu aktif | on |
| Notch | RBJ notch Q=10 | off/50/100/150 Hz | off |
| Denoise | `nnnoiseless`, frame 480, pregain +12 dB, wet/dry | enable, mix 0–100% | off, 80% |
| Gate | Sidechain HPF 100 Hz + LPF 4 kHz; envelope 2/50 ms; hysteresis 6 dB; hold; attack; release; range | enable, threshold −80…−10, learn, advanced | off, −45, hold 150, attack 8, release 220, range −50 |
| Boost | dB → linear, smooth 15 ms | 0…+20 dB | +6 dB |
| EQ | Low shelf 120 Hz, peak 1 kHz Q=0.8, high shelf 6 kHz | ±12 dB/band | 0/0/0 |
| Compressor | Feed-forward, dB detector, soft knee 6 dB, auto-makeup | threshold, ratio, attack 5–30, release 50–300, makeup | −18 dB, 3:1, 10 ms, 120 ms |
| Limiter | Lookahead 4 ms, sliding-min, release 50 ms | enable, ceiling | on, −1 dBFS |
| Safety | clamp −0.1 dBFS setelah limiter | — | selalu |

Meter (`LevelFrame`): `micInDb`, `gateInDb`, `gateOpen`, `gateGainDb`, `compGrDb`, `limitGrDb`, `vad`.

Learn noise floor: capture 3 detik `gateInDb` (≈90 frame @30 Hz), median + 9 dB, clamp −80…−10.

## Kontrak data

`MicSettings` final:

```
micBoostDb, humNotchHz,
denoiseEnabled, denoiseMix,
noiseGateEnabled, noiseGateThreshold, noiseGateHysteresisDb,
noiseGateAttackMs, noiseGateHoldMs, noiseGateReleaseMs, noiseGateRangeDb,
equalizerEnabled, equalizerLow, equalizerMid, equalizerHigh,
compressorEnabled, compressorThreshold, compressorRatio,
compressorAttackMs, compressorReleaseMs, compressorMakeupGain, compressorAutoMakeup,
limiterEnabled, limiterCeiling, limiterReleaseMs
```

- `AudioSettings` mendapat `version: u32`; file lama (`version` tidak ada) dimigrasi `micBoost` linear → `micBoostDb = 20*log10`.
- Field lama `micBoost` dipertahankan (deprecated) agar file lama terbaca.
- `MicSettings::sanitize()` menolak NaN/Inf dan clamp semua range; dipanggil saat load, command, dan preset.
- Preset disimpan di Rust (`audio_mic_presets`, `audio_apply_mic_preset`).

| Preset | Boost | Denoise | Gate | EQ L/M/H | Comp |
|---|---|---|---|---|---|
| Podcast/Voice | +6 | on 80% | on −42, range −50 | +2/+1/+2 | 3:1, −18 |
| Game chat | +12 | on 100% | on −38, range −60 | −2/+2/0 | 4:1, −20 |
| Noisy room | +9 | on 100% | on −32, range −60 | −3/+2/+1 | 3:1, −18 |

## Fase

### Fase 0 — Fondasi & bug fix

File: `mic_dsp.rs` (baru), `mod.rs`, `mixer.rs`, `types.rs`, `engine.rs`, `settings.rs`, `Cargo.toml`, `examples/mic_offline.rs`, `index.html`, `audio-panel.js`, `styles.css`, locales.

- Ekstrak DSP ke `MicChain` + `Biquad`; hapus `MicProcessor`.
- Fix HPF init, hold per sample, range dari dB, boost setelah gate.
- `LevelFrame` camelCase + meter baru; `AudioState.micPre`; `sanitize()`.
- Harness WAV offline.
- UI: gate LED, GR comp/limiter, hidrasi `micPre` dari state (tidak lagi hardcoded).

Acceptance:
- `cargo test --lib` hijau; `npm run build` OK; `npm test` tidak menambah kegagalan baru.
- 50 Hz teredam ≥ 6 dB sejak sample pertama.
- Hold 100 ms menutup dalam 100–300 ms setelah sinyal berhenti.
- Gate range −60 dB mencapai ≤ −55 dB saat tertutup.
- Harness menghasilkan WAV + metrik.

### Fase 1 — Boost dB, HPF, notch

- Migrasi `micBoost` linear → `micBoostDb`, `settingsVersion`.
- Slider dB 0…+20; label `+6.0 dB (2.0×)`.
- Notch 50/100/150 Hz.

Acceptance: 0 dB unity, +20 dB = 10x; tanpa klik saat slider; notch ≥ 15 dB di frekuensi target; migrasi 2.0 → +6.02 dB.

### Fase 2 — Gate

- Sidechain BPF 100 Hz–4 kHz, hysteresis, hold, attack, release, range.
- UI threshold −80…−10 + Learn + advanced.
- VAD hook disiapkan.

Acceptance: noise-only turun ≥ 25 dB; onset kata tidak terpotong; tidak chatter; hold sesuai.

### Fase 3 — Denoise

- Integrasi `nnnoiseless`, pregain, wet/dry + kompensasi delay, preroll.
- VAD → gate; skip processing saat mix 0.
- UI mix slider.

Acceptance: noise-only turun ≥ 10 dB; speech+noise membaik tanpa artefak "berair"; alignment dry/wet ≤ 1 sample; realtime factor < 0.05.

### Fase 4 — EQ biquad

- Low shelf 120 Hz, peak 1 kHz Q=0.8, high shelf 6 kHz; auto-bypass saat 0.

Acceptance: respons sweep di 120/1k/6k dalam ±1 dB.

### Fase 5 — Compressor

- Log-domain, soft knee 6 dB, attack/release, auto-makeup, GR meter.

Acceptance: kurva statis sesuai; timing ±20%; GR meter ±1 dB.

### Fase 6 — Limiter

- Lookahead 4 ms, sliding-min, release 50 ms, ceiling −1 dBFS.

Acceptance: input +12 dB di atas ceiling tidak pernah melewati ceiling; THD < 1% di bawah ceiling.

### Fase 7 — Preset & QA

- 3 preset, tuning lewat harness.
- Ukur CPU dan latensi DSP; uji 44.1/48 kHz; hot-plug.

Acceptance: CPU < 5% satu core; latensi DSP < 20 ms; preset terukur; `npm test` tetap 39/43 (4 kegagalan BLE/firmware yang diketahui).

## Harness offline

```
cargo run --manifest-path src-tauri/Cargo.toml --example mic_offline -- \
  tests/audio/speech_noise.wav out.wav --gate -40 --hold 150 --release 220
```

Opsi: `--gate <db>`, `--hold <ms>`, `--release <ms>`, `--range <db>`, `--boost <linear>`, `--comp`, `--no-limiter`, `--json`.

Fixture yang perlu direkam: `noise_only.wav`, `speech_only.wav`, `speech_noise.wav` (48 kHz mono lebih baik; 44.1 kHz juga didukung).

## Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| RNNoise berair / konsonan hilang | mix default 80%, A/B harness, preset tuning |
| Boost clip sebelum limiter | boost setelah denoise + limiter + safety clamp + indikator over |
| Gate pumping/klik | gain per sample, attack ≥ 5 ms, range bukan mute, hold 150 ms |
| Dry/wet tidak align | uji impuls, delay line 480 sample bila perlu |
| Migrasi settings rusak | `version` + unit test |
| Alokasi saat enable denoise | `DenoiseState` dibuat di `MicChain::new()` |
| Prefill 240 ms vs 20 ms | target dipisah: DSP vs end-to-end |
| Gate jalan saat mic mati | idle detector > 100 ms → skip + reset |

## Workflow commit

1. Satu commit per fase dengan pesan `feat(audio): ... (mic phase N)`.
2. Sebelum commit: `npm run test:rust`, `npm run build`, `npm test`.
3. `_st.txt` dan `_tracked.txt` tidak pernah di-commit.
