// REST API & content loader for Pyria

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const errBody = await res.json();
      if (errBody && errBody.error) detail = errBody.error;
    } catch {
      // ignore parse failure
    }
    throw new Error(`API error (${url}): ${detail}`);
  }
  return res.json();
}

export function createDefaultSaveState(heroName = 'Rowan', appearance = {}) {
  return {
    heroName,
    appearance: {
      skin: appearance.skin || 'warm_tan',
      hair: appearance.hair || 'spiky',
      tunic: appearance.tunic || 'emerald',
      hat: appearance.hat || null,
      boots: appearance.boots || 'boots_default',
      shield: appearance.shield || null,
      cloak: appearance.cloak || null,
      aura: appearance.aura || null,
      pipScarf: appearance.pipScarf || null,
    },
    eraId: 'era-01-8bit',
    realmId: 'realm-01-meadow',
    visualEra: '8bit',
    byteShards: 0,
    stats: {
      charisma: 0,
      courage: 0,
    },
    completedTrials: [],
    rescuedDragons: [],
    openedChests: [],
    ownedUnlockIds: [],
    position: null,
  };
}

/**
 * Normalizes a save payload from the server regardless of whether state fields
 * are top-level or nested under `state`.
 */
export function normalizeSave(raw) {
  if (!raw || typeof raw !== 'object') {
    return createDefaultSaveState();
  }
  const nested = raw.state && typeof raw.state === 'object' ? raw.state : {};
  const merged = { ...nested, ...raw };
  const defaults = createDefaultSaveState(
    merged.heroName || merged.hero_name || 'Code-Tamer',
    merged.appearance || {}
  );

  return {
    id: merged.id || raw.id || null,
    heroName: merged.heroName || merged.hero_name || defaults.heroName,
    appearance: {
      ...defaults.appearance,
      ...(merged.appearance || {}),
    },
    eraId: merged.eraId || defaults.eraId,
    realmId: merged.realmId || defaults.realmId,
    visualEra: merged.visualEra || defaults.visualEra,
    byteShards: Number.isFinite(merged.byteShards) ? merged.byteShards : defaults.byteShards,
    stats: {
      charisma: merged.stats?.charisma ?? 0,
      courage: merged.stats?.courage ?? 0,
    },
    completedTrials: Array.isArray(merged.completedTrials) ? [...merged.completedTrials] : [],
    rescuedDragons: Array.isArray(merged.rescuedDragons) ? [...merged.rescuedDragons] : [],
    openedChests: Array.isArray(merged.openedChests) ? [...merged.openedChests] : [],
    ownedUnlockIds: Array.isArray(merged.ownedUnlockIds) ? [...merged.ownedUnlockIds] : [],
    position: merged.position || null,
    createdAt: merged.createdAt || merged.created_at || null,
    updatedAt: merged.updatedAt || merged.updated_at || null,
  };
}

export async function fetchConfig() {
  return requestJson('/api/config');
}

export async function fetchEra(eraId) {
  return requestJson(`/content/eras/${encodeURIComponent(eraId)}.json`);
}

export async function fetchMap(realmId) {
  return requestJson(`/content/maps/${encodeURIComponent(realmId)}.json`);
}

export async function fetchSpriteManifest() {
  return requestJson('/assets/sprites/manifest.json');
}

export async function fetchTilesetManifest() {
  return requestJson('/assets/tilesets/manifest.json');
}

export async function listSaves() {
  const data = await requestJson('/api/saves');
  const list = Array.isArray(data.saves) ? data.saves : [];
  return list.map(normalizeSave);
}

export async function createSave(saveData) {
  const data = await requestJson('/api/saves', {
    method: 'POST',
    body: JSON.stringify(saveData),
  });
  return normalizeSave(data.save || data);
}

export async function getSave(id) {
  const data = await requestJson(`/api/saves/${encodeURIComponent(id)}`);
  return normalizeSave(data.save || data);
}

export async function updateSave(id, saveData) {
  const data = await requestJson(`/api/saves/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(saveData),
  });
  return normalizeSave(data.save || data);
}

export async function logAttempt(saveId, { trialId, passed, hintsUsed, code }) {
  if (!saveId) return { ok: false };
  return requestJson(`/api/saves/${encodeURIComponent(saveId)}/attempts`, {
    method: 'POST',
    body: JSON.stringify({
      trialId,
      passed: Boolean(passed),
      hintsUsed: Number(hintsUsed) || 0,
      code: String(code || ''),
    }),
  });
}
