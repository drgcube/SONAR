import { describe, expect, it } from 'vitest';
import { analyzeAudio, detectPitch, generateDemoAudio, hzToMidi, midiToHz, noteName, spectrogramBinHz, spectrumBinHz } from './analysis';

function tone(frequency: number, seconds = 0.25, sampleRate = 16000, amplitude = 0.4): Float32Array {
  return Float32Array.from({ length: seconds * sampleRate }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate));
}
function concatenate(parts: Float32Array[]): Float32Array {
  const output = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function noise(length: number): Float32Array {
  let seed = 127;
  return Float32Array.from({ length }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 4294967296 - 0.5) * 0.6; });
}

describe('fundamental pitch detection', () => {
  it.each([60, 65, 110, 220, 440, 880, 1000])('recovers %i Hz across the supported range', frequency => {
    const estimate = detectPitch(tone(frequency), 16000);
    expect(estimate).not.toBeNull();
    expect(Math.abs(12 * Math.log2(estimate!.frequency / frequency))).toBeLessThan(0.06);
    expect(estimate!.confidence).toBeGreaterThan(0.9);
  });
  it('detects the fundamental when upper harmonics are stronger', () => {
    const samples = Float32Array.from({ length: 8192 }, (_, i) => {
      const phase = 2 * Math.PI * 146.83 * i / 48000;
      return 0.03 * Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);
    });
    expect(detectPitch(samples, 48000)?.frequency).toBeCloseTo(146.83, 0);
  });
  it('rejects silence, DC offset, low-level input, and unpitched noise', () => {
    expect(detectPitch(new Float32Array(4096), 16000)).toBeNull();
    expect(detectPitch(new Float32Array(4096).fill(0.2), 16000)).toBeNull();
    expect(detectPitch(tone(220, 0.25, 16000, 0.0001), 16000)).toBeNull();
    expect(detectPitch(noise(4096), 16000)).toBeNull();
  });
});

describe('recording analysis', () => {
  it.each([2, 3])('tracks a changing harmonic pitch contour at %i cycles per second', async modulationHz => {
    const sampleRate = 16000;
    const expectedHz = (time: number) => 150 + 35 * Math.sin(2 * Math.PI * modulationHz * time);
    let phase = 0;
    const samples = Float32Array.from({ length: sampleRate * 4 }, (_, i) => {
      phase += 2 * Math.PI * expectedHz(i / sampleRate) / sampleRate;
      return 0.1 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase) + 0.1 * Math.sin(4 * phase);
    });
    const result = await analyzeAudio(samples, sampleRate);
    expect(result.quality).toBe('limited');
    expect(result.voicedRatio).toBeGreaterThan(modulationHz === 2 ? 0.95 : 0.65);
    const errors = result.frames.map(frame => Math.abs(12 * Math.log2(frame.frequency / expectedHz(frame.time))));
    expect(Math.max(...errors)).toBeLessThan(0.5);
    if (modulationHz === 2) expect(Math.abs(result.medianHz! - 150)).toBeLessThan(2);
    expect(result.frames.every(frame => frame.confidence >= 0.84)).toBe(true);
  });
  it.each([4000, 16000, 48000])('retains both pitch endpoints with short windows at %i Hz sample rate', async sampleRate => {
    for (const frequency of [60, 1000]) {
      const result = await analyzeAudio(tone(frequency, 1, sampleRate), sampleRate);
      expect(result.voicedRatio).toBeGreaterThan(0.95);
      expect(Math.abs(12 * Math.log2(result.medianHz! / frequency))).toBeLessThan(0.06);
    }
  });
  it('rejects sustained unpitched noise and DC with the speech analysis windows', async () => {
    for (const samples of [noise(32000), new Float32Array(32000).fill(0.2)]) {
      const result = await analyzeAudio(samples, 16000);
      expect(result.frames).toEqual([]);
      expect(result.quality).toBe('insufficient');
      expect(result.suggestedMidi).toBeNull();
    }
  });
  it('keeps harmonic spectrum separate from fundamental pitch use', async () => {
    const sampleRate = 48000;
    const samples = Float32Array.from({ length: sampleRate * 2 }, (_, i) => {
      const phase = 2 * Math.PI * 220 * i / sampleRate;
      return 0.08 * Math.sin(phase) + 0.45 * Math.sin(2 * phase) + 0.18 * Math.sin(3 * phase);
    });
    const result = await analyzeAudio(samples, sampleRate);
    const spectralPeak = result.spectrum.indexOf(Math.max(...result.spectrum));
    expect(spectrumBinHz(spectralPeak, sampleRate)).toBeCloseTo(437.5, 0);
    expect(result.medianHz).toBeCloseTo(220, 0);
    expect(result.notes.find(note => note.midi === 57)?.percent).toBeGreaterThan(98);
    expect(result.suggestedMidi).toBeNull();
    expect(result.spectrogram[0]).toHaveLength(128);
    expect(spectrogramBinHz(0, sampleRate)).toBe(60);
    expect(spectrogramBinHz(127, sampleRate)).toBeCloseTo(8000, 8);
  });
  it('reports silent recordings without a fabricated pitch or practice target', async () => {
    const result = await analyzeAudio(new Float32Array(32000), 16000);
    expect(result.quality).toBe('insufficient');
    expect(result.voicedSeconds).toBe(0);
    expect(result.notes).toEqual([]);
    expect(result.frames).toEqual([]);
    expect(result.medianHz).toBeNull();
    expect(result.suggestedMidi).toBeNull();
    expect(result.spectrum.every(value => value === -80)).toBe(true);
  });
  it('suggests only an interior underused note after sufficient voiced audio', async () => {
    const samples = concatenate([tone(midiToHz(48), 2), tone(midiToHz(50), 2), tone(midiToHz(52), 2), tone(midiToHz(55), 2)]);
    const result = await analyzeAudio(samples, 16000);
    expect(result.quality).toBe('good');
    expect(result.suggestedMidi).not.toBeNull();
    expect(result.suggestedMidi!).toBeGreaterThan(48);
    expect(result.suggestedMidi!).toBeLessThan(55);
    expect(result.notes.find(note => note.midi === result.suggestedMidi)?.percent).toBeLessThan(2);
    expect(result.notes.reduce((sum, note) => sum + note.percent, 0)).toBeCloseTo(100, 5);
    expect(result.notes.reduce((sum, note) => sum + note.seconds, 0)).toBeCloseTo(result.voicedSeconds, 5);
    const short = await analyzeAudio(samples.subarray(0, 32000), 16000);
    expect(short.suggestedMidi).toBeNull();
  });
  it('uses pitch percentiles to keep a short outlier out of the observed range', async () => {
    const result = await analyzeAudio(concatenate([tone(160, 4), tone(640, 0.12), tone(160, 4)]), 16000);
    expect(result.medianHz).toBeCloseTo(160, 0);
    expect(result.rangeSemitones).toBeLessThan(0.1);
  });
  it('bounds the note map by the robust interval while preserving omitted voiced time', async () => {
    const result = await analyzeAudio(concatenate([tone(110, 0.24), tone(220, 4), tone(880, 0.24), tone(220, 4)]), 16000);
    expect(result.frames.some(frame => frame.frequency < 120)).toBe(true);
    expect(result.frames.some(frame => frame.frequency > 850)).toBe(true);
    const first = Math.floor(hzToMidi(result.lowHz!));
    const last = Math.ceil(hzToMidi(result.highHz!));
    expect(result.notes[0].midi).toBe(first);
    expect(result.notes.at(-1)!.midi).toBe(last);
    expect(result.notes.length).toBeLessThanOrEqual(3);
    const shownFrameCount = result.frames.filter(frame => Math.round(frame.midi) >= first && Math.round(frame.midi) <= last).length;
    const shownPercent = result.notes.reduce((sum, note) => sum + note.percent, 0);
    const shownSeconds = result.notes.reduce((sum, note) => sum + note.seconds, 0);
    expect(shownPercent).toBeCloseTo(100 * shownFrameCount / result.frames.length, 6);
    expect(shownSeconds).toBeCloseTo(result.voicedSeconds * shownFrameCount / result.frames.length, 6);
    expect(shownPercent).toBeGreaterThan(90);
    expect(shownPercent).toBeLessThan(99);
  });
  it('counts quiet pauses as unvoiced and flags substantial clipping', async () => {
    const paused = await analyzeAudio(concatenate([tone(220, 2), new Float32Array(32000)]), 16000);
    expect(paused.voicedRatio).toBeGreaterThan(0.45);
    expect(paused.voicedRatio).toBeLessThan(0.55);
    const clipped = tone(220, 6, 16000, 1.4).map(value => Math.max(-1, Math.min(1, value)));
    const result = await analyzeAudio(clipped, 16000);
    expect(result.clippingRatio).toBeGreaterThan(0.1);
    expect(result.quality).toBe('limited');
    expect(result.suggestedMidi).toBeNull();
  });
  it('analyzes the synthesized example through the real pipeline with bounded output', async () => {
    const { samples, sampleRate } = generateDemoAudio();
    const progress: number[] = [];
    const result = await analyzeAudio(samples, sampleRate, value => progress.push(value));
    expect(result.duration).toBe(24);
    expect(result.quality).toBe('good');
    expect(result.spectrum).toHaveLength(1024);
    expect(result.spectrogram).toHaveLength(180);
    expect(result.voicedSeconds).toBeGreaterThan(15);
    expect(result.notes.length).toBeLessThanOrEqual(12);
    expect(result.suggestedMidi).not.toBeNull();
    expect(result.spectrum.every(value => Number.isFinite(value) && value >= -80 && value <= 0)).toBe(true);
    expect(result.spectrogram.flat().every(value => Number.isFinite(value) && value >= -80 && value <= 0)).toBe(true);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
  });
  it('rejects invalid input cleanly', async () => {
    await expect(analyzeAudio(new Float32Array(), 16000)).rejects.toThrow('no audio');
    await expect(analyzeAudio(new Float32Array([NaN]), 16000)).rejects.toThrow('invalid');
    await expect(analyzeAudio(tone(220), 0)).rejects.toThrow('sample rate');
  });
});

it('converts concert pitch and chromatic labels consistently', () => {
  expect(midiToHz(69)).toBe(440);
  expect(hzToMidi(440)).toBe(69);
  expect(noteName(60)).toBe('C4');
  expect(noteName(61)).toBe('C♯4');
});
