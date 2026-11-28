import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HERO_SESSION_COOKIE,
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_SECONDS,
  signToken,
} from '../crypto';
import type { ParentSessionPayload } from '../types';

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

describe('Worker API saves, attempts, health & static fallback edge cases', () => {
  it('supports parent & admin POST/GET/PUT /api/saves, attempts listing, and admin health saveCount', async () => {
    const parentCookie = await makeParentCookie('parent@example.com');
    const adminCookie = await makeParentCookie('admin@pyria.test');

    // Parent creates save using { save: {...} } wrapper
    const created = await apiJson('/api/saves', {
      method: 'POST',
      cookie: parentCookie,
      body: { save: { heroName: 'Ember', ownerEmail: 'spoof@evil.test' } },
    });
    expect(created.res.status).toBe(201);
    expect(created.data.save.ownerEmail).toBe('parent@example.com');
    const saveId = created.data.save.id;

    // Admin creates save assigned to another owner
    const adminCreated = await apiJson('/api/saves', {
      method: 'POST',
      cookie: adminCookie,
      body: { heroName: 'Cobalt', ownerEmail: 'other@example.com' },
    });
    expect(adminCreated.res.status).toBe(201);
    expect(adminCreated.data.save.ownerEmail).toBe('other@example.com');

    // GET /api/saves scoping: parent sees own, admin sees all or filtered by ?owner=
    const parentList = await apiJson('/api/saves', { cookie: parentCookie });
    expect(parentList.data.saves.map((s: any) => s.heroName)).toEqual(['Ember']);

    const adminAll = await apiJson('/api/saves?owner=all', { cookie: adminCookie });
    expect(adminAll.data.saves.length).toBe(2);

    const adminFiltered = await apiJson('/api/saves?owner=other@example.com', { cookie: adminCookie });
    expect(adminFiltered.data.saves.map((s: any) => s.heroName)).toEqual(['Cobalt']);

    // Admin /api/health exposes saveCount; parent does not
    const parentHealth = await apiJson('/api/health', { cookie: parentCookie });
    expect(parentHealth.data.saveCount).toBeUndefined();
    const adminHealth = await apiJson('/api/health', { cookie: adminCookie });
    expect(adminHealth.data.saveCount).toBe(2);

    // PUT /api/saves/:id with { save: {...} } wrapper
    const putWrap = await apiJson(`/api/saves/${saveId}`, {
      method: 'PUT',
      cookie: parentCookie,
      body: { save: { heroName: 'Ember', byteShards: 88 } },
    });
    expect(putWrap.res.status).toBe(200);
    expect(putWrap.data.save.byteShards).toBe(88);

    // Log and list attempts
    const att = await apiJson(`/api/saves/${saveId}/attempts`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01-01', passed: true, hintsUsed: 0, code: 'say("hi")' },
    });
    expect(att.res.status).toBe(201);

    const listAtt = await apiJson(`/api/saves/${saveId}/attempts`, { cookie: parentCookie });
    expect(listAtt.res.status).toBe(200);
    expect(listAtt.data.attempts.length).toBe(1);
    expect(listAtt.data.attempts[0].trialId).toBe('trial-01-01');

    // 404 for unknown save & unknown API endpoint
    expect((await apiJson('/api/saves/does-not-exist', { cookie: parentCookie })).res.status).toBe(404);
    expect((await apiJson('/api/saves/does-not-exist/attempts', { cookie: parentCookie })).res.status).toBe(404);
    expect((await apiJson('/api/does-not-exist')).res.status).toBe(404);
  });

  it('serves hero-scoped GET /api/saves and static fallback routes under /console/* and /admin/*', async () => {
    const created = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { save: { heroName: 'Starlight' } },
    });
    expect(created.res.status).toBe(201);
    const heroCookie = extractCookie(created.res, HERO_SESSION_COOKIE);

    // Seed a second hero so hero-scoping is actually proven (not tautological)
    const other = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'OtherHero' },
    });
    expect(other.res.status).toBe(201);

    const list = await apiJson('/api/saves', { cookie: heroCookie });
    expect(list.res.status).toBe(200);
    expect(list.data.saves.map((s: any) => s.heroName)).toEqual(['Starlight']);

    // /console/builder.js and /admin/builder.css fallback to /builder/* with proper MIME types
    const jsRes = await SELF.fetch(`${BASE}/console/builder.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('Content-Type')).toMatch(/javascript/i);
    expect(jsRes.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const cssRes = await SELF.fetch(`${BASE}/admin/builder.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('Content-Type')).toMatch(/text\/css/i);
    expect(cssRes.headers.get('X-Content-Type-Options')).toBe('nosniff');

    // HEAD on SPA route and /console
    for (const p of ['/new', '/console']) {
      const res = await SELF.fetch(`${BASE}${p}`, { method: 'HEAD' });
      expect(res.status, p).toBe(200);
      expect(await res.text()).toBe('');
    }
  });
});

describe('Worker Auth & Console error paths', () => {
  it('handles Google OAuth error responses, upstream 502s, and unverified email 403', async () => {
    // OAuth error query param
    const denied = await SELF.fetch(`${BASE}/api/auth/google/callback?error=access_denied`, {
      redirect: 'manual',
    });
    expect(denied.status).toBe(400);

    // Missing code/state
    const missing = await SELF.fetch(`${BASE}/api/auth/google/callback`, { redirect: 'manual' });
    expect(missing.status).toBe(400);

    // Helper to get a valid OAuth state + cookie
    const getOAuthState = async () => {
      const start = await SELF.fetch(`${BASE}/api/auth/google/start?next=/console`, {
        redirect: 'manual',
      });
      const authUrl = new URL(start.headers.get('Location')!);
      return {
        state: authUrl.searchParams.get('state')!,
        cookie: extractCookie(start, 'pyria_oauth_state')!,
      };
    };

    const origFetch = globalThis.fetch.bind(globalThis);

    // 1. Token endpoint returns 500 -> 502
    const s1 = await getOAuthState();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u === 'https://oauth2.googleapis.com/token') return new Response('err', { status: 500 });
      return origFetch(input, init);
    });
    const cb1 = await SELF.fetch(
      `${BASE}/api/auth/google/callback?code=c&state=${encodeURIComponent(s1.state)}`,
      { headers: { Cookie: s1.cookie }, redirect: 'manual' }
    );
    expect(cb1.status).toBe(502);
    vi.restoreAllMocks();

    // 2. Token endpoint missing access_token -> 502
    const s2 = await getOAuthState();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return origFetch(input, init);
    });
    const cb2 = await SELF.fetch(
      `${BASE}/api/auth/google/callback?code=c&state=${encodeURIComponent(s2.state)}`,
      { headers: { Cookie: s2.cookie }, redirect: 'manual' }
    );
    expect(cb2.status).toBe(502);
    vi.restoreAllMocks();

    // 3. Userinfo endpoint returns 500 -> 502
    const s3 = await getOAuthState();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === 'https://openidconnect.googleapis.com/v1/userinfo') return new Response('err', { status: 500 });
      return origFetch(input, init);
    });
    const cb3 = await SELF.fetch(
      `${BASE}/api/auth/google/callback?code=c&state=${encodeURIComponent(s3.state)}`,
      { headers: { Cookie: s3.cookie }, redirect: 'manual' }
    );
    expect(cb3.status).toBe(502);
    vi.restoreAllMocks();

    // 4. Unverified email -> 403
    const s4 = await getOAuthState();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (u === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return new Response(JSON.stringify({ email: 'u@example.com', email_verified: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return origFetch(input, init);
    });
    const cb4 = await SELF.fetch(
      `${BASE}/api/auth/google/callback?code=c&state=${encodeURIComponent(s4.state)}`,
      { headers: { Cookie: s4.cookie }, redirect: 'manual' }
    );
    expect(cb4.status).toBe(403);
  });

  it('handles logout scopes, redeem validation, and console error/edge paths', async () => {
    // Logout with empty body (clears both), hero scope (clears ONLY hero), and invalid scope
    const emptyLogout = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: BASE },
    });
    expect(emptyLogout.status).toBe(200);
    const cleared = emptyLogout.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith(`${HERO_SESSION_COOKIE}=;`) && c.includes('Max-Age=0'))).toBe(
      true
    );
    expect(cleared.some((c) => c.startsWith(`${PARENT_SESSION_COOKIE}=;`) && c.includes('Max-Age=0'))).toBe(
      true
    );

    const heroLogout = await apiJson('/api/auth/logout', { method: 'POST', body: { scope: 'hero' } });
    expect(heroLogout.res.status).toBe(200);
    const heroCleared = heroLogout.res.headers.getSetCookie();
    expect(
      heroCleared.some((c) => c.startsWith(`${HERO_SESSION_COOKIE}=;`) && c.includes('Max-Age=0'))
    ).toBe(true);
    expect(heroCleared.some((c) => c.startsWith(`${PARENT_SESSION_COOKIE}=`))).toBe(false);

    const badScope = await apiJson('/api/auth/logout', { method: 'POST', body: { scope: 'bogus' } });
    expect(badScope.res.status).toBe(400);

    // Redeem too-short Hero Code -> 400
    const shortRedeem = await apiJson('/api/auth/hero-code/redeem', {
      method: 'POST',
      body: { heroCode: 'AB' },
    });
    expect(shortRedeem.res.status).toBe(400);

    const parentCookie = await makeParentCookie('console-edge@example.com');
    const adminCookie = await makeParentCookie('admin@pyria.test');

    // Invalid preferences on create -> 400
    expect(
      (
        await apiJson('/api/console/heroes', {
          method: 'POST',
          cookie: parentCookie,
          body: { heroName: 'ValidHero', preferences: [] },
        })
      ).res.status
    ).toBe(400);
    expect(
      (
        await apiJson('/api/console/heroes', {
          method: 'POST',
          cookie: parentCookie,
          body: { heroName: 'ValidHero', preferences: { difficulty: 'invalid' } },
        })
      ).res.status
    ).toBe(400);

    // Create valid hero via console
    const hero = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: parentCookie,
      body: { heroName: 'Zephyr', appearance: { hair: 'spiky' } },
    });
    expect(hero.res.status).toBe(201);
    const saveId = hero.data.save.id;

    // Claiming hero already owned by self returns 200 idempotently
    const reClaim = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentCookie,
      body: { heroCode: hero.data.heroCode },
    });
    expect(reClaim.res.status).toBe(200);

    // Short claim code -> 400
    expect(
      (
        await apiJson('/api/console/claim-hero', {
          method: 'POST',
          cookie: parentCookie,
          body: { heroCode: 'NO' },
        })
      ).res.status
    ).toBe(400);

    // Seed a second parent's hero so admin ?owner= activity filtering is proven non-tautological
    const otherParentCookie = await makeParentCookie('other-parent@example.com');
    const otherHero = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: otherParentCookie,
      body: { heroName: 'Bramble' },
    });
    expect(otherHero.res.status).toBe(201);

    // Admin activity filtering returns ONLY events for console-edge@example.com
    const adminAct = await apiJson('/api/console/activity?since=0&limit=10&owner=console-edge@example.com', {
      cookie: adminCookie,
    });
    expect(adminAct.res.status).toBe(200);
    expect(adminAct.data.events.length).toBeGreaterThanOrEqual(1);
    expect(adminAct.data.events.every((e: any) => e.saveId === saveId)).toBe(true);

    // Override-trial validation errors & awardShards: false
    expect(
      (
        await apiJson(`/api/console/saves/${saveId}/override-trial`, {
          method: 'POST',
          cookie: parentCookie,
          body: { trialId: '', solved: true },
        })
      ).res.status
    ).toBe(400);
    expect(
      (
        await apiJson(`/api/console/saves/${saveId}/override-trial`, {
          method: 'POST',
          cookie: parentCookie,
          body: { trialId: 'trial-01-01', solved: 'yes' },
        })
      ).res.status
    ).toBe(400);
    const noShards = await apiJson(`/api/console/saves/${saveId}/override-trial`, {
      method: 'POST',
      cookie: parentCookie,
      body: { trialId: 'trial-01-01', solved: true, awardShards: false },
    });
    expect(noShards.res.status).toBe(200);
    expect(noShards.data.shardsDelta).toBe(0);
    expect(noShards.data.save.state.solvedTrials).toContain('trial-01-01');
    expect(noShards.data.save.state.byteShards).toBe(0);

    // Preferences validation error
    expect(
      (
        await apiJson(`/api/console/saves/${saveId}/preferences`, {
          method: 'PUT',
          cookie: parentCookie,
          body: { maxPipHints: 99 },
        })
      ).res.status
    ).toBe(400);

    // Assign-owner validation errors & null unassign & 404
    expect(
      (
        await apiJson(`/api/console/saves/${saveId}/assign-owner`, {
          method: 'POST',
          cookie: adminCookie,
          body: {},
        })
      ).res.status
    ).toBe(400);
    expect(
      (
        await apiJson(`/api/console/saves/${saveId}/assign-owner`, {
          method: 'POST',
          cookie: adminCookie,
          body: { ownerEmail: 123 },
        })
      ).res.status
    ).toBe(400);
    expect(
      (
        await apiJson('/api/console/saves/missing-id/assign-owner', {
          method: 'POST',
          cookie: adminCookie,
          body: { ownerEmail: null },
        })
      ).res.status
    ).toBe(404);
    const unassign = await apiJson(`/api/console/saves/${saveId}/assign-owner`, {
      method: 'POST',
      cookie: adminCookie,
      body: { ownerEmail: null },
    });
    expect(unassign.res.status).toBe(200);
    expect(unassign.data.save.ownerEmail).toBeNull();

    // Unknown console endpoint & invalid URL encoding
    expect((await apiJson('/api/console/unknown', { cookie: parentCookie })).res.status).toBe(404);
    expect(
      (await apiJson('/api/console/saves/%ZZ/rotate-code', { method: 'POST', cookie: parentCookie })).res
        .status
    ).toBe(400);
  });
});
