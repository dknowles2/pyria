import {
  HERO_PLAY_TTL_SECONDS,
  HERO_SESSION_COOKIE,
  HERO_SESSION_TTL_SECONDS,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
  PARENT_LINK_TTL_SECONDS,
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
  HeroPlayTokenPayload,
  HeroSessionPayload,
  MagicLinkTokenPayload,
  OAuthStatePayload,
  ParentLinkTokenPayload,
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
const MAGIC_LINK_TTL_SECONDS = 900; // 15 minutes
const DEFAULT_MAGIC_LINK_IP_LIMIT = 5;
const DEFAULT_MAGIC_LINK_EMAIL_LIMIT = 3;
const DEFAULT_MAGIC_LINK_WINDOW_SEC = 600; // 10 minutes
const DEFAULT_MAGIC_LINK_FROM = 'Pyria <noreply@pyria.dev>';
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

export function isMagicLinkEnabled(env: Env): boolean {
  return Boolean((env.RESEND_API_KEY || '').trim() && (env.PYRIA_SESSION_SECRET || '').trim());
}

export async function resolveAuthContext(
  request: Request,
  env: Env,
  db: PyriaD1
): Promise<AuthContext> {
  const secret = (env.PYRIA_SESSION_SECRET || '').trim();
  const googleOAuthEnabled = isGoogleOAuthEnabled(env);
  const magicLinkEnabled = isMagicLinkEnabled(env);
  if (!secret) {
    return {
      role: 'guest',
      heroSaveId: null,
      heroName: null,
      heroLinkedToParent: false,
      heroPreferences: null,
      parentEmail: null,
      isAdmin: false,
      googleOAuthEnabled,
      magicLinkEnabled,
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
  let heroLinkedToParent = false;
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
        heroLinkedToParent = Boolean(row.owner_email && row.owner_email.trim());
        heroPreferences = parsePreferencesJson(row.preferences_json);
      }
    }
  }

  const role = isAdmin ? 'admin' : parentEmail ? 'parent' : heroSaveId ? 'hero' : 'guest';

  return {
    role,
    heroSaveId,
    heroName,
    heroLinkedToParent,
    heroPreferences,
    parentEmail,
    isAdmin,
    googleOAuthEnabled,
    magicLinkEnabled,
  };
}

export async function signParentLinkToken(saveId: string, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + PARENT_LINK_TTL_SECONDS;
  return signToken({ typ: 'parent_link', saveId, exp } satisfies ParentLinkTokenPayload, secret);
}

export async function signHeroPlayToken(
  saveId: string,
  sessionVersion: number,
  secret: string
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + HERO_PLAY_TTL_SECONDS;
  return signToken(
    { typ: 'hero_play', saveId, sessionVersion, exp } satisfies HeroPlayTokenPayload,
    secret
  );
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
      linkedToParent: auth.heroLinkedToParent,
      parentEmail: auth.parentEmail,
      isAdmin: auth.isAdmin,
      googleOAuthEnabled: auth.googleOAuthEnabled,
      magicLinkEnabled: auth.magicLinkEnabled,
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
    const [token, parentLinkToken] = await Promise.all([
      signToken(
        { typ: 'hero', saveId: save.id, sessionVersion: 1, exp } satisfies HeroSessionPayload,
        secret
      ),
      signParentLinkToken(save.id, secret),
    ]);
    const cookie = serializeCookie(HERO_SESSION_COOKIE, token, {
      maxAge: HERO_SESSION_TTL_SECONDS,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttpsRequest(request),
    });

    return jsonResponse(
      {
        save,
        heroCode,
        parentLinkToken,
        parentLinkExpiresInSeconds: PARENT_LINK_TTL_SECONDS,
      },
      201,
      { 'Set-Cookie': cookie }
    );
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

  const secret = getSessionSecret(env);
  const rawPlayToken = typeof body.playToken === 'string' ? body.playToken.trim() : '';
  let row = null;

  if (rawPlayToken) {
    const playPayload = await verifyToken<HeroPlayTokenPayload>(rawPlayToken, secret, 'hero_play');
    if (
      playPayload &&
      typeof playPayload.saveId === 'string' &&
      typeof playPayload.sessionVersion === 'number'
    ) {
      const candidate = await db.getSaveRow(playPayload.saveId);
      if (candidate && Number(candidate.session_version ?? 1) === playPayload.sessionVersion) {
        row = candidate;
      }
    }
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
      return jsonResponse({ error: 'This play link has expired or is no longer valid' }, 401);
    }
  } else {
    const rawCode = typeof body.heroCode === 'string' ? body.heroCode : '';
    const normalized = normalizeHeroCode(rawCode);
    if (!normalized || normalized.length < 5 || normalized.length > 64) {
      return jsonResponse({ error: 'Invalid Hero Code' }, 400);
    }

    const hash = await hashHeroCode(normalized, secret);
    row = await db.getSaveByRecoveryHash(hash);
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

export async function handleCreateHeroLinkToken(
  request: Request,
  env: Env,
  db: PyriaD1,
  auth: AuthContext
): Promise<Response> {
  if (!auth.heroSaveId) {
    return jsonResponse({ error: 'Active hero session required' }, 401);
  }

  const ip = getClientIp(request);
  const rl = await checkRateLimit(env.DB, `hero-link-token:${ip}`, 20, DEFAULT_CREATE_WINDOW_SEC);
  if (!rl.allowed) {
    return rateLimitExceededResponse(rl.retryAfterSeconds);
  }

  const row = await db.getSaveRow(auth.heroSaveId);
  if (!row) {
    return jsonResponse({ error: 'Hero save not found' }, 404);
  }
  if (row.owner_email && row.owner_email.trim()) {
    return jsonResponse(
      { error: 'This hero is already linked to a parent account', alreadyLinked: true },
      409
    );
  }

  const secret = getSessionSecret(env);
  const parentLinkToken = await signParentLinkToken(row.id, secret);
  return jsonResponse({
    parentLinkToken,
    heroName: row.hero_name,
    expiresInSeconds: PARENT_LINK_TTL_SECONDS,
  });
}

export async function handleHeroPlayPreview(
  request: Request,
  env: Env,
  db: PyriaD1
): Promise<Response> {
  const limit = Number.parseInt(env.PYRIA_RATE_LIMIT_REDEEM || '', 10) || DEFAULT_REDEEM_LIMIT;
  const ip = getClientIp(request);
  const rl = await checkRateLimit(env.DB, `hero-play-preview:${ip}`, limit * 2, DEFAULT_REDEEM_WINDOW_SEC);
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

  const rawPlayToken = typeof body.playToken === 'string' ? body.playToken.trim() : '';
  if (!rawPlayToken) {
    return jsonResponse({ error: 'playToken is required' }, 400);
  }

  const secret = getSessionSecret(env);
  const payload = await verifyToken<HeroPlayTokenPayload>(rawPlayToken, secret, 'hero_play');
  if (
    !payload ||
    typeof payload.saveId !== 'string' ||
    typeof payload.sessionVersion !== 'number'
  ) {
    return jsonResponse({ error: 'This play link has expired or is no longer valid' }, 401);
  }

  const row = await db.getSaveRow(payload.saveId);
  if (!row || Number(row.session_version ?? 1) !== payload.sessionVersion) {
    return jsonResponse({ error: 'This play link has expired or is no longer valid' }, 401);
  }

  return jsonResponse({
    valid: true,
    saveId: row.id,
    heroName: row.hero_name,
  });
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

function redirectMagicLinkInvalid(): Response {
  const headers = new Headers();
  headers.set('Location', '/console?auth_error=magic_link_invalid');
  headers.set('Cache-Control', 'no-store');
  applySecurityHeaders(headers);
  return new Response(null, { status: 302, headers });
}

function buildMagicLinkEmailHtml(verifyUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#0b1020;color:#eef3ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#151c32;border:2px solid #2b385c;border-radius:16px;padding:28px;">
    <p style="margin:0 0 8px;font-size:12px;font-weight:800;letter-spacing:0.1em;color:#f6c945;text-transform:uppercase;">PYRIA PARENT CONSOLE</p>
    <h1 style="margin:0 0 12px;font-size:24px;color:#eef3ff;">Sign in to Pyria</h1>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#9eb0d6;">
      Click the button below to sign in to the Pyria Parent Console. This link works once and expires in 15 minutes.
    </p>
    <p style="margin:0 0 22px;">
      <a href="${verifyUrl}" style="display:inline-block;padding:13px 24px;border-radius:10px;background:#34d399;color:#062118;font-weight:800;font-size:15px;text-decoration:none;">
        Sign In to Pyria Console →
      </a>
    </p>
    <p style="margin:0;font-size:12.5px;line-height:1.5;color:#9eb0d6;">
      If you didn't request this link, you can safely ignore this email.
    </p>
  </div>
</body>
</html>`;
}

export async function handleMagicLinkRequest(request: Request, env: Env): Promise<Response> {
  if (!isMagicLinkEnabled(env)) {
    return jsonResponse({ error: 'Email Magic Link sign-in is not configured on this server' }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request, 4096);
  } catch (err) {
    if (err instanceof ValidationError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const rawEmail = typeof body.email === 'string' ? body.email : '';
  const email = normalizeEmail(rawEmail);
  if (!email || email.length > 254 || !EMAIL_FORMAT_RE.test(email)) {
    return jsonResponse({ error: 'Please enter a valid email address.' }, 400);
  }

  const ipLimit =
    Number.parseInt(env.PYRIA_RATE_LIMIT_MAGIC_LINK || '', 10) || DEFAULT_MAGIC_LINK_IP_LIMIT;
  const ip = getClientIp(request);
  const ipRl = await checkRateLimit(
    env.DB,
    `magic-ip:${ip}`,
    ipLimit,
    DEFAULT_MAGIC_LINK_WINDOW_SEC
  );
  if (!ipRl.allowed) {
    return rateLimitExceededResponse(ipRl.retryAfterSeconds);
  }

  const emailLimit = Math.min(ipLimit, DEFAULT_MAGIC_LINK_EMAIL_LIMIT);
  const emailRl = await checkRateLimit(
    env.DB,
    `magic-email:${email}`,
    emailLimit,
    DEFAULT_MAGIC_LINK_WINDOW_SEC
  );
  if (!emailRl.allowed) {
    return rateLimitExceededResponse(emailRl.retryAfterSeconds);
  }

  const secret = getSessionSecret(env);
  const url = new URL(request.url);
  const nextPath = sanitizeNextPath(typeof body.next === 'string' ? body.next : null, '/console');
  const jti = generateRandomToken(16);
  const exp = Math.floor(Date.now() / 1000) + MAGIC_LINK_TTL_SECONDS;
  const token = await signToken(
    { typ: 'magic_link', email, jti, next: nextPath, exp } satisfies MagicLinkTokenPayload,
    secret
  );

  const verifyUrl = `${url.origin}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
  const resendUrl = env.RESEND_API_URL || 'https://api.resend.com/emails';
  const fromAddress = (env.MAGIC_LINK_FROM_EMAIL || '').trim() || DEFAULT_MAGIC_LINK_FROM;

  const resendRes = await fetch(resendUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [email],
      subject: 'Sign in to Pyria Parent Console',
      html: buildMagicLinkEmailHtml(verifyUrl),
      text: `Sign in to the Pyria Parent Console:\n\n${verifyUrl}\n\nThis link works once and expires in 15 minutes. If you didn't request this email, you can safely ignore it.`,
    }),
  });

  if (!resendRes.ok) {
    return jsonResponse(
      { error: 'Unable to send sign-in email right now. Please try again in a moment.' },
      502
    );
  }

  return jsonResponse({
    ok: true,
    message: 'Check your email for your sign-in link! It expires in 15 minutes.',
  });
}

export async function handleMagicLinkVerify(request: Request, env: Env): Promise<Response> {
  if (!isMagicLinkEnabled(env)) {
    return jsonResponse({ error: 'Email Magic Link sign-in is not configured on this server' }, 503);
  }

  const secret = getSessionSecret(env);
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) {
    return redirectMagicLinkInvalid();
  }

  const payload = await verifyToken<MagicLinkTokenPayload>(token, secret, 'magic_link');
  const email = payload ? normalizeEmail(payload.email) : null;
  if (!payload || !email || typeof payload.jti !== 'string' || !payload.jti) {
    return redirectMagicLinkInvalid();
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Prune expired entries opportunistically and consume jti atomically (single-use)
  await env.DB.prepare('DELETE FROM magic_link_tokens WHERE expires_at < ?').bind(nowSec).run();
  const insertRes = await env.DB.prepare(
    'INSERT OR IGNORE INTO magic_link_tokens (jti, expires_at) VALUES (?, ?)'
  )
    .bind(payload.jti, payload.exp)
    .run();

  if (!insertRes.meta || Number(insertRes.meta.changes) === 0) {
    return redirectMagicLinkInvalid();
  }

  const exp = nowSec + PARENT_SESSION_TTL_SECONDS;
  const sessionToken = await signToken(
    { typ: 'parent', email, exp } satisfies ParentSessionPayload,
    secret
  );

  const nextPath = sanitizeNextPath(payload.next, '/console');
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
      secure: isHttpsRequest(request),
    })
  );
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
