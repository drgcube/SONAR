/** A display palette, not a physical equivalence between sound and visible light. */
export const COLOR_MIN_HZ = 60;
export const COLOR_MAX_HZ = 8000;

type RGB = [number, number, number];
const STOPS: RGB[] = [
  [242, 103, 94], // red
  [249, 161, 88], // orange
  [235, 207, 99], // yellow
  [132, 207, 148], // green
  [93, 211, 219], // cyan
  [114, 160, 246], // blue
  [193, 134, 236], // violet
];
const DARK: RGB = [27, 33, 30];
const WHITE: RGB = [252, 253, 254];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const mix = (a: RGB, b: RGB, amount: number): RGB => a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount)) as RGB;

/** The same absolute frequency has the same hue in every view and recording. */
export function frequencyRgb(frequency: number): RGB {
  const safeFrequency = Number.isFinite(frequency) ? clamp(frequency, COLOR_MIN_HZ, COLOR_MAX_HZ) : COLOR_MIN_HZ;
  const position = Math.log(safeFrequency / COLOR_MIN_HZ) / Math.log(COLOR_MAX_HZ / COLOR_MIN_HZ) * (STOPS.length - 1);
  const lower = Math.floor(position);
  return mix(STOPS[lower], STOPS[Math.min(lower + 1, STOPS.length - 1)], position - lower);
}

export function frequencyColor(frequency: number, alpha = 1): string {
  return `rgba(${frequencyRgb(frequency).join(',')},${clamp(alpha, 0, 1)})`;
}

/**
 * Spectrogram dB uses one peak reference for the entire recording.
 * -80 dB is the dark floor; -16 dB reaches the frequency hue. Only the
 * strongest energy approaches white, so quiet rows keep a dark background.
 */
export function spectrogramRgb(frequency: number, relativeDb: number): RGB {
  const intensity = Number.isFinite(relativeDb) ? clamp((relativeDb + 80) / 80, 0, 1) : 0;
  const color = frequencyRgb(frequency);
  if (intensity <= 0.8) return mix(DARK, color, (intensity / 0.8) ** 1.2);
  return mix(color, WHITE, ((intensity - 0.8) / 0.2) ** 1.6);
}

export const FREQUENCY_GRADIENT = `linear-gradient(90deg, ${STOPS.map((color, index) => `rgb(${color.join(',')}) ${index / (STOPS.length - 1) * 100}%`).join(', ')})`;
