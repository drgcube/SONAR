# SONAR

A private voice exploration studio built with React, TypeScript, Vite, and the Web Audio API. Record a moment, inspect its sound and speaking pitches, and explore a comfortable reference frequency.

**Continuing development or integrating another project? Start with [Paul's developer handoff](docs/handoff.md).**

## Run

Use Node.js 22.12 or newer on the Node 22 release line, or Node.js 24+. If you use nvm, run `nvm install` and `nvm use`; `.nvmrc` selects Node 22.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Microphone capture requires a secure browser context: HTTPS or a loopback address such as `localhost` or `127.0.0.1`. Allow microphone access when prompted. The browser must support Web Audio, AudioWorklet, and `getUserMedia`; audio file support depends on its decoder. Use a current Chrome, Firefox, or Safari; the full browser/device compatibility matrix has not been validated.

```sh
npm run build    # TypeScript check and production files in dist/
npm run preview  # Serve the production build locally
npm test         # Synthetic-signal DSP tests
```

A [GitHub Actions template](docs/github-actions-ci.yml) is included but not active; see the [handoff](docs/handoff.md#optional-github-automation) to enable it.

The production app is static and needs no API server or credentials. Serve `dist/` over HTTPS for microphone use on a deployed site.

## What works

- Microphone recording with a live spectrum, a sound-responsive orb and level-history bars, an explicit stop button, and a 60-second limit. The input monitor uses RMS/peak measurements from the same audio batches that are captured, independently of pitch detection.
- A microphone selector and an explicit 30-second **Check mic** mode. The check retains no recording and creates no voice map. It shows the actual input device and distinguishes very quiet, receiving, clipped, muted, and interrupted audio; its clock counts received samples. You can move directly from a check to recording with the selected mic.
- Local audio import, up to 30 MiB and two minutes; channels are averaged to mono.
- Rainbow spectrum and spectrogram, pitch contour, typical pitch, observed span, and frequency-use distribution. Hue consistently maps 60–8,000 Hz from red to violet. Spectrogram brightness shows relative spectral power, with the strongest areas approaching white.
- Scale-agnostic Hz views by default, including equal-width frequency bands and a continuous reference-frequency slider. An optional **Musical scale** switch enables chromatic note labels, note-use bars, and note-based practice; the preference is remembered on this device.
- Frequency or note selection and a quiet, two-second sine reference for optional humming practice.
- Explicitly saved voice maps, reopening/deletion, and JSON report export.
- A clearly labeled, reproducible 24-second synthesized example analyzed by the same pipeline. It is not a recording of a person. The initial sound illustration is decorative and contains no measurements.

## How the measurements work

**Pitch:** A YIN-style cumulative mean normalized difference estimator examines 50 ms windows after antialiased resampling to at most 8 kHz, with a 40 ms hop. Each window spans three periods at the 60 Hz lower bound and is short enough to follow changing speech pitch. It accepts periodic estimates between 60 and 1,000 Hz, requires confidence of at least 0.84, and rejects windows below an RMS gate of `max(0.002, whole-recording RMS × 0.08)`. Unvoiced or uncertain windows contribute no pitch estimate. Confidence is an algorithm score, not a calibrated probability.

**Summary and optional notes:** Typical pitch is the median detected fundamental frequency. The observed span uses its 5th–95th percentiles. The default map groups raw, unrounded Hz values into twelve equal-width frequency bands within this span; very narrow spans use one band. Its practice slider selects continuous frequencies without note snapping. With **Musical scale** on, a separate interpretation rounds pitches to equal-tempered semitones with A4 = 440 Hz, and the note map covers the percentile endpoints rounded outward to whole semitones. The contour retains unrounded pitch estimates in both modes. Percentages use **all accepted voiced frames** as their denominator, so the displayed bins may total less than 100%. Voiced duration is estimated from the proportion of accepted analysis windows. Changing the display never changes the underlying measurements.

**Spectrum:** Audio is antialiased and resampled to at most 16 kHz. A 2,048-point Hann-windowed FFT produces 1,024 frequency bins. The average spectrum uses mean power, expressed relative to its strongest bin. The spectrogram contains at most 180 time columns and 128 logarithmic frequency bands from 60 Hz to the lower of 8 kHz or the source Nyquist frequency. It uses peak power within each band and a common reference across columns. Both displays have an −80 dB floor. Live spectrum values come directly from the browser analyser and use a different reference from the analyzed spectrum; these are not calibrated sound-pressure measurements.

**Color:** Hue uses a fixed logarithmic 60–8,000 Hz mapping across recordings and views. Spectrogram pixels progress from dark at −80 dB through their frequency hue to near-white at the strongest relative power (0 dB). The two legends separate frequency from relative energy. Brightness does not estimate resonance Q.

**Suggestions (musical mode):** A less-used interior note is suggested only when the sample passes the app’s quality checks: at least five estimated voiced seconds, at least 20% voiced coverage, and less than 1% clipped samples. A candidate must have less than 60% of an equal-share note occupancy. This is a transparent exploration heuristic, not a therapeutic recommendation.

## Privacy and limits

Raw audio is processed in browser memory. SONAR does not upload it or persist recordings. Choosing **Save voice map** stores derived measurements—including pitch frames and spectral arrays—in this browser’s `localStorage`. Up to eight maps are retained; a ninth replaces the oldest. Saved maps can be deleted, and exported JSON files remain wherever the user saves them. The page loads its optional Instrument Serif font from Google Fonts; font requests do not contain voice data.

Every result describes one sample. Background noise, whispering, breathiness, creaky voice, overlapping speakers, microphone processing, clipping, and pitch octave errors can change the result. Browser capture requests echo cancellation, noise suppression, and automatic gain control off, but hardware and browser behavior may differ. A short speaking sample does not measure a person’s full singing range, and ordinary speech need not visit every note.

Alfred Tomatis’s work is historical inspiration. SONAR is independent of the Tomatis Method and is not a clinical assessment or validated therapy. Unobserved pitches do not establish trauma, harmful relationships, hearing loss, weakness, or psychological blocks.

Automated tests exercise synthetic tones, stronger harmonics, silence, noise, clipping, sparse samples, invalid input, and the generated example. They do not establish accuracy on a representative human speech dataset. Live human microphone accuracy and broad browser/device compatibility still require validation.

## Source map

| File | Responsibility |
| --- | --- |
| `src/App.tsx` | Studio flow, optional scale, frequency/note maps, reference practice, saved sessions, and export |
| `src/audio/useVoiceRecorder.ts` | AudioWorklet capture, resource cleanup, file decoding, and reference tones |
| `src/audio/analysis.ts` | Resampling, YIN pitch estimation, FFT, summaries, and synthetic example |
| `src/audio/analysis.test.ts` | DSP regression tests |
| `src/audio/frequencyView.ts` | Continuous-Hz distribution bands, with companion tests |
| `src/audio/spectrumColors.ts` | Shared frequency hue and spectrogram power mapping, with companion tests |
| `src/components/InputMonitor.tsx` | Captured-signal bars, responsive orb, input state, and device feedback |
| `src/audio/inputLevel.test.ts` | Recording/preview metering, sample retention, silence and duration limits |
| `src/components/VoiceChart.tsx` | Responsive canvas plots and accessible chart descriptions |
| `src/styles.css` | Visual design, responsive layout, and motion preferences |
| `docs/design-direction.md` | Product direction and scientific boundaries |
