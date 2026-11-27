import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GUEST_SAVES_STORAGE_KEY,
  buildCleanSavePayload,
  createDefaultSaveState,
  createGuestSave,
  createHeroCode,
  createSave,
  deleteGuestSave,
  fetchConfig,
  fetchEra,
  fetchMap,
  fetchMe,
  fetchSpriteManifest,
  fetchTilesetManifest,
  getGuestSave,
  getSave,
  isGuestMode,
  listGuestSaves,
  listSaves,
  logAttempt,
  logoutSession,
  normalizeMe,
  normalizeSave,
  redeemHeroCode,
  resetMeCache,
  updateGuestSave,
  updateSave,
} from './api.js';

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
    removeItem(k) {
      store.delete(k);
    },
    clear() {
      store.clear();
    },
  };
}

function jsonRes(body, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      return body;
    },
  };
}

test('normalizeMe and isGuestMode normalize both cloudflare and local payloads', () => {
  const cfGuest = normalizeMe({
    mode: 'cloudflare',
    auth: { role: 'guest', googleOAuthEnabled: true },
  });
  assert.equal(cfGuest.mode, 'cloudflare');
  assert.equal(cfGuest.auth.role, 'guest');
  assert.equal(cfGuest.authenticated, false);
  assert.equal(cfGuest.auth.googleOAuthEnabled, true);
  assert.equal(isGuestMode(cfGuest), true);

  const localAdmin = normalizeMe({
    authenticated: true,
    email: 'admin@pyria.test',
    isAdmin: true,
    accounts: ['admin@pyria.test'],
  });
  assert.equal(localAdmin.mode, 'local');
  assert.equal(localAdmin.auth.role, 'admin');
  assert.equal(localAdmin.email, 'admin@pyria.test');
  assert.deepEqual(localAdmin.accounts, ['admin@pyria.test']);
  assert.equal(isGuestMode(localAdmin), false);

  const heroOnly = normalizeMe({
    mode: 'cloudflare',
    auth: { heroSaveId: 'save-1', heroName: 'Rowan' },
  });
  assert.equal(heroOnly.auth.role, 'hero');
  assert.equal(heroOnly.authenticated, true);
  assert.equal(isGuestMode(heroOnly), false);
});

test('normalizeSave and buildCleanSavePayload merge nested state, dedupe trials, and strip extra fields', () => {
  const fallback = normalizeSave(null);
  assert.equal(fallback.heroName, 'Rowan');
  assert.equal(fallback.eraId, 'era-01-8bit');

  const norm = normalizeSave({
    id: 'guest-123',
    hero_name: 'Aria',
    owner_email: 'parent@example.com',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    state: {
      byteShards: 45,
      appearance: { hair: 'braided' },
      solvedTrials: ['t1', 't2'],
      completedTrials: ['t2', 't3'],
      stats: { charisma: 3 },
      trialDrafts: { t4: 'print(1)' },
    },
    preferences: { difficulty: 'explorer' },
    unknownClientField: 'should-be-stripped',
  });

  assert.equal(norm.heroName, 'Aria');
  assert.equal(norm.byteShards, 45);
  assert.equal(norm.appearance.hair, 'braided');
  assert.equal(norm.appearance.tunic, 'emerald'); // default preserved
  assert.deepEqual(norm.solvedTrials, ['t1', 't2', 't3']);
  assert.deepEqual(norm.completedTrials, ['t1', 't2', 't3']);
  assert.deepEqual(norm.stats, { charisma: 3, courage: 0 });
  assert.equal(norm.isGuest, true);
  assert.equal(norm.createdAt, '2026-01-01T00:00:00Z');
  assert.equal(norm.updatedAt, '2026-01-02T00:00:00Z');
  assert.deepEqual(norm.preferences, { difficulty: 'explorer' });

  const clean = buildCleanSavePayload(norm, { includeHeroName: true, includeOwnerEmail: true });
  assert.equal(clean.heroName, 'Aria');
  assert.equal(clean.ownerEmail, 'parent@example.com');
  assert.equal('id' in clean, false);
  assert.equal('isGuest' in clean, false);
  assert.equal('unknownClientField' in clean, false);

  const withoutName = buildCleanSavePayload(norm, { includeHeroName: false, includeOwnerEmail: false });
  assert.equal('heroName' in withoutName, false);
  assert.equal('ownerEmail' in withoutName, false);

  const def = createDefaultSaveState('Nova', { tunic: 'violet' });
  assert.equal(def.heroName, 'Nova');
  assert.equal(def.appearance.tunic, 'violet');
});

test('guest localStorage CRUD handles create, sort, get, update, delete, and corrupt JSON', () => {
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: makeLocalStorage(),
    configurable: true,
    writable: true,
  });
  try {
    // Corrupted JSON recovers cleanly
    globalThis.localStorage.setItem(GUEST_SAVES_STORAGE_KEY, '{not-json');
    assert.deepEqual(listGuestSaves(), []);

    // Sorting by updatedAt descending with explicit distinct timestamps
    globalThis.localStorage.setItem(
      GUEST_SAVES_STORAGE_KEY,
      JSON.stringify([
        { id: 'guest-old', heroName: 'OldHero', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'guest-new', heroName: 'NewHero', updatedAt: '2026-06-01T00:00:00.000Z' },
      ])
    );
    assert.deepEqual(
      listGuestSaves().map((s) => s.id),
      ['guest-new', 'guest-old']
    );

    // Clear and test full create/get/update/delete lifecycle
    globalThis.localStorage.clear();
    const s1 = createGuestSave({ heroName: 'FirstHero', byteShards: 10 });
    assert.ok(s1.id.startsWith('guest-'));
    assert.equal(s1.isGuest, true);

    const s2 = createGuestSave({ heroName: 'SecondHero', byteShards: 20 });
    assert.equal(listGuestSaves().length, 2);
    assert.equal(getGuestSave(s1.id)?.heroName, 'FirstHero');
    assert.equal(getGuestSave(null), null);
    assert.equal(getGuestSave('missing'), null);

    // Update existing guest save
    const updated = updateGuestSave(s1.id, { byteShards: 99 });
    assert.equal(updated?.byteShards, 99);
    assert.equal(getGuestSave(s1.id)?.byteShards, 99);

    // Updating a missing/deleted guest save returns null without re-inserting
    assert.equal(updateGuestSave('guest-deleted', { byteShards: 5 }), null);
    assert.equal(updateGuestSave(null, { byteShards: 5 }), null);
    assert.equal(listGuestSaves().length, 2);

    // Delete
    deleteGuestSave(s2.id);
    deleteGuestSave(null);
    assert.deepEqual(
      listGuestSaves().map((s) => s.id),
      [s1.id]
    );

    // Storage write error (e.g. QuotaExceededError) is caught cleanly without throwing
    const throwingStorage = {
      getItem: () => '[]',
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: throwingStorage,
      configurable: true,
      writable: true,
    });
    const prevWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const created = createGuestSave({ heroName: 'QuotaHero' });
      assert.equal(created.heroName, 'QuotaHero');
      assert.equal(warned, true);
    } finally {
      console.warn = prevWarn;
    }
  } finally {
    if (prevDesc) {
      Object.defineProperty(globalThis, 'localStorage', prevDesc);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('remote API helpers send expected requests, normalize responses, and surface structured errors', async () => {
  const prevFetch = globalThis.fetch;
  const calls = [];
  let nextResponse = () => jsonRes({});

  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return nextResponse(url, opts);
  };

  try {
    // 1. Reset cached /api/me state so test is order-independent
    resetMeCache();
    nextResponse = () => {
      throw new Error('offline');
    };
    const fallbackMe = await fetchMe();
    assert.equal(fallbackMe.mode, 'cloudflare');
    assert.equal(fallbackMe.auth.role, 'guest');

    // 2. fetchMe succeeds and caches lastKnownMe on subsequent transient error
    nextResponse = () =>
      jsonRes({
        mode: 'cloudflare',
        auth: { role: 'parent', parentEmail: 'p@example.com', isAdmin: false, googleOAuthEnabled: true },
      });
    const liveMe = await fetchMe();
    assert.equal(liveMe.auth.role, 'parent');
    assert.equal(calls.at(-1).opts.cache, 'no-store');

    nextResponse = () => {
      throw new Error('transient');
    };
    const cachedMe = await fetchMe();
    assert.equal(cachedMe.auth.parentEmail, 'p@example.com');

    // 3. Content & config loaders
    nextResponse = () => jsonRes({ ok: true });
    await fetchConfig();
    assert.equal(calls.at(-1).url, '/api/config');
    await fetchEra('era-01-8bit');
    assert.equal(calls.at(-1).url, '/content/eras/era-01-8bit.json');
    await fetchMap('realm-01-meadow');
    assert.equal(calls.at(-1).url, '/content/maps/realm-01-meadow.json');
    await fetchSpriteManifest();
    assert.ok(calls.at(-1).url.startsWith('/assets/sprites/manifest.json'));
    await fetchTilesetManifest();
    assert.ok(calls.at(-1).url.startsWith('/assets/tilesets/manifest.json'));

    // 4. Saves CRUD (including no ownerFilter, POST body, GET URL, and PUT stripping ownerEmail)
    nextResponse = () => jsonRes({ saves: [{ id: 's1', heroName: 'Rowan' }] });
    await listSaves();
    assert.equal(calls.at(-1).url, '/api/saves');
    const saves = await listSaves('a@b.com');
    assert.equal(calls.at(-1).url, '/api/saves?owner=a%40b.com');
    assert.equal(saves[0].isGuest, false);

    nextResponse = () => jsonRes({ save: { id: 's2', heroName: 'Leo' } }, 201);
    const created = await createSave({ heroName: 'Leo', ownerEmail: 'a@b.com' });
    assert.equal(calls.at(-1).opts.method, 'POST');
    assert.equal(JSON.parse(calls.at(-1).opts.body).heroName, 'Leo');
    assert.equal(JSON.parse(calls.at(-1).opts.body).ownerEmail, 'a@b.com');
    assert.equal(created.id, 's2');

    nextResponse = () => jsonRes({ save: { id: 's2', heroName: 'Leo' } });
    const fetched = await getSave('s2');
    assert.equal(calls.at(-1).url, '/api/saves/s2');
    assert.equal(fetched.id, 's2');

    const updated = await updateSave(
      's2',
      { heroName: 'Leo', byteShards: 50, ownerEmail: 'should-strip@x.test' },
      { keepalive: true }
    );
    assert.equal(calls.at(-1).url, '/api/saves/s2');
    assert.equal(calls.at(-1).opts.method, 'PUT');
    assert.equal(calls.at(-1).opts.keepalive, true);
    assert.equal('ownerEmail' in JSON.parse(calls.at(-1).opts.body), false);
    assert.equal(updated.id, 's2');

    // 5. logAttempt skips guest saves and posts cloud saves
    const skipped = await logAttempt('guest-123', { trialId: 't1', passed: true, hintsUsed: 0, code: '' });
    assert.deepEqual(skipped, { ok: false, skipped: true });

    nextResponse = () => jsonRes({ ok: true, attemptId: 7 }, 201);
    const logged = await logAttempt('s2', { trialId: 't1', passed: true, hintsUsed: 2, code: 'print(1)' });
    assert.equal(logged.attemptId, 7);
    assert.equal(calls.at(-1).url, '/api/saves/s2/attempts');

    // 6. Hero Codes (with and without state) & Logout
    nextResponse = () => jsonRes({ save: { id: 's3', heroName: 'Pip' }, heroCode: 'AMBER-FOX-123456' }, 201);
    const hcBare = await createHeroCode('Pip');
    assert.equal(hcBare.heroCode, 'AMBER-FOX-123456');
    assert.deepEqual(JSON.parse(calls.at(-1).opts.body), { heroName: 'Pip' });

    const hc = await createHeroCode('  Pip  ', { byteShards: 12 });
    assert.equal(hc.heroCode, 'AMBER-FOX-123456');
    const hcBody = JSON.parse(calls.at(-1).opts.body);
    assert.equal(hcBody.heroName, 'Pip');
    assert.equal(hcBody.state.byteShards, 12);

    nextResponse = () => jsonRes({ save: { id: 's3', heroName: 'Pip' } });
    const redeemed = await redeemHeroCode('  amber-fox-123456 ');
    assert.equal(calls.at(-1).url, '/api/auth/hero-code/redeem');
    assert.equal(redeemed.save.id, 's3');
    assert.deepEqual(JSON.parse(calls.at(-1).opts.body), { heroCode: 'AMBER-FOX-123456' });

    nextResponse = () => jsonRes({ ok: true });
    await logoutSession('hero');
    assert.equal(calls.at(-1).url, '/api/auth/logout');
    assert.deepEqual(JSON.parse(calls.at(-1).opts.body), { scope: 'hero' });

    // 7. Non-2xx JSON and non-JSON error responses throw Error with status and detail
    nextResponse = () => jsonRes({ error: 'Rate limit exceeded' }, 429, 'Too Many Requests');
    await assert.rejects(
      () => redeemHeroCode('BAD-CODE-000000'),
      (err) => err instanceof Error && err.status === 429 && err.detail === 'Rate limit exceeded'
    );

    nextResponse = () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      async json() {
        throw new SyntaxError('not json');
      },
    });
    await assert.rejects(
      () => fetchConfig(),
      (err) => err instanceof Error && err.status === 502 && err.detail === '502 Bad Gateway'
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});
