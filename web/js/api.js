// REST API, Guest localStorage & content loader for Pyria

export const GUEST_SAVES_STORAGE_KEY = 'pyria_guest_saves';

async function requestJson(url, options = {}) {
  const isApi = String(url || '').startsWith('/api/');
  const fetchOpts = {
    ...(isApi ? { cache: 'no-store' } : {}),
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  };
  const res = await fetch(url, fetchOpts);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const errBody = await res.json();
      if (errBody && errBody.error) detail = errBody.error;
    } catch {
      // ignore parse failure
    }
    const err = new Error(`API error (${url}): ${detail}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

export function normalizeMe(raw) {
  const mode = raw?.mode === 'cloudflare' ? 'cloudflare' : 'local';
  const auth = raw?.auth && typeof raw.auth === 'object' ? raw.auth : {};
  const isAdmin = Boolean(auth.isAdmin ?? raw?.isAdmin);
  const parentEmail = auth.parentEmail ?? raw?.email ?? null;
  const heroSaveId = auth.heroSaveId || null;
  const heroName = auth.heroName || null;
  const role =
    auth.role ||
    (isAdmin ? 'admin' : parentEmail ? 'parent' : heroSaveId ? 'hero' : 'guest');
  const googleOAuthEnabled = Boolean(auth.googleOAuthEnabled);

  return {
    mode,
    auth: {
      role,
      heroSaveId,
      heroName,
      parentEmail,
      isAdmin,
      googleOAuthEnabled,
    },
    authenticated: Boolean(raw?.authenticated ?? (role !== 'guest')),
    email: parentEmail,
    isAdmin,
    accounts: Array.isArray(raw?.accounts) ? raw.accounts : [],
  };
}

export function isGuestMode(me) {
  return me?.mode === 'cloudflare' && me?.auth?.role === 'guest';
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
}

/**
 * Normalizes a save payload from the server or localStorage regardless of
 * whether state fields are top-level or nested under `state`.
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

  const solvedSet = new Set([
    ...(Array.isArray(merged.solvedTrials) ? merged.solvedTrials : []),
    ...(Array.isArray(merged.completedTrials) ? merged.completedTrials : []),
  ]);
  const solvedTrials = [...solvedSet];

  const prefs =
    raw.preferences && typeof raw.preferences === 'object'
      ? { ...raw.preferences }
      : merged.preferences && typeof merged.preferences === 'object'
        ? { ...merged.preferences }
        : null;

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
    solvedTrials,
    completedTrials: [...solvedTrials],
    trialDrafts: merged.trialDrafts && typeof merged.trialDrafts === 'object' ? { ...merged.trialDrafts } : {},
    seenCutscenes: Array.isArray(merged.seenCutscenes) ? [...merged.seenCutscenes] : [],
    foundEasterEggs: Array.isArray(merged.foundEasterEggs) ? [...merged.foundEasterEggs] : [],
    unlockedSpells: Array.isArray(merged.unlockedSpells) ? [...merged.unlockedSpells] : [],
    rescuedDragons: Array.isArray(merged.rescuedDragons) ? [...merged.rescuedDragons] : [],
    openedChests: Array.isArray(merged.openedChests) ? [...merged.openedChests] : [],
    ownedUnlockIds: Array.isArray(merged.ownedUnlockIds) ? [...merged.ownedUnlockIds] : [],
    position: merged.position || null,
    ownerEmail: merged.ownerEmail || merged.owner_email || null,
    createdAt: merged.createdAt || merged.created_at || null,
    updatedAt: merged.updatedAt || merged.updated_at || null,
    preferences: prefs,
    isGuest: Boolean(raw.isGuest || String(merged.id || '').startsWith('guest-')),
  };
}

/**
 * Strips client-only and server-managed fields so only allowlisted save state
 * fields are sent to the backend.
 */
export function buildCleanSavePayload(save, { includeHeroName = true, includeOwnerEmail = false } = {}) {
  const norm = normalizeSave(save);
  const payload = {
    appearance: norm.appearance,
    eraId: norm.eraId,
    realmId: norm.realmId,
    visualEra: norm.visualEra,
    byteShards: norm.byteShards,
    stats: norm.stats,
    solvedTrials: norm.solvedTrials,
    completedTrials: norm.completedTrials,
    trialDrafts: norm.trialDrafts,
    seenCutscenes: norm.seenCutscenes,
    foundEasterEggs: norm.foundEasterEggs,
    unlockedSpells: norm.unlockedSpells,
    rescuedDragons: norm.rescuedDragons,
    openedChests: norm.openedChests,
    ownedUnlockIds: norm.ownedUnlockIds,
    position: norm.position,
  };
  if (includeHeroName) {
    payload.heroName = norm.heroName;
  }
  if (includeOwnerEmail && norm.ownerEmail) {
    payload.ownerEmail = norm.ownerEmail;
  }
  return payload;
}

// ==================== GUEST LOCALSTORAGE SAVES ====================
function readGuestSavesRaw() {
  try {
    const raw = localStorage.getItem(GUEST_SAVES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeGuestSavesRaw(saves) {
  try {
    localStorage.setItem(GUEST_SAVES_STORAGE_KEY, JSON.stringify(saves));
  } catch (err) {
    console.warn('Could not write guest saves to localStorage:', err);
  }
}

export function listGuestSaves() {
  return readGuestSavesRaw()
    .map((s) => ({ ...normalizeSave(s), isGuest: true }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function getGuestSave(id) {
  if (!id) return null;
  const found = readGuestSavesRaw().find((s) => s && s.id === id);
  return found ? { ...normalizeSave(found), isGuest: true } : null;
}

export function createGuestSave(saveData) {
  const now = new Date().toISOString();
  const id = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalized = {
    ...normalizeSave(saveData),
    id,
    ownerEmail: null,
    createdAt: now,
    updatedAt: now,
    isGuest: true,
  };
  const all = readGuestSavesRaw();
  all.unshift(normalized);
  writeGuestSavesRaw(all);
  return normalized;
}

export function updateGuestSave(id, saveData) {
  if (!id) return null;
  const now = new Date().toISOString();
  const all = readGuestSavesRaw();
  const idx = all.findIndex((s) => s && s.id === id);
  const existing = idx >= 0 ? all[idx] : {};
  const updated = {
    ...normalizeSave({ ...existing, ...saveData, id }),
    id,
    ownerEmail: null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    isGuest: true,
  };
  if (idx >= 0) {
    all[idx] = updated;
  } else {
    all.unshift(updated);
  }
  writeGuestSavesRaw(all);
  return updated;
}

export function deleteGuestSave(id) {
  if (!id) return;
  const all = readGuestSavesRaw().filter((s) => s && s.id !== id);
  writeGuestSavesRaw(all);
}

// ==================== REMOTE API & CONTENT ====================
export async function fetchMe() {
  try {
    const data = await requestJson('/api/me', { cache: 'no-store' });
    return normalizeMe(data);
  } catch {
    return normalizeMe({ mode: 'local', authenticated: false, email: null, isAdmin: false, accounts: [] });
  }
}

export async function fetchConfig() {
  return requestJson('/api/config', { cache: 'no-store' });
}

export async function fetchEra(eraId) {
  return requestJson(`/content/eras/${encodeURIComponent(eraId)}.json`);
}

export async function fetchMap(realmId) {
  return requestJson(`/content/maps/${encodeURIComponent(realmId)}.json`);
}

export async function fetchSpriteManifest() {
  return requestJson('/assets/sprites/manifest.json?v=20261127i');
}

export async function fetchTilesetManifest() {
  return requestJson('/assets/tilesets/manifest.json?v=20261127i');
}

export async function listSaves(ownerFilter = null) {
  const qs = ownerFilter ? `?owner=${encodeURIComponent(ownerFilter)}` : '';
  const data = await requestJson(`/api/saves${qs}`, { cache: 'no-store' });
  const list = Array.isArray(data.saves) ? data.saves : [];
  return list.map((s) => ({ ...normalizeSave(s), isGuest: false }));
}

export async function createSave(saveData) {
  const payload = buildCleanSavePayload(saveData, { includeHeroName: true, includeOwnerEmail: true });
  const data = await requestJson('/api/saves', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return { ...normalizeSave(data.save || data), isGuest: false };
}

export async function getSave(id) {
  const data = await requestJson(`/api/saves/${encodeURIComponent(id)}`, { cache: 'no-store' });
  return { ...normalizeSave(data.save || data), isGuest: false };
}

export async function updateSave(id, saveData) {
  const payload = buildCleanSavePayload(saveData, { includeHeroName: true, includeOwnerEmail: false });
  const data = await requestJson(`/api/saves/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return { ...normalizeSave(data.save || data), isGuest: false };
}

export async function logAttempt(saveId, { trialId, passed, hintsUsed, code }) {
  if (!saveId || String(saveId).startsWith('guest-')) return { ok: false, skipped: true };
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

// ==================== HERO CODES & AUTH ====================
export async function createHeroCode(heroName, saveState = null) {
  const body = { heroName: String(heroName || '').trim() };
  if (saveState && typeof saveState === 'object') {
    body.state = buildCleanSavePayload(saveState, { includeHeroName: false, includeOwnerEmail: false });
  }
  const data = await requestJson('/api/auth/hero-code/create', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    save: data.save ? { ...normalizeSave(data.save), isGuest: false } : null,
    heroCode: data.heroCode || '',
  };
}

export async function redeemHeroCode(heroCode) {
  const data = await requestJson('/api/auth/hero-code/redeem', {
    method: 'POST',
    body: JSON.stringify({ heroCode: String(heroCode || '').trim().toUpperCase() }),
  });
  return {
    save: data.save ? { ...normalizeSave(data.save), isGuest: false } : null,
  };
}

export async function logoutSession(scope = 'all') {
  return requestJson('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
}
