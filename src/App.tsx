import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, AudioLines, Check, CheckCheck, ChevronRight, CircleHelp, Download, Headphones, LoaderCircle, Mic, Plus, ShieldCheck, Square, Trash2, Upload, Volume2, X } from 'lucide-react';
import VoiceChart from './components/VoiceChart';
import InputMonitor from './components/InputMonitor';
import type { ChartMode } from './components/VoiceChart';
import { analyzeAudio, generateDemoAudio, hzToMidi, midiToHz, noteName } from './audio/analysis';
import type { AnalysisResult, NoteBin } from './audio/analysis';
import { frequencyBands } from './audio/frequencyView';
import { frequencyColor } from './audio/spectrumColors';
import { decodeAudioFile, playTone, stopTone, useVoiceRecorder } from './audio/useVoiceRecorder';

type Source = 'recording' | 'upload' | 'example';
type Session = { id: string; createdAt: string; name: string; source: Source; result: AnalysisResult };
const SESSION_KEY = 'sonar.sessions.v1';
const SCALE_KEY = 'sonar.musicalScale.v1';
function readMusicalScale() { try { return localStorage.getItem(SCALE_KEY) === 'true'; } catch { return false; } }
const prompts = {
  read: { label: 'Read aloud', title: 'Let your natural voice lead.', text: '“There is no one else with a voice quite like mine. I can be soft, I can be certain, and I can take up a little more space. Today, I am curious about what I might discover.”', hint: 'Read this twice, at your own pace. Let the words feel natural.' },
  speak: { label: 'Speak freely', title: 'Tell us about a good moment.', text: 'Think of a place where you feel completely at ease. What can you see? What can you hear? What makes it feel like you?', hint: 'Speak naturally for 30–60 seconds. There is no right way to sound.' },
  hum: { label: 'Gentle hum', title: 'Follow a comfortable sound.', text: 'Begin with an easy “mmm.” Let it settle, then gently glide a little higher and lower. Stay within what feels effortless.', hint: 'Take pauses to breathe. No need to push your range.' },
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finiteBetween(value: unknown, minimum: number, maximum = Infinity): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function validAnalysis(value: unknown): value is AnalysisResult {
  if (!isRecord(value) || !finiteBetween(value.duration, Number.MIN_VALUE, 120)
    || !finiteBetween(value.sampleRate, 2000, 384000)
    || !finiteBetween(value.voicedSeconds, 0, value.duration + 1e-6)
    || !finiteBetween(value.voicedRatio, 0, 1 + 1e-6)
    || !finiteBetween(value.clippingRatio, 0, 1) || !finiteBetween(value.rms, 0)
    || typeof value.quality !== 'string' || !['good', 'limited', 'insufficient'].includes(value.quality)) return false;
  if (![value.medianHz, value.lowHz, value.highHz].every(n => n === null || finiteBetween(n, 60, 1000))
    || !(value.rangeSemitones === null || finiteBetween(value.rangeSemitones, 0, 60))) return false;
  const duration = value.duration;
  if (!Array.isArray(value.notes) || value.notes.length > 128 || !value.notes.every(note =>
    isRecord(note) && finiteBetween(note.midi, 0, 127) && Number.isInteger(note.midi)
    && typeof note.label === 'string' && note.label.length > 0 && note.label.length <= 12
    && finiteBetween(note.frequency, 40, 2000) && finiteBetween(note.seconds, 0, duration + 1e-6)
    && finiteBetween(note.percent, 0, 100 + 1e-6))) return false;
  if (!(value.suggestedMidi === null || (finiteBetween(value.suggestedMidi, 0, 127)
    && Number.isInteger(value.suggestedMidi) && value.notes.some(note => note.midi === value.suggestedMidi)))) return false;
  if (!Array.isArray(value.frames) || value.frames.length > 4000 || !value.frames.every(frame =>
    isRecord(frame) && finiteBetween(frame.time, 0, duration + 1e-6)
    && finiteBetween(frame.frequency, 60, 1000) && finiteBetween(frame.midi, 0, 127)
    && finiteBetween(frame.confidence, 0, 1))) return false;
  if (!Array.isArray(value.spectrum) || value.spectrum.length !== 1024
    || !value.spectrum.every(db => finiteBetween(db, -80, 0))) return false;
  return Array.isArray(value.spectrogram) && value.spectrogram.length > 0 && value.spectrogram.length <= 180
    && value.spectrogram.every(column => Array.isArray(column) && column.length === 128
      && column.every(db => finiteBetween(db, -80, 0)));
}
function readSessions(): Session[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((session): session is Session => isRecord(session)
      && typeof session.id === 'string' && session.id.length > 0 && session.id.length <= 128
      && typeof session.createdAt === 'string' && Number.isFinite(Date.parse(session.createdAt))
      && typeof session.name === 'string' && session.name.length > 0 && session.name.length <= 200
      && typeof session.source === 'string' && ['recording', 'upload', 'example'].includes(session.source)
      && validAnalysis(session.result)).slice(0, 8);
  } catch { return []; }
}
const motionBehavior = (): ScrollBehavior => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
const seconds = (n: number) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
function Mark({ small = false }: { small?: boolean }) { return <svg className={small ? 'sonar-mark small' : 'sonar-mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M8 5a21 21 0 0 1 0 30M16 10a14 14 0 0 1 0 20M24 15a7 7 0 0 1 0 10" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" /></svg>; }

export default function App() {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [source, setSource] = useState<Source>('recording');
  const [mode, setMode] = useState<ChartMode>('spectrum');
  const [musicalScale, setMusicalScale] = useState(readMusicalScale);
  const [selectedFrequency, setSelectedFrequency] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<keyof typeof prompts>('read');
  const [selectedMic, setSelectedMic] = useState('');
  const [promptOpen, setPromptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedMidi, setSelectedMidi] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [sessions, setSessions] = useState<Session[]>(readSessions);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [modal, setModal] = useState<'guide' | 'sessions' | null>(null);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const studio = useRef<HTMLElement>(null);
  const practice = useRef<HTMLElement>(null);
  const modalRef = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopTone(); }; }, []);
  async function processAudio(samples: Float32Array, sampleRate: number, nextSource: Source) {
    if (lock.current || !mounted.current) return;
    lock.current = true; setBusy(true); setProgress(0); setError(null); setNotice('');
    try {
      const analysis = await analyzeAudio(samples, sampleRate, value => { if (mounted.current) setProgress(value); });
      if (!mounted.current) return;
      setResult(analysis); setSource(nextSource); setSavedId(null);
      setSelectedFrequency(analysis.medianHz);
      setSelectedMidi(analysis.suggestedMidi ?? (analysis.medianHz ? Math.round(hzToMidi(analysis.medianHz)) : null));
      setNotice(nextSource === 'example' ? 'Example ready. This is generated audio, not a recording of you.' : analysis.quality === 'insufficient' ? 'Audio analyzed. Check the recording feedback below for the next step.' : 'Your voice map is ready to explore.');
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : 'We couldn’t analyze this audio. Please try another recording.'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const recorder = useVoiceRecorder((samples, sampleRate) => { void processAudio(samples, sampleRate, 'recording'); });
  const recording = recorder.status === 'recording';
  const checking = recorder.status === 'checking';
  const monitoring = recording || checking;
  const effectiveMode: ChartMode = monitoring ? 'spectrum' : mode;
  const occupied = busy || recorder.status !== 'idle';
  useEffect(() => { if (recording) { setPromptOpen(true); setResult(null); setSelectedFrequency(null); setSelectedMidi(null); setSavedId(null); setNotice(''); } }, [recording]);
  useEffect(() => { if (!modal) return; const el = modalRef.current; if (el && !el.open) el.showModal(); return () => { el?.close(); }; }, [modal]);
  useEffect(() => { if (!notice) return; const id = window.setTimeout(() => setNotice(''), 6500); return () => clearTimeout(id); }, [notice]);
  async function example() { if (occupied) return; stopTone(); setPlaying(false); recorder.clearError(); const demo = generateDemoAudio(); await processAudio(demo.samples, demo.sampleRate, 'example'); }
  async function startRecording() {
    if ((occupied && !checking) || lock.current) return;
    stopTone(); setPlaying(false); setError(null); recorder.clearError();
    if (checking) await recorder.stop();
    if (mounted.current) await recorder.start(selectedMic || undefined, 'record');
  }
  async function toggleMicCheck() {
    if (checking) { await recorder.stop(); return; }
    if (occupied || lock.current) return;
    stopTone(); setPlaying(false); setError(null); recorder.clearError();
    await recorder.start(selectedMic || undefined, 'check');
  }
  async function upload(file?: File) {
    if (!file || occupied) return;
    stopTone(); setPlaying(false); setBusy(true); setProgress(0); setError(null); recorder.clearError();
    try { const decoded = await decodeAudioFile(file); if (!mounted.current) return; await processAudio(decoded.samples, decoded.sampleRate, 'upload'); }
    catch (err) { if (mounted.current) { setError(err instanceof Error ? err.message : 'This audio file could not be opened.'); setBusy(false); } }
    finally { if (fileInput.current) fileInput.current.value = ''; }
  }
  function toggleMusicalScale() {
    stopTone(); setPlaying(false);
    const next = !musicalScale; setMusicalScale(next);
    try { localStorage.setItem(SCALE_KEY, String(next)); } catch { /* View still works without persistence. */ }
  }
  function selectFrequency(hz: number) {
    if (!Number.isFinite(hz) || result?.lowHz == null || result.highHz == null) return;
    stopTone(); setPlaying(false);
    setSelectedFrequency(Math.max(result.lowHz, Math.min(result.highHz, hz)));
  }
  async function hearNote() {
    if (playing) { stopTone(); setPlaying(false); return; }
    if (toneHz === null || occupied) return;
    setPlaying(true);
    try { await playTone(toneHz, 2); } catch { setError('Audio playback is unavailable. Check your browser’s sound permissions.'); }
    finally { if (mounted.current) setPlaying(false); }
  }
  function saveSession() {
    if (!result || savedId) return;
    const id = crypto.randomUUID();
    const session: Session = { id, createdAt: new Date().toISOString(), name: source === 'example' ? 'Example voice map' : source === 'upload' ? 'Imported voice map' : 'My voice map', source, result };
    const next = [session, ...sessions].slice(0, 8);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); setSessions(next); setSavedId(id); setNotice('Voice map saved on this device. Audio is not stored.'); }
    catch { setError('Your browser could not save this map. You can still download the report.'); }
  }
  function deleteSession(id: string) { const next = sessions.filter(s => s.id !== id); try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); setSessions(next); if (savedId === id) setSavedId(null); } catch { setError('Your browser could not remove this map.'); } }
  function openSession(session: Session) { stopTone(); setPlaying(false); setResult(session.result); setSource(session.source); setSavedId(session.id); setSelectedFrequency(session.result.medianHz); setSelectedMidi(session.result.suggestedMidi ?? (session.result.medianHz ? Math.round(hzToMidi(session.result.medianHz)) : null)); setModal(null); setError(null); studio.current?.scrollIntoView({ behavior: motionBehavior(), block: 'start' }); }
  function exportReport() {
    if (!result) return;
    const blob = new Blob([JSON.stringify({ app: 'SONAR', version: 1, exportedAt: new Date().toISOString(), source, displayMode: musicalScale ? 'musical-notes' : 'frequency-hz', description: 'Descriptive acoustic analysis of one audio sample. Notes not observed in this sample do not indicate vocal inability, hearing loss, trauma, or psychological weakness. Not a clinical assessment.', analysis: result }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `sonar-${source}-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 10000); setNotice('Your JSON report is ready. Check your browser’s downloads.');
  }
  const bins: NoteBin[] = result?.notes.length ? result.notes : Array.from({ length: 13 }, (_, i) => ({ midi: 48 + i, label: noteName(48 + i), frequency: midiToHz(48 + i), seconds: 0, percent: 0 }));
  const maxPercent = Math.max(1, ...bins.map(n => n.percent));
  const selectedNote = result?.notes.find(n => n.midi === selectedMidi);
  const insufficient = result?.quality === 'insufficient';
  const toneHz = musicalScale ? selectedMidi === null ? null : midiToHz(selectedMidi) : selectedFrequency;
  const toneLabel = toneHz === null ? '' : musicalScale ? noteName(selectedMidi!) : `${toneHz.toFixed(1)} Hz`;
  const canPractice = !!result && !insufficient && toneHz !== null;
  const bands = frequencyBands(result);
  const bandPrecision = bands.length > 1 && result?.lowHz != null && result.highHz != null && (result.highHz - result.lowHz) < 12 ? (result.highHz - result.lowHz) < 1.2 ? 3 : 2 : 1;
  const maxBandPercent = Math.max(1, ...bands.map(band => band.percent));
  const outsidePercent = result ? Math.max(0, 100 - (musicalScale ? result.notes : bands).reduce((total, bin) => total + bin.percent, 0)) : 0;
  const plotTitle = { spectrum: 'The shape of your sound', spectrogram: 'Your sound, over time', pitch: 'The path of your pitch' }[effectiveMode];

  return <>
    <header className="site-header">
      <a href="#" className="brand" aria-label="Sonar home"><Mark /><span>SONAR<span className="brand-descriptor">VOICE EXPLORATION STUDIO</span></span></a>
      <nav aria-label="Main navigation"><a className="nav-active" href="#studio">Your studio</a><a href="#practice">Practice</a><button onClick={() => setModal('sessions')}>Saved sessions{sessions.length > 0 && <span className="nav-count">{sessions.length}</span>}</button></nav>
      <button className="guide-button" aria-label="A little guidance" onClick={() => setModal('guide')}><CircleHelp size={17} /><span>A little guidance</span></button>
    </header>

    <main className="page-shell">
      <section className="intro" aria-labelledby="intro-title">
        <div><div className="eyebrow"><span className="tiny-star">✳</span> A NEW WAY TO KNOW YOUR VOICE</div><h1 id="intro-title">Meet your <em>voice.</em></h1><p>Listen with curiosity. See your sound. Explore what’s possible.</p></div>
        <div className="intro-aside"><div className="privacy-symbol"><ShieldCheck size={20} /></div><p>Just you and your voice.<span>Your audio stays in your browser.</span></p></div>
      </section>

      <section ref={studio} id="studio" className="studio" aria-label="Voice recording and analysis">
        <div className="visual-panel">
          <div className="visual-heading"><div><div className="eyebrow muted">01 / YOUR VOCAL LANDSCAPE</div><h2>{plotTitle}</h2></div><span className={`status-pill ${monitoring ? 'is-recording' : ''}`}><span />{checking ? 'Checking microphone' : recording ? 'Recording · live input' : busy ? 'Mapping your voice' : result ? source === 'example' ? 'Generated example' : 'Your voice map' : 'Ready to listen'}</span></div>
          <div className="chart-controls"><div className="chart-tabs" role="group" aria-label="Visualization"><button aria-pressed={effectiveMode === 'spectrum'} onClick={() => setMode('spectrum')}>Spectrum</button><button aria-pressed={effectiveMode === 'spectrogram'} disabled={monitoring} onClick={() => setMode('spectrogram')}>Spectrogram</button><button aria-pressed={effectiveMode === 'pitch'} disabled={monitoring} onClick={() => setMode('pitch')}>Pitch contour</button></div><button className="scale-toggle" role="switch" aria-label="Musical scale" aria-checked={musicalScale} onClick={toggleMusicalScale}><span className="scale-toggle-track" aria-hidden="true"><i/></span><span>Musical scale <b>{musicalScale ? 'On' : 'Off'}</b></span></button></div><p className="scale-caption">{musicalScale ? 'Note labels · chromatic scale · A4 = 440 Hz' : 'Continuous frequencies in Hz · no note snapping'}</p>
          <div className="chart-wrap"><VoiceChart result={monitoring ? null : result} mode={effectiveMode} musicalScale={musicalScale} liveSpectrum={recorder.liveSpectrum} recording={monitoring} sampleRate={recorder.sampleRate ?? undefined} />{busy && <div className="analysis-overlay" role="status"><LoaderCircle className="spin" size={26}/><span>Finding the shape of your voice…</span><small>{progress > 0 ? `${Math.round(progress * 100)}% analyzed` : 'Preparing your audio'}</small></div>}</div>
          <div className="chart-footer"><span><i />{effectiveMode === 'pitch' ? 'Fundamental pitch · voiced moments only' : effectiveMode === 'spectrogram' ? 'Frequency × time · relative spectral power' : 'Sound energy · fundamental + harmonics'}</span><span>{monitoring ? `${seconds(recorder.capturedSeconds)} ${checking ? 'MIC CHECK' : 'CAPTURED'}` : result ? `${result.duration.toFixed(1)}s SAMPLE` : 'A PORTRAIT, NOT A SCORE'}</span></div>
        </div>

        <div className="capture-panel">
          <div className="capture-top"><span className="eyebrow">LET’S BEGIN WITH YOU</span><span className="duration-label">30–60 SEC</span></div>
          <h2>Make yourself heard.</h2><p className="capture-subtitle">A small moment. A new perspective.</p>
          <div className="microphone-picker">
            <label htmlFor="microphone-input">Microphone</label>
            <div className="microphone-picker-controls">
              <select id="microphone-input" value={selectedMic} disabled={occupied} onFocus={() => { void recorder.refreshMicrophones(); }} onChange={event => setSelectedMic(event.target.value)} aria-describedby="microphone-help">
                <option value="">System default microphone</option>
                {recorder.microphones.filter(mic => mic.deviceId && mic.deviceId !== 'default').map(mic => <option key={mic.deviceId} value={mic.deviceId}>{mic.label}</option>)}
                {selectedMic && !recorder.microphones.some(mic => mic.deviceId === selectedMic) && <option value={selectedMic}>Previously selected mic · unavailable</option>}
              </select>
              <button className="mic-check-button" disabled={busy || recording || recorder.status === 'requesting'} onClick={toggleMicCheck}>{checking ? <Square size={12}/> : <AudioLines size={15}/>} {checking ? 'Stop check' : 'Check mic'}</button>
            </div>
            <p id="microphone-help">{checking ? 'Check only. No voice map is being recorded.' : monitoring ? recorder.activeDeviceLabel : recorder.microphones.some(mic => mic.deviceId && mic.deviceId !== 'default') ? 'Choose your microphone, then speak during a mic check.' : 'Check your input before recording. Device names appear after access.'}</p>
          </div>
          <div className="prompt-tabs" role="group" aria-label="Recording prompt">{(Object.keys(prompts) as (keyof typeof prompts)[]).map(key => <button key={key} aria-pressed={key === prompt} disabled={occupied} onClick={() => setPrompt(key)}>{prompts[key].label}</button>)}</div>
          <details className="prompt-content prompt-disclosure" open={promptOpen} onToggle={event => setPromptOpen(event.currentTarget.open)}><summary>{prompts[prompt].title}</summary><p>{prompts[prompt].text}</p></details>
          <p className="recording-hint">{prompts[prompt].hint}</p>
          <InputMonitor active={recording} checking={checking} inputState={recorder.inputState} level={recorder.level} peak={recorder.peak} history={recorder.signalHistory} elapsed={recorder.capturedSeconds} deviceLabel={monitoring ? recorder.activeDeviceLabel : selectedMic ? recorder.microphones.find(mic => mic.deviceId === selectedMic)?.label || 'Selected microphone' : 'System default microphone'} />
          <button className={`record-button ${recording ? 'recording' : ''}`} onClick={recording || recorder.status === 'requesting' ? recorder.stop : startRecording} disabled={busy}>{recording ? <Square size={16} fill="currentColor" /> : busy || recorder.status === 'requesting' ? <LoaderCircle className="spin" size={18} /> : <Mic size={19}/>}<span>{recording ? 'Finish recording' : recorder.status === 'requesting' ? 'Cancel microphone request' : busy ? 'Analyzing audio…' : checking ? 'Record with this mic' : result ? 'Record a new moment' : 'Start recording'}</span>{!recording && !busy && recorder.status !== 'requesting' && <ArrowRight size={17} />}</button>
          <div className="alternative-actions"><button onClick={() => fileInput.current?.click()} disabled={occupied}><Upload size={14}/>Import audio</button><span>or</span><button onClick={example} disabled={occupied}>Try an example<ArrowUpRight size={14}/></button></div>
          <input ref={fileInput} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac" className="sr-only" aria-label="Import an audio recording" onChange={event => { void upload(event.target.files?.[0]); }} tabIndex={-1} />
        </div>
      </section>
      {(error || recorder.error) && <div className="error-banner" role="alert"><CircleHelp size={18}/><span>{error || recorder.error}</span><button aria-label="Dismiss error" onClick={() => { setError(null); recorder.clearError(); }}><X size={18}/></button></div>}
      <div className="metrics-row" aria-label="Voice summary">
        <div className="metric"><span>Typical pitch<CircleHelp size={13}><title>Median fundamental frequency of voiced frames</title></CircleHelp></span><strong>{result?.medianHz ? musicalScale ? Math.round(result.medianHz) : result.medianHz.toFixed(1) : '—'}<small>Hz</small></strong><p>{result?.medianHz ? musicalScale ? `Around ${noteName(Math.round(hzToMidi(result.medianHz)))} in this sample` : 'Median frequency · no note rounding' : 'Your voice’s natural center'}</p></div>
        <div className="metric"><span>Observed pitch span</span><strong>{result?.lowHz != null && result.highHz != null ? musicalScale ? result.rangeSemitones?.toFixed(1) : (result.highHz - result.lowHz).toFixed(1) : '—'}<small>{musicalScale ? 'semitones' : 'Hz'}</small></strong><p>{result?.lowHz && result.highHz ? `${Math.round(result.lowHz)}–${Math.round(result.highHz)} Hz · middle 90% of pitches` : 'The pitches you visit as you speak'}</p></div>
        <div className="metric"><span>Voiced moments</span><strong>{result ? result.voicedSeconds.toFixed(1) : '—'}<small>seconds</small></strong><p>{result ? `${Math.round(result.voicedRatio * 100)}% of your ${result.duration.toFixed(1)}s sample` : 'Clear, steady sound we can explore'}</p></div>
        <div className="metric-note"><AudioLines size={23}/><p>{result ? source === 'example' ? 'You’re exploring a generated example. Record your voice to make it personal.' : insufficient ? result.rms < 0.002 ? 'The captured input was very quiet. Check the microphone and its level.' : 'Sound was captured. There wasn’t enough steady pitch for a voice map.' : 'One moment of your voice. A starting point for exploration.' : 'Every voice has its own landscape. Let’s discover yours.'}</p></div>
      </div>
      {result && source !== 'example' && (result.quality !== 'good' || result.clippingRatio > 0.01) && <div className="quality-note" role="status"><CircleHelp size={18}/><div><strong>{result.clippingRatio > 0.01 ? 'The input was too loud' : result.rms < 0.002 ? 'The recorded input was very quiet' : insufficient ? 'Audio was captured, but pitch was unclear' : 'A little more speech will help'}</strong><p>{result.clippingRatio > 0.01 ? 'Move farther from the microphone or lower its input volume, then check the meter again.' : result.rms < 0.002 ? 'Use Check mic and speak normally. If the bars stay flat, choose a different microphone or check its mute switch and system input volume.' : insufficient ? `${result.duration.toFixed(1)} seconds of audio reached the recorder, but only ${result.voicedSeconds.toFixed(1)} seconds had a reliable pitch. Check the selected mic, reduce background sound, and try a few seconds of a comfortable “mmm” before speaking normally.` : 'Record 30–60 seconds of clear speech, with the input bars responding as you talk.'}</p><small>{result.duration.toFixed(1)}s captured · {result.rms > 0.0001 ? `${Math.round(20 * Math.log10(result.rms))} dBFS` : 'below −80 dBFS'} average input · {Math.round(result.voicedRatio * 100)}% reliable pitch</small></div><button className="text-action" disabled={occupied} onClick={() => { studio.current?.scrollIntoView({behavior:motionBehavior()}); void toggleMicCheck(); }}>Check mic<ArrowUpRight size={14}/></button></div>}

      <section className="pitch-section" aria-labelledby="pitch-title">
        <div className="section-heading"><div><div className="eyebrow">02 / {musicalScale ? 'YOUR PITCH PALETTE' : 'YOUR FREQUENCY MAP'}</div><h2 id="pitch-title">{musicalScale ? 'Notice the notes you visit.' : 'Explore your voice, without a scale.'}</h2></div><button className="text-action" onClick={() => setModal('guide')}>How to read your map<ArrowUpRight size={15}/></button></div>
        <p className="section-description">{musicalScale ? result ? 'Notes across your central pitch range. Each bar shows its share of all voiced moments. Select a note to explore.' : 'Some notes feel familiar. Others are less traveled. Your recording will reveal the pattern.' : result ? 'Your measured pitches, grouped into equal-width frequency bands. Select a band, then explore any frequency within your observed span.' : 'See your voice in Hz, with no musical notes or fixed scale. Record a moment to reveal the frequencies you visit.'}</p>
        <div className="note-map" aria-label={musicalScale ? "Distribution of detected pitches" : "Distribution of measured frequencies"}>{musicalScale ? (<div className="note-bars" style={{ gridTemplateColumns: `repeat(${bins.length}, minmax(30px, 1fr))` }}>{bins.map(n => <button key={n.midi} className={`note-bin ${selectedMidi === n.midi ? 'selected' : ''} ${result?.suggestedMidi === n.midi ? 'suggested' : ''}`} disabled={!result || insufficient || occupied} aria-pressed={selectedMidi === n.midi} aria-label={`${n.label}, ${n.percent.toFixed(1)} percent of voiced time${result?.suggestedMidi === n.midi ? ', less-used note to explore' : ''}`} onClick={() => { stopTone(); setPlaying(false); setSelectedMidi(n.midi); }}><span className="note-percent">{result ? `${Math.round(n.percent)}%` : ''}</span><span className="bar-slot"><span className="note-fill" style={{ height: result ? `${Math.max(3, n.percent / maxPercent * 100)}%` : '3px' }}/></span><span className="note-label">{n.label}</span><span className="note-dot">{result?.suggestedMidi === n.midi ? '•' : ''}</span></button>)}</div>) : bands.length > 0 ? (
          <div className="note-bars frequency-bars" style={{ gridTemplateColumns: `repeat(${bands.length}, minmax(44px, 1fr))` }}>{bands.map((band, index) => {
            const selected = selectedFrequency !== null && selectedFrequency >= band.lowHz && (selectedFrequency < band.highHz || index === bands.length - 1 && selectedFrequency <= band.highHz);
            return <button key={index} className={`note-bin frequency-bin ${selected ? 'selected' : ''}`} disabled={insufficient || occupied} aria-pressed={selected} aria-label={`${band.lowHz.toFixed(bandPrecision)} to ${band.highHz.toFixed(bandPrecision)} hertz, ${band.percent.toFixed(1)} percent of voiced time`} onClick={() => selectFrequency(band.centerHz)}><span className="note-percent">{Math.round(band.percent)}%</span><span className="bar-slot"><span className="note-fill" style={{ height: `${Math.max(3, band.percent / maxBandPercent * 100)}%`, background: frequencyColor(band.centerHz, selected ? 1 : 0.62) }}/></span><span className="note-label">{band.centerHz.toFixed(bandPrecision)}</span><span className="frequency-unit">Hz</span></button>;
          })}</div>
        ) : <div className="frequency-empty"><AudioLines size={26}/><div><strong>{result ? 'No reliable frequencies to map yet' : 'Your frequencies will appear here'}</strong><p>{result ? 'Use the input check, then record clear speech or a comfortable hum.' : 'The map will follow your measured voice, without snapping it to musical notes.'}</p></div></div>}
          <div className="note-map-footer"><span>{musicalScale ? <><i className="legend-more"/>More visited<i className="legend-less"/>Less visited</> : 'Bar height = time spent · hue = frequency'}</span><span>{result ? !result.frames.length ? 'NO RELIABLE PITCHES TO MAP' : `${outsidePercent.toFixed(1)}% OUTSIDE THIS VIEW · NOT YOUR FULL RANGE` : 'YOUR MAP WILL APPEAR AFTER RECORDING'}</span></div>
        </div>
        <div className="pitch-explainer"><span><Plus size={15}/>{musicalScale ? 'A less-used note is an invitation to explore, never a sign that something is missing in you.' : 'The bars summarize a continuous signal. There is no scale to complete or ideal pattern to match.'}</span>{result && <div className="report-actions"><button onClick={saveSession} disabled={!!savedId || occupied}>{savedId ? <CheckCheck size={15}/> : <Plus size={15}/>} {savedId ? 'Saved on device' : 'Save voice map'}</button><button onClick={exportReport} disabled={occupied} aria-label="Download voice analysis report"><Download size={16}/><span>Export</span></button></div>}</div>
      </section>

      <section ref={practice} id="practice" className="practice-section" aria-labelledby="practice-title">
        <div className="practice-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="practice-art-center">{canPractice ? musicalScale ? noteName(selectedMidi!) : <span className="orb-hz">{toneHz!.toFixed(1)}<small>Hz</small></span> : <AudioLines size={33}/>}</div><span className="orbit-caption">A LITTLE MORE POSSIBILITY</span></div>
        <div className="practice-copy"><div className="eyebrow">03 / ROOM TO EXPLORE</div><h2 id="practice-title">{canPractice ? <>{musicalScale ? <>Get curious about <em>{toneLabel}.</em></> : <>Find a frequency.<br/>{' '}<em>Follow your voice.</em></>}</> : <>Let curiosity<br/>lead the way.</>}</h2><p>{canPractice ? musicalScale ? `${selectedNote ? `${noteName(selectedMidi!)} appeared in ${selectedNote.percent.toFixed(1)}% of this sample’s voiced moments. ` : ''}Listen, then try a soft, comfortable hum. You can always choose another note above.` : 'Choose any frequency in your central observed range. Listen to the reference, then try an easy hum. The tone follows your selection without snapping to a musical scale.' : `Begin with a voice map. Then listen to a ${musicalScale ? 'note' : 'frequency'} within your observed range and meet it with a gentle hum.`}</p><div className="practice-steps"><span><b>1</b>Listen</span><ChevronRight size={13}/><span><b>2</b>Hum gently</span><ChevronRight size={13}/><span><b>3</b>Explore again</span></div></div>
        <div className="practice-action">{canPractice ? <><span className="practice-frequency">{toneHz!.toFixed(1)} <small>Hz</small></span>{!musicalScale && result?.lowHz != null && result.highHz != null && <div className="frequency-tuner"><label htmlFor="reference-frequency">Reference frequency</label><input id="reference-frequency" type="range" min={result.lowHz} max={result.highHz} step="any" value={toneHz!} disabled={occupied || result.highHz <= result.lowHz} onChange={event => selectFrequency(Number(event.target.value))} aria-valuetext={`${toneHz!.toFixed(1)} hertz`} /><div><span>{result.lowHz.toFixed(1)} Hz</span><span>{result.highHz.toFixed(1)} Hz</span></div></div>}<button className="secondary-button" onClick={hearNote} disabled={occupied}>{playing ? <Square size={16}/> : <Volume2 size={18}/>} {playing ? 'Stop tone' : `Listen to ${toneLabel}`}</button><p>Low volume. Easy breath.<br/>Stay where your voice feels at ease.</p><button className="practice-record text-action" onClick={() => { setPrompt('hum'); studio.current?.scrollIntoView({ behavior: motionBehavior() }); }}>Make another voice map<ArrowUpRight size={14}/></button></> : <><Headphones size={26}/><p>Your first exploration<br/>starts with a little listening.</p><button className="secondary-button" onClick={() => studio.current?.scrollIntoView({ behavior: motionBehavior() })}>Create your voice map<ArrowUpRight size={16}/></button></>}</div>
      </section>
      <div className="closing-note"><ShieldCheck size={15}/><p>Private by design. Audio is processed here in your browser. Saved maps stay on this device; recordings are not stored.</p></div>
    </main>
    <footer className="site-footer"><a className="footer-brand" href="#"><Mark small/>SONAR</a><span>A little listening. A little possibility.</span><button onClick={() => setModal('guide')}>The thinking behind SONAR<ArrowUpRight size={14}/></button></footer>
    <div className={`toast ${notice ? 'show' : ''}`} role="status" aria-live="polite">{notice && <><Check size={17}/>{notice}</>}</div>

    {modal && <dialog ref={modalRef} className="modal" onCancel={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) setModal(null); }} aria-labelledby="modal-title"><div className="modal-inner"><button className="modal-close" aria-label="Close dialog" onClick={() => setModal(null)} autoFocus><X size={21}/></button><div className="eyebrow">{modal === 'guide' ? 'A LITTLE CONTEXT' : 'YOUR PRIVATE COLLECTION'}</div><h2 id="modal-title">{modal === 'guide' ? 'A portrait, not a verdict.' : 'Moments of your voice.'}</h2>{modal === 'guide' ? <div className="guide-content">
      <p>SONAR helps you observe and explore your sound. There is no ideal voice map, and everyday speech doesn’t need to cover every musical note.</p>
      <h3>Two ways of seeing your voice</h3><p><strong>Spectrum & spectrogram.</strong> These show energy across frequencies, including your fundamental pitch, harmonics, breath, and background sound. The spectrogram adds time. Hue identifies frequency using a fixed logarithmic red-to-violet key from 60 Hz to 8 kHz. In the spectrum, curve height is energy. In the spectrogram, brightness increases with relative spectral power, with the strongest areas approaching white. White marks the top of this display’s relative power range; it is not a Q-factor measurement or calibrated loudness.</p><p><strong>Pitch contour & frequency map.</strong> These estimate fundamental frequency in clear, voiced moments. Musical scale is off by default: the contour uses Hz, the map groups raw frequency estimates into equal-Hz bands, and reference tones move continuously within your observed span. When Musical scale is on, note bins use the nearest equal-tempered semitone (A4 = 440 Hz), and practice references use those note frequencies. The toggle never alters the original recording or the measured pitch contour. Typical pitch is the median; span uses the 5th–95th percentiles to reduce outliers. The frequency map spans that central interval directly; the musical note map rounds the interval outward to semitones. Both maps’ percentages use all voiced frames, so notes outside the view can leave the displayed total below 100%.</p>
      <h3>What “less visited” means</h3><p>In musical mode, with enough reliable voice data, SONAR can suggest a relatively infrequent note inside your observed pitch span. This describes one sample, not what you are capable of singing. Pauses, language, emotion, microphone quality, and pitch-tracking errors all affect the result. Quiet or noisy recordings may not support a suggestion.</p>
      <h3>Our inspiration, kept in perspective</h3><p>Alfred Tomatis explored links between hearing and voice. That history inspired this project’s curiosity. SONAR is independent of the Tomatis Method and is not a validated Tomatis assessment or therapy. Missing or uncommon pitches cannot establish trauma, harmful relationships, hearing loss, or psychological weakness.</p><p>Evidence for clinical benefits of Tomatis-style auditory interventions is limited. The Cochrane review below concerns autism interventions; it does not test this app or establish any link between pitch gaps and trauma.</p><div className="source-links"><a href="https://www.tomatis.com/en/the-tomatis-method/alfred-tomatis-the-pioneer-of-audio-psycho-phonology/" target="_blank" rel="noreferrer">Tomatis: historical background<ArrowUpRight size={14}/></a><a href="https://www.asha.org/policy/TR2004-00260/" target="_blank" rel="noreferrer">ASHA: auditory integration review<ArrowUpRight size={14}/></a><a href="https://www.cochrane.org/evidence/CD003681_auditory-integration-therapy-autism-spectrum-disorders" target="_blank" rel="noreferrer">Cochrane: review of sound therapies<ArrowUpRight size={14}/></a></div>
      <h3>Your session, on your device</h3><p>Microphone access begins only when you press Record or Check mic. The input monitor reacts to incoming audio, even when a pitch cannot be detected. Check mic runs for up to 30 seconds and keeps no recording; a recording runs for up to 60 seconds. Stopping either releases the microphone. Microphone names appear after access is granted, and you can choose an input before starting. Audio is processed in memory and never uploaded by SONAR. Only explicitly saved maps persist in this browser. Up to eight recent maps are retained; saving a ninth replaces the oldest. Import up to two minutes of browser-supported audio, up to 30 MB. The example uses generated sound.</p>
    </div> : <div className="sessions-content"><p>Saved in this browser. Your maps stay here; your raw audio does not. Up to eight recent maps are kept.</p>{sessions.length ? <div className="session-list">{sessions.map(session => <div className="session-item" key={session.id}><button className="session-open" disabled={occupied} onClick={() => openSession(session)}><AudioLines size={20}/><span><strong>{session.name}</strong><small>{new Date(session.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {session.result.duration.toFixed(1)}s</small></span><ArrowUpRight size={17}/></button><button className="session-delete" aria-label={`Delete ${session.name} from ${new Date(session.createdAt).toLocaleString()}`} onClick={() => deleteSession(session.id)}><Trash2 size={16}/></button></div>)}</div> : <div className="sessions-empty"><AudioLines size={42}/><h3>Your collection begins with one moment.</h3><p>Record or import audio, then choose “Save voice map.”</p><button className="secondary-button" onClick={() => { setModal(null); studio.current?.scrollIntoView({ behavior: motionBehavior() }); }}>Back to your studio<ArrowRight size={16}/></button></div>}</div>}</div></dialog>}
  </>;
}
