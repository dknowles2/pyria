import { applySecurityHeaders, jsonResponse } from './security';
import type {
  AuthContext,
  DifficultyMode,
  Env,
  TrialCalibrationFlag,
  TrialMetadata,
  TrialMetricRow,
  TrialMetricsFilters,
  TrialMetricsResponse,
} from './types';
import { ValidationError, hasControlChars } from './validation';

const VALID_DIFFICULTY_FILTERS = new Set(['all', 'explorer', 'standard', 'challenge']);
const VALID_DAYS_FILTERS = new Set(['7', '30', '90', 'all']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FORMULA_PREFIX_RE = /^(?:[=+\-@\t\r]|\s+[=+\-@])/;
const MAX_RAW_ATTEMPT_ROWS = 50_000;

interface DailyRollupRow {
  day: string;
  trial_id: string;
  attempts: number;
  passes: number;
  first_try_passes: number;
  unique_attempters: number;
  unique_solvers: number;
  hinted_attempts: number;
  total_hints: number;
  tier3_hints: number;
  parent_overrides: number;
}

interface PriorBeforeWindowRow {
  save_id: string;
  trial_id: string;
  had_pass: number;
}

interface RawAttemptRow {
  save_id: string;
  trial_id: string;
  passed: number;
  hints_used: number;
  is_practice: number;
  error_type: string | null;
  day: string;
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

export function computePercentile(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return round1(sortedValues[0]);
  const idx = percentile * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const interpolated = sortedValues[lo] + (idx - lo) * (sortedValues[hi] - sortedValues[lo]);
  return round1(interpolated);
}

export function isValidIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [yStr, mStr, dStr] = value.split('-');
  const y = Number.parseInt(yStr, 10);
  const m = Number.parseInt(mStr, 10);
  const d = Number.parseInt(dStr, 10);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function parseTrialMetricsFilters(searchParams: URLSearchParams): TrialMetricsFilters {
  const parseOptString = (name: string, maxLen: number): string | null => {
    const raw = searchParams.get(name);
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length > maxLen || hasControlChars(trimmed)) {
      throw new ValidationError(`Invalid ${name} filter`);
    }
    return trimmed;
  };

  const eraId = parseOptString('eraId', 128);
  const realmId = parseOptString('realmId', 128);
  const trialType = parseOptString('trialType', 64);

  const rawDiff = (searchParams.get('difficulty') ?? 'all').trim().toLowerCase() || 'all';
  if (!VALID_DIFFICULTY_FILTERS.has(rawDiff)) {
    throw new ValidationError("difficulty must be 'all', 'explorer', 'standard', or 'challenge'");
  }
  const difficulty = rawDiff as 'all' | DifficultyMode;

  const rawDays = (searchParams.get('days') ?? '30').trim().toLowerCase() || '30';
  if (!VALID_DAYS_FILTERS.has(rawDays)) {
    throw new ValidationError("days must be '7', '30', '90', or 'all'");
  }
  const days = rawDays as '7' | '30' | '90' | 'all';

  const rawSince = (searchParams.get('since') ?? '').trim();
  let since: string | null = null;
  if (rawSince) {
    if (!isValidIsoDate(rawSince)) {
      throw new ValidationError('since must be a valid YYYY-MM-DD date');
    }
    since = rawSince;
  }

  const rawMinHeroes = (searchParams.get('minHeroes') ?? '').trim();
  let minHeroes = 5;
  if (rawMinHeroes) {
    if (!/^\d+$/.test(rawMinHeroes)) {
      throw new ValidationError('minHeroes must be an integer >= 1');
    }
    const parsed = Number.parseInt(rawMinHeroes, 10);
    if (parsed < 1 || parsed > 10000) {
      throw new ValidationError('minHeroes must be between 1 and 10000');
    }
    minHeroes = parsed;
  }

  const rawPractice = (searchParams.get('includePractice') ?? '0').trim().toLowerCase();
  let includePractice = false;
  if (rawPractice === '1' || rawPractice === 'true') {
    includePractice = true;
  } else if (rawPractice === '0' || rawPractice === 'false' || rawPractice === '') {
    includePractice = false;
  } else {
    throw new ValidationError("includePractice must be '0' or '1'");
  }

  const rawFormat = (searchParams.get('format') ?? 'json').trim().toLowerCase() || 'json';
  if (rawFormat !== 'json' && rawFormat !== 'csv') {
    throw new ValidationError("format must be 'json' or 'csv'");
  }
  const format = rawFormat as 'json' | 'csv';

  return {
    eraId,
    realmId,
    trialType,
    difficulty,
    days,
    since,
    minHeroes,
    includePractice,
    format,
  };
}

export function computeMinDay(filters: TrialMetricsFilters, now: Date = new Date()): string | null {
  if (filters.since) return filters.since;
  if (filters.days === 'all') return null;
  const daysNum = Number.parseInt(filters.days, 10);
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (daysNum - 1))
  );
  return cutoff.toISOString().slice(0, 10);
}

export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (FORMULA_PREFIX_RE.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatTrialMetricsCsv(trials: TrialMetricRow[]): string {
  const headers = [
    'trialId',
    'title',
    'eraId',
    'realmId',
    'trialType',
    'concepts',
    'uniqueHeroes',
    'uniqueSolvers',
    'attempts',
    'passes',
    'completionRate',
    'firstTryPassRate',
    'medianAttemptsToSolve',
    'p75AttemptsToSolve',
    'hintUsageRate',
    'tier3HintRate',
    'parentOverrides',
    'parentOverrideRate',
    'topError',
    'flag',
    'flagReasons',
  ];

  const lines: string[] = [headers.join(',')];
  for (const t of trials) {
    const topErr =
      t.topErrors.length > 0 ? `${t.topErrors[0].errorType} (${t.topErrors[0].count})` : '';
    const row = [
      t.trialId,
      t.title,
      t.eraId,
      t.realmId,
      t.trialType,
      t.concepts.join('; '),
      t.uniqueHeroes,
      t.uniqueSolvers,
      t.attempts,
      t.passes,
      t.completionRate ?? '',
      t.firstTryPassRate ?? '',
      t.medianAttemptsToSolve ?? '',
      t.p75AttemptsToSolve ?? '',
      t.hintUsageRate ?? '',
      t.tier3HintRate ?? '',
      t.parentOverrides,
      t.parentOverrideRate ?? '',
      topErr,
      t.flag,
      t.flagReasons.join('; '),
    ];
    lines.push(row.map(sanitizeCsvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

async function loadJsonAsset<T>(env: Env, requestUrl: string, assetPath: string): Promise<T | null> {
  try {
    const assetUrl = new URL(assetPath, requestUrl);
    const res = await env.ASSETS.fetch(new Request(assetUrl.toString()));
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadTrialCatalog(env: Env, requestUrl: string): Promise<TrialMetadata[]> {
  const game = await loadJsonAsset<{ eraOrder?: string[] }>(env, requestUrl, '/content/game.json');
  const eraIds = game?.eraOrder ?? [
    'era-01-8bit',
    'era-02-16bit',
    'era-03-32bit',
    'era-04-64bit',
  ];

  const eraDocs = await Promise.all(
    eraIds.map((eraId) =>
      loadJsonAsset<{
        id?: string;
        name?: string;
        realms?: Array<{
          id?: string;
          name?: string;
          trials?: Array<{
            id?: string;
            title?: string;
            trialType?: string;
            concepts?: unknown[];
          }>;
        }>;
      }>(env, requestUrl, `/content/eras/${encodeURIComponent(eraId)}.json`)
    )
  );

  const catalog: TrialMetadata[] = [];
  for (let i = 0; i < eraIds.length; i += 1) {
    const era = eraDocs[i];
    if (!era?.realms) continue;
    const eraId = era.id || eraIds[i];
    const eraName = era.name || eraId;
    for (const realm of era.realms) {
      const realmId = realm.id || '';
      const realmName = realm.name || realmId;
      for (const trial of realm.trials ?? []) {
        if (!trial.id) continue;
        catalog.push({
          trialId: trial.id,
          title: trial.title || trial.id,
          eraId,
          eraName,
          realmId,
          realmName,
          trialType: trial.trialType || 'code',
          concepts: Array.isArray(trial.concepts) ? trial.concepts.map((c) => String(c)) : [],
        });
      }
    }
  }
  return catalog;
}

function evaluateFlag(params: {
  trialType: string;
  uniqueHeroes: number;
  minHeroes: number;
  attempts: number;
  passes: number;
  completionRate: number | null;
  firstTryPassRate: number | null;
  medianAttemptsToSolve: number | null;
  hintUsageRate: number | null;
  tier3HintRate: number | null;
  parentOverrideRate: number | null;
  assertionErrorCount: number;
}): { flag: TrialCalibrationFlag; flagReasons: string[] } {
  if (params.uniqueHeroes < params.minHeroes) {
    return {
      flag: 'low_data',
      flagReasons:
        params.uniqueHeroes === 0
          ? ['No attempts recorded']
          : [`Only ${params.uniqueHeroes} hero(es) attempted (minimum ${params.minHeroes})`],
    };
  }

  const bugReasons: string[] = [];
  const hardReasons: string[] = [];
  const easyReasons: string[] = [];

  const failedAttempts = Math.max(0, params.attempts - params.passes);
  if (
    failedAttempts >= 3 &&
    params.assertionErrorCount / failedAttempts >= 0.6 &&
    ((params.tier3HintRate ?? 0) >= 20 || (params.completionRate ?? 100) < 60)
  ) {
    const pct = round1((params.assertionErrorCount / failedAttempts) * 100);
    bugReasons.push(`High AssertionError share of failures (${pct}%) despite hints/low completion`);
  }

  if (params.completionRate !== null && params.completionRate < 60) {
    hardReasons.push(`Low completion rate (${params.completionRate}%)`);
  }
  if (params.medianAttemptsToSolve !== null && params.medianAttemptsToSolve >= 5) {
    hardReasons.push(`High median attempts to solve (${params.medianAttemptsToSolve})`);
  }
  if (params.tier3HintRate !== null && params.tier3HintRate >= 35) {
    hardReasons.push(`High Tier-3 walkthrough hint rate (${params.tier3HintRate}%)`);
  }
  if (params.parentOverrideRate !== null && params.parentOverrideRate >= 15) {
    hardReasons.push(`Elevated parent override rate (${params.parentOverrideRate}%)`);
  }

  const easyThreshold = params.trialType === 'multiple_choice' ? 95 : 90;
  if (
    params.firstTryPassRate !== null &&
    params.firstTryPassRate >= easyThreshold &&
    (params.hintUsageRate ?? 0) <= 5 &&
    (params.medianAttemptsToSolve === null || params.medianAttemptsToSolve <= 1)
  ) {
    easyReasons.push(
      `Very high first-try pass rate (${params.firstTryPassRate}%) with minimal hints (${params.hintUsageRate ?? 0}%)`
    );
  }

  if (bugReasons.length > 0) {
    return { flag: 'possible_bug', flagReasons: [...bugReasons, ...hardReasons] };
  }
  if (hardReasons.length > 0) {
    return { flag: 'too_hard', flagReasons: hardReasons };
  }
  if (easyReasons.length > 0) {
    return { flag: 'too_easy', flagReasons: easyReasons };
  }
  return { flag: 'ok', flagReasons: [] };
}

export async function computeTrialMetrics(
  db: D1Database,
  catalog: TrialMetadata[],
  filters: TrialMetricsFilters,
  now: Date = new Date()
): Promise<TrialMetricsResponse> {
  const minDay = computeMinDay(filters, now);

  // Build filtered queries for trial_stats_daily and trial_attempts
  const rollupWhere: string[] = [];
  const rollupBinds: unknown[] = [];
  if (minDay) {
    rollupWhere.push('day >= ?');
    rollupBinds.push(minDay);
  }
  if (filters.difficulty !== 'all') {
    rollupWhere.push('difficulty_mode = ?');
    rollupBinds.push(filters.difficulty);
  }
  const rollupSql = `
    SELECT day, trial_id,
           SUM(attempts) AS attempts,
           SUM(passes) AS passes,
           SUM(first_try_passes) AS first_try_passes,
           SUM(unique_attempters) AS unique_attempters,
           SUM(unique_solvers) AS unique_solvers,
           SUM(hinted_attempts) AS hinted_attempts,
           SUM(total_hints) AS total_hints,
           SUM(tier3_hints) AS tier3_hints,
           SUM(parent_overrides) AS parent_overrides
    FROM trial_stats_daily
    ${rollupWhere.length > 0 ? `WHERE ${rollupWhere.join(' AND ')}` : ''}
    GROUP BY day, trial_id
    ORDER BY day ASC
  `;

  const rawWhere: string[] = [];
  const rawBinds: unknown[] = [];
  if (minDay) {
    rawWhere.push('created_at >= ?');
    rawBinds.push(minDay);
  }
  if (filters.difficulty !== 'all') {
    rawWhere.push("COALESCE(difficulty_mode, 'standard') = ?");
    rawBinds.push(filters.difficulty);
  }
  if (!filters.includePractice) {
    rawWhere.push('COALESCE(is_practice, 0) = 0');
  }
  const rawSql = `
    SELECT save_id, trial_id, passed, hints_used,
           COALESCE(is_practice, 0) AS is_practice,
           error_type,
           SUBSTR(created_at, 1, 10) AS day
    FROM trial_attempts
    ${rawWhere.length > 0 ? `WHERE ${rawWhere.join(' AND ')}` : ''}
    ORDER BY trial_id ASC, save_id ASC, created_at ASC, id ASC
    LIMIT ?
  `;
  rawBinds.push(MAX_RAW_ATTEMPT_ROWS + 1);

  const priorPromise = minDay
    ? db
        .prepare(
          `SELECT save_id, trial_id,
                  MAX(CASE WHEN passed = 1 THEN 1 ELSE 0 END) AS had_pass
           FROM trial_attempts
           WHERE created_at < ? AND COALESCE(is_practice, 0) = 0
           GROUP BY save_id, trial_id`
        )
        .bind(minDay)
        .all<PriorBeforeWindowRow>()
    : Promise.resolve({ results: [] as PriorBeforeWindowRow[] });

  const [rollupRes, rawRes, priorRes] = await Promise.all([
    db.prepare(rollupSql).bind(...rollupBinds).all<DailyRollupRow>(),
    db.prepare(rawSql).bind(...rawBinds).all<RawAttemptRow>(),
    priorPromise,
  ]);

  const truncated = rawRes.results.length > MAX_RAW_ATTEMPT_ROWS;
  const boundedRawRows = truncated
    ? rawRes.results.slice(0, MAX_RAW_ATTEMPT_ROWS)
    : rawRes.results;

  // Track (trialId::saveId) -> hadPassBeforeWindow so windowed first-try & uniqueSolvers are never inflated
  const priorBeforeWindow = new Map<string, boolean>();
  for (const p of priorRes.results) {
    priorBeforeWindow.set(`${p.trial_id}\u0000${p.save_id}`, Boolean(p.had_pass));
  }

  // Index rollup rows by trial_id -> day
  const rollupByTrial = new Map<string, Map<string, DailyRollupRow>>();
  for (const r of rollupRes.results) {
    let dayMap = rollupByTrial.get(r.trial_id);
    if (!dayMap) {
      dayMap = new Map();
      rollupByTrial.set(r.trial_id, dayMap);
    }
    dayMap.set(r.day, {
      day: r.day,
      trial_id: r.trial_id,
      attempts: Number(r.attempts ?? 0),
      passes: Number(r.passes ?? 0),
      first_try_passes: Number(r.first_try_passes ?? 0),
      unique_attempters: Number(r.unique_attempters ?? 0),
      unique_solvers: Number(r.unique_solvers ?? 0),
      hinted_attempts: Number(r.hinted_attempts ?? 0),
      total_hints: Number(r.total_hints ?? 0),
      tier3_hints: Number(r.tier3_hints ?? 0),
      parent_overrides: Number(r.parent_overrides ?? 0),
    });
  }

  // Group raw attempts by trial_id
  const rawByTrial = new Map<string, RawAttemptRow[]>();
  for (const r of boundedRawRows) {
    let list = rawByTrial.get(r.trial_id);
    if (!list) {
      list = [];
      rawByTrial.set(r.trial_id, list);
    }
    list.push(r);
  }

  // Build combined trial metadata list (catalog + any orphan trialIds present in DB)
  const metaById = new Map<string, TrialMetadata>();
  const orderedMeta: TrialMetadata[] = [];
  for (const meta of catalog) {
    metaById.set(meta.trialId, meta);
    orderedMeta.push(meta);
  }
  const extraIds = new Set<string>([...rollupByTrial.keys(), ...rawByTrial.keys()]);
  for (const tid of [...extraIds].sort()) {
    if (!metaById.has(tid)) {
      const fallback: TrialMetadata = {
        trialId: tid,
        title: tid,
        eraId: 'unknown',
        eraName: 'Unknown Era',
        realmId: 'unknown',
        realmName: 'Unknown Realm',
        trialType: 'code',
        concepts: [],
      };
      metaById.set(tid, fallback);
      orderedMeta.push(fallback);
    }
  }

  // Apply metadata filters
  const filteredMeta = orderedMeta.filter((m) => {
    if (filters.eraId && m.eraId !== filters.eraId) return false;
    if (filters.realmId && m.realmId !== filters.realmId) return false;
    if (filters.trialType && m.trialType !== filters.trialType) return false;
    return true;
  });

  const trialRows: TrialMetricRow[] = [];
  const allTrialMedians: number[] = [];
  let trialsWithData = 0;
  let flaggedTooHard = 0;
  let flaggedTooEasy = 0;
  let flaggedPossibleBug = 0;
  let flaggedLowData = 0;
  let totalOverrides = 0;

  for (const meta of filteredMeta) {
    const rawRows = rawByTrial.get(meta.trialId) ?? [];
    const rollupDayMap = rollupByTrial.get(meta.trialId) ?? new Map<string, DailyRollupRow>();

    // Per-day raw non-practice and raw practice buckets (to avoid double-counting with rollup!)
    const rawNpByDay = new Map<
      string,
      { attempts: number; passes: number; hintedAttempts: number; tier3Hints: number }
    >();
    const rawPracticeByDay = new Map<
      string,
      { attempts: number; passes: number; hintedAttempts: number; tier3Hints: number }
    >();

    const heroSaves = new Set<string>();
    const heroSolved = new Set<string>();
    const heroFirstPassed = new Set<string>();
    const heroAttemptCountsBeforeSolve = new Map<string, number>();
    const heroSolvedCounts = new Map<string, number>();

    const hintTierBreakdown = { tier0: 0, tier1: 0, tier2: 0, tier3: 0 };
    const errorCounts = new Map<string, number>();
    let rawNpCount = 0;

    for (const r of rawRows) {
      const passed = Boolean(r.passed);
      const hints = Number(r.hints_used ?? 0);
      const isPractice = Boolean(r.is_practice);
      const day = r.day;

      if (hints <= 0) hintTierBreakdown.tier0 += 1;
      else if (hints === 1) hintTierBreakdown.tier1 += 1;
      else if (hints === 2) hintTierBreakdown.tier2 += 1;
      else hintTierBreakdown.tier3 += 1;

      if (!passed && r.error_type) {
        errorCounts.set(r.error_type, (errorCounts.get(r.error_type) ?? 0) + 1);
      }

      const targetMap = isPractice ? rawPracticeByDay : rawNpByDay;
      let bucket = targetMap.get(day);
      if (!bucket) {
        bucket = { attempts: 0, passes: 0, hintedAttempts: 0, tier3Hints: 0 };
        targetMap.set(day, bucket);
      }
      bucket.attempts += 1;
      if (passed) bucket.passes += 1;
      if (hints > 0) bucket.hintedAttempts += 1;
      if (hints >= 3) bucket.tier3Hints += 1;

      if (!isPractice) {
        rawNpCount += 1;
      }

      // Per-hero progression tracking (non-practice rows only, excluding heroes with pre-window history)
      if (!isPractice) {
        const priorKey = `${meta.trialId}\u0000${r.save_id}`;
        const hadPriorAttempt = priorBeforeWindow.has(priorKey);
        const hadPriorPass = priorBeforeWindow.get(priorKey) === true;

        const isFirstInWindow = !heroSaves.has(r.save_id);
        heroSaves.add(r.save_id);
        if (isFirstInWindow && passed && !hadPriorAttempt) {
          heroFirstPassed.add(r.save_id);
        }
        if (!hadPriorPass && !heroSolved.has(r.save_id)) {
          const nextCount = (heroAttemptCountsBeforeSolve.get(r.save_id) ?? 0) + 1;
          heroAttemptCountsBeforeSolve.set(r.save_id, nextCount);
          if (passed) {
            heroSolved.add(r.save_id);
            if (!hadPriorAttempt) {
              heroSolvedCounts.set(r.save_id, nextCount);
            }
          }
        }
      }
    }

    // Reconcile non-practice raw rows vs durable daily rollups per day (no double-counting!)
    const allDays = new Set<string>([
      ...rollupDayMap.keys(),
      ...rawNpByDay.keys(),
      ...rawPracticeByDay.keys(),
    ]);

    let mergedNpAttempts = 0;
    let mergedNpPasses = 0;
    let mergedNpHintedAttempts = 0;
    let mergedNpTier3 = 0;
    let rollupFirstTryTotal = 0;
    let rollupUniqueAttemptersTotal = 0;
    let rollupUniqueSolversTotal = 0;
    let parentOverrides = 0;

    let practiceAttempts = 0;
    let practicePasses = 0;
    let practiceHintedAttempts = 0;
    let practiceTier3 = 0;

    const dailyTrend: Array<{ day: string; attempts: number; passes: number }> = [];

    for (const day of [...allDays].sort()) {
      const rDay = rollupDayMap.get(day);
      const npDay = rawNpByDay.get(day);
      const prDay = rawPracticeByDay.get(day);

      const dayNpAttempts = Math.max(npDay?.attempts ?? 0, rDay?.attempts ?? 0);
      const dayNpPasses = Math.max(npDay?.passes ?? 0, rDay?.passes ?? 0);
      const dayNpHinted = Math.max(npDay?.hintedAttempts ?? 0, rDay?.hinted_attempts ?? 0);
      const dayNpTier3 = Math.max(npDay?.tier3Hints ?? 0, rDay?.tier3_hints ?? 0);

      mergedNpAttempts += dayNpAttempts;
      mergedNpPasses += dayNpPasses;
      mergedNpHintedAttempts += dayNpHinted;
      mergedNpTier3 += dayNpTier3;

      if (rDay) {
        rollupFirstTryTotal += rDay.first_try_passes;
        rollupUniqueAttemptersTotal += rDay.unique_attempters;
        rollupUniqueSolversTotal += rDay.unique_solvers;
        parentOverrides += rDay.parent_overrides;
      }

      const dayPrAttempts = prDay?.attempts ?? 0;
      const dayPrPasses = prDay?.passes ?? 0;
      practiceAttempts += dayPrAttempts;
      practicePasses += dayPrPasses;
      practiceHintedAttempts += prDay?.hintedAttempts ?? 0;
      practiceTier3 += prDay?.tier3Hints ?? 0;

      const dayTotalAttempts = dayNpAttempts + dayPrAttempts;
      const dayTotalPasses = dayNpPasses + dayPrPasses;
      if (dayTotalAttempts > 0 || dayTotalPasses > 0) {
        dailyTrend.push({
          day,
          attempts: dayTotalAttempts,
          passes: dayTotalPasses,
        });
      }
    }

    const attempts = mergedNpAttempts + practiceAttempts;
    const passes = mergedNpPasses + practicePasses;
    const hintedAttempts = Math.min(attempts, mergedNpHintedAttempts + practiceHintedAttempts);
    const tier3Hints = mergedNpTier3 + practiceTier3;

    // Use lifetime-accurate rollup counts when rollup covers all raw non-practice attempts
    const rollupAuthoritative = rollupDayMap.size > 0 && rawNpCount <= mergedNpAttempts;
    const uniqueSolvers = rollupAuthoritative
      ? rollupUniqueSolversTotal
      : Math.max(heroSolved.size, rollupUniqueSolversTotal);
    const firstTryPasses = Math.min(
      uniqueSolvers,
      rollupAuthoritative
        ? rollupFirstTryTotal
        : Math.max(heroFirstPassed.size, rollupFirstTryTotal)
    );
    let uniqueHeroes = Math.max(heroSaves.size, rollupUniqueAttemptersTotal, uniqueSolvers);
    if (uniqueHeroes === 0 && attempts > 0) {
      uniqueHeroes = 1;
    }

    const completionRate =
      uniqueHeroes > 0 ? round1(Math.min(100, (uniqueSolvers / uniqueHeroes) * 100)) : null;
    const firstTryPassRate =
      uniqueHeroes > 0 ? round1(Math.min(100, (firstTryPasses / uniqueHeroes) * 100)) : null;

    const attemptsToSolveSorted = [...heroSolvedCounts.values()].sort((a, b) => a - b);
    const medianAttemptsToSolve = computePercentile(attemptsToSolveSorted, 0.5);
    const p75AttemptsToSolve = computePercentile(attemptsToSolveSorted, 0.75);

    const hintUsageRate = attempts > 0 ? round1((hintedAttempts / attempts) * 100) : null;
    const tier3HintRate = attempts > 0 ? round1((tier3Hints / attempts) * 100) : null;

    const parentOverrideRate =
      uniqueHeroes > 0
        ? round1(Math.min(100, (parentOverrides / uniqueHeroes) * 100))
        : parentOverrides > 0
          ? 100.0
          : null;

    const topErrors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([errorType, count]) => ({ errorType, count }));

    const assertionErrorCount = errorCounts.get('AssertionError') ?? 0;
    const { flag, flagReasons } = evaluateFlag({
      trialType: meta.trialType,
      uniqueHeroes,
      minHeroes: filters.minHeroes,
      attempts,
      passes,
      completionRate,
      firstTryPassRate,
      medianAttemptsToSolve,
      hintUsageRate,
      tier3HintRate,
      parentOverrideRate,
      assertionErrorCount,
    });

    if (attempts > 0 || parentOverrides > 0) {
      trialsWithData += 1;
    }
    if (medianAttemptsToSolve !== null) {
      allTrialMedians.push(medianAttemptsToSolve);
    }
    totalOverrides += parentOverrides;
    if (flag === 'too_hard') flaggedTooHard += 1;
    else if (flag === 'too_easy') flaggedTooEasy += 1;
    else if (flag === 'possible_bug') flaggedPossibleBug += 1;
    else if (flag === 'low_data') flaggedLowData += 1;

    trialRows.push({
      trialId: meta.trialId,
      title: meta.title,
      eraId: meta.eraId,
      eraName: meta.eraName,
      realmId: meta.realmId,
      realmName: meta.realmName,
      trialType: meta.trialType,
      concepts: meta.concepts,
      uniqueHeroes,
      uniqueSolvers,
      attempts,
      passes,
      completionRate,
      firstTryPassRate,
      medianAttemptsToSolve,
      p75AttemptsToSolve,
      hintUsageRate,
      tier3HintRate,
      hintTierBreakdown,
      parentOverrides,
      parentOverrideRate,
      topErrors,
      dailyTrend,
      flag,
      flagReasons,
    });
  }

  allTrialMedians.sort((a, b) => a - b);
  const overallMedianAttempts = computePercentile(allTrialMedians, 0.5);

  return {
    filters,
    summary: {
      totalTrials: trialRows.length,
      trialsWithData,
      flaggedTooHard,
      flaggedTooEasy,
      flaggedPossibleBug,
      flaggedLowData,
      overallMedianAttempts,
      totalOverrides,
      truncated,
    },
    trials: trialRows,
  };
}

export async function handleAdminTrialMetrics(
  request: Request,
  env: Env,
  auth: AuthContext,
  url: URL
): Promise<Response> {
  if (!auth.isAdmin) {
    return jsonResponse({ error: 'Admin access required' }, 403);
  }

  let filters: TrialMetricsFilters;
  try {
    filters = parseTrialMetricsFilters(url.searchParams);
  } catch (err) {
    if (err instanceof ValidationError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    return jsonResponse({ error: 'Invalid query parameters' }, 400);
  }

  const catalog = await loadTrialCatalog(env, request.url);
  const metrics = await computeTrialMetrics(env.DB, catalog, filters);

  if (filters.format === 'csv') {
    const csv = formatTrialMetricsCsv(metrics.trials);
    const headers = new Headers({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="pyria-trial-metrics.csv"',
      'Cache-Control': 'no-store',
    });
    applySecurityHeaders(headers);
    return new Response(request.method.toUpperCase() === 'HEAD' ? null : csv, {
      status: 200,
      headers,
    });
  }

  return jsonResponse(metrics, 200);
}
