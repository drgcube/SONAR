/** All analysis runs locally. Pitch use describes this recording, not vocal health. */
export type PitchFrame = { time: number; frequency: number; midi: number; confidence: number };
export type NoteBin = { midi: number; label: string; frequency: number; seconds: number; percent: number };
export type PitchEstimate = { frequency: number; confidence: number };
export type AnalysisResult = {
  duration: number;
  voicedSeconds: number;
  voicedRatio: number;
  medianHz: number | null;
  lowHz: number | null;
  highHz: number | null;
  rangeSemitones: number | null;
  /**
   * Semitone bins spanning the 5th–95th F0 percentiles, rounded outward.
   * Percentages use every voiced frame as denominator; outlying frames remain
   * in `frames`, so displayed percentages can sum to less than 100%.
   */
  notes: NoteBin[];
  frames: PitchFrame[];
  /** 1024 relative-dB bins, [-80, 0]. Use spectrumBinHz for their frequencies. */
  spectrum: number[];
  /** Time columns, each containing 128 low-to-high log-frequency relative-dB bins. */
  spectrogram: number[][];
  /** Original audio sample rate, before the internal antialiased resampling. */
  sampleRate: number;
  clippingRatio: number;
  rms: number;
  quality: 'good' | 'limited' | 'insufficient';
  suggestedMidi: number | null;
};

export const SPECTRUM_FFT_SIZE = 2048;
export const SPECTROGRAM_BINS = 128;
export const SPECTRUM_FLOOR_DB = -80;
const MIN_PITCH = 60;
const MAX_PITCH = 1000;
const PITCH_WINDOW_SECONDS = 0.05;
const HOP_SECONDS = 0.04;
const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function midiToHz(midi: number): number { return 440 * 2 ** ((midi - 69) / 12); }
export function hzToMidi(hz: number): number { return 69 + 12 * Math.log2(hz / 440); }
export function noteName(midi: number): string {
  const note = Math.round(midi);
  return `${NOTES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}
export function spectrumBinHz(index: number, sampleRate: number): number {
  return index * Math.min(sampleRate, 16000) / SPECTRUM_FFT_SIZE;
}
export function spectrogramBinHz(index: number, sampleRate: number): number {
  return MIN_PITCH * (Math.min(8000, sampleRate / 2) / MIN_PITCH) ** (index / (SPECTROGRAM_BINS - 1));
}

/** Windowed-sinc resampling prevents high harmonics aliasing into the pitch band. */
function resample(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  const radius = Math.max(8, Math.ceil(8 * ratio));
  const phaseCount = 64;
  const cutoff = Math.min(1, 1 / ratio) * 0.94;
  const kernels: Float64Array[] = [];
  for (let phase = 0; phase < phaseCount; phase++) {
    const kernel = new Float64Array(radius * 2 + 1);
    let total = 0;
    for (let tap = -radius; tap <= radius; tap++) {
      const offset = tap - phase / phaseCount;
      const x = Math.PI * offset * cutoff;
      const sinc = Math.abs(x) < 1e-10 ? 1 : Math.sin(x) / x;
      const window = Math.abs(offset) > radius ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * offset / radius) + 0.08 * Math.cos(2 * Math.PI * offset / radius);
      kernel[tap + radius] = cutoff * sinc * window;
      total += kernel[tap + radius];
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
    kernels.push(kernel);
  }
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    const center = Math.floor(position);
    const kernel = kernels[Math.min(phaseCount - 1, Math.floor((position - center) * phaseCount))];
    let sum = 0;
    for (let tap = -radius; tap <= radius; tap++) {
      const index = center + tap;
      if (index >= 0 && index < samples.length) sum += samples[index] * kernel[tap + radius];
    }
    output[i] = sum;
  }
  return output;
}

/** YIN cumulative mean normalized difference; null means no reliable periodic pitch. */
export function detectPitch(samples: Float32Array, sampleRate: number): PitchEstimate | null {
  if (!Number.isFinite(sampleRate) || sampleRate < 2000 || samples.length === 0) return null;
  const rate = Math.min(sampleRate, 8000);
  return yin(sampleRate > rate ? resample(samples, sampleRate, rate) : samples, rate, 0.002);
}

function yin(samples: Float32Array, sampleRate: number, rmsGate: number): PitchEstimate | null {
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_PITCH));
  // Keep a neighbor beyond the lower-pitch boundary for period interpolation.
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_PITCH) + 1, Math.floor(samples.length / 2));
  if (maxLag <= minLag + 1) return null;
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += (samples[i] - mean) ** 2;
  if (!Number.isFinite(energy) || Math.sqrt(energy / samples.length) < rmsGate) return null;

  const difference = new Float64Array(maxLag + 1);
  const rawDifference = new Float64Array(maxLag + 1);
  const windowLength = samples.length - maxLag;
  let accumulated = 0;
  difference[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < windowLength; i++) {
      const delta = samples[i] - samples[i + lag];
      sum += delta * delta;
    }
    rawDifference[lag] = sum;
    accumulated += sum;
    difference[lag] = accumulated > 0 ? sum * lag / accumulated : 1;
  }
  let candidate = -1;
  for (let lag = minLag; lag < maxLag; lag++) {
    if (difference[lag] < 0.16) {
      while (lag + 1 <= maxLag && difference[lag + 1] < difference[lag]) lag++;
      candidate = lag;
      break;
    }
  }
  if (candidate < 0) return null;
  const confidence = Math.max(0, Math.min(1, 1 - difference[candidate]));
  let period = candidate;
  if (candidate > 0 && candidate < maxLag) {
    // Interpolate the unnormalized difference to avoid CMND's short-lag bias.
    const left = rawDifference[candidate - 1];
    const center = rawDifference[candidate];
    const right = rawDifference[candidate + 1];
    const denominator = left - 2 * center + right;
    if (Math.abs(denominator) > 1e-12) period += Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator));
  }
  const frequency = sampleRate / period;
  // A tiny interpolation tolerance retains tones exactly on either endpoint.
  if (frequency < MIN_PITCH * 0.999 || frequency > MAX_PITCH * 1.001 || confidence < 0.84) return null;
  return { frequency: Math.max(MIN_PITCH, Math.min(MAX_PITCH, frequency)), confidence };
}

function fftPower(samples: Float32Array, center: number): Float64Array {
  const size = SPECTRUM_FFT_SIZE;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  const start = Math.round(center - size / 2);
  let mean = 0;
  let count = 0;
  for (let i = 0; i < size; i++) {
    const sampleIndex = start + i;
    if (sampleIndex >= 0 && sampleIndex < samples.length) { mean += samples[sampleIndex]; count++; }
  }
  mean /= Math.max(count, 1);
  for (let i = 0; i < size; i++) {
    const sampleIndex = start + i;
    if (sampleIndex >= 0 && sampleIndex < samples.length) {
      real[i] = (samples[sampleIndex] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    }
  }
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let length = 2; length <= size; length *= 2) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let weightReal = 1;
      let weightImaginary = 0;
      for (let j = 0; j < length / 2; j++) {
        const even = offset + j;
        const odd = even + length / 2;
        const oddReal = real[odd] * weightReal - imaginary[odd] * weightImaginary;
        const oddImaginary = real[odd] * weightImaginary + imaginary[odd] * weightReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextWeight = weightReal * stepReal - weightImaginary * stepImaginary;
        weightImaginary = weightReal * stepImaginary + weightImaginary * stepReal;
        weightReal = nextWeight;
      }
    }
  }
  const power = new Float64Array(size / 2);
  for (let i = 0; i < power.length; i++) power[i] = (real[i] ** 2 + imaginary[i] ** 2) / (size * size);
  return power;
}

function percentile(sorted: number[], percent: number): number {
  const index = (sorted.length - 1) * percent;
  const below = Math.floor(index);
  return sorted[below] + (sorted[Math.min(sorted.length - 1, below + 1)] - sorted[below]) * (index - below);
}
function decibels(power: number, reference: number): number {
  return reference > 1e-14 ? Math.max(SPECTRUM_FLOOR_DB, Math.min(0, 10 * Math.log10(Math.max(power, 1e-20) / reference))) : SPECTRUM_FLOOR_DB;
}
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Speech pitch uses 50 ms windows at up to 8 kHz and a 40 ms hop. This spans
 * three periods at the 60 Hz lower bound while following changing speech pitch.
 * Only reliable, non-silent periodic windows count. The range is the
 * 5th–95th percentile of F0.
 * Spectrogram column centers are evenly spaced at (column + .5) * duration / count.
 * Each log-frequency row contains peak power in that row's band (nearest FFT bin
 * at low frequencies). Every column uses the same relative dB reference.
 */
export async function analyzeAudio(samples: Float32Array, sampleRate: number, onProgress?: (n: number) => void): Promise<AnalysisResult> {
  if (!Number.isFinite(sampleRate) || sampleRate < 2000 || sampleRate > 384000) throw new Error('Unsupported audio sample rate.');
  if (samples.length === 0) throw new Error('The recording contains no audio.');
  onProgress?.(0);
  let energy = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    if (!Number.isFinite(value)) throw new Error('The recording contains invalid audio samples.');
    energy += value * value;
    if (Math.abs(value) >= 0.995) clipped++;
  }
  const duration = samples.length / sampleRate;
  const rms = Math.sqrt(energy / samples.length);
  const clippingRatio = clipped / samples.length;
  await yieldToBrowser();
  const spectrumRate = Math.min(16000, sampleRate);
  const downsampled = resample(samples, sampleRate, spectrumRate);
  onProgress?.(0.12);
  await yieldToBrowser();
  const pitchRate = Math.min(8000, sampleRate);
  const pitchSamples = resample(downsampled, spectrumRate, pitchRate);
  const frames: PitchFrame[] = [];
  const hop = Math.round(pitchRate * HOP_SECONDS);
  const windowSize = Math.min(Math.round(pitchRate * PITCH_WINDOW_SECONDS), pitchSamples.length);
  const rmsGate = Math.max(0.002, rms * 0.08);
  const windowCount = Math.max(1, Math.floor((pitchSamples.length - windowSize) / hop) + 1);
  for (let index = 0; index < windowCount; index++) {
    const start = index * hop;
    const estimate = yin(pitchSamples.subarray(start, start + windowSize), pitchRate, rmsGate);
    if (estimate) frames.push({ time: (start + windowSize / 2) / pitchRate, frequency: estimate.frequency, midi: hzToMidi(estimate.frequency), confidence: estimate.confidence });
    if (index % 32 === 0) {
      onProgress?.(0.18 + 0.56 * index / windowCount);
      await yieldToBrowser();
    }
  }
  const columnCount = Math.max(1, Math.min(180, Math.ceil(duration / 0.05)));
  const spectralColumns: Float64Array[] = [];
  const averagePower = new Float64Array(SPECTRUM_FFT_SIZE / 2);
  let spectralPeak = 0;
  for (let column = 0; column < columnCount; column++) {
    const power = fftPower(downsampled, (column + 0.5) * downsampled.length / columnCount);
    const logPower = new Float64Array(SPECTROGRAM_BINS);
    for (let bin = 0; bin < power.length; bin++) averagePower[bin] += power[bin] / columnCount;
    for (let row = 0; row < SPECTROGRAM_BINS; row++) {
      const lowHz = spectrogramBinHz(row - 0.5, sampleRate);
      const highHz = spectrogramBinHz(row + 0.5, sampleRate);
      const lowBin = Math.max(1, Math.min(power.length - 1, Math.round(lowHz * SPECTRUM_FFT_SIZE / spectrumRate)));
      const highBin = Math.max(lowBin, Math.min(power.length - 1, Math.round(highHz * SPECTRUM_FFT_SIZE / spectrumRate)));
      for (let bin = lowBin; bin <= highBin; bin++) logPower[row] = Math.max(logPower[row], power[bin]);
      spectralPeak = Math.max(spectralPeak, logPower[row]);
    }
    spectralColumns.push(logPower);
    if (column % 20 === 0) { onProgress?.(0.76 + 0.22 * column / columnCount); await yieldToBrowser(); }
  }
  const spectrumPeak = Math.max(...averagePower);
  const spectrum = Array.from(averagePower, value => decibels(value, spectrumPeak));
  const spectrogram = spectralColumns.map(column => Array.from(column, value => decibels(value, spectralPeak)));
  const frequencies = frames.map(frame => frame.frequency).sort((a, b) => a - b);
  const medianHz = frequencies.length ? percentile(frequencies, 0.5) : null;
  const lowHz = frequencies.length ? percentile(frequencies, 0.05) : null;
  const highHz = frequencies.length ? percentile(frequencies, 0.95) : null;
  const rangeSemitones = lowHz && highHz ? 12 * Math.log2(highHz / lowHz) : null;
  // Include window edges in coverage; one reliable isolated window still cannot
  // qualify a short sample for a suggested exercise.
  const secondsPerFrame = duration / windowCount;
  const voicedSeconds = frames.length * secondsPerFrame;
  const voicedRatio = voicedSeconds / duration;
  const noteCounts = new Map<number, number>();
  for (const frame of frames) {
    const midi = Math.round(frame.midi);
    noteCounts.set(midi, (noteCounts.get(midi) ?? 0) + 1);
  }
  const notes: NoteBin[] = [];
  if (noteCounts.size && lowHz !== null && highHz !== null) {
    // Sparse extreme estimates must not turn the palette into a long series of
    // empty bins. Keep the same robust interval as the range metric, enclosing
    // it with whole semitones. Do not renormalize or alter the retained frames.
    const first = Math.floor(hzToMidi(lowHz));
    const last = Math.ceil(hzToMidi(highHz));
    for (let midi = first; midi <= last; midi++) {
      const count = noteCounts.get(midi) ?? 0;
      notes.push({ midi, label: noteName(midi), frequency: midiToHz(midi), seconds: count * secondsPerFrame, percent: count / frames.length * 100 });
    }
  }
  const quality = voicedSeconds < 0.6 || frames.length < 6 || voicedRatio < 0.08
    ? 'insufficient' : voicedSeconds < 5 || voicedRatio < 0.2 || clippingRatio >= 0.01 ? 'limited' : 'good';
  let suggestedMidi: number | null = null;
  if (quality === 'good' && lowHz && highHz && medianHz) {
    const lowMidi = Math.round(hzToMidi(lowHz));
    const highMidi = Math.round(hzToMidi(highHz));
    const expectedShare = 100 / Math.max(1, highMidi - lowMidi + 1);
    const candidates = notes.filter(note => note.midi > lowMidi && note.midi < highMidi && note.percent < expectedShare * 0.6);
    candidates.sort((a, b) => a.percent - b.percent || Math.abs(a.midi - hzToMidi(medianHz)) - Math.abs(b.midi - hzToMidi(medianHz)));
    suggestedMidi = candidates[0]?.midi ?? null;
  }
  onProgress?.(1);
  return { duration, voicedSeconds, voicedRatio, medianHz, lowHz, highHz, rangeSemitones, notes, frames, spectrum, spectrogram, sampleRate, clippingRatio, rms, quality, suggestedMidi };
}

/** Reproducible synthesized harmonic phrases — an example signal, not a person. */
export function generateDemoAudio(): { samples: Float32Array; sampleRate: number } {
  const sampleRate = 16000;
  const duration = 24;
  const samples = new Float32Array(sampleRate * duration);
  const melody = [48, 50, 52, 55, 52, 50, 48, 52, 55, 57, 55, 52, 50, 48, 55, 52, 57, 55, 50, 52];
  let phase = 0;
  let seed = 7143;
  for (let i = 0; i < samples.length; i++) {
    const time = i / sampleRate;
    const phraseTime = time % 4.8;
    if (phraseTime > 4.25 || time < 0.25 || time > duration - 0.4) continue;
    const syllable = Math.floor(time / 0.48);
    const within = (time % 0.48) / 0.48;
    const envelope = Math.min(1, within / 0.09, (1 - within) / 0.15) * (0.75 + 0.15 * Math.sin(time * 1.7));
    const midi = melody[syllable % melody.length] + 0.08 * Math.sin(2 * Math.PI * 4.3 * time) - 0.12 * within;
    phase += 2 * Math.PI * midiToHz(midi) / sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 4294967296 - 0.5) * 0.007;
    const harmonic = Math.sin(phase) * 0.52 + Math.sin(phase * 2) * 0.27 + Math.sin(phase * 3) * 0.13 + Math.sin(phase * 4) * 0.07 + Math.sin(phase * 6) * 0.035;
    samples[i] = envelope * (harmonic * 0.45 + noise);
  }
  return { samples, sampleRate };
}
