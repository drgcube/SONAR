import { describe, expect, it } from 'vitest';
import { frequencyRgb, spectrogramRgb } from './spectrumColors';

describe('frequency and energy display colors', () => {
  it('keeps low-to-high frequency colors fixed on a logarithmic range', () => {
    const red = frequencyRgb(60);
    const green = frequencyRgb(Math.sqrt(60 * 8000));
    const violet = frequencyRgb(8000);
    expect(red[0]).toBeGreaterThan(red[1]);
    expect(red[0]).toBeGreaterThan(red[2]);
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(green[1]).toBeGreaterThan(green[2]);
    expect(violet[0]).toBeGreaterThan(violet[1]);
    expect(violet[2]).toBeGreaterThan(violet[1]);
    expect(frequencyRgb(0)).toEqual(red);
    expect(frequencyRgb(20000)).toEqual(violet);
  });

  it('does not color silence as energy and reserves white for the strongest bins', () => {
    for (const hz of [60, 250, 1000, 8000]) {
      const dark = spectrogramRgb(hz, -80);
      const hue = spectrogramRgb(hz, -16);
      const white = spectrogramRgb(hz, 0);
      expect(dark).toEqual([27, 33, 30]);
      expect(hue).toEqual(frequencyRgb(hz));
      expect(white).toEqual([252, 253, 254]);
      expect(spectrogramRgb(hz, -40).every((channel, index) => channel > dark[index] && channel < hue[index])).toBe(true);
      expect(spectrogramRgb(hz, -8).every((channel, index) => channel >= hue[index] && channel <= white[index])).toBe(true);
      expect(spectrogramRgb(hz, -120)).toEqual(dark);
      expect(spectrogramRgb(hz, NaN)).toEqual(dark);
      expect(spectrogramRgb(hz, 12)).toEqual(white);
    }
  });
});
