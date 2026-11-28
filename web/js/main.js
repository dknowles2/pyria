// Pyria: Return of the Bits — Main Application Controller

import {
  fetchMe,
  fetchConfig,
  fetchEra,
  fetchMap,
  fetchSpriteManifest,
  fetchTilesetManifest,
  listSaves,
  createSave,
  getSave,
  updateSave,
  logAttempt,
  createDefaultSaveState,
  isGuestMode,
  listGuestSaves,
  createGuestSave,
  getGuestSave,
  updateGuestSave,
  deleteGuestSave,
  createHeroCode,
  createHeroLinkToken,
  redeemHeroCode,
  previewHeroPlayToken,
  redeemHeroPlayToken,
  logoutSession,
} from './api.js?v=20261127o';
import { audio } from './audio.js?v=20261127i';
import { music, resolveRegionTheme } from './music.js?v=20261127j';
import { pyRunner } from './pyRunner.js?v=20261127j';
import { attachAutocomplete, buildCharCreateSuggestions } from './autocomplete.js?v=20261127i';
import { SpriteManager } from './sprites.js?v=20261127v';
import { WorldEngine } from './world.js?v=20261127v';
import { ModalManager, attachCodeEditorKeys, attachCodeGutter } from './modals.js?v=20261127v';
import { playCutscene, isCutsceneActive, STORY_CUTSCENES } from './cutscene.js?v=20261127w';
import { AppRouter } from './router.js?v=20261127l';
import {
  DEFAULT_FAMILIARITY_ID,
  PYTHON_FAMILIARITY_LEVELS,
  buildPreferencesForFamiliarity,
  getFamiliarityOption,
} from './onboarding.js?v=20261127r';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ADMIN_OWNER_STORAGE_KEY = 'pyria_admin_owner_filter';

const state = {
  me: {
    mode: 'local',
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
  },
  adminOwnerFilter: sessionStorage.getItem(ADMIN_OWNER_STORAGE_KEY) || 'all',
  gameConfig: null,
  catalog: null,
  era: null,
  sprites: null,
  world: null,
  modals: null,
  router: null,
  pendingSaveForRoute: null,
  mapsCache: new Map(),
  activeSave: null,
  activeRealm: null,
  activeMap: null,
  // Character creation preview state
  ccAppearance: {
    name: 'Rowan',
    skin: 'warm_tan',
    hair: 'spiky',
    tunic: 'emerald',
  },
  ccDirIndex: 0,
  ccFamiliarity: DEFAULT_FAMILIARITY_ID,
  ccAdvancedMode: false,
  ccAnimTimer: null,
  titleAnimTimer: null,
};

const SKIN_SWATCHES = {
  ivory: '#fde6d2',
  peach: '#f7c8a4',
  olive: '#d5b283',
  warm_tan: '#c68d5c',
  bronze: '#965c36',
  deep_brown: '#5b341d',
};

const TUNIC_SWATCHES = {
  emerald: '#10b981',
  crimson: '#ef4444',
  navy: '#2563eb',
  amber: '#f59e0b',
  violet: '#8b5cf6',
  slate: '#64748b',
};

function formatOptionLabel(val) {
  return String(val || '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildHeroForgePython(appearance) {
  const safeName = String(appearance.name || 'Rowan').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    `set_name("${safeName}")`,
    `preview_skin("${appearance.skin}")`,
    `preview_hair("${appearance.hair}")`,
    `preview_tunic("${appearance.tunic}")`,
    'confirm_hero()',
  ].join('\n') + '\n';
}

const DIRS = ['down', 'right', 'up', 'left'];

// ==================== DOM HELPERS ====================
const $ = (sel) => document.querySelector(sel);

function syncMusicButtons() {
  const on = music.isEnabled();
  const label = on ? '🎵 Music: On' : '🎵 Music: Off';
  for (const sel of ['#btn-hud-music', '#btn-title-music', '#btn-charcreate-music']) {
    const btn = $(sel);
    if (btn) btn.textContent = label;
  }
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const target = $(`#${screenId}`);
  if (target) target.classList.add('active');

  if (screenId === 'screen-title' || screenId === 'screen-charcreate') {
    music.setTheme('title', { immediate: true });
  }

  if (state.world) {
    state.world.setPaused(screenId !== 'screen-game');
  }
}

function showToast(message) {
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3400);
}

function getNpc(npcId) {
  return (
    (state.gameConfig?.npcs || []).find((n) => n.id === npcId) || {
      id: npcId,
      name: npcId,
      role: 'Guide',
      catchphrase: 'Good luck, Code-Tamer!',
    }
  );
}

const VISUAL_ERAS = ['8bit', '16bit', '32bit', '64bit'];
const VISUAL_ERA_LABELS = {
  '8bit': '8-Bit NES',
  '16bit': '16-Bit SNES',
  '32bit': '32-Bit Isometric',
  '64bit': '64-Bit N64 3D',
};
const ERA_TO_VISUAL = {
  'era-01-8bit': '8bit',
  'era-02-16bit': '16bit',
  'era-03-32bit': '32bit',
  'era-04-64bit': '64bit',
};

function normalizeVisualEra(v) {
  return VISUAL_ERAS.includes(v) ? v : '8bit';
}

function getAllLoadedEras() {
  if (state.eras && state.eras.size > 0) return [...state.eras.values()];
  return state.era ? [state.era] : [];
}

function getEraAndRealm(realmId) {
  for (const era of getAllLoadedEras()) {
    const found = (era.realms || []).find((r) => r.id === realmId);
    if (found) return { era, realm: found };
  }
  const fallbackEra = state.era || getAllLoadedEras()[0] || null;
  return { era: fallbackEra, realm: fallbackEra?.realms?.[0] || null };
}

function getRealm(realmId) {
  for (const era of getAllLoadedEras()) {
    const found = (era.realms || []).find((r) => r.id === realmId);
    if (found) return found;
  }
  return state.era?.realms?.[0] || null;
}

function getTrial(trialId) {
  for (const era of getAllLoadedEras()) {
    for (const realm of era.realms || []) {
      const found = (realm.trials || []).find((t) => t.id === trialId);
      if (found) return { trial: found, realm, era };
    }
  }
  return { trial: null, realm: null, era: null };
}

// ==================== TRIAL DRAFT AUTO-SAVE ====================
let draftPersistTimer = null;

function readLocalDrafts(saveId) {
  if (!saveId) return {};
  try {
    const raw = localStorage.getItem(`pyria_drafts_${saveId}`);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalDrafts(saveId, drafts) {
  if (!saveId) return;
  try {
    localStorage.setItem(`pyria_drafts_${saveId}`, JSON.stringify(drafts || {}));
  } catch {
    // ignore quota errors
  }
}

function getTrialDraft(save, trialId) {
  if (!save || !trialId) return null;
  const saveOwner = (save.ownerEmail || '').trim().toLowerCase();
  const currentEmail = (state.me?.email || '').trim().toLowerCase();
  // Never auto-load another account's server draft into the runnable editor (e.g. admin inspecting a player save)
  if (saveOwner && saveOwner !== currentEmail) {
    return null;
  }
  const local = readLocalDrafts(save.id);
  if (typeof local[trialId] === 'string' && local[trialId].trim().length > 0) {
    return local[trialId];
  }
  const serverDraft = save.trialDrafts?.[trialId];
  if (typeof serverDraft === 'string' && serverDraft.trim().length > 0) {
    return serverDraft;
  }
  return null;
}

function updateTrialDraft(save, trialId, code, { immediatePersist = false } = {}) {
  if (!save || !trialId) return;
  if (!save.trialDrafts || typeof save.trialDrafts !== 'object') {
    save.trialDrafts = {};
  }
  save.trialDrafts[trialId] = code;
  const local = readLocalDrafts(save.id);
  local[trialId] = code;
  writeLocalDrafts(save.id, local);

  if (draftPersistTimer) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = null;
  }
  if (immediatePersist) {
    persistSave().catch(() => {});
  } else {
    draftPersistTimer = setTimeout(() => {
      draftPersistTimer = null;
      persistSave().catch(() => {});
    }, 800);
  }
}

function clearTrialDraft(save, trialId, { skipPersist = false } = {}) {
  if (!save || !trialId) return;
  if (draftPersistTimer) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = null;
  }
  if (save.trialDrafts && trialId in save.trialDrafts) {
    delete save.trialDrafts[trialId];
  }
  const local = readLocalDrafts(save.id);
  if (trialId in local) {
    delete local[trialId];
    writeLocalDrafts(save.id, local);
  }
  if (!skipPersist) {
    persistSave().catch(() => {});
  }
}

// ==================== PERSISTENCE ====================
let persistQueue = Promise.resolve();
let sessionExpiredHandling = false;
let lastExpiredSaveId = null;

function isActiveSaveGuest(save) {
  if (!save) return isGuestMode(state.me);
  return Boolean(save.isGuest || String(save.id || '').startsWith('guest-') || isGuestMode(state.me));
}

function migrateLocalDrafts(oldSaveId, newSaveId) {
  if (!oldSaveId || !newSaveId || oldSaveId === newSaveId) return;
  try {
    const oldDrafts = readLocalDrafts(oldSaveId);
    if (Object.keys(oldDrafts).length > 0) {
      const merged = { ...oldDrafts, ...readLocalDrafts(newSaveId) };
      writeLocalDrafts(newSaveId, merged);
    }
    localStorage.removeItem(`pyria_drafts_${oldSaveId}`);
  } catch {
    // ignore storage errors
  }
}

async function handleHeroSessionExpired(snapshot) {
  const source = snapshot || state.activeSave;
  if (sessionExpiredHandling) return;
  if (source?.id && source.id === lastExpiredSaveId) return;
  sessionExpiredHandling = true;
  if (source?.id) lastExpiredSaveId = source.id;
  try {
    if (draftPersistTimer) {
      clearTimeout(draftPersistTimer);
      draftPersistTimer = null;
    }
    if (source && !source.isGuest) {
      const oldId = source.id;
      const backup = createGuestSave(source);
      migrateLocalDrafts(oldId, backup.id);
      if (state.activeSave && state.activeSave.id === oldId) {
        state.activeSave = backup;
        state.world?.setSave(backup);
        state.router?.replace({ name: 'game', saveId: backup.id }, { silent: true });
      }
    }
    state.me = await fetchMe();
    renderAccountIdentityBar();
    renderAdminRealmJump();
    updateHud();
    const modalAlreadyOpen = !$('#modal-backdrop')?.classList.contains('hidden');
    if (state.modals && !modalAlreadyOpen) {
      state.modals.openHeroSessionExpiredModal({
        heroName: source?.heroName,
        onEnterHeroCode: () => openEnterHeroCodeFlow(),
      });
    } else if (!modalAlreadyOpen) {
      showToast('Your Hero Code changed — progress backed up locally. Enter your new Hero Code!');
    }
  } finally {
    sessionExpiredHandling = false;
  }
}

function syncHeroPositionToSave() {
  if (state.activeSave && state.world && state.activeMap) {
    state.activeSave.position = {
      realmId: state.activeMap.realmId,
      x: Math.floor(state.world.hero.x),
      y: Math.floor(state.world.hero.y),
    };
  }
}

function persistPositionOnPageHide() {
  if (!$('#screen-game')?.classList.contains('active')) return;
  if (!state.activeSave || !state.activeSave.id) return;
  syncHeroPositionToSave();
  const snapshot = JSON.parse(JSON.stringify(state.activeSave));
  if (isActiveSaveGuest(snapshot)) {
    updateGuestSave(snapshot.id, snapshot);
  } else {
    updateSave(snapshot.id, snapshot, { keepalive: true }).catch(() => {});
  }
}

function persistSave() {
  if (!state.activeSave || !state.activeSave.id) return Promise.resolve();
  persistQueue = persistQueue
    .catch(() => {})
    .then(async () => {
      if (!state.activeSave || !state.activeSave.id) return;
      syncHeroPositionToSave();
      const snapshot = JSON.parse(JSON.stringify(state.activeSave));
      try {
        if (isActiveSaveGuest(snapshot)) {
          const updated = updateGuestSave(snapshot.id, snapshot);
          if (state.activeSave && state.activeSave.id === snapshot.id && updated?.updatedAt) {
            state.activeSave.updatedAt = updated.updatedAt;
          }
          return;
        }
        const updated = await updateSave(snapshot.id, snapshot);
        if (state.activeSave && state.activeSave.id === snapshot.id && updated?.updatedAt) {
          state.activeSave.updatedAt = updated.updatedAt;
        }
      } catch (err) {
        console.warn('Could not persist save:', err);
        if (
          state.me?.mode === 'cloudflare' &&
          !isActiveSaveGuest(snapshot) &&
          (err?.status === 401 || err?.status === 403)
        ) {
          await handleHeroSessionExpired(snapshot);
        }
      }
    });
  return persistQueue;
}

function getSolvedTrialsSet(save) {
  return new Set([
    ...(save?.solvedTrials || []),
    ...(save?.completedTrials || []),
  ]);
}

function getSecretsStats(save) {
  const solved = getSolvedTrialsSet(save);
  let solvedBonusCount = 0;
  for (const r of state.era?.realms || []) {
    for (const t of r.trials || []) {
      if (t.isBonus && solved.has(t.id)) solvedBonusCount += 1;
    }
  }
  const foundEggsCount = Array.isArray(save?.foundEasterEggs) ? save.foundEasterEggs.length : 0;
  return {
    solvedBonusCount,
    foundEggsCount,
    totalSecrets: solvedBonusCount + foundEggsCount,
    bonusHints: solvedBonusCount + Math.floor(foundEggsCount / 2),
  };
}

function getBonusLockInfo(entity, save, realm) {
  if (!entity || entity.type !== 'bonus_trial') {
    return { locked: false, reason: null };
  }
  const completed = getSolvedTrialsSet(save);
  if (entity.refId && completed.has(entity.refId)) {
    return { locked: false, reason: null };
  }
  if (entity.requiredTrialId && !completed.has(entity.requiredTrialId)) {
    return {
      locked: true,
      reason: 'Complete the earlier Realm Trials first to unseal this secret rune!',
    };
  }
  const activeRealm = realm || state.activeRealm;
  const coreTrials = (activeRealm?.trials || []).filter((t) => !t.isBonus);
  const bossTrialId = activeRealm?.cutscenes?.bossTrialId || coreTrials[coreTrials.length - 1]?.id;
  const bossTrial = coreTrials.find((t) => t.id === bossTrialId);
  const unsolvedCore = coreTrials.filter((t) => !completed.has(t.id));

  if ((bossTrialId && !completed.has(bossTrialId)) || unsolvedCore.length > 0) {
    const bossLabel = bossTrial ? `"${bossTrial.title}"` : 'the Realm Boss';
    const remaining = unsolvedCore.length;
    const reason =
      remaining > 1
        ? `Defeat ${bossLabel} (${remaining} Realm Trials left) to unseal this secret rune!`
        : `Defeat ${bossLabel} first to unseal this secret rune!`;
    return { locked: true, reason };
  }
  return { locked: false, reason: null };
}

function updateInteractPrompt(entity) {
  const prompt = $('#interact-prompt');
  const label = $('#interact-prompt-label');
  const touchBtn = $('#btn-touch-interact');
  const touchLabel = $('#touch-interact-label');
  if (!prompt || !label) return;
  if (!entity) {
    prompt.classList.add('hidden');
    touchBtn?.classList.remove('near-target');
    if (touchLabel) touchLabel.textContent = 'Act';
    return;
  }
  const solved = getSolvedTrialsSet(state.activeSave);
  touchBtn?.classList.add('near-target');
  if ((entity.type === 'trial' || entity.type === 'bonus_trial') && solved.has(entity.refId)) {
    label.textContent = `✓ ${entity.label} (Completed)`;
    if (touchLabel) touchLabel.textContent = 'Done';
    prompt.classList.remove('hidden');
    return;
  }
  if (entity.type === 'bonus_trial') {
    const lockInfo = getBonusLockInfo(entity, state.activeSave, state.activeRealm);
    if (lockInfo.locked) {
      label.textContent = `🔒 ${entity.label} (Beat Realm Boss to unlock)`;
      if (touchLabel) touchLabel.textContent = 'Locked';
      prompt.classList.remove('hidden');
      return;
    }
  }
  let verb = 'Inspect';
  let shortLabel = 'Act';
  if (entity.type === 'npc') { verb = 'Talk to'; shortLabel = 'Talk'; }
  else if (entity.type === 'workshop') { verb = 'Open'; shortLabel = 'Shop'; }
  else if (entity.type === 'chest') { verb = 'Open'; shortLabel = 'Open'; }
  else if (entity.type === 'vault') { verb = 'Enter'; shortLabel = 'Vault'; }
  else if (entity.type === 'portal') { verb = 'Step into'; shortLabel = 'Portal'; }
  else if (entity.type === 'trial') { verb = 'Begin'; shortLabel = 'Code'; }
  else if (entity.type === 'bonus_trial') { verb = 'Discover'; shortLabel = 'Bonus'; }
  else if (entity.type === 'easter_egg') { verb = 'Inspect'; shortLabel = 'Secret'; }
  label.textContent = `${verb} ${entity.label}`;
  if (touchLabel) touchLabel.textContent = shortLabel;
  prompt.classList.remove('hidden');
}

function renderAdminRealmJump() {
  const selectEl = $('#hud-admin-realm-jump');
  if (!selectEl) return;
  if (!state.me?.isAdmin) {
    selectEl.classList.add('hidden');
    selectEl.innerHTML = '';
    return;
  }
  const eras = getAllLoadedEras();
  selectEl.innerHTML = eras
    .map((era) => {
      const opts = (era.realms || [])
        .map(
          (r) =>
            `<option value="${escapeHtml(r.id)}">R${Number(r.number) || 0}: ${escapeHtml(r.name)}</option>`
        )
        .join('');
      return `<optgroup label="${escapeHtml(era.name)}">${opts}</optgroup>`;
    })
    .join('');
  if (state.activeRealm?.id) {
    selectEl.value = state.activeRealm.id;
  }
  selectEl.classList.remove('hidden');

  const csEl = $('#hud-admin-cutscene-preview');
  if (csEl) {
    const opts = Object.values(STORY_CUTSCENES)
      .map((cs) => `<option value="${escapeHtml(cs.id)}">${escapeHtml(cs.label)}</option>`)
      .join('');
    csEl.innerHTML = `<option value="">🎬 Preview Cutscene…</option>${opts}`;
    csEl.classList.remove('hidden');
  }
}

async function runStoryCutsceneById(cutsceneId, { markSeen = false } = {}) {
  if (isCutsceneActive()) return;
  const cs = STORY_CUTSCENES[cutsceneId];
  if (!cs) return;
  const save = state.activeSave;
  if (markSeen && save) {
    const seen = new Set(save.seenCutscenes || []);
    if (seen.has(cutsceneId)) return;
    seen.add(cutsceneId);
    save.seenCutscenes = [...seen];
    await persistSave();
  }
  state.world?.setPaused(true);
  music.setDucked(true);
  if (cutsceneId.startsWith('era-transition-')) {
    audio.playDragonRescue();
  }
  await playCutscene({
    id: cutsceneId,
    title: cs.title,
    subtitle: cs.subtitle,
    beats: cs.beats,
    save,
    sprites: state.sprites,
    eraKey: cs.eraKey || '8bit',
    realmId: cs.realmId || 'realm-01-meadow',
    finalButtonLabel: cs.finalButtonLabel || 'Continue ▸',
  });
  music.setDucked(false);
  state.world?.setPaused(false);
}

// ==================== HUD UPDATES ====================
function updateHud() {
  const save = state.activeSave;
  if (!save) return;

  $('#hud-hero-name').textContent = save.heroName || 'Code-Tamer';
  const eraKey = normalizeVisualEra(save.visualEra);
  $('#hud-era-badge').textContent = VISUAL_ERA_LABELS[eraKey] || '8-Bit NES';
  $('#hud-realm-name').textContent = state.activeRealm?.name || 'Whispering Meadow';
  const adminJumpEl = $('#hud-admin-realm-jump');
  if (adminJumpEl && state.me?.isAdmin && state.activeRealm?.id) {
    adminJumpEl.value = state.activeRealm.id;
  }
  $('#hud-shards').textContent = String(save.byteShards ?? 0);
  $('#btn-hud-mute').textContent = audio.isMuted() ? '🔇' : '🔊';

  const hudHeroCodeBtn = $('#btn-hud-hero-code');
  if (hudHeroCodeBtn) {
    const showUpgrade = state.me?.mode === 'cloudflare' && isActiveSaveGuest(save);
    hudHeroCodeBtn.classList.toggle('hidden', !showUpgrade);
  }

  // Realm Trials progress indicator (excludes hidden isBonus Trials from main Vault count)
  const completed = getSolvedTrialsSet(save);
  const realmTrials = (state.activeRealm?.trials || []).filter((t) => !t.isBonus);
  const solvedInRealm = realmTrials.filter((t) => completed.has(t.id)).length;
  const totalInRealm = realmTrials.length;
  const trialsEl = $('#hud-trials-progress');
  if (trialsEl) {
    const allDone = totalInRealm > 0 && solvedInRealm >= totalInRealm;
    trialsEl.textContent = `${allDone ? '✓' : '★'} Trials: ${solvedInRealm}/${totalInRealm}`;
    trialsEl.classList.toggle('all-complete', allDone);
  }

  // Secrets counter (Bonus Trials + Easter Eggs)
  const secrets = getSecretsStats(save);
  const secretsEl = $('#hud-secrets');
  if (secretsEl) {
    secretsEl.textContent = `✦ Secrets: ${secrets.totalSecrets}`;
    secretsEl.title = `Secrets Found: ${secrets.solvedBonusCount} Bonus Trials, ${secrets.foundEggsCount} Easter Eggs (+${secrets.bonusHints} Bonus Hints)`;
  }

  // Hero mini portrait
  const portraitCanvas = $('#hud-portrait');
  if (portraitCanvas && state.sprites) {
    const is64 = eraKey === '64bit';
    const targetSz = is64 ? 64 : 32;
    if (portraitCanvas.width !== targetSz || portraitCanvas.height !== targetSz) {
      portraitCanvas.width = targetSz;
      portraitCanvas.height = targetSz;
    }
    portraitCanvas.classList.toggle('pixel-canvas', !is64);
    const ctx = portraitCanvas.getContext('2d');
    ctx.clearRect(0, 0, targetSz, targetSz);
    state.sprites.drawHero(ctx, save.appearance, eraKey, 'down', 0, 0, 0, targetSz, targetSz);
  }

  // Rescued dragons summary (data-driven across all Realms in the current Era)
  const dragonsEl = $('#hud-dragons');
  const rescued = new Set(save.rescuedDragons || []);
  const eraRealms = state.era?.realms || [];
  const totalDragons = eraRealms.length || 8;
  const rescuedInEra = eraRealms.filter((r) => r.dragon && rescued.has(r.dragon.id));
  const currentDragon = state.activeRealm?.dragon;
  const currentRescued = currentDragon && rescued.has(currentDragon.id);
  const dragonSummaryHtml = `<span class="dragon-badge ${rescuedInEra.length > 0 ? 'rescued' : ''}" title="Rescued Dragons in ${escapeHtml(state.era?.name || '8-Bit Era')}">🐉 ${rescuedInEra.length}/${totalDragons}</span>`;
  const currentDragonHtml = currentDragon
    ? `<span class="dragon-badge ${currentRescued ? 'rescued' : ''}">${escapeHtml(currentDragon.name)}${currentRescued ? ' ✓' : ''}</span>`
    : '';
  dragonsEl.innerHTML = dragonSummaryHtml + currentDragonHtml;

  // Dynamic Pip objective tip (100% driven by the Realm's actual trial list)
  const realmDragon = state.activeRealm?.dragon;
  const nextTrial = realmTrials.find((t) => !completed.has(t.id));
  let tip = 'Explore the realm! Press E or click nearby to interact.';
  if (nextTrial) {
    tip = `Next Trial (${solvedInRealm}/${totalInRealm}): ${nextTrial.title} — follow the gold ! marker on your minimap!`;
  } else if (realmDragon && !rescued.has(realmDragon.id)) {
    tip = `All ${totalInRealm} Trials solved! Head to ${realmDragon.name}'s Logic Vault (red dot on minimap) to rescue ${realmDragon.name}!`;
  } else if (realmDragon && rescued.has(realmDragon.id)) {
    tip = `${realmDragon.name} is free! Step into the glowing Portal or visit Bram's Workshop to spend your Byte Shards!`;
  }
  $('#hud-objective').textContent = tip;

  if (state.world?.nearestEntity) {
    updateInteractPrompt(state.world.nearestEntity);
  }
}

// ==================== TITLE & SAVE PICKER ====================
function renderAccountIdentityBar() {
  const me = state.me || {};
  const auth = me.auth || {};
  const isCloudflare = me.mode === 'cloudflare';
  const bar = $('#title-account-bar');
  const pill = $('#title-user-pill');
  const builderBtn = $('#btn-title-builder');
  const parentsBtn = $('#btn-title-parents');
  const heroLinkParentBtn = $('#btn-hero-link-parent');
  const heroSignOutBtn = $('#btn-hero-signout');
  const accountSignOutBtn = $('#btn-account-signout');
  const enterCodeBtn = $('#btn-enter-hero-code');
  const adminBar = $('#admin-account-bar');
  const adminSel = $('#admin-account-select');

  if (enterCodeBtn) {
    enterCodeBtn.classList.toggle('hidden', !isCloudflare);
  }

  if (isCloudflare) {
    bar?.classList.remove('hidden');
    if (auth.role === 'admin') {
      if (pill) {
        pill.className = 'pill pill-gold';
        pill.textContent = auth.parentEmail ? `🛡️ Admin: ${auth.parentEmail}` : '🛡️ Admin';
      }
      if (builderBtn) {
        builderBtn.href = '/console';
        builderBtn.textContent = '🛡️ Console';
        builderBtn.classList.remove('hidden');
      }
      parentsBtn?.classList.add('hidden');
      heroLinkParentBtn?.classList.add('hidden');
      heroSignOutBtn?.classList.add('hidden');
      accountSignOutBtn?.classList.remove('hidden');
    } else if (auth.role === 'parent') {
      if (pill) {
        pill.className = 'pill pill-blue';
        pill.textContent = auth.parentEmail ? `👤 ${auth.parentEmail}` : '👤 Signed In';
      }
      if (builderBtn) {
        builderBtn.href = '/console';
        builderBtn.textContent = '👤 Console';
        builderBtn.classList.remove('hidden');
      }
      parentsBtn?.classList.add('hidden');
      heroLinkParentBtn?.classList.add('hidden');
      heroSignOutBtn?.classList.add('hidden');
      accountSignOutBtn?.classList.remove('hidden');
    } else if (auth.role === 'hero') {
      if (pill) {
        pill.className = 'pill pill-green';
        pill.textContent = auth.linkedToParent
          ? `🧙 Hero: ${auth.heroName || 'Code-Tamer'} · ✓ Account Linked`
          : `🧙 Hero: ${auth.heroName || 'Code-Tamer'}`;
      }
      builderBtn?.classList.add('hidden');
      parentsBtn?.classList.remove('hidden');
      heroLinkParentBtn?.classList.toggle('hidden', Boolean(auth.linkedToParent));
      heroSignOutBtn?.classList.remove('hidden');
      accountSignOutBtn?.classList.add('hidden');
    } else {
      if (pill) {
        pill.className = 'pill pill-violet';
        pill.textContent = '✨ Guest Mode (Saved on this device)';
      }
      builderBtn?.classList.add('hidden');
      parentsBtn?.classList.remove('hidden');
      heroLinkParentBtn?.classList.add('hidden');
      heroSignOutBtn?.classList.add('hidden');
      accountSignOutBtn?.classList.add('hidden');
    }
  } else {
    parentsBtn?.classList.add('hidden');
    heroLinkParentBtn?.classList.add('hidden');
    heroSignOutBtn?.classList.add('hidden');
    accountSignOutBtn?.classList.add('hidden');
    if (me.authenticated || me.email || me.isAdmin) {
      bar?.classList.remove('hidden');
      if (pill) {
        if (me.isAdmin) {
          pill.className = 'pill pill-gold';
          pill.textContent = me.email ? `🛡️ Admin: ${me.email}` : '🛡️ Admin Mode';
        } else {
          pill.className = 'pill pill-blue';
          pill.textContent = `👤 ${me.email}`;
        }
      }
    } else {
      bar?.classList.add('hidden');
    }
    if (me.isAdmin && builderBtn) {
      builderBtn.href = '/builder';
      builderBtn.textContent = '🛠️ Builder';
      builderBtn.classList.remove('hidden');
    } else {
      builderBtn?.classList.add('hidden');
    }
  }

  if (me.isAdmin && !isCloudflare) {
    adminBar?.classList.remove('hidden');
    if (adminSel) {
      const accounts = new Set(Array.isArray(me.accounts) ? me.accounts : []);
      if (me.email) accounts.add(me.email);
      const sorted = [...accounts].filter(Boolean).sort();
      const opts = ['<option value="all">All Accounts</option>'];
      for (const email of sorted) {
        opts.push(`<option value="${escapeHtml(email)}">${escapeHtml(email)}</option>`);
      }
      adminSel.innerHTML = opts.join('');
      if (state.adminOwnerFilter !== 'all' && !sorted.includes(state.adminOwnerFilter)) {
        state.adminOwnerFilter = 'all';
      }
      adminSel.value = state.adminOwnerFilter;
    }
  } else {
    adminBar?.classList.add('hidden');
  }
}

let heroCodeUpgradeInFlight = false;
const GUEST_CLOUD_NUDGE_KEY = 'pyria_guest_cloud_nudge_shown';

function maybeShowGuestCloudNudge(save) {
  if (state.me?.mode !== 'cloudflare' || !isActiveSaveGuest(save)) return;
  if (!Array.isArray(save?.rescuedDragons) || save.rescuedDragons.length !== 1) return;
  try {
    if (localStorage.getItem(GUEST_CLOUD_NUDGE_KEY)) return;
    localStorage.setItem(GUEST_CLOUD_NUDGE_KEY, '1');
  } catch {
    return;
  }
  setTimeout(() => {
    showToast('☁️ Tip: Tap Save to Cloud anytime to back up your hero across devices!');
  }, 2400);
}

async function upgradeGuestSaveToHeroCode(targetSave) {
  if (!targetSave || heroCodeUpgradeInFlight) return;
  heroCodeUpgradeInFlight = true;
  const oldGuestId = targetSave.id;
  if (draftPersistTimer) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = null;
  }
  await persistQueue.catch(() => {});
  try {
    const res = await createHeroCode(targetSave.heroName, targetSave);
    if (!res.save || !res.heroCode) {
      throw new Error('Server did not return a Hero Code');
    }
    // Swap activeSave and migrate local drafts BEFORE deleting the guest save so
    // any concurrent persistSave() cannot write back to the old guest ID.
    let needsPostUpgradeSync = false;
    if (state.activeSave && state.activeSave.id === oldGuestId) {
      // Preserve any in-memory progress made while createHeroCode() was in flight.
      const mergedCloudSave = {
        ...state.activeSave,
        ...res.save,
        byteShards: Math.max(Number(state.activeSave.byteShards) || 0, Number(res.save.byteShards) || 0),
        solvedTrials: [...new Set([...(state.activeSave.solvedTrials || []), ...(res.save.solvedTrials || [])])],
        completedTrials: [...new Set([...(state.activeSave.completedTrials || []), ...(res.save.completedTrials || [])])],
        openedChests: [...new Set([...(state.activeSave.openedChests || []), ...(res.save.openedChests || [])])],
        foundEasterEggs: [...new Set([...(state.activeSave.foundEasterEggs || []), ...(res.save.foundEasterEggs || [])])],
        rescuedDragons: [...new Set([...(state.activeSave.rescuedDragons || []), ...(res.save.rescuedDragons || [])])],
        ownedUnlockIds: [...new Set([...(state.activeSave.ownedUnlockIds || []), ...(res.save.ownedUnlockIds || [])])],
        seenCutscenes: [...new Set([...(state.activeSave.seenCutscenes || []), ...(res.save.seenCutscenes || [])])],
        position: state.activeSave.position || res.save.position || null,
        isGuest: false,
      };
      state.activeSave = mergedCloudSave;
      state.world?.setSave(mergedCloudSave);
      state.router?.replace({ name: 'game', saveId: mergedCloudSave.id }, { silent: true });
      needsPostUpgradeSync = true;
    }
    migrateLocalDrafts(oldGuestId, res.save.id);
    if (String(oldGuestId || '').startsWith('guest-')) {
      deleteGuestSave(oldGuestId);
    }
    const [freshMe, freshConfig] = await Promise.all([
      fetchMe(),
      fetchConfig().catch(() => null),
    ]);
    state.me = freshMe;
    if (freshConfig?.game) {
      state.gameConfig = freshConfig.game;
      if (freshConfig.heroPreferences) {
        state.gameConfig.heroPreferences = freshConfig.heroPreferences;
      }
    }
    if (needsPostUpgradeSync) {
      persistSave().catch(() => {});
    }
    updateHud();
    renderAccountIdentityBar();
    renderAdminRealmJump();
    if ($('#screen-title')?.classList.contains('active')) {
      await refreshSavesList();
    }
    state.modals.openHeroCodeDisplayModal({
      heroName: res.save.heroName,
      heroCode: res.heroCode,
      parentLinkToken: res.parentLinkToken || '',
      onPollLinked: pollHeroLinkedStatus,
    });
  } catch (err) {
    audio.playError();
    showToast(`Could not create Hero Code: ${err.detail || err.message}`);
  } finally {
    heroCodeUpgradeInFlight = false;
  }
}

async function pollHeroLinkedStatus() {
  const freshMe = await fetchMe();
  state.me = freshMe;
  if (freshMe?.auth?.linkedToParent) {
    renderAccountIdentityBar();
    if ($('#screen-title')?.classList.contains('active')) {
      refreshSavesList().catch(() => {});
    }
    return true;
  }
  return false;
}

async function openLinkToParentFlow() {
  try {
    const res = await createHeroLinkToken();
    if (!res.parentLinkToken) {
      throw new Error('Could not generate a parent link right now.');
    }
    state.modals.openLinkToParentModal({
      heroName: res.heroName || state.me?.auth?.heroName || 'Hero',
      parentLinkToken: res.parentLinkToken,
      expiresInSeconds: res.expiresInSeconds,
      onPollLinked: pollHeroLinkedStatus,
    });
  } catch (err) {
    audio.playError();
    if (err?.status === 409) {
      state.me = await fetchMe();
      renderAccountIdentityBar();
      if ($('#screen-title')?.classList.contains('active')) {
        await refreshSavesList();
      }
      showToast('This hero is already linked to an account!');
      return;
    }
    showToast(`Could not create link: ${err?.detail || err?.message || 'Try again'}`);
  }
}

function openEnterHeroCodeFlow() {
  state.modals.openEnterHeroCodeModal({
    onRedeem: async (code) => {
      const res = await redeemHeroCode(code);
      if (!res.save) {
        throw new Error('Could not load hero for that code.');
      }
      lastExpiredSaveId = null;
      const [freshMe, freshConfig] = await Promise.all([
        fetchMe(),
        fetchConfig().catch(() => null),
      ]);
      state.me = freshMe;
      if (freshConfig?.game) {
        state.gameConfig = freshConfig.game;
        if (freshConfig.heroPreferences) {
          state.gameConfig.heroPreferences = freshConfig.heroPreferences;
        }
      }
      renderAccountIdentityBar();
      renderAdminRealmJump();
      audio.playSuccess();
      await navigateToGame(res.save);
      showToast(`Welcome back, ${res.save.heroName}!`);
    },
  });
}

async function renameSaveRecord(targetSave, newName) {
  if (!targetSave || !targetSave.id) {
    throw new Error('No hero save selected.');
  }
  const trimmed = String(newName || '').trim();
  const isActive = Boolean(state.activeSave && state.activeSave.id === targetSave.id);
  const isGuest = isActiveSaveGuest(targetSave);

  if (isActive) {
    await persistQueue.catch(() => {});
  }

  let updated;
  if (isGuest) {
    const base = (isActive ? state.activeSave : getGuestSave(targetSave.id)) || targetSave;
    updated = updateGuestSave(targetSave.id, { ...base, heroName: trimmed });
    if (!updated) {
      throw new Error('Could not find local guest save to rename.');
    }
  } else {
    const base = isActive ? state.activeSave : await getSave(targetSave.id).catch(() => targetSave);
    updated = await updateSave(targetSave.id, { ...base, heroName: trimmed });
  }

  const finalName = updated?.heroName || trimmed;
  if (isActive && state.activeSave) {
    state.activeSave.heroName = finalName;
    if (updated?.updatedAt) {
      state.activeSave.updatedAt = updated.updatedAt;
    }
    updateHud();
  }
  if (state.me?.auth?.heroSaveId === targetSave.id) {
    state.me.auth.heroName = finalName;
    renderAccountIdentityBar();
  }
  audio.playSuccess();
  showToast(`Hero renamed to "${finalName}"!`);
  return updated;
}

function openRenameHeroFlow(targetSave, { refreshList = false } = {}) {
  if (!targetSave || !state.modals) return;
  state.modals.openRenameHeroModal({
    currentName: targetSave.heroName,
    onRename: async (newName) => {
      await renameSaveRecord(targetSave, newName);
      if (refreshList) {
        await refreshSavesList();
      }
    },
  });
}

async function refreshSavesList() {
  const listEl = $('#saves-list');
  const countEl = $('#saves-count');
  const isCloudflare = state.me?.mode === 'cloudflare';
  const guest = isGuestMode(state.me);

  try {
    const ownerParam = !isCloudflare && state.me?.isAdmin ? state.adminOwnerFilter || 'all' : null;
    const saves = guest ? listGuestSaves() : await listSaves(ownerParam);
    const showingAll = Boolean(!isCloudflare && state.me?.isAdmin && ownerParam === 'all');
    countEl.textContent = `${saves.length} ${saves.length === 1 ? 'Hero' : 'Heroes'}`;
    if (saves.length === 0) {
      listEl.innerHTML = isCloudflare
        ? '<div class="empty-state">No heroes yet! Click <strong>Start New Adventure</strong> to play right away, or <strong>Enter Hero Code</strong> to load a hero.</div>'
        : '<div class="empty-state">No saved heroes yet. Click <strong>Start New Adventure</strong> to forge your first Code-Tamer!</div>';
      return;
    }

    listEl.innerHTML = '';
    for (const s of saves) {
      const realm = getRealm(s.realmId);
      const card = document.createElement('div');
      card.className = 'save-card';
      const ownerBadgeHtml =
        showingAll && s.ownerEmail
          ? `<div class="save-owner-pill">${escapeHtml(s.ownerEmail)}</div>`
          : '';
      const guestBadgeHtml = s.isGuest
        ? '<div class="save-guest-pill">Local Save (This Device)</div>'
        : isCloudflare && s.linkedToParent
          ? '<div class="save-linked-pill">☁️ Cloud Save · ✓ Account Linked</div>'
          : isCloudflare
            ? '<div class="save-cloud-pill">☁️ Cloud Save</div>'
            : '';
      const upgradeBtnHtml =
        isCloudflare && s.isGuest
          ? '<button type="button" class="btn btn-sm btn-sky btn-card-hero-code">☁️ Save to Cloud</button>'
          : isCloudflare && !s.isGuest && !s.linkedToParent && state.me?.auth?.role === 'hero'
            ? '<button type="button" class="btn btn-sm btn-ghost btn-card-link-parent">🔗 Link to Account</button>'
            : '';
      card.innerHTML = `
        <div class="save-card-info">
          <div class="save-card-name">${escapeHtml(s.heroName)}</div>
          <div class="save-card-meta">
            ${escapeHtml(realm ? realm.name : s.realmId)} · ✦ ${Number(s.byteShards) || 0} Shards · 🐉 ${(s.rescuedDragons || []).length} Dragons
          </div>
          ${ownerBadgeHtml}
          ${guestBadgeHtml}
        </div>
        <div class="save-card-actions">
          ${upgradeBtnHtml}
          <button type="button" class="btn btn-sm btn-ghost btn-card-rename" title="Rename Hero" aria-label="Rename ${escapeHtml(s.heroName)}">✏️ Rename</button>
          <button type="button" class="btn btn-sm btn-primary btn-card-continue">Continue →</button>
        </div>
      `;

      const renameBtn = card.querySelector('.btn-card-rename');
      renameBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openRenameHeroFlow(s, { refreshList: true });
      });

      const upgradeBtn = card.querySelector('.btn-card-hero-code');
      upgradeBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        audio.playClick();
        upgradeBtn.disabled = true;
        upgradeBtn.textContent = 'Creating...';
        await upgradeGuestSaveToHeroCode(s);
        upgradeBtn.disabled = false;
        upgradeBtn.textContent = '☁️ Save to Cloud';
      });

      const linkParentBtn = card.querySelector('.btn-card-link-parent');
      linkParentBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        audio.playClick();
        linkParentBtn.disabled = true;
        linkParentBtn.textContent = 'Generating...';
        await openLinkToParentFlow();
        linkParentBtn.disabled = false;
        linkParentBtn.textContent = '🔗 Link to Account';
      });

      card.addEventListener('click', async () => {
        audio.playClick();
        if (s.id) {
          await navigateToGame(s);
        } else {
          await enterOverworld(s);
        }
      });
      listEl.appendChild(card);
    }
  } catch (err) {
    countEl.textContent = 'Offline';
    listEl.innerHTML = `<div class="empty-state">Could not reach save server: ${escapeHtml(err.message)}</div>`;
  }
}

function startTitlePreview() {
  const canvas = $('#title-preview-canvas');
  if (!canvas || !state.sprites) return;
  if (state.titleAnimTimer) clearInterval(state.titleAnimTimer);
  let frame = 0;
  const demoHero = { skin: 'warm_tan', hair: 'spiky', tunic: 'emerald', hat: 'hat_explorer', boots: 'boots_default' };
  const draw = () => {
    state.sprites.drawHeroAndPipPreview(canvas, demoHero, '8bit', 'down', frame);
    frame += 1;
  };
  draw();
  state.titleAnimTimer = setInterval(draw, 320);
}

// ==================== CHARACTER CREATION ====================
function updateCharCreateSummary() {
  const livePyEl = $('#cc-live-python-preview');
  if (livePyEl) {
    livePyEl.textContent = buildHeroForgePython(state.ccAppearance).trimEnd();
  }
}

function syncVisualPickerSelection() {
  const nameInput = $('#cc-name-input');
  if (nameInput && nameInput.value !== state.ccAppearance.name) {
    nameInput.value = state.ccAppearance.name || '';
  }
  document.querySelectorAll('#cc-skin-pills .picker-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === state.ccAppearance.skin);
  });
  document.querySelectorAll('#cc-hair-pills .picker-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === state.ccAppearance.hair);
  });
  document.querySelectorAll('#cc-tunic-pills .picker-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === state.ccAppearance.tunic);
  });
}

function setCharCreateMode(advanced) {
  state.ccAdvancedMode = Boolean(advanced);
  const toggleBtn = $('#btn-charcreate-advanced');
  const visualPanel = $('#charcreate-visual-panel');
  const advancedPanel = $('#charcreate-advanced-panel');
  const livePyBox = $('#cc-live-python-box');
  const spellbookBox = $('#charcreate-spellbook-box');
  const pyStatusEl = $('#charcreate-py-status');
  const titleEl = $('#forge-panel-title');

  if (state.ccAdvancedMode) {
    // Sync latest visual selections into the Python editor
    $('#charcreate-code').value = buildHeroForgePython(state.ccAppearance);
    state.ccGutter?.setMarks(new Map());
    visualPanel?.classList.add('hidden');
    livePyBox?.classList.add('hidden');
    advancedPanel?.classList.remove('hidden');
    spellbookBox?.classList.remove('hidden');
    pyStatusEl?.classList.remove('hidden');
    if (toggleBtn) {
      toggleBtn.textContent = '✨ Switch to Visual Mode';
      toggleBtn.classList.add('active');
      toggleBtn.classList.remove('recommended');
      toggleBtn.setAttribute('aria-pressed', 'true');
    }
    if (titleEl) titleEl.textContent = 'Hero Forge (Python)';
  } else {
    syncVisualPickerSelection();
    syncFamiliaritySelection();
    updateCharCreateSummary();
    advancedPanel?.classList.add('hidden');
    spellbookBox?.classList.add('hidden');
    pyStatusEl?.classList.add('hidden');
    visualPanel?.classList.remove('hidden');
    livePyBox?.classList.remove('hidden');
    if (toggleBtn) {
      toggleBtn.textContent = '⚡ Advanced Mode: Write Python';
      toggleBtn.classList.remove('active');
      toggleBtn.setAttribute('aria-pressed', 'false');
    }
    if (titleEl) titleEl.textContent = 'Hero Forge';
  }
}

function syncFamiliaritySelection() {
  const selected = getFamiliarityOption(state.ccFamiliarity);
  state.ccFamiliarity = selected.id;
  document.querySelectorAll('#cc-familiarity-options .familiarity-card').forEach((btn) => {
    const active = btn.dataset.value === selected.id;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  const summaryEl = $('#cc-familiarity-summary');
  if (summaryEl) {
    summaryEl.textContent = selected.calibrationSummary;
  }
  const toggleBtn = $('#btn-charcreate-advanced');
  if (toggleBtn) {
    toggleBtn.classList.toggle('recommended', selected.id === 'comfortable' && !state.ccAdvancedMode);
  }
}

function buildFamiliarityPicker() {
  const container = $('#cc-familiarity-options');
  if (!container) return;
  container.innerHTML = '';
  for (const level of PYTHON_FAMILIARITY_LEVELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'familiarity-card';
    btn.dataset.value = level.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.innerHTML = `
      <span class="familiarity-card-title"><span>${escapeHtml(level.badge)}</span><span>${escapeHtml(level.label)}</span></span>
      <span class="familiarity-card-desc">${escapeHtml(level.description)}</span>
    `;
    btn.addEventListener('click', () => {
      audio.playClick();
      state.ccFamiliarity = level.id;
      syncFamiliaritySelection();
    });
    container.appendChild(btn);
  }
  syncFamiliaritySelection();
}

function buildVisualHeroPickers() {
  const cc = state.catalog?.characterCreation;
  if (!cc) return;

  const renderGroup = (containerSel, values, field, swatches = null) => {
    const container = $(containerSel);
    if (!container) return;
    container.innerHTML = '';
    for (const val of values || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-pill';
      btn.dataset.value = val;
      if (swatches && swatches[val]) {
        const dot = document.createElement('span');
        dot.className = 'swatch-dot';
        dot.style.background = swatches[val];
        btn.appendChild(dot);
      }
      const label = document.createElement('span');
      label.textContent = formatOptionLabel(val);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        audio.playClick();
        state.ccAppearance[field] = val;
        syncVisualPickerSelection();
        updateCharCreateSummary();
      });
      container.appendChild(btn);
    }
  };

  renderGroup('#cc-skin-pills', cc.allowedValues.skin, 'skin', SKIN_SWATCHES);
  renderGroup('#cc-hair-pills', cc.allowedValues.hair, 'hair', null);
  renderGroup('#cc-tunic-pills', cc.allowedValues.tunic, 'tunic', TUNIC_SWATCHES);
}

async function createHeroForCurrentAuth(newSavePayload) {
  if (state.me?.mode === 'cloudflare' && state.me?.auth?.role === 'hero') {
    const activeHeroLabel = state.me?.auth?.heroName || 'your current hero';
    const linked = Boolean(state.me?.auth?.linkedToParent);
    const ok = await state.modals.confirmDialog({
      title: 'Start a New Hero?',
      badge: `Current: ${activeHeroLabel}`,
      message: `This will sign out ${activeHeroLabel} on this device so a new adventure can begin.`,
      subtext: linked
        ? `${activeHeroLabel} is safely linked to an account — you can always generate a fresh Hero Code in the Console!`
        : `Make sure you have ${activeHeroLabel}'s Hero Code written down so you can sign back in later.`,
      confirmLabel: 'Start New Hero',
      confirmClass: 'btn-primary',
      cancelLabel: 'Keep Playing Current Hero',
    });
    if (!ok) {
      return null;
    }
    // A child hero cookie is scoped to one saveId and cannot POST /api/saves.
    // Switch cleanly to Guest Mode so a sibling can start a new adventure locally.
    await logoutSession('hero').catch(() => {});
    state.me = await fetchMe();
    renderAccountIdentityBar();
    renderAdminRealmJump();
    return createGuestSave(newSavePayload);
  }
  if (isGuestMode(state.me)) {
    return createGuestSave(newSavePayload);
  }
  return createSave(newSavePayload);
}

async function launchAdventureFromHeroForge(errorEl) {
  const cleanedName = String(state.ccAppearance.name || '').trim();
  if (cleanedName.length < 2 || cleanedName.length > 16) {
    audio.playError();
    if (errorEl) {
      errorEl.textContent = 'Hero name must be between 2 and 16 characters long!';
      errorEl.classList.remove('hidden');
    }
    return false;
  }
  if (errorEl) errorEl.classList.add('hidden');

  if (state.ccAnimTimer) {
    clearInterval(state.ccAnimTimer);
    state.ccAnimTimer = null;
  }

  const newSavePayload = createDefaultSaveState(
    cleanedName,
    {
      skin: state.ccAppearance.skin,
      hair: state.ccAppearance.hair,
      tunic: state.ccAppearance.tunic,
    },
    buildPreferencesForFamiliarity(state.ccFamiliarity)
  );
  if (state.me?.isAdmin && state.adminOwnerFilter && state.adminOwnerFilter !== 'all') {
    newSavePayload.ownerEmail = state.adminOwnerFilter;
  }

  try {
    const created = await createHeroForCurrentAuth(newSavePayload);
    if (!created) return false;
    audio.playSuccess();
    await navigateToGame(created, { replace: true });
    showToast(`Welcome to Pyria, ${created.heroName}!`);
    return true;
  } catch (err) {
    audio.playError();
    if (errorEl) {
      errorEl.textContent = `Could not save hero: ${err.message}`;
      errorEl.classList.remove('hidden');
    }
    return false;
  }
}

function buildCharCreateSpellbook() {
  const container = $('#charcreate-spellbook');
  const cc = state.catalog?.characterCreation;
  if (!container || !cc) return;

  const groups = [
    {
      label: 'Functions',
      pills: [
        'set_name("Rowan")',
        'confirm_hero()',
      ],
    },
    {
      label: 'Skin Tones',
      pills: (cc.allowedValues.skin || []).map((v) => `preview_skin("${v}")`),
    },
    {
      label: 'Hairstyles',
      pills: (cc.allowedValues.hair || []).map((v) => `preview_hair("${v}")`),
    },
    {
      label: 'Tunic Colors',
      pills: (cc.allowedValues.tunic || []).map((v) => `preview_tunic("${v}")`),
    },
  ];

  container.innerHTML = '';
  for (const g of groups) {
    const labelEl = document.createElement('div');
    labelEl.className = 'spell-group-label';
    labelEl.textContent = g.label;
    container.appendChild(labelEl);

    for (const pillText of g.pills) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'spell-pill';
      btn.textContent = pillText;
      btn.addEventListener('click', () => {
        audio.playClick();
        const codeEl = $('#charcreate-code');
        const fnPrefix = pillText.split('(')[0] + '(';
        const lines = codeEl.value.split('\n');
        const idx = lines.findIndex((l) => l.trim().startsWith(fnPrefix));
        if (idx >= 0) {
          lines[idx] = pillText;
          codeEl.value = lines.join('\n');
        } else {
          // Insert before confirm_hero() if present
          const confirmIdx = lines.findIndex((l) => l.trim().startsWith('confirm_hero('));
          if (confirmIdx >= 0) {
            lines.splice(confirmIdx, 0, pillText);
          } else {
            lines.push(pillText);
          }
          codeEl.value = lines.join('\n');
        }
        state.ccGutter?.setMarks(new Map());
        codeEl.focus();
      });
      container.appendChild(btn);
    }
  }
}

function openCharCreateScreen() {
  const cc = state.catalog.characterCreation;
  state.ccAppearance = {
    name: 'Rowan',
    skin: cc.defaults.skin || 'warm_tan',
    hair: cc.defaults.hair || 'spiky',
    tunic: cc.defaults.tunic || 'emerald',
  };
  state.ccDirIndex = 0;
  state.ccFamiliarity = DEFAULT_FAMILIARITY_ID;
  $('#charcreate-code').value = cc.starterCode || buildHeroForgePython(state.ccAppearance);
  state.ccGutter?.setMarks(new Map());
  $('#cc-visual-error')?.classList.add('hidden');
  setCharCreateMode(false);
  syncVisualPickerSelection();
  syncFamiliaritySelection();
  updateCharCreateSummary();

  const outEl = $('#charcreate-output');
  outEl.className = 'pip-console';
  outEl.innerHTML = `
    <div class="pip-console-header">🐉 Pip says:</div>
    <div class="pip-console-body">
      Change your name, skin, hair, or tunic using real Python calls!
      Click any Spellbook pill on the left, then press <strong>Run Python</strong>.
      Include <code>confirm_hero()</code> to launch into Whispering Meadow!
    </div>
  `;

  showScreen('screen-charcreate');

  const canvas = $('#charcreate-canvas');
  if (state.ccAnimTimer) clearInterval(state.ccAnimTimer);
  let frame = 0;
  const draw = () => {
    state.sprites.drawHeroAndPipPreview(canvas, state.ccAppearance, '8bit', DIRS[state.ccDirIndex], frame);
    frame += 1;
  };
  draw();
  state.ccAnimTimer = setInterval(draw, 250);
}

async function runCharCreateCode() {
  const codeEl = $('#charcreate-code');
  const runBtn = $('#btn-charcreate-run');
  const outEl = $('#charcreate-output');
  const cc = state.catalog.characterCreation;

  runBtn.disabled = true;
  runBtn.textContent = 'Running...';
  audio.playCodeRun();

  const res = await pyRunner.runCharCreate(codeEl.value, state.ccAppearance, cc.allowedValues);
  runBtn.disabled = false;
  runBtn.textContent = '▶ Run Python';

  if (res.appearance) {
    state.ccAppearance = { ...state.ccAppearance, ...res.appearance };
    syncVisualPickerSelection();
    updateCharCreateSummary();
  }

  if (res.passed) {
    state.ccGutter?.setMarks(new Map());
    audio.playSuccess();
    outEl.className = 'pip-console success';
    outEl.innerHTML = `
      <div class="pip-console-header">🎉 Hero Forged!</div>
      <div class="pip-console-body">${escapeHtml(res.stdout ? res.stdout.trim() : 'Preview updated!')}</div>
    `;

    if (res.confirmed) {
      if (state.ccAnimTimer) {
        clearInterval(state.ccAnimTimer);
        state.ccAnimTimer = null;
      }
      const newSavePayload = createDefaultSaveState(
        state.ccAppearance.name || 'Rowan',
        {
          skin: state.ccAppearance.skin,
          hair: state.ccAppearance.hair,
          tunic: state.ccAppearance.tunic,
        },
        buildPreferencesForFamiliarity(state.ccFamiliarity)
      );
      if (state.me?.isAdmin && state.adminOwnerFilter && state.adminOwnerFilter !== 'all') {
        newSavePayload.ownerEmail = state.adminOwnerFilter;
      }
      try {
        const created = await createHeroForCurrentAuth(newSavePayload);
        if (!created) return;
        await navigateToGame(created, { replace: true });
        showToast(`Welcome to Pyria, ${created.heroName}!`);
      } catch (err) {
        outEl.className = 'pip-console error';
        outEl.innerHTML = `
          <div class="pip-console-header">⚠️ Could not save hero</div>
          <div class="pip-console-body">${escapeHtml(err.message)}</div>
        `;
      }
    }
  } else {
    if (res.errorLine) {
      const errLn = Number(res.errorLine);
      state.ccGutter?.setMarks(
        new Map([[errLn, { kind: 'hl-error', icon: '⚠️', badge: 'check this line' }]])
      );
      state.ccGutter?.scrollToLine(errLn);
    } else {
      state.ccGutter?.setMarks(new Map());
    }
    audio.playError();
    outEl.className = 'pip-console error';
    outEl.innerHTML = `
      <div class="pip-console-header">🐉 Pip's Clue:</div>
      <div class="pip-console-body">${escapeHtml(res.pipMessage)}</div>
    `;
  }
}

// ==================== OVERWORLD ENTRY & REALM LOADING ====================
async function refreshLiveContent() {
  const eraId = state.activeSave?.eraId || state.era?.id || 'era-01-8bit';
  try {
    const [config, era] = await Promise.all([fetchConfig(), fetchEra(eraId)]);
    if (config?.game) {
      state.gameConfig = config.game;
      if (config.heroPreferences) {
        state.gameConfig.heroPreferences = config.heroPreferences;
      }
    }
    if (config?.catalog) state.catalog = config.catalog;
    if (era) {
      if (!state.eras) state.eras = new Map();
      state.eras.set(era.id, era);
      state.era = era;
      if (state.activeRealm) {
        const refreshedRealm = (era.realms || []).find((r) => r.id === state.activeRealm.id);
        if (refreshedRealm) state.activeRealm = refreshedRealm;
      }
    }
  } catch (err) {
    console.warn('Live content refresh skipped:', err);
  }
}

async function loadRealm(realmId, spawnOverride = null) {
  const { era: targetEra, realm: foundRealm } = getEraAndRealm(realmId);
  if (targetEra && state.activeSave) {
    state.era = targetEra;
    state.activeSave.eraId = targetEra.id;
    state.activeSave.visualEra = ERA_TO_VISUAL[targetEra.id] || '8bit';
  }
  await refreshLiveContent();
  const realm = getRealm(realmId) || foundRealm;
  if (!realm) return;
  state.activeRealm = realm;
  state.activeSave.realmId = realm.id;

  let mapData = state.mapsCache.get(realm.id);
  if (!mapData) {
    mapData = await fetchMap(realm.id);
    state.mapsCache.set(realm.id, mapData);
  }
  state.activeMap = mapData;
  const visualEra = normalizeVisualEra(state.activeSave.visualEra);
  state.world.setEraKey(visualEra);
  state.world.loadMap(mapData, state.activeSave, spawnOverride);
  const startX = Math.floor(state.world.hero.x);
  const startY = Math.floor(state.world.hero.y);
  const startRegion = (mapData.regions || []).find(
    (r) => startX >= r.x && startX < r.x + r.width && startY >= r.y && startY < r.y + r.height
  );
  music.setTheme(resolveRegionTheme(startRegion?.id, realm.id), { immediate: true });
  music.setEra(visualEra);
  updateHud();
  if (state.activeSave?.heroName) {
    document.title = `${state.activeSave.heroName} · ${realm.name} — Pyria`;
  }
  showToast(`Entered ${realm.name} (${VISUAL_ERA_LABELS[visualEra]})!`);
}

async function enterOverworld(save) {
  if (state.titleAnimTimer) {
    clearInterval(state.titleAnimTimer);
    state.titleAnimTimer = null;
  }
  state.activeSave = save;
  showScreen('screen-game');
  state.world.setPaused(false);

  const targetRealm = save.realmId && getRealm(save.realmId) ? save.realmId : 'realm-01-meadow';
  const spawnOverride =
    save.position && save.position.realmId === targetRealm
      ? { x: save.position.x, y: save.position.y }
      : null;

  try {
    await loadRealm(targetRealm, spawnOverride);
  } catch (err) {
    console.warn(`Could not load map for ${targetRealm}, falling back to realm-01-meadow:`, err);
    await loadRealm('realm-01-meadow', null);
  }

  // Play the Opening Story Cutscene once for new heroes entering Whispering Meadow
  if (targetRealm === 'realm-01-meadow' && !(save.seenCutscenes || []).includes('opening')) {
    await runStoryCutsceneById('opening', { markSeen: true });
  }
}

// ==================== ENTITY INTERACTIONS ====================
let interactionInFlight = false;

async function handleEntityInteract(entity) {
  if (!entity || interactionInFlight || isCutsceneActive()) return;
  const modalOpen = !$('#modal-backdrop')?.classList.contains('hidden');
  if (modalOpen) return;

  interactionInFlight = true;
  try {
    await handleEntityInteractInner(entity);
  } finally {
    interactionInFlight = false;
  }
}

async function handleEntityInteractInner(entity) {
  const save = state.activeSave;
  if (!save) return;
  const eraKey = normalizeVisualEra(save.visualEra);
  const completed = getSolvedTrialsSet(save);
  const rescued = new Set(save.rescuedDragons || []);

  if (entity.type === 'npc') {
    const npc = getNpc(entity.refId);
    if (entity.refId === 'elder-ada') {
      const realm = state.activeRealm;
      const realmTrials = (realm?.trials || []).filter((t) => !t.isBonus);
      const solvedCount = realmTrials.filter((t) => completed.has(t.id)).length;
      const nextTrial = realmTrials.find((t) => !completed.has(t.id));
      const dragon = realm?.dragon;
      const dragonFree = Boolean(dragon && rescued.has(dragon.id));
      let msg = realm?.storyIntro || npc.personality;
      if (dragonFree) {
        msg = `Wonderful work, ${save.heroName}! ${dragon.name} is free and Bit ${realm.number} is restored! Step through the glowing exit Portal to continue your quest through Pyria!`;
      } else if (solvedCount > 0 && nextTrial) {
        msg = `You've conquered ${solvedCount} of ${realmTrials.length} Trials in ${realm?.name}, ${save.heroName}! Follow the gold ! marker on your minimap to find "${nextTrial.title}".`;
      } else if (solvedCount >= realmTrials.length && realmTrials.length > 0 && dragon) {
        msg = `All ${realmTrials.length} Trials are solved, ${save.heroName}! Head to ${dragon.name}'s Logic Vault (the glowing red dot on your minimap) to rescue ${dragon.name}!`;
      }
      state.modals.openNpcDialogue({ npc, spriteKey: entity.spriteKey, message: msg, eraKey });
    } else if (entity.refId === 'bram') {
      const charismaLine =
        save.stats?.charisma > 0
          ? `Hah! I can feel that Charisma Spark glowing on ya, ${save.heroName}! `
          : '';
      state.modals.openNpcDialogue({
        npc,
        spriteKey: entity.spriteKey,
        message: `${charismaLine}Bring me Byte Shards from Trials and chests, and write real Python function calls at my anvil to forge gear and upgrades!`,
        eraKey,
        extraAction: {
          label: "⚒ Open Bram's Workshop",
          onClick: () => openWorkshop(),
        },
      });
    } else {
      state.modals.openNpcDialogue({ npc, spriteKey: entity.spriteKey, message: npc.personality, eraKey });
    }
    return;
  }

  if (entity.type === 'workshop') {
    openWorkshop();
    return;
  }

  if (entity.type === 'chest') {
    const opened = new Set(save.openedChests || []);
    if (opened.has(entity.id)) {
      showToast('This chest is already empty!');
      audio.playClick();
      return;
    }
    const reward = Number(entity.shardReward) || 15;
    save.openedChests.push(entity.id);
    save.byteShards += reward;
    updateHud();
    await persistSave();
    state.modals.openChestModal({
      label: entity.label,
      shardReward: reward,
      totalShards: save.byteShards,
    });
    return;
  }

  if (entity.type === 'easter_egg') {
    if (!Array.isArray(save.foundEasterEggs)) save.foundEasterEggs = [];
    const alreadyFound = save.foundEasterEggs.includes(entity.id);
    const reward = Number(entity.shardReward) || 15;
    if (!alreadyFound) {
      save.foundEasterEggs.push(entity.id);
      save.byteShards += reward;
      updateHud();
      await persistSave();
    }
    const secrets = getSecretsStats(save);
    state.modals.openEasterEggModal({
      entity,
      alreadyFound,
      shardReward: reward,
      totalEggs: secrets.foundEggsCount,
      bonusHints: secrets.bonusHints,
    });
    return;
  }

  if (entity.type === 'trial' || entity.type === 'bonus_trial') {
    if (entity.type === 'bonus_trial') {
      const lockInfo = getBonusLockInfo(entity, save, state.activeRealm);
      if (lockInfo.locked) {
        audio.playError();
        showToast(`🔒 Pip: ${lockInfo.reason}`);
        return;
      }
    }
    if (entity.requiredTrialId && !completed.has(entity.requiredTrialId)) {
      audio.playError();
      showToast('Solve the earlier Trial first to unlock this path!');
      return;
    }
    const { trial, realm } = getTrial(entity.refId);
    if (!trial) {
      showToast(`Trial ${entity.refId} not found.`);
      return;
    }
    const alreadySolved = completed.has(trial.id);

    // Pre-Boss Cut-Scene trigger (once per Realm when facing an unsolved Boss Trial)
    const preBossBeats = realm?.cutscenes?.preBoss;
    const preBossKey = `${realm.id}:preBoss`;
    if (
      !alreadySolved &&
      realm?.cutscenes?.bossTrialId === trial.id &&
      Array.isArray(preBossBeats) &&
      preBossBeats.length > 0 &&
      !(save.seenCutscenes || []).includes(preBossKey)
    ) {
      if (!Array.isArray(save.seenCutscenes)) save.seenCutscenes = [];
      save.seenCutscenes.push(preBossKey);
      state.world.setPaused(true);
      music.setTheme('vault');
      audio.playBossIntro();
      await playCutscene({
        id: preBossKey,
        title: '⚔️ BOSS ENCOUNTER',
        subtitle: `${realm.name} — ${trial.title}`,
        beats: preBossBeats,
        save,
        sprites: state.sprites,
        eraKey,
        realmId: realm.id,
        finalButtonLabel: '⚔️ Face the Boss Trial!',
      });
      await persistSave();
    }

    const hasBridgeUnlock = (entity.dynamicTiles || []).some((d) => d.tileWhenUnlocked === 'bridge_wood');
    const hasGateUnlock = (entity.dynamicTiles || []).some((d) => d.tileWhenUnlocked === 'mossy_gate_open');
    const unlockNote = hasBridgeUnlock
      ? 'The broken bridge is repaired — you can cross now!'
      : hasGateUnlock
        ? 'The mossy gate slid open — the path ahead is clear!'
        : null;

    const secretsStats = getSecretsStats(save);
    state.modals.openTrialModal({
      trial,
      realm,
      era: state.era,
      gameConfig: state.gameConfig,
      catalog: state.catalog,
      save,
      alreadySolved,
      unlockNote,
      bonusHints: secretsStats.bonusHints,
      onEquipKitReward: async (kit) => {
        if (kit?.equipLayer && kit?.equipKey) {
          save.appearance[kit.equipLayer] = kit.equipKey;
          state.world.setSave(save);
          updateHud();
          showToast(`✨ Equipped ${kit.name}!`);
          await persistSave();
        }
      },
      savedDraft: alreadySolved ? null : getTrialDraft(save, trial.id),
      onDraftChange: (code) => updateTrialDraft(save, trial.id, code, { immediatePersist: false }),
      onDraftFlush: (code) => updateTrialDraft(save, trial.id, code, { immediatePersist: true }),
      onDraftClear: (opts) => clearTrialDraft(save, trial.id, opts),
      onAttempt: (attempt) => {
        if (isActiveSaveGuest(save)) return;
        logAttempt(save.id, attempt).catch((err) => {
          console.warn('Attempt log failed:', err);
          if (state.me?.mode === 'cloudflare' && (err?.status === 401 || err?.status === 403)) {
            handleHeroSessionExpired(state.activeSave);
          }
        });
      },
      onSolved: async (solvedTrial) => {
        const solvedSet = getSolvedTrialsSet(save);
        const isFirstSolve = !solvedSet.has(solvedTrial.id);
        if (isFirstSolve) {
          solvedSet.add(solvedTrial.id);
          save.solvedTrials = [...solvedSet];
          save.completedTrials = [...solvedSet];
          save.byteShards += Number(solvedTrial.shardReward) || 0;
          if (solvedTrial.isBonus) {
            audio.playSecretFound();
            const kit = solvedTrial.bonusKitReward;
            if (kit?.unlockId) {
              if (!Array.isArray(save.ownedUnlockIds)) save.ownedUnlockIds = [];
              if (!save.ownedUnlockIds.includes(kit.unlockId)) {
                save.ownedUnlockIds.push(kit.unlockId);
              }
            }
            if (kit?.spellName) {
              if (!Array.isArray(save.unlockedSpells)) save.unlockedSpells = [];
              if (!save.unlockedSpells.includes(kit.spellName)) {
                save.unlockedSpells.push(kit.spellName);
              }
            }
            showToast(`🌟 Bonus Complete! +${solvedTrial.shardReward} Shards & +1 Bonus Hint!`);
          } else {
            showToast(`✓ Trial Complete! +${solvedTrial.shardReward} Byte Shards!`);
          }
        } else {
          showToast(`✓ Practice run passed for ${solvedTrial.title}!`);
        }
        state.world.setSave(save);
        await refreshLiveContent();
        updateHud();
        await persistSave();
      },
    });
    return;
  }

  if (entity.type === 'vault') {
    if (entity.requiredTrialId && !completed.has(entity.requiredTrialId)) {
      audio.playError();
      showToast('Unlock the Vault Gate Trial first!');
      return;
    }
    const realm = state.activeRealm;
    const alreadyRescued = rescued.has(entity.refId);
    const postBossBeats = realm?.cutscenes?.postBoss;

    // Post-Boss Cut-Scene trigger on first rescue of a Realm's Dragon
    if (!alreadyRescued && Array.isArray(postBossBeats) && postBossBeats.length > 0) {
      state.world.setPaused(true);
      audio.playVaultShatter();
      audio.playDragonRescue();
      const bitNum = realm?.number ?? save.rescuedDragons.length + 1;
      const dragonName = realm?.dragon?.name || 'the Dragon';
      const dragonTitle = realm?.dragon?.title || 'Dragon Guardian';
      const upgradeNote = realm?.miniVisualUpgrade || 'Portal unlocked!';

      await playCutscene({
        id: `${realm.id}:postBoss`,
        title: `✨ BIT ${bitNum} RESTORED`,
        subtitle: `${dragonName} — ${dragonTitle}`,
        beats: postBossBeats,
        save,
        sprites: state.sprites,
        eraKey,
        realmId: realm.id,
        finalButtonLabel: '✨ Claim Bit & Continue!',
      });

      if (!save.rescuedDragons.includes(entity.refId)) {
        save.rescuedDragons.push(entity.refId);
      }
      const postBossKey = `${realm.id}:postBoss`;
      if (!Array.isArray(save.seenCutscenes)) save.seenCutscenes = [];
      if (!save.seenCutscenes.includes(postBossKey)) {
        save.seenCutscenes.push(postBossKey);
      }
      showToast(`✨ Bit ${bitNum} Restored! ${dragonName} is free — ${upgradeNote}`);
      maybeShowGuestCloudNudge(save);
      await refreshLiveContent();
      updateHud();
      await persistSave();
      state.world.setPaused(false);
      return;
    }

    state.modals.openDragonRescueModal({
      realm,
      spriteKey: entity.spriteKey,
      eraKey,
      alreadyRescued,
      onConfirm: async () => {
        if (!alreadyRescued) {
          save.rescuedDragons.push(entity.refId);
          const bitNum = realm?.number ?? save.rescuedDragons.length;
          const dragonName = realm?.dragon?.name || 'the Dragon';
          const upgradeNote = realm?.miniVisualUpgrade || 'Portal unlocked!';
          showToast(`✨ Bit ${bitNum} Restored! ${dragonName} is free — ${upgradeNote}`);
          maybeShowGuestCloudNudge(save);
          await refreshLiveContent();
          updateHud();
          await persistSave();
        }
      },
    });
    return;
  }

  if (entity.type === 'portal') {
    if (entity.requiredTrialId && !completed.has(entity.requiredTrialId)) {
      audio.playError();
      showToast('Complete the Realm Trials to activate this Portal!');
      return;
    }

    const currentRealm = state.activeRealm;
    const targetRealm = getRealm(entity.refId);
    const isForwardPortal =
      !String(entity.id || '').startsWith('portal-back-') &&
      Boolean(entity.requiredTrialId);

    if (isForwardPortal && currentRealm?.dragon?.id && !rescued.has(currentRealm.dragon.id)) {
      audio.playError();
      showToast(`Rescue ${currentRealm.dragon.name} in the Logic Vault first!`);
      return;
    }

    const targetRealmId = entity.refId;
    try {
      let mapData = state.mapsCache.get(targetRealmId);
      if (!mapData) {
        mapData = await fetchMap(targetRealmId);
        state.mapsCache.set(targetRealmId, mapData);
      }
      audio.playPortal();
      const prevEraId = state.activeSave?.eraId;
      await loadRealm(targetRealmId);
      await persistSave();
      const newEraId = state.activeSave?.eraId;
      if (prevEraId && newEraId && prevEraId !== newEraId) {
        const eraCsMap = {
          'era-02-16bit': 'era-transition-16bit',
          'era-03-32bit': 'era-transition-32bit',
          'era-04-64bit': 'era-transition-64bit',
        };
        const csId = eraCsMap[newEraId];
        if (csId && !(state.activeSave.seenCutscenes || []).includes(csId)) {
          await runStoryCutsceneById(csId, { markSeen: true });
        }
      }
    } catch {
      audio.playDragonRescue();
      const nextRealmName = targetRealm?.name || 'the next Realm';
      state.modals.openNpcDialogue({
        npc: getNpc('elder-ada'),
        spriteKey: 'elder_ada',
        eraKey,
        message: `Chapter Complete, ${save.heroName}! You've conquered ${currentRealm?.name || 'this Realm'} and rescued ${save.rescuedDragons.length} dragons! Stay tuned for ${nextRealmName} — feel free to return to Whispering Meadow or forge more gear at Bram's Workshop!`,
        extraAction: {
          label: 'Return to Whispering Meadow',
          onClick: async () => {
            audio.playPortal();
            await loadRealm('realm-01-meadow');
            await persistSave();
          },
        },
      });
    }
  }
}

function openWorkshop() {
  const save = state.activeSave;
  if (!save) return;
  const eraKey = normalizeVisualEra(save.visualEra);
  state.modals.openWorkshopModal({
    catalog: state.catalog,
    save,
    eraKey,
    onSaveUpdated: async (updated) => {
      state.activeSave.appearance = updated.appearance;
      state.activeSave.stats = updated.stats;
      state.activeSave.ownedUnlockIds = updated.ownedUnlockIds;
      state.activeSave.byteShards = updated.byteShards;
      state.world.setSave(state.activeSave);
      updateHud();
      await persistSave();
    },
  });
}

// ==================== FORMAL NAVIGATION & GAME MENU ====================
async function resolveSaveById(saveId) {
  if (!saveId) return null;

  const isGuestId = String(saveId).startsWith('guest-');
  if (isGuestId) {
    const local = getGuestSave(saveId);
    if (local) return local;
  } else {
    try {
      const remote = await getSave(saveId);
      if (remote) return remote;
    } catch (err) {
      // Fall back to pending save or local guest save if applicable
      console.warn(`Could not fetch save ${saveId} from server:`, err);
    }
  }

  if (state.pendingSaveForRoute && state.pendingSaveForRoute.id === saveId) {
    return state.pendingSaveForRoute;
  }

  return getGuestSave(saveId);
}

async function navigateToGame(save, { replace = false } = {}) {
  if (!save) return;
  if (!save.id || !state.router) {
    await enterOverworld(save);
    return;
  }
  state.pendingSaveForRoute = save;
  await state.router.navigate({ name: 'game', saveId: save.id }, { replace });
}

async function returnToTitle() {
  if (state.modals?.isOpen()) {
    state.modals.close();
  }
  if (state.activeSave) {
    await persistSave();
  }
  if (state.router) {
    await state.router.navigate({ name: 'title' });
  } else {
    showScreen('screen-title');
    startTitlePreview();
    await refreshSavesList();
  }
}

async function handleRoute(ctx) {
  const { route, isCurrent } = ctx;

  // Cleanly tear down active screen state when navigating away
  if (route.name !== 'game') {
    if (state.modals?.isOpen()) {
      state.modals.close();
    }
    if ($('#screen-game')?.classList.contains('active') && state.activeSave) {
      await persistSave();
      if (!isCurrent()) return;
    }
  }
  if (route.name !== 'charcreate' && state.ccAnimTimer) {
    clearInterval(state.ccAnimTimer);
    state.ccAnimTimer = null;
  }

  if (route.name === 'title') {
    document.title = 'Pyria: Return of the Bits';
    showScreen('screen-title');
    startTitlePreview();
    await refreshSavesList();
    return;
  }

  if (route.name === 'charcreate') {
    document.title = 'Forge Your Hero — Pyria';
    openCharCreateScreen();
    return;
  }

  if (route.name === 'game') {
    const saveId = route.saveId;
    const preloaded =
      state.pendingSaveForRoute && state.pendingSaveForRoute.id === saveId
        ? state.pendingSaveForRoute
        : null;
    state.pendingSaveForRoute = null;

    // If already playing this exact save and screen is active, no need to reload
    if (
      state.activeSave &&
      state.activeSave.id === saveId &&
      $('#screen-game')?.classList.contains('active')
    ) {
      return;
    }

    let save = null;
    if (preloaded && preloaded.isGuest) {
      save = getGuestSave(saveId) || preloaded;
    } else if (preloaded && ctx.source === 'replace') {
      // Newly forged hero — already fresh from POST /api/saves
      save = preloaded;
    } else {
      // Always fetch latest server state when loading from Save Picker, refresh, or browser history
      save = await resolveSaveById(saveId);
      if (!save && preloaded) save = preloaded;
    }

    if (!isCurrent()) return;

    if (!save) {
      await state.router.navigate({ name: 'title' }, { replace: true });
      showToast('Could not load that hero save — returned to Main Title.');
      return;
    }

    document.title = `${save.heroName || 'Code-Tamer'} — Pyria`;
    await enterOverworld(save);
  }
}

function openGameMenu() {
  if (!state.activeSave || !state.modals) return;
  audio.playClick();
  const eraKey = normalizeVisualEra(state.activeSave.visualEra);
  state.modals.openGameMenuModal({
    save: state.activeSave,
    realm: state.activeRealm,
    eraLabel: VISUAL_ERA_LABELS[eraKey] || '8-Bit NES',
    isGuestCloudflare: state.me?.mode === 'cloudflare' && isActiveSaveGuest(state.activeSave),
    musicEnabled: music.isEnabled(),
    muted: audio.isMuted(),
    onOpenWorkshop: () => openWorkshop(),
    onSaveNow: async () => {
      await persistSave();
      showToast('Progress saved!');
    },
    onReturnToTitle: async () => {
      await returnToTitle();
    },
    onToggleMusic: () => {
      music.toggle();
      audio.playClick();
      syncMusicButtons();
      return music.isEnabled();
    },
    onToggleMute: () => {
      audio.toggleMute();
      updateHud();
      return audio.isMuted();
    },
    onGetHeroCode: async () => {
      if (!state.activeSave || heroCodeUpgradeInFlight) return;
      await persistSave();
      await upgradeGuestSaveToHeroCode(state.activeSave);
    },
  });
}

// ==================== WIRE UI EVENTS ====================
function wireControls() {
  // Title
  $('#btn-new-adventure').addEventListener('click', () => {
    audio.playClick();
    state.router.navigate({ name: 'charcreate' });
  });

  $('#btn-enter-hero-code')?.addEventListener('click', () => {
    audio.playClick();
    openEnterHeroCodeFlow();
  });

  $('#btn-hero-link-parent')?.addEventListener('click', async () => {
    const btn = $('#btn-hero-link-parent');
    audio.playClick();
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generating...';
    }
    try {
      await openLinkToParentFlow();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔗 Link Account';
      }
    }
  });

  $('#btn-account-signout')?.addEventListener('click', async () => {
    const btn = $('#btn-account-signout');
    audio.playClick();
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Signing out...';
    }
    try {
      await logoutSession('parent');
    } catch (err) {
      console.warn('Account sign out warning:', err);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Sign Out';
      }
    }
    const [freshMe, freshConfig] = await Promise.all([
      fetchMe(),
      fetchConfig().catch(() => null),
    ]);
    state.me = freshMe;
    if (freshConfig?.game) {
      state.gameConfig = freshConfig.game;
      if (freshConfig.heroPreferences) {
        state.gameConfig.heroPreferences = freshConfig.heroPreferences;
      }
    }
    renderAccountIdentityBar();
    renderAdminRealmJump();
    await refreshSavesList();
    showToast('Signed out!');
  });

  $('#btn-hero-signout')?.addEventListener('click', async () => {
    audio.playClick();
    const activeHeroLabel = state.me?.auth?.heroName || 'your current hero';
    const linked = Boolean(state.me?.auth?.linkedToParent);
    const ok = await state.modals.confirmDialog({
      title: 'Switch Hero?',
      badge: `Signed in as ${activeHeroLabel}`,
      message: `Sign out ${activeHeroLabel} on this device?`,
      subtext: linked
        ? `${activeHeroLabel}'s cloud progress is safe and linked to an account — you can always generate a fresh Hero Code in the Console.`
        : `Make sure you have ${activeHeroLabel}'s Hero Code written down so you can sign back in later!`,
      confirmLabel: 'Switch Hero',
      confirmClass: 'btn-sky',
      cancelLabel: 'Stay Signed In',
    });
    if (!ok) {
      return;
    }
    try {
      await logoutSession('hero');
    } catch (err) {
      console.warn('Hero sign out warning:', err);
    }
    state.me = await fetchMe();
    renderAccountIdentityBar();
    renderAdminRealmJump();
    await refreshSavesList();
    showToast('Switched back to Guest Mode.');
  });

  $('#admin-account-select')?.addEventListener('change', async (e) => {
    state.adminOwnerFilter = e.target.value || 'all';
    sessionStorage.setItem(ADMIN_OWNER_STORAGE_KEY, state.adminOwnerFilter);
    audio.playClick();
    await refreshSavesList();
  });

  // Character Creation
  $('#btn-charcreate-back').addEventListener('click', async () => {
    audio.playClick();
    await state.router.navigate({ name: 'title' });
  });

  $('#btn-preview-turn').addEventListener('click', () => {
    state.ccDirIndex = (state.ccDirIndex + 1) % DIRS.length;
    audio.playClick();
  });

  $('#btn-charcreate-advanced').addEventListener('click', () => {
    audio.playClick();
    setCharCreateMode(!state.ccAdvancedMode);
  });

  $('#cc-name-input').addEventListener('input', (e) => {
    state.ccAppearance.name = e.target.value;
    $('#cc-visual-error')?.classList.add('hidden');
    updateCharCreateSummary();
  });

  $('#cc-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#btn-charcreate-start')?.click();
    }
  });

  $('#btn-charcreate-start').addEventListener('click', async () => {
    const startBtn = $('#btn-charcreate-start');
    startBtn.disabled = true;
    startBtn.textContent = 'Starting Adventure...';
    const ok = await launchAdventureFromHeroForge($('#cc-visual-error'));
    if (!ok) {
      startBtn.disabled = false;
      startBtn.textContent = '✦ Start Adventure';
    } else {
      startBtn.disabled = false;
      startBtn.textContent = '✦ Start Adventure';
    }
  });

  const ccCodeEl = $('#charcreate-code');
  state.ccGutter = attachCodeGutter(
    ccCodeEl,
    $('#charcreate-code-gutter'),
    $('#charcreate-code-highlights')
  );
  ccCodeEl.addEventListener('input', () => state.ccGutter?.setMarks(new Map()));
  $('#btn-charcreate-run').addEventListener('click', runCharCreateCode);
  $('#btn-charcreate-reset').addEventListener('click', () => {
    ccCodeEl.value = state.catalog?.characterCreation?.starterCode || '';
    state.ccGutter?.setMarks(new Map());
    audio.playClick();
  });
  attachCodeEditorKeys(ccCodeEl, runCharCreateCode);
  attachAutocomplete(ccCodeEl, () => buildCharCreateSuggestions(state.catalog));

  // HUD
  $('#btn-hud-rename')?.addEventListener('click', () => {
    if (!state.activeSave) return;
    openRenameHeroFlow(state.activeSave);
  });
  $('#hud-admin-realm-jump')?.addEventListener('change', async (e) => {
    const targetRealmId = e.target.value;
    e.target.blur();
    if (!state.me?.isAdmin || !state.activeSave || !targetRealmId) return;
    if (targetRealmId === state.activeRealm?.id) return;
    try {
      audio.playPortal();
      await loadRealm(targetRealmId, null);
      await persistSave();
    } catch (err) {
      audio.playError();
      showToast(`Jump failed: ${err.message}`);
    }
  });
  $('#hud-admin-cutscene-preview')?.addEventListener('change', async (e) => {
    const csId = e.target.value;
    e.target.value = '';
    e.target.blur();
    if (!state.me?.isAdmin || !csId) return;
    await runStoryCutsceneById(csId, { markSeen: false });
  });
  $('#btn-hud-hero-code')?.addEventListener('click', async () => {
    const btn = $('#btn-hud-hero-code');
    if (!state.activeSave || heroCodeUpgradeInFlight) return;
    audio.playClick();
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Creating...';
    }
    try {
      await persistSave();
      await upgradeGuestSaveToHeroCode(state.activeSave);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '☁️ Save to Cloud';
      }
    }
  });
  $('#btn-hud-workshop').addEventListener('click', () => openWorkshop());

  for (const sel of ['#btn-hud-music', '#btn-title-music', '#btn-charcreate-music']) {
    $(sel)?.addEventListener('click', () => {
      music.toggle();
      audio.playClick();
      syncMusicButtons();
    });
  }
  music.onChange(() => syncMusicButtons());
  syncMusicButtons();

  $('#btn-hud-mute').addEventListener('click', () => {
    audio.toggleMute();
    updateHud();
  });

  $('#btn-hud-title')?.addEventListener('click', async () => {
    audio.playClick();
    await returnToTitle();
  });

  $('#btn-hud-menu').addEventListener('click', () => {
    openGameMenu();
  });

  $('#btn-hud-autopath')?.addEventListener('click', () => {
    if (!state.world) return;
    if (state.world.autoPath) {
      state.world.cancelAutoPath();
      audio.playClick();
      return;
    }
    const res = state.world.startAutoPathToNextObjective();
    if (!res.ok) {
      audio.playError();
      if (res.reason === 'blocked') {
        showToast('🧭 Path is blocked right now — try unlocking the gate or bridge first!');
      } else {
        showToast('✨ No remaining objectives in this Realm!');
      }
    } else if (res.arrived) {
      showToast(`✨ You're already right at ${res.entity?.label || 'your next objective'}!`);
    } else {
      showToast(`🧭 Walking to ${res.entity?.label || 'next Trial'}… (press WASD/Arrows to cancel)`);
    }
  });

  // Escape opens the Game Menu when in the overworld with no modal or cutscene active
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!$('#screen-game')?.classList.contains('active')) return;
    if (state.modals?.isOpen()) return;
    if (document.querySelector('.cutscene-overlay')) return;
    e.preventDefault();
    openGameMenu();
  });

  // Persist current hero position on refresh / tab hide so reloading resumes right where you stood
  window.addEventListener('pagehide', persistPositionOnPageHide);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persistPositionOnPageHide();
    }
  });

  // Prevent iPadOS Safari text selection across the overworld screen (never blocking inputs/textareas)
  $('#screen-game')?.addEventListener('selectstart', (e) => {
    const tag = e.target?.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
    }
  });

  // Interact prompt + circular touch Interact button (multi-touch safe with passive: false)
  $('#interact-prompt').addEventListener('click', () => {
    state.world?.triggerInteract();
  });

  const touchInteractBtn = $('#btn-touch-interact');
  if (touchInteractBtn) {
    let lastTouchInteractMs = 0;
    touchInteractBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    touchInteractBtn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        lastTouchInteractMs = Date.now();
        touchInteractBtn.classList.add('pressed');
        state.world?.triggerInteract();
      },
      { passive: false }
    );
    const clearInteractPress = (e) => {
      e.preventDefault();
      touchInteractBtn.classList.remove('pressed');
    };
    touchInteractBtn.addEventListener('touchend', clearInteractPress, { passive: false });
    touchInteractBtn.addEventListener('touchcancel', clearInteractPress, { passive: false });
    touchInteractBtn.addEventListener('click', () => {
      if (Date.now() - lastTouchInteractMs < 400) return;
      state.world?.triggerInteract();
    });
  }

  // Roblox/Minecraft-style Virtual Thumbstick (multi-touch by touch.identifier + mouse drag)
  const joystickEl = $('#touch-joystick');
  const nubEl = $('#joystick-nub');
  if (joystickEl && nubEl) {
    const MAX_RADIUS = 38;
    const DEADZONE = 12;
    let activeTouchId = null;
    let mouseDragging = false;
    let centerX = 0;
    let centerY = 0;

    const refreshCenter = () => {
      const rect = joystickEl.getBoundingClientRect();
      centerX = rect.left + rect.width / 2;
      centerY = rect.top + rect.height / 2;
    };

    const applyVirtualVec = (vx, vy) => {
      if (!state.world) return;
      if (typeof state.world.setVirtualVector === 'function') {
        state.world.setVirtualVector(vx, vy);
      } else if (vx === 0 && vy === 0) {
        state.world.setVirtualDirection?.(null);
      } else if (Math.abs(vx) > Math.abs(vy)) {
        state.world.setVirtualDirection?.(vx < 0 ? 'left' : 'right');
      } else {
        state.world.setVirtualDirection?.(vy < 0 ? 'up' : 'down');
      }
    };

    const updateStick = (clientX, clientY) => {
      const dx = clientX - centerX;
      const dy = clientY - centerY;
      const dist = Math.hypot(dx, dy);
      const clampedDist = Math.min(MAX_RADIUS, dist);
      const angle = Math.atan2(dy, dx);
      const nx = dist > 0 ? Math.cos(angle) * clampedDist : 0;
      const ny = dist > 0 ? Math.sin(angle) * clampedDist : 0;
      nubEl.style.transform = `translate3d(${nx.toFixed(1)}px, ${ny.toFixed(1)}px, 0)`;

      if (dist < DEADZONE) {
        applyVirtualVec(0, 0);
      } else {
        // Smooth 360° analog / diagonal movement (scaled 0.45..1.0 past deadzone)
        const norm = Math.min(1, (dist - DEADZONE) / (MAX_RADIUS - DEADZONE));
        const speedScale = 0.45 + 0.55 * norm;
        applyVirtualVec(Math.cos(angle) * speedScale, Math.sin(angle) * speedScale);
      }
    };

    const resetStick = () => {
      activeTouchId = null;
      mouseDragging = false;
      joystickEl.classList.remove('active');
      nubEl.style.transform = 'translate3d(0, 0, 0)';
      applyVirtualVec(0, 0);
    };

    joystickEl.addEventListener('contextmenu', (e) => e.preventDefault());

    // Strict { passive: false } touch listeners for iPadOS Safari
    joystickEl.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        if (activeTouchId !== null) return;
        const t = e.changedTouches[0];
        if (!t) return;
        activeTouchId = t.identifier;
        joystickEl.classList.add('active');
        refreshCenter();
        updateStick(t.clientX, t.clientY);
      },
      { passive: false }
    );

    const onWindowTouchMove = (e) => {
      if (activeTouchId === null) return;
      for (const t of e.touches) {
        if (t.identifier === activeTouchId) {
          e.preventDefault();
          updateStick(t.clientX, t.clientY);
          return;
        }
      }
    };

    const endTouchStick = (e) => {
      if (activeTouchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier === activeTouchId) {
          e.preventDefault();
          resetStick();
          return;
        }
      }
    };
    window.addEventListener('touchmove', onWindowTouchMove, { passive: false });
    window.addEventListener('touchend', endTouchStick, { passive: false });
    window.addEventListener('touchcancel', endTouchStick, { passive: false });

    // Desktop mouse drag support
    joystickEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      mouseDragging = true;
      joystickEl.classList.add('active');
      refreshCenter();
      updateStick(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => {
      if (!mouseDragging) return;
      updateStick(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', () => {
      if (mouseDragging) resetStick();
    });
    window.addEventListener('blur', resetStick);
  }

  // Pyodide status indicators
  pyRunner.onStatusChange((status) => {
    const els = [$('#charcreate-py-status'), $('#hud-py-status')];
    for (const el of els) {
      if (!el) continue;
      const keepHidden = el.id === 'charcreate-py-status' && !state.ccAdvancedMode;
      el.textContent = status.label;
      el.className = `py-status pill ${
        status.state === 'ready' ? 'pill-green' : status.state === 'error' ? 'pill-rose' : 'pill-muted'
      }${keepHidden ? ' hidden' : ''}`;
    }
  });
}

// ==================== BOOTSTRAP ====================
function capturePendingPlayToken() {
  try {
    const url = new URL(window.location.href);
    const token = (url.searchParams.get('play') || '').trim();
    if (!token) return '';
    url.searchParams.delete('play');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return token;
  } catch {
    return '';
  }
}

async function handlePendingPlayToken(playToken) {
  if (!playToken || state.me?.mode !== 'cloudflare') return;
  try {
    const preview = await previewHeroPlayToken(playToken);
    if (!preview.valid || !preview.heroName) {
      throw new Error('This play link has expired or is no longer valid.');
    }
    const currentHeroName =
      state.me?.auth?.role === 'hero' ? state.me?.auth?.heroName || '' : '';
    state.modals.openPlayLinkConfirmModal({
      heroName: preview.heroName,
      currentHeroName,
      onConfirm: async () => {
        const res = await redeemHeroPlayToken(playToken);
        if (!res.save) {
          throw new Error('Could not load hero for that play link.');
        }
        lastExpiredSaveId = null;
        const [freshMe, freshConfig] = await Promise.all([
          fetchMe(),
          fetchConfig().catch(() => null),
        ]);
        state.me = freshMe;
        if (freshConfig?.game) {
          state.gameConfig = freshConfig.game;
          if (freshConfig.heroPreferences) {
            state.gameConfig.heroPreferences = freshConfig.heroPreferences;
          }
        }
        renderAccountIdentityBar();
        renderAdminRealmJump();
        audio.playSuccess();
        await navigateToGame(res.save);
        showToast(`Welcome back, ${res.save.heroName}!`);
      },
    });
  } catch (err) {
    state.modals.openPlayLinkInvalidModal({
      message: err?.detail || err?.message,
      onEnterHeroCode: () => openEnterHeroCodeFlow(),
    });
  }
}

async function init() {
  const pendingPlayToken = capturePendingPlayToken();
  try {
    const [me, config, spriteManifest, tilesetManifest] = await Promise.all([
      fetchMe(),
      fetchConfig(),
      fetchSpriteManifest(),
      fetchTilesetManifest(),
    ]);

    const eraOrder = config.game?.eraOrder || ['era-01-8bit', 'era-02-16bit', 'era-03-32bit', 'era-04-64bit'];
    const loadedEras = await Promise.all(
      eraOrder.map((eid) => fetchEra(eid).catch(() => null))
    );
    state.eras = new Map();
    for (const e of loadedEras) {
      if (e && e.id) state.eras.set(e.id, e);
    }

    state.me = me;
    state.gameConfig = config.game;
    if (config.heroPreferences && state.gameConfig) {
      state.gameConfig.heroPreferences = config.heroPreferences;
    }
    state.catalog = config.catalog;
    state.era = state.eras.get('era-01-8bit') || [...state.eras.values()][0] || null;
    state.sprites = new SpriteManager(spriteManifest, tilesetManifest);
    state.sprites.preloadCore('8bit');
    state.sprites.preloadCore('16bit');
    renderAccountIdentityBar();
    renderAdminRealmJump();

    state.modals = new ModalManager($('#modal-backdrop'), $('#modal-content'), {
      sprites: state.sprites,
      onPauseChange: (paused) => state.world?.setPaused(paused),
    });

    let regionHideTimer = null;
    state.world = new WorldEngine($('#world-canvas'), state.sprites, {
      onRegionChange: (region) => {
        if (state.activeRealm) {
          music.setTheme(resolveRegionTheme(region?.id, state.activeRealm.id));
        }
        const banner = $('#region-banner');
        if (!banner || !region) return;
        banner.textContent = region.name;
        banner.classList.add('visible');
        if (regionHideTimer) clearTimeout(regionHideTimer);
        regionHideTimer = setTimeout(() => banner.classList.remove('visible'), 2600);
      },
      onNearestEntityChange: (entity) => {
        updateInteractPrompt(entity);
      },
      onAutoPathChange: (path) => {
        const btn = $('#btn-hud-autopath');
        if (!btn) return;
        btn.textContent = path ? '⏹ Stop Walking' : '🧭 Walk to Next';
      },
      onFastTravel: (ent) => {
        showToast(`✨ Fast-traveled to ${ent.label || 'marker'}!`);
        persistSave().catch(() => {});
      },
      onMinimapAutoPath: (ent, res) => {
        if (!res?.ok) {
          audio.playError();
          showToast(`🧭 Can't reach ${ent.label || 'that marker'} yet — clear earlier paths first!`);
        } else if (res.arrived) {
          showToast(`✨ You're already next to ${ent.label || 'that marker'}!`);
        } else {
          showToast(`🧭 Walking to ${ent.label || 'marker'}… (press WASD/Arrows to cancel)`);
        }
      },
      onInteract: (entity) => handleEntityInteract(entity),
    });

    wireControls();
    buildFamiliarityPicker();
    buildVisualHeroPickers();
    buildCharCreateSpellbook();
    state.router = new AppRouter({ onRoute: handleRoute });
    await state.router.start();
    if (pendingPlayToken) {
      await handlePendingPlayToken(pendingPlayToken);
    }
  } catch (err) {
    console.error('Pyria boot failed:', err);
    const listEl = $('#saves-list');
    if (listEl) {
      listEl.innerHTML = `<div class="empty-state">Failed to boot Pyria: ${escapeHtml(err.message)}</div>`;
    }
  }
}

init();
