import type { CSSProperties } from 'react';
import { Mic, MicOff } from 'lucide-react';
import './InputMonitor.css';

export type InputMonitorProps = {
  active: boolean;
  checking: boolean;
  inputState: 'idle' | 'quiet' | 'receiving' | 'clipping' | 'muted' | 'interrupted';
  level: number;
  peak: number;
  history: number[];
  elapsed: number;
  deviceLabel: string;
};

const statuses: Record<InputMonitorProps['inputState'], string> = {
  idle: 'See your sound here',
  quiet: 'Very quiet input',
  receiving: 'Sound is coming through',
  clipping: 'Input is too loud',
  muted: 'Microphone is muted',
  interrupted: 'Audio paused',
};

const safeLevel = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const decibels = (value: number) => value > 0 ? 20 * Math.log10(value) : -Infinity;
const strength = (value: number) => Math.max(0, Math.min(1, (decibels(safeLevel(value)) + 65) / 53));
const formatDb = (value: number) => value < -80 ? '<−80' : String(Math.round(value)).replace('-', '−');

export default function InputMonitor({
  active, checking, inputState, level, peak, history, elapsed, deviceLabel,
}: InputMonitorProps) {
  const listening = active || checking;
  const unavailable = inputState === 'muted' || inputState === 'interrupted';
  const measuredLevel = listening && !unavailable ? safeLevel(level) : 0;
  const power = strength(measuredLevel);
  const clipping = listening && !unavailable && (inputState === 'clipping' || safeLevel(peak) >= 0.98);
  const recent = listening && !unavailable ? history.slice(-40) : [];
  const bars = [...Array<number>(40 - recent.length).fill(0), ...recent];
  const captured = Math.floor(Math.max(0, Number.isFinite(elapsed) ? elapsed : 0));
  const duration = `${Math.floor(captured / 60)}:${String(captured % 60).padStart(2, '0')}`;
  const status = statuses[listening ? inputState : 'idle'];
  const orbStyle = {
    '--input-power': power,
    '--input-halo': `${power * 7}px`,
    '--input-halo-alpha': power * 0.11,
  } as CSSProperties;

  return (
    <div className={`input-monitor${listening ? ' is-listening' : ''}${clipping ? ' is-clipping' : ''}`}>
      <div className="input-monitor-heading">
        <span className="input-monitor-mode">
          {active && <i aria-hidden="true" />}
          {active ? 'REC' : checking ? 'MIC CHECK' : 'INPUT MONITOR'}
        </span>
        {active && <span className="input-monitor-time">{duration} <span>captured</span></span>}
        {!active && <span className="input-monitor-caption">Live sound level</span>}
      </div>

      <div className="input-monitor-signal">
        <div className="input-monitor-orb" style={orbStyle} aria-hidden="true">
          {inputState === 'muted' && listening ? <MicOff size={20} strokeWidth={1.6} /> : <Mic size={20} strokeWidth={1.6} />}
        </div>
        <svg
          className="input-monitor-wave"
          viewBox="0 0 280 48"
          preserveAspectRatio="none"
          role="img"
          aria-label={listening
            ? 'Recent microphone sound levels. Taller bars mean louder sound; these do not measure pitch.'
            : 'Microphone sound level monitor. Start a microphone check or recording to see incoming sound.'}
        >
          {bars.map((value, index) => {
            const amount = strength(value);
            const height = 3 + amount * 41;
            return <rect key={index} x={index * 7 + 1.5} y={(48 - height) / 2} width={3.5} height={height} rx={1.75} opacity={0.3 + amount * 0.7} />;
          })}
        </svg>
        <span className="input-monitor-db" title={listening ? `Peak: ${formatDb(decibels(safeLevel(peak)))} dBFS` : 'Decibels relative to full scale'}>
          {listening ? formatDb(decibels(measuredLevel)) : '—'}<small>dBFS</small>
        </span>
      </div>

      <p className="input-monitor-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      <p className="input-monitor-device" title={deviceLabel || 'Choose a microphone to check your input'}>
        {deviceLabel || 'Choose a microphone to check your input'}
      </p>
    </div>
  );
}
