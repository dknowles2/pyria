// Pyria Parent & Builder Console — Live Progress Stream, Difficulty Tuning & Story Editor

const POLL_INTERVAL_MS = 2500;
const PASSCODE_STORAGE_KEY = 'pyria_builder_passcode';

const state = {
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
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function renderHeroCards() {
  const listEl = $('#hero-cards-list');
  if (!listEl) return;

  if (!state.saves.length) {
    listEl.innerHTML =
      '<div class="empty-state">No saved heroes yet. Launch <a href="/" style="color:var(--accent-sky);">Pyria</a> and forge a hero to see live progress here!</div>';
    return;
  }

  listEl.innerHTML = state.saves
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
      const solvedCount = stats.solvedCount ?? solvedList.length;
      const pct = Math.min(100, Math.round((solvedCount / Math.max(1, totalRealmTrials)) * 100));
      const shards = st.byteShards ?? 0;
      const dragons = Array.isArray(st.rescuedDragons) ? st.rescuedDragons : [];
      const attemptCount = stats.attemptCount ?? 0;
      const passCount = stats.passCount ?? 0;
      const passPct = attemptCount > 0 ? `${Math.round((passCount / attemptCount) * 100)}%` : '—';
      const hintsUsed = stats.totalHintsUsed ?? 0;
      const lastActive = stats.lastActive || save.updatedAt;
      const isSelected = state.selectedHeroId === save.id;

      return `
        <div class="hero-card ${isSelected ? 'selected' : ''}" data-save-id="${escapeHtml(save.id)}">
          <div class="hero-card-top">
            <div>
              <div class="hero-card-name">${escapeHtml(save.heroName || st.heroName || 'Hero')}</div>
              <div class="hint-sub">${escapeHtml(era?.name || '8-Bit Era')} · ${escapeHtml(realm?.name || realmId)}</div>
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
      renderHeroCards();
      renderActivityStream();
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
  if (state.selectedHeroId) {
    const hero = state.saves.find((s) => s.id === state.selectedHeroId);
    filterChip?.classList.remove('hidden');
    if (filterName) filterName.textContent = hero?.heroName || 'Hero';
    filtered = state.events.filter((ev) => ev.saveId === state.selectedHeroId);
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
              <span class="pill ${badge.cls}">${badge.text}</span>
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
                  <button class="btn btn-sm btn-ghost btn-toggle-code" data-event-id="${ev.id}">
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
  state.summary = data.summary || null;
  if (data.globalDifficultyOverride) {
    state.globalDifficulty = data.globalDifficultyOverride;
  }

  const recent = Array.isArray(data.recentEvents) ? data.recentEvents : [];
  state.events = recent;
  state.latestEventId = recent.reduce((max, ev) => Math.max(max, Number(ev.id) || 0), 0);

  renderGlobalControls();
  renderSummaryStrip();
  renderHeroCards();
  renderActivityStream();
}

async function pollLiveUpdates() {
  try {
    const [actData, progData] = await Promise.all([
      apiFetch(`/api/builder/activity?since=${state.latestEventId}&limit=50`),
      apiFetch('/api/builder/progress'),
    ]);

    state.saves = Array.isArray(progData.saves) ? progData.saves : [];
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

    renderGlobalControls();
    renderSummaryStrip();
    renderHeroCards();
    renderActivityStream(newIds);
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
              <span>${r.number}. ${escapeHtml(r.name)}</span>
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
  btn.textContent = 'Testing...';
  try {
    const res = await apiFetch('/api/builder/test-trial', {
      method: 'POST',
      body: JSON.stringify({ code, testCode }),
    });
    box.className = `test-result-box ${res.passed ? 'passed' : 'failed'}`;
    box.classList.remove('hidden');
    box.innerHTML = `
      <div style="font-weight:800; margin-bottom:6px; color:${res.passed ? 'var(--accent-emerald)' : 'var(--accent-rose)'};">
        ${res.passed ? '✓ Reference Solution PASSED!' : res.timedOut ? '⏱ Timed Out (3s limit)' : '✗ Test Failed'}
      </div>
      ${res.pipFriendlyHint ? `<div style="margin-bottom:6px;">🐉 <strong>Pip:</strong> ${escapeHtml(res.pipFriendlyHint)}</div>` : ''}
      ${res.stdout ? `<pre class="event-code-pre">stdout:\n${escapeHtml(res.stdout)}</pre>` : ''}
      ${res.stderr ? `<pre class="event-code-pre" style="color:#fecdd3;">stderr:\n${escapeHtml(res.stderr)}</pre>` : ''}
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
          <td><strong>${realm.number}. ${escapeHtml(realm.name)}</strong></td>
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

// ==================== WIRE UI EVENTS ====================
function wireEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => {
        const active = b.dataset.tab === target;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `tab-${target}`);
      });
    });
  });

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
  try {
    await Promise.all([loadOverview(), loadProgressFull()]);
  } catch (err) {
    console.warn('Initial builder load error:', err.message);
  }
  setLivePolling(true);
}

init();
