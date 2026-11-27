import type {
  ActivityEventRecord,
  AttemptRecord,
  DifficultyMode,
  EnrichedSaveRecord,
  Env,
  SaveDbRow,
  SavePreferences,
  SaveRecord,
} from './types';
import {
  MAX_DIFF_EVENTS_PER_UPDATE,
  MAX_SAVE_STATE_BYTES,
  QuotaError,
  ValidationError,
  coerceByteShards,
  normalizeEmail,
  utf8ByteLength,
  validateSavePayload,
} from './validation';

const DEFAULT_MAX_SAVES_PER_ACCOUNT = 10;
const DEFAULT_MAX_UNOWNED_SAVES = 2000;
const DEFAULT_UNOWNED_IDLE_DAYS = 90;
const DEFAULT_MAX_ATTEMPT_CODE_ROWS = 500;
const DEFAULT_MAX_ATTEMPTS_PER_SAVE = 5000;
const DEFAULT_MAX_EVENTS_PER_SAVE = 500;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function safeParseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parsePreferencesJson(raw: string | null | undefined): SavePreferences {
  const obj = safeParseObject(raw);
  const prefs: SavePreferences = {};
  if (
    obj.difficulty === 'explorer' ||
    obj.difficulty === 'standard' ||
    obj.difficulty === 'challenge'
  ) {
    prefs.difficulty = obj.difficulty;
  }
  if (typeof obj.showRawTracebacks === 'boolean') {
    prefs.showRawTracebacks = obj.showRawTracebacks;
  }
  if (typeof obj.maxPipHints === 'number' && Number.isInteger(obj.maxPipHints)) {
    prefs.maxPipHints = obj.maxPipHints;
  }
  return prefs;
}

function extractStringSet(state: Record<string, unknown>, ...keys: string[]): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    const val = state[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item !== null && item !== undefined) {
          out.add(String(item));
        }
      }
    }
  }
  return out;
}

interface EventDbRow {
  id: number;
  save_id: string;
  hero_name: string;
  owner_email: string | null;
  event_type: string;
  realm_id: string | null;
  trial_id: string | null;
  summary: string;
  details_json: string;
  created_at: string;
}

interface AttemptAggRow {
  save_id: string;
  attempt_count: number;
  pass_count: number | null;
  total_hints: number | null;
  last_attempt_at: string | null;
}

export class PyriaD1 {
  readonly db: D1Database;
  readonly maxSavesPerAccount: number;
  readonly maxUnownedSaves: number;
  readonly unownedIdleDays: number;
  readonly maxAttemptCodeRows: number;
  readonly maxAttemptsPerSave: number;
  readonly maxEventsPerSave: number;

  constructor(env: Env) {
    this.db = env.DB;
    this.maxSavesPerAccount = parsePositiveInt(
      env.PYRIA_MAX_SAVES_PER_ACCOUNT,
      DEFAULT_MAX_SAVES_PER_ACCOUNT
    );
    this.maxUnownedSaves = parsePositiveInt(
      env.PYRIA_MAX_UNOWNED_SAVES,
      DEFAULT_MAX_UNOWNED_SAVES
    );
    this.unownedIdleDays = parsePositiveInt(
      env.PYRIA_UNOWNED_IDLE_DAYS,
      DEFAULT_UNOWNED_IDLE_DAYS
    );
    this.maxAttemptCodeRows = parsePositiveInt(
      env.PYRIA_MAX_ATTEMPT_CODE_ROWS,
      DEFAULT_MAX_ATTEMPT_CODE_ROWS
    );
    this.maxAttemptsPerSave = parsePositiveInt(
      env.PYRIA_MAX_ATTEMPTS_PER_SAVE,
      DEFAULT_MAX_ATTEMPTS_PER_SAVE
    );
    this.maxEventsPerSave = parsePositiveInt(
      env.PYRIA_MAX_EVENTS_PER_SAVE,
      DEFAULT_MAX_EVENTS_PER_SAVE
    );
  }

  static rowToSave(row: SaveDbRow): SaveRecord {
    const state = safeParseObject(row.state_json);
    const prefs = parsePreferencesJson(row.preferences_json);
    const ownerEmail = row.owner_email ?? null;
    return {
      ...state,
      id: row.id,
      heroName: row.hero_name,
      ownerEmail,
      linkedToParent: Boolean(ownerEmail && ownerEmail.trim()),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      preferences: prefs,
    };
  }

  static rowToEvent(row: EventDbRow): ActivityEventRecord {
    return {
      id: Number(row.id),
      saveId: row.save_id,
      heroName: row.hero_name,
      ownerEmail: row.owner_email ?? null,
      eventType: row.event_type,
      realmId: row.realm_id ?? null,
      trialId: row.trial_id ?? null,
      summary: row.summary,
      details: safeParseObject(row.details_json),
      createdAt: row.created_at,
    };
  }

  private async pruneEvents(saveId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM activity_events
         WHERE save_id = ? AND id NOT IN (
           SELECT id FROM activity_events WHERE save_id = ? ORDER BY id DESC LIMIT ?
         )`
      )
      .bind(saveId, saveId, this.maxEventsPerSave)
      .run();
  }

  private async insertEvent(params: {
    saveId: string;
    heroName: string;
    eventType: string;
    summary: string;
    details: Record<string, unknown>;
    realmId?: string | null;
    trialId?: string | null;
    createdAt?: string;
    prune?: boolean;
  }): Promise<void> {
    const ts = params.createdAt ?? utcNowIso();
    await this.db
      .prepare(
        `INSERT INTO activity_events
         (save_id, hero_name, event_type, realm_id, trial_id, summary, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.saveId,
        params.heroName,
        params.eventType,
        params.realmId ?? null,
        params.trialId ?? null,
        params.summary,
        JSON.stringify(params.details),
        ts
      )
      .run();

    if (params.prune !== false) {
      await this.pruneEvents(params.saveId);
    }
  }

  async countSaves(): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS cnt FROM saves')
      .first<{ cnt: number }>();
    return Number(row?.cnt ?? 0);
  }

  async countAccountSaves(ownerEmail: string): Promise<number> {
    const norm = normalizeEmail(ownerEmail);
    if (!norm) return 0;
    const row = await this.db
      .prepare("SELECT COUNT(*) AS cnt FROM saves WHERE LOWER(COALESCE(owner_email, '')) = ?")
      .bind(norm)
      .first<{ cnt: number }>();
    return Number(row?.cnt ?? 0);
  }

  async listAccounts(extraEmail?: string | null): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        "SELECT DISTINCT LOWER(TRIM(owner_email)) AS email FROM saves WHERE owner_email IS NOT NULL AND TRIM(owner_email) != ''"
      )
      .all<{ email: string }>();
    const accounts = new Set<string>();
    for (const r of results) {
      if (r.email) accounts.add(r.email);
    }
    const normExtra = normalizeEmail(extraEmail);
    if (normExtra) accounts.add(normExtra);
    return [...accounts].sort();
  }

  async getSaveRow(saveId: string): Promise<SaveDbRow | null> {
    return this.db
      .prepare(
        `SELECT id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at
         FROM saves WHERE id = ?`
      )
      .bind(saveId)
      .first<SaveDbRow>();
  }

  async getSaveByRecoveryHash(hash: string): Promise<SaveDbRow | null> {
    return this.db
      .prepare(
        `SELECT id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at
         FROM saves WHERE recovery_code_hash = ?`
      )
      .bind(hash)
      .first<SaveDbRow>();
  }

  async getSave(saveId: string): Promise<SaveRecord | null> {
    const row = await this.getSaveRow(saveId);
    return row ? PyriaD1.rowToSave(row) : null;
  }

  async listSaves(ownerFilter?: string | null): Promise<SaveRecord[]> {
    const norm = ownerFilter ? normalizeEmail(ownerFilter) : null;
    const query = norm
      ? this.db
          .prepare(
            `SELECT id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at
             FROM saves WHERE LOWER(COALESCE(owner_email, '')) = ?
             ORDER BY updated_at DESC, created_at DESC`
          )
          .bind(norm)
      : this.db.prepare(
          `SELECT id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at
           FROM saves ORDER BY updated_at DESC, created_at DESC`
        );
    const { results } = await query.all<SaveDbRow>();
    return results.map((r) => PyriaD1.rowToSave(r));
  }

  async createSave(
    payload: Record<string, unknown>,
    options?: {
      ownerEmail?: string | null;
      recoveryCodeHash?: string | null;
      preferences?: SavePreferences;
    }
  ): Promise<SaveRecord> {
    const { sanitized, heroName } = validateSavePayload(payload, { requireHeroName: true });
    if (!heroName) {
      throw new ValidationError('heroName is required');
    }

    const normOwner = normalizeEmail(options?.ownerEmail ?? null);
    const saveId = crypto.randomUUID();
    const now = utcNowIso();
    const prefs: SavePreferences = options?.preferences ?? {};
    const state: Record<string, unknown> = {
      ...sanitized,
      id: saveId,
      heroName,
      ownerEmail: normOwner,
      createdAt: now,
      updatedAt: now,
    };
    if ('byteShards' in state) {
      state.byteShards = coerceByteShards(state.byteShards, 0);
    }

    const stateJson = JSON.stringify(state);
    if (utf8ByteLength(stateJson) > MAX_SAVE_STATE_BYTES) {
      throw new ValidationError(
        `Save state exceeds maximum size (${MAX_SAVE_STATE_BYTES} bytes)`,
        413
      );
    }

    const prefsJson = JSON.stringify(prefs);

    if (normOwner !== null) {
      // Atomic conditional INSERT enforcing per-parent account cap without TOCTOU race
      const res = await this.db
        .prepare(
          `INSERT INTO saves
           (id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at)
           SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM saves WHERE LOWER(COALESCE(owner_email, '')) = ?) < ?`
        )
        .bind(
          saveId,
          heroName,
          normOwner,
          options?.recoveryCodeHash ?? null,
          prefsJson,
          stateJson,
          now,
          now,
          normOwner,
          this.maxSavesPerAccount
        )
        .run();

      if (Number(res.meta.changes ?? 0) === 0) {
        throw new QuotaError(
          `Save limit reached (${this.maxSavesPerAccount} heroes per parent account)`
        );
      }
    } else {
      // Opportunistically prune idle unowned saves older than unownedIdleDays
      const cutoffIso = new Date(
        Date.now() - this.unownedIdleDays * 86400 * 1000
      )
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      await this.db.batch([
        this.db
          .prepare(
            `DELETE FROM trial_attempts WHERE save_id IN (
               SELECT id FROM saves WHERE (owner_email IS NULL OR TRIM(owner_email) = '') AND updated_at < ?
             )`
          )
          .bind(cutoffIso),
        this.db
          .prepare(
            `DELETE FROM activity_events WHERE save_id IN (
               SELECT id FROM saves WHERE (owner_email IS NULL OR TRIM(owner_email) = '') AND updated_at < ?
             )`
          )
          .bind(cutoffIso),
        this.db
          .prepare(
            `DELETE FROM saves WHERE (owner_email IS NULL OR TRIM(owner_email) = '') AND updated_at < ?`
          )
          .bind(cutoffIso),
      ]);

      // Atomic conditional INSERT enforcing global unowned save cap
      const res = await this.db
        .prepare(
          `INSERT INTO saves
           (id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at)
           SELECT ?, ?, NULL, ?, 1, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM saves WHERE owner_email IS NULL OR TRIM(owner_email) = '') < ?`
        )
        .bind(
          saveId,
          heroName,
          options?.recoveryCodeHash ?? null,
          prefsJson,
          stateJson,
          now,
          now,
          this.maxUnownedSaves
        )
        .run();

      if (Number(res.meta.changes ?? 0) === 0) {
        throw new QuotaError(
          'Anonymous hero storage limit reached. Please sign in to the Parent Console to create a hero.'
        );
      }
    }

    const realmId =
      typeof state.realmId === 'string' && state.realmId ? state.realmId : 'realm-01-meadow';
    await this.insertEvent({
      saveId,
      heroName,
      eventType: 'hero_created',
      realmId,
      summary: `Forged new hero ${heroName}`,
      details: { heroName, appearance: state.appearance ?? null },
      createdAt: now,
    });

    return {
      ...state,
      id: saveId,
      heroName,
      ownerEmail: normOwner,
      linkedToParent: Boolean(normOwner),
      createdAt: now,
      updatedAt: now,
      preferences: prefs,
    };
  }

  async updateSave(
    saveId: string,
    payload: Record<string, unknown>
  ): Promise<SaveRecord | null> {
    const existing = await this.getSaveRow(saveId);
    if (!existing) return null;

    const { sanitized, heroName: validatedName } = validateSavePayload(payload, {
      requireHeroName: false,
      allowedLegacyHeroName: existing.hero_name,
      sanitizeDrafts: true,
    });

    const prevState = safeParseObject(existing.state_json);
    const heroName = validatedName ?? existing.hero_name;
    const now = utcNowIso();

    const state: Record<string, unknown> = {
      ...sanitized,
      id: saveId,
      heroName,
      ownerEmail: existing.owner_email ?? null,
      createdAt: existing.created_at,
      updatedAt: now,
    };
    if ('byteShards' in state) {
      const prevShards = coerceByteShards(prevState.byteShards, 0);
      state.byteShards = coerceByteShards(state.byteShards, prevShards);
    }

    const stateJson = JSON.stringify(state);
    if (utf8ByteLength(stateJson) > MAX_SAVE_STATE_BYTES) {
      throw new ValidationError(
        `Save state exceeds maximum size (${MAX_SAVE_STATE_BYTES} bytes)`,
        413
      );
    }

    await this.db
      .prepare('UPDATE saves SET hero_name = ?, state_json = ?, updated_at = ? WHERE id = ?')
      .bind(heroName, stateJson, now, saveId)
      .run();

    // Diff previous vs new state for live activity events (bounded & pruned once)
    const curRealm =
      (typeof state.realmId === 'string' && state.realmId) ||
      (typeof prevState.realmId === 'string' && prevState.realmId) ||
      null;
    const prevRealm = typeof prevState.realmId === 'string' && prevState.realmId ? prevState.realmId : null;
    const maxDiffEvents = Math.min(MAX_DIFF_EVENTS_PER_UPDATE, this.maxEventsPerSave);
    const eventsToInsert: Array<{
      eventType: string;
      summary: string;
      details: Record<string, unknown>;
    }> = [];

    const pushDiff = (eventType: string, summary: string, details: Record<string, unknown>) => {
      if (eventsToInsert.length < maxDiffEvents) {
        eventsToInsert.push({ eventType, summary, details });
      }
    };

    const prevChests = extractStringSet(prevState, 'openedChests');
    const newChests = extractStringSet(state, 'openedChests');
    for (const chestId of [...newChests].filter((c) => !prevChests.has(c)).sort()) {
      pushDiff('chest_opened', `Opened treasure chest ${chestId}`, {
        chestId,
        byteShards: state.byteShards ?? 0,
      });
    }

    const prevUnlocks = extractStringSet(prevState, 'ownedUnlockIds', 'unlockedItems', 'unlockedIds');
    const newUnlocks = extractStringSet(state, 'ownedUnlockIds', 'unlockedItems', 'unlockedIds');
    for (const unlockId of [...newUnlocks].filter((u) => !prevUnlocks.has(u)).sort()) {
      pushDiff('workshop_purchase', `Unlocked ${unlockId} in Bram's Workshop`, {
        unlockId,
        byteShards: state.byteShards ?? 0,
      });
    }

    const prevDragons = extractStringSet(prevState, 'rescuedDragons');
    const newDragons = extractStringSet(state, 'rescuedDragons');
    for (const dragonId of [...newDragons].filter((d) => !prevDragons.has(d)).sort()) {
      pushDiff('dragon_rescued', `Rescued dragon ${dragonId}!`, { dragonId });
    }

    const prevEggs = extractStringSet(prevState, 'foundEasterEggs');
    const newEggs = extractStringSet(state, 'foundEasterEggs');
    for (const eggId of [...newEggs].filter((e) => !prevEggs.has(e)).sort()) {
      pushDiff('easter_egg_found', `Found hidden Easter Egg: ${eggId}`, {
        eggId,
        byteShards: state.byteShards ?? 0,
      });
    }

    if (prevRealm && curRealm && prevRealm !== curRealm) {
      pushDiff('realm_entered', `Entered ${curRealm}`, {
        fromRealmId: prevRealm,
        toRealmId: curRealm,
      });
    }

    if (eventsToInsert.length > 0) {
      const stmts = eventsToInsert.map((ev) =>
        this.db
          .prepare(
            `INSERT INTO activity_events
             (save_id, hero_name, event_type, realm_id, trial_id, summary, details_json, created_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
          )
          .bind(
            saveId,
            heroName,
            ev.eventType,
            curRealm,
            ev.summary,
            JSON.stringify(ev.details),
            now
          )
      );
      await this.db.batch(stmts);
      await this.pruneEvents(saveId);
    }

    return {
      ...state,
      id: saveId,
      heroName,
      ownerEmail: existing.owner_email ?? null,
      linkedToParent: Boolean(existing.owner_email && existing.owner_email.trim()),
      createdAt: existing.created_at,
      updatedAt: now,
      preferences: parsePreferencesJson(existing.preferences_json),
    };
  }

  async deleteSave(saveId: string): Promise<boolean> {
    const existing = await this.db
      .prepare('SELECT id FROM saves WHERE id = ?')
      .bind(saveId)
      .first<{ id: string }>();
    if (!existing) return false;

    await this.db.batch([
      this.db.prepare('DELETE FROM trial_attempts WHERE save_id = ?').bind(saveId),
      this.db.prepare('DELETE FROM activity_events WHERE save_id = ?').bind(saveId),
      this.db.prepare('DELETE FROM saves WHERE id = ?').bind(saveId),
    ]);
    return true;
  }

  async logAttempt(params: {
    saveId: string;
    trialId: string;
    passed: boolean;
    hintsUsed: number;
    code: string;
    difficultyMode?: DifficultyMode;
    isPractice?: boolean;
    errorType?: string | null;
    durationMs?: number | null;
  }): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT hero_name, state_json FROM saves WHERE id = ?')
      .bind(params.saveId)
      .first<{ hero_name: string; state_json: string }>();
    if (!row) return null;

    const now = utcNowIso();
    const day = now.slice(0, 10);
    const st = safeParseObject(row.state_json);
    const realmId = typeof st.realmId === 'string' && st.realmId ? st.realmId : null;
    const difficultyMode: DifficultyMode = params.difficultyMode ?? 'standard';
    const isPractice = Boolean(params.isPractice);
    const errorType = params.passed ? null : (params.errorType ?? null);
    const durationMs = params.durationMs ?? null;

    let firstTryInc = 0;
    let uniqueAttempterInc = 0;
    let uniqueSolverInc = 0;
    if (!isPractice) {
      const solvedInState = extractStringSet(st, 'solvedTrials', 'completedTrials');
      const alreadySolvedInState = solvedInState.has(params.trialId);
      const prior = await this.db
        .prepare(
          `SELECT COUNT(*) AS prior_attempts,
                  SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS prior_passes
           FROM trial_attempts
           WHERE save_id = ? AND trial_id = ? AND COALESCE(is_practice, 0) = 0`
        )
        .bind(params.saveId, params.trialId)
        .first<{ prior_attempts: number; prior_passes: number | null }>();
      const priorAttempts = Number(prior?.prior_attempts ?? 0);
      const priorPasses = Number(prior?.prior_passes ?? 0);
      if (!alreadySolvedInState) {
        if (priorAttempts === 0) uniqueAttempterInc = 1;
        if (params.passed && priorAttempts === 0) firstTryInc = 1;
        if (params.passed && priorPasses === 0) uniqueSolverInc = 1;
      }
    }

    const insertRes = await this.db
      .prepare(
        `INSERT INTO trial_attempts
         (save_id, trial_id, passed, hints_used, code, difficulty_mode, is_practice, error_type, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.saveId,
        params.trialId,
        params.passed ? 1 : 0,
        params.hintsUsed,
        params.code,
        difficultyMode,
        isPractice ? 1 : 0,
        errorType,
        durationMs,
        now
      )
      .run();

    const attemptId = Number(insertRes.meta.last_row_id ?? 0);

    // Durable daily rollup for non-practice attempts (survives trial_attempts pruning)
    const batchStmts: D1PreparedStatement[] = [];
    if (!isPractice) {
      batchStmts.push(
        this.db
          .prepare(
            `INSERT INTO trial_stats_daily
             (day, trial_id, difficulty_mode, attempts, passes, first_try_passes, unique_attempters, unique_solvers, hinted_attempts, total_hints, tier3_hints, parent_overrides)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0)
             ON CONFLICT(day, trial_id, difficulty_mode) DO UPDATE SET
               attempts = attempts + excluded.attempts,
               passes = passes + excluded.passes,
               first_try_passes = first_try_passes + excluded.first_try_passes,
               unique_attempters = unique_attempters + excluded.unique_attempters,
               unique_solvers = unique_solvers + excluded.unique_solvers,
               hinted_attempts = hinted_attempts + excluded.hinted_attempts,
               total_hints = total_hints + excluded.total_hints,
               tier3_hints = tier3_hints + excluded.tier3_hints`
          )
          .bind(
            day,
            params.trialId,
            difficultyMode,
            params.passed ? 1 : 0,
            firstTryInc,
            uniqueAttempterInc,
            uniqueSolverInc,
            params.hintsUsed > 0 ? 1 : 0,
            params.hintsUsed,
            params.hintsUsed >= 3 ? 1 : 0
          )
      );
    }

    // Blank code blobs past maxAttemptCodeRows while preserving aggregate stats,
    // and enforce hard row cap maxAttemptsPerSave.
    batchStmts.push(
      this.db
        .prepare(
          `UPDATE trial_attempts SET code = ''
           WHERE save_id = ? AND code != '' AND id NOT IN (
             SELECT id FROM trial_attempts WHERE save_id = ? ORDER BY id DESC LIMIT ?
           )`
        )
        .bind(params.saveId, params.saveId, this.maxAttemptCodeRows),
      this.db
        .prepare(
          `DELETE FROM trial_attempts
           WHERE save_id = ? AND id NOT IN (
             SELECT id FROM trial_attempts WHERE save_id = ? ORDER BY id DESC LIMIT ?
           )`
        )
        .bind(params.saveId, params.saveId, this.maxAttemptsPerSave)
    );

    await this.db.batch(batchStmts);

    await this.insertEvent({
      saveId: params.saveId,
      heroName: row.hero_name,
      eventType: params.passed ? 'trial_passed' : 'trial_failed',
      realmId,
      trialId: params.trialId,
      summary: params.passed
        ? `Passed Trial ${params.trialId}`
        : `Attempted Trial ${params.trialId}`,
      details: {
        trialId: params.trialId,
        passed: params.passed,
        hintsUsed: params.hintsUsed,
        code: params.code,
        difficultyMode,
        isPractice,
        errorType,
        durationMs,
        attemptId,
      },
      createdAt: now,
    });

    return attemptId;
  }

  async listAttempts(saveId: string): Promise<AttemptRecord[] | null> {
    const exists = await this.db
      .prepare('SELECT 1 AS ok FROM saves WHERE id = ?')
      .bind(saveId)
      .first<{ ok: number }>();
    if (!exists) return null;

    const { results } = await this.db
      .prepare(
        `SELECT id, save_id, trial_id, passed, hints_used, code,
                COALESCE(difficulty_mode, 'standard') AS difficulty_mode,
                COALESCE(is_practice, 0) AS is_practice,
                error_type, duration_ms, created_at
         FROM trial_attempts WHERE save_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .bind(saveId)
      .all<{
        id: number;
        save_id: string;
        trial_id: string;
        passed: number;
        hints_used: number;
        code: string;
        difficulty_mode: string;
        is_practice: number;
        error_type: string | null;
        duration_ms: number | null;
        created_at: string;
      }>();

    return results.map((r) => ({
      id: Number(r.id),
      saveId: r.save_id,
      trialId: r.trial_id,
      passed: Boolean(r.passed),
      hintsUsed: Number(r.hints_used),
      code: r.code,
      difficultyMode:
        r.difficulty_mode === 'explorer' || r.difficulty_mode === 'challenge'
          ? r.difficulty_mode
          : 'standard',
      isPractice: Boolean(r.is_practice),
      errorType: r.error_type ?? null,
      durationMs: r.duration_ms !== null && r.duration_ms !== undefined ? Number(r.duration_ms) : null,
      createdAt: r.created_at,
    }));
  }

  async getActivitySince(
    sinceId: number,
    limit: number,
    ownerFilter?: string | null
  ): Promise<{ events: ActivityEventRecord[]; latestId: number }> {
    const clampedLimit = Math.max(1, Math.min(limit, 200));
    const normOwner = ownerFilter ? normalizeEmail(ownerFilter) : null;

    const eventsQuery = normOwner
      ? this.db
          .prepare(
            `SELECT e.id, e.save_id, e.hero_name, s.owner_email, e.event_type,
                    e.realm_id, e.trial_id, e.summary, e.details_json, e.created_at
             FROM activity_events e
             INNER JOIN saves s ON s.id = e.save_id
             WHERE e.id > ? AND LOWER(COALESCE(s.owner_email, '')) = ?
             ORDER BY e.id ASC LIMIT ?`
          )
          .bind(sinceId, normOwner, clampedLimit)
      : this.db
          .prepare(
            `SELECT e.id, e.save_id, e.hero_name, s.owner_email, e.event_type,
                    e.realm_id, e.trial_id, e.summary, e.details_json, e.created_at
             FROM activity_events e
             LEFT JOIN saves s ON s.id = e.save_id
             WHERE e.id > ?
             ORDER BY e.id ASC LIMIT ?`
          )
          .bind(sinceId, clampedLimit);

    const latestQuery = normOwner
      ? this.db
          .prepare(
            `SELECT COALESCE(MAX(e.id), 0) AS latest_id
             FROM activity_events e
             INNER JOIN saves s ON s.id = e.save_id
             WHERE LOWER(COALESCE(s.owner_email, '')) = ?`
          )
          .bind(normOwner)
      : this.db.prepare('SELECT COALESCE(MAX(id), 0) AS latest_id FROM activity_events');

    const [{ results }, latestRow] = await Promise.all([
      eventsQuery.all<EventDbRow>(),
      latestQuery.first<{ latest_id: number }>(),
    ]);

    return {
      events: results.map((r) => PyriaD1.rowToEvent(r)),
      latestId: Number(latestRow?.latest_id ?? 0),
    };
  }

  async getProgressSnapshot(options: {
    ownerFilter?: string | null;
    extraAccount?: string | null;
    includeAllAccounts?: boolean;
  }): Promise<{
    saves: EnrichedSaveRecord[];
    accounts: string[];
    recentEvents: ActivityEventRecord[];
    summary: {
      totalSaves: number;
      totalAttempts: number;
      passRate: number;
      totalHintsUsed: number;
      totalDragonsRescued: number;
    };
  }> {
    const rawFilter = options.ownerFilter;
    const normFilter =
      rawFilter && rawFilter.toLowerCase() !== 'all' ? normalizeEmail(rawFilter) : null;

    const savesQuery = normFilter
      ? this.db
          .prepare(
            `SELECT id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at
             FROM saves WHERE LOWER(COALESCE(owner_email, '')) = ?
             ORDER BY updated_at DESC, created_at DESC`
          )
          .bind(normFilter)
      : this.db.prepare(
          `SELECT id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at
           FROM saves ORDER BY updated_at DESC, created_at DESC`
        );

    const attemptsQuery = normFilter
      ? this.db
          .prepare(
            `SELECT ta.save_id, COUNT(*) AS attempt_count,
                    SUM(CASE WHEN ta.passed = 1 THEN 1 ELSE 0 END) AS pass_count,
                    SUM(ta.hints_used) AS total_hints,
                    MAX(ta.created_at) AS last_attempt_at
             FROM trial_attempts ta
             INNER JOIN saves s ON s.id = ta.save_id
             WHERE LOWER(COALESCE(s.owner_email, '')) = ?
             GROUP BY ta.save_id`
          )
          .bind(normFilter)
      : this.db.prepare(
          `SELECT save_id, COUNT(*) AS attempt_count,
                  SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count,
                  SUM(hints_used) AS total_hints,
                  MAX(created_at) AS last_attempt_at
           FROM trial_attempts GROUP BY save_id`
        );

    const eventsQuery = normFilter
      ? this.db
          .prepare(
            `SELECT e.id, e.save_id, e.hero_name, s.owner_email, e.event_type,
                    e.realm_id, e.trial_id, e.summary, e.details_json, e.created_at
             FROM activity_events e
             INNER JOIN saves s ON s.id = e.save_id
             WHERE LOWER(COALESCE(s.owner_email, '')) = ?
             ORDER BY e.id DESC LIMIT 80`
          )
          .bind(normFilter)
      : this.db.prepare(
          `SELECT e.id, e.save_id, e.hero_name, s.owner_email, e.event_type,
                  e.realm_id, e.trial_id, e.summary, e.details_json, e.created_at
           FROM activity_events e
           LEFT JOIN saves s ON s.id = e.save_id
           ORDER BY e.id DESC LIMIT 80`
        );

    const [saveRes, attemptRes, eventRes, accounts] = await Promise.all([
      savesQuery.all<SaveDbRow>(),
      attemptsQuery.all<AttemptAggRow>(),
      eventsQuery.all<EventDbRow>(),
      options.includeAllAccounts
        ? this.listAccounts(options.extraAccount)
        : Promise.resolve(
            options.extraAccount ? [normalizeEmail(options.extraAccount)!].filter(Boolean) : []
          ),
    ]);

    const attemptsBySave = new Map<string, AttemptAggRow>();
    for (const r of attemptRes.results) {
      attemptsBySave.set(r.save_id, r);
    }

    const enrichedSaves: EnrichedSaveRecord[] = [];
    let totalAttempts = 0;
    let totalPasses = 0;
    let totalHints = 0;
    let totalDragons = 0;

    for (const row of saveRes.results) {
      const state = PyriaD1.rowToSave(row);
      const att = attemptsBySave.get(row.id);
      const attemptCount = att ? Number(att.attempt_count) : 0;
      const passCount = att ? Number(att.pass_count ?? 0) : 0;
      const hintsUsed = att ? Number(att.total_hints ?? 0) : 0;
      const lastAttemptAt = att?.last_attempt_at ?? '';
      const lastActive = row.updated_at >= lastAttemptAt ? row.updated_at : lastAttemptAt;

      const solvedSet = extractStringSet(state, 'solvedTrials', 'completedTrials');
      const rescuedSet = extractStringSet(state, 'rescuedDragons');

      totalAttempts += attemptCount;
      totalPasses += passCount;
      totalHints += hintsUsed;
      totalDragons += rescuedSet.size;

      enrichedSaves.push({
        id: row.id,
        heroName: row.hero_name,
        ownerEmail: row.owner_email ?? null,
        sessionVersion: Number(row.session_version ?? 1),
        hasHeroCode: Boolean(row.recovery_code_hash),
        preferences: parsePreferencesJson(row.preferences_json),
        state,
        stats: {
          attemptCount,
          passCount,
          totalHintsUsed: hintsUsed,
          solvedCount: solvedSet.size,
          rescuedCount: rescuedSet.size,
          lastActive,
        },
        updatedAt: row.updated_at,
      });
    }

    const passRate =
      totalAttempts > 0 ? Math.round((totalPasses / totalAttempts) * 1000) / 10 : 0.0;

    return {
      saves: enrichedSaves,
      accounts,
      recentEvents: eventRes.results.map((r) => PyriaD1.rowToEvent(r)),
      summary: {
        totalSaves: enrichedSaves.length,
        totalAttempts,
        passRate,
        totalHintsUsed: totalHints,
        totalDragonsRescued: totalDragons,
      },
    };
  }

  async overrideTrial(params: {
    saveId: string;
    trialId: string;
    solved: boolean;
    awardShards: boolean;
    shardReward: number;
  }): Promise<{ save: EnrichedSaveRecord; shardsDelta: number } | null> {
    const row = await this.getSaveRow(params.saveId);
    if (!row) return null;

    const now = utcNowIso();
    const state = PyriaD1.rowToSave(row);

    const orderedSolved: string[] = [];
    const seen = new Set<string>();
    for (const key of ['solvedTrials', 'completedTrials'] as const) {
      const val = state[key];
      if (Array.isArray(val)) {
        for (const item of val) {
          const s = String(item);
          if (!seen.has(s)) {
            seen.add(s);
            orderedSolved.push(s);
          }
        }
      }
    }

    let shardsDelta = 0;
    let summary: string;
    const wasAlreadySolved = seen.has(params.trialId);

    if (params.solved) {
      if (!wasAlreadySolved) {
        orderedSolved.push(params.trialId);
        if (params.awardShards && params.shardReward > 0) {
          shardsDelta = Math.trunc(params.shardReward);
          const curShards = coerceByteShards(state.byteShards, 0);
          state.byteShards = coerceByteShards(curShards + shardsDelta, curShards);
        }
      }
      if (state.trialDrafts && typeof state.trialDrafts === 'object' && !Array.isArray(state.trialDrafts)) {
        const drafts = { ...(state.trialDrafts as Record<string, unknown>) };
        delete drafts[params.trialId];
        state.trialDrafts = drafts;
      }
      summary =
        shardsDelta > 0
          ? `Parent marked ${params.trialId} complete (+${shardsDelta} Shards)`
          : `Parent marked ${params.trialId} complete`;
    } else {
      const filtered = orderedSolved.filter((t) => t !== params.trialId);
      orderedSolved.length = 0;
      orderedSolved.push(...filtered);
      summary = `Parent reset ${params.trialId} to unsolved`;
    }

    state.solvedTrials = [...orderedSolved];
    state.completedTrials = [...orderedSolved];
    state.updatedAt = now;

    // Persist state_json without duplicating preferences inside state_json
    const stateToStore = { ...state };
    delete stateToStore.preferences;

    await this.db
      .prepare('UPDATE saves SET state_json = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(stateToStore), now, params.saveId)
      .run();

    // Increment durable parent_overrides rollup when marking a previously unsolved trial solved
    if (params.solved && !wasAlreadySolved) {
      const prefs = parsePreferencesJson(row.preferences_json);
      const overrideDifficulty: DifficultyMode = prefs.difficulty ?? 'standard';
      const day = now.slice(0, 10);
      await this.db
        .prepare(
          `INSERT INTO trial_stats_daily
           (day, trial_id, difficulty_mode, attempts, passes, first_try_passes, unique_solvers, total_hints, tier3_hints, parent_overrides)
           VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 1)
           ON CONFLICT(day, trial_id, difficulty_mode) DO UPDATE SET
             parent_overrides = parent_overrides + 1`
        )
        .bind(day, params.trialId, overrideDifficulty)
        .run();
    }

    const realmId = typeof state.realmId === 'string' && state.realmId ? state.realmId : null;
    await this.insertEvent({
      saveId: params.saveId,
      heroName: row.hero_name,
      eventType: 'parent_override',
      realmId,
      trialId: params.trialId,
      summary,
      details: {
        trialId: params.trialId,
        solved: params.solved,
        shardsDelta,
        byteShards: state.byteShards ?? 0,
      },
      createdAt: now,
    });

    const att = await this.db
      .prepare(
        `SELECT COUNT(*) AS attempt_count,
                SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS pass_count,
                SUM(hints_used) AS total_hints,
                MAX(created_at) AS last_attempt_at
         FROM trial_attempts WHERE save_id = ?`
      )
      .bind(params.saveId)
      .first<AttemptAggRow>();

    const attemptCount = att ? Number(att.attempt_count) : 0;
    const passCount = att ? Number(att.pass_count ?? 0) : 0;
    const hintsUsed = att ? Number(att.total_hints ?? 0) : 0;
    const lastAttemptAt = att?.last_attempt_at ?? '';
    const rescuedSet = extractStringSet(state, 'rescuedDragons');

    const enriched: EnrichedSaveRecord = {
      id: params.saveId,
      heroName: row.hero_name,
      ownerEmail: row.owner_email ?? null,
      sessionVersion: Number(row.session_version ?? 1),
      hasHeroCode: Boolean(row.recovery_code_hash),
      preferences: parsePreferencesJson(row.preferences_json),
      state,
      stats: {
        attemptCount,
        passCount,
        totalHintsUsed: hintsUsed,
        solvedCount: orderedSolved.length,
        rescuedCount: rescuedSet.size,
        lastActive: now >= lastAttemptAt ? now : lastAttemptAt,
      },
      updatedAt: now,
    };

    return { save: enriched, shardsDelta };
  }

  async updatePreferences(
    saveId: string,
    prefs: SavePreferences
  ): Promise<{ saveId: string; preferences: SavePreferences } | null> {
    const row = await this.getSaveRow(saveId);
    if (!row) return null;

    const existingPrefs = parsePreferencesJson(row.preferences_json);
    const merged: SavePreferences = { ...existingPrefs, ...prefs };
    const now = utcNowIso();

    await this.db
      .prepare('UPDATE saves SET preferences_json = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(merged), now, saveId)
      .run();

    return { saveId, preferences: merged };
  }

  async rotateHeroCode(
    saveId: string,
    newRecoveryCodeHash: string
  ): Promise<{ saveId: string; sessionVersion: number } | null> {
    const row = await this.getSaveRow(saveId);
    if (!row) return null;

    const nextVersion = Number(row.session_version ?? 1) + 1;
    const now = utcNowIso();

    await this.db
      .prepare(
        'UPDATE saves SET recovery_code_hash = ?, session_version = ?, updated_at = ? WHERE id = ?'
      )
      .bind(newRecoveryCodeHash, nextVersion, now, saveId)
      .run();

    return { saveId, sessionVersion: nextVersion };
  }

  async assignOwner(saveId: string, ownerEmail: string | null): Promise<SaveRecord | null> {
    const row = await this.getSaveRow(saveId);
    if (!row) return null;

    const normOwner = normalizeEmail(ownerEmail);
    const now = utcNowIso();
    const state = PyriaD1.rowToSave(row);
    state.ownerEmail = normOwner;
    state.linkedToParent = Boolean(normOwner);
    state.updatedAt = now;

    const stateToStore = { ...state };
    delete stateToStore.preferences;

    await this.db
      .prepare('UPDATE saves SET owner_email = ?, state_json = ?, updated_at = ? WHERE id = ?')
      .bind(normOwner, JSON.stringify(stateToStore), now, saveId)
      .run();

    return state;
  }

  /**
   * Atomically claim an unowned hero save for a parent account, enforcing both
   * `owner_email IS NULL` and the per-account 10-hero cap in a single SQL UPDATE.
   */
  async claimUnownedHero(
    saveId: string,
    ownerEmail: string
  ): Promise<
    | { status: 'claimed'; save: SaveRecord }
    | { status: 'already_owned_by_self'; save: SaveRecord }
    | { status: 'already_owned_by_other' }
    | { status: 'quota_exceeded' }
    | { status: 'not_found' }
  > {
    const normOwner = normalizeEmail(ownerEmail);
    if (!normOwner) return { status: 'not_found' };

    const row = await this.getSaveRow(saveId);
    if (!row) return { status: 'not_found' };

    const existingOwner = normalizeEmail(row.owner_email);
    if (existingOwner === normOwner) {
      return { status: 'already_owned_by_self', save: PyriaD1.rowToSave(row) };
    }
    if (existingOwner && existingOwner !== normOwner) {
      return { status: 'already_owned_by_other' };
    }

    const now = utcNowIso();
    const state = PyriaD1.rowToSave(row);
    state.ownerEmail = normOwner;
    state.linkedToParent = Boolean(normOwner);
    state.updatedAt = now;
    const stateToStore = { ...state };
    delete stateToStore.preferences;

    const res = await this.db
      .prepare(
        `UPDATE saves
         SET owner_email = ?, state_json = ?, updated_at = ?
         WHERE id = ?
           AND (owner_email IS NULL OR TRIM(owner_email) = '')
           AND (SELECT COUNT(*) FROM saves WHERE LOWER(COALESCE(owner_email, '')) = ?) < ?`
      )
      .bind(normOwner, JSON.stringify(stateToStore), now, saveId, normOwner, this.maxSavesPerAccount)
      .run();

    if (Number(res.meta.changes ?? 0) === 1) {
      return { status: 'claimed', save: state };
    }

    // Re-check why the atomic UPDATE affected 0 rows
    const latest = await this.getSaveRow(saveId);
    if (!latest) return { status: 'not_found' };
    const latestOwner = normalizeEmail(latest.owner_email);
    if (latestOwner === normOwner) {
      return { status: 'already_owned_by_self', save: PyriaD1.rowToSave(latest) };
    }
    if (latestOwner && latestOwner !== normOwner) {
      return { status: 'already_owned_by_other' };
    }
    return { status: 'quota_exceeded' };
  }
}
