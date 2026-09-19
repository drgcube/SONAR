# SONAR — developer handoff for Paul

SONAR is a working, local-first voice exploration studio. The current implementation captures or imports audio, measures its spectrum and fundamental pitch, visualizes the result, and plays optional reference tones. It is a React/TypeScript/Vite application with no backend, accounts, API keys, or cloud storage.

Start with this document, then the [measurement and privacy details](../README.md), [design direction](design-direction.md), and [verification record](verification.md). The last implemented features are the measured microphone orb/history, device selection and mic check, continuous-Hz mode, and rainbow frequency/power displays.

## Get running

After you have access to the repository:

```sh
git clone https://github.com/drgcube/SONAR.git
cd SONAR
npm ci
npm run dev
```

Use Node.js 22.12 or newer on the Node 22 line, or Node.js 24+. If using nvm, run `nvm install` and `nvm use` after cloning; `.nvmrc` selects Node 22. Follow the URL printed by Vite. No `.env` file is required. The development server binds to `127.0.0.1` by default; a phone cannot reach that loopback server directly. Microphone capture requires HTTPS or a browser-recognized local secure context, plus microphone permission.

```sh
npm test         # Vitest regression suite
npm run build    # TypeScript check, then production output in dist/
npm run preview  # Inspect an existing production build locally
```

The handoff baseline has 38 passing tests: 24 DSP, 5 capture-worklet, 7 continuous-frequency distribution, and 2 color-mapping tests. Browser QA and its remaining gaps are documented in [verification.md](verification.md). `npm test` does not run those manual browser journeys.

For a fast product tour, choose **Try an example**, inspect all three charts, switch **Musical scale** on/off, select a frequency, play/stop its reference, then save and reopen a map. The example is synthesized and labeled accordingly. Use **Check mic** before making a real recording; moving bars confirm incoming sound even when no reliable pitch is detected.

## Architecture and data flow

```text
Microphone → AudioWorklet → mono Float32Array ┐
Audio file → browser decoder → mono samples  ├→ analyzeAudio → AnalysisResult
Generated example → mono samples            ┘                    │
                                             charts / distributions / practice
                                                                 │
                                              explicit local save / JSON export
```

| Boundary | Current location and behavior |
| --- | --- |
| Application state | `src/App.tsx`: recording/import orchestration, current result, chart/scale choices, practice, dialogs, persistence, and export. There is no router or global state library. |
| Capture and playback | `src/audio/useVoiceRecorder.ts`: React hook, worklet source, browser decoding, tone generation, and cleanup. Capture requests echo cancellation, noise suppression, and automatic gain control off; devices may behave differently. |
| Analysis | `src/audio/analysis.ts`: signal processing and exported types. It has no React dependency. Analysis runs on the main thread with periodic asynchronous yields, not in a Web Worker. |
| Continuous-Hz distribution | `src/audio/frequencyView.ts`: derives equal-Hz bins from raw pitch frames; no MIDI snapping. |
| Shared colors | `src/audio/spectrumColors.ts`: fixed logarithmic 60–8,000 Hz hue mapping and relative-power brightness. |
| Visualization | `src/components/VoiceChart.tsx`: responsive canvas charts, legends, accessible descriptions, and live spectrum. `InputMonitor.tsx` shows measured input state independently of pitch analysis. |
| Styling | `src/styles.css` and `src/components/InputMonitor.css`. Preserve the warm-paper studio, continuous header/hero transition, and functional dark chart area. |

`App.tsx` is currently the integration point rather than a packaged SDK. Extracting persistence/report types and application orchestration is a sensible next step before connecting another product.

## Existing functions to reuse

These signatures describe the current implementation, not a separate public API:

```ts
// src/audio/analysis.ts
analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (n: number) => void,
): Promise<AnalysisResult>
detectPitch(samples: Float32Array, sampleRate: number): PitchEstimate | null
generateDemoAudio(): { samples: Float32Array; sampleRate: number }
spectrumBinHz(index: number, sampleRate: number): number
spectrogramBinHz(index: number, sampleRate: number): number
midiToHz(midi: number): number
hzToMidi(hz: number): number
noteName(midi: number): string

// src/audio/useVoiceRecorder.ts — browser/React boundary
useVoiceRecorder(
  onComplete: (samples: Float32Array, sampleRate: number) => void,
)
decodeAudioFile(file: File): Promise<{
  samples: Float32Array; sampleRate: number;
}>
playTone(frequency: number, duration?: number): Promise<void>
stopTone(): void

// src/audio/frequencyView.ts
frequencyBands(
  result: AnalysisResult | null | undefined,
  count?: number,
): FrequencyBand[]
```

The recorder hook returns `start(deviceId?: string, mode?: 'record' | 'check'): Promise<void>`, `stop(): Promise<void>`, `refreshMicrophones()`, and `clearError()`, alongside state including `status`, `capturedSeconds`, `level`, `peak`, `signalHistory`, `inputState`, `microphones`, `activeDeviceLabel`, `sampleRate`, `liveSpectrum`, and `error`. Start capture and tones directly from a user gesture. `onComplete` receives a finished recording; mic-check mode produces no recording result. Stop/unmount releases tracks, nodes, and contexts. Playback is a single shared reference tone; the app requests two seconds, while the function defaults to 1.5 seconds.

Recording is capped at 60 seconds; mic check at 30 seconds. File decoding rejects files over 30 MiB or two minutes, averages channels to mono, and uses the browser decoder's resulting sample rate. Supported codecs depend on the browser. The core `analyzeAudio` function validates sample rate (2,000–384,000 Hz), nonempty input, and finite samples, but **does not enforce the UI's duration/size limits**; an integration must apply its own resource limits.

An existing browser integration can analyze audio without mounting the UI:

```ts
import { analyzeAudio } from './audio/analysis';
import { decodeAudioFile } from './audio/useVoiceRecorder';

const { samples, sampleRate } = await decodeAudioFile(file);
const analysis = await analyzeAudio(samples, sampleRate, setProgress);
// Use analysis in the host application; raw samples need not be persisted.
```

Move file decoding into a dedicated browser module if the host should avoid importing the React hook module. There is currently no HTTP endpoint, report-upload service, report-import function, plugin protocol, or external-project synchronization. JSON export is the available portable data boundary.

## Measurement contract

`AnalysisResult` is exported from `analysis.ts` and contains:

| Fields | Meaning |
| --- | --- |
| `duration`, `sampleRate` | Seconds and the input PCM sample rate before SONAR's internal resampling. |
| `frames` | Accepted voiced frames: `{ time, frequency, midi, confidence }`. Time is the window center in seconds; frequency is unrounded Hz; MIDI remains fractional. Rejected/unvoiced windows are omitted. Confidence is an algorithm score, not a probability. |
| `medianHz`, `lowHz`, `highHz`, `rangeSemitones` | Median, 5th/95th percentile pitch, and logarithmic span; nullable when no reliable pitch exists. These are sample statistics, not physiological range. |
| `voicedSeconds`, `voicedRatio` | Estimated coverage from accepted-window proportion, not exact speech segmentation. |
| `notes` | `{ midi, label, frequency, seconds, percent }` semitone bins, with A4 = 440 Hz. The central percentile interval is rounded outward for this view. |
| `spectrum` | 1,024 mean-power FFT bins, normalized to the strongest average bin, in relative dB from −80 to 0. Use `spectrumBinHz()` for positions. |
| `spectrogram` | At most 180 time columns × 128 low-to-high logarithmic frequency rows. Column center = `(column + 0.5) * duration / columnCount`; use `spectrogramBinHz()` for row frequencies. Peak band power uses one shared reference across columns, with a −80 dB floor. |
| `rms`, `clippingRatio` | Whole-sample linear RMS and fraction of samples with absolute amplitude ≥ 0.995. |
| `quality`, `suggestedMidi` | `good`, `limited`, or `insufficient`; optional less-used interior-note heuristic. It is not a clinical quality score or prescription. |

The default frequency distribution is computed on demand by `frequencyBands()` and is not stored separately in `AnalysisResult`. It uses twelve equal-Hz bins across the percentile interval (one bin for spans below 0.1 Hz). Both frequency and note percentages use **all accepted voiced frames**, so displayed percentages can total less than 100%. Keep outliers in `frames`; changing views must not change the measured data.

The spectrum and spectrogram have distinct normalization references; live analyser values have a different reference again. These are not calibrated SPL measurements. Rainbow hue identifies frequency; spectrogram brightness toward white identifies stronger relative power. No Q factor is measured. See the README for pitch windows, confidence gates, resampling, FFT parameters, and suggestion criteria.

## Saved sessions and exported reports

Persistence currently lives in private functions inside `App.tsx`; `validAnalysis()` and the session types are not exported. `sonar.sessions.v1` stores a JSON array in `localStorage`:

```ts
type Session = {
  id: string;             // crypto.randomUUID()
  createdAt: string;      // ISO timestamp
  name: string;
  source: 'recording' | 'upload' | 'example';
  result: AnalysisResult;
};
```

Saving is explicit. Newest sessions come first, at most eight are kept, and a ninth replaces the oldest. Loading filters malformed records with nested-field validation. Invalid data is ignored, not migrated. Storage-quota failures are surfaced to the user. Raw audio is never stored. Maps include detailed derived pitch and spectral data, so handle them as personal data when adding any sharing feature.

The independent `sonar.musicalScale.v1` key stores the string `"true"` or `"false"`; missing/unreadable values default to Hz mode. Other transient choices, including mic selection and reference frequency, are not persisted. `localStorage` is origin/browser scoped: changing host, port, browser, or device does not carry maps over. GitHub publication does not transfer a user's saved sessions.

**Export** downloads a JSON report with this envelope:

```ts
{
  app: 'SONAR',
  version: 1,
  exportedAt: string, // ISO timestamp
  source: 'recording' | 'upload' | 'example',
  displayMode: 'musical-notes' | 'frequency-hz',
  description: string, // explanatory scientific-boundary text
  analysis: AnalysisResult,
}
```

The filename is `sonar-<source>-YYYY-MM-DD.json`. Export includes no PCM samples, recording file, microphone identifier, selected practice frequency, or saved-session ID. **Import audio** accepts audio files, not these reports; a report cannot yet be reopened through the UI. Export version 1 and local-storage key version 1 are separate formats. Neither records the analysis-algorithm revision. Before another project depends on them, extract a shared versioned schema, add validation/migrations and algorithm metadata, and implement an explicit report-import path with size limits. Preserve nullable fields and array orientations when consuming reports.

## Optional GitHub automation

The [build/test workflow template](github-actions-ci.yml) runs `npm ci`, `npm test`, and `npm run build` on main-branch pushes and pull requests. It is stored under `docs/` and is **not active**: the publishing login could create the repository but lacked GitHub's `workflow` scope, so GitHub rejected an upload containing `.github/workflows/ci.yml`.

To enable it later, use an account/token authorized to manage Actions workflows, copy the template to `.github/workflows/ci.yml`, and commit that change. Normal source edits and local development do not need workflow-management permission. The initial source was verified from a clean dependency installation locally.

## Continue from here

1. **Validate real recording behavior.** Test ordinary human speech and humming on physical microphones across Chrome, Firefox, Safari, and mobile. Include silence, permission denial, wrong/muted/disconnected devices, background noise, and low/high voices. Existing synthetic tests do not establish real-speech accuracy; the cause of the original user's unreliable-pitch recordings was not established.
2. **Define the integration contract.** Agree on Paul's host projects and whether they need embedded UI, shared analysis code, or portable reports. Separate report/session serialization from `App.tsx`, version its schema, and add round-trip tests before connecting external storage. No backend is needed merely to reuse analysis locally.
3. **Improve long-running analysis.** Consider a dedicated Web Worker, cancellation, and explicit resource budgets before raising duration limits. Keep progress reporting and microphone cleanup intact.
4. **Build comparison carefully.** Session naming, validated JSON import, and comparing samples recorded under similar conditions would make saved maps more useful. Preserve source labels, processing metadata, and the distinction between measured change and a health inference.
5. **Finish deployment and accessibility validation.** The output is a static `dist/` directory. Choose an HTTPS host; configure Vite's `base` if serving under a subpath. If embedding in an iframe, verify microphone Permissions Policy and gesture requirements. Check any host CSP against blob-based AudioWorklet loading and optional Google Fonts. Run keyboard/screen-reader and contrast audits beyond the current responsive browser checks.

## Product boundaries to preserve

- SONAR describes a single audio sample. A missing or uncommon pitch does not establish weakness, trauma, harmful relationships, hearing loss, psychological blocks, or inability to sing a note.
- Spectrum energy includes harmonics, noise, and breath; it is not the same measurement as fundamental pitch. Ordinary speech need not visit every frequency or note.
- Tomatis's work is historical inspiration; the app is independent of the Tomatis Method and is not a validated assessment or therapy. There is no trauma-detection or listening-treatment layer.
- Raw voice processing stays in browser memory. No audio upload occurs. Optional Google Fonts requests exist, but contain no voice data. Any future synchronization or recording retention needs an explicit product/privacy decision and accurate UI copy.
- Treat the generated example as synthetic, maintain continuous-Hz mode as a first-class option, and retain reduced-motion behavior and text explanations alongside canvas charts.
