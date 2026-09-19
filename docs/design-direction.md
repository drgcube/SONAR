# SONAR — direction and product brief

Audience: people curious about their speaking voice and expressive range. The primary journey is to record 30–60 seconds, see an acoustic portrait, understand pitch use in that sample, and optionally explore a comfortable note.

Brand evidence: SONAR project name and the owner's hearing/voice research inspiration. No existing assets or visual references supplied. Proposed direction: a quiet acoustic instrument on warm paper, with ink-dark spectral plotting, persimmon accents, generous margins, and an editorial serif headline. It should feel exploratory and precise, never diagnostic.

Identity: an abstract set of radiating acoustic arcs. No stock wellness imagery. Cream continuous page background joins navigation and introductory content without rules. A functional dark chart surface clarifies where measured data lives. Use Instrument Serif for expressive headings and a system sans for readable controls, with system monospace for measurements; external font optional with fallbacks.

Content sequence: restrained navigation; short invitation and privacy cue; capture controls alongside a large spectrum/spectrogram/pitch plot; metrics and chromatic note-use map; individualized listening/humming practice; locally saved sessions; methodology and research context.

Interaction: microphone capture or local audio upload; clearly labeled generated example; pause-free recording with explicit stop; note selection and low-volume tone playback; save/delete session summaries and export report. Motion only communicates recording or played notes. Respect reduced motion.

Responsive: broad two-column instrument at desktop; stacked chart and capture at mobile. Controls wrap, charts fit the viewport, and note bins scroll only within their own region when required. Visible keyboard focus and text equivalents for canvas charts.

Scientific boundary: harmonic spectrum and fundamental pitch are different measurements. A short speech sample is not a singing range test. Low-use bins describe only the sample and do not imply weakness, hearing loss, trauma, subconscious blocks, or a need to hit all notes. Research inspiration is attributed, not presented as clinical validation or affiliation.

Implementation: local React + TypeScript + Vite application, Web Audio API, in-browser FFT and fundamental-pitch analysis, localStorage summaries (only on explicit save), no server upload. Tests cover meaningful DSP behavior and core browser journeys. Desktop and mobile rendered inspection required.

## Recording feedback refinement

Add measured input feedback adjacent to the recording control: a small responsive microphone orb plus a short history of input level bars. Motion follows actual captured signal, including sound without detectable pitch, and rests when input is silent; it is never a decorative recording loop. Show the active microphone, input level, captured duration, and separate quiet/muted/interrupted states. A user-initiated mic check provides the same feedback without retaining a recording. Preserve the existing warm-paper instrument direction and continuous page composition.

## Scale-agnostic and rainbow views

Default to continuous frequency in Hz, with a Musical scale switch for optional chromatic note labels and note-based references. The raw pitch contour and recording remain unchanged. In frequency mode, histogram bands and freely chosen reference tones use measured Hz, without semitone snapping. Rainbow hue is a fixed logarithmic frequency key (60 Hz red through 8 kHz violet), consistent across the spectrum and spectrogram. Spectrum height encodes energy; spectrogram power controls brightness toward white. Add explicit legends so visual intensity is readable without confusing frequency, power, or Q-factor. Q-factor is not estimated by this app.
