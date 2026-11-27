import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FAMILIARITY_ID,
  PYTHON_FAMILIARITY_LEVELS,
  buildPreferencesForFamiliarity,
  getFamiliarityOption,
} from './onboarding.js';
import {
  buildCleanSavePayload,
  createDefaultSaveState,
  normalizeSave,
} from './api.js';

test('familiarity presets map cleanly to difficulty, tracebacks, and Pip hints', () => {
  assert.equal(PYTHON_FAMILIARITY_LEVELS.length, 3);
  assert.equal(DEFAULT_FAMILIARITY_ID, 'new');

  assert.deepEqual(buildPreferencesForFamiliarity('new'), {
    difficulty: 'explorer',
    showRawTracebacks: false,
    maxPipHints: 3,
  });
  assert.deepEqual(buildPreferencesForFamiliarity('some'), {
    difficulty: 'standard',
    showRawTracebacks: false,
    maxPipHints: 3,
  });
  assert.deepEqual(buildPreferencesForFamiliarity('comfortable'), {
    difficulty: 'challenge',
    showRawTracebacks: true,
    maxPipHints: 2,
  });

  // Unknown or missing familiarity falls back safely to default
  assert.equal(getFamiliarityOption('unknown-level').id, DEFAULT_FAMILIARITY_ID);
  assert.deepEqual(
    buildPreferencesForFamiliarity(undefined),
    buildPreferencesForFamiliarity(DEFAULT_FAMILIARITY_ID)
  );
});

test('createDefaultSaveState and normalizeSave preserve preferences without breaking legacy saves', () => {
  // Legacy save without preferences remains valid and has preferences: null
  const legacySave = createDefaultSaveState('LegacyHero', { skin: 'olive' });
  assert.equal('preferences' in legacySave, false);
  const normLegacy = normalizeSave({
    id: 'guest-legacy-1',
    heroName: 'LegacyHero',
    realmId: 'realm-03-cavern',
    byteShards: 120,
    solvedTrials: ['trial-01-01'],
  });
  assert.equal(normLegacy.preferences, null);
  assert.equal(normLegacy.byteShards, 120);

  // New onboarded save carries calibrated preferences
  const prefs = buildPreferencesForFamiliarity('comfortable');
  const onboarded = createDefaultSaveState('Nova', { tunic: 'cobalt' }, prefs);
  assert.deepEqual(onboarded.preferences, prefs);
  const normOnboarded = normalizeSave(onboarded);
  assert.deepEqual(normOnboarded.preferences, prefs);

  // buildCleanSavePayload omits preferences so gameplay PUT updates never clobber server preferences
  const cleanPayload = buildCleanSavePayload(normOnboarded);
  assert.equal('preferences' in cleanPayload, false);
});
