import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RECORDER_PROCESSOR } from './useVoiceRecorder';

interface CaptureMessage {
  type: string;
  samples?: Float32Array;
  count?: number;
  rms?: number;
  peak?: number;
}
interface Processor {
  buffer: Float32Array | null;
  process(inputs: Float32Array[][]): boolean;
  port: { onmessage: (event: { data: string }) => void };
}

function recorder(mode: 'record' | 'check', sampleRate = 16000) {
  const messages: CaptureMessage[] = [];
  let Constructor!: new (options: { processorOptions: { mode: string } }) => Processor;
  runInNewContext(RECORDER_PROCESSOR, {
    sampleRate,
    Float32Array,
    AudioWorkletProcessor: class {
      port = { postMessage: (message: CaptureMessage) => messages.push(message), onmessage: () => undefined };
    },
    registerProcessor: (_name: string, value: typeof Constructor) => { Constructor = value; },
  });
  const processor = new Constructor({ processorOptions: { mode } });
  return {
    processor,
    messages,
    feed(samples: Float32Array) {
      for (let offset = 0; offset < samples.length; offset += 128) {
        if (!processor.process([[samples.subarray(offset, offset + 128)]])) break;
      }
    },
    stop() { processor.port.onmessage({ data: 'stop' }); },
  };
}

describe('live input capture and metering', () => {
  it('measures the same audio batches that are preserved for a recording, including an unpitched signal', () => {
    const capture = recorder('record');
    const samples = Float32Array.from({ length: 4999 }, (_, i) => i % 11 === 0 ? 1 : ((i * 13) % 19 - 9) / 50);
    capture.feed(samples);
    capture.stop();
    const chunks = capture.messages.filter((message) => message.type === 'chunk');
    expect(chunks.flatMap((message) => [...message.samples!])).toEqual([...samples]);
    for (const chunk of chunks) {
      const recorded = chunk.samples!;
      const rms = Math.sqrt(recorded.reduce((sum, sample) => sum + sample * sample, 0) / recorded.length);
      expect(chunk.count).toBe(recorded.length);
      expect(chunk.rms).toBeCloseTo(rms, 12);
      expect(chunk.peak).toBe(Math.max(...recorded.map(Math.abs)));
    }
    expect(capture.messages.at(-1)?.type).toBe('stopped');
  });

  it('checks a microphone without allocating a recording buffer or posting raw samples', () => {
    const capture = recorder('check');
    capture.feed(new Float32Array(4000).fill(0.125));
    capture.stop();
    expect(capture.processor.buffer).toBeNull();
    const readings = capture.messages.filter((message) => message.type === 'meter');
    expect(readings.length).toBeGreaterThan(1);
    expect(readings.reduce((sum, message) => sum + message.count!, 0)).toBe(4000);
    for (const reading of readings) {
      expect(reading.samples).toBeUndefined();
      expect(reading.rms).toBe(0.125);
      expect(reading.peak).toBe(0.125);
    }
    expect(capture.messages.every((message) => message.type !== 'chunk')).toBe(true);
  });

  it('distinguishes received silence from an input that produces no frames', () => {
    const capture = recorder('record');
    for (let i = 0; i < 100; i++) capture.processor.process([[]]);
    expect(capture.messages).toHaveLength(0);
    capture.feed(new Float32Array(3200));
    capture.stop();
    const chunks = capture.messages.filter((message) => message.type === 'chunk');
    expect(chunks.reduce((sum, chunk) => sum + chunk.count!, 0)).toBe(3200);
    expect(chunks.every((chunk) => chunk.rms === 0 && chunk.peak === 0)).toBe(true);
  });

  it.each([['check', 30], ['record', 60]] as const)('limits %s to %i seconds of actual input', (mode, seconds) => {
    const capture = recorder(mode);
    capture.feed(new Float32Array((seconds + 1) * 16000).fill(0.01));
    capture.stop();
    capture.stop();
    expect(capture.messages.reduce((sum, message) => sum + (message.count ?? 0), 0)).toBe(seconds * 16000);
    expect(capture.messages.filter((message) => message.type === 'stopped')).toHaveLength(1);
    expect(capture.processor.process([[new Float32Array(128)]])).toBe(false);
  });
});
