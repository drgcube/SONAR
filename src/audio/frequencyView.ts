import type { AnalysisResult } from './analysis';

export type FrequencyBand = {
  lowHz: number;
  highHz: number;
  centerHz: number;
  seconds: number;
  percent: number;
};

/**
 * Equal-Hz bands across the observed 5th–95th percentile pitch range. Frequencies
 * remain continuous; musical notes and the frame's MIDI estimate are not used.
 * Outliers stay in the denominator, so visible percentages may total below 100%.
 */
export function frequencyBands(result: AnalysisResult | null | undefined, count = 12): FrequencyBand[] {
  if (!result || !result.frames.length || !Number.isSafeInteger(count) || count < 1) return [];
  const { lowHz, highHz, medianHz, voicedSeconds, frames } = result;
  if (lowHz === null || highHz === null || !Number.isFinite(lowHz) || !Number.isFinite(highHz)
    || lowHz <= 0 || highHz < lowHz || !Number.isFinite(voicedSeconds) || voicedSeconds < 0) return [];

  const span = highHz - lowHz;
  const bandCount = span < 0.1 ? 1 : count;
  const bands = Array.from({ length: bandCount }, (_, index): FrequencyBand => {
    const start = lowHz + span * index / bandCount;
    const end = index === bandCount - 1 ? highHz : lowHz + span * (index + 1) / bandCount;
    return {
      lowHz: start,
      highHz: end,
      centerHz: span < 0.1 && medianHz !== null && Number.isFinite(medianHz)
        ? Math.max(lowHz, Math.min(highHz, medianHz)) : start + (end - start) / 2,
      seconds: 0,
      percent: 0,
    };
  });
  const counts = new Array<number>(bandCount).fill(0);
  for (const { frequency } of frames) {
    if (!Number.isFinite(frequency) || frequency < lowHz || frequency > highHz) continue;
    // Compare actual edges to put boundary values in the band to their right.
    // The final edge is inclusive, including a completely flat observed range.
    const index = bands.findIndex(band => frequency < band.highHz);
    counts[index < 0 ? bandCount - 1 : index]++;
  }
  return bands.map((band, index) => {
    const share = counts[index] / frames.length;
    return { ...band, percent: share * 100, seconds: share * voicedSeconds };
  });
}
