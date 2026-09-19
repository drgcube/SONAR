# Verification — September 19, 2026

## Completed

- Production TypeScript/Vite build passes.
- 18 DSP tests pass, covering pitch endpoints, harmonic-rich signals including a missing fundamental, stronger harmonics, silence, DC, noise, clipping, invalid and sparse inputs, percentile boundaries, outlier omission, and the synthetic example.
- Browser recording tested with a synthetic 180 Hz MediaStream: 180 Hz median measured; stopping capture ends its track. No physical microphone permission was granted during QA.
- Imported an eight-second 220 Hz mono WAV through the actual file picker: 220 Hz median, eight-second duration, and approximately 100% voiced coverage.
- All three visualizations render analyzed data. Live recording uses spectrum labeling; completed pitch/spectrogram views remain distinct.
- Note selection and reference-tone start/stop work. Saved maps open and delete. Temporary test maps were removed afterward.
- JSON export produced a file in Downloads; parsed payload verified app/source, 220 Hz pitch, eight-second duration, and no raw sample array. The browser automation download-event waiter timed out despite the successful file write, so filesystem verification was used.
- Simulated denied microphone access displays a helpful error. A pending permission request can be cancelled and the studio returns to ready state.
- Desktop (~1264 px), tablet (900 px), and mobile (390 px) screenshots inspected. Mobile practice and chart layout reviewed; no horizontal page overflow. Note charts may scroll within their own region for wider ranges.
- Native modal keyboard/focus behavior, semantic buttons, accessible chart descriptions, focus styles, and reduced-motion styling implemented. Programmatic scroll also honors reduced motion.
- Invalid persisted analysis entries are rejected by nested-field validation.
- Dependency audit passed with no known vulnerabilities after updating Vitest.

## Remaining validation

The app is a working first implementation, not a clinically validated assessment. Ordinary human speech across diverse voice qualities, microphones, rooms, and browsers still needs benchmark evaluation. Synthetic accuracy does not establish real-world accuracy. Safari/Firefox and physical mobile microphones were not tested here. A full assistive-technology and WCAG audit has not been conducted.

## Voice-responsive recording update

- Added a real RMS/peak-driven orb and 40-bar recent input history, with a 400 ms status hold to avoid flickering between syllables. Silence rests at the minimum bar height; the orb never runs a decorative pulse.
- Browser test using a synthetic input: silence produced 3 px bars; a quiet tone produced ~23 px bars; a louder tone ~41 px bars. Returning to silence restored the baseline. Muting the synthetic track displayed “Microphone is muted.”
- Explicit mic selection passed the exact selected device ID to capture. Mic check created no map; transition to recording stopped previous tracks and started a fresh capture. The completed 180 Hz recording measured 180 Hz. All tracks ended after stop.
- A silent 7.3-second browser recording produced specific quiet-input guidance, captured duration, input dBFS, and 0% reliable pitch, rather than only a generic insufficient-pitch message.
- Mic check is bounded to 30 seconds, recording to 60 seconds, including a wall-clock release timer for stalled inputs. Worklet tests verify actual sample duration, final flush, retained recording samples, and no raw preview sample messages.
- Pitch-analysis windows shortened from 128 ms to 50 ms. Confidence and silence thresholds unchanged. Six new DSP regressions verify rapidly varying contours (<0.5-semitone retained-frame error), sample-rate endpoints, and noise rejection. All 29 tests pass (24 DSP + 5 input capture).
- Desktop and 390 px mobile feedback inspected. Mobile page reflows without horizontal overflow; recording button text wrapping corrected.
- No physical user microphone was recorded during this QA. The cause of the user's earlier failed recordings is not established; the input monitor and device selector make it observable.

## Scale-agnostic frequency and rainbow update

- Default display uses unrounded Hz values, equal-width frequency bands, Hz span, and a continuous reference-frequency slider. The optional Musical scale switch restores chromatic note labels and note practice without altering the measured contour. Its on/off preference survived a browser reload.
- Fixed logarithmic 60–8,000 Hz colors are shared by spectrum, spectrogram, pitch points, and frequency bars. Spectrogram brightness uses a common relative-power reference across time; stronger energy approaches white. Frequency and relative-energy legends are separate. No resonance Q measurement is claimed.
- All 38 tests pass: 24 DSP, 5 input capture, 7 frequency-distribution, and 2 palette tests. New tests cover raw-Hz binning, percentile edges, outliers, narrow spans, invalid inputs, consistent hue, and increasing brightness. Final TypeScript/Vite production build passes.
- Browser inspection verified all three charts, switching between Hz and musical labels, a continuously selected 164.655 Hz reference (displayed as 164.7 Hz), and reference-tone start/stop behavior. A clean page loaded and analyzed the generated example with no console errors.
- Desktop and 390 px mobile spectrum/spectrogram and practice layouts inspected. Separate legends remain legible, the mobile practice heading spacing was corrected, and there is no horizontal page overflow (375 px content width including the browser's scrollbar allowance). Wide frequency maps scroll internally.
- QA used the labeled generated example. No new physical microphone recording or human-speech accuracy claim was made for this update.

## GitHub handoff preparation

- Verified a clean source copy with `npm ci`, all 38 tests, and the production build. This did not reuse the development folder’s installed dependencies.
- Added Node engine constraints, `.nvmrc`, developer handoff, and repository guidance. Source control excludes dependencies, build output, environment files, logs, and coverage.
- GitHub Actions is not active: the existing OAuth login lacks `workflow` scope. The verified build/test workflow is included as `docs/github-actions-ci.yml` for later activation with appropriate permissions.
