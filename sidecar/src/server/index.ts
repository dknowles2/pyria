import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runTrialTest } from "./pythonRunner.js";
import { ContentStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = "ui://pyria-builder/app.html";
const MCP_APP_MIME = "text/html;profile=mcp-app";

const PANE_META = {
  ui: { resourceUri: APP_URI },
  "com.google.antigravity/ui": {
    entrypoints: [
      { type: "aux_pane", title: "Pyria Builder" },
      { type: "global", title: "Pyria Builder" },
    ],
  },
};

const APP_ONLY_META = {
  ui: { visibility: ["app"] },
};

function parseContentDir(argv: string[]): string {
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

async function loadAppHtml(): Promise<string> {
  const htmlPath =
    process.env.PYRIA_APP_HTML || path.join(__dirname, "app.html");
  return readFile(htmlPath, "utf8");
}

const DifficultyModeSchema = z.enum(["explorer", "standard", "challenge"]);

const DifficultyOverrideSchema = z
  .object({
    mode: DifficultyModeSchema,
    showRawTracebacks: z.boolean(),
  })
  .nullable();

const DragonPatchSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  element: z.string().optional(),
  rescueDialogue: z.string().optional(),
});

const TrialSchema = z.object({
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
    challenge: z.string(),
  }),
  referenceSolution: z.string(),
  testCode: z.string(),
  hints: z.object({
    tier1_nudge: z.string(),
    tier2_pattern: z.string(),
    tier3_walkthrough: z.string(),
  }),
  difficultyOverride: DifficultyOverrideSchema,
});

function formatOverviewText(
  overview: Awaited<ReturnType<ContentStore["getGameOverview"]>>
): string {
  const lines: string[] = [
    `# ${overview.title} (${overview.currencyName})`,
    `Global Difficulty: ${overview.globalDifficultyOverride.mode} | Raw Tracebacks: ${overview.globalDifficultyOverride.showRawTracebacks} | Max Hints: ${overview.globalDifficultyOverride.maxHintsAllowed}`,
    `Concept Repetition Warnings: ${overview.warnings.length}`,
  ];
  if (overview.missingFiles.length > 0) {
    lines.push(`Missing content files: ${overview.missingFiles.join(", ")}`);
  }
  for (const era of overview.eras) {
    lines.push(
      `\n## ${era.name} (${era.id}) — ${era.realms.length} Realms (${era.visualStyle})`
    );
    for (const r of era.realms) {
      const diff = r.difficultyOverride
        ? ` [override: ${r.difficultyOverride.mode}]`
        : "";
      const warn = r.warningCount > 0 ? ` [${r.warningCount} warning(s)]` : "";
      lines.push(
        `- Realm ${r.number}: ${r.name} (${r.id}) — Dragon: ${r.dragonName}, ${r.trialCount} trial(s)${diff}${warn}`
      );
    }
  }
  return lines.join("\n");
}

const contentDir = parseContentDir(process.argv.slice(2));
const store = new ContentStore(contentDir);

const server = new McpServer({
  name: "pyria-builder",
  version: "1.0.0",
});

// UI Resource
server.registerResource(
  "Pyria Builder App",
  APP_URI,
  {
    description:
      "Interactive Pyria Builder sidecar UI for authoring Realms, Trials, Pip hints, and testing Python solutions.",
    mimeType: MCP_APP_MIME,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
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
              prefersBorder: false,
            },
          },
        },
      ],
    };
  }
);

// 1. open_pyria_builder (PANE entrypoint)
server.registerTool(
  "open_pyria_builder",
  {
    title: "Pyria Builder",
    description:
      "Open the Pyria Builder sidecar UI to browse and edit Eras, Realms, Trials, Pip hints, Byte Shard rewards, and difficulty overrides. All arguments are optional.",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID to select (e.g. era-01-8bit)"),
      realmId: z.string().optional().describe("Optional Realm ID to select"),
      trialId: z.string().optional().describe("Optional Trial ID to select"),
    },
    _meta: PANE_META,
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
      const firstRealmId = overview.eras.find((e) => e.id === targetEraId)
        ?.realms[0]?.id;
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
        trialId: args.trialId ?? selectedRealm?.trials[0]?.id ?? null,
      },
      selectedRealm,
    };

    const summaryText = selectedRealm
      ? `Opened Pyria Builder on Realm ${selectedRealm.number}: ${selectedRealm.name} (${selectedRealm.id}) in ${resolvedEraId}.\n\n${formatOverviewText(overview)}`
      : `Opened Pyria Builder.\n\n${formatOverviewText(overview)}`;

    return {
      content: [{ type: "text", text: summaryText }],
      structuredContent: structured,
    };
  }
);

// 2. get_game_overview
server.registerTool(
  "get_game_overview",
  {
    title: "Get Game Overview",
    description:
      "Return Pyria's eras, realms summary, global difficulty override, NPCs, and concept repetition warnings.",
    inputSchema: {},
  },
  async () => {
    const overview = await store.getGameOverview();
    return {
      content: [{ type: "text", text: formatOverviewText(overview) }],
      structuredContent: overview as unknown as Record<string, unknown>,
    };
  }
);

// 3. get_realm
server.registerTool(
  "get_realm",
  {
    title: "Get Realm",
    description:
      "Return the full JSON for a single Realm including its dragon details, story intro/outro, and all Trials.",
    inputSchema: {
      realmId: z.string().describe("Realm ID to load"),
      eraId: z.string().optional().describe("Optional Era ID to narrow lookup"),
    },
  },
  async (args) => {
    const found = await store.findRealm(args.realmId, args.eraId);
    if (!found) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Realm "${args.realmId}" not found.`,
          },
        ],
      };
    }

    const { era, realm } = found;
    return {
      content: [
        {
          type: "text",
          text: `Realm ${realm.number}: ${realm.name} (${realm.id}) in ${era.name} — Dragon: ${realm.dragon?.name}, ${realm.trials.length} trial(s).\n\n${JSON.stringify(realm, null, 2)}`,
        },
      ],
      structuredContent: {
        eraId: era.id,
        eraName: era.name,
        realm,
      },
    };
  }
);

// 4. upsert_realm
server.registerTool(
  "upsert_realm",
  {
    title: "Upsert Realm",
    description:
      "Update a Realm's name, storyIntro, storyOutro, dragon details, miniVisualUpgrade, primaryConcepts, or difficultyOverride.",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID"),
      realmId: z.string().describe("Realm ID to update"),
      name: z.string().optional(),
      storyIntro: z.string().optional(),
      storyOutro: z.string().optional(),
      miniVisualUpgrade: z.string().optional(),
      primaryConcepts: z.array(z.string()).optional(),
      dragon: DragonPatchSchema.optional(),
      difficultyOverride: DifficultyOverrideSchema.optional(),
    },
  },
  async (args) => {
    try {
      const { era, realm } = await store.upsertRealm(args);
      return {
        content: [
          {
            type: "text",
            text: `Saved Realm ${realm.number}: ${realm.name} (${realm.id}) in ${era.id}.`,
          },
        ],
        structuredContent: {
          eraId: era.id,
          realm,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }
);

// 5. upsert_trial
server.registerTool(
  "upsert_trial",
  {
    title: "Upsert Trial",
    description:
      "Add a new Trial or update an existing Trial inside a Realm (including starter code per difficulty, reference solution, testCode, and all 3 Pip hint tiers).",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID"),
      realmId: z.string().describe("Target Realm ID"),
      trial: TrialSchema,
    },
  },
  async (args) => {
    try {
      const { era, realm, trial, created } = await store.upsertTrial(args);
      return {
        content: [
          {
            type: "text",
            text: `${created ? "Created" : "Updated"} Trial "${trial.title}" (${trial.id}) in Realm ${realm.number}: ${realm.name}.`,
          },
        ],
        structuredContent: {
          eraId: era.id,
          realm,
          trial,
          created,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }
);

// 6. delete_trial
server.registerTool(
  "delete_trial",
  {
    title: "Delete Trial",
    description: "Remove a Trial from a Realm by trialId.",
    inputSchema: {
      eraId: z.string().optional().describe("Optional Era ID"),
      realmId: z.string().describe("Realm ID"),
      trialId: z.string().describe("Trial ID to delete"),
    },
  },
  async (args) => {
    try {
      const { era, realm, deletedTrialId } = await store.deleteTrial(args);
      return {
        content: [
          {
            type: "text",
            text: `Deleted Trial "${deletedTrialId}" from Realm ${realm.number}: ${realm.name}.`,
          },
        ],
        structuredContent: {
          eraId: era.id,
          realm,
          deletedTrialId,
        },
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }
);

// 7. set_difficulty_override
server.registerTool(
  "set_difficulty_override",
  {
    title: "Set Difficulty Override",
    description:
      "Set global, realm-level, or trial-level difficulty mode (explorer/standard/challenge) and raw Python traceback visibility. Pass override: null on realm or trial scope to inherit.",
    inputSchema: {
      scope: z.enum(["global", "realm", "trial"]),
      eraId: z.string().optional(),
      realmId: z.string().optional(),
      trialId: z.string().optional(),
      override: DifficultyOverrideSchema,
      maxHintsAllowed: z.number().int().min(0).max(10).optional(),
    },
  },
  async (args) => {
    try {
      const res = await store.setDifficultyOverride(args);
      return {
        content: [
          {
            type: "text",
            text: `Updated ${res.scope} difficulty override: ${JSON.stringify(
              res.globalDifficultyOverride ??
                res.trial?.difficultyOverride ??
                res.realm?.difficultyOverride ??
                null
            )}`,
          },
        ],
        structuredContent: res as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }
);

// 8. run_trial_test
server.registerTool(
  "run_trial_test",
  {
    title: "Run Trial Test",
    description:
      "Execute Python student/reference code followed by Trial testCode in a sandboxed python3 subprocess (3s timeout) with stdout captured into OUTPUT. Returns passed, stdout, stderr, and pipFriendlyHint.",
    inputSchema: {
      code: z.string().describe("Python code to execute (student or reference solution)"),
      testCode: z
        .string()
        .describe("Python assertions / test harness code (may inspect OUTPUT and student variables)"),
    },
  },
  async (args) => {
    const result = await runTrialTest(args.code, args.testCode, 3000);
    const statusLabel = result.passed ? "PASSED" : "FAILED";
    const summary = [
      `Result: ${statusLabel}${result.durationMs !== undefined ? ` (${result.durationMs}ms)` : ""}`,
      `Pip: ${result.pipFriendlyHint}`,
      result.stdout ? `STDOUT:\n${result.stdout}` : "",
      result.stderr ? `STDERR:\n${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  }
);

// 9. check_concept_repetition
server.registerTool(
  "check_concept_repetition",
  {
    title: "Check Concept Repetition",
    description:
      "Scan all Eras, Realms, and Trials and flag higher Realms repeating basic Python concepts past their maxBasicRealm threshold in game.json.",
    inputSchema: {},
  },
  async () => {
    const report = await store.checkConceptRepetition();
    const lines = [
      `Scanned ${report.totalRealmsScanned} realm(s) and ${report.totalTrialsScanned} trial(s).`,
      report.warnings.length === 0
        ? "No concept repetition warnings found!"
        : `Found ${report.warnings.length} repetition warning(s):`,
      ...report.warnings.map((w) => `- ${w.message}`),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: report as unknown as Record<string, unknown>,
    };
  }
);

// 10. App-only helper to load catalog + NPCs for reference tab
server.registerTool(
  "app_get_catalog",
  {
    title: "Get Catalog and NPCs",
    description: "App-only helper returning catalog.json and game.json NPCs.",
    inputSchema: {},
    _meta: APP_ONLY_META,
  },
  async () => {
    const { config } = await store.loadGameConfig();
    const { catalog } = await store.loadCatalog();
    return {
      content: [{ type: "text", text: "Loaded catalog and NPCs." }],
      structuredContent: {
        npcs: config.npcs,
        currencyName: config.currencyName,
        catalog,
      },
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
