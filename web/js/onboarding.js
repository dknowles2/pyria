// Player onboarding Python familiarity presets & lesson calibration

export const DEFAULT_FAMILIARITY_ID = 'new';

export const PYTHON_FAMILIARITY_LEVELS = [
  {
    id: 'new',
    badge: '🌱',
    label: 'Brand new to coding',
    description: 'Never written code before',
    calibrationSummary:
      'Starts in Explorer mode with guided fill-in-the-blank starter spells, friendly Pip clues, and 3 hints.',
    preferences: {
      difficulty: 'explorer',
      showRawTracebacks: false,
      maxPipHints: 3,
    },
  },
  {
    id: 'some',
    badge: '⚡',
    label: 'Some coding or a little Python',
    description: 'Tried Scratch, another language, or a bit of Python',
    calibrationSummary:
      'Starts in Standard mode so you write spells from scratch with friendly Pip clues and 3 hints.',
    preferences: {
      difficulty: 'standard',
      showRawTracebacks: false,
      maxPipHints: 3,
    },
  },
  {
    id: 'comfortable',
    badge: '🐉',
    label: 'Comfortable with Python',
    description: 'Used variables, if/else, or loops in Python',
    calibrationSummary:
      'Starts in Challenge mode with real Python tracebacks and 2 Pip hints. Tip: try Advanced Mode above to forge your hero in Python!',
    preferences: {
      difficulty: 'challenge',
      showRawTracebacks: true,
      maxPipHints: 2,
    },
  },
];

export function getFamiliarityOption(id) {
  return (
    PYTHON_FAMILIARITY_LEVELS.find((item) => item.id === id) ||
    PYTHON_FAMILIARITY_LEVELS.find((item) => item.id === DEFAULT_FAMILIARITY_ID) ||
    PYTHON_FAMILIARITY_LEVELS[0]
  );
}

export function buildPreferencesForFamiliarity(id) {
  const opt = getFamiliarityOption(id);
  return {
    difficulty: opt.preferences.difficulty,
    showRawTracebacks: opt.preferences.showRawTracebacks,
    maxPipHints: opt.preferences.maxPipHints,
  };
}
