import type { DifficultyMode, SavePreferences } from './types';

export const MAX_JSON_BODY_BYTES = 512 * 1024;
export const MAX_SAVE_BODY_BYTES = 128 * 1024;
export const MAX_SAVE_STATE_BYTES = 128 * 1024;
export const MAX_ATTEMPT_BODY_BYTES = 64 * 1024;
export const MAX_ATTEMPT_CODE_BYTES = 32 * 1024;

export const HERO_NAME_MIN_LEN = 2;
export const HERO_NAME_MAX_LEN = 24;
export const MAX_TRIAL_ID_LEN = 128;
export const MAX_SAVE_STRING_LEN = 128;
export const MAX_SAVE_LIST_ITEMS = 1000;
export const MAX_TRIAL_DRAFTS = 512;
export const MAX_APPEARANCE_KEYS = 32;
export const MAX_BYTE_SHARDS = 1_000_000_000;
export const MAX_DIFF_EVENTS_PER_UPDATE = 100;

export const ALLOWED_SAVE_KEYS = new Set<string>([
  'id',
  'heroName',
  'hero_name',
  'ownerEmail',
  'owner_email',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'appearance',
  'eraId',
  'realmId',
  'visualEra',
  'byteShards',
  'stats',
  'solvedTrials',
  'completedTrials',
  'trialDrafts',
  'seenCutscenes',
  'foundEasterEggs',
  'unlockedSpells',
  'rescuedDragons',
  'openedChests',
  'ownedUnlockIds',
  'unlockedItems',
  'unlockedIds',
  'position',
]);

const SAVE_STRING_LIST_KEYS = new Set<string>([
  'solvedTrials',
  'completedTrials',
  'seenCutscenes',
  'foundEasterEggs',
  'unlockedSpells',
  'rescuedDragons',
  'openedChests',
  'ownedUnlockIds',
  'unlockedItems',
  'unlockedIds',
]);

const SAVE_SCALAR_STRING_KEYS = new Set<string>(['eraId', 'realmId', 'visualEra']);

const STATS_STRING_LIST_KEYS = new Set<string>([
  'customItems',
  'completedWorkshopChallenges',
]);

const SERVER_MANAGED_SAVE_KEYS = new Set<string>([
  'id',
  'heroName',
  'hero_name',
  'ownerEmail',
  'owner_email',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

const VALID_DIFFICULTIES = new Set<DifficultyMode>(['explorer', 'standard', 'challenge']);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
const DISALLOWED_UNICODE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export class ValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

export class QuotaError extends Error {
  readonly status: number;
  constructor(message: string, status = 429) {
    super(message);
    this.name = 'QuotaError';
    this.status = status;
  }
}

export function utf8ByteLength(str: string): number {
  return encoder.encode(str).byteLength;
}

export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  // Walk back from maxBytes if we landed on a UTF-8 continuation byte (10xxxxxx)
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
}

export function hasSurrogatesOrNul(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // valid surrogate pair
      } else {
        return true; // lone high surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

export function hasControlChars(value: string): boolean {
  if (hasSurrogatesOrNul(value)) return true;
  for (const ch of value) {
    if (ch === '\u200d') continue; // Allow ZWJ for multi-codepoint emoji sequences
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || DISALLOWED_UNICODE_RE.test(ch)) {
      return true;
    }
  }
  return false;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  return cleaned || null;
}

export function coerceByteShards(raw: unknown, fallback = 0): number {
  const safeFallback = Math.max(0, Math.min(Math.trunc(fallback), MAX_BYTE_SHARDS));
  if (typeof raw === 'boolean' || raw === null || raw === undefined) {
    return safeFallback;
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return safeFallback;
  return Math.max(0, Math.min(Math.trunc(num), MAX_BYTE_SHARDS));
}

export function validateHeroName(
  raw: unknown,
  allowedLegacyName?: string | null
): string {
  if (typeof raw !== 'string') {
    throw new ValidationError('heroName must be a string');
  }
  if (allowedLegacyName !== undefined && allowedLegacyName !== null && raw === allowedLegacyName) {
    return raw;
  }
  if (hasControlChars(raw)) {
    throw new ValidationError('heroName must not contain control characters');
  }
  const cleaned = raw.trim();
  const len = Array.from(cleaned).length;
  if (len < HERO_NAME_MIN_LEN || len > HERO_NAME_MAX_LEN) {
    throw new ValidationError(
      `heroName must be between ${HERO_NAME_MIN_LEN} and ${HERO_NAME_MAX_LEN} characters`
    );
  }
  return cleaned;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function validateSavePayload(
  payload: Record<string, unknown>,
  options: {
    requireHeroName: boolean;
    allowedLegacyHeroName?: string | null;
    sanitizeDrafts?: boolean;
  }
): { sanitized: Record<string, unknown>; heroName: string | null } {
  const unknownKeys = Object.keys(payload)
    .filter((k) => !ALLOWED_SAVE_KEYS.has(k))
    .sort();
  if (unknownKeys.length > 0) {
    let preview = unknownKeys.slice(0, 8).join(', ');
    if (unknownKeys.length > 8) {
      preview += ` (+${unknownKeys.length - 8} more)`;
    }
    throw new ValidationError(`Disallowed save field(s): ${preview}`);
  }

  let heroName: string | null = null;
  if ('heroName' in payload) {
    heroName = validateHeroName(payload.heroName, options.allowedLegacyHeroName);
  } else if ('hero_name' in payload) {
    heroName = validateHeroName(payload.hero_name, options.allowedLegacyHeroName);
  } else if (options.requireHeroName) {
    throw new ValidationError('heroName is required');
  }

  for (const emailKey of ['ownerEmail', 'owner_email'] as const) {
    if (emailKey in payload && payload[emailKey] !== null && payload[emailKey] !== undefined) {
      const val = payload[emailKey];
      if (typeof val !== 'string' || val.length > 254 || hasControlChars(val)) {
        throw new ValidationError(`${emailKey} must be a valid string or null`);
      }
    }
  }

  const sanitizeDrafts = Boolean(options.sanitizeDrafts);
  const sanitized: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(payload)) {
    if (SERVER_MANAGED_SAVE_KEYS.has(key)) continue;

    if (SAVE_SCALAR_STRING_KEYS.has(key)) {
      if (val !== null && val !== undefined) {
        if (typeof val !== 'string' || val.length > MAX_SAVE_STRING_LEN || hasControlChars(val)) {
          throw new ValidationError(
            `${key} must be a string up to ${MAX_SAVE_STRING_LEN} characters without control characters`
          );
        }
      }
      sanitized[key] = val ?? null;
      continue;
    }

    if (SAVE_STRING_LIST_KEYS.has(key)) {
      if (val !== null && val !== undefined) {
        if (!Array.isArray(val)) {
          throw new ValidationError(`${key} must be a list of strings`);
        }
        if (val.length > MAX_SAVE_LIST_ITEMS) {
          throw new ValidationError(`${key} exceeds maximum item count (${MAX_SAVE_LIST_ITEMS})`);
        }
        for (const item of val) {
          if (typeof item !== 'string' || item.length > MAX_SAVE_STRING_LEN || hasControlChars(item)) {
            throw new ValidationError(
              `${key} items must be strings up to ${MAX_SAVE_STRING_LEN} characters without control characters`
            );
          }
        }
      }
      sanitized[key] = val ?? null;
      continue;
    }

    if (key === 'appearance') {
      if (val !== null && val !== undefined) {
        if (!isPlainObject(val)) {
          throw new ValidationError('appearance must be an object');
        }
        const entries = Object.entries(val);
        if (entries.length > MAX_APPEARANCE_KEYS) {
          throw new ValidationError(`appearance exceeds maximum key count (${MAX_APPEARANCE_KEYS})`);
        }
        for (const [ak, av] of entries) {
          if (ak.length > 64 || hasControlChars(ak)) {
            throw new ValidationError('Invalid appearance key');
          }
          if (
            av !== null &&
            typeof av !== 'string' &&
            typeof av !== 'boolean' &&
            typeof av !== 'number'
          ) {
            throw new ValidationError(`appearance.${ak} must be a scalar value or null`);
          }
          if (typeof av === 'number' && !Number.isFinite(av)) {
            throw new ValidationError(`appearance.${ak} must be a finite number`);
          }
          if (typeof av === 'string' && (av.length > MAX_SAVE_STRING_LEN || hasControlChars(av))) {
            throw new ValidationError(
              `appearance.${ak} must be a string up to ${MAX_SAVE_STRING_LEN} characters without control characters`
            );
          }
        }
      }
      sanitized[key] = val ?? null;
      continue;
    }

    if (key === 'stats') {
      if (val !== null && val !== undefined) {
        if (!isPlainObject(val)) {
          throw new ValidationError('stats must be an object');
        }
        const entries = Object.entries(val);
        if (entries.length > 32) {
          throw new ValidationError('stats exceeds maximum key count (32)');
        }
        for (const [sk, sv] of entries) {
          if (sk.length > 64 || hasControlChars(sk)) {
            throw new ValidationError('Invalid stats key');
          }
          if (STATS_STRING_LIST_KEYS.has(sk)) {
            if (sv !== null) {
              if (!Array.isArray(sv)) {
                throw new ValidationError(`stats.${sk} must be a list of strings or null`);
              }
              if (sv.length > MAX_SAVE_LIST_ITEMS) {
                throw new ValidationError(
                  `stats.${sk} exceeds maximum item count (${MAX_SAVE_LIST_ITEMS})`
                );
              }
              for (const item of sv) {
                if (typeof item !== 'string' || item.length > MAX_SAVE_STRING_LEN || hasControlChars(item)) {
                  throw new ValidationError(
                    `stats.${sk} items must be strings up to ${MAX_SAVE_STRING_LEN} characters without control characters`
                  );
                }
              }
            }
          } else if (sv !== null && (typeof sv !== 'number' || !Number.isFinite(sv))) {
            throw new ValidationError(`stats.${sk} must be a finite number or null`);
          }
        }
      }
      sanitized[key] = val ?? null;
      continue;
    }

    if (key === 'position') {
      if (val !== null && val !== undefined) {
        if (!isPlainObject(val)) {
          throw new ValidationError('position must be an object or null');
        }
        const entries = Object.entries(val);
        if (entries.length > 16) {
          throw new ValidationError('position exceeds maximum key count (16)');
        }
        for (const [pk, pv] of entries) {
          if (pk.length > 64 || hasControlChars(pk)) {
            throw new ValidationError('Invalid position key');
          }
          if (pv !== null) {
            if (typeof pv === 'boolean') {
              throw new ValidationError(`position.${pk} must be a string, number, or null`);
            }
            if (typeof pv === 'string') {
              if (pv.length > MAX_SAVE_STRING_LEN || hasControlChars(pv)) {
                throw new ValidationError(`position.${pk} must be a valid string`);
              }
            } else if (typeof pv !== 'number' || !Number.isFinite(pv)) {
              throw new ValidationError(`position.${pk} must be a finite number`);
            }
          }
        }
      }
      sanitized[key] = val ?? null;
      continue;
    }

    if (key === 'trialDrafts') {
      if (val !== null && val !== undefined) {
        if (!isPlainObject(val)) {
          if (sanitizeDrafts) {
            sanitized[key] = {};
            continue;
          }
          throw new ValidationError('trialDrafts must be an object');
        }
        const entries = Object.entries(val);
        if (!sanitizeDrafts && entries.length > MAX_TRIAL_DRAFTS) {
          throw new ValidationError(
            `trialDrafts exceeds maximum entry count (${MAX_TRIAL_DRAFTS})`
          );
        }
        const cleanedDrafts: Record<string, string> = {};
        for (const [dk, dv] of entries) {
          if (!dk.trim() || dk.length > MAX_TRIAL_ID_LEN || hasControlChars(dk)) {
            if (sanitizeDrafts) continue;
            throw new ValidationError('Invalid trialDrafts key');
          }
          if (typeof dv !== 'string') {
            if (sanitizeDrafts) continue;
            throw new ValidationError(`trialDrafts.${dk} must be a string`);
          }
          if (hasSurrogatesOrNul(dv)) {
            throw new ValidationError(
              `trialDrafts.${dk} must not contain NUL bytes or lone Unicode surrogates`
            );
          }
          let draftVal = dv;
          if (utf8ByteLength(draftVal) > MAX_ATTEMPT_CODE_BYTES) {
            if (sanitizeDrafts) {
              draftVal = truncateUtf8Bytes(draftVal, MAX_ATTEMPT_CODE_BYTES);
            } else {
              throw new ValidationError(
                `trialDrafts.${dk} exceeds maximum length (${MAX_ATTEMPT_CODE_BYTES} bytes)`,
                413
              );
            }
          }
          cleanedDrafts[dk] = draftVal;
        }
        const keys = Object.keys(cleanedDrafts);
        if (sanitizeDrafts && keys.length > MAX_TRIAL_DRAFTS) {
          const kept: Record<string, string> = {};
          for (const k of keys.slice(-MAX_TRIAL_DRAFTS)) {
            kept[k] = cleanedDrafts[k];
          }
          sanitized[key] = kept;
        } else {
          sanitized[key] = cleanedDrafts;
        }
      } else {
        sanitized[key] = null;
      }
      continue;
    }

    sanitized[key] = val;
  }

  return { sanitized, heroName };
}

export const MAX_ERROR_TYPE_LEN = 64;
export const MAX_DURATION_MS = 86_400_000;
const ERROR_TYPE_RE = /^[A-Za-z0-9_.:-]+$/;

export function validateAttemptPayload(body: Record<string, unknown>): {
  trialId: string;
  passed: boolean;
  hintsUsed: number;
  code: string;
  difficultyMode: DifficultyMode;
  isPractice: boolean;
  errorType: string | null;
  durationMs: number | null;
} {
  const rawTrialId = body.trialId !== undefined ? body.trialId : body.trial_id;
  if (typeof rawTrialId !== 'string' || hasControlChars(rawTrialId)) {
    throw new ValidationError('trialId is required and must be a valid string');
  }
  const trialId = rawTrialId.trim();
  if (!trialId || trialId.length > MAX_TRIAL_ID_LEN) {
    throw new ValidationError(`trialId must be between 1 and ${MAX_TRIAL_ID_LEN} characters`);
  }

  const passed = Boolean(body.passed);
  const rawHints = body.hintsUsed !== undefined ? body.hintsUsed : (body.hints_used ?? 0);
  let hintsNum: number;
  if (typeof rawHints === 'number') {
    if (!Number.isFinite(rawHints) || !Number.isInteger(rawHints)) {
      throw new ValidationError('hintsUsed must be an integer');
    }
    hintsNum = rawHints;
  } else if (typeof rawHints === 'string' && /^-?\d+$/.test(rawHints.trim())) {
    hintsNum = Number.parseInt(rawHints.trim(), 10);
  } else {
    throw new ValidationError('hintsUsed must be an integer');
  }

  const rawCode = body.code;
  let code = '';
  if (rawCode === null || rawCode === undefined) {
    code = '';
  } else if (typeof rawCode === 'string') {
    code = rawCode;
  } else {
    throw new ValidationError('code must be a string');
  }

  if (hasSurrogatesOrNul(code)) {
    throw new ValidationError('code must not contain NUL bytes or lone Unicode surrogates');
  }
  if (utf8ByteLength(code) > MAX_ATTEMPT_CODE_BYTES) {
    throw new ValidationError(
      `Attempt code exceeds maximum length (${MAX_ATTEMPT_CODE_BYTES} bytes)`,
      413
    );
  }

  const rawDifficulty =
    body.difficultyMode !== undefined ? body.difficultyMode : body.difficulty_mode;
  let difficultyMode: DifficultyMode = 'standard';
  if (rawDifficulty !== undefined && rawDifficulty !== null) {
    if (
      typeof rawDifficulty !== 'string' ||
      !VALID_DIFFICULTIES.has(rawDifficulty as DifficultyMode)
    ) {
      throw new ValidationError("difficultyMode must be 'explorer', 'standard', or 'challenge'");
    }
    difficultyMode = rawDifficulty as DifficultyMode;
  }

  const rawIsPractice = body.isPractice !== undefined ? body.isPractice : body.is_practice;
  let isPractice = false;
  if (rawIsPractice !== undefined && rawIsPractice !== null) {
    if (typeof rawIsPractice !== 'boolean') {
      throw new ValidationError('isPractice must be a boolean');
    }
    isPractice = rawIsPractice;
  }

  const rawErrorType = body.errorType !== undefined ? body.errorType : body.error_type;
  let errorType: string | null = null;
  if (rawErrorType !== undefined && rawErrorType !== null && rawErrorType !== '') {
    if (
      typeof rawErrorType !== 'string' ||
      rawErrorType.length > MAX_ERROR_TYPE_LEN ||
      !ERROR_TYPE_RE.test(rawErrorType)
    ) {
      throw new ValidationError(
        `errorType must be a string up to ${MAX_ERROR_TYPE_LEN} characters matching /^[A-Za-z0-9_.:-]+$/`
      );
    }
    errorType = rawErrorType;
  }
  if (passed) {
    errorType = null;
  }

  const rawDuration = body.durationMs !== undefined ? body.durationMs : body.duration_ms;
  let durationMs: number | null = null;
  if (rawDuration !== undefined && rawDuration !== null) {
    if (
      typeof rawDuration !== 'number' ||
      !Number.isFinite(rawDuration) ||
      !Number.isInteger(rawDuration) ||
      rawDuration < 0 ||
      rawDuration > MAX_DURATION_MS
    ) {
      throw new ValidationError(`durationMs must be an integer between 0 and ${MAX_DURATION_MS}`);
    }
    durationMs = rawDuration;
  }

  return {
    trialId,
    passed,
    hintsUsed: Math.max(0, Math.min(hintsNum, 1000)),
    code,
    difficultyMode,
    isPractice,
    errorType,
    durationMs,
  };
}

export function validatePreferences(body: Record<string, unknown>): SavePreferences {
  const prefs: SavePreferences = {};

  if ('difficulty' in body && body.difficulty !== null && body.difficulty !== undefined) {
    if (
      typeof body.difficulty !== 'string' ||
      !VALID_DIFFICULTIES.has(body.difficulty as DifficultyMode)
    ) {
      throw new ValidationError("difficulty must be 'explorer', 'standard', or 'challenge'");
    }
    prefs.difficulty = body.difficulty as DifficultyMode;
  }

  if (
    'showRawTracebacks' in body &&
    body.showRawTracebacks !== null &&
    body.showRawTracebacks !== undefined
  ) {
    if (typeof body.showRawTracebacks !== 'boolean') {
      throw new ValidationError('showRawTracebacks must be a boolean');
    }
    prefs.showRawTracebacks = body.showRawTracebacks;
  }

  if ('maxPipHints' in body && body.maxPipHints !== null && body.maxPipHints !== undefined) {
    if (
      typeof body.maxPipHints !== 'number' ||
      !Number.isInteger(body.maxPipHints) ||
      body.maxPipHints < 0 ||
      body.maxPipHints > 10
    ) {
      throw new ValidationError('maxPipHints must be an integer between 0 and 10');
    }
    prefs.maxPipHints = body.maxPipHints;
  }

  return prefs;
}

async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ValidationError(`Request body exceeds limit (${maxBytes} bytes)`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readJsonBody(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
  options?: { allowEmpty?: boolean }
): Promise<Record<string, unknown>> {
  const contentType = (request.headers.get('Content-Type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  if (options?.allowEmpty && !contentType) {
    const bytes = await readBoundedBytes(request, maxBytes);
    if (bytes.byteLength === 0) return {};
    throw new ValidationError('Content-Type must be application/json', 415);
  }

  if (contentType !== 'application/json') {
    throw new ValidationError('Content-Type must be application/json', 415);
  }

  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader);
    if (!Number.isInteger(declared) || declared < 0) {
      throw new ValidationError('Invalid Content-Length header', 400);
    }
    if (declared > maxBytes) {
      throw new ValidationError(`Request body exceeds limit (${maxBytes} bytes)`, 413);
    }
  }

  const bytes = await readBoundedBytes(request, maxBytes);
  if (bytes.byteLength === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(
      `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      400
    );
  }

  if (!isPlainObject(parsed)) {
    throw new ValidationError('JSON body must be an object', 400);
  }
  return parsed;
}
