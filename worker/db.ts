import type {
  ActivityEventRecord,
  AttemptRecord,
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
  readonly maxAttemptCodeRows: number;
  readonly maxAttemptsPerSave: number;
  readonly maxEventsPerSave: number;

  constructor(env: Env) {
    this.db = env.DB;
    this.maxSavesPerAccount = parsePositiveInt(
      env.PYRIA_MAX_SAVES_PER_ACCOUNT,
      DEFAULT_MAX_SAVES_PER_ACCOUNT
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
    return {
      ...state,
      id: row.id,
      heroName: row.hero_name,
      ownerEmail: row.owner_email ?? null,
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
    if (normOwner !== null) {
      const count = await this.countAccountSaves(normOwner);
      if (count >= this.maxSavesPerAccount) {
        throw new QuotaError(
          `Save limit reached (${this.maxSavesPerAccount} heroes per parent account)`
        );
      }
    }

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
    await this.db
      .prepare(
        `INSERT INTO saves
         (id, hero_name, owner_email, recovery_code_hash, session_version, preferences_json, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .bind(
        saveId,
        heroName,
        normOwner,
        options?.recoveryCodeHash ?? null,
        prefsJson,
        stateJson,
        now,
        now
      )
      .run();

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
  }): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT hero_name, state_json FROM saves WHERE id = ?')
      .bind(params.saveId)
      .first<{ hero_name: string; state_json: string }>();
    if (!row) return null;

    const now = utcNowIso();
    const st = safeParseObject(row.state_json);
    const realmId = typeof st.realmId === 'string' && st.realmId ? st.realmId : null;

    const insertRes = await this.db
      .prepare(
        `INSERT INTO trial_attempts (save_id, trial_id, passed, hints_used, code, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        params.saveId,
        params.trialId,
        params.passed ? 1 : 0,
        params.hintsUsed,
        params.code,
        now
      )
      .run();

    const attemptId = Number(insertRes.meta.last_row_id ?? 0);

    // Blank code blobs past maxAttemptCodeRows while preserving aggregate stats,
    // and enforce hard row cap maxAttemptsPerSave.
    await this.db.batch([
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
        .bind(params.saveId, params.saveId, this.maxAttemptsPerSave),
    ]);

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
        `SELECT id, save_id, trial_id, passed, hints_used, code, created_at
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
        created_at: string;
      }>();

    return results.map((r) => ({
      id: Number(r.id),
      saveId: r.save_id,
      trialId: r.trial_id,
      passed: Boolean(r.passed),
      hintsUsed: Number(r.hints_used),
      code: r.code,
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

    const attemptsQuery = this.db.prepare(
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

    if (params.solved) {
      if (!seen.has(params.trialId)) {
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
    state.updatedAt = now;

    const stateToStore = { ...state };
    delete stateToStore.preferences;

    await this.db
      .prepare('UPDATE saves SET owner_email = ?, state_json = ?, updated_at = ? WHERE id = ?')
      .bind(normOwner, JSON.stringify(stateToStore), now, saveId)
      .run();

    return state;
  }
}
