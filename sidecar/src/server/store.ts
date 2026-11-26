import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  CatalogData,
  ConceptProgressionEntry,
  DifficultyOverride,
  EraData,
  EraSummary,
  GameConfig,
  GameOverview,
  GlobalDifficultyOverride,
  Realm,
  RepetitionWarning,
  Trial,
} from "../shared/types.js";

const DEFAULT_GAME_CONFIG: GameConfig = {
  title: "Pyria",
  version: "0.1.0",
  currencyName: "Byte Shards",
  terminology: {
    era: "Era",
    realm: "Realm",
    trial: "Trial",
  },
  globalDifficultyOverride: {
    mode: "standard",
    showRawTracebacks: false,
    maxHintsAllowed: 3,
  },
  eraOrder: ["era-01-8bit", "era-02-16bit"],
  npcs: [],
  conceptProgression: [],
};

const DEFAULT_CATALOG: CatalogData = {
  characterCreation: {},
  unlockables: [],
};

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmpPath, filePath);
}

export class ContentStore {
  readonly contentDir: string;

  constructor(contentDir: string) {
    this.contentDir = path.resolve(contentDir);
  }

  private get gamePath(): string {
    return path.join(this.contentDir, "game.json");
  }

  private get catalogPath(): string {
    return path.join(this.contentDir, "catalog.json");
  }

  private get erasDir(): string {
    return path.join(this.contentDir, "eras");
  }

  private eraPath(eraId: string): string {
    return path.join(this.erasDir, `${eraId}.json`);
  }

  async loadGameConfig(): Promise<{ config: GameConfig; exists: boolean }> {
    const data = await readJsonSafe<GameConfig>(this.gamePath);
    if (!data) {
      return { config: structuredClone(DEFAULT_GAME_CONFIG), exists: false };
    }
    return {
      config: {
        ...DEFAULT_GAME_CONFIG,
        ...data,
        terminology: {
          ...DEFAULT_GAME_CONFIG.terminology,
          ...(data.terminology ?? {}),
        },
        globalDifficultyOverride: {
          ...DEFAULT_GAME_CONFIG.globalDifficultyOverride,
          ...(data.globalDifficultyOverride ?? {}),
        },
        eraOrder: Array.isArray(data.eraOrder)
          ? data.eraOrder
          : DEFAULT_GAME_CONFIG.eraOrder,
        npcs: Array.isArray(data.npcs) ? data.npcs : [],
        conceptProgression: Array.isArray(data.conceptProgression)
          ? data.conceptProgression
          : [],
      },
      exists: true,
    };
  }

  async saveGameConfig(config: GameConfig): Promise<void> {
    await writeJsonAtomic(this.gamePath, config);
  }

  async loadCatalog(): Promise<{ catalog: CatalogData; exists: boolean }> {
    const data = await readJsonSafe<CatalogData>(this.catalogPath);
    if (!data) {
      return { catalog: structuredClone(DEFAULT_CATALOG), exists: false };
    }
    return {
      catalog: {
        ...DEFAULT_CATALOG,
        ...data,
        unlockables: Array.isArray(data.unlockables) ? data.unlockables : [],
      },
      exists: true,
    };
  }

  async listEraIds(gameConfig?: GameConfig): Promise<string[]> {
    const cfg = gameConfig ?? (await this.loadGameConfig()).config;
    const ordered = [...cfg.eraOrder];
    try {
      const files = await readdir(this.erasDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const id = file.slice(0, -5);
        if (!ordered.includes(id)) {
          ordered.push(id);
        }
      }
    } catch {
      // eras/ directory might not exist yet
    }
    return ordered;
  }

  async loadEra(eraId: string): Promise<EraData | null> {
    const data = await readJsonSafe<EraData>(this.eraPath(eraId));
    if (!data) return null;
    return {
      ...data,
      realms: Array.isArray(data.realms) ? data.realms : [],
    };
  }

  async saveEra(era: EraData): Promise<void> {
    await writeJsonAtomic(this.eraPath(era.id), era);
  }

  async loadAllEras(gameConfig?: GameConfig): Promise<{
    eras: EraData[];
    missingEraFiles: string[];
  }> {
    const eraIds = await this.listEraIds(gameConfig);
    const eras: EraData[] = [];
    const missingEraFiles: string[] = [];
    for (const eraId of eraIds) {
      const era = await this.loadEra(eraId);
      if (era) {
        eras.push(era);
      } else {
        missingEraFiles.push(`eras/${eraId}.json`);
      }
    }
    return { eras, missingEraFiles };
  }

  async findRealm(
    realmId: string,
    eraId?: string
  ): Promise<{ era: EraData; realm: Realm; realmIndex: number } | null> {
    if (eraId) {
      const era = await this.loadEra(eraId);
      if (!era) return null;
      const idx = era.realms.findIndex((r) => r.id === realmId);
      if (idx >= 0) {
        return { era, realm: era.realms[idx], realmIndex: idx };
      }
      return null;
    }

    const { eras } = await this.loadAllEras();
    for (const era of eras) {
      const idx = era.realms.findIndex((r) => r.id === realmId);
      if (idx >= 0) {
        return { era, realm: era.realms[idx], realmIndex: idx };
      }
    }
    return null;
  }

  computeRepetitionWarnings(
    config: GameConfig,
    eras: EraData[]
  ): RepetitionWarning[] {
    const warnings: RepetitionWarning[] = [];
    const conceptMap = new Map<string, ConceptProgressionEntry>();
    for (const entry of config.conceptProgression) {
      if (entry && typeof entry.id === "string") {
        conceptMap.set(entry.id, entry);
      }
    }

    // Build era rank map so we know if a realm is in a later era than minEra
    const eraOrder = config.eraOrder.length
      ? config.eraOrder
      : eras.map((e) => e.id);
    const eraRank = (eraId: string): number => {
      const idx = eraOrder.indexOf(eraId);
      return idx >= 0 ? idx : 999;
    };

    // Cumulative global realm number across eras (e.g. Era 1: 1..8, Era 2: 9..24)
    let cumulativeOffset = 0;
    for (const era of eras) {
      const currentEraRank = eraRank(era.id);
      for (const realm of era.realms) {
        const globalRealmNum = cumulativeOffset + (realm.number || 0);

        const checkConcept = (
          conceptId: string,
          source: "realm.primaryConcepts" | "trial.concepts",
          trial?: Trial
        ) => {
          const rule = conceptMap.get(conceptId);
          if (!rule || typeof rule.maxBasicRealm !== "number") return;

          const minEraRank = eraRank(rule.minEra);
          const exceedsInSameEra =
            currentEraRank === minEraRank && realm.number > rule.maxBasicRealm;
          const exceedsInLaterEra =
            currentEraRank > minEraRank && globalRealmNum > rule.maxBasicRealm;

          if (exceedsInSameEra || exceedsInLaterEra) {
            warnings.push({
              eraId: era.id,
              eraName: era.name,
              realmId: realm.id,
              realmNumber: realm.number,
              realmName: realm.name,
              conceptId,
              maxBasicRealm: rule.maxBasicRealm,
              source,
              trialId: trial?.id,
              trialTitle: trial?.title,
              message: trial
                ? `Realm ${realm.number} (${realm.name}) Trial "${trial.title}" repeats basic concept "${conceptId}" past maxBasicRealm ${rule.maxBasicRealm}.`
                : `Realm ${realm.number} (${realm.name}) lists basic concept "${conceptId}" in primaryConcepts past maxBasicRealm ${rule.maxBasicRealm}.`,
            });
          }
        };

        for (const concept of realm.primaryConcepts || []) {
          checkConcept(concept, "realm.primaryConcepts");
        }
        for (const trial of realm.trials || []) {
          for (const concept of trial.concepts || []) {
            checkConcept(concept, "trial.concepts", trial);
          }
        }
      }
      cumulativeOffset += era.realms.length;
    }

    return warnings;
  }

  async getGameOverview(): Promise<GameOverview> {
    const missingFiles: string[] = [];
    const { config, exists: gameExists } = await this.loadGameConfig();
    if (!gameExists) missingFiles.push("game.json");

    const { catalog, exists: catalogExists } = await this.loadCatalog();
    if (!catalogExists) missingFiles.push("catalog.json");

    const { eras, missingEraFiles } = await this.loadAllEras(config);
    missingFiles.push(...missingEraFiles);

    const warnings = this.computeRepetitionWarnings(config, eras);
    const warningsByRealm = new Map<string, number>();
    for (const w of warnings) {
      warningsByRealm.set(w.realmId, (warningsByRealm.get(w.realmId) ?? 0) + 1);
    }

    const eraSummaries: EraSummary[] = eras.map((era) => ({
      id: era.id,
      name: era.name,
      subtitle: era.subtitle,
      bitCount: era.bitCount,
      visualStyle: era.visualStyle,
      realms: era.realms.map((r) => ({
        id: r.id,
        number: r.number,
        name: r.name,
        dragonName: r.dragon?.name ?? "Unknown Dragon",
        dragonElement: r.dragon?.element ?? "",
        trialCount: Array.isArray(r.trials) ? r.trials.length : 0,
        primaryConcepts: Array.isArray(r.primaryConcepts)
          ? r.primaryConcepts
          : [],
        difficultyOverride: r.difficultyOverride ?? null,
        warningCount: warningsByRealm.get(r.id) ?? 0,
      })),
    }));

    return {
      contentDir: this.contentDir,
      missingFiles,
      title: config.title,
      currencyName: config.currencyName,
      terminology: config.terminology,
      globalDifficultyOverride: config.globalDifficultyOverride,
      eras: eraSummaries,
      conceptProgression: config.conceptProgression,
      warnings,
      npcs: config.npcs,
      unlockablesCount: catalog.unlockables.length,
    };
  }

  async checkConceptRepetition(): Promise<{
    warnings: RepetitionWarning[];
    conceptProgression: ConceptProgressionEntry[];
    totalRealmsScanned: number;
    totalTrialsScanned: number;
  }> {
    const { config } = await this.loadGameConfig();
    const { eras } = await this.loadAllEras(config);
    const warnings = this.computeRepetitionWarnings(config, eras);
    let totalRealmsScanned = 0;
    let totalTrialsScanned = 0;
    for (const era of eras) {
      totalRealmsScanned += era.realms.length;
      for (const r of era.realms) {
        totalTrialsScanned += (r.trials || []).length;
      }
    }
    return {
      warnings,
      conceptProgression: config.conceptProgression,
      totalRealmsScanned,
      totalTrialsScanned,
    };
  }

  async upsertRealm(input: {
    eraId?: string;
    realmId: string;
    name?: string;
    storyIntro?: string;
    storyOutro?: string;
    miniVisualUpgrade?: string;
    primaryConcepts?: string[];
    dragon?: Partial<Realm["dragon"]>;
    difficultyOverride?: DifficultyOverride | null;
  }): Promise<{ era: EraData; realm: Realm }> {
    const found = await this.findRealm(input.realmId, input.eraId);
    if (!found) {
      throw new Error(
        `Realm "${input.realmId}" not found${input.eraId ? ` in era "${input.eraId}"` : ""}.`
      );
    }

    const { era, realm, realmIndex } = found;
    const updated: Realm = {
      ...realm,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.storyIntro !== undefined ? { storyIntro: input.storyIntro } : {}),
      ...(input.storyOutro !== undefined ? { storyOutro: input.storyOutro } : {}),
      ...(input.miniVisualUpgrade !== undefined
        ? { miniVisualUpgrade: input.miniVisualUpgrade }
        : {}),
      ...(input.primaryConcepts !== undefined
        ? { primaryConcepts: input.primaryConcepts }
        : {}),
      ...(input.dragon !== undefined
        ? {
            dragon: {
              ...realm.dragon,
              ...input.dragon,
            },
          }
        : {}),
      ...(input.difficultyOverride !== undefined
        ? { difficultyOverride: input.difficultyOverride }
        : {}),
    };

    era.realms[realmIndex] = updated;
    await this.saveEra(era);
    return { era, realm: updated };
  }

  async upsertTrial(input: {
    eraId?: string;
    realmId: string;
    trial: Trial;
  }): Promise<{ era: EraData; realm: Realm; trial: Trial; created: boolean }> {
    const found = await this.findRealm(input.realmId, input.eraId);
    if (!found) {
      throw new Error(
        `Realm "${input.realmId}" not found${input.eraId ? ` in era "${input.eraId}"` : ""}.`
      );
    }

    const { era, realm, realmIndex } = found;
    const trials = Array.isArray(realm.trials) ? [...realm.trials] : [];
    const existingIdx = trials.findIndex((t) => t.id === input.trial.id);

    let merged: Trial;
    let created = false;
    if (existingIdx >= 0) {
      merged = {
        ...trials[existingIdx],
        ...input.trial,
        starterCode: {
          ...trials[existingIdx].starterCode,
          ...input.trial.starterCode,
        },
        hints: {
          ...trials[existingIdx].hints,
          ...input.trial.hints,
        },
      };
      trials[existingIdx] = merged;
    } else {
      created = true;
      merged = input.trial;
      trials.push(merged);
    }

    const updatedRealm: Realm = { ...realm, trials };
    era.realms[realmIndex] = updatedRealm;
    await this.saveEra(era);
    return { era, realm: updatedRealm, trial: merged, created };
  }

  async deleteTrial(input: {
    eraId?: string;
    realmId: string;
    trialId: string;
  }): Promise<{ era: EraData; realm: Realm; deletedTrialId: string }> {
    const found = await this.findRealm(input.realmId, input.eraId);
    if (!found) {
      throw new Error(
        `Realm "${input.realmId}" not found${input.eraId ? ` in era "${input.eraId}"` : ""}.`
      );
    }

    const { era, realm, realmIndex } = found;
    const trials = Array.isArray(realm.trials) ? realm.trials : [];
    const nextTrials = trials.filter((t) => t.id !== input.trialId);
    if (nextTrials.length === trials.length) {
      throw new Error(
        `Trial "${input.trialId}" not found in realm "${input.realmId}".`
      );
    }

    const updatedRealm: Realm = { ...realm, trials: nextTrials };
    era.realms[realmIndex] = updatedRealm;
    await this.saveEra(era);
    return { era, realm: updatedRealm, deletedTrialId: input.trialId };
  }

  async setDifficultyOverride(input: {
    scope: "global" | "realm" | "trial";
    eraId?: string;
    realmId?: string;
    trialId?: string;
    override: DifficultyOverride | null;
    maxHintsAllowed?: number;
  }): Promise<{
    scope: "global" | "realm" | "trial";
    globalDifficultyOverride?: GlobalDifficultyOverride;
    realm?: Realm;
    trial?: Trial;
  }> {
    if (input.scope === "global") {
      const { config } = await this.loadGameConfig();
      const next: GlobalDifficultyOverride = {
        mode: input.override?.mode ?? config.globalDifficultyOverride.mode,
        showRawTracebacks:
          input.override?.showRawTracebacks ??
          config.globalDifficultyOverride.showRawTracebacks,
        maxHintsAllowed:
          input.maxHintsAllowed ??
          config.globalDifficultyOverride.maxHintsAllowed,
      };
      config.globalDifficultyOverride = next;
      await this.saveGameConfig(config);
      return { scope: "global", globalDifficultyOverride: next };
    }

    if (!input.realmId) {
      throw new Error(`realmId is required for scope "${input.scope}".`);
    }

    const found = await this.findRealm(input.realmId, input.eraId);
    if (!found) {
      throw new Error(`Realm "${input.realmId}" not found.`);
    }

    const { era, realm, realmIndex } = found;

    if (input.scope === "realm") {
      const updatedRealm: Realm = {
        ...realm,
        difficultyOverride: input.override,
      };
      era.realms[realmIndex] = updatedRealm;
      await this.saveEra(era);
      return { scope: "realm", realm: updatedRealm };
    }

    if (!input.trialId) {
      throw new Error('trialId is required for scope "trial".');
    }

    const trialIdx = (realm.trials || []).findIndex(
      (t) => t.id === input.trialId
    );
    if (trialIdx < 0) {
      throw new Error(
        `Trial "${input.trialId}" not found in realm "${input.realmId}".`
      );
    }

    const updatedTrial: Trial = {
      ...realm.trials[trialIdx],
      difficultyOverride: input.override,
    };
    const nextTrials = [...realm.trials];
    nextTrials[trialIdx] = updatedTrial;
    const updatedRealm: Realm = { ...realm, trials: nextTrials };
    era.realms[realmIndex] = updatedRealm;
    await this.saveEra(era);
    return { scope: "trial", realm: updatedRealm, trial: updatedTrial };
  }
}
