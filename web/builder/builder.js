// Pyria Parent & Builder Console — Live Progress Stream, Difficulty Tuning & Story Editor

import { pyRunner } from '/js/pyRunner.js?v=20261127h';

const POLL_INTERVAL_MS = 2500;
const PASSCODE_STORAGE_KEY = 'pyria_builder_passcode';

const state = {
  me: null,
  accounts: [],
  selectedAccount: 'all',
  liveEnabled: true,
  pollTimer: null,
  latestEventId: 0,
  events: [],
  saves: [],
  summary: null,
  globalDifficulty: { mode: 'standard', showRawTracebacks: false, maxHintsAllowed: 3 },
  selectedHeroId: null,
  expandedCodeEventIds: new Set(),

  overview: null,
  selectedEraId: null,
  selectedRealmId: null,
  selectedTrialId: null,

  // Realm Progress & Live Map Tracker state
  mapsCache: new Map(),
  trackerRealmId: 'realm-01-meadow',
  trackerManualRealm: false,
  trackerFilter: 'remaining', // 'remaining' | 'all'
  trackerHoverEntityId: null,
  trackerPinnedEntityId: null,
  trackerAnimRaf: null,
};

const MAP_TILE_COLORS = {
  grass: '#2d6a4f',
  grass_flower: '#40916c',
  dirt_path: '#b08968',
  water: '#1d6fa5',
  bridge_wood: '#d4a373',
  bridge_broken: '#7f5539',
  stone_floor: '#64748b',
  stone_wall: '#334155',
  tree: '#1b4332',
  bush: '#2d5a27',
  campfire: '#f97316',
  anvil: '#94a3b8',
  statue: '#cbd5e1',
  mossy_gate_closed: '#9a3412',
  mossy_gate_open: '#4d7c0f',
  chest_closed: '#f59e0b',
  chest_open: '#78716c',
  vault_shrine: '#dc2626',
  torch: '#fb923c',
  portal: '#38bdf8',
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg, isError = false) {
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function formatRelativeTime(iso) {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatClockTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ==================== API CLIENT ====================
async function apiFetch(url, options = {}) {
  const passcode = sessionStorage.getItem(PASSCODE_STORAGE_KEY) || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(passcode ? { 'X-Builder-Passcode': passcode } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    $('#passcode-bar')?.classList.remove('hidden');
    throw new Error('Builder passcode required');
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.error) detail = body.error;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  $('#passcode-bar')?.classList.add('hidden');
  return res.json();
}

// ==================== LOOKUP HELPERS ====================
function getRealmMeta(realmId) {
  for (const era of state.overview?.eras || []) {
    const realm = (era.realms || []).find((r) => r.id === realmId);
    if (realm) return { era, realm };
  }
  return { era: null, realm: null };
}

function getSelectedRealmObj() {
  const era = (state.overview?.eras || []).find((e) => e.id === state.selectedEraId);
  if (!era) return { era: null, realm: null };
  const realm = (era.realms || []).find((r) => r.id === state.selectedRealmId) || null;
  return { era, realm };
}

// ==================== LIVE PROGRESS RENDERING ====================
function renderGlobalControls() {
  const diff = state.globalDifficulty || {};
  const mode = diff.mode || 'standard';
  document.querySelectorAll('#global-diff-segmented .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  const tbEl = $('#global-raw-tracebacks');
  if (tbEl) tbEl.checked = Boolean(diff.showRawTracebacks);
  const hintsEl = $('#global-max-hints');
  if (hintsEl) hintsEl.value = String(diff.maxHintsAllowed ?? 3);
}

function renderSummaryStrip() {
  const s = state.summary || {};
  $('#kpi-saves').textContent = String(s.totalSaves ?? state.saves.length);
  $('#kpi-attempts').textContent = String(s.totalAttempts ?? 0);
  const passRate = s.totalAttempts > 0 && Number.isFinite(s.passRate)
    ? `${Math.round(s.passRate)}%`
    : '—';
  $('#kpi-passrate').textContent = passRate;
  $('#kpi-hints').textContent = String(s.totalHintsUsed ?? 0);
  $('#kpi-dragons').textContent = String(s.totalDragonsRescued ?? 0);
}

function getVisibleSaves() {
  if (!state.selectedAccount || state.selectedAccount === 'all') {
    return state.saves;
  }
  return state.saves.filter((s) => (s.ownerEmail || '') === state.selectedAccount);
}

function populateAccountFilter() {
  const sel = $('#account-filter-select');
  if (!sel) return;
  const set = new Set(Array.isArray(state.accounts) ? state.accounts : []);
  for (const s of state.saves) {
    if (s.ownerEmail) set.add(s.ownerEmail);
  }
  const sorted = [...set].filter(Boolean).sort();
  const opts = ['<option value="all">All Accounts</option>'];
  for (const email of sorted) {
    opts.push(`<option value="${escapeHtml(email)}">${escapeHtml(email)}</option>`);
  }
  sel.innerHTML = opts.join('');
  if (state.selectedAccount !== 'all' && !sorted.includes(state.selectedAccount)) {
    state.selectedAccount = 'all';
  }
  sel.value = state.selectedAccount;
}

function renderHeroCards() {
  const listEl = $('#hero-cards-list');
  if (!listEl) return;

  const visibleSaves = getVisibleSaves();
  if (!visibleSaves.length) {
    listEl.innerHTML =
      '<div class="empty-state">No saved heroes yet for this account. Launch <a href="/" style="color:var(--accent-sky);">Pyria</a> and forge a hero to see live progress here!</div>';
    return;
  }

  listEl.innerHTML = visibleSaves
    .map((save) => {
      const st = save.state && typeof save.state === 'object' ? save.state : save;
      const stats = save.stats || {};
      const realmId = st.realmId || 'realm-01-meadow';
      const { era, realm } = getRealmMeta(realmId);
      const totalRealmTrials = realm?.trials?.length || 6;
      const solvedList = Array.isArray(st.solvedTrials)
        ? st.solvedTrials
        : Array.isArray(st.completedTrials)
          ? st.completedTrials
          : [];
      const solvedCount = Number(stats.solvedCount ?? solvedList.length) || 0;
      const pct = Math.min(100, Math.round((solvedCount / Math.max(1, totalRealmTrials)) * 100));
      const shards = Number(st.byteShards) || 0;
      const dragons = Array.isArray(st.rescuedDragons) ? st.rescuedDragons : [];
      const attemptCount = Number(stats.attemptCount) || 0;
      const passCount = Number(stats.passCount) || 0;
      const passPct = attemptCount > 0 ? `${Math.round((passCount / attemptCount) * 100)}%` : '—';
      const hintsUsed = Number(stats.totalHintsUsed) || 0;
      const lastActive = stats.lastActive || save.updatedAt;
      const isSelected = state.selectedHeroId === save.id;

      return `
        <div class="hero-card ${isSelected ? 'selected' : ''}" data-save-id="${escapeHtml(save.id)}">
          <div class="hero-card-top">
            <div>
              <div class="hero-card-name">${escapeHtml(save.heroName || st.heroName || 'Hero')}</div>
              <div class="hint-sub">${escapeHtml(era?.name || '8-Bit Era')} · ${escapeHtml(realm?.name || realmId)}</div>
              ${save.ownerEmail ? `<span class="pill pill-blue" style="margin-top:4px;">👤 ${escapeHtml(save.ownerEmail)}</span>` : ''}
            </div>
            <span class="pill pill-muted">${escapeHtml(formatRelativeTime(lastActive))}</span>
          </div>

          <div>
            <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
              <span>Trials Solved</span>
              <strong>${solvedCount} / ${totalRealmTrials}</strong>
            </div>
            <div class="progress-bar-track">
              <div class="progress-bar-fill" style="width:${pct}%;"></div>
            </div>
          </div>

          <div class="hero-card-stats">
            <span class="pill pill-gold">✦ ${shards} Shards</span>
            <span class="pill pill-green">🐉 ${dragons.length} Dragons</span>
            <span class="pill pill-blue">Pass: ${passPct} (${passCount}/${attemptCount})</span>
            <span class="pill pill-violet">💡 Hints: ${hintsUsed}</span>
          </div>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.hero-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.saveId;
      state.selectedHeroId = state.selectedHeroId === id ? null : id;
      state.trackerManualRealm = false;
      state.trackerPinnedEntityId = null;
      renderHeroCards();
      renderActivityStream();
      refreshRealmTracker();
    });
  });
}

function getEventBadge(eventType) {
  switch (eventType) {
    case 'trial_passed':
      return { cls: 'pill-green', text: '✓ Trial Passed' };
    case 'trial_failed':
      return { cls: 'pill-rose', text: '✗ Trial Attempt' };
    case 'chest_opened':
      return { cls: 'pill-gold', text: '📦 Chest' };
    case 'workshop_purchase':
      return { cls: 'pill-violet', text: '⚒️ Workshop' };
    case 'dragon_rescued':
      return { cls: 'pill-gold', text: '🐉 Dragon Rescued' };
    case 'hero_created':
      return { cls: 'pill-blue', text: '✨ New Hero' };
    case 'realm_entered':
      return { cls: 'pill-blue', text: '🚪 Entered Realm' };
    case 'parent_override':
      return { cls: 'pill-violet', text: '🛡️ Parent Override' };
    case 'easter_egg_found':
      return { cls: 'pill-gold', text: '✨ Easter Egg' };
    default:
      return { cls: 'pill-muted', text: eventType || 'Event' };
  }
}

function renderActivityStream(newlyArrivedIds = new Set()) {
  const streamEl = $('#activity-stream');
  const filterChip = $('#filter-chip');
  const filterName = $('#filter-chip-name');
  const countPill = $('#event-count-pill');
  if (!streamEl) return;

  let filtered = state.events;
  if (state.selectedAccount && state.selectedAccount !== 'all') {
    const allowedSaveIds = new Set(getVisibleSaves().map((s) => s.id));
    filtered = filtered.filter((ev) => allowedSaveIds.has(ev.saveId));
  }
  if (state.selectedHeroId) {
    const hero = state.saves.find((s) => s.id === state.selectedHeroId);
    filterChip?.classList.remove('hidden');
    if (filterName) filterName.textContent = hero?.heroName || 'Hero';
    filtered = filtered.filter((ev) => ev.saveId === state.selectedHeroId);
  } else {
    filterChip?.classList.add('hidden');
  }

  if (countPill) {
    countPill.textContent = `${filtered.length} ${filtered.length === 1 ? 'event' : 'events'}`;
  }

  if (!filtered.length) {
    streamEl.innerHTML =
      '<div class="empty-state">No activity events yet for this view. Play Pyria to watch live updates stream in!</div>';
    return;
  }

  streamEl.innerHTML = filtered
    .map((ev) => {
      const badge = getEventBadge(ev.eventType);
      const details = ev.details || {};
      const hasCode = Boolean(details.code && String(details.code).trim());
      const hintsUsed = Number(details.hintsUsed) || 0;
      const isExpanded = state.expandedCodeEventIds.has(ev.id);
      const isNew = newlyArrivedIds.has(ev.id);

      return `
        <div class="event-card type-${escapeHtml(ev.eventType)} ${isNew ? 'event-new' : ''}">
          <div class="event-top">
            <div class="event-badges">
              <span class="pill ${escapeHtml(badge.cls)}">${escapeHtml(badge.text)}</span>
              <strong>${escapeHtml(ev.heroName || 'Hero')}</strong>
              ${ev.trialId ? `<span class="pill pill-muted">${escapeHtml(ev.trialId)}</span>` : ''}
              ${hintsUsed > 0 ? `<span class="pill pill-gold">💡 ${hintsUsed} ${hintsUsed === 1 ? 'hint' : 'hints'}</span>` : ''}
            </div>
            <span class="event-time" title="${escapeHtml(ev.createdAt || '')}">
              ${escapeHtml(formatRelativeTime(ev.createdAt))} · ${escapeHtml(formatClockTime(ev.createdAt))}
            </span>
          </div>
          <div class="event-summary">${escapeHtml(ev.summary)}</div>
          ${
            hasCode
              ? `
                <div>
                  <button class="btn btn-sm btn-ghost btn-toggle-code" data-event-id="${escapeHtml(ev.id)}">
                    ${isExpanded ? '▾ Hide Python Code' : '▸ View Python Code'}
                  </button>
                  <pre class="event-code-pre ${isExpanded ? '' : 'hidden'}">${escapeHtml(details.code)}</pre>
                </div>
              `
              : ''
          }
        </div>
      `;
    })
    .join('');

  streamEl.querySelectorAll('.btn-toggle-code').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.eventId);
      if (state.expandedCodeEventIds.has(id)) {
        state.expandedCodeEventIds.delete(id);
      } else {
        state.expandedCodeEventIds.add(id);
      }
      renderActivityStream();
    });
  });
}

// ==================== LIVE POLLING ====================
async function loadProgressFull() {
  const data = await apiFetch('/api/builder/progress');
  state.saves = Array.isArray(data.saves) ? data.saves : [];
  state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
  state.summary = data.summary || null;
  if (data.globalDifficultyOverride) {
    state.globalDifficulty = data.globalDifficultyOverride;
  }

  const recent = Array.isArray(data.recentEvents) ? data.recentEvents : [];
  state.events = recent;
  state.latestEventId = recent.reduce((max, ev) => Math.max(max, Number(ev.id) || 0), 0);

  populateAccountFilter();
  renderGlobalControls();
  renderSummaryStrip();
  renderHeroCards();
  renderActivityStream();
  refreshRealmTracker();
}

async function pollLiveUpdates() {
  try {
    const [actData, progData] = await Promise.all([
      apiFetch(`/api/builder/activity?since=${state.latestEventId}&limit=50`),
      apiFetch('/api/builder/progress'),
    ]);

    state.saves = Array.isArray(progData.saves) ? progData.saves : [];
    state.accounts = Array.isArray(progData.accounts) ? progData.accounts : [];
    state.summary = progData.summary || null;
    if (progData.globalDifficultyOverride) {
      state.globalDifficulty = progData.globalDifficultyOverride;
    }

    const incoming = Array.isArray(actData.events) ? actData.events : [];
    const newIds = new Set();
    if (incoming.length > 0) {
      const existingIds = new Set(state.events.map((e) => e.id));
      // incoming is oldest-to-newest; prepend newest-first
      for (const ev of incoming) {
        if (!existingIds.has(ev.id)) {
          state.events.unshift(ev);
          newIds.add(ev.id);
        }
      }
      if (state.events.length > 150) {
        state.events.length = 150;
      }
    }
    if (Number.isFinite(actData.latestId)) {
      state.latestEventId = Math.max(state.latestEventId, actData.latestId);
    }

    populateAccountFilter();
    renderGlobalControls();
    renderSummaryStrip();
    renderHeroCards();
    renderActivityStream(newIds);
    refreshRealmTracker();
  } catch (err) {
    console.warn('Live poll paused/failed:', err.message);
  }
}

function setLivePolling(enabled) {
  state.liveEnabled = Boolean(enabled);
  const pill = $('#live-indicator');
  const text = $('#live-indicator-text');
  const btn = $('#btn-toggle-live');

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  if (state.liveEnabled) {
    pill?.classList.add('active');
    if (text) text.textContent = 'LIVE';
    if (btn) btn.textContent = '⏸ Pause';
    state.pollTimer = setInterval(pollLiveUpdates, POLL_INTERVAL_MS);
  } else {
    pill?.classList.remove('active');
    if (text) text.textContent = 'PAUSED';
    if (btn) btn.textContent = '▶ Resume';
  }
}

// ==================== GLOBAL DIFFICULTY CONTROLS ====================
async function pushGlobalDifficulty(patch) {
  const next = {
    mode: state.globalDifficulty?.mode || 'standard',
    showRawTracebacks: Boolean(state.globalDifficulty?.showRawTracebacks),
    maxHintsAllowed: Number(state.globalDifficulty?.maxHintsAllowed ?? 3),
    ...patch,
  };
  try {
    await apiFetch('/api/builder/difficulty', {
      method: 'PUT',
      body: JSON.stringify({ scope: 'global', override: next }),
    });
    state.globalDifficulty = next;
    renderGlobalControls();
    showToast(`Global difficulty saved: ${next.mode} (hints: ${next.maxHintsAllowed})`);
    await loadOverview();
  } catch (err) {
    showToast(`Failed to update difficulty: ${err.message}`, true);
  }
}

// ==================== STORY, TRIALS & CONCEPT HEALTH ====================
async function loadOverview() {
  const data = await apiFetch('/api/builder/overview');
  state.overview = data;

  if (!state.selectedEraId && data.eras?.length) {
    state.selectedEraId = data.eras[0].id;
    state.selectedRealmId = data.eras[0].realms?.[0]?.id || null;
  }

  renderEraRealmTree();
  renderRealmEditor();
  renderConceptHealth();
  renderHeroCards(); // refresh realm names/trial counts
  populateTrackerRealmSelect();
  refreshRealmTracker();
}

function renderEraRealmTree() {
  const treeEl = $('#era-realm-tree');
  if (!treeEl || !state.overview) return;

  treeEl.innerHTML = (state.overview.eras || [])
    .map((era) => {
      const realmsHtml = (era.realms || [])
        .map((r) => {
          const active = era.id === state.selectedEraId && r.id === state.selectedRealmId;
          return `
            <button type="button" class="realm-nav-btn ${active ? 'active' : ''}" data-era-id="${escapeHtml(era.id)}" data-realm-id="${escapeHtml(r.id)}">
              <span>${escapeHtml(r.number)}. ${escapeHtml(r.name)}</span>
              <span class="pill pill-muted">${(r.trials || []).length}</span>
            </button>
          `;
        })
        .join('');
      return `
        <div>
          <div class="era-group-title">${escapeHtml(era.name)}</div>
          ${realmsHtml}
        </div>
      `;
    })
    .join('');

  treeEl.querySelectorAll('.realm-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedEraId = btn.dataset.eraId;
      state.selectedRealmId = btn.dataset.realmId;
      state.selectedTrialId = null;
      renderEraRealmTree();
      renderRealmEditor();
    });
  });
}

function renderRealmEditor() {
  const { era, realm } = getSelectedRealmObj();
  if (!realm) return;

  $('#realm-editor-heading').textContent = `${era.name} — Realm ${realm.number}: ${realm.name}`;
  $('#re-name').value = realm.name || '';
  $('#re-concepts').value = (realm.primaryConcepts || []).join(', ');
  $('#re-story-intro').value = realm.storyIntro || '';
  $('#re-story-outro').value = realm.storyOutro || '';
  $('#re-visual-upgrade').value = realm.miniVisualUpgrade || '';
  $('#re-dragon-name').value = realm.dragon?.name || '';
  $('#re-dragon-element').value = realm.dragon?.element || '';
  $('#re-dragon-dialogue').value = realm.dragon?.rescueDialogue || '';

  const ov = realm.difficultyOverride || {};
  $('#re-diff-mode').value = ov.mode || '';
  $('#re-diff-tracebacks').value =
    typeof ov.showRawTracebacks === 'boolean' ? String(ov.showRawTracebacks) : '';

  const trials = realm.trials || [];
  if (!state.selectedTrialId || !trials.some((t) => t.id === state.selectedTrialId)) {
    state.selectedTrialId = trials[0]?.id || null;
  }
  renderTrialTabsAndEditor(realm);
}

function renderTrialTabsAndEditor(realm) {
  const tabsEl = $('#trial-tabs');
  const wrapEl = $('#trial-editor-wrap');
  const trials = realm.trials || [];

  tabsEl.innerHTML = trials
    .map(
      (t) => `
      <button type="button" class="trial-tab-btn ${t.id === state.selectedTrialId ? 'active' : ''}" data-trial-id="${escapeHtml(t.id)}">
        ${escapeHtml(t.id)}: ${escapeHtml(t.title)}
      </button>
    `
    )
    .join('');

  tabsEl.querySelectorAll('.trial-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedTrialId = btn.dataset.trialId;
      renderTrialTabsAndEditor(realm);
    });
  });

  const trial = trials.find((t) => t.id === state.selectedTrialId);
  if (!trial) {
    wrapEl.classList.add('hidden');
    return;
  }
  wrapEl.classList.remove('hidden');

  $('#te-id').value = trial.id || '';
  $('#te-title').value = trial.title || '';
  $('#te-shards').value = String(trial.shardReward ?? 25);
  $('#te-concepts').value = (trial.concepts || []).join(', ');
  $('#te-story').value = trial.storyPrompt || '';
  $('#te-objective').value = trial.objective || '';
  $('#te-starter-explorer').value = trial.starterCode?.explorer || '';
  $('#te-starter-standard').value = trial.starterCode?.standard || '';
  $('#te-starter-challenge').value = trial.starterCode?.challenge || '';
  $('#te-reference').value = trial.referenceSolution || '';
  $('#te-test').value = trial.testCode || '';
  $('#te-hint-1').value = trial.hints?.tier1_nudge || '';
  $('#te-hint-2').value = trial.hints?.tier2_pattern || '';
  $('#te-hint-3').value = trial.hints?.tier3_walkthrough || '';
  $('#test-result-box').classList.add('hidden');
}

async function saveCurrentRealm() {
  const { era, realm } = getSelectedRealmObj();
  if (!era || !realm) return;

  const modeVal = $('#re-diff-mode').value;
  const tbVal = $('#re-diff-tracebacks').value;
  let difficultyOverride = null;
  if (modeVal || tbVal) {
    difficultyOverride = {};
    if (modeVal) difficultyOverride.mode = modeVal;
    if (tbVal) difficultyOverride.showRawTracebacks = tbVal === 'true';
  }

  const payload = {
    name: $('#re-name').value.trim(),
    primaryConcepts: $('#re-concepts')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    storyIntro: $('#re-story-intro').value,
    storyOutro: $('#re-story-outro').value,
    miniVisualUpgrade: $('#re-visual-upgrade').value,
    dragon: {
      ...(realm.dragon || {}),
      name: $('#re-dragon-name').value.trim(),
      element: $('#re-dragon-element').value.trim(),
      rescueDialogue: $('#re-dragon-dialogue').value,
    },
    difficultyOverride,
  };

  try {
    await apiFetch(`/api/builder/realms/${encodeURIComponent(era.id)}/${encodeURIComponent(realm.id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    showToast(`Saved Realm "${payload.name}"!`);
    await loadOverview();
  } catch (err) {
    showToast(`Save failed: ${err.message}`, true);
  }
}

async function saveCurrentTrial() {
  const { era, realm } = getSelectedRealmObj();
  if (!era || !realm) return;
  const trialId = $('#te-id').value.trim();
  if (!trialId) {
    showToast('Trial ID is required', true);
    return;
  }

  const existing = (realm.trials || []).find((t) => t.id === trialId);
  const payload = {
    id: trialId,
    title: $('#te-title').value.trim(),
    storyPrompt: $('#te-story').value,
    objective: $('#te-objective').value,
    concepts: $('#te-concepts')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    shardReward: Number($('#te-shards').value) || 0,
    unlockId: existing?.unlockId ?? null,
    starterCode: {
      explorer: $('#te-starter-explorer').value,
      standard: $('#te-starter-standard').value,
      challenge: $('#te-starter-challenge').value,
    },
    referenceSolution: $('#te-reference').value,
    testCode: $('#te-test').value,
    hints: {
      tier1_nudge: $('#te-hint-1').value,
      tier2_pattern: $('#te-hint-2').value,
      tier3_walkthrough: $('#te-hint-3').value,
    },
    difficultyOverride: existing?.difficultyOverride ?? null,
  };

  try {
    await apiFetch(
      `/api/builder/realms/${encodeURIComponent(era.id)}/${encodeURIComponent(realm.id)}/trials/${encodeURIComponent(trialId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      }
    );
    state.selectedTrialId = trialId;
    showToast(`Saved Trial "${payload.title}"!`);
    await loadOverview();
  } catch (err) {
    showToast(`Failed to save trial: ${err.message}`, true);
  }
}

async function deleteCurrentTrial() {
  const { era, realm } = getSelectedRealmObj();
  if (!era || !realm || !state.selectedTrialId) return;
  if (!confirm(`Delete Trial "${state.selectedTrialId}" from ${realm.name}?`)) return;

  try {
    await apiFetch(
      `/api/builder/realms/${encodeURIComponent(era.id)}/${encodeURIComponent(realm.id)}/trials/${encodeURIComponent(state.selectedTrialId)}`,
      { method: 'DELETE' }
    );
    showToast(`Deleted Trial ${state.selectedTrialId}`);
    state.selectedTrialId = null;
    await loadOverview();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, true);
  }
}

function addNewTrialDraft() {
  const { realm } = getSelectedRealmObj();
  if (!realm) return;
  const nextNum = String((realm.trials || []).length + 1).padStart(2, '0');
  const realmNum = String(realm.number || 1).padStart(2, '0');
  const newId = `trial-${realmNum}-${nextNum}`;
  const draft = {
    id: newId,
    title: 'New Python Trial',
    storyPrompt: 'Write a new adventure prompt for this Trial!',
    objective: 'Describe what the player should print or compute.',
    concepts: realm.primaryConcepts?.slice(0, 2) || ['print_output'],
    shardReward: 25,
    unlockId: null,
    starterCode: {
      explorer: '# Explorer starter\n',
      standard: '# Standard starter\n',
      challenge: '# Challenge starter\n',
    },
    referenceSolution: 'print("Hello, Pyria!")\n',
    testCode: 'assert OUTPUT.strip() == "Hello, Pyria!"\n',
    hints: {
      tier1_nudge: 'Gentle nudge from Pip...',
      tier2_pattern: 'Code pattern hint...',
      tier3_walkthrough: 'Exact walkthrough...',
    },
    difficultyOverride: null,
  };
  realm.trials = [...(realm.trials || []), draft];
  state.selectedTrialId = newId;
  renderTrialTabsAndEditor(realm);
  showToast(`Created draft ${newId} — click Save Trial to persist!`);
}

async function testCurrentTrialSolution() {
  const box = $('#test-result-box');
  const btn = $('#btn-test-solution');
  const code = $('#te-reference').value;
  const testCode = $('#te-test').value;

  btn.disabled = true;
  btn.textContent = 'Testing in Pyodide...';
  try {
    const res = await pyRunner.runTrial(code, testCode, true);
    const stderrText =
      res.rawTraceback ||
      (!res.passed && res.errorMessage
        ? `${res.errorType || 'Error'}: ${res.errorMessage}`
        : '');
    box.className = `test-result-box ${res.passed ? 'passed' : 'failed'}`;
    box.classList.remove('hidden');
    box.innerHTML = `
      <div style="font-weight:800; margin-bottom:6px; color:${res.passed ? 'var(--accent-emerald)' : 'var(--accent-rose)'};">
        ${res.passed ? '✓ Reference Solution PASSED!' : res.timedOut ? '⏱ Timed Out (3s limit)' : '✗ Test Failed'}
      </div>
      ${res.pipMessage ? `<div style="margin-bottom:6px;">🐉 <strong>Pip:</strong> ${escapeHtml(res.pipMessage)}</div>` : ''}
      ${res.stdout ? `<pre class="event-code-pre">stdout:\n${escapeHtml(res.stdout)}</pre>` : ''}
      ${stderrText ? `<pre class="event-code-pre" style="color:#fecdd3;">stderr:\n${escapeHtml(stderrText)}</pre>` : ''}
    `;
  } catch (err) {
    showToast(`Test error: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Test Solution';
  }
}

function renderConceptHealth() {
  if (!state.overview) return;
  const warnings = state.overview.conceptWarnings || [];
  const pill = $('#warnings-count-pill');
  const listEl = $('#concept-warnings-list');

  if (warnings.length === 0) {
    pill.className = 'pill pill-green';
    pill.textContent = '✓ All Clear';
    listEl.innerHTML =
      '<div class="empty-state">No concept repetition warnings! Every Realm introduces fresh Python skills cleanly.</div>';
  } else {
    pill.className = 'pill pill-gold';
    pill.textContent = `${warnings.length} ${warnings.length === 1 ? 'Warning' : 'Warnings'}`;
    listEl.innerHTML = warnings
      .map(
        (w) => `
        <div class="warning-card">
          <strong>${escapeHtml(w.concept || w.conceptId || 'Concept')}</strong>
          <span class="pill pill-muted" style="margin-left:6px;">${escapeHtml(w.realmName || w.realmId || '')}</span>
          <div class="muted-text" style="margin-top:4px;">${escapeHtml(w.message || w.reason || JSON.stringify(w))}</div>
        </div>
      `
      )
      .join('');
  }

  const tbody = $('#realm-diff-tbody');
  if (!tbody) return;
  const rows = [];
  for (const era of state.overview.eras || []) {
    for (const realm of era.realms || []) {
      const ov = realm.difficultyOverride || {};
      rows.push(`
        <tr>
          <td>${escapeHtml(era.name)}</td>
          <td><strong>${escapeHtml(realm.number)}. ${escapeHtml(realm.name)}</strong></td>
          <td>${(realm.trials || []).length}</td>
          <td>
            <select class="input input-sm realm-diff-select" data-era="${escapeHtml(era.id)}" data-realm="${escapeHtml(realm.id)}" data-field="mode">
              <option value="" ${!ov.mode ? 'selected' : ''}>Inherit Global</option>
              <option value="explorer" ${ov.mode === 'explorer' ? 'selected' : ''}>Explorer</option>
              <option value="standard" ${ov.mode === 'standard' ? 'selected' : ''}>Standard</option>
              <option value="challenge" ${ov.mode === 'challenge' ? 'selected' : ''}>Challenge</option>
            </select>
          </td>
          <td>
            <select class="input input-sm realm-diff-select" data-era="${escapeHtml(era.id)}" data-realm="${escapeHtml(realm.id)}" data-field="showRawTracebacks">
              <option value="" ${typeof ov.showRawTracebacks !== 'boolean' ? 'selected' : ''}>Inherit Global</option>
              <option value="true" ${ov.showRawTracebacks === true ? 'selected' : ''}>Show</option>
              <option value="false" ${ov.showRawTracebacks === false ? 'selected' : ''}>Hide</option>
            </select>
          </td>
        </tr>
      `);
    }
  }
  tbody.innerHTML = rows.join('');

  tbody.querySelectorAll('.realm-diff-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const eraId = sel.dataset.era;
      const realmId = sel.dataset.realm;
      const row = sel.closest('tr');
      const modeVal = row.querySelector('[data-field="mode"]').value;
      const tbVal = row.querySelector('[data-field="showRawTracebacks"]').value;
      let override = null;
      if (modeVal || tbVal) {
        override = {};
        if (modeVal) override.mode = modeVal;
        if (tbVal) override.showRawTracebacks = tbVal === 'true';
      }
      try {
        await apiFetch('/api/builder/difficulty', {
          method: 'PUT',
          body: JSON.stringify({ scope: 'realm', eraId, realmId, override }),
        });
        showToast(`Updated difficulty override for ${realmId}`);
        await loadOverview();
      } catch (err) {
        showToast(`Failed to update override: ${err.message}`, true);
      }
    });
  });
}

// ==================== REALM PROGRESS & LIVE MAP TRACKER ====================
function getActiveTrackerSave() {
  const visible = getVisibleSaves();
  if (!visible.length) return null;
  if (state.selectedHeroId) {
    const found = visible.find((s) => s.id === state.selectedHeroId);
    if (found) return found;
  }
  return visible[0];
}

function getSaveStateObj(save) {
  if (!save) return {};
  return save.state && typeof save.state === 'object' ? save.state : save;
}

function getSolvedSetForSave(save) {
  const st = getSaveStateObj(save);
  return new Set([
    ...(Array.isArray(st.solvedTrials) ? st.solvedTrials : []),
    ...(Array.isArray(st.completedTrials) ? st.completedTrials : []),
  ]);
}

function populateTrackerRealmSelect() {
  const sel = $('#tracker-realm-select');
  if (!sel || !state.overview) return;
  const options = [];
  for (const era of state.overview.eras || []) {
    for (const r of era.realms || []) {
      options.push(`<option value="${escapeHtml(r.id)}">${escapeHtml(r.number)}. ${escapeHtml(r.name)}</option>`);
    }
  }
  if (options.length) {
    sel.innerHTML = options.join('');
    sel.value = state.trackerRealmId;
  }
}

async function fetchRealmMapCached(realmId) {
  if (!realmId) return null;
  if (state.mapsCache.has(realmId)) {
    return state.mapsCache.get(realmId);
  }
  try {
    const res = await fetch(`/content/maps/${encodeURIComponent(realmId)}.json`);
    if (!res.ok) {
      state.mapsCache.set(realmId, null);
      return null;
    }
    const data = await res.json();
    state.mapsCache.set(realmId, data);
    return data;
  } catch {
    state.mapsCache.set(realmId, null);
    return null;
  }
}

function findRegionNameForTile(mapData, x, y) {
  for (const r of mapData?.regions || []) {
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
      return r.name;
    }
  }
  return mapData?.name || 'Overworld';
}

function buildTrackerItems(mapData, realmMeta, save) {
  const solved = getSolvedSetForSave(save);
  const st = getSaveStateObj(save);
  const openedChests = new Set(Array.isArray(st.openedChests) ? st.openedChests : []);
  const rescuedDragons = new Set(Array.isArray(st.rescuedDragons) ? st.rescuedDragons : []);
  const trialsById = new Map((realmMeta?.trials || []).map((t) => [t.id, t]));

  const trials = [];
  const chests = [];
  const milestones = [];

  for (const ent of mapData?.entities || []) {
    const regionName = findRegionNameForTile(mapData, ent.x, ent.y);
    if (ent.type === 'trial') {
      const tObj = trialsById.get(ent.refId);
      const isDone = solved.has(ent.refId);
      trials.push({
        id: ent.id,
        entity: ent,
        kind: 'trial',
        title: tObj?.title || ent.label,
        subtitle: `${ent.refId} · +${tObj?.shardReward ?? 0} 💎`,
        regionName,
        x: ent.x,
        y: ent.y,
        done: isDone,
        statusLabel: isDone ? 'Solved' : 'Remaining',
      });
    } else if (ent.type === 'chest') {
      const isDone = openedChests.has(ent.id);
      chests.push({
        id: ent.id,
        entity: ent,
        kind: 'chest',
        title: ent.label,
        subtitle: `+${ent.shardReward ?? 15} 💎 Byte Shards`,
        regionName,
        x: ent.x,
        y: ent.y,
        done: isDone,
        statusLabel: isDone ? 'Opened' : 'Unopened',
      });
    } else if (ent.type === 'vault') {
      const isRescued = rescuedDragons.has(ent.refId);
      const isUnlocked = !ent.requiredTrialId || solved.has(ent.requiredTrialId);
      milestones.push({
        id: ent.id,
        entity: ent,
        kind: 'vault',
        title: ent.label,
        subtitle: realmMeta?.dragon?.name ? `Dragon: ${realmMeta.dragon.name}` : 'Dragon Vault',
        regionName,
        x: ent.x,
        y: ent.y,
        done: isRescued,
        locked: !isRescued && !isUnlocked,
        statusLabel: isRescued ? 'Rescued' : isUnlocked ? 'Ready to Rescue!' : 'Locked',
      });
    } else if (ent.type === 'portal') {
      const isUnlocked = !ent.requiredTrialId || solved.has(ent.requiredTrialId);
      milestones.push({
        id: ent.id,
        entity: ent,
        kind: 'portal',
        title: ent.label,
        subtitle: `Destination: ${ent.refId || 'Next Realm'}`,
        regionName,
        x: ent.x,
        y: ent.y,
        done: false,
        locked: !isUnlocked,
        statusLabel: isUnlocked ? 'Active' : 'Locked',
      });
    }
  }

  return { trials, chests, milestones, all: [...trials, ...chests, ...milestones] };
}

function getActiveHighlightId() {
  return state.trackerHoverEntityId || state.trackerPinnedEntityId || null;
}

function updateTrackerCallout(mapData, items) {
  const calloutEl = $('#tracker-callout');
  if (!calloutEl) return;
  const targetId = getActiveHighlightId();
  if (!targetId || !mapData) {
    calloutEl.innerHTML = 'Hover or click any checklist item or map pin to locate it!';
    return;
  }
  const item = items.all.find((i) => i.id === targetId);
  if (item) {
    calloutEl.innerHTML = `
      <strong>${escapeHtml(item.title)}</strong>
      <span class="pill ${item.done ? 'pill-green' : item.locked ? 'pill-rose' : 'pill-gold'}" style="margin:0 6px;">${escapeHtml(item.statusLabel)}</span>
      <span class="hint-sub">${escapeHtml(item.regionName)} · (${Number(item.x) || 0}, ${Number(item.y) || 0})</span>
    `;
    return;
  }
  const ent = (mapData.entities || []).find((e) => e.id === targetId);
  if (ent) {
    const regionName = findRegionNameForTile(mapData, ent.x, ent.y);
    calloutEl.innerHTML = `
      <strong>${escapeHtml(ent.label)}</strong>
      <span class="pill pill-violet" style="margin:0 6px;">${escapeHtml(ent.type)}</span>
      <span class="hint-sub">${escapeHtml(regionName)} · (${Number(ent.x) || 0}, ${Number(ent.y) || 0})</span>
    `;
  }
}

function renderTrackerChecklist(mapData, realmMeta, save, items) {
  const listEl = $('#tracker-checklist');
  const summaryEl = $('#tracker-summary-pills');
  if (!listEl || !summaryEl) return;

  const trialsLeft = items.trials.filter((t) => !t.done).length;
  const chestsLeft = items.chests.filter((c) => !c.done).length;
  const vaultItem = items.milestones.find((m) => m.kind === 'vault');
  const dragonName = realmMeta?.dragon?.name || 'Dragon';
  const dragonStatus = vaultItem ? vaultItem.statusLabel : 'Unknown';

  summaryEl.innerHTML = `
    <span class="pill ${trialsLeft === 0 ? 'pill-green' : 'pill-gold'}">
      ${trialsLeft === 0 ? `✓ All ${items.trials.length} Trials Solved` : `Trials: ${trialsLeft}/${items.trials.length} left`}
    </span>
    <span class="pill ${chestsLeft === 0 ? 'pill-green' : 'pill-gold'}">
      ${chestsLeft === 0 ? `✓ All ${items.chests.length} Chests Opened` : `Chests: ${chestsLeft}/${items.chests.length} left`}
    </span>
    <span class="pill ${dragonStatus === 'Rescued' ? 'pill-green' : dragonStatus === 'Locked' ? 'pill-rose' : 'pill-blue'}">
      🐉 ${escapeHtml(dragonName)}: ${escapeHtml(dragonStatus)}
    </span>
  `;

  if (!mapData) {
    listEl.innerHTML = '<div class="empty-state">This Realm does not have a playable overworld map yet.</div>';
    return;
  }

  const filterFn = (item) => (state.trackerFilter === 'remaining' ? !item.done : true);
  const highlightId = getActiveHighlightId();

  const renderGroup = (title, groupItems) => {
    const visible = groupItems.filter(filterFn);
    if (!visible.length) return '';
    return `
      <div>
        <div class="tracker-group-title">${escapeHtml(title)}</div>
        <div style="display:flex; flex-direction:column; gap:5px;">
          ${visible
            .map((it) => {
              const iconCls = it.done ? 'done' : it.locked ? 'locked' : 'open';
              let icon = '○';
              if (it.done) icon = '✓';
              else if (it.kind === 'chest') icon = '📦';
              else if (it.locked) icon = '🔒';
              else if (it.kind === 'vault') icon = '🐉';
              else if (it.kind === 'portal') icon = '🌀';
              const overrideBtnHtml =
                it.kind === 'trial' && save && save.id
                  ? it.done
                    ? `<button type="button" class="btn-override-reset" data-override-trial="${escapeHtml(it.entity.refId)}" data-override-title="${escapeHtml(it.title)}" data-override-solved="false" title="Reset Trial to unsolved">↺ Reset</button>`
                    : `<button type="button" class="btn-override-done" data-override-trial="${escapeHtml(it.entity.refId)}" data-override-title="${escapeHtml(it.title)}" data-override-solved="true" title="Mark Trial complete and award Byte Shards">✓ Mark Done</button>`
                  : '';
              return `
                <div class="tracker-row ${it.done ? 'done' : ''} ${highlightId === it.id ? 'highlighted' : ''}" data-entity-id="${escapeHtml(it.id)}">
                  <div class="tracker-row-main">
                    <span class="tracker-status-icon ${iconCls}">${icon}</span>
                    <div style="min-width:0;">
                      <div class="tracker-row-title">${escapeHtml(it.title)}</div>
                      <div class="tracker-row-meta">${escapeHtml(it.subtitle)} · ${escapeHtml(it.regionName)}</div>
                    </div>
                  </div>
                  <div class="tracker-row-right">
                    ${overrideBtnHtml}
                    <span class="tracker-coords">(${Number(it.x) || 0}, ${Number(it.y) || 0})</span>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  };

  const html = [
    renderGroup('Python Trials', items.trials),
    renderGroup('Byte Shard Chests', items.chests),
    renderGroup('Dragon Vault & Portal', items.milestones),
  ]
    .filter(Boolean)
    .join('');

  listEl.innerHTML =
    html ||
    '<div class="empty-state">🎉 Everything in this Realm is complete! Switch to <strong>All Items</strong> to review.</div>';

  listEl.querySelectorAll('.tracker-row').forEach((row) => {
    const eid = row.dataset.entityId;
    row.addEventListener('mouseenter', () => {
      state.trackerHoverEntityId = eid;
      syncChecklistHighlight();
      updateTrackerCallout(mapData, items);
      drawTrackerMap(mapData, save);
    });
    row.addEventListener('mouseleave', () => {
      if (state.trackerHoverEntityId === eid) {
        state.trackerHoverEntityId = null;
        syncChecklistHighlight();
        updateTrackerCallout(mapData, items);
        drawTrackerMap(mapData, save);
      }
    });
    row.addEventListener('click', () => {
      state.trackerPinnedEntityId = state.trackerPinnedEntityId === eid ? null : eid;
      syncChecklistHighlight();
      updateTrackerCallout(mapData, items);
      drawTrackerMap(mapData, save);
    });
  });

  listEl.querySelectorAll('[data-override-trial]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!save || !save.id) return;
      const trialId = btn.dataset.overrideTrial;
      const title = btn.dataset.overrideTitle || trialId;
      const solved = btn.dataset.overrideSolved === 'true';

      btn.disabled = true;
      try {
        const res = await apiFetch(
          `/api/builder/saves/${encodeURIComponent(save.id)}/override-trial`,
          {
            method: 'POST',
            body: JSON.stringify({ trialId, solved, awardShards: solved }),
          }
        );
        const delta = Number(res.shardsDelta) || 0;
        if (solved) {
          showToast(
            delta > 0
              ? `Marked "${title}" complete (+${delta} Shards)`
              : `Marked "${title}" complete`
          );
        } else {
          showToast(`Reset "${title}" to unsolved`);
        }
        await loadProgressFull();
      } catch (err) {
        showToast(`Override failed: ${err.message}`, true);
        btn.disabled = false;
      }
    });
  });
}

function syncChecklistHighlight() {
  const activeId = getActiveHighlightId();
  document.querySelectorAll('#tracker-checklist .tracker-row').forEach((row) => {
    row.classList.toggle('highlighted', row.dataset.entityId === activeId);
  });
}

function drawTrackerMap(mapData, save) {
  const canvas = $('#tracker-map-canvas');
  const emptyEl = $('#tracker-map-empty');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (!mapData) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  const tilePx = 8;
  const targetW = mapData.width * tilePx;
  const targetH = mapData.height * tilePx;
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const solved = getSolvedSetForSave(save);
  const st = getSaveStateObj(save);
  const openedChests = new Set(Array.isArray(st.openedChests) ? st.openedChests : []);
  const rescuedDragons = new Set(Array.isArray(st.rescuedDragons) ? st.rescuedDragons : []);

  // Build dynamic tile overrides from Hero's solvedTrials
  const overrides = new Map();
  for (const ent of mapData.entities || []) {
    if (!Array.isArray(ent.dynamicTiles)) continue;
    const unlocked = Boolean(ent.refId && solved.has(ent.refId));
    for (const dt of ent.dynamicTiles) {
      overrides.set(`${dt.x},${dt.y}`, {
        layer: dt.layer,
        tile: unlocked ? dt.tileWhenUnlocked : dt.tileWhenLocked,
      });
    }
  }

  // 1. Render terrain tiles
  for (let y = 0; y < mapData.height; y++) {
    for (let x = 0; x < mapData.width; x++) {
      const ov = overrides.get(`${x},${y}`);
      let gTile = mapData.layers.ground[y][x];
      if (ov && ov.layer === 'ground') gTile = ov.tile;
      let dTile = mapData.layers.decor[y][x];
      if (ov && ov.layer === 'decor') dTile = ov.tile;

      const key = dTile && MAP_TILE_COLORS[dTile] ? dTile : gTile;
      ctx.fillStyle = MAP_TILE_COLORS[key] || '#1e293b';
      ctx.fillRect(x * tilePx, y * tilePx, tilePx, tilePx);
    }
  }

  // 2. Subtle named region labels
  ctx.save();
  ctx.font = 'bold 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of mapData.regions || []) {
    const cx = (r.x + r.width / 2) * tilePx;
    const cy = (r.y + r.height / 2) * tilePx;
    ctx.fillStyle = 'rgba(8, 12, 23, 0.55)';
    const w = Math.min(r.width * tilePx - 6, ctx.measureText(r.name).width + 10);
    ctx.fillRect(cx - w / 2, cy - 7, w, 14);
    ctx.fillStyle = 'rgba(238, 243, 255, 0.72)';
    ctx.fillText(r.name, cx, cy);
  }
  ctx.restore();

  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
  const highlightId = getActiveHighlightId();

  // 3. Draw entity pins
  for (const ent of mapData.entities || []) {
    const cx = (ent.x + 0.5) * tilePx;
    const cy = (ent.y + 0.5) * tilePx;

    if (ent.type === 'trial') {
      const isDone = solved.has(ent.refId);
      ctx.fillStyle = isDone ? '#059669' : '#eab308';
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isDone ? '#a7f3d0' : '#fef08a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = isDone ? '#ffffff' : '#1f1300';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isDone ? '✓' : '!', cx, cy + 0.5);
    } else if (ent.type === 'chest') {
      const isOpen = openedChests.has(ent.id);
      ctx.fillStyle = isOpen ? 'rgba(52, 211, 153, 0.55)' : '#f59e0b';
      ctx.fillRect(cx - 4.5, cy - 4.5, 9, 9);
      ctx.strokeStyle = isOpen ? '#a7f3d0' : '#fef3c7';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(cx - 4.5, cy - 4.5, 9, 9);
    } else if (ent.type === 'vault') {
      const isRescued = rescuedDragons.has(ent.refId);
      ctx.fillStyle = isRescued ? '#f6c945' : '#ef4444';
      ctx.beginPath();
      ctx.arc(cx, cy, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fef08a';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★', cx, cy + 0.5);
    } else {
      // NPC, Workshop, Portal -> blue/violet diamond
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = ent.type === 'portal' ? '#38bdf8' : '#a78bfa';
      ctx.fillRect(-4, -4, 8, 8);
      ctx.strokeStyle = '#eef3ff';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-4, -4, 8, 8);
      ctx.restore();
    }

    // Pulsing targeting ring when highlighted from checklist or map hover/click
    if (highlightId === ent.id) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.65 + 0.35 * pulse).toFixed(2)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 11 + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 15 + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 4. Hero's live position (pulsing cyan/white ring when Hero is in this Realm)
  const posObj = st.position || st.playerPos || null;
  const heroRealmId = posObj?.realmId || st.realmId || 'realm-01-meadow';
  if (save && heroRealmId === mapData.realmId && posObj && Number.isFinite(posObj.x) && Number.isFinite(posObj.y)) {
    const hx = (posObj.x + 0.5) * tilePx;
    const hy = (posObj.y + 0.5) * tilePx;
    ctx.fillStyle = `rgba(56, 189, 248, ${(0.35 + 0.35 * pulse).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(hx, hy, 8 + pulse * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(hx, hy, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

let lastTrackerContext = { mapData: null, items: null, save: null };

async function refreshRealmTracker() {
  const save = getActiveTrackerSave();
  const heroPill = $('#tracker-hero-pill');
  const realmSelect = $('#tracker-realm-select');
  const st = getSaveStateObj(save);

  if (heroPill) {
    heroPill.textContent = save ? `Hero: ${save.heroName || st.heroName || 'Hero'}` : 'Hero: None';
  }

  if (!state.trackerManualRealm && st.realmId) {
    state.trackerRealmId = st.realmId;
  }
  if (realmSelect && realmSelect.value !== state.trackerRealmId) {
    realmSelect.value = state.trackerRealmId;
  }

  const { realm } = getRealmMeta(state.trackerRealmId);
  const mapData = await fetchRealmMapCached(state.trackerRealmId);
  const items = buildTrackerItems(mapData, realm, save);
  lastTrackerContext = { mapData, items, save };

  renderTrackerChecklist(mapData, realm, save, items);
  updateTrackerCallout(mapData, items);
  drawTrackerMap(mapData, save);
}

function wireTrackerEvents() {
  const realmSel = $('#tracker-realm-select');
  realmSel?.addEventListener('change', () => {
    state.trackerRealmId = realmSel.value;
    state.trackerManualRealm = true;
    state.trackerPinnedEntityId = null;
    state.trackerHoverEntityId = null;
    refreshRealmTracker();
  });

  document.querySelectorAll('#tracker-filter-segmented .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.trackerFilter = btn.dataset.trackerFilter;
      document.querySelectorAll('#tracker-filter-segmented .seg-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.trackerFilter === state.trackerFilter);
      });
      refreshRealmTracker();
    });
  });

  const canvas = $('#tracker-map-canvas');
  if (canvas) {
    const findNearestEntityOnCanvas = (e) => {
      const { mapData } = lastTrackerContext;
      if (!mapData) return null;
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (canvas.width / rect.width);
      const py = (e.clientY - rect.top) * (canvas.height / rect.height);
      const tilePx = canvas.width / mapData.width;
      let nearest = null;
      let bestDist = 14;
      for (const ent of mapData.entities || []) {
        const ex = (ent.x + 0.5) * tilePx;
        const ey = (ent.y + 0.5) * tilePx;
        const d = Math.hypot(px - ex, py - ey);
        if (d < bestDist) {
          bestDist = d;
          nearest = ent;
        }
      }
      return nearest;
    };

    canvas.addEventListener('mousemove', (e) => {
      const ent = findNearestEntityOnCanvas(e);
      const nextId = ent ? ent.id : null;
      if (nextId !== state.trackerHoverEntityId) {
        state.trackerHoverEntityId = nextId;
        syncChecklistHighlight();
        updateTrackerCallout(lastTrackerContext.mapData, lastTrackerContext.items || { all: [] });
        drawTrackerMap(lastTrackerContext.mapData, lastTrackerContext.save);
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (state.trackerHoverEntityId !== null) {
        state.trackerHoverEntityId = null;
        syncChecklistHighlight();
        updateTrackerCallout(lastTrackerContext.mapData, lastTrackerContext.items || { all: [] });
        drawTrackerMap(lastTrackerContext.mapData, lastTrackerContext.save);
      }
    });

    canvas.addEventListener('click', (e) => {
      const ent = findNearestEntityOnCanvas(e);
      state.trackerPinnedEntityId = ent ? ent.id : null;
      syncChecklistHighlight();
      updateTrackerCallout(lastTrackerContext.mapData, lastTrackerContext.items || { all: [] });
      drawTrackerMap(lastTrackerContext.mapData, lastTrackerContext.save);
      if (ent) {
        const row = document.querySelector(`#tracker-checklist .tracker-row[data-entity-id="${CSS.escape(ent.id)}"]`);
        row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  // Lightweight pulse animation for Hero dot & targeting ring when Live Progress tab is visible
  const pulseTick = () => {
    const liveTab = $('#tab-live');
    if (liveTab?.classList.contains('active') && lastTrackerContext.mapData) {
      drawTrackerMap(lastTrackerContext.mapData, lastTrackerContext.save);
    }
    state.trackerAnimRaf = requestAnimationFrame(pulseTick);
  };
  state.trackerAnimRaf = requestAnimationFrame(pulseTick);
}

// ==================== WIRE UI EVENTS ====================
function wireEvents() {
  // Tabs (sticky across refreshes via URL hash + localStorage)
  const VALID_TABS = new Set(['live', 'story', 'health', 'assets']);
  const normalizeTab = (t) => (t === 'progress' ? 'live' : VALID_TABS.has(t) ? t : 'live');
  const activateTab = (target, { updateUrl = true } = {}) => {
    const tab = normalizeTab(target);
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tab}`);
    });
    try {
      localStorage.setItem('pyria_builder_tab', tab);
    } catch {
      // ignore storage errors
    }
    if (updateUrl && window.location.hash !== `#${tab}`) {
      history.replaceState(null, '', `#${tab}`);
    }
  };

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  window.addEventListener('hashchange', () => {
    const hashTab = window.location.hash.replace(/^#/, '');
    if (hashTab) activateTab(hashTab, { updateUrl: false });
  });

  const initialHashTab = window.location.hash.replace(/^#/, '');
  let savedTab = null;
  try {
    savedTab = localStorage.getItem('pyria_builder_tab');
  } catch {
    savedTab = null;
  }
  const initialTab = initialHashTab
    ? normalizeTab(initialHashTab)
    : savedTab
      ? normalizeTab(savedTab)
      : 'live';
  activateTab(initialTab, { updateUrl: false });

  // Live controls
  $('#btn-toggle-live').addEventListener('click', () => {
    setLivePolling(!state.liveEnabled);
  });
  $('#btn-refresh-now').addEventListener('click', () => {
    loadProgressFull().catch((e) => showToast(e.message, true));
    loadOverview().catch(() => {});
  });

  $('#filter-chip').addEventListener('click', () => {
    state.selectedHeroId = null;
    renderHeroCards();
    renderActivityStream();
  });

  // Passcode unlock
  $('#btn-passcode-submit').addEventListener('click', async () => {
    const val = $('#passcode-input').value.trim();
    sessionStorage.setItem(PASSCODE_STORAGE_KEY, val);
    try {
      await Promise.all([loadProgressFull(), loadOverview()]);
      showToast('Builder Console unlocked!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Account filter switcher
  $('#account-filter-select')?.addEventListener('change', (e) => {
    state.selectedAccount = e.target.value || 'all';
    state.selectedHeroId = null;
    state.trackerManualRealm = false;
    state.trackerPinnedEntityId = null;
    renderHeroCards();
    renderActivityStream();
    refreshRealmTracker();
  });

  // Quick parent difficulty controls
  document.querySelectorAll('#global-diff-segmented .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      pushGlobalDifficulty({ mode: btn.dataset.mode });
    });
  });
  $('#global-raw-tracebacks').addEventListener('change', (e) => {
    pushGlobalDifficulty({ showRawTracebacks: e.target.checked });
  });
  $('#global-max-hints').addEventListener('change', (e) => {
    pushGlobalDifficulty({ maxHintsAllowed: Number(e.target.value) });
  });

  // Story & Trials actions
  $('#btn-save-realm').addEventListener('click', saveCurrentRealm);
  $('#btn-add-trial').addEventListener('click', addNewTrialDraft);
  $('#btn-save-trial').addEventListener('click', saveCurrentTrial);
  $('#btn-delete-trial').addEventListener('click', deleteCurrentTrial);
  $('#btn-test-solution').addEventListener('click', testCurrentTrialSolution);

  // Assets preview switcher
  document.querySelectorAll('[data-preview]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.preview;
      document.querySelectorAll('[data-preview]').forEach((b) => {
        b.classList.toggle('active', b.dataset.preview === which);
      });
      const url = which === 'sprites' ? '/assets/sprites/preview.html' : '/assets/world/preview.html';
      $('#assets-iframe').src = url;
      $('#btn-open-preview-tab').href = url;
    });
  });
}

// ==================== BOOTSTRAP ====================
async function init() {
  wireEvents();
  wireTrackerEvents();
  try {
    const meRes = await fetch(`/api/me?_ts=${Date.now()}`, { cache: 'no-store' });
    if (meRes.ok) {
      state.me = await meRes.json();
      const adminPill = $('#builder-admin-pill');
      if (adminPill && state.me?.email) {
        adminPill.textContent = `🛡️ ${state.me.email}`;
        adminPill.classList.remove('hidden');
      }
    }
  } catch {
    // ignore if /api/me unavailable
  }
  try {
    await Promise.all([loadOverview(), loadProgressFull()]);
  } catch (err) {
    console.warn('Initial builder load error:', err.message);
  }
  setLivePolling(true);
}

init();
