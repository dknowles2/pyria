import { generateUniqueHeroCodeHash, getSessionSecret, signHeroPlayToken } from './auth';
import { HERO_PLAY_TTL_SECONDS, hashHeroCode, normalizeHeroCode, verifyToken } from './crypto';
import { PyriaD1 } from './db';
import {
  buildDigestForParent,
  createUnsubscribeToken,
  escapeHtml,
  getDigestBaseUrl,
  renderWeeklyDigestEmail,
  verifyUnsubscribeToken,
} from './digest';
import { createEmailSender, getEmailFrom } from './email';
import {
  checkGlobalHeroCodeThrottle,
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
  recordHeroCodeFailure,
} from './rateLimit';
import { applySecurityHeaders, checkSameOrigin, jsonResponse, safeDecodeSegment } from './security';
import type { AuthContext, Env, ParentLinkTokenPayload, SavePreferences } from './types';
import {
  MAX_SAVE_BODY_BYTES,
  MAX_TRIAL_ID_LEN,
  QuotaError,
  ValidationError,
  hasControlChars,
  normalizeEmail,
  readJsonBody,
  validatePreferences,
} from './validation';

const DEFAULT_CLAIM_LIMIT = 15;
const DEFAULT_CLAIM_WINDOW_SEC = 300; // 5 minutes
const DEFAULT_GLOBAL_FAIL_LIMIT = 200;
const DEFAULT_GLOBAL_FAIL_WINDOW_SEC = 300; // 5 minutes

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

async function findTrialShardReward(
  env: Env,
  requestUrl: string,
  trialId: string
): Promise<number> {
  const game = await loadJsonAsset<{ eraOrder?: string[] }>(env, requestUrl, '/content/game.json');
  const eraIds = game?.eraOrder ?? [
    'era-01-8bit',
    'era-02-16bit',
    'era-03-32bit',
    'era-04-64bit',
  ];

  for (const eraId of eraIds) {
    const era = await loadJsonAsset<{
      realms?: Array<{ trials?: Array<{ id?: string; shardReward?: number }> }>;
    }>(env, requestUrl, `/content/eras/${encodeURIComponent(eraId)}.json`);
    if (!era?.realms) continue;
    for (const realm of era.realms) {
      for (const trial of realm.trials ?? []) {
        if (trial.id === trialId) {
          const reward = Number(trial.shardReward ?? 0);
          return Number.isFinite(reward) && reward > 0 ? Math.trunc(reward) : 0;
        }
      }
    }
  }
  return 0;
}

function requireParent(auth: AuthContext): Response | null {
  if (!auth.parentEmail) {
    return jsonResponse({ error: 'Parent authentication required' }, 403);
  }
  return null;
}

async function requireParentOwnsSave(
  db: PyriaD1,
  auth: AuthContext,
  saveId: string
): Promise<Response | null> {
  const row = await db.getSaveRow(saveId);
  if (!row) {
    return jsonResponse({ error: 'Save not found' }, 404);
  }
  if (auth.isAdmin) return null;
  const owner = normalizeEmail(row.owner_email);
  if (!owner || owner !== auth.parentEmail) {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }
  return null;
}

export async function handleConsoleRequest(
  request: Request,
  env: Env,
  db: PyriaD1,
  auth: AuthContext,
  url: URL
): Promise<Response> {
  const parentErr = requireParent(auth);
  if (parentErr) return parentErr;

  const method = request.method.toUpperCase();
  const pathname = url.pathname;
  const parts = pathname.split('/').filter(Boolean);

  // GET /api/console/preferences
  if (method === 'GET' && pathname === '/api/console/preferences') {
    const preferences = await db.getParentPreferences(auth.parentEmail!);
    return jsonResponse({
      preferences,
      notice:
        'Weekly progress emails are sent on Sunday evenings only when a linked hero solves a trial or reaches a new milestone.',
    });
  }

  // PUT /api/console/preferences
  if (method === 'PUT' && pathname === '/api/console/preferences') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request, 4096);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonResponse({ error: err.message }, err.status);
      }
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    if (typeof body.weeklyDigestEnabled !== 'boolean') {
      return jsonResponse({ error: 'weeklyDigestEnabled must be a boolean' }, 400);
    }

    const preferences = await db.setParentPreferences(auth.parentEmail!, body.weeklyDigestEnabled);
    return jsonResponse({ preferences });
  }

  // GET /api/console/progress
  if (method === 'GET' && pathname === '/api/console/progress') {
    const requestedOwner = url.searchParams.get('owner');
    const ownerFilter = auth.isAdmin ? (requestedOwner || 'all') : auth.parentEmail!;
    const snapshot = await db.getProgressSnapshot({
      ownerFilter,
      extraAccount: auth.parentEmail,
      includeAllAccounts: auth.isAdmin,
    });
    const game = await loadJsonAsset<{ globalDifficultyOverride?: Record<string, unknown> }>(
      env,
      request.url,
      '/content/game.json'
    );
    return jsonResponse({
      ...snapshot,
      globalDifficultyOverride: game?.globalDifficultyOverride ?? {},
    });
  }

  // GET /api/console/activity?since=<id>&limit=<n>
  if (method === 'GET' && pathname === '/api/console/activity') {
    const sinceRaw = Number.parseInt(url.searchParams.get('since') || '0', 10);
    const limitRaw = Number.parseInt(url.searchParams.get('limit') || '50', 10);
    const sinceId = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;
    const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? limitRaw : 50;

    const requestedOwner = url.searchParams.get('owner');
    let ownerFilter: string | null;
    if (auth.isAdmin) {
      ownerFilter =
        requestedOwner && requestedOwner.toLowerCase() !== 'all'
          ? normalizeEmail(requestedOwner)
          : null;
    } else {
      ownerFilter = auth.parentEmail!;
    }

    const { events, latestId } = await db.getActivitySince(sinceId, limit, ownerFilter);
    return jsonResponse({ events, latestId });
  }

  // POST /api/console/heroes
  if (method === 'POST' && pathname === '/api/console/heroes') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request, MAX_SAVE_BODY_BYTES);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonResponse({ error: err.message }, err.status);
      }
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    let preferences: SavePreferences = {};
    if (body.preferences !== undefined && body.preferences !== null) {
      if (typeof body.preferences !== 'object' || Array.isArray(body.preferences)) {
        return jsonResponse({ error: 'preferences must be an object' }, 400);
      }
      try {
        preferences = validatePreferences(body.preferences as Record<string, unknown>);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid preferences' }, 400);
      }
    }

    const savePayload: Record<string, unknown> = {
      heroName: body.heroName,
      eraId: 'era-01-8bit',
      realmId: 'realm-01-meadow',
      visualEra: '8bit',
      byteShards: 0,
      stats: { charisma: 0, courage: 0 },
      solvedTrials: [],
      completedTrials: [],
      trialDrafts: {},
      seenCutscenes: [],
      foundEasterEggs: [],
      unlockedSpells: [],
      rescuedDragons: [],
      openedChests: [],
      ownedUnlockIds: [],
      position: null,
    };
    if (body.appearance !== undefined) {
      savePayload.appearance = body.appearance;
    }

    const secret = getSessionSecret(env);
    try {
      const { heroCode, hash } = await generateUniqueHeroCodeHash(db, secret);
      const save = await db.createSave(savePayload, {
        ownerEmail: auth.parentEmail!,
        recoveryCodeHash: hash,
        preferences,
      });
      const playToken = await signHeroPlayToken(save.id, 1, secret);
      const parentPrefs = await db.getParentPreferences(auth.parentEmail!);
      return jsonResponse(
        {
          save,
          heroCode,
          playToken,
          playTokenExpiresInSeconds: HERO_PLAY_TTL_SECONDS,
          weeklyDigestEnabled: parentPrefs.weeklyDigestEnabled,
          weeklyDigestNotice: parentPrefs.weeklyDigestEnabled
            ? `Weekly progress emails are enabled for ${auth.parentEmail!}. You will only receive an email when your hero makes progress, and you can turn them off anytime in Parent Console preferences.`
            : 'Weekly progress emails are currently paused. You can re-enable them anytime in Parent Console preferences.',
        },
        201
      );
    } catch (err) {
      if (err instanceof ValidationError || err instanceof QuotaError) {
        return jsonResponse({ error: err.message }, err.status);
      }
      throw err;
    }
  }

  // POST /api/console/link-preview
  if (method === 'POST' && pathname === '/api/console/link-preview') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request, 8192);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonResponse({ error: err.message }, err.status);
      }
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    const rawLinkToken = typeof body.linkToken === 'string' ? body.linkToken.trim() : '';
    if (!rawLinkToken) {
      return jsonResponse({ error: 'linkToken is required' }, 400);
    }

    const secret = getSessionSecret(env);
    const payload = await verifyToken<ParentLinkTokenPayload>(rawLinkToken, secret, 'parent_link');
    if (!payload || typeof payload.saveId !== 'string') {
      return jsonResponse({ error: 'This parent link has expired or is invalid' }, 404);
    }

    const row = await db.getSaveRow(payload.saveId);
    if (!row) {
      return jsonResponse({ error: 'This parent link has expired or is invalid' }, 404);
    }

    const existingOwner = normalizeEmail(row.owner_email);
    if (existingOwner && existingOwner !== auth.parentEmail) {
      return jsonResponse({ error: 'This hero is already linked to another parent account' }, 404);
    }

    return jsonResponse({
      saveId: row.id,
      heroName: row.hero_name,
      alreadyOwnedBySelf: existingOwner === auth.parentEmail,
    });
  }

  // POST /api/console/claim-hero
  if (method === 'POST' && pathname === '/api/console/claim-hero') {
    const claimLimit =
      Number.parseInt(env.PYRIA_RATE_LIMIT_CLAIM || '', 10) || DEFAULT_CLAIM_LIMIT;
    const globalFailLimit =
      Number.parseInt(env.PYRIA_RATE_LIMIT_GLOBAL_FAIL || '', 10) || DEFAULT_GLOBAL_FAIL_LIMIT;
    const ip = getClientIp(request);

    // Pre-lookup global failure throttle for IPs with prior recent misses
    const globalThrottle = await checkGlobalHeroCodeThrottle(
      env.DB,
      ip,
      globalFailLimit,
      DEFAULT_GLOBAL_FAIL_WINDOW_SEC
    );
    if (!globalThrottle.allowed) {
      return rateLimitExceededResponse(globalThrottle.retryAfterSeconds);
    }

    const [ipRl, emailRl] = await Promise.all([
      checkRateLimit(env.DB, `claim-ip:${ip}`, claimLimit, DEFAULT_CLAIM_WINDOW_SEC),
      checkRateLimit(
        env.DB,
        `claim-email:${auth.parentEmail!}`,
        claimLimit,
        DEFAULT_CLAIM_WINDOW_SEC
      ),
    ]);
    if (!ipRl.allowed) return rateLimitExceededResponse(ipRl.retryAfterSeconds);
    if (!emailRl.allowed) return rateLimitExceededResponse(emailRl.retryAfterSeconds);

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request, 8192);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonResponse({ error: err.message }, err.status);
      }
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    const secret = getSessionSecret(env);
    const rawLinkToken = typeof body.linkToken === 'string' ? body.linkToken.trim() : '';
    let row = null;

    if (rawLinkToken) {
      const payload = await verifyToken<ParentLinkTokenPayload>(rawLinkToken, secret, 'parent_link');
      if (payload && typeof payload.saveId === 'string') {
        row = await db.getSaveRow(payload.saveId);
      }
    } else {
      const rawCode = typeof body.heroCode === 'string' ? body.heroCode : '';
      const normalized = normalizeHeroCode(rawCode);
      if (!normalized || normalized.length < 5 || normalized.length > 64) {
        return jsonResponse({ error: 'Invalid Hero Code' }, 400);
      }
      const hash = await hashHeroCode(normalized, secret);
      row = await db.getSaveByRecoveryHash(hash);
    }

    const recordGlobalFail = async (): Promise<Response | null> => {
      const failRl = await recordHeroCodeFailure(
        env.DB,
        ip,
        globalFailLimit,
        DEFAULT_GLOBAL_FAIL_WINDOW_SEC
      );
      return failRl.allowed ? null : rateLimitExceededResponse(failRl.retryAfterSeconds);
    };

    // Return identical error for not-found and already-owned-by-other to prevent code enumeration
    const unavailableMsg = rawLinkToken
      ? 'This parent link has expired or is no longer available'
      : 'Hero Code not found or unavailable';
    if (!row) {
      const globalErr = await recordGlobalFail();
      if (globalErr) return globalErr;
      return jsonResponse({ error: unavailableMsg }, 404);
    }

    const claimRes = await db.claimUnownedHero(row.id, auth.parentEmail!);
    if (claimRes.status === 'claimed' || claimRes.status === 'already_owned_by_self') {
      const parentPrefs = await db.getParentPreferences(auth.parentEmail!);
      return jsonResponse(
        {
          save: claimRes.save,
          weeklyDigestEnabled: parentPrefs.weeklyDigestEnabled,
          weeklyDigestNotice: parentPrefs.weeklyDigestEnabled
            ? `Weekly progress emails are enabled for ${auth.parentEmail!}. You will only receive an email when your hero makes progress, and you can turn them off anytime in Parent Console preferences.`
            : 'Weekly progress emails are currently paused. You can re-enable them anytime in Parent Console preferences.',
        },
        200
      );
    }
    if (claimRes.status === 'quota_exceeded') {
      return jsonResponse(
        { error: `Save limit reached (${db.maxSavesPerAccount} heroes per parent account)` },
        429
      );
    }

    const globalErr = await recordGlobalFail();
    if (globalErr) return globalErr;
    return jsonResponse({ error: unavailableMsg }, 404);
  }

  // Routes under /api/console/saves/:id/<action>
  if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'console' && parts[2] === 'saves') {
    const saveId = safeDecodeSegment(parts[3]);
    if (saveId === null) {
      return jsonResponse({ error: 'Invalid URL encoding' }, 400);
    }
    const action = parts[4];

    // POST /api/console/saves/:id/rotate-code
    if (method === 'POST' && action === 'rotate-code') {
      const accessErr = await requireParentOwnsSave(db, auth, saveId);
      if (accessErr) return accessErr;

      const secret = getSessionSecret(env);
      const { heroCode, hash } = await generateUniqueHeroCodeHash(db, secret);
      const rotated = await db.rotateHeroCode(saveId, hash);
      if (!rotated) {
        return jsonResponse({ error: 'Save not found' }, 404);
      }
      const playToken = await signHeroPlayToken(rotated.saveId, rotated.sessionVersion, secret);
      return jsonResponse({
        saveId: rotated.saveId,
        heroCode,
        sessionVersion: rotated.sessionVersion,
        playToken,
        playTokenExpiresInSeconds: HERO_PLAY_TTL_SECONDS,
      });
    }

    // POST /api/console/saves/:id/override-trial
    if (method === 'POST' && action === 'override-trial') {
      const accessErr = await requireParentOwnsSave(db, auth, saveId);
      if (accessErr) return accessErr;

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request, 16384);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid request body' }, 400);
      }

      const rawTrialId = body.trialId;
      if (
        typeof rawTrialId !== 'string' ||
        !rawTrialId.trim() ||
        rawTrialId.length > MAX_TRIAL_ID_LEN ||
        hasControlChars(rawTrialId)
      ) {
        return jsonResponse({ error: 'trialId is required and must be a valid string' }, 400);
      }
      if (typeof body.solved !== 'boolean') {
        return jsonResponse({ error: 'solved must be a boolean' }, 400);
      }

      const trialId = rawTrialId.trim();
      const solved = body.solved;
      const awardShards = solved ? body.awardShards !== false : false;
      const shardReward =
        solved && awardShards ? await findTrialShardReward(env, request.url, trialId) : 0;

      const result = await db.overrideTrial({
        saveId,
        trialId,
        solved,
        awardShards,
        shardReward,
      });
      if (!result) {
        return jsonResponse({ error: 'Save not found' }, 404);
      }
      return jsonResponse({
        ok: true,
        save: result.save,
        shardsDelta: result.shardsDelta,
      });
    }

    // PUT /api/console/saves/:id/preferences
    if (method === 'PUT' && action === 'preferences') {
      const accessErr = await requireParentOwnsSave(db, auth, saveId);
      if (accessErr) return accessErr;

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request, 8192);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid request body' }, 400);
      }

      let prefs: SavePreferences;
      try {
        prefs = validatePreferences(body);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid preferences' }, 400);
      }

      const updated = await db.updatePreferences(saveId, prefs);
      if (!updated) {
        return jsonResponse({ error: 'Save not found' }, 404);
      }
      return jsonResponse(updated);
    }

    // POST /api/console/saves/:id/assign-owner (admin only)
    if (method === 'POST' && action === 'assign-owner') {
      if (!auth.isAdmin) {
        return jsonResponse({ error: 'Admin access required' }, 403);
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request, 8192);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid request body' }, 400);
      }

      if (!('ownerEmail' in body)) {
        return jsonResponse({ error: 'ownerEmail is required' }, 400);
      }
      const ownerVal = body.ownerEmail;
      if (ownerVal !== null && (typeof ownerVal !== 'string' || ownerVal.length > 254 || hasControlChars(ownerVal))) {
        return jsonResponse({ error: 'ownerEmail must be a valid string or null' }, 400);
      }

      const updated = await db.assignOwner(saveId, ownerVal);
      if (!updated) {
        return jsonResponse({ error: 'Save not found' }, 404);
      }
      return jsonResponse({ ok: true, save: updated });
    }
  }

  return jsonResponse({ error: 'Unknown console API endpoint' }, 404);
}

function htmlResponse(html: string, status = 200): Response {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  applySecurityHeaders(headers);
  return new Response(html, { status, headers });
}

function wantsHtml(request: Request): boolean {
  const accept = (request.headers.get('Accept') || '').toLowerCase();
  return accept.includes('text/html') && !accept.includes('application/json');
}

/**
 * POST /api/admin/digest/preview
 * Admin-only endpoint to inspect rendered HTML/plain-text digest without spamming parents.
 * Optionally sends a test email to the requesting admin (or explicit `toEmail`) when `sendTest: true`.
 */
export async function handleAdminDigestPreview(
  request: Request,
  env: Env,
  db: PyriaD1,
  auth: AuthContext,
  url: URL
): Promise<Response> {
  if (!auth.isAdmin) {
    return jsonResponse({ error: 'Admin access required' }, 403);
  }

  let body: Record<string, unknown> = {};
  const contentLength = request.headers.get('Content-Length');
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if ((contentLength && contentLength !== '0') || contentType.includes('application/json')) {
    try {
      body = await readJsonBody(request, 8192);
    } catch (err) {
      if (err instanceof ValidationError) {
        return jsonResponse({ error: err.message }, err.status);
      }
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }
  }

  const requestedOwner =
    typeof body.ownerEmail === 'string' && body.ownerEmail.trim()
      ? normalizeEmail(body.ownerEmail)
      : auth.parentEmail;

  if (!requestedOwner) {
    return jsonResponse({ error: 'ownerEmail is required for digest preview' }, 400);
  }

  const weekKey =
    typeof body.weekKey === 'string' && /^\d{4}-W\d{2}$/.test(body.weekKey.trim())
      ? body.weekKey.trim()
      : undefined;

  const baseUrl = getDigestBaseUrl(env, url.origin);
  const { digest, weeklyDigestEnabled, weekKey: resolvedWeekKey } = await buildDigestForParent(
    db,
    env,
    requestedOwner,
    { weekKey, baseUrl }
  );

  if (!digest) {
    return jsonResponse({
      ok: true,
      ownerEmail: requestedOwner,
      weekKey: resolvedWeekKey,
      weeklyDigestEnabled,
      hasProgress: false,
      digest: null,
      email: null,
      testSent: false,
    });
  }

  const secret = getSessionSecret(env);
  const unsubToken = await createUnsubscribeToken(requestedOwner, secret);
  const rendered = renderWeeklyDigestEmail(digest, {
    baseUrl,
    unsubscribeToken: unsubToken,
  });

  let testSent = false;
  let providerMessageId: string | null = null;
  if (body.sendTest === true) {
    const targetEmail =
      typeof body.toEmail === 'string' && body.toEmail.trim()
        ? normalizeEmail(body.toEmail)
        : auth.parentEmail;
    if (!targetEmail) {
      return jsonResponse({ error: 'Valid toEmail or admin email is required to send test' }, 400);
    }
    const sender = createEmailSender(env);
    if (!sender) {
      return jsonResponse(
        { error: 'Email transport is not configured (set EMAIL_API_KEY or SEND_EMAIL binding)' },
        503
      );
    }
    const res = await sender.send({
      to: targetEmail,
      from: getEmailFrom(env),
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      headers: rendered.headers,
    });
    testSent = true;
    providerMessageId = res.providerMessageId;
  }

  return jsonResponse({
    ok: true,
    ownerEmail: requestedOwner,
    weekKey: resolvedWeekKey,
    weeklyDigestEnabled,
    hasProgress: true,
    digest,
    email: {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: rendered.headers,
      consoleUrl: rendered.consoleUrl,
      unsubscribeUrl: rendered.unsubscribeUrl,
    },
    testSent,
    providerMessageId,
  });
}

/**
 * Stateless HMAC-SHA256 One-Click Unsubscribe:
 * GET  /api/email/unsubscribe?token=...  (parent clicks link in email)
 * POST /api/email/unsubscribe?token=...  (RFC 8058 mail-client List-Unsubscribe=One-Click)
 */
export async function handleUnsubscribeRequest(
  request: Request,
  env: Env,
  db: PyriaD1,
  url: URL
): Promise<Response> {
  const method = request.method.toUpperCase();
  let token = (url.searchParams.get('token') || '').trim();

  if (!token && method === 'POST') {
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    try {
      if (ct.includes('application/json')) {
        const body = await readJsonBody(request, 4096);
        if (typeof body.token === 'string') token = body.token.trim();
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        const formText = await request.text();
        const params = new URLSearchParams(formText);
        token = (params.get('token') || '').trim();
      }
    } catch {
      // Fall through to invalid token handling
    }
  }

  let secret = '';
  try {
    secret = getSessionSecret(env);
  } catch {
    return jsonResponse({ error: 'Unsubscribe service unavailable' }, 503);
  }

  const payload = await verifyUnsubscribeToken(token, secret);
  if (!payload) {
    if (method === 'GET' && wantsHtml(request)) {
      return htmlResponse(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invalid Unsubscribe Link — Pyria</title>
</head>
<body style="margin:0;padding:32px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <main style="max-width:520px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
    <h1 style="margin:0 0 10px;font-size:20px;">Unsubscribe Link Invalid or Expired</h1>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#475569;">
      This unsubscribe link is no longer valid. You can manage your weekly progress email settings anytime in the Parent Console.
    </p>
    <a href="/console/preferences" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;">Open Parent Console Preferences</a>
  </main>
</body>
</html>`,
        400
      );
    }
    return jsonResponse({ error: 'Invalid or expired unsubscribe token' }, 400);
  }

  const preferences = await db.setParentPreferences(payload.email, false);

  if (method === 'GET' && wantsHtml(request)) {
    return htmlResponse(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribed — Pyria</title>
</head>
<body style="margin:0;padding:32px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <main style="max-width:520px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
    <h1 style="margin:0 0 10px;font-size:20px;">Weekly Progress Emails Paused</h1>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#475569;">
      <strong>${escapeHtml(preferences.ownerEmail)}</strong> has been unsubscribed from Pyria weekly progress emails.
    </p>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">
      Changed your mind? You can re-enable weekly updates anytime in the Parent Console.
    </p>
    <a href="/console/preferences" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;">Manage Email Preferences</a>
  </main>
</body>
</html>`,
      200
    );
  }

  return jsonResponse({
    ok: true,
    email: preferences.ownerEmail,
    weeklyDigestEnabled: preferences.weeklyDigestEnabled,
    unsubscribedAt: preferences.unsubscribedAt,
  });
}

/**
 * Server-rendered Parent Console email preferences toggle page (/console/preferences).
 * Works with zero inline JS (strict CSP compliant) and lets parents enable/disable weekly emails.
 */
export async function handleConsolePreferencesPage(
  request: Request,
  db: PyriaD1,
  auth: AuthContext
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (!auth.parentEmail) {
    return htmlResponse(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Parent Console Email Preferences — Pyria</title>
</head>
<body style="margin:0;padding:32px 16px;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f8fafc;">
  <main style="max-width:520px;margin:0 auto;padding:28px;background:#1e293b;border:1px solid #334155;border-radius:12px;">
    <h1 style="margin:0 0 10px;font-size:20px;">Sign In to Manage Email Preferences</h1>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#cbd5e1;">
      Sign in with your parent account in the Parent Console to enable or pause weekly progress emails.
    </p>
    <a href="/console" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;">Go to Parent Console</a>
  </main>
</body>
</html>`,
      200
    );
  }

  let savedMessage = '';
  if (method === 'POST') {
    const csrfErr = checkSameOrigin(request);
    if (csrfErr) return csrfErr;
    const formText = await request.text();
    const params = new URLSearchParams(formText);
    const enabled = params.get('weeklyDigestEnabled') === '1';
    await db.setParentPreferences(auth.parentEmail, enabled);
    savedMessage = enabled
      ? 'Weekly progress emails are now enabled.'
      : 'Weekly progress emails are now paused.';
  }

  const prefs = await db.getParentPreferences(auth.parentEmail);
  const nextVal = prefs.weeklyDigestEnabled ? '0' : '1';
  const btnLabel = prefs.weeklyDigestEnabled
    ? 'Pause Weekly Progress Emails'
    : 'Enable Weekly Progress Emails';
  const statusLabel = prefs.weeklyDigestEnabled ? 'Enabled' : 'Paused';
  const statusColor = prefs.weeklyDigestEnabled ? '#16a34a' : '#d97706';

  return htmlResponse(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Weekly Email Preferences — Pyria Parent Console</title>
</head>
<body style="margin:0;padding:32px 16px;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f8fafc;">
  <main style="max-width:560px;margin:0 auto;padding:28px;background:#1e293b;border:1px solid #334155;border-radius:12px;">
    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#94a3b8;font-weight:700;">Pyria Parent Console</div>
    <h1 style="margin:6px 0 12px;font-size:22px;">Weekly Progress Emails</h1>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#cbd5e1;">
      Account: <strong>${escapeHtml(prefs.ownerEmail)}</strong><br />
      Status: <strong style="color:${statusColor};">${statusLabel}</strong>
    </p>
    <p style="margin:0 0 18px;font-size:13px;line-height:1.6;color:#94a3b8;">
      When enabled, Pyria sends a concise Sunday evening summary whenever at least one of your linked heroes solves a Python trial or reaches a new milestone. Weeks with no activity are always skipped.
    </p>
    ${
      savedMessage
        ? `<div style="margin:0 0 16px;padding:10px 14px;border-radius:8px;background:#064e3b;border:1px solid #10b981;color:#d1fae5;font-size:13px;">${escapeHtml(
            savedMessage
          )}</div>`
        : ''
    }
    <form method="POST" action="/console/preferences" style="margin:0 0 18px;">
      <input type="hidden" name="weeklyDigestEnabled" value="${nextVal}" />
      <button type="submit" style="cursor:pointer;padding:10px 18px;border:none;border-radius:8px;background:#4f46e5;color:#ffffff;font-size:14px;font-weight:600;">${btnLabel}</button>
    </form>
    <a href="/console" style="color:#93c5fd;font-size:13px;text-decoration:underline;">&larr; Back to Parent Console</a>
  </main>
</body>
</html>`,
    200
  );
}

/**
 * Self-hosted CSP-compliant script mounted on /console to display the Weekly Progress
 * Emails toggle and opt-in notice inside the Parent Console UI without editing web/.
 */
export function serveConsoleDigestPrefsScript(): Response {
  const js = `(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  async function initDigestPrefs() {
    try {
      const res = await fetch('/api/console/preferences', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.preferences) return;
      const host = document.querySelector('#builder-app main, #builder-app .topbar') || document.body;
      if (!host || document.getElementById('pyria-weekly-digest-bar')) return;

      const bar = document.createElement('section');
      bar.id = 'pyria-weekly-digest-bar';
      bar.style.cssText = 'margin:12px auto;max-width:1180px;padding:12px 16px;border-radius:10px;background:#1e293b;border:1px solid #334155;color:#f8fafc;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;font-size:13px;';

      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = 'Weekly Progress Emails: ';
      const desc = document.createElement('span');
      desc.style.color = '#cbd5e1';
      desc.textContent = data.notice || 'Sent weekly only when your hero makes progress.';
      info.appendChild(title);
      info.appendChild(desc);

      const label = document.createElement('label');
      label.style.cssText = 'display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'pyria-weekly-digest-toggle';
      checkbox.checked = Boolean(data.preferences.weeklyDigestEnabled);
      const statusText = document.createElement('span');
      statusText.textContent = checkbox.checked ? 'Enabled' : 'Paused';

      checkbox.addEventListener('change', async function () {
        const nextVal = checkbox.checked;
        checkbox.disabled = true;
        try {
          const putRes = await fetch('/api/console/preferences', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ weeklyDigestEnabled: nextVal }),
          });
          if (!putRes.ok) {
            checkbox.checked = !nextVal;
          } else {
            statusText.textContent = nextVal ? 'Enabled' : 'Paused';
          }
        } catch {
          checkbox.checked = !nextVal;
        } finally {
          checkbox.disabled = false;
        }
      });

      label.appendChild(checkbox);
      label.appendChild(statusText);
      bar.appendChild(info);
      bar.appendChild(label);

      const topbar = document.querySelector('#builder-app .topbar');
      if (topbar && topbar.parentNode) {
        topbar.parentNode.insertBefore(bar, topbar.nextSibling);
      } else {
        document.body.insertBefore(bar, document.body.firstChild);
      }
    } catch {
      // Non-parent or guest view; keep silent
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDigestPrefs);
  } else {
    initDigestPrefs();
  }
})();
`;
  const headers = new Headers({
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
  applySecurityHeaders(headers);
  return new Response(js, { status: 200, headers });
}
