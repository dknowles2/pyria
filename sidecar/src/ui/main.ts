import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type {
  CatalogData,
  DifficultyMode,
  DifficultyOverride,
  GameOverview,
  NpcDefinition,
  Realm,
  RepetitionWarning,
  Trial,
  TrialTestResult,
} from "../shared/types.js";

type MainTab = "realms" | "health" | "catalog";
type StarterTab = DifficultyMode;

interface UiState {
  connected: boolean;
  canUpdateContext: boolean;
  mainTab: MainTab;
  overview: GameOverview | null;
  selectedEraId: string | null;
  selectedRealmId: string | null;
  selectedRealm: Realm | null;
  selectedTrialId: string | null;
  starterTab: StarterTab;
  testResult: TrialTestResult | null;
  testing: boolean;
  saving: boolean;
  statusBanner: { kind: "info" | "success" | "warn" | "danger"; text: string } | null;
  catalog: CatalogData | null;
  catalogNpcs: NpcDefinition[];
  healthWarnings: RepetitionWarning[];
}

const state: UiState = {
  connected: false,
  canUpdateContext: false,
  mainTab: "realms",
  overview: null,
  selectedEraId: null,
  selectedRealmId: null,
  selectedRealm: null,
  selectedTrialId: null,
  starterTab: "standard",
  testResult: null,
  testing: false,
  saving: false,
  statusBanner: null,
  catalog: null,
  catalogNpcs: [],
  healthWarnings: [],
};

const app = new App({ name: "Pyria Builder", version: "1.0.0" }, {});

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setBanner(
  kind: "info" | "success" | "warn" | "danger",
  text: string
): void {
  state.statusBanner = { kind, text };
  render();
}

function parseConcepts(csv: string): string[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getSelectedTrial(): Trial | null {
  if (!state.selectedRealm || !state.selectedTrialId) return null;
  return (
    state.selectedRealm.trials.find((t) => t.id === state.selectedTrialId) ??
    null
  );
}

function extractStructured<T>(res: unknown): T | null {
  if (!res || typeof res !== "object") return null;
  const r = res as { structuredContent?: T };
  return r.structuredContent ?? null;
}

async function refreshOverview(keepSelection = true): Promise<void> {
  const res = await app.callServerTool({
    name: "get_game_overview",
    arguments: {},
  });
  const overview = extractStructured<GameOverview>(res);
  if (!overview) return;
  state.overview = overview;
  state.healthWarnings = overview.warnings || [];

  if (!keepSelection || !state.selectedEraId) {
    state.selectedEraId = overview.eras[0]?.id ?? null;
  }
  const era =
    overview.eras.find((e) => e.id === state.selectedEraId) ?? overview.eras[0];
  if (era) {
    state.selectedEraId = era.id;
    const realmExists = era.realms.some((r) => r.id === state.selectedRealmId);
    if (!keepSelection || !realmExists) {
      const nextRealmId = era.realms[0]?.id ?? null;
      if (nextRealmId) {
        await loadRealm(nextRealmId, era.id);
      } else {
        state.selectedRealmId = null;
        state.selectedRealm = null;
        state.selectedTrialId = null;
      }
    }
  }
  render();
}

async function loadRealm(realmId: string, eraId?: string): Promise<void> {
  const res = await app.callServerTool({
    name: "get_realm",
    arguments: eraId ? { realmId, eraId } : { realmId },
  });
  const data = extractStructured<{ eraId: string; realm: Realm }>(res);
  if (!data?.realm) return;
  state.selectedEraId = data.eraId;
  state.selectedRealmId = data.realm.id;
  state.selectedRealm = data.realm;
  const stillHasTrial = data.realm.trials.some(
    (t) => t.id === state.selectedTrialId
  );
  state.selectedTrialId = stillHasTrial
    ? state.selectedTrialId
    : (data.realm.trials[0]?.id ?? null);
  state.testResult = null;
  render();
}

async function loadCatalog(): Promise<void> {
  const res = await app.callServerTool({
    name: "app_get_catalog",
    arguments: {},
  });
  const data = extractStructured<{
    npcs: NpcDefinition[];
    catalog: CatalogData;
  }>(res);
  if (!data) return;
  state.catalog = data.catalog;
  state.catalogNpcs = data.npcs || [];
  render();
}

async function runConceptCheck(): Promise<void> {
  const res = await app.callServerTool({
    name: "check_concept_repetition",
    arguments: {},
  });
  const data = extractStructured<{ warnings: RepetitionWarning[] }>(res);
  if (data) {
    state.healthWarnings = data.warnings;
    if (state.overview) {
      state.overview.warnings = data.warnings;
    }
    setBanner(
      data.warnings.length === 0 ? "success" : "warn",
      data.warnings.length === 0
        ? "Concept check passed: zero repetition warnings."
        : `Found ${data.warnings.length} concept repetition warning(s).`
    );
  }
}

async function attachRealmToChat(): Promise<void> {
  if (!state.canUpdateContext || !state.selectedRealm) return;
  const r = state.selectedRealm;
  const trialLines =
    r.trials.length > 0
      ? r.trials
          .map(
            (t, idx) =>
              `${idx + 1}. **${t.title}** (\`${t.id}\`) — Concepts: ${t.concepts.join(", ") || "none"} | Reward: ${t.shardReward} Byte Shards\n   - Objective: ${t.objective}`
          )
          .join("\n")
      : "_No trials yet._";

  const md = [
    `## Pyria Context: Realm ${r.number} — ${r.name} (\`${r.id}\`)`,
    `- **Era**: \`${state.selectedEraId}\``,
    `- **Dragon Guardian**: ${r.dragon?.name} (${r.dragon?.title}, ${r.dragon?.element})`,
    `- **Mini Visual Upgrade**: ${r.miniVisualUpgrade}`,
    `- **Primary Concepts**: ${r.primaryConcepts.join(", ") || "none"}`,
    `- **Difficulty Override**: ${r.difficultyOverride ? `${r.difficultyOverride.mode} (rawTracebacks=${r.difficultyOverride.showRawTracebacks})` : "inherit global"}`,
    `\n### Story Intro\n${r.storyIntro}`,
    `\n### Story Outro\n${r.storyOutro}`,
    `\n### Trials (${r.trials.length})\n${trialLines}`,
  ].join("\n");

  await app.updateModelContext({
    content: [{ type: "text", text: md }],
  });
  setBanner("success", `Attached Realm ${r.number} (${r.name}) to chat context.`);
}

async function attachTrialToChat(): Promise<void> {
  if (!state.canUpdateContext || !state.selectedRealm) return;
  const r = state.selectedRealm;
  const t = getSelectedTrial();
  if (!t) return;

  const md = [
    `## Pyria Context: Trial "${t.title}" (\`${t.id}\`)`,
    `- **Realm**: Realm ${r.number} — ${r.name} (\`${r.id}\`, Era \`${state.selectedEraId}\`)`,
    `- **Dragon**: ${r.dragon?.name} | **Reward**: ${t.shardReward} Byte Shards | **Unlock**: ${t.unlockId ?? "none"}`,
    `- **Concepts**: ${t.concepts.join(", ") || "none"}`,
    `- **Objective**: ${t.objective}`,
    `\n### Story Prompt\n${t.storyPrompt}`,
    `\n### Reference Solution\n\`\`\`python\n${t.referenceSolution}\n\`\`\``,
    `\n### Test Code\n\`\`\`python\n${t.testCode}\n\`\`\``,
    `\n### Pip Hints\n- **Tier 1 (Nudge)**: ${t.hints.tier1_nudge}\n- **Tier 2 (Pattern)**: ${t.hints.tier2_pattern}\n- **Tier 3 (Walkthrough)**: ${t.hints.tier3_walkthrough}`,
  ].join("\n");

  await app.updateModelContext({
    content: [{ type: "text", text: md }],
  });
  setBanner("success", `Attached Trial "${t.title}" to chat context.`);
}

async function saveRealmFromForm(): Promise<void> {
  if (!state.selectedRealm || !state.selectedEraId) return;
  const root = document.getElementById("realm-form");
  if (!root) return;

  const getVal = (name: string) =>
    (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)?.value ?? "";
  const getChecked = (name: string) =>
    Boolean((root.querySelector(`[name="${name}"]`) as HTMLInputElement)?.checked);

  const modeVal = getVal("realmDiffMode");
  const difficultyOverride: DifficultyOverride | null =
    modeVal === "inherit"
      ? null
      : {
          mode: modeVal as DifficultyMode,
          showRawTracebacks: getChecked("realmRawTracebacks"),
        };

  state.saving = true;
  render();
  try {
    const res = await app.callServerTool({
      name: "upsert_realm",
      arguments: {
        eraId: state.selectedEraId,
        realmId: state.selectedRealm.id,
        name: getVal("realmName").trim(),
        miniVisualUpgrade: getVal("miniVisualUpgrade").trim(),
        primaryConcepts: parseConcepts(getVal("primaryConcepts")),
        storyIntro: getVal("storyIntro"),
        storyOutro: getVal("storyOutro"),
        dragon: {
          name: getVal("dragonName").trim(),
          title: getVal("dragonTitle").trim(),
          element: getVal("dragonElement").trim(),
          rescueDialogue: getVal("dragonDialogue"),
        },
        difficultyOverride,
      },
    });
    const data = extractStructured<{ realm: Realm }>(res);
    if (data?.realm) {
      state.selectedRealm = data.realm;
    }
    await refreshOverview(true);
    setBanner("success", `Saved Realm ${state.selectedRealm?.number}: ${state.selectedRealm?.name}.`);
  } catch (err) {
    setBanner("danger", `Failed to save realm: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.saving = false;
    render();
  }
}

function readTrialFromForm(): Trial | null {
  const existing = getSelectedTrial();
  const root = document.getElementById("trial-form");
  if (!root || !existing) return null;

  const getVal = (name: string) =>
    (root.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)?.value ?? "";
  const getChecked = (name: string) =>
    Boolean((root.querySelector(`[name="${name}"]`) as HTMLInputElement)?.checked);

  const modeVal = getVal("trialDiffMode");
  const difficultyOverride: DifficultyOverride | null =
    modeVal === "inherit"
      ? null
      : {
          mode: modeVal as DifficultyMode,
          showRawTracebacks: getChecked("trialRawTracebacks"),
        };

  // Capture currently visible starter code textarea into existing.starterCode
  const currentStarter = getVal("starterCodeActive");
  const starterCode = {
    ...existing.starterCode,
    [state.starterTab]: currentStarter,
  };

  return {
    ...existing,
    id: getVal("trialId").trim() || existing.id,
    title: getVal("trialTitle").trim() || existing.title,
    storyPrompt: getVal("storyPrompt"),
    objective: getVal("objective"),
    concepts: parseConcepts(getVal("trialConcepts")),
    shardReward: Math.max(0, Number.parseInt(getVal("shardReward"), 10) || 0),
    unlockId: getVal("unlockId").trim() || null,
    starterCode,
    referenceSolution: getVal("referenceSolution"),
    testCode: getVal("testCode"),
    hints: {
      tier1_nudge: getVal("hint1"),
      tier2_pattern: getVal("hint2"),
      tier3_walkthrough: getVal("hint3"),
    },
    difficultyOverride,
  };
}

async function saveTrialFromForm(): Promise<void> {
  if (!state.selectedRealm || !state.selectedEraId) return;
  const trial = readTrialFromForm();
  if (!trial) return;

  state.saving = true;
  render();
  try {
    const res = await app.callServerTool({
      name: "upsert_trial",
      arguments: {
        eraId: state.selectedEraId,
        realmId: state.selectedRealm.id,
        trial,
      },
    });
    const data = extractStructured<{ realm: Realm; trial: Trial }>(res);
    if (data?.realm) {
      state.selectedRealm = data.realm;
      state.selectedTrialId = data.trial.id;
    }
    await refreshOverview(true);
    setBanner("success", `Saved Trial "${trial.title}".`);
  } catch (err) {
    setBanner("danger", `Failed to save trial: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.saving = false;
    render();
  }
}

async function createNewTrial(): Promise<void> {
  if (!state.selectedRealm || !state.selectedEraId) return;
  const nextNum = state.selectedRealm.trials.length + 1;
  const newId = `${state.selectedRealm.id}-trial-${String(nextNum).padStart(2, "0")}`;
  const newTrial: Trial = {
    id: newId,
    title: `Trial ${nextNum}: New Spell`,
    storyPrompt: "Pip points at a glowing rune pedestal waiting for your Python spell.",
    objective: "Print 'Hello, Pyria!' to awaken the rune.",
    concepts: state.selectedRealm.primaryConcepts.slice(0, 1),
    shardReward: 25,
    unlockId: null,
    starterCode: {
      explorer: '# Explorer mode: fill in the string!\nprint("___")\n',
      standard: '# Standard mode: write a print() call\n',
      challenge: "# Challenge mode: awaken the rune!\n",
    },
    referenceSolution: 'print("Hello, Pyria!")\n',
    testCode: 'assert "Hello, Pyria!" in OUTPUT, "Expected OUTPUT to contain Hello, Pyria!"\n',
    hints: {
      tier1_nudge: "Try using Python's print() function.",
      tier2_pattern: 'Pattern: print("your text here")',
      tier3_walkthrough: 'Type print("Hello, Pyria!") and run your spell.',
    },
    difficultyOverride: null,
  };

  state.saving = true;
  render();
  try {
    const res = await app.callServerTool({
      name: "upsert_trial",
      arguments: {
        eraId: state.selectedEraId,
        realmId: state.selectedRealm.id,
        trial: newTrial,
      },
    });
    const data = extractStructured<{ realm: Realm; trial: Trial }>(res);
    if (data?.realm) {
      state.selectedRealm = data.realm;
      state.selectedTrialId = data.trial.id;
      state.testResult = null;
    }
    await refreshOverview(true);
    setBanner("success", `Created Trial "${newTrial.title}".`);
  } catch (err) {
    setBanner("danger", `Failed to create trial: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.saving = false;
    render();
  }
}

async function deleteSelectedTrial(): Promise<void> {
  if (!state.selectedRealm || !state.selectedEraId || !state.selectedTrialId) return;
  const trial = getSelectedTrial();
  if (!trial) return;

  state.saving = true;
  render();
  try {
    const res = await app.callServerTool({
      name: "delete_trial",
      arguments: {
        eraId: state.selectedEraId,
        realmId: state.selectedRealm.id,
        trialId: trial.id,
      },
    });
    const data = extractStructured<{ realm: Realm }>(res);
    if (data?.realm) {
      state.selectedRealm = data.realm;
      state.selectedTrialId = data.realm.trials[0]?.id ?? null;
      state.testResult = null;
    }
    await refreshOverview(true);
    setBanner("info", `Deleted Trial "${trial.title}".`);
  } catch (err) {
    setBanner("danger", `Failed to delete trial: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.saving = false;
    render();
  }
}

async function runLiveTest(which: "reference" | "starter"): Promise<void> {
  const trial = readTrialFromForm() ?? getSelectedTrial();
  if (!trial) return;

  const code =
    which === "reference"
      ? trial.referenceSolution
      : trial.starterCode[state.starterTab];

  state.testing = true;
  state.testResult = null;
  render();
  try {
    const res = await app.callServerTool({
      name: "run_trial_test",
      arguments: {
        code,
        testCode: trial.testCode,
      },
    });
    const result = extractStructured<TrialTestResult>(res);
    state.testResult = result;
  } catch (err) {
    state.testResult = {
      passed: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      pipFriendlyHint: "Pip couldn't reach the test runner tool.",
    };
  } finally {
    state.testing = false;
    render();
  }
}

async function saveGlobalDifficulty(): Promise<void> {
  const root = document.getElementById("global-diff-form");
  if (!root) return;
  const mode = (root.querySelector('[name="globalMode"]') as HTMLSelectElement)
    .value as DifficultyMode;
  const showRawTracebacks = Boolean(
    (root.querySelector('[name="globalTracebacks"]') as HTMLInputElement).checked
  );
  const maxHintsAllowed = Math.max(
    0,
    Number.parseInt(
      (root.querySelector('[name="globalMaxHints"]') as HTMLInputElement).value,
      10
    ) || 3
  );

  state.saving = true;
  render();
  try {
    await app.callServerTool({
      name: "set_difficulty_override",
      arguments: {
        scope: "global",
        override: { mode, showRawTracebacks },
        maxHintsAllowed,
      },
    });
    await refreshOverview(true);
    setBanner(
      "success",
      `Global difficulty updated: ${mode} (tracebacks: ${showRawTracebacks ? "shown" : "hidden"}, max hints: ${maxHintsAllowed}).`
    );
  } catch (err) {
    setBanner("danger", `Failed to update global difficulty: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.saving = false;
    render();
  }
}

function renderRealmTab(): string {
  const overview = state.overview;
  if (!overview) {
    return `<div class="main-pane"><div class="card">Loading Pyria content...</div></div>`;
  }

  const currentEra =
    overview.eras.find((e) => e.id === state.selectedEraId) ?? overview.eras[0];
  const realm = state.selectedRealm;
  const trial = getSelectedTrial();

  const eraPills = overview.eras
    .map(
      (e) =>
        `<button class="era-pill ${e.id === currentEra?.id ? "active" : ""}" data-era="${esc(e.id)}">${esc(e.bitCount)}-Bit (${e.realms.length})</button>`
    )
    .join("");

  const realmItems = (currentEra?.realms ?? [])
    .map((r) => {
      const diffBadge = r.difficultyOverride
        ? `<span class="badge badge-info">${esc(r.difficultyOverride.mode)}</span>`
        : "";
      const warnBadge =
        r.warningCount > 0
          ? `<span class="badge badge-warn">${r.warningCount} warn</span>`
          : "";
      return `
        <button class="realm-item ${r.id === state.selectedRealmId ? "active" : ""}" data-realm="${esc(r.id)}" data-era="${esc(currentEra?.id)}">
          <div class="realm-item-top">
            <span>#${r.number} ${esc(r.name)}</span>
            <span class="badge">${r.trialCount}T</span>
          </div>
          <div class="realm-item-meta">
            <span>Dragon: ${esc(r.dragonName)}</span>
            ${diffBadge}
            ${warnBadge}
          </div>
        </button>`;
    })
    .join("");

  const realmEditor = realm
    ? `
    <section class="card" id="realm-form">
      <div class="card-header">
        <div>
          <h2 class="card-title">Realm ${realm.number}: ${esc(realm.name)}</h2>
          <div class="card-subtitle">${esc(realm.id)} · Dragon: ${esc(realm.dragon?.name)} (${esc(realm.dragon?.element)})</div>
        </div>
        <div class="actions-row">
          ${
            state.canUpdateContext
              ? `<button class="btn btn-sm" id="btn-attach-realm">Attach Realm to Chat</button>`
              : ""
          }
          <button class="btn btn-primary btn-sm" id="btn-save-realm" ${state.saving ? "disabled" : ""}>Save Realm</button>
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label>Realm Name</label>
          <input type="text" name="realmName" value="${esc(realm.name)}" />
        </div>
        <div class="field">
          <label>Mini Visual Upgrade</label>
          <input type="text" name="miniVisualUpgrade" value="${esc(realm.miniVisualUpgrade)}" />
        </div>
        <div class="field">
          <label>Dragon Name</label>
          <input type="text" name="dragonName" value="${esc(realm.dragon?.name)}" />
        </div>
        <div class="field">
          <label>Dragon Title</label>
          <input type="text" name="dragonTitle" value="${esc(realm.dragon?.title)}" />
        </div>
        <div class="field">
          <label>Dragon Element</label>
          <input type="text" name="dragonElement" value="${esc(realm.dragon?.element)}" />
        </div>
        <div class="field">
          <label>Primary Concepts (comma-separated)</label>
          <input type="text" name="primaryConcepts" value="${esc((realm.primaryConcepts || []).join(", "))}" />
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label>Realm Difficulty Override</label>
          <select name="realmDiffMode" id="realmDiffMode">
            <option value="inherit" ${!realm.difficultyOverride ? "selected" : ""}>Inherit Global (${esc(overview.globalDifficultyOverride.mode)})</option>
            <option value="explorer" ${realm.difficultyOverride?.mode === "explorer" ? "selected" : ""}>Explorer (scaffolding)</option>
            <option value="standard" ${realm.difficultyOverride?.mode === "standard" ? "selected" : ""}>Standard</option>
            <option value="challenge" ${realm.difficultyOverride?.mode === "challenge" ? "selected" : ""}>Challenge (minimal starter)</option>
          </select>
        </div>
        <div class="field">
          <label>Traceback Visibility</label>
          <label class="checkbox-row">
            <input type="checkbox" name="realmRawTracebacks" ${realm.difficultyOverride?.showRawTracebacks ? "checked" : ""} />
            Show raw Python tracebacks in this Realm
          </label>
        </div>
      </div>

      <div class="field">
        <label>Story Intro</label>
        <textarea name="storyIntro">${esc(realm.storyIntro)}</textarea>
      </div>
      <div class="field">
        <label>Dragon Rescue Dialogue</label>
        <textarea name="dragonDialogue">${esc(realm.dragon?.rescueDialogue)}</textarea>
      </div>
      <div class="field">
        <label>Story Outro</label>
        <textarea name="storyOutro">${esc(realm.storyOutro)}</textarea>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <div>
          <h3 class="card-title">Trials (${realm.trials.length})</h3>
          <div class="card-subtitle">Select a Trial to edit Python code, Pip hints, and run live tests</div>
        </div>
        <button class="btn btn-primary btn-sm" id="btn-new-trial" ${state.saving ? "disabled" : ""}>+ New Trial</button>
      </div>
      <div class="trial-strip">
        ${
          realm.trials.length > 0
            ? realm.trials
                .map(
                  (t, i) => `
                  <button class="trial-chip ${t.id === state.selectedTrialId ? "active" : ""}" data-trial="${esc(t.id)}">
                    <span>${i + 1}. ${esc(t.title)}</span>
                    <span class="badge">${t.shardReward}</span>
                  </button>`
                )
                .join("")
            : `<span class="muted">No trials in this Realm yet. Click "+ New Trial" to author one!</span>`
        }
      </div>
    </section>
    `
    : `<div class="card">Select a Realm to begin editing.</div>`;

  const trialEditor = trial
    ? `
    <section class="card" id="trial-form">
      <div class="card-header">
        <div>
          <h3 class="card-title">${esc(trial.title)}</h3>
          <div class="card-subtitle">${esc(trial.id)} · ${trial.shardReward} ${esc(overview.currencyName)}</div>
        </div>
        <div class="actions-row">
          ${
            state.canUpdateContext
              ? `<button class="btn btn-sm" id="btn-attach-trial">Attach Trial to Chat</button>`
              : ""
          }
          <button class="btn btn-success btn-sm" id="btn-test-solution" ${state.testing ? "disabled" : ""}>${state.testing ? "Running..." : "Test Solution"}</button>
          <button class="btn btn-primary btn-sm" id="btn-save-trial" ${state.saving ? "disabled" : ""}>Save Trial</button>
          <button class="btn btn-danger btn-sm" id="btn-delete-trial" ${state.saving ? "disabled" : ""}>Delete</button>
        </div>
      </div>

      ${
        state.testResult
          ? `
        <div class="test-result ${state.testResult.passed ? "pass" : "fail"}">
          <div class="card-header">
            <strong>${state.testResult.passed ? "PASS — All test runes succeeded!" : "FAIL — Trial test did not pass"}</strong>
            ${state.testResult.durationMs !== undefined ? `<span class="badge">${state.testResult.durationMs}ms</span>` : ""}
          </div>
          <div class="pip-box"><strong>Pip says:</strong> ${esc(state.testResult.pipFriendlyHint)}</div>
          ${state.testResult.stdout ? `<div><label class="muted">Captured OUTPUT:</label><pre class="output-pre">${esc(state.testResult.stdout)}</pre></div>` : ""}
          ${state.testResult.stderr ? `<div><label class="muted">Traceback / Stderr:</label><pre class="output-pre">${esc(state.testResult.stderr)}</pre></div>` : ""}
        </div>`
          : ""
      }

      <div class="grid-2">
        <div class="field">
          <label>Trial ID</label>
          <input type="text" name="trialId" value="${esc(trial.id)}" readonly />
        </div>
        <div class="field">
          <label>Trial Title</label>
          <input type="text" name="trialTitle" value="${esc(trial.title)}" />
        </div>
        <div class="field">
          <label>${esc(overview.currencyName)} Reward</label>
          <input type="number" name="shardReward" min="0" value="${esc(trial.shardReward)}" />
        </div>
        <div class="field">
          <label>Unlock ID (optional)</label>
          <input type="text" name="unlockId" value="${esc(trial.unlockId ?? "")}" placeholder="e.g. hat-explorer" />
        </div>
        <div class="field">
          <label>Concept Tags (comma-separated)</label>
          <input type="text" name="trialConcepts" value="${esc((trial.concepts || []).join(", "))}" />
        </div>
        <div class="field">
          <label>Trial Difficulty Override</label>
          <select name="trialDiffMode">
            <option value="inherit" ${!trial.difficultyOverride ? "selected" : ""}>Inherit Realm / Global</option>
            <option value="explorer" ${trial.difficultyOverride?.mode === "explorer" ? "selected" : ""}>Explorer</option>
            <option value="standard" ${trial.difficultyOverride?.mode === "standard" ? "selected" : ""}>Standard</option>
            <option value="challenge" ${trial.difficultyOverride?.mode === "challenge" ? "selected" : ""}>Challenge</option>
          </select>
          <label class="checkbox-row">
            <input type="checkbox" name="trialRawTracebacks" ${trial.difficultyOverride?.showRawTracebacks ? "checked" : ""} />
            Show raw tracebacks
          </label>
        </div>
      </div>

      <div class="field">
        <label>Story Prompt</label>
        <textarea name="storyPrompt">${esc(trial.storyPrompt)}</textarea>
      </div>
      <div class="field">
        <label>Objective</label>
        <textarea name="objective">${esc(trial.objective)}</textarea>
      </div>

      <div class="field">
        <div class="card-header">
          <label>Starter Code by Difficulty</label>
          <div class="subtabs">
            ${(["explorer", "standard", "challenge"] as StarterTab[])
              .map(
                (m) =>
                  `<button type="button" class="subtab ${state.starterTab === m ? "active" : ""}" data-starter-tab="${m}">${m}</button>`
              )
              .join("")}
          </div>
        </div>
        <textarea class="code" name="starterCodeActive">${esc(trial.starterCode?.[state.starterTab] ?? "")}</textarea>
      </div>

      <div class="field">
        <label>Reference Solution (Python)</label>
        <textarea class="code" name="referenceSolution">${esc(trial.referenceSolution)}</textarea>
      </div>

      <div class="field">
        <label>Test Code (Python — inspects variables & captured OUTPUT)</label>
        <textarea class="code" name="testCode">${esc(trial.testCode)}</textarea>
      </div>

      <div class="field">
        <label>Pip Hint — Tier 1 (Gentle Nudge)</label>
        <textarea name="hint1">${esc(trial.hints?.tier1_nudge ?? "")}</textarea>
      </div>
      <div class="field">
        <label>Pip Hint — Tier 2 (Code Pattern)</label>
        <textarea name="hint2">${esc(trial.hints?.tier2_pattern ?? "")}</textarea>
      </div>
      <div class="field">
        <label>Pip Hint — Tier 3 (Step-by-Step Walkthrough)</label>
        <textarea name="hint3">${esc(trial.hints?.tier3_walkthrough ?? "")}</textarea>
      </div>
    </section>
    `
    : "";

  return `
    <div class="workspace">
      <aside class="sidebar">
        <div class="era-bar">${eraPills || '<span class="muted">No eras</span>'}</div>
        <div class="realm-list">${realmItems || '<div class="muted" style="padding:8px">No realms yet</div>'}</div>
      </aside>
      <main class="main-pane">
        ${realmEditor}
        ${trialEditor}
      </main>
    </div>
  `;
}

function renderHealthTab(): string {
  const overview = state.overview;
  if (!overview) {
    return `<div class="main-pane"><div class="card">Loading...</div></div>`;
  }
  const g = overview.globalDifficultyOverride;
  const warnings = state.healthWarnings;

  return `
    <main class="main-pane">
      <section class="card" id="global-diff-form">
        <div class="card-header">
          <div>
            <h2 class="card-title">Global Difficulty & Parent Controls</h2>
            <div class="card-subtitle">Default difficulty across all Realms unless overridden</div>
          </div>
          <button class="btn btn-primary btn-sm" id="btn-save-global" ${state.saving ? "disabled" : ""}>Save Global Settings</button>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>Global Difficulty Mode</label>
            <select name="globalMode">
              <option value="explorer" ${g.mode === "explorer" ? "selected" : ""}>Explorer (extra starter hints)</option>
              <option value="standard" ${g.mode === "standard" ? "selected" : ""}>Standard</option>
              <option value="challenge" ${g.mode === "challenge" ? "selected" : ""}>Challenge (minimal scaffolding)</option>
            </select>
          </div>
          <div class="field">
            <label>Max Pip Hints Allowed</label>
            <input type="number" name="globalMaxHints" min="0" max="10" value="${esc(g.maxHintsAllowed)}" />
          </div>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" name="globalTracebacks" ${g.showRawTracebacks ? "checked" : ""} />
          Show raw Python tracebacks globally (otherwise Pip translates errors in early Realms)
        </label>
      </section>

      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Concept Anti-Repetition Health</h2>
            <div class="card-subtitle">Flags higher Realms repeating basic Python concepts past maxBasicRealm</div>
          </div>
          <button class="btn btn-sm" id="btn-run-concept-check">Re-scan Realms</button>
        </div>
        ${
          warnings.length === 0
            ? `<div class="badge badge-success">All clear — no concept repetition warnings!</div>`
            : warnings
                .map(
                  (w) => `
                  <div class="warning-item">
                    <div>
                      <strong>${esc(w.conceptId)}</strong> in Realm ${w.realmNumber} (${esc(w.realmName)})
                      <div class="card-subtitle">${esc(w.message)}</div>
                    </div>
                    <button class="btn btn-sm" data-jump-realm="${esc(w.realmId)}" data-jump-era="${esc(w.eraId)}">Open Realm</button>
                  </div>`
                )
                .join("")
        }
      </section>

      <section class="card">
        <div class="card-header">
          <h3 class="card-title">Concept Progression Rules (${overview.conceptProgression.length})</h3>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Concept ID</th>
              <th>Min Era</th>
              <th>Max Basic Realm</th>
            </tr>
          </thead>
          <tbody>
            ${
              overview.conceptProgression.length > 0
                ? overview.conceptProgression
                    .map(
                      (c) => `
                      <tr>
                        <td><code>${esc(c.id)}</code></td>
                        <td>${esc(c.minEra)}</td>
                        <td>Realm ${esc(c.maxBasicRealm)}</td>
                      </tr>`
                    )
                    .join("")
                : `<tr><td colspan="3" class="muted">No conceptProgression entries in game.json yet.</td></tr>`
            }
          </tbody>
        </table>
      </section>
    </main>
  `;
}

function renderCatalogTab(): string {
  const npcs = state.catalogNpcs.length
    ? state.catalogNpcs
    : (state.overview?.npcs ?? []);
  const unlockables = state.catalog?.unlockables ?? [];

  return `
    <main class="main-pane">
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">NPC Cast (${npcs.length})</h2>
        </div>
        <table class="data-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Catchphrase</th></tr>
          </thead>
          <tbody>
            ${
              npcs.length > 0
                ? npcs
                    .map(
                      (n) => `
                      <tr>
                        <td><strong>${esc(n.name)}</strong></td>
                        <td>${esc(n.role)}</td>
                        <td class="muted">"${esc(n.catchphrase)}"</td>
                      </tr>`
                    )
                    .join("")
                : `<tr><td colspan="3" class="muted">No NPCs loaded yet.</td></tr>`
            }
          </tbody>
        </table>
      </section>

      <section class="card">
        <div class="card-header">
          <h2 class="card-title">Bram's Workshop Unlockables (${unlockables.length})</h2>
        </div>
        <table class="data-table">
          <thead>
            <tr><th>Item</th><th>Python Call</th><th>Category</th><th>Cost</th></tr>
          </thead>
          <tbody>
            ${
              unlockables.length > 0
                ? unlockables
                    .map(
                      (u) => `
                      <tr>
                        <td><strong>${esc(u.name)}</strong><div class="card-subtitle">${esc(u.description)}</div></td>
                        <td><code>${esc(u.functionCall)}</code></td>
                        <td><span class="badge">${esc(u.category)}</span></td>
                        <td>${esc(u.shardCost)}</td>
                      </tr>`
                    )
                    .join("")
                : `<tr><td colspan="4" class="muted">No catalog unlockables loaded yet.</td></tr>`
            }
          </tbody>
        </table>
      </section>
    </main>
  `;
}

function render(): void {
  const root = document.getElementById("app");
  if (!root) return;

  const warningCount = state.healthWarnings.length;
  const missingBanner =
    state.overview && state.overview.missingFiles.length > 0
      ? `<div class="banner banner-warn">
           <span>Waiting for content files: ${esc(state.overview.missingFiles.join(", "))}</span>
           <button class="btn btn-sm" id="btn-refresh-missing">Reload</button>
         </div>`
      : "";

  const statusBanner = state.statusBanner
    ? `<div class="banner banner-${state.statusBanner.kind}">
         <span>${esc(state.statusBanner.text)}</span>
         <button class="btn btn-sm" id="btn-dismiss-banner">Dismiss</button>
       </div>`
    : "";

  const bodyHtml =
    state.mainTab === "realms"
      ? renderRealmTab()
      : state.mainTab === "health"
        ? renderHealthTab()
        : renderCatalogTab();

  root.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>${esc(state.overview?.title || "Pyria")} Builder</span>
      </div>
      <div class="tabs">
        <button class="tab-btn ${state.mainTab === "realms" ? "active" : ""}" data-main-tab="realms">Realms & Trials</button>
        <button class="tab-btn ${state.mainTab === "health" ? "active" : ""}" data-main-tab="health">
          Global & Health ${warningCount > 0 ? `<span class="badge badge-warn">${warningCount}</span>` : ""}
        </button>
        <button class="tab-btn ${state.mainTab === "catalog" ? "active" : ""}" data-main-tab="catalog">Catalog & NPCs</button>
        <button class="btn btn-sm" id="btn-reload-all">Refresh</button>
      </div>
    </header>
    ${missingBanner}
    ${statusBanner}
    ${bodyHtml}
  `;

  bindEvents();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLElement>("[data-main-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      const next = el.dataset.mainTab as MainTab;
      state.mainTab = next;
      if (next === "catalog" && !state.catalog) {
        void loadCatalog();
      }
      render();
    });
  });

  document.getElementById("btn-reload-all")?.addEventListener("click", () => {
    void refreshOverview(true);
  });
  document.getElementById("btn-refresh-missing")?.addEventListener("click", () => {
    void refreshOverview(false);
  });
  document.getElementById("btn-dismiss-banner")?.addEventListener("click", () => {
    state.statusBanner = null;
    render();
  });

  document.querySelectorAll<HTMLElement>("[data-era]").forEach((el) => {
    if (el.hasAttribute("data-realm")) return;
    el.addEventListener("click", () => {
      const eraId = el.dataset.era!;
      state.selectedEraId = eraId;
      const era = state.overview?.eras.find((e) => e.id === eraId);
      if (era?.realms[0]) {
        void loadRealm(era.realms[0].id, eraId);
      } else {
        state.selectedRealmId = null;
        state.selectedRealm = null;
        state.selectedTrialId = null;
        render();
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-realm]").forEach((el) => {
    el.addEventListener("click", () => {
      void loadRealm(el.dataset.realm!, el.dataset.era);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-trial]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedTrialId = el.dataset.trial!;
      state.testResult = null;
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-starter-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      // Persist any unsaved edit in current starter tab before switching
      const trial = getSelectedTrial();
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '#trial-form textarea[name="starterCodeActive"]'
      );
      if (trial && textarea) {
        trial.starterCode[state.starterTab] = textarea.value;
      }
      state.starterTab = el.dataset.starterTab as StarterTab;
      render();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-jump-realm]").forEach((el) => {
    el.addEventListener("click", () => {
      state.mainTab = "realms";
      void loadRealm(el.dataset.jumpRealm!, el.dataset.jumpEra);
    });
  });

  document.getElementById("btn-attach-realm")?.addEventListener("click", () => {
    void attachRealmToChat();
  });
  document.getElementById("btn-attach-trial")?.addEventListener("click", () => {
    void attachTrialToChat();
  });
  document.getElementById("btn-save-realm")?.addEventListener("click", () => {
    void saveRealmFromForm();
  });
  document.getElementById("btn-new-trial")?.addEventListener("click", () => {
    void createNewTrial();
  });
  document.getElementById("btn-save-trial")?.addEventListener("click", () => {
    void saveTrialFromForm();
  });
  document.getElementById("btn-delete-trial")?.addEventListener("click", () => {
    void deleteSelectedTrial();
  });
  document.getElementById("btn-test-solution")?.addEventListener("click", () => {
    void runLiveTest("reference");
  });
  document.getElementById("btn-save-global")?.addEventListener("click", () => {
    void saveGlobalDifficulty();
  });
  document.getElementById("btn-run-concept-check")?.addEventListener("click", () => {
    void runConceptCheck();
  });
}

// Register MCP App handlers BEFORE connect()
app.ontoolinput = () => {
  // Show subtle loading state if no data yet
  if (!state.overview) {
    render();
  }
};

app.ontoolresult = (result) => {
  const payload = extractStructured<{
    overview?: GameOverview;
    selection?: { eraId: string | null; realmId: string | null; trialId: string | null };
    selectedRealm?: Realm | null;
  }>(result);

  if (payload?.overview) {
    state.overview = payload.overview;
    state.healthWarnings = payload.overview.warnings || [];
  }
  if (payload?.selection) {
    state.selectedEraId = payload.selection.eraId;
    state.selectedRealmId = payload.selection.realmId;
    state.selectedTrialId = payload.selection.trialId;
  }
  if (payload?.selectedRealm) {
    state.selectedRealm = payload.selectedRealm;
    if (!state.selectedTrialId && payload.selectedRealm.trials[0]) {
      state.selectedTrialId = payload.selectedRealm.trials[0].id;
    }
  }
  render();
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function boot(): Promise<void> {
  try {
    await app.connect();
    state.connected = true;
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

    const caps = app.getHostCapabilities();
    state.canUpdateContext = Boolean(caps?.updateModelContext);

    if (!state.overview) {
      await refreshOverview(false);
    } else {
      render();
    }
  } catch (err) {
    const root = document.getElementById("app");
    if (root) {
      root.innerHTML = `<div class="boot-screen">
        <div class="boot-title">Pyria Builder</div>
        <div class="boot-sub">Host connection error: ${esc(err instanceof Error ? err.message : String(err))}</div>
      </div>`;
    }
  }
}

void boot();
