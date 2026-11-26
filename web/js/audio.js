// Lightweight Web Audio API 8-bit chiptune sound effects

const MUTE_KEY = 'pyria_audio_muted';

class RetroAudio {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem(MUTE_KEY) === 'true';
  }

  ensureContext() {
    if (this.muted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  isMuted() {
    return this.muted;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem(MUTE_KEY, String(this.muted));
    if (!this.muted) {
      this.playClick();
    }
    return this.muted;
  }

  playTone(freq, duration = 0.08, type = 'square', volume = 0.07, delay = 0) {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playClick() {
    this.playTone(660, 0.045, 'square', 0.045, 0);
  }

  playStep() {
    this.playTone(170, 0.035, 'triangle', 0.035, 0);
  }

  playBump() {
    this.playTone(110, 0.07, 'sawtooth', 0.04, 0);
  }

  playCodeRun() {
    this.playTone(440, 0.05, 'square', 0.05, 0);
    this.playTone(587.33, 0.06, 'square', 0.05, 0.055);
  }

  playChest() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      this.playTone(f, 0.1, 'square', 0.06, i * 0.07);
    });
  }

  playForge() {
    this.playTone(330, 0.07, 'sawtooth', 0.06, 0);
    this.playTone(523.25, 0.08, 'square', 0.06, 0.08);
    this.playTone(783.99, 0.14, 'triangle', 0.07, 0.16);
  }

  playSuccess() {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
    notes.forEach((f, i) => {
      this.playTone(f, i === notes.length - 1 ? 0.24 : 0.09, 'square', 0.065, i * 0.08);
    });
  }

  playDragonRescue() {
    const melody = [
      [392.0, 0.1],
      [523.25, 0.1],
      [659.25, 0.1],
      [783.99, 0.14],
      [659.25, 0.09],
      [1046.5, 0.34],
    ];
    let t = 0;
    for (const [f, d] of melody) {
      this.playTone(f, d, 'square', 0.07, t);
      this.playTone(f / 2, d, 'triangle', 0.05, t);
      t += d + 0.02;
    }
  }

  playPortal() {
    const notes = [330, 440, 554.37, 659.25, 880];
    notes.forEach((f, i) => {
      this.playTone(f, 0.11, 'triangle', 0.06, i * 0.06);
    });
  }

  playError() {
    this.playTone(260, 0.1, 'triangle', 0.06, 0);
    this.playTone(196, 0.16, 'triangle', 0.06, 0.1);
  }

  playBossIntro() {
    const notes = [
      [392.0, 0.12],
      [369.99, 0.12],
      [329.63, 0.14],
      [246.94, 0.28],
    ];
    let t = 0;
    for (const [f, d] of notes) {
      this.playTone(f, d, 'sawtooth', 0.065, t);
      this.playTone(f / 2, d, 'square', 0.045, t);
      t += d + 0.02;
    }
  }

  playVaultShatter() {
    const burst = [1046.5, 1318.5, 880, 1567.98, 1760, 2093];
    burst.forEach((f, i) => {
      this.playTone(f, 0.07, 'square', 0.055, i * 0.035);
    });
    this.playTone(523.25, 0.25, 'triangle', 0.07, 0.24);
    this.playTone(783.99, 0.3, 'triangle', 0.07, 0.32);
  }
}

export const audio = new RetroAudio();
