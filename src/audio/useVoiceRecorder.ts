import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_RECORDING_SECONDS = 60;
const MAX_CHECK_SECONDS = 30;
const SIGNAL_HISTORY_LENGTH = 40;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FILE_SECONDS = 120;

// The processor sends small batches and never routes the microphone to speakers.
export const RECORDER_PROCESSOR = `
class SonarRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.checking = options.processorOptions.mode === 'check';
    this.batchSize = Math.max(128, Math.round(sampleRate * 0.07));
    this.buffer = this.checking ? null : new Float32Array(this.batchSize);
    this.limit = sampleRate * (this.checking ? ${MAX_CHECK_SECONDS} : ${MAX_RECORDING_SECONDS});
    this.offset = 0;
    this.total = 0;
    this.energy = 0;
    this.peak = 0;
    this.active = true;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') this.stop();
    };
  }
  flush() {
    if (!this.offset) return;
    const message = { type: 'meter', count: this.offset, rms: Math.sqrt(this.energy / this.offset), peak: this.peak };
    if (this.checking) {
      this.port.postMessage(message);
    } else {
      const samples = this.buffer.slice(0, this.offset);
      this.port.postMessage({ ...message, type: 'chunk', samples }, [samples.buffer]);
    }
    this.offset = 0;
    this.energy = 0;
    this.peak = 0;
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    this.flush();
    this.port.postMessage({ type: 'stopped' });
  }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel++) sample += channels[channel][i];
      sample /= channels.length;
      if (this.buffer) this.buffer[this.offset] = sample;
      this.offset++;
      this.energy += sample * sample;
      this.peak = Math.max(this.peak, Math.abs(sample));
      this.total++;
      if (this.offset === this.batchSize) this.flush();
      if (this.total >= this.limit) {
        this.stop();
        return false;
      }
    }
    return true;
  }
}
registerProcessor('sonar-recorder', SonarRecorder);
`;

interface CaptureSession {
  mode: 'record' | 'check';
  context: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  recorder?: AudioWorkletNode;
  mute?: GainNode;
  chunks: Float32Array[];
  sampleCount: number;
  startedAt: number | null;
  animationFrame: number;
  durationTimer?: number;
  lastSamplesAt: number;
  lastSignalAt: number;
  cancelled: boolean;
  stopped: boolean;
  finalizing: boolean;
  finalization?: Promise<void>;
  flushResolve?: () => void;
}

function audioContextConstructor(): typeof AudioContext {
  const Constructor = window.AudioContext ?? (window as Window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!Constructor) throw new Error('This browser does not support audio analysis. Try a current version of Safari, Chrome, or Firefox.');
  return Constructor;
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Microphone access was not allowed. Enable it in your browser’s site settings, then try again.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No microphone was found. Connect a microphone or import an audio recording.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Your microphone could not start. Check that it is connected and available, then try again.';
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return 'The selected microphone is no longer available. Choose another microphone and try again.';
      case 'SecurityError':
        return 'The browser has blocked microphone access for this page. Open SONAR over HTTPS or on localhost.';
      case 'AbortError':
        return 'Microphone capture was interrupted. Please try again.';
    }
  }
  return error instanceof Error ? error.message : 'The microphone could not start. Please try again or import an audio recording.';
}

async function releaseSession(session: CaptureSession): Promise<void> {
  cancelAnimationFrame(session.animationFrame);
  window.clearTimeout(session.durationTimer);
  session.context.onstatechange = null;
  session.stream?.getTracks().forEach((track) => track.stop());
  for (const node of [session.source, session.analyser, session.recorder, session.mute]) {
    try { node?.disconnect(); } catch { /* Already disconnected. */ }
  }
  if (session.recorder) {
    session.recorder.port.onmessage = null;
    session.recorder.port.close();
  }
  if (session.context.state !== 'closed') {
    try { await session.context.close(); } catch { /* Closing can race with navigation. */ }
  }
}

export type InputState = 'idle' | 'quiet' | 'receiving' | 'clipping' | 'muted' | 'interrupted';
export interface MicrophoneDevice { deviceId: string; label: string }
interface CaptureMessage {
  type: 'chunk' | 'meter' | 'stopped';
  samples?: Float32Array;
  count?: number;
  rms?: number;
  peak?: number;
}

/** Captures only after start() is called from a user action. Spectrum values are dBFS; level is linear RMS. */
export function useVoiceRecorder(onComplete: (samples: Float32Array, sampleRate: number) => void) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'recording' | 'checking'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [inputState, setInputState] = useState<InputState>('idle');
  const [signalHistory, setSignalHistory] = useState<number[]>(() => Array(SIGNAL_HISTORY_LENGTH).fill(0));
  const [microphones, setMicrophones] = useState<MicrophoneDevice[]>([]);
  const [activeDeviceLabel, setActiveDeviceLabel] = useState('');
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [liveSpectrum, setLiveSpectrum] = useState<Float32Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<CaptureSession | null>(null);
  const mountedRef = useRef(true);
  const deviceRequestRef = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Device enumeration never prompts for permission. Labels become available after start().
  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const request = ++deviceRequestRef.current;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!mountedRef.current || request !== deviceRequestRef.current) return;
      setMicrophones(devices.filter((device) => device.kind === 'audioinput').map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || (device.deviceId === 'default' ? 'System default microphone' : `Microphone ${index + 1}`),
      })));
    } catch {
      // Enumeration may be restricted before permission; the default microphone can still be requested.
    }
  }, []);

  const finishSession = useCallback((session: CaptureSession, includeResult: boolean): Promise<void> => {
    if (session.finalization) return session.finalization;
    // Checking shares the same input path, but never retains samples or creates a map.
    includeResult = includeResult && session.mode === 'record';
    session.finalizing = true;
    if (!includeResult) session.cancelled = true;
    cancelAnimationFrame(session.animationFrame);
    window.clearTimeout(session.durationTimer);

    session.finalization = (async () => {
      if (includeResult && session.recorder && !session.stopped) {
        // Flush the final partial chunk. A suspended audio device must not hold the UI open.
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(done, 250);
          function done() {
            window.clearTimeout(timeout);
            session.flushResolve = undefined;
            resolve();
          }
          session.flushResolve = done;
          session.recorder!.port.postMessage('stop');
        });
      }
      await releaseSession(session);
      if (sessionRef.current !== session || !mountedRef.current) return;
      sessionRef.current = null;
      setStatus('idle');
      setInputState('idle');
      setLevel(0);
      setPeak(0);
      setLiveSpectrum(null);
      setElapsed(session.sampleCount / session.context.sampleRate);
      if (!includeResult || session.cancelled) return;
      if (!session.sampleCount) {
        setError('No audio was captured. Check your microphone and try a longer recording.');
        return;
      }
      const samples = new Float32Array(session.sampleCount);
      let offset = 0;
      for (const chunk of session.chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      session.chunks = [];
      try {
        onCompleteRef.current(samples, session.context.sampleRate);
      } catch {
        setError('Your recording could not be analyzed. Please try again or import another recording.');
      }
    })();
    return session.finalization;
  }, []);

  const stop = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    return session ? finishSession(session, session.startedAt !== null) : Promise.resolve();
  }, [finishSession]);

  const start = useCallback(async (deviceId?: string, mode: 'record' | 'check' = 'record') => {
    // Keep ownership until the old context has closed, including its final flush.
    if (sessionRef.current || !mountedRef.current) return;
    stopTone();
    setError(null);
    setElapsed(0);
    setLevel(0);
    setPeak(0);
    setInputState('idle');
    setSignalHistory(Array(SIGNAL_HISTORY_LENGTH).fill(0));
    setActiveDeviceLabel('');
    setSampleRate(null);
    setLiveSpectrum(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Microphone recording needs a secure connection. Open SONAR over HTTPS or on localhost, or import an audio file.');
      return;
    }

    let session: CaptureSession;
    try {
      const Constructor = audioContextConstructor();
      session = {
        mode, context: new Constructor(), chunks: [], sampleCount: 0, startedAt: null,
        animationFrame: 0, lastSamplesAt: 0, lastSignalAt: -Infinity, cancelled: false, stopped: false, finalizing: false,
      };
    } catch (cause) {
      setError(microphoneError(cause));
      return;
    }
    sessionRef.current = session;
    setSampleRate(session.context.sampleRate);
    setStatus('requesting');
    // Resume in the original gesture stack, before waiting for permission.
    const initialResume = session.context.resume().catch(() => undefined);
    const isCurrent = () => mountedRef.current && sessionRef.current === session && !session.cancelled && !session.finalizing;
    let processorUrl: string | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
        video: false,
      });
      if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('The microphone disconnected before capture could start. Choose another microphone and try again.');
      setActiveDeviceLabel(track.label || 'System default microphone');
      void refreshMicrophones();
      await initialResume;
      if (!isCurrent()) return;
      if (session.context.state === 'suspended') await session.context.resume();
      if (!isCurrent()) return;
      if (!session.context.audioWorklet) {
        throw new Error('This browser cannot capture microphone audio for analysis. Use a current browser or import an audio recording.');
      }
      processorUrl = URL.createObjectURL(new Blob([RECORDER_PROCESSOR], { type: 'application/javascript' }));
      await session.context.audioWorklet.addModule(processorUrl);
      if (!isCurrent()) return;
      if (!stream.active) throw new Error('The microphone disconnected before capture could start. Choose another microphone and try again.');

      session.source = session.context.createMediaStreamSource(stream);
      session.analyser = session.context.createAnalyser();
      session.analyser.fftSize = 2048;
      session.analyser.minDecibels = -100;
      session.analyser.maxDecibels = -10;
      session.analyser.smoothingTimeConstant = 0.75;
      session.recorder = new AudioWorkletNode(session.context, 'sonar-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { mode },
      });
      session.mute = session.context.createGain();
      session.mute.gain.value = 0;
      const unavailableState = (): InputState | null => {
        if (track.readyState === 'ended' || session.context.state !== 'running') return 'interrupted';
        if (track.muted || !track.enabled) return 'muted';
        return null;
      };
      const markUnavailable = () => {
        if (!isCurrent()) return;
        const unavailable = unavailableState();
        setInputState(unavailable ?? 'quiet');
        setLevel(0);
        setPeak(0);
        if (unavailable) {
          session.lastSignalAt = -Infinity;
          setLiveSpectrum(null);
        }
      };
      session.context.onstatechange = markUnavailable;
      track.addEventListener('mute', markUnavailable);
      track.addEventListener('unmute', markUnavailable);
      session.recorder.onprocessorerror = () => {
        if (isCurrent()) {
          setError('Audio capture was interrupted. Please check your microphone and try again.');
          void finishSession(session, false);
        }
      };
      session.recorder.port.onmessage = ({ data }: MessageEvent<CaptureMessage>) => {
        if (session.cancelled || !mountedRef.current || sessionRef.current !== session) return;
        if (data.type === 'chunk' || data.type === 'meter') {
          if (data.type === 'chunk' && data.samples && session.mode === 'record') session.chunks.push(data.samples);
          session.sampleCount += data.count ?? 0;
          session.lastSamplesAt = performance.now();
          const unavailable = unavailableState();
          const rms = unavailable ? 0 : data.rms ?? 0;
          const currentPeak = unavailable ? 0 : data.peak ?? 0;
          if (unavailable) session.lastSignalAt = -Infinity;
          else if (rms >= 0.002) session.lastSignalAt = session.lastSamplesAt;
          // Brief gaps between syllables should not make the status chatter; the meter stays instantaneous.
          const recentlyReceived = session.lastSamplesAt - session.lastSignalAt <= 400;
          setLevel(rms);
          setPeak(currentPeak);
          setInputState(unavailable ?? (currentPeak >= 0.985 ? 'clipping' : recentlyReceived ? 'receiving' : 'quiet'));
          setSignalHistory((history) => [...history.slice(1), rms]);
          // This clock advances only when the worklet actually receives samples.
          setElapsed(session.sampleCount / session.context.sampleRate);
        } else if (data.type === 'stopped') {
          session.stopped = true;
          session.flushResolve?.();
          if (!session.finalizing) void finishSession(session, true);
        }
      };
      session.source.connect(session.analyser);
      session.analyser.connect(session.recorder);
      session.recorder.connect(session.mute);
      session.mute.connect(session.context.destination);
      session.startedAt = performance.now();
      session.lastSamplesAt = session.startedAt;
      setInputState(unavailableState() ?? 'quiet');
      setStatus(mode === 'check' ? 'checking' : 'recording');
      // A stalled device or suspended context still releases on the wall-clock limit.
      // The displayed duration continues to count only actual samples from the worklet.
      session.durationTimer = window.setTimeout(() => {
        if (mode === 'record' && (unavailableState() || performance.now() - session.lastSamplesAt > 1000)) {
          setError('The microphone stopped delivering audio. The audio captured so far has been kept.');
        }
        void finishSession(session, mode === 'record');
      }, (mode === 'check' ? MAX_CHECK_SECONDS : MAX_RECORDING_SECONDS) * 1000);

      const spectrum = new Float32Array(session.analyser.frequencyBinCount);
      let lastUpdate = -Infinity;
      const update = (now: number) => {
        if (!isCurrent()) return;
        if (now - lastUpdate >= 70) {
          const unavailable = unavailableState();
          if (unavailable || now - session.lastSamplesAt > 1000) {
            setInputState(unavailable ?? 'interrupted');
            setLevel(0);
            setPeak(0);
            setLiveSpectrum(null);
            setSignalHistory((history) => [...history.slice(1), 0]);
          } else {
            session.analyser!.getFloatFrequencyData(spectrum);
            setLiveSpectrum(spectrum.slice());
          }
          lastUpdate = now;
        }
        session.animationFrame = requestAnimationFrame(update);
      };
      session.animationFrame = requestAnimationFrame(update);
      track.addEventListener('ended', () => {
        if (isCurrent()) {
          setError(mode === 'check'
            ? 'Your microphone disconnected. Choose another microphone and check it again.'
            : 'Your microphone disconnected. The audio captured so far has been kept.');
          void finishSession(session, true);
        }
      }, { once: true });
    } catch (cause) {
      if (isCurrent()) {
        setError(microphoneError(cause));
        await finishSession(session, false);
      }
    } finally {
      if (processorUrl) URL.revokeObjectURL(processorUrl);
    }
  }, [finishSession, refreshMicrophones]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshMicrophones();
    navigator.mediaDevices?.addEventListener('devicechange', refreshMicrophones);
    return () => {
      mountedRef.current = false;
      deviceRequestRef.current++;
      navigator.mediaDevices?.removeEventListener('devicechange', refreshMicrophones);
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        session.cancelled = true;
        session.flushResolve?.();
        void releaseSession(session);
      }
    };
  }, [refreshMicrophones]);

  const clearError = useCallback(() => setError(null), []);
  return {
    status, elapsed, capturedSeconds: elapsed, level, peak, sampleRate, liveSpectrum, error,
    inputState, signalHistory, microphones, activeDeviceLabel, refreshMicrophones, start, stop, clearError,
  };
}

/** Decodes locally, rejects oversized/long recordings, and averages all channels to mono. */
export async function decodeAudioFile(file: File): Promise<{ samples: Float32Array; sampleRate: number }> {
  if (!file.size) throw new Error('This audio file is empty. Choose another recording.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose an audio file smaller than 30 MB.');
  const Constructor = audioContextConstructor();
  const context = new Constructor();
  try {
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new Error('This file could not be decoded as audio. Try a WAV, MP3, or M4A file supported by your browser.');
    }
    if (!decoded.length || !decoded.numberOfChannels || !Number.isFinite(decoded.duration)) {
      throw new Error('This file contains no readable audio. Choose another recording.');
    }
    if (decoded.duration > MAX_FILE_SECONDS) throw new Error('Choose a recording of 2 minutes or less.');
    const samples = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const channelSamples = decoded.getChannelData(channel);
      for (let frame = 0; frame < samples.length; frame++) {
        samples[frame] += channelSamples[frame] / decoded.numberOfChannels;
      }
    }
    return { samples, sampleRate: decoded.sampleRate };
  } finally {
    if (context.state !== 'closed') await context.close().catch(() => undefined);
  }
}

interface ActiveTone {
  context: AudioContext;
  oscillator: OscillatorNode;
  gain: GainNode;
  cancelled: boolean;
  resolve: () => void;
  timer?: number;
  finish: () => void;
}
let activeTone: ActiveTone | null = null;

/** Cancels the currently playing or pending reference tone and releases its audio device. */
export function stopTone(): void {
  const tone = activeTone;
  if (!tone) return;
  tone.cancelled = true;
  tone.finish();
}

/** A quiet sine reference, with a gentle envelope. Call directly from a user action. */
export async function playTone(frequency: number, duration = 1.5): Promise<void> {
  if (!Number.isFinite(frequency) || frequency < 40 || frequency > 2000) {
    throw new Error('Choose a reference tone between 40 and 2,000 Hz.');
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 10) {
    throw new Error('Reference tones must last between 0 and 10 seconds.');
  }
  stopTone();
  const Constructor = audioContextConstructor();
  const context = new Constructor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  let finished = false;
  const tone: ActiveTone = {
    context, oscillator, gain, cancelled: false, resolve: resolveCompletion,
    finish: () => {
      if (finished) return;
      finished = true;
      if (activeTone === tone) activeTone = null;
      if (tone.timer !== undefined) window.clearTimeout(tone.timer);
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* It may not have started yet. */ }
      oscillator.disconnect();
      gain.disconnect();
      if (context.state !== 'closed') void context.close().catch(() => undefined);
      tone.resolve();
    },
  };
  activeTone = tone;
  // Also cover a browser that leaves resume() pending after audio permission changes.
  tone.timer = window.setTimeout(tone.finish, duration * 1000 + 1500);
  try {
    await Promise.race([context.resume(), completion]);
    if (tone.cancelled || finished) return completion;
    const now = context.currentTime;
    const attack = Math.min(0.06, duration / 4);
    const release = Math.min(0.14, duration / 3);
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.06, now + attack);
    gain.gain.setValueAtTime(0.06, now + duration - release);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = tone.finish;
    oscillator.start(now);
    oscillator.stop(now + duration);
    // A suspended/backgrounded audio device must not retain a pending tone indefinitely.
    window.clearTimeout(tone.timer);
    tone.timer = window.setTimeout(tone.finish, duration * 1000 + 1000);
    await completion;
  } catch (cause) {
    tone.finish();
    if (!tone.cancelled) throw cause;
  }
}
