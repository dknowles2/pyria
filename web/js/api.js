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
  const linkedToParent = Boolean(auth.linkedToParent);
  const role =
    auth.role ||
    (isAdmin ? 'admin' : parentEmail ? 'parent' : heroSaveId ? 'hero' : 'guest');
  const googleOAuthEnabled = Boolean(auth.googleOAuthEnabled);
  const magicLinkEnabled = Boolean(auth.magicLinkEnabled);

  return {
    mode,
    auth: {
      role,
      heroSaveId,
      heroName,
      linkedToParent,
      parentEmail,
      isAdmin,
      googleOAuthEnabled,
      magicLinkEnabled,
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

export function createDefaultSaveState(heroName = 'Rowan', appearance = {}, preferences = null) {
  const base = {
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
      arrows: 0,
      potions: 0,
      customItems: [],
      completedWorkshopChallenges: [],
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
  if (preferences && typeof preferences === 'object' && !Array.isArray(preferences)) {
    base.preferences = { ...preferences };
  }
  return base;
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
      arrows: merged.stats?.arrows ?? 0,
      potions: merged.stats?.potions ?? 0,
      customItems: Array.isArray(merged.stats?.customItems) ? [...merged.stats.customItems] : [],
      completedWorkshopChallenges: Array.isArray(merged.stats?.completedWorkshopChallenges)
        ? [...merged.stats.completedWorkshopChallenges]
        : [],
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
    linkedToParent: Boolean(merged.linkedToParent ?? (merged.ownerEmail || merged.owner_email)),
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
  if (idx < 0) {
    // Save was deleted or upgraded to a cloud Hero Code; do not re-insert a stale duplicate.
    return null;
  }
  const existing = all[idx];
  const updated = {
    ...normalizeSave({ ...existing, ...saveData, id }),
    id,
    ownerEmail: null,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    isGuest: true,
  };
  all[idx] = updated;
  writeGuestSavesRaw(all);
  return updated;
}

export function deleteGuestSave(id) {
  if (!id) return;
  const all = readGuestSavesRaw().filter((s) => s && s.id !== id);
  writeGuestSavesRaw(all);
}

let lastKnownMe = null;

export function resetMeCache() {
  lastKnownMe = null;
}

// ==================== REMOTE API & CONTENT ====================
export async function fetchMe() {
  try {
    const data = await requestJson('/api/me', { cache: 'no-store' });
    lastKnownMe = normalizeMe(data);
    return lastKnownMe;
  } catch {
    if (lastKnownMe) return lastKnownMe;
    // Fail safely to guest mode so transient /api/me outages never drop guest saves
    // or attempt unauthenticated writes to /api/saves.
    return normalizeMe({
      mode: 'cloudflare',
      auth: {
        role: 'guest',
        heroSaveId: null,
        heroName: null,
        parentEmail: null,
        isAdmin: false,
        googleOAuthEnabled: false,
      },
      authenticated: false,
      email: null,
      isAdmin: false,
      accounts: [],
    });
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
  return requestJson('/assets/tilesets/manifest.json?v=20261128a');
}

export async function listSaves(ownerFilter = null) {
  const qs = ownerFilter ? `?owner=${encodeURIComponent(ownerFilter)}` : '';
  const data = await requestJson(`/api/saves${qs}`, { cache: 'no-store' });
  const list = Array.isArray(data.saves) ? data.saves : [];
  return list.map((s) => ({ ...normalizeSave(s), isGuest: false }));
}

export async function createSave(saveData) {
  const payload = buildCleanSavePayload(saveData, { includeHeroName: true, includeOwnerEmail: true });
  if (
    saveData?.preferences &&
    typeof saveData.preferences === 'object' &&
    !Array.isArray(saveData.preferences) &&
    Object.keys(saveData.preferences).length > 0
  ) {
    payload.preferences = { ...saveData.preferences };
  }
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

export async function updateSave(id, saveData, { keepalive = false } = {}) {
  const payload = buildCleanSavePayload(saveData, { includeHeroName: true, includeOwnerEmail: false });
  const data = await requestJson(`/api/saves/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    ...(keepalive ? { keepalive: true } : {}),
  });
  return { ...normalizeSave(data.save || data), isGuest: false };
}

const ALLOWED_DIFFICULTY_MODES = new Set(['explorer', 'standard', 'challenge']);
const MAX_DURATION_MS = 86400000;

export function normalizeAttemptErrorType(raw, passed = false) {
  if (passed || typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || null;
}

export async function logAttempt(
  saveId,
  { trialId, passed, hintsUsed, code, difficultyMode, isPractice, errorType, durationMs }
) {
  if (!saveId || String(saveId).startsWith('guest-')) return { ok: false, skipped: true };
  const passedBool = Boolean(passed);
  const safeDifficulty = ALLOWED_DIFFICULTY_MODES.has(difficultyMode) ? difficultyMode : 'standard';
  const safeErrorType = normalizeAttemptErrorType(errorType, passedBool);
  const hasDuration =
    (typeof durationMs === 'number' && Number.isFinite(durationMs)) ||
    (typeof durationMs === 'string' && durationMs.trim() !== '' && Number.isFinite(Number(durationMs)));
  const safeDurationMs = hasDuration
    ? Math.max(0, Math.min(MAX_DURATION_MS, Math.round(Number(durationMs))))
    : null;

  return requestJson(`/api/saves/${encodeURIComponent(saveId)}/attempts`, {
    method: 'POST',
    body: JSON.stringify({
      trialId,
      passed: passedBool,
      hintsUsed: Number(hintsUsed) || 0,
      code: String(code || ''),
      difficultyMode: safeDifficulty,
      isPractice: Boolean(isPractice),
      errorType: safeErrorType,
      durationMs: safeDurationMs,
    }),
  });
}

// ==================== HERO CODES & AUTH ====================
export async function createHeroCode(heroName, saveState = null) {
  const body = { heroName: String(heroName || '').trim() };
  if (saveState && typeof saveState === 'object') {
    body.state = buildCleanSavePayload(saveState, { includeHeroName: false, includeOwnerEmail: false });
    if (
      saveState.preferences &&
      typeof saveState.preferences === 'object' &&
      !Array.isArray(saveState.preferences) &&
      Object.keys(saveState.preferences).length > 0
    ) {
      body.preferences = { ...saveState.preferences };
    }
  }
  const data = await requestJson('/api/auth/hero-code/create', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    save: data.save ? { ...normalizeSave(data.save), isGuest: false } : null,
    heroCode: data.heroCode || '',
    parentLinkToken: data.parentLinkToken || '',
    parentLinkExpiresInSeconds: Number(data.parentLinkExpiresInSeconds) || 900,
  };
}

export async function createHeroLinkToken() {
  const data = await requestJson('/api/auth/hero-link-token', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return {
    parentLinkToken: data.parentLinkToken || '',
    heroName: data.heroName || '',
    expiresInSeconds: Number(data.expiresInSeconds) || 900,
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

export async function previewHeroPlayToken(playToken) {
  const data = await requestJson('/api/auth/play-preview', {
    method: 'POST',
    body: JSON.stringify({ playToken: String(playToken || '').trim() }),
  });
  return {
    valid: Boolean(data.valid),
    saveId: data.saveId || null,
    heroName: data.heroName || '',
  };
}

export async function redeemHeroPlayToken(playToken) {
  const data = await requestJson('/api/auth/hero-code/redeem', {
    method: 'POST',
    body: JSON.stringify({ playToken: String(playToken || '').trim() }),
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
