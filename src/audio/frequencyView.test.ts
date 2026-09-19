import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from './analysis';
import { frequencyBands } from './frequencyView';

function recording(frequencies: number[], overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    duration: 10,
    voicedSeconds: 8,
    voicedRatio: 0.8,
    lowHz: 100,
    highHz: 200,
    medianHz: 150,
    rangeSemitones: 12,
    notes: [],
    // Deliberately misleading MIDI values prove the frequency view uses raw Hz.
    frames: frequencies.map((frequency, index) => ({ time: index * 0.04, frequency, midi: 69, confidence: 0.99 })),
    spectrum: [],
    spectrogram: [],
    sampleRate: 16000,
    clippingRatio: 0,
    rms: 0.1,
    quality: 'good',
    suggestedMidi: null,
    ...overrides,
  };
}

describe('continuous frequency bands', () => {
  it('keeps an arbitrary flat frequency exactly, without musical quantization or an invented range', () => {
    const result = recording([123.4, 123.4, 123.4], { lowHz: 123.4, highHz: 123.4, medianHz: 123.4 });
    expect(frequencyBands(result)).toEqual([
      { lowHz: 123.4, highHz: 123.4, centerHz: 123.4, seconds: 8, percent: 100 },
    ]);
  });

  it('uses equal-Hz intervals and assigns internal edges to the right, with the last edge inclusive', () => {
    const result = recording([100, 123.4, 124.99, 125, 150, 175, 200]);
    const bands = frequencyBands(result, 4);
    expect(bands.map(({ lowHz, highHz, centerHz }) => [lowHz, highHz, centerHz])).toEqual([
      [100, 125, 112.5], [125, 150, 137.5], [150, 175, 162.5], [175, 200, 187.5],
    ]);
    [3, 1, 1, 2].forEach((count, index) => {
      expect(bands[index].percent).toBeCloseTo(count / 7 * 100, 10);
      expect(bands[index].seconds).toBeCloseTo(count / 7 * 8, 10);
    });
    expect(result.frames[1].frequency).toBe(123.4);
  });

  it('retains outliers in the denominator without widening the observed central range', () => {
    const result = recording([60, 100, 110, 120, 130, 140, 150, 175, 200, 900]);
    const bands = frequencyBands(result, 4);
    expect(bands[0].lowHz).toBe(100);
    expect(bands.at(-1)!.highHz).toBe(200);
    expect(bands.reduce((total, band) => total + band.percent, 0)).toBeCloseTo(80, 10);
    expect(bands.reduce((total, band) => total + band.seconds, 0)).toBeCloseTo(6.4, 10);
  });

  it('collapses a narrow range while counting only frequencies inside the original interval', () => {
    const result = recording([123.39, 123.4, 123.42, 123.45, 123.46], {
      lowHz: 123.4, highHz: 123.45, medianHz: 123.42,
    });
    expect(frequencyBands(result)).toEqual([
      { lowHz: 123.4, highHz: 123.45, centerHz: 123.42, seconds: 4.8, percent: 60 },
    ]);
  });

  it('keeps the representative pitch within a narrow range if median data is invalid', () => {
    expect(frequencyBands(recording([123.4], { lowHz: 123.4, highHz: 123.4, medianHz: 500 }))[0].centerHz).toBe(123.4);
    expect(frequencyBands(recording([123.4], { lowHz: 123.4, highHz: 123.4, medianHz: null }))[0].centerHz).toBe(123.4);
  });

  it('handles missing data and invalid bounds without fabricating bands', () => {
    expect(frequencyBands(null)).toEqual([]);
    expect(frequencyBands(undefined)).toEqual([]);
    expect(frequencyBands(recording([]))).toEqual([]);
    for (const overrides of [
      { lowHz: null }, { highHz: null }, { lowHz: NaN }, { highHz: Infinity },
      { lowHz: 0 }, { lowHz: -100 }, { lowHz: 201 }, { voicedSeconds: NaN }, { voicedSeconds: -1 },
    ]) expect(frequencyBands(recording([150], overrides))).toEqual([]);
    for (const count of [0, -1, 1.5, NaN, Infinity]) expect(frequencyBands(recording([150]), count)).toEqual([]);
  });

  it('ignores invalid frame frequencies without redistributing their duration', () => {
    const bands = frequencyBands(recording([100, NaN, Infinity, 200]), 2);
    expect(bands.map(band => band.percent)).toEqual([25, 25]);
    expect(bands.map(band => band.seconds)).toEqual([2, 2]);
  });
});
