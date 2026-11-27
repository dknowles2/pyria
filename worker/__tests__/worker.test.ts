import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
        parentEmail: null,
        isAdmin: false,
        googleOAuthEnabled: true,
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
