import {
  handleGetMe,
  handleGoogleCallback,
  handleGoogleStart,
  handleHeroCodeCreate,
  handleHeroCodeRedeem,
  handleLogout,
  resolveAuthContext,
} from './auth';
import { handleConsoleRequest } from './console';
import { PyriaD1 } from './db';
import { checkRateLimit, getClientIp, rateLimitExceededResponse } from './rateLimit';
import {
  applySecurityHeaders,
  buildPySandboxCsp,
  cacheControlForPath,
  checkSameOrigin,
  jsonResponse,
} from './security';
import type { AuthContext, Env } from './types';
import {
  MAX_ATTEMPT_BODY_BYTES,
  MAX_SAVE_BODY_BYTES,
  QuotaError,
  ValidationError,
  normalizeEmail,
  readJsonBody,
  validateAttemptPayload,
} from './validation';

const DEFAULT_SAVES_RATE_LIMIT = 20;
const DEFAULT_SAVES_RATE_WINDOW_SEC = 600;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

let cachedSandboxCsp: string | null = null;

async function canAccessSave(
  db: PyriaD1,
  auth: AuthContext,
  saveId: string
): Promise<{ status: 200 | 403 | 404 }> {
  const row = await db.getSaveRow(saveId);
  if (!row) return { status: 404 };

  if (auth.isAdmin) return { status: 200 };
  if (auth.heroSaveId && auth.heroSaveId === saveId) return { status: 200 };
  if (auth.parentEmail) {
    const owner = normalizeEmail(row.owner_email);
    if (owner && owner === auth.parentEmail) return { status: 200 };
  }
  return { status: 403 };
}

async function handleApiConfig(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  const [gameRes, catalogRes] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL('/content/game.json', request.url).toString())),
    env.ASSETS.fetch(new Request(new URL('/content/catalog.json', request.url).toString())),
  ]);
  if (!gameRes.ok || !catalogRes.ok) {
    return jsonResponse({ error: 'Content file missing' }, 404);
  }

  const game = (await gameRes.json()) as Record<string, unknown>;
  const catalog = (await catalogRes.json()) as Record<string, unknown>;

  // Merge active hero's per-hero preferences into game.globalDifficultyOverride
  if (auth.heroPreferences && Object.keys(auth.heroPreferences).length > 0) {
    const baseDiff =
      game.globalDifficultyOverride &&
      typeof game.globalDifficultyOverride === 'object' &&
      !Array.isArray(game.globalDifficultyOverride)
        ? { ...(game.globalDifficultyOverride as Record<string, unknown>) }
        : {};
    if (auth.heroPreferences.difficulty !== undefined) {
      baseDiff.mode = auth.heroPreferences.difficulty;
    }
    if (auth.heroPreferences.showRawTracebacks !== undefined) {
      baseDiff.showRawTracebacks = auth.heroPreferences.showRawTracebacks;
    }
    if (auth.heroPreferences.maxPipHints !== undefined) {
      baseDiff.maxHintsAllowed = auth.heroPreferences.maxPipHints;
    }
    game.globalDifficultyOverride = baseDiff;
  }

  return jsonResponse({
    game,
    catalog,
    heroPreferences: auth.heroPreferences ?? null,
  });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const pathname = url.pathname;

  if (MUTATING_METHODS.has(method)) {
    const csrfError = checkSameOrigin(request);
    if (csrfError) return csrfError;
  }

  // Disable /api/builder/* in production
  if (pathname === '/api/builder' || pathname.startsWith('/api/builder/')) {
    return jsonResponse(
      {
        error:
          'Builder authoring is disabled in production. Use /console for Parent & Admin progress.',
      },
      403
    );
  }

  const db = new PyriaD1(env);

  // Auth endpoints that don't require pre-resolved session
  if (method === 'POST' && pathname === '/api/auth/hero-code/create') {
    return handleHeroCodeCreate(request, env, db);
  }
  if (method === 'POST' && pathname === '/api/auth/hero-code/redeem') {
    return handleHeroCodeRedeem(request, env, db);
  }
  if (method === 'GET' && pathname === '/api/auth/google/start') {
    return handleGoogleStart(request, env);
  }
  if (method === 'GET' && pathname === '/api/auth/google/callback') {
    return handleGoogleCallback(request, env);
  }
  if (method === 'POST' && pathname === '/api/auth/logout') {
    return handleLogout(request);
  }

  const auth = await resolveAuthContext(request, env, db);

  // GET /api/me
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/me') {
    return handleGetMe(auth);
  }

  // GET /api/health
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/health') {
    const payload: Record<string, unknown> = { ok: true, mode: 'cloudflare' };
    if (auth.isAdmin) {
      payload.saveCount = await db.countSaves();
    }
    return jsonResponse(payload);
  }

  // GET /api/config
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/config') {
    return handleApiConfig(request, env, auth);
  }

  // Parent & Admin Console API (/api/console/*)
  if (pathname.startsWith('/api/console/')) {
    return handleConsoleRequest(request, env, db, auth, url);
  }

  // /api/saves
  if (pathname === '/api/saves') {
    if (method === 'GET' || method === 'HEAD') {
      if (auth.isAdmin) {
        const ownerParam = (url.searchParams.get('owner') || '').trim().toLowerCase();
        const saves =
          ownerParam === 'all' || (!ownerParam && !auth.parentEmail)
            ? await db.listSaves(null)
            : await db.listSaves(ownerParam || auth.parentEmail);
        return jsonResponse({ saves });
      }
      if (auth.parentEmail) {
        const saves = await db.listSaves(auth.parentEmail);
        return jsonResponse({ saves });
      }
      if (auth.heroSaveId) {
        const save = await db.getSave(auth.heroSaveId);
        return jsonResponse({ saves: save ? [save] : [] });
      }
      return jsonResponse({ saves: [] });
    }

    if (method === 'POST') {
      if (!auth.parentEmail && !auth.isAdmin) {
        return jsonResponse(
          { error: 'Authentication required. Use guest mode or create a Hero Code.' },
          401
        );
      }

      const limit =
        Number.parseInt(env.PYRIA_RATE_LIMIT_SAVES || '', 10) || DEFAULT_SAVES_RATE_LIMIT;
      const ip = getClientIp(request);
      const rl = await checkRateLimit(
        env.DB,
        `saves-create:${ip}`,
        limit,
        DEFAULT_SAVES_RATE_WINDOW_SEC
      );
      if (!rl.allowed) {
        return rateLimitExceededResponse(rl.retryAfterSeconds);
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

      if (
        body.save &&
        typeof body.save === 'object' &&
        !Array.isArray(body.save) &&
        Object.keys(body).length === 1
      ) {
        body = body.save as Record<string, unknown>;
      }

      const requestedOwner = normalizeEmail(body.ownerEmail);
      const ownerEmail = auth.isAdmin && requestedOwner ? requestedOwner : auth.parentEmail;

      try {
        const save = await db.createSave(body, { ownerEmail });
        return jsonResponse({ save }, 201);
      } catch (err) {
        if (err instanceof ValidationError || err instanceof QuotaError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        throw err;
      }
    }
  }

  // /api/saves/:id and /api/saves/:id/attempts
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'saves') {
    const saveId = decodeURIComponent(parts[2]);
    const access = await canAccessSave(db, auth, saveId);
    if (access.status === 404) return jsonResponse({ error: 'Save not found' }, 404);
    if (access.status === 403) return jsonResponse({ error: 'Forbidden' }, 403);

    if (method === 'GET' || method === 'HEAD') {
      const save = await db.getSave(saveId);
      if (!save) return jsonResponse({ error: 'Save not found' }, 404);
      return jsonResponse({ save });
    }

    if (method === 'PUT') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request, MAX_SAVE_BODY_BYTES);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid request body' }, 400);
      }

      if (
        body.save &&
        typeof body.save === 'object' &&
        !Array.isArray(body.save) &&
        Object.keys(body).length === 1
      ) {
        body = body.save as Record<string, unknown>;
      }

      try {
        const updated = await db.updateSave(saveId, body);
        if (!updated) return jsonResponse({ error: 'Save not found' }, 404);
        return jsonResponse({ save: updated });
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        throw err;
      }
    }

    if (method === 'DELETE') {
      // Child hero sessions cannot delete saves directly; only parent owner or admin can delete
      if (!auth.isAdmin && !auth.parentEmail) {
        return jsonResponse({ error: 'Parent or admin authentication required to delete saves' }, 403);
      }
      const deleted = await db.deleteSave(saveId);
      if (!deleted) return jsonResponse({ error: 'Save not found' }, 404);
      return jsonResponse({ ok: true, deletedId: saveId });
    }
  }

  if (
    parts.length === 4 &&
    parts[0] === 'api' &&
    parts[1] === 'saves' &&
    parts[3] === 'attempts'
  ) {
    const saveId = decodeURIComponent(parts[2]);
    const access = await canAccessSave(db, auth, saveId);
    if (access.status === 404) return jsonResponse({ error: 'Save not found' }, 404);
    if (access.status === 403) return jsonResponse({ error: 'Forbidden' }, 403);

    if (method === 'GET' || method === 'HEAD') {
      const attempts = await db.listAttempts(saveId);
      if (!attempts) return jsonResponse({ error: 'Save not found' }, 404);
      return jsonResponse({ attempts });
    }

    if (method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request, MAX_ATTEMPT_BODY_BYTES);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid request body' }, 400);
      }

      let attempt: ReturnType<typeof validateAttemptPayload>;
      try {
        attempt = validateAttemptPayload(body);
      } catch (err) {
        if (err instanceof ValidationError) {
          return jsonResponse({ error: err.message }, err.status);
        }
        return jsonResponse({ error: 'Invalid attempt payload' }, 400);
      }

      const attemptId = await db.logAttempt({ saveId, ...attempt });
      if (attemptId === null) return jsonResponse({ error: 'Save not found' }, 404);
      return jsonResponse({ ok: true, attemptId }, 201);
    }
  }

  return jsonResponse({ error: 'Unknown API endpoint' }, 404);
}

async function serveStaticWithHeaders(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const method = request.method.toUpperCase();
  const pathname = url.pathname;
  const lowerPath = pathname.toLowerCase();

  // Block any mutating requests to /builder/* in production
  if (
    MUTATING_METHODS.has(method) &&
    (lowerPath === '/builder' || lowerPath.startsWith('/builder/'))
  ) {
    return jsonResponse({ error: 'Builder writes are disabled in production' }, 403);
  }

  // Handle /py-sandbox.html (case-insensitive) with strict opaque-origin hashed CSP
  if (lowerPath === '/py-sandbox.html') {
    const assetUrl = new URL('/py-sandbox.html', request.url);
    const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method }));
    if (!assetRes.ok) {
      return jsonResponse({ error: 'Sandbox file not found' }, 404);
    }
    const htmlText = await assetRes.text();
    if (!cachedSandboxCsp) {
      cachedSandboxCsp = await buildPySandboxCsp(htmlText);
    }
    const headers = new Headers(assetRes.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=300');
    applySecurityHeaders(headers, {
      csp: cachedSandboxCsp,
      frameOptions: 'SAMEORIGIN',
    });
    return new Response(method === 'HEAD' ? null : htmlText, {
      status: assetRes.status,
      headers,
    });
  }

  // Route /console, /console/*, /admin, /admin/*, /builder, /builder/* cleanly to console/builder assets
  let assetReq = request;
  if (
    lowerPath === '/console' ||
    lowerPath === '/console/' ||
    lowerPath === '/admin' ||
    lowerPath === '/admin/' ||
    lowerPath === '/builder' ||
    lowerPath === '/builder/'
  ) {
    // Prefer /console/index.html if frontend added one, otherwise serve /builder/index.html
    if (lowerPath.startsWith('/console')) {
      const consoleTry = await env.ASSETS.fetch(
        new Request(new URL('/console/index.html', request.url).toString(), { method })
      );
      if (consoleTry.ok) {
        const headers = new Headers(consoleTry.headers);
        headers.set('Cache-Control', 'no-cache');
        applySecurityHeaders(headers);
        return new Response(method === 'HEAD' ? null : consoleTry.body, {
          status: consoleTry.status,
          headers,
        });
      }
    }
    assetReq = new Request(new URL('/builder/index.html', request.url).toString(), { method });
  } else if (lowerPath.startsWith('/console/') || lowerPath.startsWith('/admin/')) {
    // First try direct asset; if 404, fallback to /builder/<subpath>
    const directRes = await env.ASSETS.fetch(request);
    if (directRes.ok) {
      const headers = new Headers(directRes.headers);
      headers.set('Cache-Control', cacheControlForPath(pathname));
      applySecurityHeaders(headers);
      return new Response(method === 'HEAD' ? null : directRes.body, {
        status: directRes.status,
        headers,
      });
    }
    const sub = pathname.replace(/^\/(console|admin)\//i, '');
    assetReq = new Request(new URL(`/builder/${sub}`, request.url).toString(), { method });
  }

  const assetRes = await env.ASSETS.fetch(assetReq);
  const headers = new Headers(assetRes.headers);
  headers.set('Cache-Control', cacheControlForPath(pathname));
  applySecurityHeaders(headers);

  return new Response(method === 'HEAD' ? null : assetRes.body, {
    status: assetRes.status,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }
      return await serveStaticWithHeaders(request, env, url);
    } catch (err) {
      console.error('Unhandled worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  },
};
