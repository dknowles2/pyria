#!/usr/bin/env node

// src/server/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile as readFile2 } from "node:fs/promises";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// src/server/pythonRunner.ts
import { spawn } from "node:child_process";
var PYTHON_HARNESS = `
import io
import json
import sys
import traceback
from contextlib import redirect_stdout

payload = json.loads(sys.stdin.read())
student_code = payload.get("code", "")
test_code = payload.get("testCode", "")

stdout_buf = io.StringIO()
ns = {"__name__": "__main__"}
result = {
    "passed": False,
    "stdout": "",
    "stderr": "",
    "errorType": None,
    "errorMessage": None,
    "phase": "student",
}

try:
    with redirect_stdout(stdout_buf):
        exec(compile(student_code, "<hero_spell>", "exec"), ns)
    captured = stdout_buf.getvalue()
    ns["OUTPUT"] = captured
    result["stdout"] = captured
    result["phase"] = "test"
    if test_code.strip():
        test_stdout = io.StringIO()
        with redirect_stdout(test_stdout):
            exec(compile(test_code, "<trial_test>", "exec"), ns)
        extra = test_stdout.getvalue()
        if extra:
            result["stdout"] = captured + extra
    result["passed"] = True
except BaseException as exc:
    result["stdout"] = stdout_buf.getvalue()
    result["errorType"] = type(exc).__name__
    result["errorMessage"] = str(exc)
    result["stderr"] = traceback.format_exc()

sys.stdout.write(json.dumps(result))
`;
function buildPipHint(passed, errorType, errorMessage, phase, timedOut) {
  if (passed) {
    return "Pip chirps happily! Your Python spell passed every single test rune!";
  }
  if (timedOut) {
    return "Whoa, Pip got dizzy! Your spell took longer than 3 seconds \u2014 check if a loop is running forever.";
  }
  const msg = errorMessage || "";
  switch (errorType) {
    case "SyntaxError":
      return `Pip spotted a typo in your spell syntax (${msg || "check quotes, colons ':', and matching parentheses '()'"}).`;
    case "IndentationError":
    case "TabError":
      return "Pip noticed uneven spacing! In Python, lines inside an `if`, `for`, or `def` block need the exact same indentation (4 spaces).";
    case "NameError": {
      const match = msg.match(/name '([^']+)' is not defined/);
      const name = match ? match[1] : "that name";
      return `Pip scratched his head \u2014 Python doesn't know '${name}' yet. Check the spelling or make sure you defined it before using it!`;
    }
    case "TypeError":
      return `Pip saw two mismatched types bumping into each other (${msg}). Remember you can't mix strings and numbers without converting them (like str() or int())!`;
    case "ValueError":
      return `Pip says the right kind of value was passed, but its contents didn't work (${msg}). Double-check the exact text or number!`;
    case "ZeroDivisionError":
      return "Pip ducked! Dividing by zero makes the magic runes explode \u2014 check your divisor.";
    case "IndexError":
      return "Pip peeked past the end of your list! Remember Python lists start counting at 0.";
    case "KeyError":
      return `Pip couldn't find that key in the dictionary (${msg}). Check the spelling and quotes!`;
    case "AssertionError":
      if (msg) {
        return `Almost there! Pip checked the Trial runes and found: ${msg}`;
      }
      return "Almost there! Your code ran without crashing, but the output or variable value didn't quite match what the Trial expects.";
    default:
      if (phase === "test") {
        return `Pip saw your spell run, but a test check failed (${errorType || "Error"}: ${msg || "check expected values"}).`;
      }
      return `Pip bumped into a ${errorType || "Python error"}: ${msg || "check your spell carefully and try again!"}`;
  }
}
async function runTrialTest(code, testCode, timeoutMs = 3e3) {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", "-c", PYTHON_HARNESS], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        PYTHONIOENCODING: "utf-8"
      }
    });
    let stdoutRaw = "";
    let stderrRaw = "";
    let timedOut = false;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish({
        passed: false,
        stdout: "",
        stderr: `Execution timed out after ${timeoutMs}ms`,
        pipFriendlyHint: buildPipHint(false, "TimeoutError", null, "student", true),
        timedOut: true,
        durationMs: Date.now() - start
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutRaw += chunk.toString("utf8");
      if (stdoutRaw.length > 262144) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrRaw += chunk.toString("utf8");
      if (stderrRaw.length > 262144) {
        child.kill("SIGKILL");
      }
    });
    child.on("error", (err) => {
      finish({
        passed: false,
        stdout: "",
        stderr: `Failed to launch python3: ${err.message}`,
        pipFriendlyHint: "Pip couldn't wake up the Python engine (`python3`). Make sure Python 3 is installed on this machine.",
        durationMs: Date.now() - start
      });
    });
    child.on("close", () => {
      if (timedOut) return;
      const durationMs = Date.now() - start;
      try {
        const parsed = JSON.parse(stdoutRaw);
        finish({
          passed: Boolean(parsed.passed),
          stdout: parsed.stdout ?? "",
          stderr: parsed.stderr ?? stderrRaw,
          pipFriendlyHint: buildPipHint(
            Boolean(parsed.passed),
            parsed.errorType ?? null,
            parsed.errorMessage ?? null,
            parsed.phase ?? "student",
            false
          ),
          timedOut: false,
          durationMs
        });
      } catch {
        finish({
          passed: false,
          stdout: stdoutRaw,
          stderr: stderrRaw || "Unexpected runner output",
          pipFriendlyHint: buildPipHint(
            false,
            "RuntimeError",
            stderrRaw.trim().split("\n").pop() || null,
            "student",
            false
          ),
          timedOut: false,
          durationMs
        });
      }
    });
    child.stdin.write(JSON.stringify({ code, testCode }));
    child.stdin.end();
  });
}

// src/server/store.ts
import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
var DEFAULT_GAME_CONFIG = {
  title: "Pyria",
  version: "0.1.0",
  currencyName: "Byte Shards",
  terminology: {
    era: "Era",
    realm: "Realm",
    trial: "Trial"
  },
  globalDifficultyOverride: {
    mode: "standard",
    showRawTracebacks: false,
    maxHintsAllowed: 3
  },
  eraOrder: ["era-01-8bit", "era-02-16bit"],
  npcs: [],
  conceptProgression: []
};
var DEFAULT_CATALOG = {
  characterCreation: {},
  unlockables: []
};
async function readJsonSafe(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmpPath, filePath);
}
var ContentStore = class {
  contentDir;
  constructor(contentDir2) {
    this.contentDir = path.resolve(contentDir2);
  }
  get gamePath() {
    return path.join(this.contentDir, "game.json");
  }
  get catalogPath() {
    return path.join(this.contentDir, "catalog.json");
  }
  get erasDir() {
    return path.join(this.contentDir, "eras");
  }
  eraPath(eraId) {
    return path.join(this.erasDir, `${eraId}.json`);
  }
  async loadGameConfig() {
    const data = await readJsonSafe(this.gamePath);
    if (!data) {
      return { config: structuredClone(DEFAULT_GAME_CONFIG), exists: false };
    }
    return {
      config: {
        ...DEFAULT_GAME_CONFIG,
        ...data,
        terminology: {
          ...DEFAULT_GAME_CONFIG.terminology,
          ...data.terminology ?? {}
        },
        globalDifficultyOverride: {
          ...DEFAULT_GAME_CONFIG.globalDifficultyOverride,
          ...data.globalDifficultyOverride ?? {}
        },
        eraOrder: Array.isArray(data.eraOrder) ? data.eraOrder : DEFAULT_GAME_CONFIG.eraOrder,
        npcs: Array.isArray(data.npcs) ? data.npcs : [],
        conceptProgression: Array.isArray(data.conceptProgression) ? data.conceptProgression : []
      },
      exists: true
    };
  }
  async saveGameConfig(config) {
    await writeJsonAtomic(this.gamePath, config);
  }
  async loadCatalog() {
    const data = await readJsonSafe(this.catalogPath);
    if (!data) {
      return { catalog: structuredClone(DEFAULT_CATALOG), exists: false };
    }
    return {
      catalog: {
        ...DEFAULT_CATALOG,
        ...data,
        unlockables: Array.isArray(data.unlockables) ? data.unlockables : []
      },
      exists: true
    };
  }
  async listEraIds(gameConfig) {
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
    }
    return ordered;
  }
  async loadEra(eraId) {
    const data = await readJsonSafe(this.eraPath(eraId));
    if (!data) return null;
    return {
      ...data,
      realms: Array.isArray(data.realms) ? data.realms : []
    };
  }
  async saveEra(era) {
    await writeJsonAtomic(this.eraPath(era.id), era);
  }
  async loadAllEras(gameConfig) {
    const eraIds = await this.listEraIds(gameConfig);
    const eras = [];
    const missingEraFiles = [];
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
  async findRealm(realmId, eraId) {
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
  computeRepetitionWarnings(config, eras) {
    const warnings = [];
    const conceptMap = /* @__PURE__ */ new Map();
    for (const entry of config.conceptProgression) {
      if (entry && typeof entry.id === "string") {
        conceptMap.set(entry.id, entry);
      }
    }
    const eraOrder = config.eraOrder.length ? config.eraOrder : eras.map((e) => e.id);
    const eraRank = (eraId) => {
      const idx = eraOrder.indexOf(eraId);
      return idx >= 0 ? idx : 999;
    };
    let cumulativeOffset = 0;
    for (const era of eras) {
      const currentEraRank = eraRank(era.id);
      for (const realm of era.realms) {
        const globalRealmNum = cumulativeOffset + (realm.number || 0);
        const checkConcept = (conceptId, source, trial) => {
          const rule = conceptMap.get(conceptId);
          if (!rule || typeof rule.maxBasicRealm !== "number") return;
          const minEraRank = eraRank(rule.minEra);
          const exceedsInSameEra = currentEraRank === minEraRank && realm.number > rule.maxBasicRealm;
          const exceedsInLaterEra = currentEraRank > minEraRank && globalRealmNum > rule.maxBasicRealm;
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
              message: trial ? `Realm ${realm.number} (${realm.name}) Trial "${trial.title}" repeats basic concept "${conceptId}" past maxBasicRealm ${rule.maxBasicRealm}.` : `Realm ${realm.number} (${realm.name}) lists basic concept "${conceptId}" in primaryConcepts past maxBasicRealm ${rule.maxBasicRealm}.`
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
  async getGameOverview() {
    const missingFiles = [];
    const { config, exists: gameExists } = await this.loadGameConfig();
    if (!gameExists) missingFiles.push("game.json");
    const { catalog, exists: catalogExists } = await this.loadCatalog();
    if (!catalogExists) missingFiles.push("catalog.json");
    const { eras, missingEraFiles } = await this.loadAllEras(config);
    missingFiles.push(...missingEraFiles);
    const warnings = this.computeRepetitionWarnings(config, eras);
    const warningsByRealm = /* @__PURE__ */ new Map();
    for (const w of warnings) {
      warningsByRealm.set(w.realmId, (warningsByRealm.get(w.realmId) ?? 0) + 1);
    }
    const eraSummaries = eras.map((era) => ({
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
        primaryConcepts: Array.isArray(r.primaryConcepts) ? r.primaryConcepts : [],
        difficultyOverride: r.difficultyOverride ?? null,
        warningCount: warningsByRealm.get(r.id) ?? 0
      }))
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
      unlockablesCount: catalog.unlockables.length
    };
  }
  async checkConceptRepetition() {
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
      totalTrialsScanned
    };
  }
  async upsertRealm(input) {
    const found = await this.findRealm(input.realmId, input.eraId);
    if (!found) {
      throw new Error(
        `Realm "${input.realmId}" not found${input.eraId ? ` in era "${input.eraId}"` : ""}.`
      );
    }
    const { era, realm, realmIndex } = found;
    const updated = {
      ...realm,
      ...input.name !== void 0 ? { name: input.name } : {},
      ...input.storyIntro !== void 0 ? { storyIntro: input.storyIntro } : {},
      ...input.storyOutro !== void 0 ? { storyOutro: input.storyOutro } : {},
      ...input.miniVisualUpgrade !== void 0 ? { miniVisualUpgrade: input.miniVisualUpgrade } : {},
      ...input.primaryConcepts !== void 0 ? { primaryConcepts: input.primaryConcepts } : {},
      ...input.dragon !== void 0 ? {
        dragon: {
          ...realm.dragon,
          ...input.dragon
        }
      } : {},
      ...input.difficultyOverride !== void 0 ? { difficultyOverride: input.difficultyOverride } : {}
    };
    era.realms[realmIndex] = updated;
    await this.saveEra(era);
    return { era, realm: updated };
  }
  async upsertTrial(input) {
    const found = await this.findRealm(input.realmId, input.eraId);
    if (!found) {
      throw new Error(
        `Realm "${input.realmId}" not found${input.eraId ? ` in era "${input.eraId}"` : ""}.`
      );
    }
    const { era, realm, realmIndex } = found;
    const trials = Array.isArray(realm.trials) ? [...realm.trials] : [];
    const existingIdx = trials.findIndex((t) => t.id === input.trial.id);
    let merged;
    let created = false;
    if (existingIdx >= 0) {
      merged = {
        ...trials[existingIdx],
        ...input.trial,
        starterCode: {
          ...trials[existingIdx].starterCode,
          ...input.trial.starterCode
        },
        hints: {
          ...trials[existingIdx].hints,
          ...input.trial.hints
        }
      };
      trials[existingIdx] = merged;
    } else {
      created = true;
      merged = input.trial;
      trials.push(merged);
    }
    const updatedRealm = { ...realm, trials };
    era.realms[realmIndex] = updatedRealm;
    await this.saveEra(era);
    return { era, realm: updatedRealm, trial: merged, created };
  }
  async deleteTrial(input) {
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
    const updatedRealm = { ...realm, trials: nextTrials };
    era.realms[realmIndex] = updatedRealm;
    await this.saveEra(era);
    return { era, realm: updatedRealm, deletedTrialId: input.trialId };
  }
  async setDifficultyOverride(input) {
    if (input.scope === "global") {
      const { config } = await this.loadGameConfig();
      const next = {
        mode: input.override?.mode ?? config.globalDifficultyOverride.mode,
        showRawTracebacks: input.override?.showRawTracebacks ?? config.globalDifficultyOverride.showRawTracebacks,
        maxHintsAllowed: input.maxHintsAllowed ?? config.globalDifficultyOverride.maxHintsAllowed
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
      const updatedRealm2 = {
        ...realm,
        difficultyOverride: input.override
      };
      era.realms[realmIndex] = updatedRealm2;
      await this.saveEra(era);
      return { scope: "realm", realm: updatedRealm2 };
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
    const updatedTrial = {
      ...realm.trials[trialIdx],
      difficultyOverride: input.override
    };
    const nextTrials = [...realm.trials];
    nextTrials[trialIdx] = updatedTrial;
    const updatedRealm = { ...realm, trials: nextTrials };
    era.realms[realmIndex] = updatedRealm;
    await this.saveEra(era);
    return { scope: "trial", realm: updatedRealm, trial: updatedTrial };
  }
};

// src/server/index.ts
var __dirname = path2.dirname(fileURLToPath(import.meta.url));
var APP_URI = "ui://pyria-builder/app.html";
var MCP_APP_MIME = "text/html;profile=mcp-app";
var PANE_META = {
  ui: { resourceUri: APP_URI },
  "com.google.antigravity/ui": {
    entrypoints: [
      { type: "aux_pane", title: "Pyria Builder" },
      { type: "global", title: "Pyria Builder" }
    ]
  }
};
var APP_ONLY_META = {
  ui: { visibility: ["app"] }
};
function parseContentDir(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--content-dir=")) {
      return arg.slice("--content-dir=".length);
    }
    if (arg === "--content-dir" && argv[i + 1]) {
      return argv[i + 1];
    }
  }
  return process.env.PYRIA_CONTENT_DIR || "/Users/dknowles/src/pyria/content";
}
async function loadAppHtml() {
  const htmlPath = process.env.PYRIA_APP_HTML || path2.join(__dirname, "app.html");
  return readFile2(htmlPath, "utf8");
}
var DifficultyModeSchema = z.enum(["explorer", "standard", "challenge"]);
var DifficultyOverrideSchema = z.object({
  mode: DifficultyModeSchema,
  showRawTracebacks: z.boolean()
}).nullable();
var DragonPatchSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  element: z.string().optional(),
  rescueDialogue: z.string().optional()
});
var TrialSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  storyPrompt: z.string(),
  objective: z.string(),
  concepts: z.array(z.string()),
  shardReward: z.number().int().min(0),
  unlockId: z.string().nullable(),
  starterCode: z.object({
    explorer: z.string(),
    standard: z.string(),
    challenge: z.string()
  }),
  referenceSolution: z.string(),
  testCode: z.string(),
  hints: z.object({
    tier1_nudge: z.string(),
    tier2_pattern: z.string(),
    tier3_walkthrough: z.string()
  }),
  difficultyOverride: DifficultyOverrideSchema
});
function formatOverviewText(overview) {
  const lines = [
    `# ${overview.title} (${overview.currencyName})`,
    `Global Difficulty: ${overview.globalDifficultyOverride.mode} | Raw Tracebacks: ${overview.globalDifficultyOverride.showRawTracebacks} | Max Hints: ${overview.globalDifficultyOverride.maxHintsAllowed}`,
    `Concept Repetition Warnings: ${overview.warnings.length}`
  ];
  if (overview.missingFiles.length > 0) {
    lines.push(`Missing content files: ${overview.missingFiles.join(", ")}`);
  }
  for (const era of overview.eras) {
    lines.push(
      `
## ${era.name} (${era.id}) \u2014 ${era.realms.length} Realms (${era.visualStyle})`
    );
    for (const r of era.realms) {
      const diff = r.difficultyOverride ? ` [override: ${r.difficultyOverride.mode}]` : "";
      const warn = r.warningCount > 0 ? ` [${r.warningCount} warning(s)]` : "";
      lines.push(
        `- Realm ${r.number}: ${r.name} (${r.id}) \u2014 Dragon: ${r.dragonName}, ${r.trialCount} trial(s)${diff}${warn}`
      );
    }
  }
  return lines.join("\n");
}
var contentDir = parseContentDir(process.argv.slice(2));
var store = new ContentStore(contentDir);
var server = new McpServer({
  name: "pyria-builder",
  version: "1.0.0"
});
server.registerResource(
  "Pyria Builder App",
  APP_URI,
  {
    description: "Interactive Pyria Builder sidecar UI for authoring Realms, Trials, Pip hints, and testing Python solutions.",
    mimeType: MCP_APP_MIME,
    _meta: {
      ui: {
        prefersBorder: false
      }
    }
  },
  async () => {
    const html = await loadAppHtml();
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: MCP_APP_MIME,
          text: html,
          _meta: {
            ui: {
              prefersBorder: false
            }
          }
        }
      ]
    };
  }
);
server.registerTool(
  "open_pyria_builder",
  {
    title: "Pyria Builder",
    description: "Open the Pyria Builder sidecar UI to browse and edit Eras, Realms, Trials, Pip hints, Byte Shard rewards, and difficulty overrides. All arguments are optional.",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID to select (e.g. era-01-8bit)"),
      realmId: z.string().optional().describe("Optional Realm ID to select"),
      trialId: z.string().optional().describe("Optional Trial ID to select")
    },
    _meta: PANE_META
  },
  async (args) => {
    const overview = await store.getGameOverview();
    const targetEraId = args.eraId || overview.eras[0]?.id || null;
    let selectedRealm = null;
    let resolvedEraId = targetEraId;
    if (args.realmId) {
      const found = await store.findRealm(args.realmId, args.eraId);
      if (found) {
        selectedRealm = found.realm;
        resolvedEraId = found.era.id;
      }
    } else if (targetEraId) {
      const firstRealmId = overview.eras.find((e) => e.id === targetEraId)?.realms[0]?.id;
      if (firstRealmId) {
        const found = await store.findRealm(firstRealmId, targetEraId);
        if (found) {
          selectedRealm = found.realm;
        }
      }
    }
    const structured = {
      overview,
      selection: {
        eraId: resolvedEraId,
        realmId: selectedRealm?.id ?? args.realmId ?? null,
        trialId: args.trialId ?? selectedRealm?.trials[0]?.id ?? null
      },
      selectedRealm
    };
    const summaryText = selectedRealm ? `Opened Pyria Builder on Realm ${selectedRealm.number}: ${selectedRealm.name} (${selectedRealm.id}) in ${resolvedEraId}.

${formatOverviewText(overview)}` : `Opened Pyria Builder.

${formatOverviewText(overview)}`;
    return {
      content: [{ type: "text", text: summaryText }],
      structuredContent: structured
    };
  }
);
server.registerTool(
  "get_game_overview",
  {
    title: "Get Game Overview",
    description: "Return Pyria's eras, realms summary, global difficulty override, NPCs, and concept repetition warnings.",
    inputSchema: {}
  },
  async () => {
    const overview = await store.getGameOverview();
    return {
      content: [{ type: "text", text: formatOverviewText(overview) }],
      structuredContent: overview
    };
  }
);
server.registerTool(
  "get_realm",
  {
    title: "Get Realm",
    description: "Return the full JSON for a single Realm including its dragon details, story intro/outro, and all Trials.",
    inputSchema: {
      realmId: z.string().describe("Realm ID to load"),
      eraId: z.string().optional().describe("Optional Era ID to narrow lookup")
    }
  },
  async (args) => {
    const found = await store.findRealm(args.realmId, args.eraId);
    if (!found) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Realm "${args.realmId}" not found.`
          }
        ]
      };
    }
    const { era, realm } = found;
    return {
      content: [
        {
          type: "text",
          text: `Realm ${realm.number}: ${realm.name} (${realm.id}) in ${era.name} \u2014 Dragon: ${realm.dragon?.name}, ${realm.trials.length} trial(s).

${JSON.stringify(realm, null, 2)}`
        }
      ],
      structuredContent: {
        eraId: era.id,
        eraName: era.name,
        realm
      }
    };
  }
);
server.registerTool(
  "upsert_realm",
  {
    title: "Upsert Realm",
    description: "Update a Realm's name, storyIntro, storyOutro, dragon details, miniVisualUpgrade, primaryConcepts, or difficultyOverride.",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID"),
      realmId: z.string().describe("Realm ID to update"),
      name: z.string().optional(),
      storyIntro: z.string().optional(),
      storyOutro: z.string().optional(),
      miniVisualUpgrade: z.string().optional(),
      primaryConcepts: z.array(z.string()).optional(),
      dragon: DragonPatchSchema.optional(),
      difficultyOverride: DifficultyOverrideSchema.optional()
    }
  },
  async (args) => {
    try {
      const { era, realm } = await store.upsertRealm(args);
      return {
        content: [
          {
            type: "text",
            text: `Saved Realm ${realm.number}: ${realm.name} (${realm.id}) in ${era.id}.`
          }
        ],
        structuredContent: {
          eraId: era.id,
          realm
        }
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err)
          }
        ]
      };
    }
  }
);
server.registerTool(
  "upsert_trial",
  {
    title: "Upsert Trial",
    description: "Add a new Trial or update an existing Trial inside a Realm (including starter code per difficulty, reference solution, testCode, and all 3 Pip hint tiers).",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID"),
      realmId: z.string().describe("Target Realm ID"),
      trial: TrialSchema
    }
  },
  async (args) => {
    try {
      const { era, realm, trial, created } = await store.upsertTrial(args);
      return {
        content: [
          {
            type: "text",
            text: `${created ? "Created" : "Updated"} Trial "${trial.title}" (${trial.id}) in Realm ${realm.number}: ${realm.name}.`
          }
        ],
        structuredContent: {
          eraId: era.id,
          realm,
          trial,
          created
        }
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err)
          }
        ]
      };
    }
  }
);
server.registerTool(
  "delete_trial",
  {
    title: "Delete Trial",
    description: "Remove a Trial from a Realm by trialId.",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID"),
      realmId: z.string().describe("Realm ID"),
      trialId: z.string().describe("Trial ID to delete")
    }
  },
  async (args) => {
    try {
      const { era, realm, deletedTrialId } = await store.deleteTrial(args);
      return {
        content: [
          {
            type: "text",
            text: `Deleted Trial "${deletedTrialId}" from Realm ${realm.number}: ${realm.name}.`
          }
        ],
        structuredContent: {
          eraId: era.id,
          realm,
          deletedTrialId
        }
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err)
          }
        ]
      };
    }
  }
);
server.registerTool(
  "set_difficulty_override",
  {
    title: "Set Difficulty Override",
    description: "Set global, realm-level, or trial-level difficulty mode (explorer/standard/challenge) and raw Python traceback visibility. Pass override: null on realm or trial scope to inherit.",
    inputSchema: {
      scope: z.enum(["global", "realm", "trial"]),
      eraId: z.string().optional(),
      realmId: z.string().optional(),
      trialId: z.string().optional(),
      override: DifficultyOverrideSchema,
      maxHintsAllowed: z.number().int().min(0).max(10).optional()
    }
  },
  async (args) => {
    try {
      const res = await store.setDifficultyOverride(args);
      return {
        content: [
          {
            type: "text",
            text: `Updated ${res.scope} difficulty override: ${JSON.stringify(
              res.globalDifficultyOverride ?? res.trial?.difficultyOverride ?? res.realm?.difficultyOverride ?? null
            )}`
          }
        ],
        structuredContent: res
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err)
          }
        ]
      };
    }
  }
);
server.registerTool(
  "run_trial_test",
  {
    title: "Run Trial Test",
    description: "Execute Python student/reference code followed by Trial testCode in a sandboxed python3 subprocess (3s timeout) with stdout captured into OUTPUT. Returns passed, stdout, stderr, and pipFriendlyHint.",
    inputSchema: {
      code: z.string().describe("Python code to execute (student or reference solution)"),
      testCode: z.string().describe("Python assertions / test harness code (may inspect OUTPUT and student variables)")
    }
  },
  async (args) => {
    const result = await runTrialTest(args.code, args.testCode, 3e3);
    const statusLabel = result.passed ? "PASSED" : "FAILED";
    const summary = [
      `Result: ${statusLabel}${result.durationMs !== void 0 ? ` (${result.durationMs}ms)` : ""}`,
      `Pip: ${result.pipFriendlyHint}`,
      result.stdout ? `STDOUT:
${result.stdout}` : "",
      result.stderr ? `STDERR:
${result.stderr}` : ""
    ].filter(Boolean).join("\n\n");
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: result
    };
  }
);
server.registerTool(
  "check_concept_repetition",
  {
    title: "Check Concept Repetition",
    description: "Scan all Eras, Realms, and Trials and flag higher Realms repeating basic Python concepts past their maxBasicRealm threshold in game.json.",
    inputSchema: {}
  },
  async () => {
    const report = await store.checkConceptRepetition();
    const lines = [
      `Scanned ${report.totalRealmsScanned} realm(s) and ${report.totalTrialsScanned} trial(s).`,
      report.warnings.length === 0 ? "No concept repetition warnings found!" : `Found ${report.warnings.length} repetition warning(s):`,
      ...report.warnings.map((w) => `- ${w.message}`)
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: report
    };
  }
);
server.registerTool(
  "app_get_catalog",
  {
    title: "Get Catalog and NPCs",
    description: "App-only helper returning catalog.json and game.json NPCs.",
    inputSchema: {},
    _meta: APP_ONLY_META
  },
  async () => {
    const { config } = await store.loadGameConfig();
    const { catalog } = await store.loadCatalog();
    return {
      content: [{ type: "text", text: "Loaded catalog and NPCs." }],
      structuredContent: {
        npcs: config.npcs,
        currencyName: config.currencyName,
        catalog
      }
    };
  }
);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => {
  console.error("Pyria Builder MCP server failed:", err);
  process.exit(1);
});
//# sourceMappingURL=server.mjs.map
