// Pyria Parent & Builder Console — Live Progress Stream, Difficulty Tuning & Story Editor

const POLL_INTERVAL_MS = 2500;
const PASSCODE_STORAGE_KEY = 'pyria_builder_passcode';

const state = {
  mode: 'local', // 'local' | 'cloudflare'
  me: null,
  isAdmin: false,
  isParentAuthenticated: false,
  parentEmail: null,
  googleOAuthEnabled: false,
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

  // Trial Calibration state
  calFilters: {
    eraId: '',
    realmId: '',
    trialType: '',
    difficulty: 'all',
    days: '30',
    since: '',
    flag: 'all',
    includePractice: false,
  },
  calSortBy: 'flag',
  calSortDir: 'asc',
  calData: null,
  calLoading: false,
  calLoadedOnce: false,
  calReqSeq: 0,
  bootstrapped: false,
  activateTabFn: null,
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
  const isLocal = state.mode !== 'cloudflare';
  const passcode = isLocal ? sessionStorage.getItem(PASSCODE_STORAGE_KEY) || '' : '';
  const headers = {
    'Content-Type': 'application/json',
    ...(passcode ? { 'X-Builder-Passcode': passcode } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(url, { cache: 'no-store', ...options, headers });
  if (isLocal && (res.status === 401 || res.status === 403)) {
    $('#passcode-bar')?.classList.remove('hidden');
    throw new Error('Builder passcode required');
  }
  if (!isLocal && (res.status === 401 || res.status === 403)) {
    setLivePolling(false);
    showCloudflareSignInScreen();
    throw new Error('Parent sign-in required');
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
  if (isLocal) {
    $('#passcode-bar')?.classList.add('hidden');
  }
  return res.json();
}

function getProgressEndpoint() {
  if (state.mode !== 'cloudflare') {
    return '/api/builder/progress';
  }
  if (state.isAdmin && state.selectedAccount && state.selectedAccount !== 'all') {
    return `/api/console/progress?owner=${encodeURIComponent(state.selectedAccount)}`;
  }
  return '/api/console/progress';
}

function getActivityEndpoint(sinceId) {
  if (state.mode !== 'cloudflare') {
    return `/api/builder/activity?since=${sinceId}&limit=50`;
  }
  const ownerQs =
    state.isAdmin && state.selectedAccount && state.selectedAccount !== 'all'
      ? `&owner=${encodeURIComponent(state.selectedAccount)}`
      : '';
  return `/api/console/activity?since=${sinceId}&limit=50${ownerQs}`;
}

function getOverrideEndpoint(saveId) {
  if (state.mode === 'cloudflare') {
    return `/api/console/saves/${encodeURIComponent(saveId)}/override-trial`;
  }
  return `/api/builder/saves/${encodeURIComponent(saveId)}/override-trial`;
}

// ==================== CONSOLE MODAL HELPERS ====================
function closeConsoleModal() {
  const backdrop = $('#console-modal-backdrop');
  const content = $('#console-modal-content');
  backdrop?.classList.add('hidden');
  if (content) {
    content.className = 'card console-modal-card';
    content.innerHTML = '';
  }
}

function openConsoleModal(html, extraClass = '') {
  const backdrop = $('#console-modal-backdrop');
  const content = $('#console-modal-content');
  if (!backdrop || !content) return;
  content.className = `card console-modal-card ${extraClass}`.trim();
  content.innerHTML = html;
  backdrop.classList.remove('hidden');
  content.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', closeConsoleModal);
  });
}

function openOneTimeHeroCodeModal({ heroName, heroCode, title, note }) {
  openConsoleModal(`
    <div class="console-modal-header">
      <h2>${escapeHtml(title || '🔑 Hero Code Created')}</h2>
      <button type="button" class="btn btn-sm btn-ghost" data-close-modal>✕</button>
    </div>
    <p class="muted-text" style="margin:0;">
      Hero: <strong style="color:var(--text-main);">${escapeHtml(heroName || 'Hero')}</strong>
    </p>
    <div class="console-code-box">
      <div id="console-onetime-code" class="console-code-display"></div>
      <button id="btn-console-copy-code" type="button" class="btn btn-sm btn-gold">📋 Copy Hero Code</button>
    </div>
    <p class="muted-text" style="margin:0;">
      ${escapeHtml(
        note ||
          'Give this one-time Hero Code to your child. On their tablet or computer, click "Enter Hero Code" on the title screen to play!'
      )}
    </p>
    <div class="console-modal-footer">
      <button type="button" class="btn btn-primary" data-close-modal>Done</button>
    </div>
  `);

  const codeEl = $('#console-onetime-code');
  if (codeEl) codeEl.textContent = String(heroCode || '');

  const copyBtn = $('#btn-console-copy-code');
  copyBtn?.addEventListener('click', async () => {
    const text = String(heroCode || '');
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = '✓ Copied!';
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        copyBtn.textContent = '✓ Copied!';
      } catch {
        copyBtn.textContent = 'Select & Copy Above';
      }
      ta.remove();
    }
  });
}

function openAddChildHeroModal() {
  openConsoleModal(`
    <div class="console-modal-header">
      <h2>✨ Add Child Hero</h2>
      <button type="button" class="btn btn-sm btn-ghost" data-close-modal>✕</button>
    </div>
    <div class="field">
      <label for="add-hero-name">Hero Name (2–24 characters)</label>
      <input id="add-hero-name" type="text" class="input" maxlength="24" placeholder="e.g. Rowan" autocomplete="off" />
    </div>
    <div class="form-grid">
      <div class="field">
        <label for="add-hero-diff">Difficulty</label>
        <select id="add-hero-diff" class="input">
          <option value="explorer">Explorer</option>
          <option value="standard" selected>Standard</option>
          <option value="challenge">Challenge</option>
        </select>
      </div>
      <div class="field">
        <label for="add-hero-hints">Max Pip Hints</label>
        <select id="add-hero-hints" class="input">
          <option value="0">0 (No hints)</option>
          <option value="1">1 (Nudge)</option>
          <option value="2">2 (Pattern)</option>
          <option value="3" selected>3 (Full)</option>
        </select>
      </div>
    </div>
    <label class="control-group checkbox-control">
      <input id="add-hero-tracebacks" type="checkbox" />
      <span>Show Raw Python Tracebacks</span>
    </label>
    <div id="add-hero-error" class="console-error-msg hidden"></div>
    <div class="console-modal-footer">
      <button type="button" class="btn btn-ghost" data-close-modal>Cancel</button>
      <button id="btn-submit-add-hero" type="button" class="btn btn-primary">Create Hero &amp; Code</button>
    </div>
  `);

  const nameEl = $('#add-hero-name');
  const errEl = $('#add-hero-error');
  const submitBtn = $('#btn-submit-add-hero');
  setTimeout(() => nameEl?.focus(), 30);

  submitBtn?.addEventListener('click', async () => {
    const heroName = String(nameEl?.value || '').trim();
    if (heroName.length < 2 || heroName.length > 24) {
      if (errEl) {
        errEl.textContent = 'Hero name must be between 2 and 24 characters.';
        errEl.classList.remove('hidden');
      }
      return;
    }
    if (errEl) errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';
    try {
      const res = await apiFetch('/api/console/heroes', {
        method: 'POST',
        body: JSON.stringify({
          heroName,
          preferences: {
            difficulty: $('#add-hero-diff')?.value || 'standard',
            maxPipHints: Number($('#add-hero-hints')?.value ?? 3),
            showRawTracebacks: Boolean($('#add-hero-tracebacks')?.checked),
          },
        }),
      });
      await loadProgressFull();
      openOneTimeHeroCodeModal({
        heroName: res.save?.heroName || heroName,
        heroCode: res.heroCode,
        title: '🔑 Child Hero Created!',
      });
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'Could not create hero.';
        errEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Hero & Code';
    }
  });
}

function openClaimHeroModal() {
  openConsoleModal(`
    <div class="console-modal-header">
      <h2>🔗 Link Existing Hero Code</h2>
      <button type="button" class="btn btn-sm btn-ghost" data-close-modal>✕</button>
    </div>
    <p class="muted-text" style="margin:0;">
      Enter the Hero Code from your child's device to link their hero to your Parent Console.
    </p>
    <div class="field">
      <label for="claim-hero-code">Hero Code</label>
      <input id="claim-hero-code" type="text" class="input input-mono" maxlength="40" placeholder="EMBER-DRAGON-4821" autocomplete="off" />
    </div>
    <div id="claim-hero-error" class="console-error-msg hidden"></div>
    <div class="console-modal-footer">
      <button type="button" class="btn btn-ghost" data-close-modal>Cancel</button>
      <button id="btn-submit-claim-hero" type="button" class="btn btn-sky">Link Hero</button>
    </div>
  `);

  const codeEl = $('#claim-hero-code');
  const errEl = $('#claim-hero-error');
  const submitBtn = $('#btn-submit-claim-hero');
  setTimeout(() => codeEl?.focus(), 30);

  submitBtn?.addEventListener('click', async () => {
    const heroCode = String(codeEl?.value || '').trim().toUpperCase();
    if (!heroCode) {
      if (errEl) {
        errEl.textContent = 'Please enter a Hero Code.';
        errEl.classList.remove('hidden');
      }
      return;
    }
    if (errEl) errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Linking...';
    try {
      const res = await apiFetch('/api/console/claim-hero', {
        method: 'POST',
        body: JSON.stringify({ heroCode }),
      });
      closeConsoleModal();
      showToast(`Linked hero "${res.save?.heroName || 'Hero'}" to your console!`);
      await loadProgressFull();
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'Could not link Hero Code.';
        errEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Link Hero';
    }
  });
}

function openHeroPreferencesModal(save) {
  const prefs = save?.preferences && typeof save.preferences === 'object' ? save.preferences : {};
  const prefDiff = prefs.difficulty || 'standard';
  const prefHints = Number.isFinite(Number(prefs.maxPipHints)) ? Number(prefs.maxPipHints) : 3;
  const prefTracebacks = Boolean(prefs.showRawTracebacks);

  openConsoleModal(`
    <div class="console-modal-header">
      <h2>⚙️ Learning Settings</h2>
      <button type="button" class="btn btn-sm btn-ghost" data-close-modal>✕</button>
    </div>
    <p class="muted-text" style="margin:0;">
      Customize Python difficulty and Pip hints for <strong style="color:var(--text-main);">${escapeHtml(save.heroName || 'Hero')}</strong>.
    </p>
    <div class="form-grid">
      <div class="field">
        <label for="pref-modal-diff">Difficulty</label>
        <select id="pref-modal-diff" class="input">
          <option value="explorer" ${prefDiff === 'explorer' ? 'selected' : ''}>Explorer</option>
          <option value="standard" ${prefDiff === 'standard' ? 'selected' : ''}>Standard</option>
          <option value="challenge" ${prefDiff === 'challenge' ? 'selected' : ''}>Challenge</option>
        </select>
      </div>
      <div class="field">
        <label for="pref-modal-hints">Max Pip Hints</label>
        <select id="pref-modal-hints" class="input">
          <option value="0" ${prefHints === 0 ? 'selected' : ''}>0 (No hints)</option>
          <option value="1" ${prefHints === 1 ? 'selected' : ''}>1 (Nudge)</option>
          <option value="2" ${prefHints === 2 ? 'selected' : ''}>2 (Pattern)</option>
          <option value="3" ${prefHints === 3 ? 'selected' : ''}>3 (Full)</option>
        </select>
      </div>
    </div>
    <label class="control-group checkbox-control">
      <input id="pref-modal-tracebacks" type="checkbox" ${prefTracebacks ? 'checked' : ''} />
      <span>Show Raw Python Tracebacks</span>
    </label>
    <div id="pref-modal-error" class="console-error-msg hidden"></div>
    <div class="console-modal-footer">
      <button type="button" class="btn btn-ghost" data-close-modal>Cancel</button>
      <button id="btn-submit-hero-prefs" type="button" class="btn btn-primary">Save Settings</button>
    </div>
  `);

  const errEl = $('#pref-modal-error');
  const submitBtn = $('#btn-submit-hero-prefs');
  submitBtn?.addEventListener('click', async () => {
    const difficulty = $('#pref-modal-diff')?.value || 'standard';
    const maxPipHints = Number($('#pref-modal-hints')?.value ?? 3);
    const showRawTracebacks = Boolean($('#pref-modal-tracebacks')?.checked);
    if (errEl) errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';
    try {
      await apiFetch(`/api/console/saves/${encodeURIComponent(save.id)}/preferences`, {
        method: 'PUT',
        body: JSON.stringify({ difficulty, maxPipHints, showRawTracebacks }),
      });
      closeConsoleModal();
      showToast(`Saved settings for "${save.heroName}"!`);
      await loadProgressFull();
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'Could not save settings.';
        errEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Settings';
    }
  });
}

function openAssignOwnerModal(save) {
  openConsoleModal(`
    <div class="console-modal-header">
      <h2>👤 Assign Owner (Admin)</h2>
      <button type="button" class="btn btn-sm btn-ghost" data-close-modal>✕</button>
    </div>
    <p class="muted-text" style="margin:0;">
      Reassign <strong style="color:var(--text-main);">${escapeHtml(save.heroName || 'Hero')}</strong> to a parent account email:
    </p>
    <div class="field">
      <label for="assign-owner-email">Owner Email</label>
      <input id="assign-owner-email" type="email" class="input" value="${escapeHtml(save.ownerEmail || '')}" placeholder="parent@example.com" autocomplete="off" />
    </div>
    <div id="assign-owner-error" class="console-error-msg hidden"></div>
    <div class="console-modal-footer">
      <button type="button" class="btn btn-ghost" data-close-modal>Cancel</button>
      <button id="btn-submit-assign-owner" type="button" class="btn btn-gold">Save Owner</button>
    </div>
  `);

  const emailEl = $('#assign-owner-email');
  const errEl = $('#assign-owner-error');
  const submitBtn = $('#btn-submit-assign-owner');
  setTimeout(() => emailEl?.focus(), 30);

  submitBtn?.addEventListener('click', async () => {
    const ownerEmail = String(emailEl?.value || '').trim().toLowerCase();
    if (!ownerEmail) {
      if (errEl) {
        errEl.textContent = 'Please enter a valid owner email.';
        errEl.classList.remove('hidden');
      }
      return;
    }
    if (errEl) errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';
    try {
      await apiFetch(`/api/console/saves/${encodeURIComponent(save.id)}/assign-owner`, {
        method: 'POST',
        body: JSON.stringify({ ownerEmail }),
      });
      closeConsoleModal();
      showToast(`Assigned "${save.heroName}" to ${ownerEmail}`);
      await loadProgressFull();
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || 'Could not assign owner.';
        errEl.classList.remove('hidden');
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Owner';
    }
  });
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
      state.mode === 'cloudflare'
        ? '<div class="empty-state">No heroes linked yet. Click <strong>+ Add Child Hero</strong> to create a Hero Code, or <strong>🔗 Link Hero Code</strong> to claim a child\'s existing hero!</div>'
        : '<div class="empty-state">No saved heroes yet for this account. Launch <a href="/" style="color:var(--accent-sky);">Pyria</a> and forge a hero to see live progress here!</div>';
    return;
  }

  listEl.innerHTML = visibleSaves
    .map((save) => {
      const st = save.state && typeof save.state === 'object' ? save.state : save;
      const stats = save.stats || {};
      const prefs = save.preferences && typeof save.preferences === 'object' ? save.preferences : {};
      const prefDiff = prefs.difficulty || 'standard';
      const prefHints = Number.isFinite(Number(prefs.maxPipHints)) ? Number(prefs.maxPipHints) : 3;
      const prefTracebacks = Boolean(prefs.showRawTracebacks);
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

      const diffLabel = prefDiff.charAt(0).toUpperCase() + prefDiff.slice(1);
      const consoleControlsHtml =
        state.mode === 'cloudflare'
          ? `
            <div class="hero-card-console-controls" data-stop-card-click>
              <div class="hero-console-actions-row">
                <span class="pill pill-muted">⚙️ ${escapeHtml(diffLabel)} · ${prefHints} ${prefHints === 1 ? 'Hint' : 'Hints'}${prefTracebacks ? ' · Tracebacks' : ''}</span>
                <button type="button" class="btn btn-sm btn-primary btn-edit-hero-prefs" data-save-id="${escapeHtml(save.id)}">⚙️ Settings</button>
                <button type="button" class="btn btn-sm btn-gold btn-rotate-hero-code" data-save-id="${escapeHtml(save.id)}">🔄 Rotate / Revoke Code</button>
                ${
                  state.isAdmin
                    ? `<button type="button" class="btn btn-sm btn-ghost btn-assign-hero-owner" data-save-id="${escapeHtml(save.id)}">👤 Assign Owner</button>`
                    : ''
                }
              </div>
            </div>
          `
          : '';

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
          ${consoleControlsHtml}
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('[data-stop-card-click]').forEach((el) => {
    el.addEventListener('click', (e) => e.stopPropagation());
  });

  listEl.querySelectorAll('.btn-edit-hero-prefs').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const save = state.saves.find((s) => s.id === btn.dataset.saveId);
      if (save) openHeroPreferencesModal(save);
    });
  });

  listEl.querySelectorAll('.btn-rotate-hero-code').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const saveId = btn.dataset.saveId;
      const save = state.saves.find((s) => s.id === saveId);
      if (!save) return;
      if (
        !confirm(
          `Rotate Hero Code for "${save.heroName}"? This will immediately sign out any child device using the old code.`
        )
      ) {
        return;
      }
      btn.disabled = true;
      try {
        const res = await apiFetch(`/api/console/saves/${encodeURIComponent(saveId)}/rotate-code`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        openOneTimeHeroCodeModal({
          heroName: save.heroName,
          heroCode: res.heroCode,
          title: '🔄 New Hero Code Generated',
          note: 'Old child-device sessions have been revoked. Share this new one-time code to sign back in.',
        });
      } catch (err) {
        showToast(`Could not rotate code: ${err.message}`, true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  listEl.querySelectorAll('.btn-assign-hero-owner').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const save = state.saves.find((s) => s.id === btn.dataset.saveId);
      if (save) openAssignOwnerModal(save);
    });
  });

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
  const data = await apiFetch(getProgressEndpoint());
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
      apiFetch(getActivityEndpoint(state.latestEventId)),
      apiFetch(getProgressEndpoint()),
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

async function loadConsoleCurriculum() {
  try {
    const cfgRes = await fetch('/api/config', { cache: 'no-store' });
    if (!cfgRes.ok) return;
    const cfg = await cfgRes.json();
    const eraOrder = cfg?.game?.eraOrder || ['era-01-8bit', 'era-02-16bit', 'era-03-32bit', 'era-04-64bit'];
    const loadedEras = await Promise.all(
      eraOrder.map(async (eraId) => {
        try {
          const r = await fetch(`/content/eras/${encodeURIComponent(eraId)}.json`);
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      })
    );
    state.overview = {
      game: cfg.game || {},
      catalog: cfg.catalog || {},
      eras: loadedEras.filter(Boolean),
      conceptWarnings: [],
    };
    populateTrackerRealmSelect();
    populateCalibrationEraRealmFilters();
    renderHeroCards();
    refreshRealmTracker();
  } catch (err) {
    console.warn('Could not load curriculum metadata:', err);
  }
}

// ==================== STORY, TRIALS & CONCEPT HEALTH ====================
async function loadOverview() {
  if (state.mode === 'cloudflare') {
    await loadConsoleCurriculum();
    return;
  }
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
  populateCalibrationEraRealmFilters();
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
    const { pyRunner } = await import('/js/pyRunner.js?v=20261127j');
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
          getOverrideEndpoint(save.id),
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

// ==================== TRIAL CALIBRATION ====================
function canAccessCalibration() {
  return state.mode !== 'cloudflare' || (state.isParentAuthenticated && state.isAdmin);
}

function getCalibrationEndpoint(format = 'json') {
  const base = state.mode === 'cloudflare' ? '/api/admin/trial-metrics' : '/api/builder/trial-metrics';
  const params = new URLSearchParams();
  const f = state.calFilters;
  if (f.eraId) params.set('eraId', f.eraId);
  if (f.realmId) params.set('realmId', f.realmId);
  if (f.trialType) params.set('trialType', f.trialType);
  if (f.difficulty) params.set('difficulty', f.difficulty);
  if (f.days) params.set('days', f.days);
  if (f.since && /^\d{4}-\d{2}-\d{2}$/.test(f.since)) params.set('since', f.since);
  params.set('includePractice', f.includePractice ? '1' : '0');
  params.set('format', format === 'csv' ? 'csv' : 'json');
  return `${base}?${params.toString()}`;
}

function formatCalPct(val) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return '—';
  const rounded = Math.round(Number(val) * 10) / 10;
  return `${rounded}%`;
}

function formatCalNum(val, decimals = 1) {
  if (val === null || val === undefined || !Number.isFinite(Number(val))) return '—';
  const n = Number(val);
  if (decimals <= 0) return String(Math.round(n));
  return n.toFixed(decimals).replace(/\.0$/, '');
}

function formatTrialTypeLabel(trialType) {
  if (trialType === 'multiple_choice') return 'Multiple Choice';
  if (trialType === 'fix_bug') return 'Fix the Bug';
  if (!trialType || trialType === 'code') return 'Coding';
  return String(trialType);
}

function getCalibrationFlagMeta(flag) {
  switch (flag) {
    case 'possible_bug':
      return { order: 0, cls: 'pill-violet', label: '🟣 Possible Bug' };
    case 'too_hard':
      return { order: 1, cls: 'pill-rose', label: '🔴 Too Hard' };
    case 'too_easy':
      return { order: 2, cls: 'pill-amber', label: '🟡 Too Easy' };
    case 'low_data':
      return { order: 3, cls: 'pill-muted', label: '⚪ Low Data' };
    case 'ok':
    default:
      return { order: 4, cls: 'pill-green', label: '🟢 OK' };
  }
}

function populateCalibrationEraRealmFilters() {
  const eraSel = $('#cal-filter-era');
  const realmSel = $('#cal-filter-realm');
  if (!eraSel || !realmSel || !state.overview) return;

  const eras = state.overview.eras || [];
  const eraOpts = ['<option value="">All Eras</option>'];
  for (const era of eras) {
    eraOpts.push(`<option value="${escapeHtml(era.id)}">${escapeHtml(era.name || era.id)}</option>`);
  }
  eraSel.innerHTML = eraOpts.join('');
  if (state.calFilters.eraId && !eras.some((e) => e.id === state.calFilters.eraId)) {
    state.calFilters.eraId = '';
  }
  eraSel.value = state.calFilters.eraId;

  const filteredEras = state.calFilters.eraId
    ? eras.filter((e) => e.id === state.calFilters.eraId)
    : eras;
  const realmOpts = ['<option value="">All Realms</option>'];
  const validRealmIds = new Set();
  for (const era of filteredEras) {
    for (const r of era.realms || []) {
      validRealmIds.add(r.id);
      realmOpts.push(
        `<option value="${escapeHtml(r.id)}">${escapeHtml(r.number)}. ${escapeHtml(r.name)}</option>`
      );
    }
  }
  realmSel.innerHTML = realmOpts.join('');
  if (state.calFilters.realmId && !validRealmIds.has(state.calFilters.realmId)) {
    state.calFilters.realmId = '';
  }
  realmSel.value = state.calFilters.realmId;
}

function renderCalibrationKpis() {
  const s = state.calData?.summary || {};
  const withData = Number(s.trialsWithData) || 0;
  const totalTrials = Number(s.totalTrials) || 0;
  const setText = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text;
  };
  setText('#cal-kpi-with-data', `${withData} / ${totalTrials}`);
  setText('#cal-kpi-too-hard', String(Number(s.flaggedTooHard) || 0));
  setText('#cal-kpi-too-easy', String(Number(s.flaggedTooEasy) || 0));
  setText('#cal-kpi-possible-bug', String(Number(s.flaggedPossibleBug) || 0));
  setText('#cal-kpi-median', formatCalNum(s.overallMedianAttempts, 1));
  setText('#cal-kpi-overrides', String(Number(s.totalOverrides) || 0));
}

function getFilteredSortedCalibrationTrials() {
  const all = Array.isArray(state.calData?.trials) ? state.calData.trials : [];
  const flagFilter = state.calFilters.flag || 'all';
  const filtered = all.filter((t) => {
    if (flagFilter === 'all') return true;
    if (flagFilter === 'flagged') {
      return t.flag === 'too_hard' || t.flag === 'too_easy' || t.flag === 'possible_bug';
    }
    return t.flag === flagFilter;
  });

  const sortBy = state.calSortBy || 'flag';
  const dir = state.calSortDir === 'desc' ? -1 : 1;

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'title') {
      const sa = String(a.title || a.trialId || '');
      const sb = String(b.title || b.trialId || '');
      return sa.localeCompare(sb) * dir;
    }
    if (sortBy === 'flag') {
      const oa = getCalibrationFlagMeta(a.flag).order;
      const ob = getCalibrationFlagMeta(b.flag).order;
      if (oa !== ob) return (oa - ob) * dir;
      // Tie-break by uniqueHeroes descending
      return ((Number(b.uniqueHeroes) || 0) - (Number(a.uniqueHeroes) || 0));
    }
    const va = a[sortBy];
    const vb = b[sortBy];
    const aNull = va === null || va === undefined || !Number.isFinite(Number(va));
    const bNull = vb === null || vb === undefined || !Number.isFinite(Number(vb));
    if (aNull && bNull) return String(a.trialId || '').localeCompare(String(b.trialId || ''));
    if (aNull) return 1;
    if (bNull) return -1;
    const diff = (Number(va) - Number(vb)) * dir;
    if (diff !== 0) return diff;
    return String(a.trialId || '').localeCompare(String(b.trialId || ''));
  });

  return sorted;
}

function renderCalibrationTable() {
  const tbody = $('#cal-metrics-tbody');
  const countPill = $('#cal-table-count-pill');
  if (!tbody) return;

  // Update sort header indicators
  document.querySelectorAll('.cal-sort-btn').forEach((btn) => {
    const active = btn.dataset.calSort === state.calSortBy;
    btn.classList.toggle('active', active);
    const arrow = btn.querySelector('.cal-sort-arrow');
    if (arrow) {
      arrow.textContent = active ? (state.calSortDir === 'desc' ? '▼' : '▲') : '';
    }
  });

  if (state.calLoading && !state.calData) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Loading Trial Calibration metrics...</div></td></tr>';
    return;
  }

  const rows = getFilteredSortedCalibrationTrials();
  if (countPill) {
    countPill.textContent = `${rows.length} ${rows.length === 1 ? 'trial' : 'trials'}`;
  }

  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="8"><div class="empty-state">No trials match the current calibration filters.</div></td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((t) => {
      const flagMeta = getCalibrationFlagMeta(t.flag);
      const { era, realm } = getRealmMeta(t.realmId);
      const realmLabel = t.realmName || realm?.name || t.realmId || '';
      const eraLabel = t.eraName || era?.name || t.eraId || '';
      const typeLabel = formatTrialTypeLabel(t.trialType);

      return `
        <tr class="cal-row" tabindex="0" data-cal-trial-id="${escapeHtml(t.trialId)}">
          <td>
            <div class="cal-trial-title">${escapeHtml(t.title || t.trialId)}</div>
            <div class="cal-trial-meta">
              <code>${escapeHtml(t.trialId)}</code> · ${escapeHtml(realmLabel)}${eraLabel ? ` (${escapeHtml(eraLabel)})` : ''} · ${escapeHtml(typeLabel)}
            </div>
          </td>
          <td><strong>${Number(t.uniqueHeroes) || 0}</strong></td>
          <td>${escapeHtml(formatCalPct(t.completionRate))}</td>
          <td>${escapeHtml(formatCalPct(t.firstTryPassRate))}</td>
          <td>${escapeHtml(formatCalNum(t.medianAttemptsToSolve, 1))}</td>
          <td>${escapeHtml(formatCalPct(t.hintUsageRate))}</td>
          <td>${Number(t.parentOverrides) || 0}</td>
          <td><span class="pill ${escapeHtml(flagMeta.cls)}">${escapeHtml(flagMeta.label)}</span></td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.cal-row').forEach((row) => {
    const open = () => {
      const tid = row.dataset.calTrialId;
      const found = (state.calData?.trials || []).find((x) => x.trialId === tid);
      if (found) openTrialCalibrationDrillDown(found);
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

function renderBeforeAfterSummary(dailyTrend, cutoffDay) {
  const trend = Array.isArray(dailyTrend) ? dailyTrend : [];
  if (!cutoffDay || !/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay)) {
    return '<div class="hint-sub">Pick a cutoff date above to compare pass rates before vs. on/after a calibration edit.</div>';
  }
  const agg = (items) => {
    let attempts = 0;
    let passes = 0;
    for (const d of items) {
      attempts += Number(d.attempts) || 0;
      passes += Number(d.passes) || 0;
    }
    const rate = attempts > 0 ? Math.round((passes / attempts) * 1000) / 10 : null;
    return { attempts, passes, rate };
  };
  const before = agg(trend.filter((d) => String(d.day || '') < cutoffDay));
  const after = agg(trend.filter((d) => String(d.day || '') >= cutoffDay));
  return `
    <div class="cal-before-after-grid">
      <div class="cal-before-after-card">
        <span class="cal-drill-stat-label">Before ${escapeHtml(cutoffDay)}</span>
        <strong>Pass Rate: ${escapeHtml(formatCalPct(before.rate))}</strong>
        <span class="hint-sub">${before.passes} passes / ${before.attempts} attempts</span>
      </div>
      <div class="cal-before-after-card">
        <span class="cal-drill-stat-label">On / After ${escapeHtml(cutoffDay)}</span>
        <strong>Pass Rate: ${escapeHtml(formatCalPct(after.rate))}</strong>
        <span class="hint-sub">${after.passes} passes / ${after.attempts} attempts</span>
      </div>
    </div>
  `;
}

function openTrialCalibrationDrillDown(trial) {
  const flagMeta = getCalibrationFlagMeta(trial.flag);
  const { era, realm } = getRealmMeta(trial.realmId);
  const eraLabel = trial.eraName || era?.name || trial.eraId || '';
  const realmLabel = trial.realmName || realm?.name || trial.realmId || '';
  const concepts = Array.isArray(trial.concepts) ? trial.concepts : [];
  const reasons = Array.isArray(trial.flagReasons) ? trial.flagReasons : [];
  const hints = trial.hintTierBreakdown && typeof trial.hintTierBreakdown === 'object'
    ? trial.hintTierBreakdown
    : { tier0: 0, tier1: 0, tier2: 0, tier3: 0 };
  const hintTiers = [
    { label: 'Tier 0 (No Hints)', count: Number(hints.tier0) || 0 },
    { label: 'Tier 1 (Nudge)', count: Number(hints.tier1) || 0 },
    { label: 'Tier 2 (Pattern)', count: Number(hints.tier2) || 0 },
    { label: 'Tier 3+ (Walkthrough)', count: Number(hints.tier3) || 0 },
  ];
  const totalHintRows = Math.max(1, hintTiers.reduce((acc, h) => acc + h.count, 0));

  const topErrors = Array.isArray(trial.topErrors) ? trial.topErrors : [];
  const maxErrorCount = Math.max(1, ...topErrors.map((e) => Number(e.count) || 0));

  const dailyTrend = Array.isArray(trial.dailyTrend) ? trial.dailyTrend : [];
  const maxDailyAttempts = Math.max(1, ...dailyTrend.map((d) => Number(d.attempts) || 0));
  const activeSince = state.calFilters.since || '';
  const initialCutoff = '';
  const canEditInBuilder = state.mode !== 'cloudflare';

  openConsoleModal(
    `
    <div class="console-modal-header">
      <div>
        <h2>${escapeHtml(trial.title || trial.trialId)}</h2>
        <div class="cal-trial-meta" style="margin-top:4px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <code>${escapeHtml(trial.trialId)}</code>
          <span class="pill ${escapeHtml(flagMeta.cls)}">${escapeHtml(flagMeta.label)}</span>
          <span class="pill pill-blue">${escapeHtml(formatTrialTypeLabel(trial.trialType))}</span>
          ${realmLabel ? `<span class="pill pill-muted">${escapeHtml(realmLabel)}${eraLabel ? ` · ${escapeHtml(eraLabel)}` : ''}</span>` : ''}
          ${concepts.map((c) => `<span class="pill pill-muted">${escapeHtml(c)}</span>`).join('')}
        </div>
      </div>
      <button type="button" class="btn btn-sm btn-ghost" data-close-modal>✕</button>
    </div>

    ${
      reasons.length
        ? `
          <div class="cal-drill-section">
            <h3>🚩 Calibration Flag Reasons</h3>
            <ul class="cal-flag-reasons">
              ${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
            </ul>
          </div>
        `
        : ''
    }

    <div class="cal-drill-stats">
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">Unique Heroes</span>
        <span class="cal-drill-stat-val">${Number(trial.uniqueHeroes) || 0}</span>
      </div>
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">Unique Solvers</span>
        <span class="cal-drill-stat-val">${Number(trial.uniqueSolvers) || 0}</span>
      </div>
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">Completion %</span>
        <span class="cal-drill-stat-val">${escapeHtml(formatCalPct(trial.completionRate))}</span>
      </div>
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">First-Try %</span>
        <span class="cal-drill-stat-val">${escapeHtml(formatCalPct(trial.firstTryPassRate))}</span>
      </div>
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">Median / P75</span>
        <span class="cal-drill-stat-val">${escapeHtml(formatCalNum(trial.medianAttemptsToSolve, 1))} / ${escapeHtml(formatCalNum(trial.p75AttemptsToSolve, 1))}</span>
      </div>
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">Attempts / Passes</span>
        <span class="cal-drill-stat-val">${Number(trial.attempts) || 0} / ${Number(trial.passes) || 0}</span>
      </div>
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">Hint / Tier-3 %</span>
        <span class="cal-drill-stat-val">${escapeHtml(formatCalPct(trial.hintUsageRate))} / ${escapeHtml(formatCalPct(trial.tier3HintRate))}</span>
      </div>
      <div class="cal-drill-stat">
        <span class="cal-drill-stat-label">Overrides</span>
        <span class="cal-drill-stat-val">${Number(trial.parentOverrides) || 0} (${escapeHtml(formatCalPct(trial.parentOverrideRate))})</span>
      </div>
    </div>

    <div class="cal-drill-section">
      <h3>💡 Hint-Tier Breakdown</h3>
      <div class="cal-bar-list">
        ${hintTiers
          .map((h) => {
            const pct = Math.round((h.count / totalHintRows) * 100);
            return `
              <div class="cal-bar-row">
                <span class="cal-bar-label">${escapeHtml(h.label)}</span>
                <div class="cal-bar-track"><div class="cal-bar-fill fill-hint" style="width:${pct}%;"></div></div>
                <span class="cal-bar-val">${h.count} (${pct}%)</span>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>

    <div class="cal-drill-section">
      <h3>⚠️ Top Failure Modes</h3>
      ${
        topErrors.length
          ? `
            <div class="cal-bar-list">
              ${topErrors
                .map((e) => {
                  const cnt = Number(e.count) || 0;
                  const pct = Math.round((cnt / maxErrorCount) * 100);
                  return `
                    <div class="cal-bar-row">
                      <span class="cal-bar-label" title="${escapeHtml(e.errorType)}"><code>${escapeHtml(e.errorType)}</code></span>
                      <div class="cal-bar-track"><div class="cal-bar-fill fill-error" style="width:${pct}%;"></div></div>
                      <span class="cal-bar-val">${cnt}</span>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
          : '<div class="hint-sub">No recorded failure error types in this window.</div>'
      }
    </div>

    <div class="cal-drill-section">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
        <h3>📈 Daily Trend &amp; Before/After Check</h3>
        <label class="control-group" style="font-size:12px;">
          <span class="control-label">Cutoff Date:</span>
          <input id="cal-drill-cutoff" type="date" class="input input-sm" value="${escapeHtml(initialCutoff)}" />
        </label>
      </div>
      ${
        activeSince
          ? `<div class="hint-sub" style="color:var(--accent-amber);">Note: active <strong>Since (${escapeHtml(activeSince)})</strong> filter excludes earlier days. Clear <strong>Since</strong> and widen the Time Window to compare before vs. after.</div>`
          : ''
      }
      <div id="cal-drill-before-after">${renderBeforeAfterSummary(dailyTrend, initialCutoff)}</div>
      ${
        dailyTrend.length
          ? `
            <div class="cal-trend-wrap">
              ${dailyTrend
                .map((d) => {
                  const att = Number(d.attempts) || 0;
                  const pass = Number(d.passes) || 0;
                  const pctBar = Math.round((att / maxDailyAttempts) * 100);
                  const passPct = att > 0 ? Math.round((pass / att) * 100) : 0;
                  return `
                    <div class="cal-trend-row">
                      <code style="color:var(--text-muted);">${escapeHtml(d.day)}</code>
                      <div class="cal-bar-track"><div class="cal-bar-fill" style="width:${pctBar}%;"></div></div>
                      <span class="cal-bar-val">${pass}/${att} (${passPct}%)</span>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
          : '<div class="hint-sub">No daily trend points in this window.</div>'
      }
    </div>

    <div class="console-modal-footer">
      ${
        canEditInBuilder
          ? '<button id="btn-cal-edit-trial" type="button" class="btn btn-primary">✏️ Edit Trial in Story &amp; Trials</button>'
          : ''
      }
      <button type="button" class="btn btn-ghost" data-close-modal>Close</button>
    </div>
    `,
    'console-modal-wide'
  );

  const cutoffInput = $('#cal-drill-cutoff');
  const beforeAfterEl = $('#cal-drill-before-after');
  cutoffInput?.addEventListener('change', () => {
    if (beforeAfterEl) {
      beforeAfterEl.innerHTML = renderBeforeAfterSummary(dailyTrend, cutoffInput.value);
    }
  });

  if (canEditInBuilder) {
    $('#btn-cal-edit-trial')?.addEventListener('click', () => {
      closeConsoleModal();
      const targetMeta = getRealmMeta(trial.realmId);
      const targetEraId = trial.eraId || targetMeta.era?.id || state.selectedEraId;
      const targetRealmId = trial.realmId || targetMeta.realm?.id || state.selectedRealmId;
      if (targetEraId) state.selectedEraId = targetEraId;
      if (targetRealmId) state.selectedRealmId = targetRealmId;
      state.selectedTrialId = trial.trialId;
      renderEraRealmTree();
      renderRealmEditor();
      if (state.activateTabFn) {
        state.activateTabFn('story');
      }
      setTimeout(() => {
        $('#trial-editor-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    });
  }
}

async function loadTrialCalibration() {
  if (!canAccessCalibration()) return;
  const seq = ++state.calReqSeq;
  state.calLoading = true;
  renderCalibrationTable();
  try {
    const data = await apiFetch(getCalibrationEndpoint('json'));
    if (seq !== state.calReqSeq) return;
    state.calData = data;
    state.calLoadedOnce = true;
    renderCalibrationKpis();
    renderCalibrationTable();
  } catch (err) {
    if (seq !== state.calReqSeq) return;
    state.calData = null;
    renderCalibrationKpis();
    const tbody = $('#cal-metrics-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Could not load calibration metrics: ${escapeHtml(err.message)}</div></td></tr>`;
    }
    const countPill = $('#cal-table-count-pill');
    if (countPill) countPill.textContent = '0 trials';
    showToast(`Calibration load failed: ${err.message}`, true);
  } finally {
    if (seq === state.calReqSeq) {
      state.calLoading = false;
    }
  }
}

async function exportTrialCalibrationCsv() {
  if (!canAccessCalibration()) return;
  const btn = $('#btn-cal-export-csv');
  if (btn) btn.disabled = true;
  try {
    const isLocal = state.mode !== 'cloudflare';
    const passcode = isLocal ? sessionStorage.getItem(PASSCODE_STORAGE_KEY) || '' : '';
    const headers = passcode ? { 'X-Builder-Passcode': passcode } : {};
    const res = await fetch(getCalibrationEndpoint('csv'), { cache: 'no-store', headers });
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
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pyria-trial-metrics.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(
      state.calFilters.flag && state.calFilters.flag !== 'all'
        ? 'Exported pyria-trial-metrics.csv (includes all flag statuses for current server filters)'
        : 'Exported pyria-trial-metrics.csv'
    );
  } catch (err) {
    showToast(`CSV export failed: ${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function wireCalibrationEvents() {
  const onServerFilterChange = () => {
    loadTrialCalibration();
  };

  $('#cal-filter-era')?.addEventListener('change', (e) => {
    state.calFilters.eraId = e.target.value || '';
    state.calFilters.realmId = '';
    populateCalibrationEraRealmFilters();
    onServerFilterChange();
  });
  $('#cal-filter-realm')?.addEventListener('change', (e) => {
    state.calFilters.realmId = e.target.value || '';
    onServerFilterChange();
  });
  $('#cal-filter-type')?.addEventListener('change', (e) => {
    state.calFilters.trialType = e.target.value || '';
    onServerFilterChange();
  });
  $('#cal-filter-difficulty')?.addEventListener('change', (e) => {
    state.calFilters.difficulty = e.target.value || 'all';
    onServerFilterChange();
  });
  $('#cal-filter-days')?.addEventListener('change', (e) => {
    state.calFilters.days = e.target.value || '30';
    onServerFilterChange();
  });
  $('#cal-filter-since')?.addEventListener('change', (e) => {
    state.calFilters.since = e.target.value || '';
    onServerFilterChange();
  });
  $('#cal-filter-practice')?.addEventListener('change', (e) => {
    state.calFilters.includePractice = Boolean(e.target.checked);
    onServerFilterChange();
  });
  $('#cal-filter-flag')?.addEventListener('change', (e) => {
    state.calFilters.flag = e.target.value || 'all';
    renderCalibrationTable();
  });
  $('#btn-cal-refresh')?.addEventListener('click', () => {
    loadTrialCalibration();
  });
  $('#btn-cal-export-csv')?.addEventListener('click', () => {
    exportTrialCalibrationCsv();
  });

  document.querySelectorAll('.cal-sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.calSort;
      if (!col) return;
      if (state.calSortBy === col) {
        state.calSortDir = state.calSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.calSortBy = col;
        state.calSortDir = col === 'title' || col === 'flag' ? 'asc' : 'desc';
      }
      renderCalibrationTable();
    });
  });
}

// ==================== WIRE UI EVENTS ====================
function wireEvents() {
  // Tabs (sticky across refreshes via URL hash + localStorage)
  const VALID_TABS = new Set(['live', 'calibration', 'story', 'health', 'assets']);
  const normalizeTab = (t) => (t === 'progress' ? 'live' : VALID_TABS.has(t) ? t : 'live');
  const isTabAllowed = (tab) => {
    if (state.mode !== 'cloudflare') return VALID_TABS.has(tab);
    if (!state.isParentAuthenticated) return false;
    if (tab === 'live') return true;
    if (tab === 'calibration') return Boolean(state.isAdmin);
    return false;
  };
  const activateTab = (target, { updateUrl = true } = {}) => {
    const requested = normalizeTab(target);
    const tab = isTabAllowed(requested) ? requested : 'live';
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tab}`);
    });
    if (tab === 'assets' && state.mode !== 'cloudflare') {
      const iframe = $('#assets-iframe');
      if (iframe && !iframe.getAttribute('src')) {
        iframe.src = '/assets/world/preview.html';
      }
    }
    if (tab === 'calibration' && state.bootstrapped && canAccessCalibration() && !state.calLoading && !state.calLoadedOnce) {
      loadTrialCalibration();
    }
    try {
      localStorage.setItem('pyria_builder_tab', tab);
    } catch {
      // ignore storage errors
    }
    if (updateUrl && window.location.hash !== `#${tab}`) {
      history.replaceState(null, '', `#${tab}`);
    }
  };
  state.activateTabFn = activateTab;

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
    if ($('#tab-calibration')?.classList.contains('active') && canAccessCalibration()) {
      loadTrialCalibration();
    }
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
    if (state.mode === 'cloudflare') {
      loadProgressFull().catch((err) => showToast(err.message, true));
    } else {
      renderHeroCards();
      renderActivityStream();
      refreshRealmTracker();
    }
  });

  // Console hero actions & sign-out
  $('#btn-console-add-hero')?.addEventListener('click', openAddChildHeroModal);
  $('#btn-console-claim-hero')?.addEventListener('click', openClaimHeroModal);
  $('#btn-console-signout')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ scope: 'parent' }),
      });
    } catch {
      // ignore
    }
    window.location.href = '/console';
  });

  // Console modal backdrop & Escape key
  $('#console-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === $('#console-modal-backdrop')) closeConsoleModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#console-modal-backdrop')?.classList.contains('hidden')) {
      closeConsoleModal();
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

function showCloudflareSignInScreen() {
  closeConsoleModal();
  $('#console-signin-panel')?.classList.remove('hidden');
  $('#builder-tab-nav')?.classList.add('hidden');
  $('#tab-live')?.classList.remove('active');
  $('#tab-live')?.classList.add('hidden');
  $('#tab-calibration')?.classList.remove('active');
  $('#tab-calibration')?.classList.add('hidden');
  $('#builder-admin-pill')?.classList.add('hidden');
  $('#live-indicator')?.classList.add('hidden');
  $('#btn-toggle-live')?.classList.add('hidden');
  $('#btn-refresh-now')?.classList.add('hidden');
  $('#btn-console-signout')?.classList.add('hidden');

  const signInBtn = $('#btn-google-signin');
  const disabledMsg = $('#console-oauth-disabled-msg');
  if (state.googleOAuthEnabled === false) {
    signInBtn?.classList.add('hidden');
    disabledMsg?.classList.remove('hidden');
  } else {
    signInBtn?.classList.remove('hidden');
    disabledMsg?.classList.add('hidden');
  }
}

function configureConsoleMode() {
  const isCloudflare = state.mode === 'cloudflare';
  if (!isCloudflare) {
    $('#console-signin-panel')?.classList.add('hidden');
    $('#console-hero-actions')?.classList.add('hidden');
    $('#local-global-diff-controls')?.classList.remove('hidden');
    $('#account-filter-group')?.classList.remove('hidden');
    $('#builder-tab-nav')?.classList.remove('hidden');
    document.querySelectorAll('#builder-tab-nav .tab-btn').forEach((b) => b.classList.remove('hidden'));
    $('#tab-calibration')?.classList.remove('hidden');
    $('#btn-console-signout')?.classList.add('hidden');
    return;
  }

  // Cloudflare Production Mode: Parent / Admin Console only (hide local authoring tabs)
  const titleEl = $('#topbar-title');
  const subEl = $('#topbar-sub');
  if (titleEl) {
    titleEl.textContent = state.isAdmin ? 'Pyria Admin Console' : 'Pyria Parent Console';
  }
  if (subEl) {
    subEl.textContent = state.isAdmin
      ? 'Global hero progress, trial calibration, account management & Hero Codes'
      : 'Real-time child progress, Hero Codes & learning settings';
  }
  document.title = state.isAdmin ? 'Pyria Admin Console' : 'Pyria Parent Console';

  $('#passcode-bar')?.classList.add('hidden');
  $('#tab-story')?.classList.add('hidden');
  $('#tab-health')?.classList.add('hidden');
  $('#tab-assets')?.classList.add('hidden');
  $('#local-global-diff-controls')?.classList.add('hidden');
  $('#parent-controls-status')?.classList.add('hidden');

  if (!state.isParentAuthenticated) {
    showCloudflareSignInScreen();
    return;
  }

  $('#console-signin-panel')?.classList.add('hidden');
  $('#tab-live')?.classList.remove('hidden');
  $('#console-hero-actions')?.classList.remove('hidden');
  $('#btn-console-signout')?.classList.remove('hidden');
  $('#account-filter-group')?.classList.toggle('hidden', !state.isAdmin);

  if (state.isAdmin) {
    // Admin in Cloudflare mode gets Live Progress + Trial Calibration tabs only
    $('#builder-tab-nav')?.classList.remove('hidden');
    document.querySelectorAll('#builder-tab-nav .tab-btn').forEach((b) => {
      const allowed = b.dataset.tab === 'live' || b.dataset.tab === 'calibration';
      b.classList.toggle('hidden', !allowed);
    });
    $('#tab-calibration')?.classList.remove('hidden');
    const hashTab = window.location.hash.replace(/^#/, '');
    let savedTab = null;
    try {
      savedTab = localStorage.getItem('pyria_builder_tab');
    } catch {
      savedTab = null;
    }
    const preferred = hashTab || savedTab || 'live';
    if (state.activateTabFn) {
      state.activateTabFn(preferred, { updateUrl: false });
    }
  } else {
    // Non-admin parents NEVER see Trial Calibration or tab nav
    $('#builder-tab-nav')?.classList.add('hidden');
    $('#tab-btn-calibration')?.classList.add('hidden');
    $('#tab-calibration')?.classList.remove('active');
    $('#tab-calibration')?.classList.add('hidden');
    if (state.activateTabFn) {
      state.activateTabFn('live', { updateUrl: false });
    } else {
      $('#tab-live')?.classList.add('active');
    }
  }
}

// ==================== BOOTSTRAP ====================
async function init() {
  const isConsolePath = /^\/(console|admin)(\/|$)/i.test(window.location.pathname);
  if (isConsolePath) {
    state.mode = 'cloudflare';
    state.isParentAuthenticated = false;
  }
  wireEvents();
  wireTrackerEvents();
  wireCalibrationEvents();
  try {
    const meRes = await fetch('/api/me', { cache: 'no-store' });
    if (meRes.ok) {
      const me = await meRes.json();
      state.me = me;
      state.mode = me?.mode === 'cloudflare' ? 'cloudflare' : 'local';
      const auth = me?.auth && typeof me.auth === 'object' ? me.auth : {};
      state.isAdmin = Boolean(auth.isAdmin ?? me?.isAdmin);
      state.parentEmail = auth.parentEmail ?? me?.email ?? null;
      state.googleOAuthEnabled =
        typeof auth.googleOAuthEnabled === 'boolean' ? auth.googleOAuthEnabled : true;
      const role = auth.role || (state.isAdmin ? 'admin' : state.parentEmail ? 'parent' : 'guest');
      state.isParentAuthenticated = role === 'parent' || role === 'admin';

      const adminPill = $('#builder-admin-pill');
      if (adminPill && state.parentEmail) {
        adminPill.textContent = state.isAdmin
          ? `🛡️ ${state.parentEmail}`
          : `👤 ${state.parentEmail}`;
        adminPill.className = `pill ${state.isAdmin ? 'pill-gold' : 'pill-blue'}`;
        adminPill.classList.remove('hidden');
      }
    } else if (isConsolePath) {
      state.mode = 'cloudflare';
      state.isParentAuthenticated = false;
    }
  } catch {
    if (isConsolePath) {
      state.mode = 'cloudflare';
      state.isParentAuthenticated = false;
    }
  }

  state.bootstrapped = true;
  configureConsoleMode();

  if (state.mode === 'cloudflare' && !state.isParentAuthenticated) {
    return;
  }

  try {
    const initialLoads = [loadOverview(), loadProgressFull()];
    if (
      $('#tab-calibration')?.classList.contains('active') &&
      canAccessCalibration() &&
      !state.calLoading &&
      !state.calLoadedOnce
    ) {
      initialLoads.push(loadTrialCalibration());
    }
    await Promise.all(initialLoads);
  } catch (err) {
    console.warn('Initial builder load error:', err.message);
  }
  setLivePolling(true);
}

init();
