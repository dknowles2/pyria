import { generateUniqueHeroCodeHash, getSessionSecret } from './auth';
import { hashHeroCode, normalizeHeroCode } from './crypto';
import { PyriaD1 } from './db';
import { jsonResponse } from './security';
import type { AuthContext, Env, SavePreferences } from './types';
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
      return jsonResponse({ save, heroCode }, 201);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof QuotaError) {
        return jsonResponse({ error: err.message }, err.status);
      }
      throw err;
    }
  }

  // POST /api/console/claim-hero
  if (method === 'POST' && pathname === '/api/console/claim-hero') {
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
      return jsonResponse({ error: 'Hero Code not found' }, 404);
    }

    const currentOwner = normalizeEmail(row.owner_email);
    if (currentOwner && currentOwner !== auth.parentEmail) {
      return jsonResponse(
        { error: 'This hero is already linked to another parent account' },
        409
      );
    }

    if (currentOwner === auth.parentEmail) {
      return jsonResponse({ save: PyriaD1.rowToSave(row) }, 200);
    }

    // Enforce 10 heroes per parent account cap before claiming
    const currentCount = await db.countAccountSaves(auth.parentEmail!);
    if (currentCount >= db.maxSavesPerAccount) {
      return jsonResponse(
        { error: `Save limit reached (${db.maxSavesPerAccount} heroes per parent account)` },
        429
      );
    }

    const claimed = await db.assignOwner(row.id, auth.parentEmail!);
    return jsonResponse({ save: claimed }, 200);
  }

  // Routes under /api/console/saves/:id/<action>
  if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'console' && parts[2] === 'saves') {
    const saveId = decodeURIComponent(parts[3]);
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
      return jsonResponse({
        saveId: rotated.saveId,
        heroCode,
        sessionVersion: rotated.sessionVersion,
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
