export const SAMPLE_RATE = 24000;
export const FRAMES_PER_SEND = 2400;

export function merge(chunks: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// why: mics often run at 44.1 or 48 kHz; the speech APIs expect 24 kHz.
export function resample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return input;
  const ratio = fromRate / SAMPLE_RATE;
  const out = new Float32Array(Math.round(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio;
    const j = Math.min(Math.floor(pos), input.length - 1);
    const next = input[Math.min(j + 1, input.length - 1)];
    out[i] = input[j] + (next - input[j]) * (pos - j);
  }
  return out;
}

export function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Int16Array(samples.length);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  });
  return new Uint8Array(out.buffer);
}

// why: dB scale so quiet laptop mics still move the meter (-60 dB empty, 0 dB full).
export function levelOf(chunk: Float32Array): number {
  let sum = 0;
  for (const sample of chunk) sum += sample * sample;
  const db = 20 * Math.log10(Math.sqrt(sum / (chunk.length || 1)) + 1e-8);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
