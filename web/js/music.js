// Procedural 8-Bit (NES) & 16-Bit (SNES) Web Audio API Lookahead Music Sequencer

const MUSIC_ENABLED_KEY = 'pyria_music_enabled';
const MASTER_GAIN = 0.14;
const DUCKED_MULTIPLIER = 0.3;
const LOOKAHEAD_SEC = 0.14;
const SCHEDULER_INTERVAL_MS = 50;

// MIDI note number -> frequency in Hz
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Note name helper (e.g. "C4", "F#5", "Bb3") -> MIDI number
const NOTE_OFFSETS = {
  C: 0, 'C#': 1, Db: 1,
  D: 2, 'D#': 3, Eb: 3,
  E: 4,
  F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8,
  A: 9, 'A#': 10, Bb: 10,
  B: 11,
};

function n(name) {
  if (!name || name === '-') return null;
  const m = name.match(/^([A-G][#b]?)(-?\d)$/);
  if (!m) return null;
  return (parseInt(m[2], 10) + 1) * 12 + NOTE_OFFSETS[m[1]];
}

// 3 distinct 32-step (4-bar, 8th-note) looping themes
const THEMES = {
  // Cozy heroic fantasy arpeggio (C Major / A minor)
  title: {
    bpm: 104,
    lead: [
      'E5', '-', 'G5', '-', 'C5', '-', 'D5', 'E5',
      'C5', '-', 'E5', '-', 'A4', '-', '-', '-',
      'F5', '-', 'E5', '-', 'D5', '-', 'C5', 'D5',
      'E5', '-', 'D5', '-', 'B4', '-', 'G4', '-',
    ].map(n),
    bass: [
      'C3', '-', '-', '-', 'G3', '-', '-', '-',
      'A2', '-', '-', '-', 'E3', '-', '-', '-',
      'F2', '-', '-', '-', 'C3', '-', '-', '-',
      'G2', '-', '-', '-', 'D3', '-', 'G2', '-',
    ].map(n),
    arp: [
      'C4', 'E4', 'G4', 'E4', 'C4', 'E4', 'G4', 'E4',
      'A3', 'C4', 'E4', 'C4', 'A3', 'C4', 'E4', 'C4',
      'F3', 'A3', 'C4', 'A3', 'F3', 'A3', 'C4', 'A3',
      'G3', 'B3', 'D4', 'B3', 'G3', 'B3', 'D4', 'B3',
    ].map(n),
    pad: [
      ['C4', 'E4', 'G4'], null, null, null, null, null, null, null,
      ['A3', 'C4', 'E4'], null, null, null, null, null, null, null,
      ['F3', 'A3', 'C4'], null, null, null, null, null, null, null,
      ['G3', 'B3', 'D4'], null, null, null, null, null, null, null,
    ].map((ch) => (ch ? ch.map(n) : null)),
  },

  // Bright adventurous Zelda-style overworld (G Major pentatonic feel)
  meadow: {
    bpm: 124,
    lead: [
      'G4', 'B4', 'D5', '-', 'E5', '-', 'D5', 'B4',
      'G4', '-', 'A4', 'B4', 'D5', '-', '-', '-',
      'E5', '-', 'G5', 'E5', 'D5', '-', 'B4', 'G4',
      'A4', '-', 'B4', 'A4', 'G4', '-', '-', '-',
    ].map(n),
    bass: [
      'G2', '-', 'D3', '-', 'G2', '-', 'D3', '-',
      'E2', '-', 'B2', '-', 'E2', '-', 'B2', '-',
      'C3', '-', 'G3', '-', 'C3', '-', 'G3', '-',
      'D3', '-', 'A2', '-', 'D3', '-', 'F#2', '-',
    ].map(n),
    arp: [
      'G3', 'B3', 'D4', 'B3', 'G3', 'B3', 'D4', 'B3',
      'E3', 'G3', 'B3', 'G3', 'E3', 'G3', 'B3', 'G3',
      'C4', 'E4', 'G4', 'E4', 'C4', 'E4', 'G4', 'E4',
      'D4', 'F#4', 'A4', 'F#4', 'D4', 'F#4', 'A4', 'C4',
    ].map(n),
    pad: [
      ['G3', 'B3', 'D4'], null, null, null, null, null, null, null,
      ['E3', 'G3', 'B3'], null, null, null, null, null, null, null,
      ['C4', 'E4', 'G4'], null, null, null, null, null, null, null,
      ['D4', 'F#4', 'A4'], null, null, null, null, null, null, null,
    ].map((ch) => (ch ? ch.map(n) : null)),
  },

  // Mysterious atmospheric minor-key dungeon crawler (D Minor)
  ruins: {
    bpm: 96,
    lead: [
      'D5', '-', 'A4', '-', 'F4', '-', 'G4', 'A4',
      'Bb4', '-', 'A4', '-', 'G4', '-', '-', '-',
      'G4', '-', 'Bb4', '-', 'D5', '-', 'C5', 'Bb4',
      'A4', '-', 'G4', '-', 'E4', '-', 'A4', '-',
    ].map(n),
    bass: [
      'D2', '-', '-', 'A2', 'D2', '-', 'A2', '-',
      'Bb1', '-', '-', 'F2', 'Bb1', '-', 'F2', '-',
      'G2', '-', '-', 'D3', 'G2', '-', 'D3', '-',
      'A2', '-', '-', 'E2', 'A2', '-', 'C#2', '-',
    ].map(n),
    arp: [
      'D3', 'A3', 'F4', 'A3', 'D3', 'A3', 'F4', 'A3',
      'Bb2', 'F3', 'D4', 'F3', 'Bb2', 'F3', 'D4', 'F3',
      'G3', 'Bb3', 'D4', 'Bb3', 'G3', 'Bb3', 'D4', 'Bb3',
      'A3', 'C#4', 'E4', 'C#4', 'A3', 'C#4', 'E4', 'G3',
    ].map(n),
    pad: [
      ['D3', 'F3', 'A3'], null, null, null, null, null, null, null,
      ['Bb2', 'D3', 'F3'], null, null, null, null, null, null, null,
      ['G3', 'Bb3', 'D4'], null, null, null, null, null, null, null,
      ['A3', 'C#4', 'E4'], null, null, null, null, null, null, null,
    ].map((ch) => (ch ? ch.map(n) : null)),
  },
};

class MusicEngine {
  constructor() {
    const saved = localStorage.getItem(MUSIC_ENABLED_KEY);
    this.enabled = saved === null ? true : saved === 'true';
    this.themeName = 'title';
    this.era = '8bit';
    this.ducked = false;

    this.ctx = null;
    this.masterGain = null;
    this.duckGain = null;
    this.noiseBuffer = null;

    this.timerId = null;
    this.nextNoteTime = 0;
    this.currentStep = 0;
    this.unlocked = false;

    this.listeners = new Set();
    this.installGestureUnlock();
  }

  installGestureUnlock() {
    if (typeof window === 'undefined') return;
    const unlock = () => {
      this.unlocked = true;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      if (this.enabled) {
        this.start();
      }
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emitChange() {
    for (const fn of this.listeners) {
      fn(this.enabled);
    }
  }

  isEnabled() {
    return this.enabled;
  }

  ensureContext() {
    if (!this.unlocked) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();

      this.duckGain = this.ctx.createGain();
      this.duckGain.gain.setValueAtTime(this.ducked ? DUCKED_MULTIPLIER : 1.0, this.ctx.currentTime);

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(MASTER_GAIN, this.ctx.currentTime);

      this.duckGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      // Short white-noise buffer for gentle 16-bit shimmer percussion
      const length = Math.floor(this.ctx.sampleRate * 0.05);
      const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  start() {
    if (!this.enabled || !this.unlocked) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    if (this.timerId !== null) return;
    this.nextNoteTime = ctx.currentTime + 0.06;
    this.timerId = setInterval(() => this.scheduler(), SCHEDULER_INTERVAL_MS);
  }

  stop() {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  setEnabled(flag) {
    this.enabled = Boolean(flag);
    localStorage.setItem(MUSIC_ENABLED_KEY, String(this.enabled));
    if (this.enabled) {
      this.unlocked = true; // Toggling On is itself a user gesture
      this.start();
    } else {
      this.stop();
    }
    this.emitChange();
    return this.enabled;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  setTheme(themeName) {
    const resolved = THEMES[themeName] ? themeName : 'title';
    if (this.themeName === resolved) return;
    this.themeName = resolved;
    this.currentStep = 0;
  }

  setEra(eraKey) {
    this.era = eraKey === '16bit' ? '16bit' : '8bit';
  }

  setDucked(isDucked) {
    const next = Boolean(isDucked);
    if (this.ducked === next) return;
    this.ducked = next;
    if (!this.ctx || !this.duckGain) return;

    const now = this.ctx.currentTime;
    const target = this.ducked ? DUCKED_MULTIPLIER : 1.0;
    const rampSec = this.ducked ? 0.22 : 0.35;
    this.duckGain.gain.cancelScheduledValues(now);
    this.duckGain.gain.setValueAtTime(this.duckGain.gain.value, now);
    this.duckGain.gain.linearRampToValueAtTime(target, now + rampSec);
  }

  scheduler() {
    if (!this.ctx || !this.enabled) return;
    const theme = THEMES[this.themeName] || THEMES.title;
    const stepDuration = 60 / theme.bpm / 2; // 8th-note steps

    while (this.nextNoteTime < this.ctx.currentTime + LOOKAHEAD_SEC) {
      this.scheduleStep(theme, this.currentStep, this.nextNoteTime, stepDuration);
      this.nextNoteTime += stepDuration;
      this.currentStep = (this.currentStep + 1) % theme.lead.length;
    }
  }

  playVoice({ freq, time, duration, type, volume, cutoff = 2200, attack = 0.015, detune = 0 }) {
    const ctx = this.ctx;
    if (!ctx || !this.duckGain || !freq) return;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    if (detune) osc.detune.setValueAtTime(detune, time);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, time);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(volume, time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.duckGain);

    osc.start(time);
    osc.stop(time + duration + 0.03);
  }

  playShimmerTick(time, accent) {
    const ctx = this.ctx;
    if (!ctx || !this.duckGain || !this.noiseBuffer) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(6200, time);

    const gain = ctx.createGain();
    const vol = accent ? 0.045 : 0.024;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(vol, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.duckGain);

    src.start(time);
    src.stop(time + 0.045);
  }

  scheduleStep(theme, step, time, stepDur) {
    const leadNote = theme.lead[step];
    const bassNote = theme.bass[step];
    const arpNote = theme.arp[step];
    const padChord = theme.pad[step];
    const is16Bit = this.era === '16bit';

    if (leadNote !== null) {
      const freq = midiToFreq(leadNote);
      if (is16Bit) {
        // Richer SNES dual-oscillator detuned lead
        this.playVoice({ freq, time, duration: stepDur * 1.45, type: 'sawtooth', volume: 0.14, cutoff: 2300, attack: 0.02, detune: -5 });
        this.playVoice({ freq, time, duration: stepDur * 1.45, type: 'triangle', volume: 0.2, cutoff: 2600, attack: 0.02, detune: 5 });
      } else {
        // Crisp warm NES filtered square lead
        this.playVoice({ freq, time, duration: stepDur * 1.15, type: 'square', volume: 0.16, cutoff: 1700, attack: 0.01 });
      }
    }

    if (bassNote !== null) {
      const freq = midiToFreq(bassNote);
      if (is16Bit) {
        this.playVoice({ freq, time, duration: stepDur * 1.8, type: 'triangle', volume: 0.34, cutoff: 950, attack: 0.015 });
        this.playVoice({ freq: freq * 0.5, time, duration: stepDur * 1.8, type: 'sine', volume: 0.22, cutoff: 500, attack: 0.02 });
      } else {
        this.playVoice({ freq, time, duration: stepDur * 1.5, type: 'triangle', volume: 0.32, cutoff: 900, attack: 0.01 });
      }
    }

    if (arpNote !== null) {
      const freq = midiToFreq(arpNote);
      if (is16Bit) {
        this.playVoice({ freq, time, duration: stepDur * 0.85, type: 'triangle', volume: 0.11, cutoff: 2600, attack: 0.01 });
      } else {
        this.playVoice({ freq, time, duration: stepDur * 0.65, type: 'square', volume: 0.065, cutoff: 1400, attack: 0.008 });
      }
    }

    if (is16Bit && padChord) {
      for (const note of padChord) {
        this.playVoice({
          freq: midiToFreq(note),
          time,
          duration: stepDur * 7.5,
          type: 'sine',
          volume: 0.075,
          cutoff: 1600,
          attack: 0.18,
        });
      }
    }

    if (is16Bit && step % 2 === 1) {
      this.playShimmerTick(time, step % 4 === 3);
    }
  }
}

export const music = new MusicEngine();
