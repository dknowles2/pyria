export type DifficultyMode = "explorer" | "standard" | "challenge";

export interface DifficultyOverride {
  mode: DifficultyMode;
  showRawTracebacks: boolean;
}

export interface GlobalDifficultyOverride extends DifficultyOverride {
  maxHintsAllowed: number;
}

export interface NpcDefinition {
  id: string;
  name: string;
  role: string;
  personality: string;
  catchphrase: string;
  [key: string]: unknown;
}

export interface ConceptProgressionEntry {
  id: string;
  name?: string;
  label?: string;
  minEra: string;
  maxBasicRealm: number;
  description?: string;
  [key: string]: unknown;
}

export interface GameConfig {
  title: string;
  version?: string;
  currencyName: string;
  terminology: {
    era: string;
    realm: string;
    trial: string;
    [key: string]: string;
  };
  globalDifficultyOverride: GlobalDifficultyOverride;
  eraOrder: string[];
  npcs: NpcDefinition[];
  conceptProgression: ConceptProgressionEntry[];
  [key: string]: unknown;
}

export interface UnlockableItem {
  id: string;
  functionCall: string;
  category: string;
  name: string;
  description: string;
  shardCost: number;
  unlockRealmId?: string | null;
  eraId?: string;
  spriteLayer?: string;
  spriteKey?: string;
  [key: string]: unknown;
}

export interface CatalogData {
  characterCreation: Record<string, unknown>;
  unlockables: UnlockableItem[];
  [key: string]: unknown;
}

export interface DragonInfo {
  id: string;
  name: string;
  title: string;
  element: string;
  rescueDialogue: string;
  [key: string]: unknown;
}

export interface StarterCodeSet {
  explorer: string;
  standard: string;
  challenge: string;
}

export interface TrialHints {
  tier1_nudge: string;
  tier2_pattern: string;
  tier3_walkthrough: string;
}

export interface Trial {
  id: string;
  title: string;
  storyPrompt: string;
  objective: string;
  concepts: string[];
  shardReward: number;
  unlockId: string | null;
  starterCode: StarterCodeSet;
  referenceSolution: string;
  testCode: string;
  hints: TrialHints;
  difficultyOverride: DifficultyOverride | null;
  [key: string]: unknown;
}

export interface Realm {
  id: string;
  number: number;
  name: string;
  dragon: DragonInfo;
  miniVisualUpgrade: string;
  storyIntro: string;
  storyOutro: string;
  primaryConcepts: string[];
  difficultyOverride: DifficultyOverride | null;
  trials: Trial[];
  [key: string]: unknown;
}

export interface EraAct {
  id: string;
  number?: number;
  name: string;
  subtitle?: string;
  realmNumbers?: number[];
  [key: string]: unknown;
}

export interface EraData {
  id: string;
  name: string;
  subtitle: string;
  bitCount: number;
  visualStyle: string;
  acts?: EraAct[];
  realms: Realm[];
  [key: string]: unknown;
}

export interface RepetitionWarning {
  eraId: string;
  eraName: string;
  realmId: string;
  realmNumber: number;
  realmName: string;
  conceptId: string;
  maxBasicRealm: number;
  source: "realm.primaryConcepts" | "trial.concepts";
  trialId?: string;
  trialTitle?: string;
  message: string;
}

export interface RealmSummary {
  id: string;
  number: number;
  name: string;
  dragonName: string;
  dragonElement: string;
  trialCount: number;
  primaryConcepts: string[];
  difficultyOverride: DifficultyOverride | null;
  warningCount: number;
}

export interface EraSummary {
  id: string;
  name: string;
  subtitle: string;
  bitCount: number;
  visualStyle: string;
  realms: RealmSummary[];
}

export interface GameOverview {
  contentDir: string;
  missingFiles: string[];
  title: string;
  currencyName: string;
  terminology: GameConfig["terminology"];
  globalDifficultyOverride: GlobalDifficultyOverride;
  eras: EraSummary[];
  conceptProgression: ConceptProgressionEntry[];
  warnings: RepetitionWarning[];
  npcs: NpcDefinition[];
  unlockablesCount: number;
}

export interface TrialTestResult {
  passed: boolean;
  stdout: string;
  stderr: string;
  pipFriendlyHint: string;
  timedOut?: boolean;
  durationMs?: number;
}
