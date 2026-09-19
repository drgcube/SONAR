import { useEffect, useRef, useState } from 'react';
import type { AnalysisResult } from '../audio/analysis';
import { spectrogramBinHz } from '../audio/analysis';
import { COLOR_MAX_HZ, COLOR_MIN_HZ, FREQUENCY_GRADIENT, frequencyColor, spectrogramRgb } from '../audio/spectrumColors';

export type ChartMode = 'spectrum' | 'spectrogram' | 'pitch';

type VoiceChartProps = {
  result: AnalysisResult | null;
  mode: ChartMode;
  liveSpectrum: Float32Array | null;
  recording: boolean;
  sampleRate?: number;
  musicalScale?: boolean;
};

type Plot = { left: number; top: number; width: number; height: number };

const INK = '#232724';
const LABEL = '#9ca49b';
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const frequencyLabel = (frequency: number) => frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
const midiLabel = (midi: number) => {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
};

function labelStyle(ctx: CanvasRenderingContext2D) {
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = LABEL;
  ctx.textBaseline = 'middle';
}

function horizontalRule(ctx: CanvasRenderingContext2D, plot: Plot, y: number) {
  ctx.strokeStyle = 'rgba(193, 202, 187, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.left, y + 0.5);
  ctx.lineTo(plot.left + plot.width, y + 0.5);
  ctx.stroke();
}

function drawIllustration(ctx: CanvasRenderingContext2D, width: number) {
  const centerY = 77;
  const margin = Math.max(5, width * 0.03);
  const bandWidth = width - margin * 2;
  for (let x = margin; x < width - margin; x += 4) {
    const t = (x - margin) / bandWidth;
    const edge = Math.sin(Math.PI * t) ** 0.9;
    const swell = 0.34 + 0.44 * Math.exp(-(((t - 0.36) / 0.14) ** 2))
      + 0.27 * Math.exp(-(((t - 0.61) / 0.10) ** 2));
    const texture = 0.57 + 0.24 * Math.sin(t * 174) ** 2 + 0.19 * Math.cos(t * 63) ** 2;
    const height = 7 + edge * swell * texture * 114;
    ctx.fillStyle = frequencyColor(COLOR_MIN_HZ * (COLOR_MAX_HZ / COLOR_MIN_HZ) ** t, 0.28 + edge * 0.62);
    ctx.fillRect(x, centerY - height / 2, 1.5, height);
  }
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  plot: Plot,
  spectrum: ArrayLike<number>,
  sampleRate: number,
  live: boolean,
) {
  const low = 60;
  const high = Math.min(8000, sampleRate / 2);
  const floor = live ? -100 : -80;
  const frequencyX = (frequency: number) => plot.left + Math.log(frequency / low) / Math.log(high / low) * plot.width;
  const dbY = (db: number) => plot.top + (clamp(db, floor, 0) / floor) * plot.height;
  const dbTicks = live ? [0, -25, -50, -75, -100] : [0, -20, -40, -60, -80];
  labelStyle(ctx);
  ctx.textAlign = 'right';
  for (const db of dbTicks) {
    const y = dbY(db);
    horizontalRule(ctx, plot, y);
    ctx.fillText(String(db), plot.left - 9, y);
  }
  const ticks = plot.width < 370 ? [60, 250, 1000, 4000, 8000] : [60, 125, 250, 500, 1000, 2000, 4000, 8000];
  ctx.textAlign = 'center';
  for (const frequency of ticks.filter((frequency) => frequency <= high)) {
    const x = frequencyX(frequency);
    ctx.textAlign = frequency === low ? 'left' : frequency === high ? 'right' : 'center';
    ctx.fillText(frequencyLabel(frequency), x, plot.top + plot.height + 20);
  }

  const binHz = sampleRate / (spectrum.length * 2);
  const positions: [number, number][] = [];
  for (let pixel = 0; pixel <= Math.ceil(plot.width); pixel++) {
    const frequency = low * (high / low) ** (pixel / plot.width);
    const bin = frequency / binHz;
    const lower = clamp(Math.floor(bin), 0, spectrum.length - 1);
    const upper = Math.min(spectrum.length - 1, lower + 1);
    const lowerDb = Number.isFinite(spectrum[lower]) ? spectrum[lower] : floor;
    const upperDb = Number.isFinite(spectrum[upper]) ? spectrum[upper] : floor;
    const db = lowerDb + (upperDb - lowerDb) * (bin - Math.floor(bin));
    positions.push([plot.left + pixel, dbY(db)]);
  }
  if (!positions.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  const fill = ctx.createLinearGradient(plot.left, 0, plot.left + plot.width, 0);
  const stroke = ctx.createLinearGradient(plot.left, 0, plot.left + plot.width, 0);
  for (let index = 0; index <= 48; index++) {
    const offset = index / 48;
    const frequency = low * (high / low) ** offset;
    fill.addColorStop(offset, frequencyColor(frequency, 0.15));
    stroke.addColorStop(offset, frequencyColor(frequency));
  }
  ctx.beginPath();
  ctx.moveTo(positions[0][0], plot.top + plot.height);
  positions.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(positions[positions.length - 1][0], plot.top + plot.height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  positions.forEach(([x, y], index) => index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

function drawTimeLabels(ctx: CanvasRenderingContext2D, plot: Plot, duration: number) {
  labelStyle(ctx);
  const steps = plot.width < 320 ? 3 : 4;
  for (let index = 0; index <= steps; index++) {
    ctx.textAlign = index === 0 ? 'left' : index === steps ? 'right' : 'center';
    const seconds = duration * index / steps;
    ctx.fillText(`${seconds < 10 && duration < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`, plot.left + plot.width * index / steps, plot.top + plot.height + 20);
  }
}

function drawSpectrogram(ctx: CanvasRenderingContext2D, plot: Plot, result: AnalysisResult) {
  const columns = result.spectrogram;
  if (!columns.length || !columns[0].length) return;
  const rows = columns[0].length;
  const source = document.createElement('canvas');
  source.width = columns.length;
  source.height = rows;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) return;
  const pixels = sourceContext.createImageData(columns.length, rows);
  columns.forEach((column, x) => column.forEach((value, y) => {
    const offset = ((rows - 1 - y) * columns.length + x) * 4;
    const [red, green, blue] = spectrogramRgb(spectrogramBinHz(y, result.sampleRate), value);
    pixels.data[offset] = red;
    pixels.data[offset + 1] = green;
    pixels.data[offset + 2] = blue;
    pixels.data[offset + 3] = 255;
  }));
  sourceContext.putImageData(pixels, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, plot.left, plot.top, plot.width, plot.height);
  const maximumFrequency = Math.min(8000, result.sampleRate / 2);
  labelStyle(ctx);
  ctx.textAlign = 'right';
  for (const frequency of [60, 250, 1000, 4000, 8000].filter((frequency) => frequency <= maximumFrequency)) {
    const y = plot.top + (1 - Math.log(frequency / 60) / Math.log(maximumFrequency / 60)) * plot.height;
    ctx.fillText(frequencyLabel(frequency), plot.left - 9, y);
  }
  drawTimeLabels(ctx, plot, result.duration);
}

function drawPitch(ctx: CanvasRenderingContext2D, plot: Plot, result: AnalysisResult, musicalScale: boolean) {
  if (!result.frames.length) return;
  const midiValues = result.frames.map((frame) => frame.midi);
  const minimum = Math.floor(Math.min(...midiValues)) - 2;
  const maximum = Math.ceil(Math.max(...midiValues)) + 2;
  const midiY = (midi: number) => plot.top + (maximum - midi) / (maximum - minimum) * plot.height;
  const frequencies = result.frames.map((frame) => frame.frequency);
  // This view uses the unrounded estimates. A logarithmic Hz axis preserves
  // relative frequency intervals without imposing musical note bins.
  const lowHz = Math.min(...frequencies) / 1.15;
  const highHz = Math.max(...frequencies) * 1.15;
  const frequencyY = (frequency: number) => plot.top + (1 - Math.log(frequency / lowHz) / Math.log(highHz / lowHz)) * plot.height;
  const frameY = (frame: AnalysisResult['frames'][number]) => musicalScale ? midiY(frame.midi) : frequencyY(frame.frequency);
  labelStyle(ctx);
  ctx.textAlign = 'right';
  if (musicalScale) {
    const step = Math.max(1, Math.ceil((maximum - minimum) / 5));
    for (let midi = Math.ceil(minimum / step) * step; midi <= maximum; midi += step) {
      horizontalRule(ctx, plot, midiY(midi));
      ctx.fillText(midiLabel(midi), plot.left - 9, midiY(midi));
    }
  } else {
    for (let index = 0; index <= 4; index++) {
      const frequency = Math.round(lowHz * (highHz / lowHz) ** (index / 4));
      const y = frequencyY(frequency);
      horizontalRule(ctx, plot, y);
      ctx.fillText(String(frequency), plot.left - 9, y);
    }
  }
  drawTimeLabels(ctx, plot, result.duration);
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  ctx.strokeStyle = 'rgba(245,186,149,0.34)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  result.frames.forEach((frame, index) => {
    const x = plot.left + frame.time / Math.max(result.duration, 0.001) * plot.width;
    const y = frameY(frame);
    const previous = result.frames[index - 1];
    if (!previous || frame.time - previous.time > 0.12 || Math.abs(frame.midi - previous.midi) > 4) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  result.frames.forEach((frame) => {
    const x = plot.left + frame.time / Math.max(result.duration, 0.001) * plot.width;
    const y = frameY(frame);
    ctx.beginPath();
    ctx.arc(x, y, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = frequencyColor(frame.frequency);
    ctx.globalAlpha = 0.5 + clamp(frame.confidence, 0, 1) * 0.5;
    ctx.fill();
  });
  ctx.restore();
}

function ColorLegend({ spectrogram, pitch, musicalScale }: { spectrogram: boolean; pitch: boolean; musicalScale: boolean }) {
  const powerGradient = `linear-gradient(90deg, ${[-80, -60, -40, -16, -8, 0].map((db) => `rgb(${spectrogramRgb(660, db).join(',')}) ${(db + 80) / 80 * 100}%`).join(', ')})`;
  return (
    <div style={{ padding: '0 9px 9px 34px', fontSize: 10, color: '#bbc4b8', lineHeight: 1.5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <span>Hue · frequency</span>
        <span style={{ color: LABEL }}>{pitch && musicalScale ? 'Note labels · continuous pitch' : 'Logarithmic Hz'}</span>
      </div>
      <div aria-hidden="true" style={{ height: 5, borderRadius: 5, background: FREQUENCY_GRADIENT, opacity: 0.9 }} />
      <div style={{ position: 'relative', height: 24, marginTop: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 9 }}>
        {[60, 250, 1000, 8000].map((frequency, index) => (
          <span key={frequency} style={{ position: 'absolute', left: `${Math.log(frequency / 60) / Math.log(8000 / 60) * 100}%`, transform: index === 0 ? undefined : index === 3 ? 'translateX(-100%)' : 'translateX(-50%)', whiteSpace: 'nowrap' }}>{frequency >= 1000 ? `${frequency / 1000} kHz` : `${frequency} Hz`}</span>
        ))}
      </div>
      {spectrogram && (
        <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 5, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ flex: '1 1 120px' }}>Brightness · relative energy</span>
          <div style={{ flex: '1 1 120px', display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', fontSize: 9 }}>
            <span>−80 dB</span>
            <span aria-hidden="true" style={{ flex: 1, minWidth: 30, height: 5, borderRadius: 5, background: powerGradient }} />
            <span>0 dB · white</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VoiceChart({ result, mode, liveSpectrum, recording, sampleRate = 48000, musicalScale = false }: VoiceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 600, height: 242 });
  const live = recording && liveSpectrum !== null;
  const empty = !result && !live;
  const noPitch = !recording && mode === 'pitch' && result !== null && result.frames.length === 0;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    const left = mode === 'pitch' && !live ? 40 : 34;
    const plot = { left, top: 13, width: Math.max(1, size.width - left - 8), height: size.height - 48 };
    if (empty) drawIllustration(context, size.width);
    else if (live && liveSpectrum) drawSpectrum(context, plot, liveSpectrum, sampleRate, true);
    else if (result) {
      if (mode === 'spectrum') drawSpectrum(context, plot, result.spectrum, Math.min(result.sampleRate, 16000), false);
      if (mode === 'spectrogram') drawSpectrogram(context, plot, result);
      if (mode === 'pitch') drawPitch(context, plot, result, musicalScale);
    }
  }, [size, result, mode, liveSpectrum, live, empty, sampleRate, musicalScale]);

  const accessibleSummary = empty
    ? 'Illustrative sound pattern. No voice has been analyzed. Record or upload audio to see your voice.'
    : live
      ? 'Live frequency spectrum of microphone audio, on a logarithmic frequency axis. Hue follows frequency from red at 60 hertz to violet at 8000 hertz. The vertical axis shows decibels relative to full scale.'
      : mode === 'spectrum'
        ? 'Average frequency spectrum of this recording. The horizontal axis is logarithmic frequency; the vertical axis is decibels relative to the strongest frequency bin. Hue follows frequency from red at 60 hertz to violet at 8000 hertz. This includes harmonics, not only vocal pitch.'
        : mode === 'spectrogram'
          ? 'Spectrogram of this recording. Time runs left to right and logarithmic frequency rises from bottom to top. Hue follows frequency from red at 60 hertz to violet at 8000 hertz. Brightness indicates relative energy: dark at minus 80 decibels, colored for moderate energy, and near white at the recording’s strongest energy, zero decibels.'
          : noPitch
            ? 'No reliable voiced pitch frames were found in this recording.'
            : `Speaking pitch over ${result?.duration.toFixed(1)} seconds. ${musicalScale ? 'The vertical axis has musical note labels; estimates are not snapped to notes.' : 'The vertical axis shows raw frequency in hertz on a logarithmic axis, without musical note bins.'} Each point is a voiced pitch estimate; gaps indicate unvoiced or uncertain audio. Hue follows frequency. ${result?.frames.length} pitch estimates shown.`;

  return (
    <div className="voice-chart" style={{ width: '100%', minWidth: 0, color: '#edeadf' }}>
      <div ref={containerRef} style={{ position: 'relative', width: '100%', height: 242 }}>
        <canvas ref={canvasRef} role="img" aria-label={accessibleSummary} style={{ display: 'block', width: '100%', height: '100%' }} />
        {empty && (
          <div style={{ position: 'absolute', top: 153, left: 0, right: 0, textAlign: 'center', pointerEvents: 'none' }}>
            <p style={{ margin: 0, fontFamily: '"Instrument Serif", Georgia, serif', fontSize: 'clamp(23px, 4vw, 29px)', lineHeight: 1.2 }}>Your voice will appear here</p>
            <p style={{ margin: '9px 0 0', fontSize: 12, lineHeight: 1.5, color: '#aeb5aa' }}>Record a moment. Discover its shape.</p>
          </div>
        )}
        {noPitch && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center', padding: 20 }}>
            <p style={{ margin: 0, fontFamily: '"Instrument Serif", Georgia, serif', fontSize: 25 }}>A little more voice, please.</p>
            <p style={{ margin: '10px 0 0', color: LABEL, fontSize: 12, maxWidth: 290, lineHeight: 1.6 }}>We couldn’t find a steady pitch in this sample. Try speaking clearly in a quieter space.</p>
          </div>
        )}
        {live && mode !== 'spectrum' && (
          <span style={{ position: 'absolute', top: 0, right: 0, padding: '4px 7px', background: INK, color: '#bbc1b5', fontSize: 10 }}>Live spectrum · full views after recording</span>
        )}
      </div>
      <ColorLegend spectrogram={!live && mode === 'spectrogram'} pitch={!live && mode === 'pitch'} musicalScale={musicalScale} />
    </div>
  );
}
