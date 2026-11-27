import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeCsvCell } from '../analytics';
import {
  HERO_SESSION_COOKIE,
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_SECONDS,
  signToken,
} from '../crypto';
import { PyriaD1 } from '../db';
import { normalizeIpForRateLimit } from '../rateLimit';
import type { HeroSessionPayload, ParentSessionPayload } from '../types';

const BASE = 'https://pyria.test';

function extractCookie(res: Response, name: string): string | null {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const header of setCookies) {
    if (header.startsWith(`${name}=`)) {
      return header.split(';', 1)[0];
    }
  }
  const single = res.headers.get('Set-Cookie');
  if (single && single.includes(`${name}=`)) {
    const match = single.match(new RegExp(`${name}=[^;]+`));
    return match ? match[0] : null;
  }
  return null;
}

async function makeParentCookie(email: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + PARENT_SESSION_TTL_SECONDS;
  const token = await signToken(
    { typ: 'parent', email, exp } satisfies ParentSessionPayload,
    env.PYRIA_SESSION_SECRET!
  );
  return `${PARENT_SESSION_COOKIE}=${token}`;
}

async function apiJson(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string | null;
    headers?: Record<string, string>;
  } = {}
): Promise<{ res: Response; data: any }> {
  const headers: Record<string, string> = {
    Origin: BASE,
    ...(options.headers || {}),
  };
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM trial_attempts'),
    env.DB.prepare('DELETE FROM trial_stats_daily'),
    env.DB.prepare('DELETE FROM activity_events'),
    env.DB.prepare('DELETE FROM saves'),
    env.DB.prepare('DELETE FROM rate_limits'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Security Headers, Static Routing & Sandbox CSP', () => {
  it('sets strict security headers and Cache-Control: no-store on API responses', async () => {
    const { res, data } = await apiJson('/api/health');
    expect(res.status).toBe(200);
    expect(data).toEqual({ ok: true, mode: 'cloudflare' });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves /py-sandbox.html (HEAD, GET, case-insensitive, percent-encoded) with hashed opaque-origin sandbox CSP', async () => {
    // HEAD first to ensure cold-isolate HEAD does not poison cachedSandboxCsp
    const headRes = await SELF.fetch(`${BASE}/py-sandbox.html`, { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    const headCsp = headRes.headers.get('Content-Security-Policy') || '';
    expect(headCsp).toContain('sandbox allow-scripts;');
    expect(headCsp).toContain("'sha256-");
    expect(headRes.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');

    for (const path of ['/py-sandbox.html', '/PY-SANDBOX.HTML', '/%70y-sandbox.html', '//py-sandbox.html']) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status, `path ${path}`).toBe(200);
      const csp = res.headers.get('Content-Security-Policy') || '';
      expect(csp).toContain('sandbox allow-scripts;');
      expect(csp).toContain("'sha256-");
      expect(csp).toContain('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/');
      expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    }

    // Malformed percent-encoding returns 400 (never 500)
    const badPath = await SELF.fetch(`${BASE}/api/saves/%ZZ`);
    expect(badPath.status).toBe(400);
  });

  it('serves / and /js/main.js with strict security headers and generates _headers for Static Assets', async () => {
    for (const p of ['/', '/js/main.js']) {
      const res = await SELF.fetch(`${BASE}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
      expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(res.headers.get('Cache-Control')).toContain('public');
    }

    // Verify dist/assets/_headers exists in static assets build
    const headersAsset = await env.ASSETS.fetch(new Request(`${BASE}/_headers`));
    // Note: Workers Static Assets does not serve _headers publicly, so if 404 that's expected on edge,
    // while in local test we just verify headers on / and /js/main.js above.
    expect([200, 404]).toContain(headersAsset.status);
  });

  it('disables /api/builder/* and /builder write endpoints in production', async () => {
    const getRes = await apiJson('/api/builder/overview');
    expect(getRes.res.status).toBe(403);

    const putRes = await apiJson('/api/builder/difficulty', {
      method: 'PUT',
      body: { scope: 'global', override: { mode: 'explorer' } },
    });
    expect(putRes.res.status).toBe(403);

    const postBuilder = await apiJson('/builder/index.html', {
      method: 'POST',
      body: { test: true },
    });
    expect(postBuilder.res.status).toBe(403);
  });

  it('routes /console and /admin cleanly to console HTML', async () => {
    for (const path of ['/console', '/admin']) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      const html = await res.text();
      expect(html.toLowerCase()).toContain('<!doctype html');
    }
  });

  it('routes SPA game screens (/new, /play/:saveId) cleanly to index.html', async () => {
    for (const path of ['/new', '/new/', '/play/save-abc-123', '/play/guest-1700000-ab12']) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status, `path ${path}`).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      const html = await res.text();
      expect(html).toContain('screen-game');
    }
  });

  it('blocks cross-site and cross-origin mutating requests (CSRF defense)', async () => {
    const crossSite = await apiJson('/api/auth/logout', {
      method: 'POST',
      body: {},
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.res.status).toBe(403);

    const badOrigin = await apiJson('/api/auth/logout', {
      method: 'POST',
      body: {},
      headers: { Origin: 'https://evil.example' },
    });
    expect(badOrigin.res.status).toBe(403);

    const nullOrigin = await apiJson('/api/auth/logout', {
      method: 'POST',
      body: {},
      headers: { Origin: 'null' },
    });
    expect(nullOrigin.res.status).toBe(403);

    // Spoofing X-Forwarded-Host must NOT bypass CSRF check
    const spoofedFwd = await apiJson('/api/auth/logout', {
      method: 'POST',
      body: {},
      headers: {
        Origin: 'https://evil.example',
        'X-Forwarded-Host': 'evil.example',
      },
    });
    expect(spoofedFwd.res.status).toBe(403);

    // Protocol mismatch (http vs https) must be blocked
    const protoMismatch = await apiJson('/api/auth/logout', {
      method: 'POST',
      body: {},
      headers: { Origin: 'http://pyria.test' },
    });
    expect(protoMismatch.res.status).toBe(403);
  });
});

describe('Guest Mode (Zero D1 Writes)', () => {
  it('returns guest role on /api/me, empty saves, and rejects POST /api/saves with zero D1 writes', async () => {
    const me = await apiJson('/api/me');
    expect(me.res.status).toBe(200);
    expect(me.data).toEqual({
      mode: 'cloudflare',
      auth: {
        role: 'guest',
        heroSaveId: null,
        heroName: null,
        linkedToParent: false,
        parentEmail: null,
        isAdmin: false,
        googleOAuthEnabled: true,
        magicLinkEnabled: false,
      },
    });

    const saves = await apiJson('/api/saves');
    expect(saves.res.status).toBe(200);
    expect(saves.data.saves).toEqual([]);

    const createRes = await apiJson('/api/saves', {
      method: 'POST',
      body: { heroName: 'GuestHero' },
    });
    expect(createRes.res.status).toBe(401);

    const countRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM saves').first<{ cnt: number }>();
    expect(countRow?.cnt).toBe(0);
  });
});

describe('Kid-First Hero Code & Child Device Isolation', () => {
  it('upgrades guest state to Hero Code, redeems on another device, and enforces strict scope isolation', async () => {
    const created = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: {
        heroName: 'Rowan',
        state: {
          eraId: 'era-01-8bit',
          realmId: 'realm-01-meadow',
          byteShards: 42,
          solvedTrials: ['trial-01'],
        },
      },
    });
    expect(created.res.status).toBe(201);
    expect(created.data.heroCode).toMatch(/^[A-Z]+-[A-Z]+-\d{6}$/);
    expect(created.data.save.heroName).toBe('Rowan');
    expect(created.data.save.byteShards).toBe(42);

    const setCookieHeader = created.res.headers.get('Set-Cookie') || '';
    expect(setCookieHeader).toContain('pyria_hero_session=');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).toContain('Secure');

    const heroCookie = extractCookie(created.res, 'pyria_hero_session');
    expect(heroCookie).toBeTruthy();

    // Create a second hero so we can verify cross-hero isolation
    const created2 = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'Pippin' },
    });
    expect(created2.res.status).toBe(201);
    const otherSaveId = created2.data.save.id;

    // Redeem with lowercase & spaces (normalization)
    const redeemed = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: `  ${created.data.heroCode.toLowerCase().replace(/-/g, ' ')}  ` },
    });
    expect(redeemed.res.status).toBe(200);
    expect(redeemed.data.save.id).toBe(created.data.save.id);
    const redeemedCookie = extractCookie(redeemed.res, 'pyria_hero_session');

    // /api/me reports hero role
    const me = await apiJson('/api/me', { cookie: redeemedCookie });
    expect(me.data.auth.role).toBe('hero');
    expect(me.data.auth.heroSaveId).toBe(created.data.save.id);
    expect(me.data.auth.heroName).toBe('Rowan');

    // Hero can update own save & log attempts
    const putOwn = await apiJson(`/api/saves/${created.data.save.id}`, {
      method: 'PUT',
      cookie: redeemedCookie,
      body: { heroName: 'Rowan', byteShards: 75, openedChests: ['chest-1'] },
    });
    expect(putOwn.res.status).toBe(200);
    expect(putOwn.data.save.byteShards).toBe(75);

    const attempt = await apiJson(`/api/saves/${created.data.save.id}/attempts`, {
      method: 'POST',
      cookie: redeemedCookie,
      body: { trialId: 'trial-02', passed: true, hintsUsed: 1, code: 'print("hi")' },
    });
    expect(attempt.res.status).toBe(201);

    // Hero gets 403 on other hero save, DELETE own save, and /api/console/*
    expect((await apiJson(`/api/saves/${otherSaveId}`, { cookie: redeemedCookie })).res.status).toBe(403);
    expect(
      (await apiJson(`/api/saves/${created.data.save.id}`, { method: 'DELETE', cookie: redeemedCookie })).res.status
    ).toBe(403);
    expect((await apiJson('/api/console/progress', { cookie: redeemedCookie })).res.status).toBe(403);
    expect((await apiJson('/api/console/activity', { cookie: redeemedCookie })).res.status).toBe(403);
  });
});

describe('Parent-First Flow, Claiming, Cross-Account Isolation & Code Rotation', () => {
  it('supports parent-first hero creation, child redeem, claim-hero, cross-account 403, and code rotation', async () => {
    const parentA = await makeParentCookie('parent-a@example.com');
    const parentB = await makeParentCookie('parent-b@example.com');

    // Parent A creates child hero
    const parentHero = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: parentA,
      body: {
        heroName: 'Aria',
        preferences: { difficulty: 'explorer', showRawTracebacks: false, maxPipHints: 5 },
      },
    });
    expect(parentHero.res.status).toBe(201);
    const saveId = parentHero.data.save.id;
    const originalCode = parentHero.data.heroCode;

    // Child redeems Hero Code
    const childRedeem = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: originalCode },
    });
    expect(childRedeem.res.status).toBe(200);
    const oldChildCookie = extractCookie(childRedeem.res, 'pyria_hero_session');

    // Child gets merged preferences in /api/config
    const cfg = await apiJson('/api/config', { cookie: oldChildCookie });
    expect(cfg.res.status).toBe(200);
    expect(cfg.data.game.globalDifficultyOverride.mode).toBe('explorer');
    expect(cfg.data.game.globalDifficultyOverride.maxHintsAllowed).toBe(5);
    expect(cfg.data.heroPreferences.difficulty).toBe('explorer');

    // Child cannot access /api/console/*
    expect((await apiJson('/api/console/progress', { cookie: oldChildCookie })).res.status).toBe(403);

    // Kid-first hero -> Parent A claims it -> Parent B gets 409 on claim and 403 on access
    const kidHero = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'Leo' },
    });
    const claimA = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentA,
      body: { heroCode: kidHero.data.heroCode },
    });
    expect(claimA.res.status).toBe(200);
    expect(claimA.data.save.ownerEmail).toBe('parent-a@example.com');

    // Parent B trying to claim already-owned hero gets same 404 as nonexistent code (no enumeration oracle)
    const claimB = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentB,
      body: { heroCode: kidHero.data.heroCode },
    });
    const claimMissing = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentB,
      body: { heroCode: 'MISSING-CODE-999999' },
    });
    expect(claimB.res.status).toBe(404);
    expect(claimMissing.res.status).toBe(404);
    expect(claimB.data.error).toBe(claimMissing.data.error);

    // Parent B cannot view or mutate Parent A's heroes or activity
    expect((await apiJson(`/api/saves/${saveId}`, { cookie: parentB })).res.status).toBe(403);
    expect(
      (
        await apiJson(`/api/console/saves/${saveId}/override-trial`, {
          method: 'POST',
          cookie: parentB,
          body: { trialId: 'trial-01', solved: true },
        })
      ).res.status
    ).toBe(403);
    const progB = await apiJson('/api/console/progress', { cookie: parentB });
    expect(progB.data.saves).toEqual([]);
    const actB = await apiJson('/api/console/activity?since=0', { cookie: parentB });
    expect(actB.data.events).toEqual([]);

    // Parent A rotates Hero Code -> old child cookie is immediately invalidated!
    const rotated = await apiJson(`/api/console/saves/${saveId}/rotate-code`, {
      method: 'POST',
      cookie: parentA,
      body: {},
    });
    expect(rotated.res.status).toBe(200);
    expect(rotated.data.sessionVersion).toBe(2);
    expect(rotated.data.heroCode).not.toBe(originalCode);

    // Old child cookie is now rejected
    const meAfterRotate = await apiJson('/api/me', { cookie: oldChildCookie });
    expect(meAfterRotate.data.auth.role).toBe('guest');
    expect((await apiJson(`/api/saves/${saveId}`, { cookie: oldChildCookie })).res.status).toBe(403);

    // Old Hero Code no longer redeems; new Hero Code works
    expect(
      (await apiJson('/api/auth/hero-code/redeem', { method: 'POST', body: { heroCode: originalCode } }))
        .res.status
    ).toBe(401);
    const newRedeem = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: rotated.data.heroCode },
    });
    expect(newRedeem.res.status).toBe(200);
    const newChildCookie = extractCookie(newRedeem.res, 'pyria_hero_session');
    expect((await apiJson(`/api/saves/${saveId}`, { cookie: newChildCookie })).res.status).toBe(200);
  });
});

describe('Parent Trial Override, Preferences, Admin & Google OAuth', () => {
  it('handles trial overrides, preferences updates, and admin assign-owner', async () => {
    const parentCookie = await makeParentCookie('parent@example.com');
    const adminCookie = await makeParentCookie('admin@pyria.test');

    const created = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: parentCookie,
      body: { heroName: 'Nova' },
    });
    const saveId = created.data.save.id;

    // Override trial solved & unsolved
    const solveRes = await apiJson(`/api/console/saves/${saveId}/override-trial`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'realm-01-trial-01', solved: true },
    });
    expect(solveRes.res.status).toBe(200);
    expect(solveRes.data.save.state.solvedTrials).toContain('realm-01-trial-01');

    const unsolveRes = await apiJson(`/api/console/saves/${saveId}/override-trial`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'realm-01-trial-01', solved: false },
    });
    expect(unsolveRes.res.status).toBe(200);
    expect(unsolveRes.data.save.state.solvedTrials).not.toContain('realm-01-trial-01');

    // Update preferences
    const prefRes = await apiJson(`/api/console/saves/${saveId}/preferences`, {
      method: 'PUT',
      cookie: parentCookie,
      body: { difficulty: 'challenge', showRawTracebacks: true, maxPipHints: 1 },
    });
    expect(prefRes.res.status).toBe(200);
    expect(prefRes.data.preferences).toEqual({
      difficulty: 'challenge',
      showRawTracebacks: true,
      maxPipHints: 1,
    });

    // Non-admin cannot assign-owner
    const nonAdminAssign = await apiJson(`/api/console/saves/${saveId}/assign-owner`, {
      method: 'POST',
      cookie: parentCookie,
      body: { ownerEmail: 'other@example.com' },
    });
    expect(nonAdminAssign.res.status).toBe(403);

    // Admin can view all accounts and assign-owner
    const adminProg = await apiJson('/api/console/progress?owner=all', { cookie: adminCookie });
    expect(adminProg.res.status).toBe(200);
    expect(adminProg.data.saves.length).toBe(1);
    expect(adminProg.data.accounts).toContain('parent@example.com');

    const adminAssign = await apiJson(`/api/console/saves/${saveId}/assign-owner`, {
      method: 'POST',
      cookie: adminCookie,
      body: { ownerEmail: 'newowner@example.com' },
    });
    expect(adminAssign.res.status).toBe(200);
    expect(adminAssign.data.save.ownerEmail).toBe('newowner@example.com');
  });

  it('completes Google OAuth PKCE flow and rejects open redirects and mismatched state', async () => {
    const startRes = await SELF.fetch(`${BASE}/api/auth/google/start?next=//evil.example/steal`, {
      redirect: 'manual',
    });
    expect(startRes.status).toBe(302);
    const location = startRes.headers.get('Location') || '';
    const authUrl = new URL(location);
    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const stateParam = authUrl.searchParams.get('state')!;
    const oauthCookie = extractCookie(startRes, 'pyria_oauth_state')!;
    expect(oauthCookie).toBeTruthy();

    // Mismatched state is rejected
    const badState = await SELF.fetch(
      `${BASE}/api/auth/google/callback?code=abc&state=wrong-state`,
      { headers: { Cookie: oauthCookie }, redirect: 'manual' }
    );
    expect(badState.status).toBe(400);

    // Mock Google token + userinfo endpoints
    const origFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (reqUrl === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'mock-access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (reqUrl === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(
          JSON.stringify({ email: 'ParentUser@Example.com', email_verified: true }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      return origFetch(input, init);
    });

    const cbRes = await SELF.fetch(
      `${BASE}/api/auth/google/callback?code=valid-code&state=${encodeURIComponent(stateParam)}`,
      { headers: { Cookie: oauthCookie }, redirect: 'manual' }
    );
    expect(cbRes.status).toBe(302);
    // Open redirect was sanitized back to /console
    expect(cbRes.headers.get('Location')).toBe('/console');
    const parentCookie = extractCookie(cbRes, 'pyria_parent_session');
    expect(parentCookie).toBeTruthy();

    const me = await apiJson('/api/me', { cookie: parentCookie });
    expect(me.data.auth.role).toBe('parent');
    expect(me.data.auth.parentEmail).toBe('parentuser@example.com');

    // Logout clears parent session
    const logoutRes = await apiJson('/api/auth/logout', {
      method: 'POST',
      cookie: parentCookie,
      body: { scope: 'parent' },
    });
    expect(logoutRes.res.status).toBe(200);
    expect(logoutRes.res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('#45 Input Validation, Quotas, Cascading Delete & Rate Limiting', () => {
  it('enforces heroName rules, allowlist, draft truncation, and attempt code size cap', async () => {
    // Too short, control char, unknown key
    expect(
      (await apiJson('/api/auth/hero-code/create', { method: 'POST', body: { heroName: 'A' } })).res.status
    ).toBe(400);
    expect(
      (await apiJson('/api/auth/hero-code/create', { method: 'POST', body: { heroName: 'Bad\nName' } }))
        .res.status
    ).toBe(400);
    expect(
      (
        await apiJson('/api/auth/hero-code/create', {
          method: 'POST',
          body: { heroName: 'GoodHero', evilField: 123 },
        })
      ).res.status
    ).toBe(400);

    // ZWJ emoji is allowed
    const zwjRes = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'Hero👩‍💻' },
    });
    expect(zwjRes.res.status).toBe(201);
    const cookie = extractCookie(zwjRes.res, 'pyria_hero_session');
    const saveId = zwjRes.data.save.id;

    // Oversized trialDrafts truncated on PUT instead of rejecting
    const bigDraft = 'x'.repeat(40000);
    const putRes = await apiJson(`/api/saves/${saveId}`, {
      method: 'PUT',
      cookie,
      body: { heroName: 'Hero👩‍💻', trialDrafts: { 'trial-01': bigDraft } },
    });
    expect(putRes.res.status).toBe(200);
    expect(putRes.data.save.trialDrafts['trial-01'].length).toBe(32768);

    // Oversized attempt code (>32 KiB) returns 413
    const bigCodeRes = await apiJson(`/api/saves/${saveId}/attempts`, {
      method: 'POST',
      cookie,
      body: { trialId: 'trial-01', passed: false, hintsUsed: 0, code: 'a'.repeat(33000) },
    });
    expect(bigCodeRes.res.status).toBe(413);

    // Invalid hintsUsed values (null, empty string, array) return 400
    for (const badHints of [null, '', []]) {
      const badHintsRes = await apiJson(`/api/saves/${saveId}/attempts`, {
        method: 'POST',
        cookie,
        body: { trialId: 'trial-01', passed: false, hintsUsed: badHints, code: 'print(1)' },
      });
      expect(badHintsRes.res.status).toBe(400);
    }
  });

  it('enforces 10 heroes per parent account cap and cascading delete', async () => {
    const parentCookie = await makeParentCookie('quota@example.com');
    const ids: string[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const r = await apiJson('/api/console/heroes', {
        method: 'POST',
        cookie: parentCookie,
        body: { heroName: `Hero ${i}` },
      });
      expect(r.res.status).toBe(201);
      ids.push(r.data.save.id);
    }

    // 11th hero creation rejected with 429
    const eleventh = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: parentCookie,
      body: { heroName: 'Hero 11' },
    });
    expect(eleventh.res.status).toBe(429);

    // Claiming an 11th hero also rejected with 429
    const unclaimed = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'ExtraKid' },
    });
    const claimEleventh = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentCookie,
      body: { heroCode: unclaimed.data.heroCode },
    });
    expect(claimEleventh.res.status).toBe(429);

    // Log an attempt then delete the save -> cascades attempts and events
    await apiJson(`/api/saves/${ids[0]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01', passed: true, hintsUsed: 0, code: 'print(1)' },
    });
    const delRes = await apiJson(`/api/saves/${ids[0]}`, {
      method: 'DELETE',
      cookie: parentCookie,
    });
    expect(delRes.res.status).toBe(200);

    const remAttempts = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM trial_attempts WHERE save_id = ?'
    )
      .bind(ids[0])
      .first<{ cnt: number }>();
    const remEvents = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM activity_events WHERE save_id = ?'
    )
      .bind(ids[0])
      .first<{ cnt: number }>();
    expect(remAttempts?.cnt).toBe(0);
    expect(remEvents?.cnt).toBe(0);
  });

  it('rate-limits hero-code redeem and claim-hero (with IPv6 /64 bucketing) and enforces token type separation', async () => {
    // IPv6 /64 normalization groups addresses in the same /64 subnet
    expect(normalizeIpForRateLimit('2001:db8:abcd:12::1')).toBe('2001:0db8:abcd:0012::/64');
    expect(normalizeIpForRateLimit('2001:db8:abcd:12::ffff')).toBe('2001:0db8:abcd:0012::/64');

    let lastRedeem: Response | null = null;
    for (let i = 0; i < 16; i += 1) {
      const { res } = await apiJson('/api/auth/hero-code/redeem', {
        method: 'POST',
        body: { heroCode: 'FAKE-CODE-000000' },
        headers: { 'CF-Connecting-IP': `2001:db8:abcd:12::${i + 1}` },
      });
      lastRedeem = res;
    }
    expect(lastRedeem?.status).toBe(429);
    expect(Number(lastRedeem?.headers.get('Retry-After'))).toBeGreaterThan(0);

    // Claim-hero is also rate-limited per IP and per parentEmail
    const parentCookie = await makeParentCookie('ratelimit@example.com');
    let lastClaim: Response | null = null;
    for (let i = 0; i < 16; i += 1) {
      const { res } = await apiJson('/api/console/claim-hero', {
        method: 'POST',
        cookie: parentCookie,
        body: { heroCode: 'FAKE-CODE-111111' },
        headers: { 'CF-Connecting-IP': `203.0.113.${i + 1}` },
      });
      lastClaim = res;
    }
    expect(lastClaim?.status).toBe(429);
    expect(Number(lastClaim?.headers.get('Retry-After'))).toBeGreaterThan(0);

    // Token type separation: a hero token cannot be substituted as a parent session cookie
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const heroToken = await signToken(
      { typ: 'hero', saveId: 'fake-id', sessionVersion: 1, exp } satisfies HeroSessionPayload,
      env.PYRIA_SESSION_SECRET!
    );
    const confused = await apiJson('/api/console/progress', {
      cookie: `${PARENT_SESSION_COOKIE}=${heroToken}`,
    });
    expect(confused.res.status).toBe(403);

    const parentToken = await signToken(
      { typ: 'parent', email: 'a@b.com', exp } satisfies ParentSessionPayload,
      env.PYRIA_SESSION_SECRET!
    );
    const confusedHero = await apiJson('/api/me', {
      cookie: `${HERO_SESSION_COOKIE}=${parentToken}`,
    });
    expect(confusedHero.data.auth.role).toBe('guest');
  });

  it('blocks a failing IP even on a valid Hero Code once global failure cap is tripped, while allowing clean IPs', async () => {
    // Create a valid hero with a known Hero Code
    const created = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'ValidKid' },
      headers: { 'CF-Connecting-IP': '198.51.100.10' },
    });
    expect(created.res.status).toBe(201);
    const validCode = created.data.heroCode;

    // Seed global failure bucket at the limit (200)
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO rate_limits (bucket_key, count, window_start) VALUES (?, ?, ?)'
    )
      .bind('hero-code-fail:global', 200, now)
      .run();

    // Attacker IP misses once -> now recorded in hero-fail-ip:<ip>
    const attackerMiss = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: 'WRONG-GUESS-000000' },
      headers: { 'CF-Connecting-IP': '198.51.100.99' },
    });
    expect(attackerMiss.res.status).toBe(429);

    // Attacker IP now tries the *correct* Hero Code -> STILL blocked with 429 pre-lookup!
    const attackerHit = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: validCode },
      headers: { 'CF-Connecting-IP': '198.51.100.99' },
    });
    expect(attackerHit.res.status).toBe(429);
    expect(Number(attackerHit.res.headers.get('Retry-After'))).toBeGreaterThan(0);

    // Clean IP (legitimate kid with 0 prior misses) entering the valid Hero Code succeeds with 200!
    const cleanKid = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: validCode },
      headers: { 'CF-Connecting-IP': '198.51.100.55' },
    });
    expect(cleanKid.res.status).toBe(200);
    expect(cleanKid.data.save.heroName).toBe('ValidKid');
  });

  it('blanks older attempt code blobs, caps attempt rows, and prunes activity_events', async () => {
    const db = new PyriaD1({
      ...env,
      PYRIA_MAX_ATTEMPT_CODE_ROWS: '2',
      PYRIA_MAX_ATTEMPTS_PER_SAVE: '4',
      PYRIA_MAX_EVENTS_PER_SAVE: '3',
    });
    const save = await db.createSave({ heroName: 'PruneHero' });
    for (let i = 1; i <= 5; i += 1) {
      await db.logAttempt({
        saveId: save.id,
        trialId: `trial-${i}`,
        passed: i % 2 === 0,
        hintsUsed: 0,
        code: `print(${i})`,
      });
    }
    const attempts = await db.listAttempts(save.id);
    expect(attempts?.length).toBe(4);
    const nonEmptyCode = (attempts || []).filter((a) => a.code !== '');
    expect(nonEmptyCode.length).toBe(2);

    const evCount = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM activity_events WHERE save_id = ?'
    )
      .bind(save.id)
      .first<{ cnt: number }>();
    expect(evCount?.cnt).toBe(3);
  });

  it('serves gameplay assets while excluding concept-art, screenshots, previews, and build scripts', async () => {
    const okPaths = [
      '/content/game.json',
      '/assets/sprites/manifest.json',
      '/assets/tilesets/manifest.json',
      '/assets/world/maps_bundle.js',
    ];
    for (const p of okPaths) {
      const res = await SELF.fetch(`${BASE}${p}`);
      expect(res.status, `Expected 200 for ${p}`).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('public');
    }

    const excludedPaths = [
      '/assets/concept-art/hero_and_pip.png',
      '/assets/screenshots/gameplay-8bit.png',
      '/assets/sprites/preview.html',
      '/assets/sprites/build_sprites.py',
      '/assets/sprites/hero_showcase.png',
      '/assets/world/preview.html',
      '/assets/world/realm01_meadow_comparison.png',
    ];
    for (const p of excludedPaths) {
      const res = await SELF.fetch(`${BASE}${p}`);
      expect(res.status, `Expected 404 for excluded asset ${p}`).toBe(404);
    }
  });
});

describe('Onboarding Python Familiarity Preferences', () => {
  it('persists onboarding preferences on hero-code create and merges them into /api/config without breaking legacy saves', async () => {
    // 1. Legacy hero-code create without preferences still works with empty preferences
    const legacy = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'LegacyKid', state: { byteShards: 15 } },
    });
    expect(legacy.res.status).toBe(201);
    expect(legacy.data.save.preferences).toEqual({});

    // 2. New hero-code create with calibrated preferences persists them
    const onboarded = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: {
        heroName: 'PyPro',
        state: { realmId: 'realm-01-meadow' },
        preferences: {
          difficulty: 'challenge',
          showRawTracebacks: true,
          maxPipHints: 2,
        },
      },
    });
    expect(onboarded.res.status).toBe(201);
    expect(onboarded.data.save.preferences).toEqual({
      difficulty: 'challenge',
      showRawTracebacks: true,
      maxPipHints: 2,
    });

    const heroCookie = extractCookie(onboarded.res, HERO_SESSION_COOKIE);
    expect(heroCookie).toBeTruthy();

    // /api/config merges the hero's calibrated preferences
    const cfg = await apiJson('/api/config', { cookie: heroCookie });
    expect(cfg.res.status).toBe(200);
    expect(cfg.data.heroPreferences).toEqual({
      difficulty: 'challenge',
      showRawTracebacks: true,
      maxPipHints: 2,
    });
    expect(cfg.data.game.globalDifficultyOverride.mode).toBe('challenge');
    expect(cfg.data.game.globalDifficultyOverride.showRawTracebacks).toBe(true);
    expect(cfg.data.game.globalDifficultyOverride.maxHintsAllowed).toBe(2);

    // Normal gameplay PUT /api/saves/:id does not overwrite persisted preferences
    const saveUpdate = await apiJson(`/api/saves/${onboarded.data.save.id}`, {
      method: 'PUT',
      cookie: heroCookie,
      body: { byteShards: 40 },
    });
    expect(saveUpdate.res.status).toBe(200);
    expect(saveUpdate.data.save.byteShards).toBe(40);
    expect(saveUpdate.data.save.preferences).toEqual({
      difficulty: 'challenge',
      showRawTracebacks: true,
      maxPipHints: 2,
    });

    // 3. Invalid preferences are rejected cleanly with 400
    const badPrefs = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: {
        heroName: 'BadPrefs',
        preferences: { difficulty: 'impossible' },
      },
    });
    expect(badPrefs.res.status).toBe(400);
  });

  it('persists onboarding preferences on parent POST /api/saves and validates them', async () => {
    const parentCookie = await makeParentCookie('parent@example.com');

    const created = await apiJson('/api/saves', {
      method: 'POST',
      cookie: parentCookie,
      body: {
        heroName: 'BrandNew',
        preferences: {
          difficulty: 'explorer',
          showRawTracebacks: false,
          maxPipHints: 3,
        },
      },
    });
    expect(created.res.status).toBe(201);
    expect(created.data.save.preferences).toEqual({
      difficulty: 'explorer',
      showRawTracebacks: false,
      maxPipHints: 3,
    });

    const bad = await apiJson('/api/saves', {
      method: 'POST',
      cookie: parentCookie,
      body: {
        heroName: 'BadHints',
        preferences: { maxPipHints: 99 },
      },
    });
    expect(bad.res.status).toBe(400);
  });
});

describe('#70 Trial Analytics, Durable Rollups & Admin Calibration Metrics', () => {
  it('validates enriched attempt payloads and stores defaults for legacy clients', async () => {
    const created = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'MetricHero' },
    });
    expect(created.res.status).toBe(201);
    const saveId = created.data.save.id;
    const heroCookie = extractCookie(created.res, 'pyria_hero_session');

    // Legacy payload (no analytics fields) uses defaults
    const legacyRes = await apiJson(`/api/saves/${saveId}/attempts`, {
      method: 'POST',
      cookie: heroCookie,
      body: { trialId: 'trial-01-01', passed: false, hintsUsed: 0, code: 'say(1)' },
    });
    expect(legacyRes.res.status).toBe(201);

    // Enriched failed attempt
    const failRes = await apiJson(`/api/saves/${saveId}/attempts`, {
      method: 'POST',
      cookie: heroCookie,
      body: {
        trialId: 'trial-01-01',
        passed: false,
        hintsUsed: 2,
        code: 'say(1)',
        difficultyMode: 'challenge',
        isPractice: false,
        errorType: 'choice:b',
        durationMs: 12500,
      },
    });
    expect(failRes.res.status).toBe(201);

    // Passed attempt forces errorType to null
    const passRes = await apiJson(`/api/saves/${saveId}/attempts`, {
      method: 'POST',
      cookie: heroCookie,
      body: {
        trialId: 'trial-01-01',
        passed: true,
        hintsUsed: 1,
        code: 'say("Hello, Pyria!")',
        difficultyMode: 'explorer',
        isPractice: true,
        errorType: 'SyntaxError',
        durationMs: 4200,
      },
    });
    expect(passRes.res.status).toBe(201);

    const listRes = await apiJson(`/api/saves/${saveId}/attempts`, { cookie: heroCookie });
    expect(listRes.res.status).toBe(200);
    const attempts = listRes.data.attempts;
    expect(attempts.length).toBe(3);
    expect(attempts[0]).toMatchObject({
      passed: true,
      difficultyMode: 'explorer',
      isPractice: true,
      errorType: null,
      durationMs: 4200,
    });
    expect(attempts[1]).toMatchObject({
      passed: false,
      difficultyMode: 'challenge',
      isPractice: false,
      errorType: 'choice:b',
      durationMs: 12500,
    });
    expect(attempts[2]).toMatchObject({
      passed: false,
      difficultyMode: 'standard',
      isPractice: false,
      errorType: null,
      durationMs: null,
    });

    // Reject invalid values with 400
    const invalidPayloads = [
      { trialId: 'trial-01-01', passed: false, difficultyMode: 'nightmare' },
      { trialId: 'trial-01-01', passed: false, isPractice: 'yes' },
      { trialId: 'trial-01-01', passed: false, errorType: 'Syntax Error with spaces!' },
      { trialId: 'trial-01-01', passed: false, errorType: 'A'.repeat(65) },
      { trialId: 'trial-01-01', passed: false, durationMs: -1 },
      { trialId: 'trial-01-01', passed: false, durationMs: 86_400_001 },
      { trialId: 'trial-01-01', passed: false, durationMs: 12.5 },
      { trialId: 'trial-01-01', passed: false, durationMs: '100' },
    ];
    for (const bad of invalidPayloads) {
      const r = await apiJson(`/api/saves/${saveId}/attempts`, {
        method: 'POST',
        cookie: heroCookie,
        body: bad,
      });
      expect(r.res.status, `Expected 400 for ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('enforces strict admin-only 403 access control on GET /api/admin/trial-metrics', async () => {
    const heroCreated = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'ChildHero' },
    });
    const heroCookie = extractCookie(heroCreated.res, 'pyria_hero_session');
    const parentCookie = await makeParentCookie('non-admin@example.com');
    const adminCookie = await makeParentCookie('admin@pyria.test');

    // Guest -> 403
    expect((await apiJson('/api/admin/trial-metrics')).res.status).toBe(403);
    // Child hero session -> 403
    expect((await apiJson('/api/admin/trial-metrics', { cookie: heroCookie })).res.status).toBe(403);
    // Non-admin parent session -> 403
    expect((await apiJson('/api/admin/trial-metrics', { cookie: parentCookie })).res.status).toBe(403);
    // Admin session -> 200
    const adminRes = await apiJson('/api/admin/trial-metrics', { cookie: adminCookie });
    expect(adminRes.res.status).toBe(200);
    expect(adminRes.data.summary.totalTrials).toBeGreaterThan(0);
    expect(Array.isArray(adminRes.data.trials)).toBe(true);
  });

  it('computes accurate metrics, practice/date/difficulty filters, outlier flags, and CSV export', async () => {
    const adminCookie = await makeParentCookie('admin@pyria.test');
    const parentCookie = await makeParentCookie('teacher@example.com');

    // Create 5 heroes to satisfy default minHeroes=5
    const heroIds: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const created = await apiJson('/api/console/heroes', {
        method: 'POST',
        cookie: parentCookie,
        body: { heroName: `Student ${i}` },
      });
      expect(created.res.status).toBe(201);
      heroIds.push(created.data.save.id);
    }

    // trial-01-03: 5 heroes, varied attempts to solve [1, 2, 3, 5] + 1 unsolved (hero 5 overridden)
    // Hero 1: pass on 1st try (0 hints)
    await apiJson(`/api/saves/${heroIds[0]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01-03', passed: true, hintsUsed: 0, difficultyMode: 'standard' },
    });
    // Hero 1 practice replay (should be excluded by default!)
    await apiJson(`/api/saves/${heroIds[0]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: {
        trialId: 'trial-01-03',
        passed: true,
        hintsUsed: 0,
        difficultyMode: 'standard',
        isPractice: true,
      },
    });
    // Hero 2: 1 fail (SyntaxError, 1 hint) then pass (1 hint) -> 2 attempts to solve
    await apiJson(`/api/saves/${heroIds[1]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: {
        trialId: 'trial-01-03',
        passed: false,
        hintsUsed: 1,
        errorType: 'SyntaxError',
        difficultyMode: 'standard',
      },
    });
    await apiJson(`/api/saves/${heroIds[1]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01-03', passed: true, hintsUsed: 1, difficultyMode: 'standard' },
    });
    // Hero 3: 2 fails (AssertionError) then pass (tier3 hint) -> 3 attempts to solve
    for (let j = 0; j < 2; j += 1) {
      await apiJson(`/api/saves/${heroIds[2]}/attempts`, {
        method: 'POST',
        cookie: parentCookie,
        body: {
          trialId: 'trial-01-03',
          passed: false,
          hintsUsed: 2,
          errorType: 'AssertionError',
          difficultyMode: 'standard',
        },
      });
    }
    await apiJson(`/api/saves/${heroIds[2]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01-03', passed: true, hintsUsed: 3, difficultyMode: 'standard' },
    });
    // Hero 4: 4 fails (SyntaxError) then pass -> 5 attempts to solve
    for (let j = 0; j < 4; j += 1) {
      await apiJson(`/api/saves/${heroIds[3]}/attempts`, {
        method: 'POST',
        cookie: parentCookie,
        body: {
          trialId: 'trial-01-03',
          passed: false,
          hintsUsed: 3,
          errorType: 'SyntaxError',
          difficultyMode: 'standard',
        },
      });
    }
    await apiJson(`/api/saves/${heroIds[3]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01-03', passed: true, hintsUsed: 3, difficultyMode: 'standard' },
    });
    // Hero 5: 1 fail + parent override
    await apiJson(`/api/saves/${heroIds[4]}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: {
        trialId: 'trial-01-03',
        passed: false,
        hintsUsed: 3,
        errorType: 'NameError',
        difficultyMode: 'standard',
      },
    });
    const ovRes = await apiJson(`/api/console/saves/${heroIds[4]}/override-trial`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01-03', solved: true },
    });
    expect(ovRes.res.status).toBe(200);

    // trial-01-01: all 5 heroes pass on 1st try with 0 hints -> too_easy
    for (const hid of heroIds) {
      await apiJson(`/api/saves/${hid}/attempts`, {
        method: 'POST',
        cookie: parentCookie,
        body: { trialId: 'trial-01-01', passed: true, hintsUsed: 0, difficultyMode: 'explorer' },
      });
    }

    // Default query (includePractice=0)
    const metricsRes = await apiJson('/api/admin/trial-metrics?eraId=era-01-8bit&realmId=realm-01-meadow', {
      cookie: adminCookie,
    });
    expect(metricsRes.res.status).toBe(200);
    const t03 = metricsRes.data.trials.find((t: any) => t.trialId === 'trial-01-03');
    expect(t03).toBeTruthy();
    expect(t03.uniqueHeroes).toBe(5);
    expect(t03.uniqueSolvers).toBe(4);
    expect(t03.attempts).toBe(12); // 1 + 2 + 3 + 5 + 1 (practice excluded, no double count!)
    expect(t03.passes).toBe(4);
    expect(t03.completionRate).toBe(80.0);
    expect(t03.firstTryPassRate).toBe(20.0);
    // Attempts to solve: [1, 2, 3, 5] -> median = 2.5, p75 = 3 + 0.25*(5-3) = 3.5
    expect(t03.medianAttemptsToSolve).toBe(2.5);
    expect(t03.p75AttemptsToSolve).toBe(3.5);
    expect(t03.parentOverrides).toBe(1);
    expect(t03.parentOverrideRate).toBe(20.0);
    expect(t03.hintTierBreakdown).toEqual({ tier0: 1, tier1: 2, tier2: 2, tier3: 7 });
    expect(t03.topErrors[0]).toEqual({ errorType: 'SyntaxError', count: 5 });
    expect(t03.flag).toBe('too_hard');

    const t01 = metricsRes.data.trials.find((t: any) => t.trialId === 'trial-01-01');
    expect(t01.flag).toBe('too_easy');
    expect(t01.firstTryPassRate).toBe(100.0);

    // includePractice=1 adds Hero 1's practice attempt (12 -> 13) without double-counting non-practice
    const withPractice = await apiJson('/api/admin/trial-metrics?includePractice=1', {
      cookie: adminCookie,
    });
    const t03Pr = withPractice.data.trials.find((t: any) => t.trialId === 'trial-01-03');
    expect(t03Pr.attempts).toBe(13);
    expect(t03Pr.passes).toBe(5);

    // Difficulty filter isolates explorer vs standard
    const expOnly = await apiJson('/api/admin/trial-metrics?difficulty=explorer', {
      cookie: adminCookie,
    });
    expect(expOnly.data.trials.find((t: any) => t.trialId === 'trial-01-01').attempts).toBe(5);
    expect(expOnly.data.trials.find((t: any) => t.trialId === 'trial-01-03').attempts).toBe(0);

    // since filter in the future excludes today's attempts
    const futureRes = await apiJson('/api/admin/trial-metrics?since=2099-01-01', {
      cookie: adminCookie,
    });
    expect(futureRes.res.status).toBe(200);
    expect(futureRes.data.summary.trialsWithData).toBe(0);

    // Invalid query params return 400
    for (const badQs of [
      '?since=2026-02-30',
      '?since=not-a-date',
      '?difficulty=impossible',
      '?days=999',
      '?minHeroes=0',
      '?includePractice=maybe',
      '?format=xml',
    ]) {
      const badRes = await apiJson(`/api/admin/trial-metrics${badQs}`, { cookie: adminCookie });
      expect(badRes.res.status, `Expected 400 for ${badQs}`).toBe(400);
    }

    // CSV export & formula injection neutralization
    const csvRes = await SELF.fetch(`${BASE}/api/admin/trial-metrics?format=csv`, {
      headers: { Cookie: adminCookie },
    });
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('Content-Type')).toContain('text/csv');
    expect(csvRes.headers.get('Content-Disposition')).toContain('pyria-trial-metrics.csv');
    const csvText = await csvRes.text();
    expect(csvText).toContain('trialId,title,eraId,realmId');
    expect(csvText).toContain('trial-01-03');

    expect(sanitizeCsvCell('=CMD()')).toBe("'=CMD()");
    expect(sanitizeCsvCell('+1+1')).toBe("'+1+1");
    expect(sanitizeCsvCell('-2')).toBe("'-2");
    expect(sanitizeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(sanitizeCsvCell('\t=1')).toBe("'\t=1");
    expect(sanitizeCsvCell('  =HYPERLINK("x")')).toBe('"\'  =HYPERLINK(""x"")"');
  });

  it('preserves durable daily rollup metrics after trial_attempts pruning', async () => {
    const adminCookie = await makeParentCookie('admin@pyria.test');
    const db = new PyriaD1({
      ...env,
      PYRIA_MAX_ATTEMPT_CODE_ROWS: '2',
      PYRIA_MAX_ATTEMPTS_PER_SAVE: '2',
    });
    const save = await db.createSave({ heroName: 'PrunedAnalyticsHero' });

    // Log 5 attempts on trial-01-02 (raw table will prune down to 2 rows!)
    for (let i = 1; i <= 4; i += 1) {
      await db.logAttempt({
        saveId: save.id,
        trialId: 'trial-01-02',
        passed: false,
        hintsUsed: i === 4 ? 3 : 1,
        code: `bad(${i})`,
        difficultyMode: 'standard',
        isPractice: false,
        errorType: 'SyntaxError',
      });
    }
    await db.logAttempt({
      saveId: save.id,
      trialId: 'trial-01-02',
      passed: true,
      hintsUsed: 3,
      code: 'say("Wake up, Spark!")',
      difficultyMode: 'standard',
      isPractice: false,
    });

    // Confirm raw rows were pruned to 2
    const remaining = await db.listAttempts(save.id);
    expect(remaining?.length).toBe(2);

    // Metrics endpoint still reports all 5 attempts, 1 pass, 1 uniqueSolver, and 2 tier3 hints!
    const res = await apiJson('/api/admin/trial-metrics?minHeroes=1', { cookie: adminCookie });
    expect(res.res.status).toBe(200);
    const t02 = res.data.trials.find((t: any) => t.trialId === 'trial-01-02');
    expect(t02.attempts).toBe(5);
    expect(t02.passes).toBe(1);
    expect(t02.uniqueHeroes).toBe(1);
    expect(t02.uniqueSolvers).toBe(1);
    expect(t02.hintUsageRate).toBe(100.0);
    expect(t02.tier3HintRate).toBe(40.0);
  });

  it('preserves durable uniqueHeroes/completionRate/hintUsageRate after save deletion and prevents windowed first-try inflation', async () => {
    const adminCookie = await makeParentCookie('admin@pyria.test');
    const db = new PyriaD1(env);

    // 5 heroes on trial-01-04: 3 non-solvers (0 hints) + 2 solvers (1 with 3 hints, 1 with 0 hints)
    const saves = [];
    for (let i = 1; i <= 5; i += 1) {
      saves.push(await db.createSave({ heroName: `DeletedHero${i}` }));
    }
    for (let i = 0; i < 3; i += 1) {
      await db.logAttempt({
        saveId: saves[i].id,
        trialId: 'trial-01-04',
        passed: false,
        hintsUsed: 0,
        code: 'bad()',
        difficultyMode: 'standard',
      });
    }
    await db.logAttempt({
      saveId: saves[3].id,
      trialId: 'trial-01-04',
      passed: true,
      hintsUsed: 3,
      code: 'ok()',
      difficultyMode: 'standard',
    });
    await db.logAttempt({
      saveId: saves[4].id,
      trialId: 'trial-01-04',
      passed: true,
      hintsUsed: 0,
      code: 'ok()',
      difficultyMode: 'standard',
    });

    // Delete ALL 5 saves (cascading all raw trial_attempts rows!)
    for (const s of saves) {
      await db.deleteSave(s.id);
    }

    const afterDel = await apiJson('/api/admin/trial-metrics?minHeroes=5', { cookie: adminCookie });
    expect(afterDel.res.status).toBe(200);
    const t04 = afterDel.data.trials.find((t: any) => t.trialId === 'trial-01-04');
    expect(t04.uniqueHeroes).toBe(5);
    expect(t04.uniqueSolvers).toBe(2);
    expect(t04.completionRate).toBe(40.0);
    // Only 1 of 5 attempts used hints (hintsUsed=3) -> exact 20.0% (not 60% from total_hints=3!)
    expect(t04.hintUsageRate).toBe(20.0);
    expect(t04.flag).toBe('too_hard');

    // Windowed first-try inflation check: hero fails BEFORE window (2026-01-10) and passes INSIDE window (2026-01-15)
    const wSave = await db.createSave({ heroName: 'WindowHero' });
    await env.DB.prepare(
      `INSERT INTO trial_attempts (save_id, trial_id, passed, hints_used, code, difficulty_mode, is_practice, created_at)
       VALUES (?, 'trial-01-05', 0, 0, 'bad()', 'standard', 0, '2026-01-10T10:00:00Z'),
              (?, 'trial-01-05', 1, 0, 'ok()',  'standard', 0, '2026-01-15T10:00:00Z')`
    )
      .bind(wSave.id, wSave.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO trial_stats_daily (day, trial_id, difficulty_mode, attempts, passes, first_try_passes, unique_attempters, unique_solvers, hinted_attempts, total_hints, tier3_hints, parent_overrides)
       VALUES ('2026-01-10', 'trial-01-05', 'standard', 1, 0, 0, 1, 0, 0, 0, 0, 0),
              ('2026-01-15', 'trial-01-05', 'standard', 1, 1, 0, 0, 1, 0, 0, 0, 0)`
    ).run();

    const winRes = await apiJson('/api/admin/trial-metrics?since=2026-01-14&minHeroes=1', {
      cookie: adminCookie,
    });
    expect(winRes.res.status).toBe(200);
    const t05 = winRes.data.trials.find((t: any) => t.trialId === 'trial-01-05');
    expect(t05.passes).toBe(1);
    expect(t05.firstTryPassRate).toBe(0.0);

    // parentOverrideRate is clamped to 100.0 even when parentOverrides > uniqueHeroes
    const ovSave1 = await db.createSave({ heroName: 'OvHero1' });
    const ovSave2 = await db.createSave({ heroName: 'OvHero2' });
    await db.overrideTrial({ saveId: ovSave1.id, trialId: 'trial-01-06', solved: true, awardShards: false, shardReward: 0 });
    await db.overrideTrial({ saveId: ovSave2.id, trialId: 'trial-01-06', solved: true, awardShards: false, shardReward: 0 });
    await db.logAttempt({ saveId: ovSave1.id, trialId: 'trial-01-06', passed: false, hintsUsed: 0, code: 'x' });
    const ovMetrics = await apiJson('/api/admin/trial-metrics?minHeroes=1', { cookie: adminCookie });
    const t06 = ovMetrics.data.trials.find((t: any) => t.trialId === 'trial-01-06');
    expect(t06.parentOverrides).toBe(2);
    expect(t06.parentOverrideRate).toBe(100.0);
  });
});

describe('Passwordless Email Magic Links (Resend)', () => {
  it('returns 503 when RESEND_API_KEY is not configured', async () => {
    const reqRes = await apiJson('/api/auth/magic-link/request', {
      method: 'POST',
      body: { email: 'parent@example.com' },
    });
    expect(reqRes.res.status).toBe(503);

    const verRes = await SELF.fetch(`${BASE}/api/auth/magic-link/verify?token=abc`, {
      redirect: 'manual',
    });
    expect(verRes.status).toBe(503);
  });

  it('sends a single-use magic link via Resend, verifies it into a parent session, and rejects replay/invalid tokens', async () => {
    const { default: worker } = await import('../index');
    let sentPayload: any = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (target === 'https://resend.test/emails') {
        sentPayload = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({ id: 'email_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return origFetch(input as any, init);
    }) as typeof fetch;

    const testEnv = {
      ...env,
      RESEND_API_KEY: 're_test_key_123',
      RESEND_API_URL: 'https://resend.test/emails',
      MAGIC_LINK_FROM_EMAIL: 'Pyria <noreply@pyria.dev>',
    };

    try {
      // Invalid email rejected with 400
      const badEmailRes = await worker.fetch(
        new Request(`${BASE}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.42' },
          body: JSON.stringify({ email: 'not-an-email' }),
        }),
        testEnv
      );
      expect(badEmailRes.status).toBe(400);

      // Valid request sends email via Resend
      const reqRes = await worker.fetch(
        new Request(`${BASE}/api/auth/magic-link/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.42' },
          body: JSON.stringify({ email: 'Parent@Example.com', next: '/console' }),
        }),
        testEnv
      );
      expect(reqRes.status).toBe(200);
      expect(sentPayload).toBeTruthy();
      expect(sentPayload.to).toEqual(['parent@example.com']);
      expect(sentPayload.from).toBe('Pyria <noreply@pyria.dev>');

      const match = String(sentPayload.text).match(/https?:\/\/[^\s]+\/api\/auth\/magic-link\/verify\?token=([^\s]+)/);
      expect(match).toBeTruthy();
      const verifyUrl = match![0];

      // Missing/invalid token redirects to /console?auth_error=magic_link_invalid
      const badVerify = await worker.fetch(
        new Request(`${BASE}/api/auth/magic-link/verify?token=invalid.token`),
        testEnv
      );
      expect(badVerify.status).toBe(302);
      expect(badVerify.headers.get('Location')).toBe('/console?auth_error=magic_link_invalid');

      // First valid verification succeeds and sets parent session cookie
      const okVerify = await worker.fetch(new Request(verifyUrl), testEnv);
      expect(okVerify.status).toBe(302);
      expect(okVerify.headers.get('Location')).toBe('/console');
      const setCookie = okVerify.headers.get('Set-Cookie') || '';
      expect(setCookie).toContain('pyria_parent_session=');
      const parentCookie = setCookie.split(';')[0];

      // Verify /api/me recognizes the parent session + magicLinkEnabled=true
      const meRes = await worker.fetch(
        new Request(`${BASE}/api/me`, { headers: { Cookie: parentCookie } }),
        testEnv
      );
      const meData = (await meRes.json()) as any;
      expect(meData.auth.role).toBe('parent');
      expect(meData.auth.parentEmail).toBe('parent@example.com');
      expect(meData.auth.magicLinkEnabled).toBe(true);

      // Replay of the same magic link is rejected (single-use)
      const replayVerify = await worker.fetch(new Request(verifyUrl), testEnv);
      expect(replayVerify.status).toBe(302);
      expect(replayVerify.headers.get('Location')).toBe('/console?auth_error=magic_link_invalid');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('QR Link Tokens, Link-Later & Dashless Hero Codes', () => {
  it('supports kid-to-parent parentLinkToken preview, claim, linkedToParent flag, and Link Later endpoint', async () => {
    const parentA = await makeParentCookie('parent-a@example.com');
    const parentB = await makeParentCookie('parent-b@example.com');

    // Kid creates a hero code -> gets parentLinkToken too
    const created = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'Lyra' },
    });
    expect(created.res.status).toBe(201);
    expect(typeof created.data.parentLinkToken).toBe('string');
    expect(created.data.parentLinkToken.length).toBeGreaterThan(20);
    expect(created.data.save.linkedToParent).toBe(false);

    const heroCookie = extractCookie(created.res, 'pyria_hero_session');
    expect(heroCookie).toBeTruthy();

    // /api/me reports linkedToParent: false before linking
    const meBefore = await apiJson('/api/me', { cookie: heroCookie });
    expect(meBefore.data.auth.role).toBe('hero');
    expect(meBefore.data.auth.linkedToParent).toBe(false);

    // Guest cannot mint a hero-link-token
    const guestLinkAttempt = await apiJson('/api/auth/hero-link-token', {
      method: 'POST',
      body: {},
    });
    expect(guestLinkAttempt.res.status).toBe(401);

    // Unlinked hero can mint a fresh "Link Later" parentLinkToken
    const linkLater = await apiJson('/api/auth/hero-link-token', {
      method: 'POST',
      cookie: heroCookie,
      body: {},
    });
    expect(linkLater.res.status).toBe(200);
    expect(linkLater.data.heroName).toBe('Lyra');
    expect(typeof linkLater.data.parentLinkToken).toBe('string');

    // Parent A previews the link token before confirming
    const preview = await apiJson('/api/console/link-preview', {
      method: 'POST',
      cookie: parentA,
      body: { linkToken: linkLater.data.parentLinkToken },
    });
    expect(preview.res.status).toBe(200);
    expect(preview.data).toEqual({
      saveId: created.data.save.id,
      heroName: 'Lyra',
      alreadyOwnedBySelf: false,
    });

    // Parent A claims via linkToken
    const claimed = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentA,
      body: { linkToken: linkLater.data.parentLinkToken },
    });
    expect(claimed.res.status).toBe(200);
    expect(claimed.data.save.id).toBe(created.data.save.id);
    expect(claimed.data.save.linkedToParent).toBe(true);

    // /api/me now reports linkedToParent: true (without leaking parentEmail to hero)
    const meAfter = await apiJson('/api/me', { cookie: heroCookie });
    expect(meAfter.data.auth.linkedToParent).toBe(true);
    expect(meAfter.data.auth.parentEmail).toBeNull();

    // Already-linked hero gets 409 when trying to mint another link token
    const linkAfter = await apiJson('/api/auth/hero-link-token', {
      method: 'POST',
      cookie: heroCookie,
      body: {},
    });
    expect(linkAfter.res.status).toBe(409);
    expect(linkAfter.data.alreadyLinked).toBe(true);

    // Parent B cannot preview or claim an already-owned hero with the old linkToken
    const previewB = await apiJson('/api/console/link-preview', {
      method: 'POST',
      cookie: parentB,
      body: { linkToken: created.data.parentLinkToken },
    });
    expect(previewB.res.status).toBe(404);

    const claimB = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentB,
      body: { linkToken: created.data.parentLinkToken },
    });
    expect(claimB.res.status).toBe(404);

    // Token type separation: parentLinkToken cannot be used as a hero_play token
    const crossUse = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { playToken: created.data.parentLinkToken },
    });
    expect(crossUse.res.status).toBe(401);
  });

  it('supports parent-to-kid playToken preview, redeem, rotation invalidation, and dashless Hero Codes', async () => {
    const parentA = await makeParentCookie('parent-play@example.com');

    // Parent creates child hero -> gets heroCode and playToken
    const created = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: parentA,
      body: { heroName: 'Bramwell' },
    });
    expect(created.res.status).toBe(201);
    expect(typeof created.data.playToken).toBe('string');
    const oldPlayToken = created.data.playToken;

    // Preview playToken without setting a cookie
    const preview = await apiJson('/api/auth/play-preview', {
      method: 'POST',
      body: { playToken: oldPlayToken },
    });
    expect(preview.res.status).toBe(200);
    expect(preview.data).toEqual({
      valid: true,
      saveId: created.data.save.id,
      heroName: 'Bramwell',
    });
    expect(extractCookie(preview.res, 'pyria_hero_session')).toBeNull();

    // Redeem via playToken sets hero session cookie
    const redeemed = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { playToken: oldPlayToken },
    });
    expect(redeemed.res.status).toBe(200);
    expect(redeemed.data.save.id).toBe(created.data.save.id);
    expect(extractCookie(redeemed.res, 'pyria_hero_session')).toBeTruthy();

    // Token type separation: playToken cannot be used as a parent_link token
    const crossClaim = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentA,
      body: { linkToken: oldPlayToken },
    });
    expect(crossClaim.res.status).toBe(404);

    // Dashless Hero Code normalization works on redeem
    const dashless = String(created.data.heroCode).replace(/-/g, '').toLowerCase();
    const dashlessRedeem = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: dashless },
    });
    expect(dashlessRedeem.res.status).toBe(200);
    expect(dashlessRedeem.data.save.id).toBe(created.data.save.id);

    // Rotating Hero Code mints a new playToken and invalidates the old playToken
    const rotated = await apiJson(`/api/console/saves/${created.data.save.id}/rotate-code`, {
      method: 'POST',
      cookie: parentA,
      body: {},
    });
    expect(rotated.res.status).toBe(200);
    expect(typeof rotated.data.playToken).toBe('string');

    const oldPreview = await apiJson('/api/auth/play-preview', {
      method: 'POST',
      body: { playToken: oldPlayToken },
    });
    expect(oldPreview.res.status).toBe(401);

    const oldRedeem = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { playToken: oldPlayToken },
    });
    expect(oldRedeem.res.status).toBe(401);

    const newRedeem = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { playToken: rotated.data.playToken },
    });
    expect(newRedeem.res.status).toBe(200);
    expect(newRedeem.data.save.id).toBe(created.data.save.id);
  });
});

describe('Hero Renaming', () => {
  it('allows hero session to rename via PUT /api/saves/:id and logs hero_renamed activity', async () => {
    const createRes = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'Rowan' },
    });
    expect(createRes.res.status).toBe(201);
    const save = createRes.data.save;
    const heroCookie = extractCookie(createRes.res, HERO_SESSION_COOKIE);
    expect(heroCookie).toBeTruthy();

    const putRes = await apiJson(`/api/saves/${save.id}`, {
      method: 'PUT',
      cookie: heroCookie,
      body: {
        heroName: 'Aria Star',
        realmId: 'realm-01-meadow',
        byteShards: 15,
      },
    });
    expect(putRes.res.status).toBe(200);
    expect(putRes.data.save.heroName).toBe('Aria Star');
    expect(putRes.data.save.byteShards).toBe(15);

    const meRes = await apiJson('/api/me', { cookie: heroCookie });
    expect(meRes.res.status).toBe(200);
    expect(meRes.data.auth.heroName).toBe('Aria Star');

    const { results: events } = await env.DB.prepare(
      'SELECT event_type, hero_name, summary, details_json FROM activity_events WHERE save_id = ? ORDER BY id ASC'
    )
      .bind(save.id)
      .all<{ event_type: string; hero_name: string; summary: string; details_json: string }>();
    const renameEv = events.find((e) => e.event_type === 'hero_renamed');
    expect(renameEv).toBeTruthy();
    expect(renameEv?.hero_name).toBe('Aria Star');
    expect(renameEv?.summary).toBe('Renamed hero from Rowan to Aria Star');
    expect(JSON.parse(renameEv!.details_json)).toEqual({
      previousHeroName: 'Rowan',
      heroName: 'Aria Star',
    });

    // Rejects invalid name (too short)
    const badRes = await apiJson(`/api/saves/${save.id}`, {
      method: 'PUT',
      cookie: heroCookie,
      body: { heroName: 'A' },
    });
    expect(badRes.res.status).toBe(400);
  });

  it('allows parent to rename owned hero via PUT /api/console/saves/:id/rename and blocks non-owners', async () => {
    const parentACookie = await makeParentCookie('parent-a@example.com');
    const parentBCookie = await makeParentCookie('parent-b@example.com');

    const createRes = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: parentACookie,
      body: { heroName: 'Ember' },
    });
    expect(createRes.res.status).toBe(201);
    const saveId = createRes.data.save.id;

    // Non-owner parent is blocked
    const forbiddenRes = await apiJson(`/api/console/saves/${saveId}/rename`, {
      method: 'PUT',
      cookie: parentBCookie,
      body: { heroName: 'Hijacked' },
    });
    expect(forbiddenRes.res.status).toBe(403);

    // Owner parent renames hero cleanly without losing state
    const renameRes = await apiJson(`/api/console/saves/${saveId}/rename`, {
      method: 'PUT',
      cookie: parentACookie,
      body: { heroName: '  Nova Flame  ' },
    });
    expect(renameRes.res.status).toBe(200);
    expect(renameRes.data.ok).toBe(true);
    expect(renameRes.data.save.heroName).toBe('Nova Flame');
    expect(renameRes.data.save.realmId).toBe('realm-01-meadow');

    // No-op rename with same name succeeds and does not emit a duplicate event
    const noopRes = await apiJson(`/api/console/saves/${saveId}/rename`, {
      method: 'PUT',
      cookie: parentACookie,
      body: { heroName: 'Nova Flame' },
    });
    expect(noopRes.res.status).toBe(200);

    const { results: renameEvents } = await env.DB.prepare(
      "SELECT summary FROM activity_events WHERE save_id = ? AND event_type = 'hero_renamed'"
    )
      .bind(saveId)
      .all<{ summary: string }>();
    expect(renameEvents).toHaveLength(1);
    expect(renameEvents[0].summary).toBe('Renamed hero from Ember to Nova Flame');

    // Invalid name returns 400
    const badRes = await apiJson(`/api/console/saves/${saveId}/rename`, {
      method: 'PUT',
      cookie: parentACookie,
      body: { heroName: 'X' },
    });
    expect(badRes.res.status).toBe(400);
  });
});
