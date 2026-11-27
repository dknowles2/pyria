import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THEMES,
  ERA_LEVELS,
  MusicEngine,
  resolveRegionTheme,
  midiToFreq,
} from './music.js';

function createMockAudioContext() {
  const param = (initial = 0) => ({
    value: initial,
    setValueAtTime(v) {
      this.value = v;
    },
    linearRampToValueAtTime(v) {
      this.value = v;
    },
    exponentialRampToValueAtTime(v) {
      this.value = v;
    },
    cancelScheduledValues() {},
  });

  return {
    currentTime: 0,
    sampleRate: 44100,
    state: 'running',
    destination: {},
    resume: async () => {},
    suspend: async () => {},
    createGain: () => ({ gain: param(1), connect() {} }),
    createDelay: () => ({ delayTime: param(0.2), connect() {} }),
    createBiquadFilter: () => ({
      type: 'lowpass',
      frequency: param(2000),
      Q: param(1),
      connect() {},
    }),
    createDynamicsCompressor: () => ({
      threshold: param(-16),
      knee: param(18),
      ratio: param(4),
      attack: param(0.01),
      release: param(0.2),
      connect() {},
    }),
    createOscillator: () => ({
      type: 'sine',
      frequency: param(440),
      detune: param(0),
      connect() {},
      start() {},
      stop() {},
    }),
    createBuffer: (_ch, len) => ({
      getChannelData: () => new Float32Array(len),
    }),
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      start() {},
      stop() {},
    }),
  };
}

test('all 6 themes define valid 4-section (128-step) song forms with no invalid notes', () => {
  const expectedThemes = ['title', 'meadow', 'camp', 'stream', 'ruins', 'vault'];
  assert.deepEqual(Object.keys(THEMES).sort(), expectedThemes.sort());

  for (const [name, theme] of Object.entries(THEMES)) {
    assert.ok(theme.bpm >= 80 && theme.bpm <= 160, `${name} bpm in range`);
    assert.deepEqual(theme.form, ['A', 'A2', 'B', 'C'], `${name} has 4-section form`);

    const leadSignatures = new Set();

    for (const secKey of theme.form) {
      const sec = theme.sections[secKey];
      assert.ok(sec, `${name}.${secKey} exists`);

      for (const trackName of ['lead', 'counter', 'bass', 'bassWalk', 'arp', 'pad', 'padExt']) {
        assert.equal(sec[trackName].length, 32, `${name}.${secKey}.${trackName} has 32 steps`);
      }

      for (const trackName of ['lead', 'counter', 'bass', 'bassWalk', 'arp']) {
        for (const note of sec[trackName]) {
          assert.ok(
            note === null || (Number.isInteger(note) && note >= 24 && note <= 108),
            `${name}.${secKey}.${trackName} has valid MIDI note: ${note}`
          );
        }
      }

      for (const chord of sec.pad) {
        if (chord !== null) {
          assert.equal(chord.length, 3, `${name}.${secKey}.pad chords are triads`);
          for (const note of chord) {
            assert.ok(Number.isInteger(note) && note >= 36 && note <= 96);
          }
        }
      }

      for (const chord of sec.padExt) {
        if (chord !== null) {
          assert.equal(chord.length, 4, `${name}.${secKey}.padExt chords are 4-note extended voicings`);
          for (const note of chord) {
            assert.ok(Number.isInteger(note) && note >= 36 && note <= 96);
          }
        }
      }

      leadSignatures.add(JSON.stringify(sec.lead));
    }

    assert.equal(
      leadSignatures.size,
      4,
      `${name} should have 4 distinct melodic sections (A, A2, B, C)`
    );
  }
});

test('advanceStep progresses through A -> A2 -> B -> C and increments cycleIndex', () => {
  const engine = new MusicEngine();
  const theme = THEMES.meadow;

  const visitedSections = [];
  for (let i = 0; i < 128; i++) {
    if (engine.currentStep === 0) {
      visitedSections.push(engine.getActiveSection(theme).key);
    }
    engine.advanceStep(theme);
  }

  assert.deepEqual(visitedSections, ['A', 'A2', 'B', 'C']);
  assert.equal(engine.currentStep, 0);
  assert.equal(engine.sectionIndex, 0);
  assert.equal(engine.cycleIndex, 1);
});

test('era progression strictly increases musical complexity from 8bit -> 16bit -> 32bit -> 64bit', () => {
  const eras = ['8bit', '16bit', '32bit', '64bit'];

  for (const themeName of Object.keys(THEMES)) {
    const theme = THEMES[themeName];
    const statsByEra = {};

    for (const era of eras) {
      const engine = new MusicEngine();
      engine.ctx = createMockAudioContext();
      engine.transitionGain = engine.ctx.createGain();
      engine.noiseBuffer = engine.ctx.createBuffer(1, 100);
      engine.setEra(era);

      let voiceCalls = 0;
      let percCalls = 0;
      let subStepCalls = 0;
      let vibratoCalls = 0;
      let timpaniCalls = 0;
      let cymbalCalls = 0;

      const origPlayVoice = engine.playVoice.bind(engine);
      engine.playVoice = (opts) => {
        voiceCalls += 1;
        if (opts.vibratoDepth > 0) vibratoCalls += 1;
        // Sub-step 16th-note offset check
        const frac = opts.time - Math.floor(opts.time * 1000) / 1000;
        if (opts._isSubStep || Math.abs(opts.time - currentBaseTime) > 0.001) {
          subStepCalls += 1;
        }
        return origPlayVoice(opts);
      };

      const wrapPerc = (method, counter) => {
        const orig = engine[method].bind(engine);
        engine[method] = (...args) => {
          percCalls += 1;
          if (counter === 'timpani') timpaniCalls += 1;
          if (counter === 'cymbal') cymbalCalls += 1;
          return orig(...args);
        };
      };
      wrapPerc('playKick');
      wrapPerc('playSnare');
      wrapPerc('playShimmerTick');
      wrapPerc('playTimpani', 'timpani');
      wrapPerc('playCymbalSwell', 'cymbal');

      let currentBaseTime = 0;
      const stepDur = 60 / theme.bpm / 2;

      // Simulate 1 full 128-step cycle
      for (let i = 0; i < 128; i++) {
        currentBaseTime = i * stepDur;
        const { key, section } = engine.getActiveSection(theme);
        engine.scheduleStep(theme, section, key, engine.currentStep, engine.cycleIndex, currentBaseTime, stepDur);
        engine.advanceStep(theme);
      }

      statsByEra[era] = {
        voiceCalls,
        percCalls,
        subStepCalls,
        vibratoCalls,
        timpaniCalls,
        cymbalCalls,
      };
    }

    // Strict monotonic increase in voice density across eras
    assert.ok(
      statsByEra['8bit'].voiceCalls < statsByEra['16bit'].voiceCalls,
      `${themeName}: 16bit (${statsByEra['16bit'].voiceCalls}) > 8bit (${statsByEra['8bit'].voiceCalls})`
    );
    assert.ok(
      statsByEra['16bit'].voiceCalls < statsByEra['32bit'].voiceCalls,
      `${themeName}: 32bit (${statsByEra['32bit'].voiceCalls}) > 16bit (${statsByEra['16bit'].voiceCalls})`
    );
    assert.ok(
      statsByEra['32bit'].voiceCalls < statsByEra['64bit'].voiceCalls,
      `${themeName}: 64bit (${statsByEra['64bit'].voiceCalls}) > 32bit (${statsByEra['32bit'].voiceCalls})`
    );

    // 32-bit and 64-bit introduce 16th-note subdivisions
    assert.equal(statsByEra['8bit'].subStepCalls, 0);
    assert.equal(statsByEra['16bit'].subStepCalls, 0);
    assert.ok(statsByEra['32bit'].subStepCalls > 0, `${themeName}: 32bit uses 16th-note subdivisions`);
    assert.ok(
      statsByEra['64bit'].subStepCalls >= statsByEra['32bit'].subStepCalls,
      `${themeName}: 64bit has at least as many 16th-note subdivisions as 32bit`
    );

    // 64-bit adds vibrato, timpani, and cymbal swells
    assert.ok(statsByEra['64bit'].vibratoCalls > 0, `${themeName}: 64bit uses vibrato on held notes`);
    assert.ok(statsByEra['64bit'].timpaniCalls > 0, `${themeName}: 64bit uses orchestral timpani`);
    assert.ok(statsByEra['64bit'].cymbalCalls > 0, `${themeName}: 64bit uses section cymbal swells`);
  }
});

test('cycle evolution varies arrangement across successive macro-cycles', () => {
  const engine = new MusicEngine();
  engine.ctx = createMockAudioContext();
  engine.transitionGain = engine.ctx.createGain();
  engine.noiseBuffer = engine.ctx.createBuffer(1, 100);
  engine.setEra('32bit');

  const theme = THEMES.meadow;
  const stepDur = 60 / theme.bpm / 2;

  const captureCycle = (cycleIdx) => {
    const events = [];
    engine.playVoice = (opts) => {
      events.push(`${Math.round(opts.freq)}:${opts.type}`);
    };
    engine.resetSongPosition();
    engine.cycleIndex = cycleIdx;
    for (let i = 0; i < 128; i++) {
      const { key, section } = engine.getActiveSection(theme);
      engine.scheduleStep(theme, section, key, engine.currentStep, cycleIdx, i * stepDur, stepDur);
      engine.advanceStep(theme);
    }
    return events.join('|');
  };

  const c0 = captureCycle(0);
  const c1 = captureCycle(1);
  const c2 = captureCycle(2);

  assert.notEqual(c0, c1, 'Cycle 0 and Cycle 1 should produce distinct arrangements');
  assert.notEqual(c1, c2, 'Cycle 1 and Cycle 2 should produce distinct arrangements');
});

test('resolveRegionTheme and midiToFreq remain accurate', () => {
  assert.equal(resolveRegionTheme('elder-ada-clearing', 'realm-01-meadow'), 'meadow');
  assert.equal(resolveRegionTheme('bram-workshop-camp', 'realm-01-meadow'), 'camp');
  assert.equal(resolveRegionTheme('sparkling-stream', 'realm-01-meadow'), 'stream');
  assert.equal(resolveRegionTheme('spark-logic-vault', 'realm-01-meadow'), 'vault');
  assert.equal(resolveRegionTheme('ruin-vestibule', 'realm-02-ruins'), 'ruins');
  assert.equal(resolveRegionTheme(null, 'realm-64-01-valley'), 'meadow');
  assert.equal(resolveRegionTheme(null, 'realm-64-04-sanctum'), 'vault');

  assert.ok(Math.abs(midiToFreq(69) - 440) < 0.001);
  assert.deepEqual(Object.keys(ERA_LEVELS), ['8bit', '16bit', '32bit', '64bit']);
});
