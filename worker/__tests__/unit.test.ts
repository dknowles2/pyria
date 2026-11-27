import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  clearCookie,
  generateHeroCode,
  hashHeroCode,
  isHttpsRequest,
  normalizeHeroCode,
  parseCookies,
  serializeCookie,
  signToken,
  verifyToken,
} from '../crypto';
import { checkRateLimit, getClientIp, normalizeIpForRateLimit } from '../rateLimit';
import {
  cacheControlForPath,
  checkSameOrigin,
  normalizePathname,
  safeDecodeSegment,
  sanitizeNextPath,
} from '../security';
import {
  MAX_APPEARANCE_KEYS,
  MAX_ATTEMPT_CODE_BYTES,
  MAX_BYTE_SHARDS,
  MAX_SAVE_LIST_ITEMS,
  MAX_TRIAL_DRAFTS,
  ValidationError,
  coerceByteShards,
  hasControlChars,
  hasSurrogatesOrNul,
  normalizeEmail,
  readJsonBody,
  truncateUtf8Bytes,
  utf8ByteLength,
  validateAttemptPayload,
  validateHeroName,
  validatePreferences,
  validateSavePayload,
} from '../validation';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM rate_limits').run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker/validation.ts unit tests', () => {
  it('truncates UTF-8 strings cleanly on multi-byte character boundaries', () => {
    const ascii = 'abcdef';
    expect(truncateUtf8Bytes(ascii, 10)).toBe('abcdef');
    expect(truncateUtf8Bytes(ascii, 3)).toBe('abc');

    // 4-byte emoji: each '🐉' is 4 UTF-8 bytes
    const dragons = '🐉🐉🐉';
    expect(utf8ByteLength(dragons)).toBe(12);
    // Truncating at 5, 6, 7 bytes must walk back to 4 bytes (1 dragon), never U+FFFD
    for (const cap of [4, 5, 6, 7]) {
      const cut = truncateUtf8Bytes(dragons, cap);
      expect(cut).toBe('🐉');
      expect(cut).not.toContain('\uFFFD');
      expect(utf8ByteLength(cut)).toBeLessThanOrEqual(cap);
    }
    expect(truncateUtf8Bytes(dragons, 2)).toBe('');
  });

  it('detects NUL bytes, lone surrogates, and control chars while allowing valid emoji + ZWJ', () => {
    expect(hasSurrogatesOrNul('plain text')).toBe(false);
    expect(hasSurrogatesOrNul('Hero👩‍💻')).toBe(false);
    expect(hasSurrogatesOrNul('abc\0def')).toBe(true);
    expect(hasSurrogatesOrNul('bad\uD800end')).toBe(true); // lone high surrogate
    expect(hasSurrogatesOrNul('bad\uDC00end')).toBe(true); // lone low surrogate
    expect(hasSurrogatesOrNul('\uD800')).toBe(true); // trailing lone high surrogate

    expect(hasControlChars('Rowan 👩‍💻')).toBe(false);
    expect(hasControlChars('tab\there')).toBe(true);
    expect(hasControlChars('del\x7fchar')).toBe(true);
    expect(hasControlChars('c1\u0085char')).toBe(true);
    expect(hasControlChars('line\u2028sep')).toBe(true);
    expect(hasControlChars('bidi\u202Eoverride')).toBe(true);
  });

  it('coerces byteShards safely across edge types and bounds', () => {
    expect(coerceByteShards(42)).toBe(42);
    expect(coerceByteShards('99.9')).toBe(99);
    expect(coerceByteShards(-50)).toBe(0);
    expect(coerceByteShards(MAX_BYTE_SHARDS + 999)).toBe(MAX_BYTE_SHARDS);
    expect(coerceByteShards(true, 7)).toBe(7);
    expect(coerceByteShards(null, 5)).toBe(5);
    expect(coerceByteShards(undefined, 5)).toBe(5);
    expect(coerceByteShards(Number.NaN, 3)).toBe(3);
    expect(coerceByteShards(Number.POSITIVE_INFINITY, 3)).toBe(3);
    expect(coerceByteShards('not-a-number', -10)).toBe(0);
  });

  it('normalizes emails and validates heroName rules + legacy bypass', () => {
    expect(normalizeEmail('  Parent@Example.COM ')).toBe('parent@example.com');
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(123)).toBeNull();

    expect(validateHeroName('  Nova  ')).toBe('Nova');
    expect(() => validateHeroName(42)).toThrow(ValidationError);
    expect(() => validateHeroName('X')).toThrow(ValidationError);
    expect(() => validateHeroName('A'.repeat(25))).toThrow(ValidationError);
    expect(() => validateHeroName('Bad\rName')).toThrow(ValidationError);
    // Legacy name bypass allows existing non-conforming name to survive untouched
    expect(validateHeroName('X', 'X')).toBe('X');
  });

  it('validates save payload allowlist, scalar/list fields, appearance, stats, position, and trialDrafts', () => {
    // >8 unknown keys truncates preview with (+N more)
    const manyUnknown: Record<string, unknown> = { heroName: 'Rowan' };
    for (let i = 0; i < 10; i += 1) manyUnknown[`extra_${i}`] = i;
    expect(() => validateSavePayload(manyUnknown, { requireHeroName: true })).toThrow(/\+2 more/);

    // Missing required heroName vs hero_name alias
    expect(() => validateSavePayload({}, { requireHeroName: true })).toThrow('heroName is required');
    const alias = validateSavePayload({ hero_name: 'Pippin' }, { requireHeroName: true });
    expect(alias.heroName).toBe('Pippin');

    // Invalid ownerEmail
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', ownerEmail: 123 }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', ownerEmail: 'a'.repeat(255) }, { requireHeroName: true })
    ).toThrow(ValidationError);

    // Scalar string keys
    expect(
      validateSavePayload({ heroName: 'Rowan', eraId: null, realmId: 'realm-01' }, { requireHeroName: true })
        .sanitized.realmId
    ).toBe('realm-01');
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', eraId: 99 }, { requireHeroName: true })
    ).toThrow(ValidationError);

    // String list keys
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', solvedTrials: 'not-array' }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload(
        { heroName: 'Rowan', solvedTrials: Array.from({ length: MAX_SAVE_LIST_ITEMS + 1 }, () => 't') },
        { requireHeroName: true }
      )
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', solvedTrials: [123] }, { requireHeroName: true })
    ).toThrow(ValidationError);

    // Appearance
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', appearance: [] }, { requireHeroName: true })
    ).toThrow(ValidationError);
    const tooManyApp: Record<string, string> = {};
    for (let i = 0; i <= MAX_APPEARANCE_KEYS; i += 1) tooManyApp[`k${i}`] = 'v';
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', appearance: tooManyApp }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', appearance: { ['bad\nkey']: 'x' } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', appearance: { nested: {} } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', appearance: { scale: Number.NaN } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', appearance: { hair: 'bad\x00val' } }, { requireHeroName: true })
    ).toThrow(ValidationError);

    // Stats
    const validStats = validateSavePayload(
      {
        heroName: 'Rowan',
        stats: {
          charisma: 2,
          courage: 3,
          arrows: 10,
          potions: 1,
          customItems: ['Flame Blade (Power 5)'],
          completedWorkshopChallenges: ['ws-chal-01'],
        },
      },
      { requireHeroName: true }
    );
    expect(validStats.sanitized.stats).toEqual({
      charisma: 2,
      courage: 3,
      arrows: 10,
      potions: 1,
      customItems: ['Flame Blade (Power 5)'],
      completedWorkshopChallenges: ['ws-chal-01'],
    });
    expect(() =>
      validateSavePayload(
        { heroName: 'Rowan', stats: { customItems: null, completedWorkshopChallenges: null } },
        { requireHeroName: true }
      )
    ).not.toThrow();
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', stats: 'bad' }, { requireHeroName: true })
    ).toThrow(ValidationError);
    const tooManyStats: Record<string, number> = {};
    for (let i = 0; i < 33; i += 1) tooManyStats[`s${i}`] = i;
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', stats: tooManyStats }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', stats: { ['bad\tkey']: 1 } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', stats: { power: '99' } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', stats: { customItems: 'not-a-list' } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', stats: { customItems: [123] } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', stats: { customItems: ['bad\x00item'] } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload(
        { heroName: 'Rowan', stats: { customItems: new Array(1001).fill('x') } },
        { requireHeroName: true }
      )
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload(
        { heroName: 'Rowan', stats: { completedWorkshopChallenges: 42 } },
        { requireHeroName: true }
      )
    ).toThrow(ValidationError);

    // Position
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', position: [] }, { requireHeroName: true })
    ).toThrow(ValidationError);
    const tooManyPos: Record<string, number> = {};
    for (let i = 0; i < 17; i += 1) tooManyPos[`p${i}`] = i;
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', position: tooManyPos }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', position: { ['bad\n']: 1 } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', position: { flying: true } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', position: { dir: 'bad\0' } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', position: { x: Number.POSITIVE_INFINITY } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(
      validateSavePayload(
        { heroName: 'Rowan', position: { x: 10, y: 20, facing: 'north' } },
        { requireHeroName: true }
      ).sanitized.position
    ).toEqual({ x: 10, y: 20, facing: 'north' });

    // trialDrafts strict vs sanitizeDrafts
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', trialDrafts: 'nope' }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(
      validateSavePayload(
        { heroName: 'Rowan', trialDrafts: 'nope' },
        { requireHeroName: true, sanitizeDrafts: true }
      ).sanitized.trialDrafts
    ).toEqual({});

    const manyDrafts: Record<string, string> = {};
    for (let i = 0; i < MAX_TRIAL_DRAFTS + 5; i += 1) manyDrafts[`t-${i}`] = 'pass';
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', trialDrafts: manyDrafts }, { requireHeroName: true })
    ).toThrow(ValidationError);
    const trimmedDrafts = validateSavePayload(
      { heroName: 'Rowan', trialDrafts: manyDrafts },
      { requireHeroName: true, sanitizeDrafts: true }
    ).sanitized.trialDrafts as Record<string, string>;
    expect(Object.keys(trimmedDrafts).length).toBe(MAX_TRIAL_DRAFTS);

    expect(() =>
      validateSavePayload({ heroName: 'Rowan', trialDrafts: { '  ': 'x' } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', trialDrafts: { t1: 123 } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    expect(() =>
      validateSavePayload({ heroName: 'Rowan', trialDrafts: { t1: 'bad\0code' } }, { requireHeroName: true })
    ).toThrow(ValidationError);
    let oversizedErr: unknown;
    try {
      validateSavePayload(
        { heroName: 'Rowan', trialDrafts: { t1: 'a'.repeat(MAX_ATTEMPT_CODE_BYTES + 1) } },
        { requireHeroName: true }
      );
    } catch (err) {
      oversizedErr = err;
    }
    expect(oversizedErr).toBeInstanceOf(ValidationError);
    expect((oversizedErr as ValidationError).status).toBe(413);

    // sanitizeDrafts truncates oversized drafts and still rejects NUL/lone surrogates
    const truncatedDrafts = validateSavePayload(
      { heroName: 'Rowan', trialDrafts: { t1: 'a'.repeat(MAX_ATTEMPT_CODE_BYTES + 100) } },
      { requireHeroName: true, sanitizeDrafts: true }
    ).sanitized.trialDrafts as Record<string, string>;
    expect(truncatedDrafts.t1.length).toBe(MAX_ATTEMPT_CODE_BYTES);
    expect(() =>
      validateSavePayload(
        { heroName: 'Rowan', trialDrafts: { t1: 'bad\0code' } },
        { requireHeroName: true, sanitizeDrafts: true }
      )
    ).toThrow(ValidationError);

    // sanitizeDrafts silently skips bad keys/non-string values
    const cleaned = validateSavePayload(
      { heroName: 'Rowan', trialDrafts: { '  ': 'x', t1: 123, t2: 'ok' } },
      { requireHeroName: true, sanitizeDrafts: true }
    ).sanitized.trialDrafts;
    expect(cleaned).toEqual({ t2: 'ok' });
  });

  it('validates attempt payloads and preferences across all branches', () => {
    const snake = validateAttemptPayload({
      trial_id: '  trial-01  ',
      passed: 1,
      hints_used: '3',
      code: null,
    });
    expect(snake).toEqual({
      trialId: 'trial-01',
      passed: true,
      hintsUsed: 3,
      code: '',
      difficultyMode: 'standard',
      isPractice: false,
      errorType: null,
      durationMs: null,
    });

    // Clamping negative and >1000 hintsUsed
    expect(validateAttemptPayload({ trialId: 't1', hintsUsed: -5 }).hintsUsed).toBe(0);
    expect(validateAttemptPayload({ trialId: 't1', hintsUsed: 5000 }).hintsUsed).toBe(1000);

    expect(() => validateAttemptPayload({ trialId: '' })).toThrow(ValidationError);
    expect(() => validateAttemptPayload({ trialId: 't1', hintsUsed: 1.5 })).toThrow(ValidationError);
    expect(() => validateAttemptPayload({ trialId: 't1', code: 123 })).toThrow(ValidationError);
    expect(() => validateAttemptPayload({ trialId: 't1', code: 'x\0y' })).toThrow(ValidationError);

    // Preferences
    expect(validatePreferences({ difficulty: 'standard', showRawTracebacks: true, maxPipHints: 0 })).toEqual({
      difficulty: 'standard',
      showRawTracebacks: true,
      maxPipHints: 0,
    });
    expect(() => validatePreferences({ difficulty: 'nightmare' })).toThrow(ValidationError);
    expect(() => validatePreferences({ showRawTracebacks: 'yes' })).toThrow(ValidationError);
    expect(() => validatePreferences({ maxPipHints: -1 })).toThrow(ValidationError);
    expect(() => validatePreferences({ maxPipHints: 11 })).toThrow(ValidationError);
    expect(() => validatePreferences({ maxPipHints: 2.5 })).toThrow(ValidationError);
  });

  it('enforces readJsonBody content-type, size limits, allowEmpty, and strict object parsing', async () => {
    // allowEmpty with no Content-Type and empty body
    const emptyReq = new Request('https://pyria.test/api/test', { method: 'POST' });
    expect(await readJsonBody(emptyReq, 1024, { allowEmpty: true })).toEqual({});

    // allowEmpty with non-empty body and missing Content-Type -> 415
    const nonEmptyNoCt = new Request('https://pyria.test/api/test', {
      method: 'POST',
      body: 'hello',
    });
    await expect(readJsonBody(nonEmptyNoCt, 1024, { allowEmpty: true })).rejects.toMatchObject({
      status: 415,
    });

    // Wrong Content-Type -> 415
    const wrongCt = new Request('https://pyria.test/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    await expect(readJsonBody(wrongCt, 1024)).rejects.toMatchObject({ status: 415 });

    // Invalid Content-Length -> 400
    const badCl = new Request('https://pyria.test/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '-5' },
      body: '{}',
    });
    await expect(readJsonBody(badCl, 1024)).rejects.toMatchObject({ status: 400 });

    // Oversized Content-Length -> 413
    const hugeCl = new Request('https://pyria.test/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' },
      body: '{}',
    });
    await expect(readJsonBody(hugeCl, 1024)).rejects.toMatchObject({ status: 413 });

    // Streaming body exceeding limit without Content-Length -> 413
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":"' + 'x'.repeat(200) + '"}'));
        controller.close();
      },
    });
    const streamReq = new Request('https://pyria.test/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stream,
    });
    await expect(readJsonBody(streamReq, 64)).rejects.toMatchObject({ status: 413 });

    // Empty body with application/json -> {}
    const emptyJson = new Request('https://pyria.test/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    expect(await readJsonBody(emptyJson, 1024)).toEqual({});

    // Malformed JSON -> 400
    const badJson = new Request('https://pyria.test/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
    await expect(readJsonBody(badJson, 1024)).rejects.toMatchObject({ status: 400 });

    // JSON array instead of object -> 400
    const arrJson = new Request('https://pyria.test/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[1,2,3]',
    });
    await expect(readJsonBody(arrJson, 1024)).rejects.toMatchObject({ status: 400 });
  });
});

describe('worker/crypto.ts unit tests', () => {
  it('handles base64url encoding/decoding and token verification edge cases', async () => {
    const raw = new Uint8Array([0, 1, 254, 255]);
    const enc = base64UrlEncode(raw);
    expect(base64UrlDecode(enc)).toEqual(raw);
    expect(base64UrlDecode('')).toBeNull();
    expect(base64UrlDecode('invalid+chars/')).toBeNull();
    expect(base64UrlDecode('a')).toBeNull(); // invalid base64 length

    const secret = 'unit-test-secret-0123456789abcdef';
    const futureExp = Math.floor(Date.now() / 1000) + 300;
    const valid = await signToken({ typ: 'parent', email: 'a@b.com', exp: futureExp }, secret);

    // Valid token succeeds with matching expectedTyp and rejects wrong expectedTyp
    expect(await verifyToken(valid, secret, 'parent')).toEqual({
      typ: 'parent',
      email: 'a@b.com',
      exp: futureExp,
    });
    expect(await verifyToken(valid, secret, 'hero')).toBeNull();

    expect(await verifyToken(undefined, secret, 'parent')).toBeNull();
    expect(await verifyToken(valid, '', 'parent')).toBeNull();
    expect(await verifyToken('nodot', secret, 'parent')).toBeNull();
    expect(await verifyToken('a.b.c', secret, 'parent')).toBeNull();
    expect(await verifyToken(`${valid.split('.')[0]}.short`, secret, 'parent')).toBeNull();
    expect(await verifyToken(valid, 'wrong-secret', 'parent')).toBeNull();

    // Expired token rejected
    const expired = await signToken(
      { typ: 'parent', email: 'a@b.com', exp: Math.floor(Date.now() / 1000) - 10 },
      secret
    );
    expect(await verifyToken(expired, secret, 'parent')).toBeNull();

    // Non-object payload / missing exp rejected
    const badPayload = await signToken({ typ: 'parent', exp: 'not-a-number' }, secret);
    expect(await verifyToken(badPayload, secret, 'parent')).toBeNull();
  });

  it('parses cookies, detects HTTPS, serializes cookies, and normalizes/hashes Hero Codes', async () => {
    const req = new Request('http://pyria.test/', {
      headers: {
        Cookie: '  foo=bar; malformed; baz=qux=1 ; =empty ',
        'X-Forwarded-Proto': 'https, http',
      },
    });
    expect(parseCookies(req)).toEqual({ foo: 'bar', baz: 'qux=1' });
    expect(isHttpsRequest(req)).toBe(true);
    expect(isHttpsRequest(new Request('http://pyria.test/'))).toBe(false);

    const cookie = serializeCookie('sid', 'abc', {
      maxAge: -5,
      path: '/app',
      httpOnly: false,
      sameSite: 'Strict',
      secure: false,
    });
    expect(cookie).toBe('sid=abc; Path=/app; Max-Age=0; SameSite=Strict');
    expect(clearCookie('sid', true, '/x')).toBe(
      'sid=; Path=/x; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
    );

    const code = generateHeroCode();
    expect(code).toMatch(/^[A-Z]+-[A-Z]+-\d{6}$/);
    expect(normalizeHeroCode('  amber_dragon—123456 ')).toBe('AMBER-DRAGON-123456');
    const h1 = await hashHeroCode('AMBER-DRAGON-123456', 'secret');
    const h2 = await hashHeroCode('AMBER-DRAGON-123456', 'secret');
    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
  });
});

describe('worker/rateLimit.ts unit tests', () => {
  it('normalizes IPv4, IPv6, IPv4-mapped IPv6, zone IDs, and malformed inputs', () => {
    expect(normalizeIpForRateLimit('')).toBe('127.0.0.1');
    expect(normalizeIpForRateLimit(' 203.0.113.5 ')).toBe('203.0.113.5');
    expect(normalizeIpForRateLimit('[2001:db8:1:2::99]')).toBe('2001:0db8:0001:0002::/64');
    expect(normalizeIpForRateLimit('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
    expect(normalizeIpForRateLimit('::ffff:192.0.2.1')).toBe('0000:0000:0000:0000::/64');
    expect(normalizeIpForRateLimit('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(normalizeIpForRateLimit('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(normalizeIpForRateLimit('1:2:3')).toBe('1:2:3');

    expect(
      getClientIp(
        new Request('https://pyria.test/', {
          headers: { 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '198.51.100.2, 10.0.0.1' },
        })
      )
    ).toBe('203.0.113.9');
    expect(
      getClientIp(new Request('https://pyria.test/', { headers: { 'X-Forwarded-For': '198.51.100.2, 10.0.0.1' } }))
    ).toBe('198.51.100.2');
    expect(getClientIp(new Request('https://pyria.test/'))).toBe('127.0.0.1');
  });

  it('resets rate-limit bucket once window expires and prunes stale rows deterministically', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldStart = now - 600;
    const staleStart = now - 100_000; // >24h old
    await env.DB.batch([
      env.DB.prepare('INSERT INTO rate_limits (bucket_key, count, window_start) VALUES (?, ?, ?)').bind(
        'test:expired',
        99,
        oldStart
      ),
      env.DB.prepare('INSERT INTO rate_limits (bucket_key, count, window_start) VALUES (?, ?, ?)').bind(
        'test:stale-old',
        5,
        staleStart
      ),
    ]);

    // Deterministically trigger stale-row pruning path
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const r1 = await checkRateLimit(env.DB, 'test:expired', 2, 60);
    expect(r1).toEqual({ allowed: true, retryAfterSeconds: 0 });
    const r2 = await checkRateLimit(env.DB, 'test:expired', 2, 60);
    expect(r2).toEqual({ allowed: true, retryAfterSeconds: 0 });
    const r3 = await checkRateLimit(env.DB, 'test:expired', 2, 60);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);

    const staleRow = await env.DB.prepare(
      'SELECT bucket_key FROM rate_limits WHERE bucket_key = ?'
    )
      .bind('test:stale-old')
      .first();
    expect(staleRow).toBeNull();
  });
});

describe('worker/security.ts unit tests', () => {
  it('computes Cache-Control headers for all asset types', () => {
    expect(cacheControlForPath('/api/me')).toBe('no-store');
    expect(cacheControlForPath('/assets/hero.PNG')).toBe('public, max-age=86400');
    expect(cacheControlForPath('/js/main.js')).toBe('public, max-age=300');
    expect(cacheControlForPath('/content/game.json')).toBe('public, max-age=300');
    expect(cacheControlForPath('/index.html')).toBe('public, max-age=60');
  });

  it('enforces checkSameOrigin with default ports, malformed origins, and non-HTTP schemes', () => {
    expect(
      checkSameOrigin(
        new Request('https://pyria.test/api/saves', {
          method: 'POST',
          headers: { Origin: 'https://pyria.test:443', 'Sec-Fetch-Site': 'same-origin' },
        })
      )
    ).toBeNull();
    expect(
      checkSameOrigin(
        new Request('http://pyria.test/api/saves', {
          method: 'POST',
          headers: { Origin: 'http://pyria.test:80' },
        })
      )
    ).toBeNull();
    expect(
      checkSameOrigin(
        new Request('https://pyria.test/api/saves', {
          method: 'POST',
          headers: { Origin: 'not a url' },
        })
      )?.status
    ).toBe(403);
    expect(
      checkSameOrigin(
        new Request('https://pyria.test/api/saves', {
          method: 'POST',
          headers: { Origin: 'ftp://pyria.test' },
        })
      )?.status
    ).toBe(403);
  });

  it('normalizes pathnames safely and blocks traversal, NUL, backslash, and open redirects', () => {
    expect(safeDecodeSegment('hello%20world')).toBe('hello world');
    expect(safeDecodeSegment('%E0%A4%A')).toBeNull();

    expect(normalizePathname('/a//b/c')).toBe('/a/b/c');
    expect(normalizePathname('/%ZZ')).toBeNull();
    expect(normalizePathname('/a%00b')).toBeNull();
    expect(normalizePathname('/a%5cb')).toBeNull();
    expect(normalizePathname('/a/../b')).toBeNull();

    expect(sanitizeNextPath(null)).toBe('/console');
    expect(sanitizeNextPath('https://evil.com')).toBe('/console');
    expect(sanitizeNextPath('//evil.com')).toBe('/console');
    expect(sanitizeNextPath('/\\evil.com')).toBe('/console');
    expect(sanitizeNextPath('/ok\nheader')).toBe('/console');
    expect(sanitizeNextPath('/console?tab=progress#top')).toBe('/console?tab=progress#top');
  });
});
