export type DifficultyMode = "explorer" | "standard" | "challenge";
export type Direction = "down" | "up" | "left" | "right";
export type SpriteEraKey = "8bit" | "16bit";

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

/* Sprite & World Bundle Types */

export interface SpriteEraSpec {
  key: SpriteEraKey;
  name: string;
  heroFrameSize: { width: number; height: number };
  heroFramesPerDirection: number;
  heroSheetSize: { width: number; height: number };
  pipFrameSize: { width: number; height: number };
  pipFramesPerDirection: number;
  pipSheetSize: { width: number; height: number };
  recommendedFps: number;
}

export interface SpriteManifest {
  version: string;
  directions: Direction[];
  eras: Record<string, SpriteEraSpec>;
  layerOrder: {
    default: string[];
    up: string[];
  };
  fullCoverageHeadgear: string[];
  layers: {
    shadow: Record<string, { "8bit": string; "16bit": string }>;
    skin: Record<string, { "8bit": string; "16bit": string }>;
    hair: Record<
      string,
      {
        "8bit": string;
        "16bit": string;
        "8bit_tucked": string;
        "16bit_tucked": string;
      }
    >;
    torso: Record<string, { value?: string; "8bit": string; "16bit": string }>;
    footwear: Record<string, { "8bit": string; "16bit": string }>;
    headgear: Record<
      string,
      { tucksHair?: boolean; "8bit": string; "16bit": string }
    >;
    back: Record<
      string,
      {
        "8bit_back": string;
        "8bit_front": string;
        "16bit_back": string;
        "16bit_front": string;
      }
    >;
    offhand: Record<string, { "8bit": string; "16bit": string }>;
    aura: Record<string, { "8bit": string; "16bit": string }>;
    companion: Record<string, { "8bit": string; "16bit": string }>;
    companion_neck: Record<string, { "8bit": string; "16bit": string }>;
  };
}

export interface SpriteBundle {
  manifest: SpriteManifest;
  images: Record<string, string>;
}

export interface TileRect {
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TilesetEraSpec {
  tilesetImage: string;
  tilesetSize: { width: number; height: number };
  npcsImage: string;
  npcsSize: { width: number; height: number };
  tiles: Record<string, TileRect>;
  npcs: Record<string, TileRect>;
}

export interface TilesetManifest {
  version: string;
  tilesetId: string;
  tileSize: number;
  tileIds: string[];
  npcKeys: string[];
  eras: Record<SpriteEraKey, TilesetEraSpec>;
}

export interface DynamicTile {
  x: number;
  y: number;
  layer: "ground" | "decor";
  tileWhenLocked: string;
  tileWhenUnlocked: string;
  collisionWhenLocked: 0 | 1;
  collisionWhenUnlocked: 0 | 1;
}

export interface MapRegion {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapEntity {
  id: string;
  type: "npc" | "trial" | "chest" | "vault" | "portal" | "workshop";
  x: number;
  y: number;
  label: string;
  refId: string | null;
  spriteKey: string;
  shardReward?: number;
  requiredTrialId?: string | null;
  dynamicTiles?: DynamicTile[];
}

export interface RealmMap {
  id: string;
  realmId: string;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  tilesetId: string;
  spawn: { x: number; y: number };
  layers: {
    ground: string[][];
    decor: (string | null)[][];
    collision: (0 | 1)[][];
  };
  regions: MapRegion[];
  entities: MapEntity[];
}

export interface WorldBundle {
  tilesetManifest: TilesetManifest;
  tilesetImages: Record<string, string>;
  maps: RealmMap[];
}

export interface HeroLoadout {
  name: string;
  skin: string;
  hair: string;
  tunic: string; // e.g. "emerald" (maps to torso key "tunic_emerald")
  hat: string | null; // e.g. "hat_explorer" | null
  boots: string; // "boots_default" | "boots_swift"
  cloak: string | null; // "cloak_tide" | null
  shield: string | null; // "shield_oak" | "shield_coral" | null
  aura: string | null; // "aura_charisma_1" | "aura_courage_1" | null
  pipScarf: boolean;
}
