import {
  HERO_SESSION_COOKIE,
  HERO_SESSION_TTL_SECONDS,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_SECONDS,
  clearCookie,
  generateHeroCode,
  generateRandomToken,
  hashHeroCode,
  isHttpsRequest,
  normalizeHeroCode,
  parseCookies,
  serializeCookie,
  sha256Base64Url,
  signToken,
  verifyToken,
} from './crypto';
import { PyriaD1, parsePreferencesJson } from './db';
import {
  checkGlobalHeroCodeThrottle,
  checkRateLimit,
  getClientIp,
  rateLimitExceededResponse,
  recordHeroCodeFailure,
} from './rateLimit';
import { applySecurityHeaders, jsonResponse, sanitizeNextPath } from './security';
import type {
  AuthContext,
  Env,
  HeroSessionPayload,
  OAuthStatePayload,
  ParentSessionPayload,
} from './types';
import {
  MAX_SAVE_BODY_BYTES,
  QuotaError,
  ValidationError,
  normalizeEmail,
  readJsonBody,
} from './validation';

const DEFAULT_CREATE_LIMIT = 15;
const DEFAULT_CREATE_WINDOW_SEC = 600; // 10 minutes
const DEFAULT_DAILY_ANON_CREATES = 500;
const DEFAULT_DAILY_WINDOW_SEC = 86400; // 24 hours
const DEFAULT_REDEEM_LIMIT = 15;
const DEFAULT_REDEEM_WINDOW_SEC = 300; // 5 minutes
const DEFAULT_GLOBAL_FAIL_LIMIT = 200;
const DEFAULT_GLOBAL_FAIL_WINDOW_SEC = 300; // 5 minutes

export function getAdminEmails(env: Env): Set<string> {
  const raw = env.PYRIA_ADMIN_EMAILS || '';
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const cleaned = part.trim().toLowerCase();
    if (cleaned) out.add(cleaned);
  }
  return out;
}

export function getSessionSecret(env: Env): string {
  const secret = (env.PYRIA_SESSION_SECRET || '').trim();
  if (!secret) {
    throw new Error('PYRIA_SESSION_SECRET is not configured');
  }
  return secret;
}

export function isGoogleOAuthEnabled(env: Env): boolean {
  return Boolean((env.GOOGLE_CLIENT_ID || '').trim() && (env.GOOGLE_CLIENT_SECRET || '').trim());
}

export async function resolveAuthContext(
  request: Request,
  env: Env,
  db: PyriaD1
): Promise<AuthContext> {
  const secret = (env.PYRIA_SESSION_SECRET || '').trim();
  const googleOAuthEnabled = isGoogleOAuthEnabled(env);
  if (!secret) {
    return {
      role: 'guest',
      heroSaveId: null,
      heroName: null,
      heroPreferences: null,
      parentEmail: null,
      isAdmin: false,
      googleOAuthEnabled,
    };
  }

  const cookies = parseCookies(request);
  const adminEmails = getAdminEmails(env);

  let parentEmail: string | null = null;
  let isAdmin = false;
  if (cookies[PARENT_SESSION_COOKIE]) {
    const parentPayload = await verifyToken<ParentSessionPayload>(
      cookies[PARENT_SESSION_COOKIE],
      secret,
      'parent'
    );
    if (parentPayload && typeof parentPayload.email === 'string') {
      parentEmail = normalizeEmail(parentPayload.email);
      if (parentEmail && adminEmails.has(parentEmail)) {
        isAdmin = true;
      }
    }
  }

  let heroSaveId: string | null = null;
  let heroName: string | null = null;
  let heroPreferences = null;
  if (cookies[HERO_SESSION_COOKIE]) {
    const heroPayload = await verifyToken<HeroSessionPayload>(
      cookies[HERO_SESSION_COOKIE],
      secret,
      'hero'
    );
    if (
      heroPayload &&
      typeof heroPayload.saveId === 'string' &&
      typeof heroPayload.sessionVersion === 'number'
    ) {
      const row = await db.getSaveRow(heroPayload.saveId);
      if (row && Number(row.session_version) === heroPayload.sessionVersion) {
        heroSaveId = row.id;
        heroName = row.hero_name;
        heroPreferences = parsePreferencesJson(row.preferences_json);
      }
    }
  }

  const role = isAdmin ? 'admin' : parentEmail ? 'parent' : heroSaveId ? 'hero' : 'guest';

  return {
    role,
    heroSaveId,
    heroName,
    heroPreferences,
    parentEmail,
    isAdmin,
    googleOAuthEnabled,
  };
}

export async function generateUniqueHeroCodeHash(
  db: PyriaD1,
  secret: string
): Promise<{ heroCode: string; hash: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const heroCode = generateHeroCode();
    const hash = await hashHeroCode(heroCode, secret);
    const existing = await db.getSaveByRecoveryHash(hash);
    if (!existing) {
      return { heroCode, hash };
    }
  }
  throw new Error('Failed to generate unique Hero Code');
}

export async function handleGetMe(auth: AuthContext): Promise<Response> {
  return jsonResponse({
    mode: 'cloudflare',
    auth: {
      role: auth.role,
      heroSaveId: auth.heroSaveId,
      heroName: auth.heroName,
      parentEmail: auth.parentEmail,
      isAdmin: auth.isAdmin,
      googleOAuthEnabled: auth.googleOAuthEnabled,
    },
  });
}

export async function handleHeroCodeCreate(
  request: Request,
  env: Env,
  db: PyriaD1
): Promise<Response> {
  const limit = Number.parseInt(env.PYRIA_RATE_LIMIT_CREATE || '', 10) || DEFAULT_CREATE_LIMIT;
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env.DB, `hero-create:${ip}`, limit, DEFAULT_CREATE_WINDOW_SEC);
  if (!rl.allowed) {
    return rateLimitExceededResponse(rl.retryAfterSeconds);
  }

  const dailyLimit =
    Number.parseInt(env.PYRIA_MAX_DAILY_ANON_CREATES || '', 10) || DEFAULT_DAILY_ANON_CREATES;
  const globalDaily = await checkRateLimit(
    env.DB,
    'hero-create:global-daily',
    dailyLimit,
    DEFAULT_DAILY_WINDOW_SEC
  );
  if (!globalDaily.allowed) {
    return rateLimitExceededResponse(globalDaily.retryAfterSeconds);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request, MAX_SAVE_BODY_BYTES);
  } catch (err) {
    if (err instanceof ValidationError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  // Support both `{ heroName, state: { ... } }` and flat `{ heroName, appearance, ... }`
  let savePayload: Record<string, unknown>;
  if (
    body.state &&
    typeof body.state === 'object' &&
    !Array.isArray(body.state)
  ) {
    savePayload = { ...(body.state as Record<string, unknown>) };
    if (body.heroName !== undefined) {
      savePayload.heroName = body.heroName;
    }
  } else if (
    body.save &&
    typeof body.save === 'object' &&
    !Array.isArray(body.save) &&
    Object.keys(body).length === 1
  ) {
    savePayload = { ...(body.save as Record<string, unknown>) };
  } else {
    savePayload = { ...body };
  }
  // Never allow caller to spoof ownerEmail on kid-first create
  delete savePayload.ownerEmail;
  delete savePayload.owner_email;

  const secret = getSessionSecret(env);
  try {
    const { heroCode, hash } = await generateUniqueHeroCodeHash(db, secret);
    const save = await db.createSave(savePayload, {
      ownerEmail: null,
      recoveryCodeHash: hash,
    });

    const exp = Math.floor(Date.now() / 1000) + HERO_SESSION_TTL_SECONDS;
    const token = await signToken(
      { typ: 'hero', saveId: save.id, sessionVersion: 1, exp } satisfies HeroSessionPayload,
      secret
    );
    const cookie = serializeCookie(HERO_SESSION_COOKIE, token, {
      maxAge: HERO_SESSION_TTL_SECONDS,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttpsRequest(request),
    });

    return jsonResponse({ save, heroCode }, 201, { 'Set-Cookie': cookie });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof QuotaError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    throw err;
  }
}

export async function handleHeroCodeRedeem(
  request: Request,
  env: Env,
  db: PyriaD1
): Promise<Response> {
  const limit = Number.parseInt(env.PYRIA_RATE_LIMIT_REDEEM || '', 10) || DEFAULT_REDEEM_LIMIT;
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

  const rl = await checkRateLimit(env.DB, `hero-redeem:${ip}`, limit, DEFAULT_REDEEM_WINDOW_SEC);
  if (!rl.allowed) {
    return rateLimitExceededResponse(rl.retryAfterSeconds);
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

  const rawCode = typeof body.heroCode === 'string' ? body.heroCode : '';
  const normalized = normalizeHeroCode(rawCode);
  if (!normalized || normalized.length < 5 || normalized.length > 64) {
    return jsonResponse({ error: 'Invalid Hero Code' }, 400);
  }

  const secret = getSessionSecret(env);
  const hash = await hashHeroCode(normalized, secret);
  const row = await db.getSaveByRecoveryHash(hash);
  if (!row) {
    const failRl = await recordHeroCodeFailure(
      env.DB,
      ip,
      globalFailLimit,
      DEFAULT_GLOBAL_FAIL_WINDOW_SEC
    );
    if (!failRl.allowed) {
      return rateLimitExceededResponse(failRl.retryAfterSeconds);
    }
    return jsonResponse({ error: 'Invalid Hero Code' }, 401);
  }

  const exp = Math.floor(Date.now() / 1000) + HERO_SESSION_TTL_SECONDS;
  const token = await signToken(
    {
      typ: 'hero',
      saveId: row.id,
      sessionVersion: Number(row.session_version ?? 1),
      exp,
    } satisfies HeroSessionPayload,
    secret
  );

  const cookie = serializeCookie(HERO_SESSION_COOKIE, token, {
    maxAge: HERO_SESSION_TTL_SECONDS,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttpsRequest(request),
  });

  return jsonResponse({ save: PyriaD1.rowToSave(row) }, 200, { 'Set-Cookie': cookie });
}

export async function handleGoogleStart(request: Request, env: Env): Promise<Response> {
  if (!isGoogleOAuthEnabled(env)) {
    return jsonResponse({ error: 'Google Sign-In is not configured on this server' }, 503);
  }

  const secret = getSessionSecret(env);
  const url = new URL(request.url);
  const nextPath = sanitizeNextPath(url.searchParams.get('next'), '/console');
  const state = generateRandomToken(24);
  const codeVerifier = generateRandomToken(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const exp = Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS;

  const stateToken = await signToken(
    { typ: 'oauth_state', state, codeVerifier, next: nextPath, exp } satisfies OAuthStatePayload,
    secret
  );

  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!.trim());
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('prompt', 'select_account');

  const headers = new Headers();
  headers.set('Location', authUrl.toString());
  headers.set('Cache-Control', 'no-store');
  headers.append(
    'Set-Cookie',
    serializeCookie(OAUTH_STATE_COOKIE, stateToken, {
      maxAge: OAUTH_STATE_TTL_SECONDS,
      path: '/api/auth/google/callback',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttpsRequest(request),
    })
  );
  applySecurityHeaders(headers);
  return new Response(null, { status: 302, headers });
}

export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
  if (!isGoogleOAuthEnabled(env)) {
    return jsonResponse({ error: 'Google Sign-In is not configured on this server' }, 503);
  }

  const secret = getSessionSecret(env);
  const secure = isHttpsRequest(request);
  const url = new URL(request.url);
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    return jsonResponse({ error: `Google Sign-In cancelled or failed: ${oauthError}` }, 400);
  }

  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!code || !state) {
    return jsonResponse({ error: 'Missing OAuth code or state' }, 400);
  }

  const cookies = parseCookies(request);
  const oauthState = await verifyToken<OAuthStatePayload>(
    cookies[OAUTH_STATE_COOKIE],
    secret,
    'oauth_state'
  );
  if (!oauthState || oauthState.state !== state) {
    return jsonResponse({ error: 'Invalid or expired OAuth state' }, 400);
  }

  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const tokenUrl = env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!.trim(),
      client_secret: env.GOOGLE_CLIENT_SECRET!.trim(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: oauthState.codeVerifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    return jsonResponse({ error: 'Failed to exchange Google OAuth code' }, 502);
  }

  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    return jsonResponse({ error: 'Google token response missing access_token' }, 502);
  }

  const userinfoUrl = env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo';
  const userRes = await fetch(userinfoUrl, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) {
    return jsonResponse({ error: 'Failed to fetch Google user info' }, 502);
  }

  const userInfo = (await userRes.json()) as { email?: string; email_verified?: boolean };
  const email = normalizeEmail(userInfo.email);
  if (!email || userInfo.email_verified !== true) {
    return jsonResponse({ error: 'Google account email is not verified' }, 403);
  }

  const exp = Math.floor(Date.now() / 1000) + PARENT_SESSION_TTL_SECONDS;
  const sessionToken = await signToken(
    { typ: 'parent', email, exp } satisfies ParentSessionPayload,
    secret
  );

  const nextPath = sanitizeNextPath(oauthState.next, '/console');
  const headers = new Headers();
  headers.set('Location', nextPath);
  headers.set('Cache-Control', 'no-store');
  headers.append(
    'Set-Cookie',
    serializeCookie(PARENT_SESSION_COOKIE, sessionToken, {
      maxAge: PARENT_SESSION_TTL_SECONDS,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure,
    })
  );
  headers.append('Set-Cookie', clearCookie(OAUTH_STATE_COOKIE, secure, '/api/auth/google/callback'));
  applySecurityHeaders(headers);

  return new Response(null, { status: 302, headers });
}

export async function handleLogout(request: Request): Promise<Response> {
  let scope: 'all' | 'hero' | 'parent' = 'all';
  try {
    const body = await readJsonBody(request, 4096, { allowEmpty: true });
    if (body.scope === 'hero' || body.scope === 'parent' || body.scope === 'all') {
      scope = body.scope;
    } else if (body.scope !== undefined) {
      return jsonResponse({ error: "scope must be 'all', 'hero', or 'parent'" }, 400);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const secure = isHttpsRequest(request);
  const headers = new Headers();
  if (scope === 'all' || scope === 'hero') {
    headers.append('Set-Cookie', clearCookie(HERO_SESSION_COOKIE, secure));
  }
  if (scope === 'all' || scope === 'parent') {
    headers.append('Set-Cookie', clearCookie(PARENT_SESSION_COOKIE, secure));
  }
  return jsonResponse({ ok: true }, 200, headers);
}
