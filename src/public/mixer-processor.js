// ==================== AudioWorklet: WASAPI ring buffer bridge ====================
//
// Low-latency export (Fase 2D): AudioWorkletProcessor push mono PCM i16 ke
// SharedArrayBuffer ring buffer tiap render quantum (~128 sample @ 44.1kHz ≈ 2.9ms).
// Frontend polling worker copy chunk ke Vec<i16> dan invoke('audio_enqueue').
//
// Fallback (Fase 2B): bila SharedArrayBuffer tidak tersedia (dev tanpa COOP/COEP),
// playSound pakai AudioBuffer.getChannelData export seperti sebelumnya.
//
// Protokol SAB:
//   - offset 0     : u32 writeIndex (atomik)
//   - offset 4     : u32 readIndex (atomik, frontend consume)
//   - offset 8     : i16 data[0 .. N] (N dihitung di index.js)

class MixerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'soundVolume', defaultValue: 1.0, minValue: 0, maxValue: 1 },
      { name: 'micVolume', defaultValue: 1.0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.sab = null;
    this.dataView = null;
    this.i16View = null;
    this.writeIdx = 0;
    this.readIdx = 0;
    // Header SAB: 2 x u32 = 8 byte
    this.headerSize = 8;
    this.sampleRate = 44100;

    this.port.onmessage = (e) => {
      if (e.data && e.data.sab) {
        this.sab = e.data.sab;
        this.dataView = new DataView(this.sab);
        this.writeIdx = this.dataView.getUint32(0, true);
        this.readIdx = this.dataView.getUint32(4, true);
        this.i16View = new Int16Array(this.sab, this.headerSize);
        this.capacity = this.i16View.length;
      }
    };
  }

  process(inputs, _outputs, params) {
    const input = inputs[0];
    if (!input || input.length === 0 || !this.sab) return true;

    const channel = input[0];
    const sv = params.soundVolume?.[0] ?? 1.0;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i])) * sv;
      const sample = Math.round(s * 32767);
      // Ring buffer: skip bila penuh (overwrite policy untuk low-latency)
      const next = (this.writeIdx + 1) % this.capacity;
      if (next === this.readIdx) {
        // Buffer penuh — lewati (drop) demi latency kecil
        continue;
      }
      this.i16View[this.writeIdx] = sample;
      this.writeIdx = next;
    }

    // Update write index ke SAB header (atomik)
    this.dataView.setUint32(0, this.writeIdx, true);
    return true;
  }
}

registerProcessor('mixer-processor', MixerProcessor);
