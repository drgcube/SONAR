# Working on SONAR

Start with `README.md`, `docs/handoff.md`, and `docs/verification.md` for setup, architecture, and current limitations.

- Use Node 22 (`nvm use`), install with `npm ci`, and run `npm test` plus `npm run build` for code changes.
- Keep capture, pitch estimation, spectrum energy, and display color separate. Input feedback must respond to measured captured audio, even when pitch detection fails.
- Preserve raw frequency estimates. Musical-note labels are optional; Hz practice tones must remain unsnapped.
- Keep processing local by default. Recording samples are not uploaded or persisted. Saved maps and exports contain derived voice data; new sharing or server integrations need an explicit product decision and user controls.
- Unobserved pitches describe one sample. Do not present them as evidence of trauma, weakness, hearing loss, or psychological blocks. Confidence is an algorithm score; spectral brightness does not measure resonance Q.
- Preserve the visual direction in `docs/design-direction.md`. Avoid decorative divider lines between navigation and the introduction. Inspect desktop and mobile renders after visual changes.
- Never commit credentials, `.env` files, real recordings, generated exports, `node_modules`, or build output. Use synthesized fixtures for tests.
- Keep integration documentation accurate. There is currently no backend, public SDK, or JSON-report import flow.
