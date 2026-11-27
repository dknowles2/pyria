// Interactive Modals: NPC Dialogue, Chest Pickup, Python Trial, Bram's Workshop, Dragon Rescue

import { audio } from './audio.js?v=20261127i';
import { music } from './music.js?v=20261127i';
import { pyRunner } from './pyRunner.js?v=20261127j';
import {
  attachAutocomplete,
  buildTrialSuggestions,
  buildWorkshopSuggestions,
} from './autocomplete.js?v=20261127i';
import { renderQrSvg } from './qr.js?v=20261127n';

function sanitizeAttemptErrorType(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned || null;
}

const VALID_DIFFICULTY_MODES = new Set(['explorer', 'standard', 'challenge']);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderSafeMarkdown(str) {
  const escaped = escapeHtml(str);
  return escaped.replace(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g, (_, code, bold) => {
    if (code !== undefined) return `<code class="inline-md-code">${code}</code>`;
    return `<strong>${bold}</strong>`;
  });
}

function objectiveHasCodeSpoilers(objective) {
  const text = String(objective || '');
  if (!text) return false;
  return (
    /`[^`]*[(=:[\]+][^`]*`/.test(text) ||
    /\bLine\s+\d+\s*:/i.test(text) ||
    /\b(say|shout|print|def|for|while|if|elif|else|class)\s*\(/.test(text) ||
    /`(say|shout|print|def|for|while|if|elif|else|class|return)\b/.test(text)
  );
}

function buildChallengeObjectiveHtml(trial) {
  if (trial.challengeObjective) {
    return renderSafeMarkdown(trial.challengeObjective);
  }
  const raw = String(trial.objective || '');
  if (!objectiveHasCodeSpoilers(raw)) {
    return renderSafeMarkdown(raw);
  }
  const story = String(trial.storyPrompt || '');
  const quoted = [...raw.matchAll(/["']([^"'\n]{2,60})["']/g)]
    .map((m) => m[1])
    .filter((s) => !story.includes(s));
  const uniqueTargets = [...new Set(quoted)].slice(0, 4);
  const targetNote =
    uniqueTargets.length > 0
      ? ` Target text: ${uniqueTargets.map((t) => `<code class="inline-md-code">${escapeHtml(t)}</code>`).join(', ')}.`
      : '';
  return `Solve the story quest above using your Python skills — code hints are hidden in Challenge Mode!${targetNote}`;
}

const BASE_QUICK_KEYS = [
  { label: '⇥ Indent', insert: '    ', cursorOffset: 4 },
  { label: '( )', insert: '()', cursorOffset: 1 },
  { label: '" "', insert: '""', cursorOffset: 1 },
  { label: ':', insert: ':', cursorOffset: 1 },
  { label: '=', insert: ' = ', cursorOffset: 3 },
  { label: '==', insert: ' == ', cursorOffset: 4 },
  { label: '_', insert: '_', cursorOffset: 1 },
  { label: '+', insert: ' + ', cursorOffset: 3 },
  { label: '-', insert: ' - ', cursorOffset: 3 },
  { label: '*', insert: ' * ', cursorOffset: 3 },
];

function getQuickKeysForContext({ useTrainingSpells = false } = {}) {
  if (useTrainingSpells) {
    return [
      ...BASE_QUICK_KEYS,
      { label: 'say()', insert: 'say()', cursorOffset: 4 },
      { label: 'shout()', insert: 'shout()', cursorOffset: 6 },
    ];
  }
  return [
    ...BASE_QUICK_KEYS,
    { label: 'print()', insert: 'print()', cursorOffset: 6 },
  ];
}

function renderQuickKeysHtml(id, keys) {
  return `
    <div id="${id}" class="py-quick-keys" aria-label="Python Quick Keys">
      ${keys.map(
        (k, idx) => `<button type="button" class="py-qk-btn" data-qk-idx="${idx}">${escapeHtml(k.label)}</button>`
      ).join('')}
    </div>
  `;
}

function wireQuickKeysBar(barEl, textarea, keys) {
  if (!barEl || !textarea) return;
  barEl.querySelectorAll('.py-qk-btn').forEach((btn) => {
    const insertKey = (e) => {
      e.preventDefault();
      const spec = keys[Number(btn.dataset.qkIdx)];
      if (!spec) return;
      textarea.focus();
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      const val = textarea.value;
      textarea.value = val.slice(0, start) + spec.insert + val.slice(end);
      const nextPos = start + spec.cursorOffset;
      textarea.selectionStart = textarea.selectionEnd = nextPos;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };
    btn.addEventListener('pointerdown', insertKey);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

export function attachCodeEditorKeys(textarea, onRun) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;
      textarea.value = val.substring(0, start) + '    ' + val.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 4;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const currentLine = val.substring(lineStart, start);
      const leadingSpaces = (currentLine.match(/^ */) || [''])[0];
      const trimmed = currentLine.trim();
      const extraIndent = trimmed.endsWith(':') && !trimmed.startsWith('#') ? '    ' : '';
      const nextIndent = leadingSpaces + extraIndent;
      if (nextIndent.length > 0) {
        e.preventDefault();
        const insert = '\n' + nextIndent;
        textarea.value = val.substring(0, start) + insert + val.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + insert.length;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (onRun) onRun();
    }
  });
}

export function attachCodeGutter(textarea, gutterEl, highlightsEl) {
  if (!textarea || !gutterEl || !highlightsEl) {
    return { setMarks: () => {}, update: () => {}, scrollToLine: () => {} };
  }
  let lineMarks = new Map();

  const syncScroll = () => {
    gutterEl.scrollTop = textarea.scrollTop;
    highlightsEl.scrollTop = textarea.scrollTop;
  };

  const render = () => {
    const lines = String(textarea.value || '').split('\n');
    let maxMarked = 0;
    for (const ln of lineMarks.keys()) {
      if (Number(ln) > maxMarked) maxMarked = Number(ln);
    }
    const count = Math.max(lines.length, maxMarked, 6);
    const gutterHtml = [];
    const hlHtml = [];
    for (let i = 1; i <= count; i += 1) {
      const mark = lineMarks.get(i);
      const cls = mark ? ` ${mark.kind}` : '';
      const numLabel = mark?.icon ? `${mark.icon}${i}` : String(i);
      gutterHtml.push(`<div class="code-gutter-line${cls}">${escapeHtml(numLabel)}</div>`);
      const badge = mark?.badge ? `<span class="code-hl-badge">${escapeHtml(mark.badge)}</span>` : '';
      hlHtml.push(`<div class="code-hl-line${cls}">${badge}</div>`);
    }
    gutterEl.innerHTML = gutterHtml.join('');
    highlightsEl.innerHTML = hlHtml.join('');
    syncScroll();
  };

  const scrollToLine = (lineNum) => {
    const n = Number(lineNum);
    if (!n || n < 1) return;
    const targetTop = Math.max(0, (n - 3) * 22);
    if (textarea.scrollHeight > textarea.clientHeight) {
      textarea.scrollTop = targetTop;
      syncScroll();
    }
  };

  textarea.addEventListener('input', render);
  textarea.addEventListener('scroll', syncScroll);
  render();

  return {
    setMarks(marksMap) {
      lineMarks = marksMap instanceof Map ? marksMap : new Map();
      render();
    },
    update: render,
    scrollToLine,
  };
}

export function resolveDifficulty(gameConfig, realm, trial, save = null) {
  const base = {
    mode: 'standard',
    showRawTracebacks: false,
    maxHintsAllowed: 3,
  };
  const merged = {
    ...base,
    ...(gameConfig?.globalDifficultyOverride || {}),
    ...(realm?.difficultyOverride || {}),
    ...(trial?.difficultyOverride || {}),
  };
  const cfgPrefs =
    gameConfig?.heroPreferences && typeof gameConfig.heroPreferences === 'object'
      ? gameConfig.heroPreferences
      : {};
  const savePrefs =
    save?.preferences && typeof save.preferences === 'object' ? save.preferences : {};
  const prefs = { ...cfgPrefs, ...savePrefs };
  if (prefs.difficulty === 'explorer' || prefs.difficulty === 'standard' || prefs.difficulty === 'challenge') {
    merged.mode = prefs.difficulty;
  }
  if (typeof prefs.showRawTracebacks === 'boolean') {
    merged.showRawTracebacks = prefs.showRawTracebacks;
  }
  if (
    prefs.maxPipHints !== null &&
    prefs.maxPipHints !== undefined &&
    Number.isFinite(Number(prefs.maxPipHints))
  ) {
    merged.maxHintsAllowed = Math.max(0, Math.min(3, Number(prefs.maxPipHints)));
  }
  return merged;
}

export class ModalManager {
  constructor(backdropEl, contentEl, { sprites, onPauseChange }) {
    this.backdrop = backdropEl;
    this.content = contentEl;
    this.sprites = sprites;
    this.onPauseChange = onPauseChange;
    this.cleanupFns = [];
    this.allowBackdropClose = true;

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop && this.allowBackdropClose) {
        this.close();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.backdrop.classList.contains('hidden') && this.allowBackdropClose) {
        e.preventDefault();
        this.close();
      }
    });
  }

  isOpen() {
    return !this.backdrop.classList.contains('hidden');
  }

  open(html, sizeClass = '', { allowBackdropClose = true } = {}) {
    this.runCleanups();
    this.allowBackdropClose = allowBackdropClose;
    this.content.className = `modal-card ${sizeClass}`.trim();
    this.content.innerHTML = html;
    this.backdrop.classList.remove('hidden');
    if (this.onPauseChange) this.onPauseChange(true);
  }

  close() {
    this.runCleanups();
    this.allowBackdropClose = true;
    this.backdrop.classList.add('hidden');
    this.content.innerHTML = '';
    music.setDucked(false);
    if (this.onPauseChange) this.onPauseChange(false);
  }

  addCleanup(fn) {
    this.cleanupFns.push(fn);
  }

  runCleanups() {
    while (this.cleanupFns.length) {
      try {
        this.cleanupFns.pop()();
      } catch {
        // ignore
      }
    }
  }

  // ==================== NPC DIALOGUE MODAL ====================
  openNpcDialogue({ npc, spriteKey, message, eraKey, extraAction }) {
    audio.playClick();
    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>${escapeHtml(npc.name)}</h2>
          <div class="modal-badges">
            <span class="pill pill-blue">${escapeHtml(npc.role)}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>
      <div class="dialogue-box">
        <canvas id="modal-npc-canvas" width="48" height="48" class="pixel-canvas npc-portrait-canvas"></canvas>
        <div>
          <p class="dialogue-text">${escapeHtml(message)}</p>
          <p class="dialogue-catchphrase">"${escapeHtml(npc.catchphrase)}"</p>
        </div>
      </div>
      <div class="modal-footer">
        ${extraAction ? `<button id="modal-extra-action" class="btn btn-gold">${escapeHtml(extraAction.label)}</button>` : ''}
        <button class="btn btn-primary" data-close>Got it!</button>
      </div>
      `,
      'modal-compact'
    );

    const npcCanvas = this.content.querySelector('#modal-npc-canvas');
    if (npcCanvas) {
      const ctx = npcCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      this.sprites.drawNpc(ctx, spriteKey, eraKey, 4, 4, 40, 40);
    }

    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    if (extraAction) {
      const extraBtn = this.content.querySelector('#modal-extra-action');
      extraBtn?.addEventListener('click', () => {
        this.close();
        extraAction.onClick();
      });
    }
  }

  // ==================== CHEST PICKUP MODAL ====================
  openChestModal({ label, shardReward, totalShards }) {
    audio.playChest();
    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>✦ Treasure Chest Opened!</h2>
          <div class="modal-badges">
            <span class="pill pill-gold">${escapeHtml(label)}</span>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>
      <div class="dragon-rescue-banner">
        <p class="dialogue-text">
          You found <strong style="color: var(--accent-gold);">+${Number(shardReward) || 0} Byte Shards</strong>!
        </p>
        <p class="muted-text">You now have <strong>${Number(totalShards) || 0} Byte Shards</strong> to spend at Bram's Workshop.</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" data-close>Awesome!</button>
      </div>
      `,
      'modal-compact'
    );

    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const dismissBtn = this.content.querySelector('.modal-footer [data-close]');
    dismissBtn?.focus();
  }

  // ==================== EASTER EGG DISCOVERY MODAL ====================
  openEasterEggModal({ entity, alreadyFound, shardReward, totalEggs, bonusHints }) {
    audio.playSecretFound();
    const toNextHint = totalEggs % 2 === 1 ? 1 : 2;
    const hintLine =
      !alreadyFound && totalEggs % 2 === 0
        ? '✨ You discovered 2 Easter Eggs and unlocked <strong>+1 Bonus Hint</strong>!'
        : `Find <strong>${toNextHint} more</strong> Easter Egg${toNextHint === 1 ? '' : 's'} to earn your next Bonus Hint! (Current Bonus Hints: <strong>${bonusHints}</strong>)`;

    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>✨ Secret Easter Egg Found!</h2>
          <div class="modal-badges">
            <span class="pill pill-violet">✦ Hidden Secret</span>
            ${alreadyFound ? '<span class="pill pill-green">✓ Discovered</span>' : `<span class="pill pill-gold">+${shardReward} Byte Shards</span>`}
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>
      <div class="kit-reward-card">
        <h3 style="margin:0; color:var(--accent-gold);">${escapeHtml(entity.title || entity.label)}</h3>
        <p class="dialogue-text">${escapeHtml(entity.message || 'You found a hidden secret of Pyria!')}</p>
        <p class="muted-text" style="margin:0;">${hintLine}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" data-close>Awesome!</button>
      </div>
      `,
      'modal-compact'
    );

    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }

  // ==================== PYTHON TRIAL MODAL ====================
  openTrialModal({
    trial,
    realm,
    era,
    gameConfig,
    catalog,
    save,
    alreadySolved,
    unlockNote,
    bonusHints = 0,
    onEquipKitReward,
    savedDraft,
    onDraftChange,
    onDraftFlush,
    onDraftClear,
    onSolved,
    onAttempt,
  }) {
    audio.playClick();
    music.setDucked(true);
    const diff = resolveDifficulty(gameConfig, realm, trial, save);
    let currentMode = VALID_DIFFICULTY_MODES.has(diff.mode) ? diff.mode : 'standard';
    let hintsUsed = 0;
    let failedAttempts = 0;
    const CHALLENGE_BONUS_SHARDS = 10;
    let trialOpenedAt = Date.now();
    const baseMaxHints = diff.maxHintsAllowed ?? 3;
    const getEffectiveMaxHints = () =>
      currentMode === 'challenge'
        ? Math.min(1, baseMaxHints)
        : Math.min(4, baseMaxHints + (bonusHints > 0 ? bonusHints : 0));
    const maxHints = getEffectiveMaxHints();

    const getHintGateMessage = (nextTierNum, isMc) => {
      if (nextTierNum === 2 && failedAttempts < 1) {
        return isMc
          ? 'Chirp! Try picking an answer first! Make at least <strong>1 attempt</strong> before unlocking <strong>Tier 2: Code Pattern</strong> — guessing and checking helps your brain grow!'
          : 'Chirp! Give your spell a try first! Press <strong>▶ Run Python Spell</strong> at least once before unlocking <strong>Tier 2: Code Pattern</strong> — making mistakes is how Code-Tamers learn!';
      }
      if (nextTierNum >= 3 && failedAttempts < 2) {
        const remaining = 2 - failedAttempts;
        return isMc
          ? `Almost! Try <strong>${remaining} more answer${remaining === 1 ? '' : 's'}</strong> (2 attempts total) before unlocking <strong>Tier ${nextTierNum}</strong>. You've got this!`
          : `Almost! Try running your spell <strong>${remaining} more time${remaining === 1 ? '' : 's'}</strong> (2 attempts total) before unlocking <strong>Tier ${nextTierNum}</strong>. You've got this!`;
      }
      return null;
    };

    const isTrialSolvedInSave = () =>
      Boolean(
        (Array.isArray(save?.solvedTrials) && save.solvedTrials.includes(trial.id)) ||
          (Array.isArray(save?.completedTrials) && save.completedTrials.includes(trial.id))
      );

    const computeDurationMs = () =>
      Math.max(0, Math.min(86400000, Math.round(Date.now() - trialOpenedAt)));

    const buildTier4SecretHint = () => {
      if (trial.trialType === 'multiple_choice') {
        const right = (trial.choices || []).find((c) => c.id === trial.correctChoiceId);
        return right
          ? `Secret Answer: "${right.label}" — ${right.explanation || ''}`
          : 'Look closely at the exact Python syntax in each choice!';
      }
      return `Pip's Secret Solution Guide:\n${trial.referenceSolution || ''}`;
    };

    const hintTiers = [
      { key: 'tier1_nudge', label: 'Tier 1: Gentle Nudge' },
      { key: 'tier2_pattern', label: 'Tier 2: Code Pattern' },
      { key: 'tier3_walkthrough', label: 'Tier 3: Step-by-Step' },
      { key: 'tier4_secret', label: "Tier 4: 🌟 Pip's Secret Solution Guide", customText: buildTier4SecretHint() },
    ];

    const unlockItem = trial.unlockId
      ? (catalog.unlockables || []).find((u) => u.id === trial.unlockId)
      : null;

    const conceptLabels = (trial.concepts || []).map((cid) => {
      const found = (gameConfig.conceptProgression || []).find((c) => c.id === cid);
      return found ? found.label : cid;
    });

    const hasIntroChoice = Boolean(
      trial.trialType !== 'multiple_choice' &&
        trial.introChoice &&
        Array.isArray(trial.introChoice.choices) &&
        trial.introChoice.choices.length > 0
    );

    const hasExistingDraft = (() => {
      if (!trial.starterCode || typeof savedDraft !== 'string' || !savedDraft.trim()) return false;
      const starterText = trial.starterCode[currentMode] || trial.starterCode.standard || '';
      return savedDraft !== starterText;
    })();

    const renderCompletedSummary = () => {
      const useTrainingSpells = era?.id === 'era-01-8bit' && (Number(realm?.number) || 1) <= 3;
      const trialQuickKeys = getQuickKeysForContext({ useTrainingSpells });

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>✓ ${escapeHtml(trial.title)}</h2>
            <div class="modal-badges">
              <span class="pill pill-green">✓ COMPLETED</span>
              <span class="pill pill-blue">${escapeHtml(realm.name)}</span>
              ${bonusHints > 0 ? `<span class="pill pill-violet">✨ +${bonusHints} Bonus Hint${bonusHints === 1 ? '' : 's'}</span>` : ''}
              ${conceptLabels.map((l) => `<span class="pill pill-muted">${escapeHtml(l)}</span>`).join('')}
            </div>
          </div>
          <button class="btn btn-sm btn-ghost" data-close>✕</button>
        </div>

        <div class="trial-complete-card">
          <div class="trial-complete-icon">✓</div>
          <h3 class="trial-complete-title">Trial Already Mastered!</h3>
          <p class="dialogue-text">
            You've already mastered this Trial and claimed its <strong>${trial.shardReward} Byte Shards</strong>!
          </p>
          <p class="muted-text" style="margin:0;">
            <strong>Objective:</strong> ${renderSafeMarkdown(trial.objective)}
          </p>
        </div>

        <div class="modal-footer">
          <button id="btn-trial-practice" class="btn btn-ghost">Practice Again (No Extra Shards)</button>
          <button class="btn btn-primary" data-close>Close</button>
        </div>
        `,
        'modal-compact'
      );

      this.content.querySelectorAll('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.close());
      });
      this.content.querySelector('#btn-trial-practice')?.addEventListener('click', () => {
        audio.playClick();
        trialOpenedAt = Date.now();
        if (trial.trialType === 'multiple_choice') {
          renderMultipleChoiceView(true);
        } else if (hasIntroChoice) {
          renderIntroChoiceView(true);
        } else {
          renderEditorView(true);
        }
      });
    };

    const renderCelebrationView = ({ stdout, explanation, isPractice, solvedInChallenge = false }) => {
      const kit = trial.isBonus && trial.bonusKitReward && !isPractice ? trial.bonusKitReward : null;
      const canEquipKit = Boolean(kit && kit.equipLayer && kit.equipKey);
      const totalAwardedShards = (Number(trial.shardReward) || 0) + (solvedInChallenge ? CHALLENGE_BONUS_SHARDS : 0);

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>✓ ${escapeHtml(trial.title)}</h2>
            <div class="modal-badges">
              <span class="pill pill-green">${isPractice ? '✓ PRACTICE COMPLETE' : trial.isBonus ? '✦ BONUS TRIAL COMPLETE' : '✓ TRIAL COMPLETE'}</span>
              ${solvedInChallenge ? `<span class="pill pill-violet">🏆 CHALLENGE MASTERED (+${CHALLENGE_BONUS_SHARDS} Bonus 💎)</span>` : ''}
              <span class="pill pill-blue">${escapeHtml(realm.name)}</span>
            </div>
          </div>
          <button class="btn btn-sm btn-ghost" data-close>✕</button>
        </div>

        <div class="trial-complete-card">
          <div class="trial-complete-icon">${solvedInChallenge ? '🏆' : '✓'}</div>
          <h3 class="trial-complete-title">${isPractice ? 'Great Practice Run!' : solvedInChallenge ? '🏆 Challenge Mode Mastered!' : trial.isBonus ? '🌟 Hidden Bonus Complete!' : '🎉 Trial Complete!'}</h3>
          <p class="dialogue-text">
            ${
              isPractice
                ? 'Chirp! Spot-on answer again! (Byte Shards were already claimed for this Trial.)'
                : solvedInChallenge
                  ? `Chirp! Pip does a double backflip! You conquered Challenge Mode and earned <strong style="color: var(--accent-gold);">+${totalAwardedShards} Byte Shards</strong> (including <strong>+${CHALLENGE_BONUS_SHARDS} Challenge Bonus</strong>)!`
                  : `Chirp! Pip does a backflip! You earned <strong style="color: var(--accent-gold);">+${trial.shardReward} Byte Shards</strong> and saved your progress!`
            }
          </p>
          ${
            kit
              ? `
                <div class="kit-reward-card">
                  <div class="pill pill-violet">🎁 Personal Kit Reward Unlocked (FREE!)</div>
                  <strong style="font-size:16px; color:var(--accent-gold);">${escapeHtml(kit.name)}</strong>
                  <div class="muted-text" style="margin:0;">${renderSafeMarkdown(kit.description || '')}</div>
                  <div class="pill pill-gold">✨ +1 Bonus Hint Earned!</div>
                  ${canEquipKit ? `<button id="btn-equip-kit-now" type="button" class="btn btn-gold btn-sm">✨ Equip Now!</button>` : ''}
                </div>
              `
              : ''
          }
          ${explanation ? `<div class="objective-box" style="width:100%; text-align:left;"><strong>🐉 Pip explains:</strong> ${renderSafeMarkdown(explanation)}</div>` : ''}
          ${!isPractice && unlockNote ? `<div class="upgrade-callout" style="width:100%;">✨ ${renderSafeMarkdown(unlockNote)}</div>` : ''}
          ${!isPractice && unlockItem ? `<p class="muted-text" style="margin:0;">New blueprint ready in Bram's Workshop: <strong>${escapeHtml(unlockItem.name)}</strong> (<code>${escapeHtml(unlockItem.functionCall)}</code>)</p>` : ''}
          ${stdout ? `<div class="console-stdout" style="width:100%; text-align:left;">Output:\n${escapeHtml(stdout)}</div>` : ''}
        </div>

        <div class="modal-footer">
          <button class="btn btn-primary btn-lg" data-close>✦ Continue Exploring</button>
        </div>
        `,
        'modal-compact'
      );

      if (canEquipKit) {
        const equipBtn = this.content.querySelector('#btn-equip-kit-now');
        equipBtn?.addEventListener('click', () => {
          audio.playForge();
          if (onEquipKitReward) onEquipKitReward(kit);
          equipBtn.textContent = '✓ Equipped!';
          equipBtn.disabled = true;
        });
      }

      this.content.querySelectorAll('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.close());
      });
    };

    const renderMultipleChoiceView = (isPractice) => {
      const choices = Array.isArray(trial.choices) ? trial.choices : [];
      const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>${isPractice ? '✓ ' : '🧠 '}${escapeHtml(trial.title)}</h2>
            <div class="modal-badges">
              <span class="pill pill-violet">🧠 Predict &amp; Choose</span>
              <span class="pill pill-blue">${escapeHtml(realm.name)}</span>
              ${
                isPractice
                  ? '<span class="pill pill-green">✓ COMPLETED · Practice Mode (No Extra Shards)</span>'
                  : `<span class="pill pill-gold">+${trial.shardReward} Byte Shards</span>`
              }
              ${bonusHints > 0 ? `<span class="pill pill-violet">✨ +${bonusHints} Bonus Hint${bonusHints === 1 ? '' : 's'}</span>` : ''}
              ${conceptLabels.map((l) => `<span class="pill pill-muted">${escapeHtml(l)}</span>`).join('')}
            </div>
          </div>
          <button class="btn btn-sm btn-ghost" data-close>✕</button>
        </div>

        <p class="dialogue-text">${renderSafeMarkdown(trial.storyPrompt)}</p>

        <div class="objective-box">
          <strong>Question:</strong> ${renderSafeMarkdown(trial.objective)}
          ${unlockItem ? `<div class="muted-text">Unlocks in Bram's Workshop: <strong>${escapeHtml(unlockItem.name)}</strong> (<code>${escapeHtml(unlockItem.functionCall)}</code>)</div>` : ''}
        </div>

        ${trial.codeSnippet ? `<pre class="mc-code-snippet"><code>${escapeHtml(trial.codeSnippet)}</code></pre>` : ''}

        <div id="mc-choices-grid" class="mc-choices-grid">
          ${choices
            .map(
              (c, idx) => `
              <button type="button" class="mc-choice-card" data-choice-id="${escapeHtml(c.id)}">
                <span class="mc-letter">${letters[idx] || idx + 1}</span>
                <div class="mc-choice-body">
                  <div class="mc-choice-label">${escapeHtml(c.label)}</div>
                  ${c.code ? `<pre class="mc-choice-code">${escapeHtml(c.code)}</pre>` : ''}
                </div>
              </button>
            `
            )
            .join('')}
        </div>

        <div class="editor-actions">
          <button id="btn-trial-hint" class="btn btn-gold" ${maxHints === 0 ? 'disabled' : ''}>
            💡 Ask Pip (Hint 1/${maxHints})
          </button>
        </div>

        <div id="trial-hints-area" class="hidden"></div>

        <div id="trial-output" class="pip-console">
          <div class="pip-console-header">🐉 Pip says:</div>
          <div class="pip-console-body">Read the Python spell carefully and tap the answer you predict!</div>
        </div>
        `,
        'modal-wide'
      );

      const hintBtn = this.content.querySelector('#btn-trial-hint');
      const hintsArea = this.content.querySelector('#trial-hints-area');
      const outputEl = this.content.querySelector('#trial-output');

      hintBtn?.addEventListener('click', () => {
        const effMax = getEffectiveMaxHints();
        if (hintsUsed >= effMax) return;
        const gateMsg = getHintGateMessage(hintsUsed + 1, true);
        if (gateMsg) {
          audio.playClick();
          outputEl.className = 'pip-console';
          outputEl.innerHTML = `
            <div class="pip-console-header">🐉 Pip encourages you:</div>
            <div class="pip-console-body">${gateMsg}</div>
          `;
          return;
        }
        audio.playClick();
        hintsUsed += 1;
        hintsArea.classList.remove('hidden');

        const shown = hintTiers.slice(0, hintsUsed).map((t) => {
          const text = t.customText ?? trial.hints?.[t.key] ?? '';
          return `
            <div class="hint-box" style="margin-bottom:8px;">
              <div class="hint-box-title">🐉 ${escapeHtml(t.label)}</div>
              <div>${renderSafeMarkdown(text)}</div>
            </div>
          `;
        });
        hintsArea.innerHTML = shown.join('');

        if (hintsUsed >= effMax) {
          hintBtn.textContent = `💡 All ${effMax} Hint${effMax === 1 ? '' : 's'} Shown`;
          hintBtn.disabled = true;
        } else {
          hintBtn.textContent = `💡 Ask Pip (Hint ${hintsUsed + 1}/${effMax})`;
        }
      });

      let solvedInView = false;
      this.content.querySelectorAll('.mc-choice-card').forEach((card) => {
        card.addEventListener('click', async () => {
          if (solvedInView || card.classList.contains('wrong')) return;
          const choiceId = card.dataset.choiceId;
          const choice = choices.find((c) => c.id === choiceId);
          if (!choice) return;
          const isCorrect = choice.id === trial.correctChoiceId;
          const attemptIsPractice = Boolean(isPractice || alreadySolved || isTrialSolvedInSave());
          const difficultyMode = VALID_DIFFICULTY_MODES.has(currentMode) ? currentMode : 'standard';
          const errorType = isCorrect ? null : sanitizeAttemptErrorType(`choice:${choice.id}`);
          const durationMs = computeDurationMs();

          if (isCorrect) {
            solvedInView = true;
          }

          if (onAttempt) {
            onAttempt({
              trialId: trial.id,
              passed: isCorrect,
              hintsUsed,
              code: `choice:${choice.id} (${choice.label})`,
              difficultyMode,
              isPractice: attemptIsPractice,
              errorType,
              durationMs,
            });
          }

          if (isCorrect) {
            card.classList.add('correct');
            audio.playSuccess();
            if (onSolved) {
              await onSolved(trial);
            }
            renderCelebrationView({
              stdout: null,
              explanation: choice.explanation || '',
              isPractice,
            });
          } else {
            failedAttempts += 1;
            card.classList.add('wrong');
            audio.playError();
            outputEl.className = 'pip-console error';
            outputEl.innerHTML = `
              <div class="pip-console-header">🐉 Not quite — try another choice!</div>
              <div class="pip-console-body">${renderSafeMarkdown(choice.explanation || 'Look closely at each line of the Python spell and try again!')}</div>
            `;
          }
        });
      });

      this.content.querySelectorAll('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.close());
      });
    };

    const renderIntroChoiceView = (isPractice) => {
      const intro = trial.introChoice;
      const choices = Array.isArray(intro.choices) ? intro.choices : [];
      const letters = ['A', 'B', 'C', 'D'];
      const stepTitle = intro.title ? `${trial.title} — ${intro.title}` : trial.title;

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>${isPractice ? '✓ ' : '🧠 '}${escapeHtml(stepTitle)}</h2>
            <div class="modal-badges">
              <span class="pill pill-violet">🧠 Step 1 of 2: Learn It First!</span>
              <span class="pill pill-blue">${escapeHtml(realm.name)}</span>
              ${
                isPractice
                  ? '<span class="pill pill-green">✓ COMPLETED · Practice Mode</span>'
                  : `<span class="pill pill-gold">+${trial.shardReward} Byte Shards (after Step 2)</span>`
              }
              ${conceptLabels.map((l) => `<span class="pill pill-muted">${escapeHtml(l)}</span>`).join('')}
            </div>
          </div>
          <button class="btn btn-sm btn-ghost" data-close>✕</button>
        </div>

        <p class="dialogue-text">${renderSafeMarkdown(intro.prompt)}</p>

        <div class="objective-box">
          <strong>Quick Check (Step 1 of 2):</strong> ${renderSafeMarkdown(intro.question)}
        </div>

        ${intro.codeSnippet ? `<pre class="mc-code-snippet"><code>${escapeHtml(intro.codeSnippet)}</code></pre>` : ''}

        <div id="intro-choices-grid" class="mc-choices-grid">
          ${choices
            .map(
              (c, idx) => `
              <button type="button" class="mc-choice-card" data-choice-id="${escapeHtml(c.id)}">
                <span class="mc-letter">${letters[idx] || idx + 1}</span>
                <div class="mc-choice-body">
                  <div class="mc-choice-label">${escapeHtml(c.label)}</div>
                  ${c.code ? `<pre class="mc-choice-code">${escapeHtml(c.code)}</pre>` : ''}
                </div>
              </button>
            `
            )
            .join('')}
        </div>

        <div id="intro-output" class="pip-console">
          <div class="pip-console-header">🐉 Pip says:</div>
          <div class="pip-console-body">Pick the right answer first to unlock Step 2 and write your own Python spell!</div>
        </div>

        <div id="intro-continue-row" class="intro-continue-row hidden">
          <button id="btn-intro-continue" type="button" class="btn btn-primary btn-lg">⌨️ Now Try It Yourself! (Step 2 of 2) →</button>
        </div>
        `,
        'modal-wide'
      );

      const outputEl = this.content.querySelector('#intro-output');
      const continueRow = this.content.querySelector('#intro-continue-row');
      const continueBtn = this.content.querySelector('#btn-intro-continue');
      const cards = Array.from(this.content.querySelectorAll('.mc-choice-card'));

      cards.forEach((card) => {
        card.addEventListener('click', () => {
          const choiceId = card.dataset.choiceId;
          const choice = choices.find((c) => c.id === choiceId);
          if (!choice) return;
          const isCorrect = choice.id === intro.correctChoiceId;

          if (isCorrect) {
            card.classList.add('correct');
            cards.forEach((btn) => {
              btn.disabled = true;
            });
            audio.playSuccess();
            outputEl.className = 'pip-console success';
            outputEl.innerHTML = `
              <div class="pip-console-header">🐉 Spot on! You unlocked Step 2!</div>
              <div class="pip-console-body">${renderSafeMarkdown(choice.explanation || 'Great job! Now try writing it yourself!')}</div>
            `;
            continueRow.classList.remove('hidden');
            continueBtn?.focus();
          } else {
            card.classList.add('wrong');
            audio.playError();
            outputEl.className = 'pip-console error';
            outputEl.innerHTML = `
              <div class="pip-console-header">🐉 Not quite — try another choice!</div>
              <div class="pip-console-body">${renderSafeMarkdown(choice.explanation || 'Look closely at the Python example and try again!')}</div>
            `;
          }
        });
      });

      continueBtn?.addEventListener('click', () => {
        audio.playClick();
        renderEditorView(isPractice);
      });

      this.content.querySelectorAll('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.close());
      });
    };

    const renderEditorView = (isPractice) => {
      const starterText = trial.starterCode[currentMode] || trial.starterCode.standard || '';
      const hasRestoredDraft =
        !isPractice &&
        typeof savedDraft === 'string' &&
        savedDraft.trim().length > 0 &&
        savedDraft !== starterText;
      const initialCode = hasRestoredDraft ? savedDraft : starterText;
      let skipFlushOnClose = false;

      const useTrainingSpells = era?.id === 'era-01-8bit' && (Number(realm?.number) || 1) <= 3;
      const trialQuickKeys = getQuickKeysForContext({ useTrainingSpells });
      const isFixBug = trial.trialType === 'fix_bug';
      const hasHashComment = (code) => /^\s*#/m.test(code || '');
      const showCommentTip = (Number(realm?.number) || 1) <= 3 && hasHashComment(initialCode);
      const showIndentTip = (trial.concepts || []).some((c) =>
        /^(conditionals|for_loops|while_loops|nested_loops|functions|classes|class_|error_handling)/.test(c)
      );
      const ensureTrailingEditableLine = (code) => {
        if (!code) return '';
        const lines = code.split('\n');
        const last = lines[lines.length - 1];
        if (/^\s*#/.test(last)) return `${code}\n`;
        return code;
      };
      const editableInitialCode = ensureTrailingEditableLine(initialCode);

      const renderBugBannerBody = () => {
        if (currentMode === 'explorer' || failedAttempts >= 1) {
          return renderSafeMarkdown(
            trial.bugSummary || 'Lord Null sabotaged this spell — find and fix the bug, then run it!'
          );
        }
        return 'Lord Null sabotaged this spell! Read the code carefully, spot what is broken, and run your fix. <em>(A detailed bug clue unlocks after your first test run, or in Explorer mode.)</em>';
      };

      const renderObjectiveInnerHtml = () => {
        if (currentMode === 'challenge') {
          return `<strong>🏆 Challenge Goal:</strong> ${buildChallengeObjectiveHtml(trial)}`;
        }
        return `<strong>Objective:</strong> ${renderSafeMarkdown(trial.objective)}`;
      };

      const initialMaxHints = getEffectiveMaxHints();

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>${isPractice ? '✓ ' : isFixBug ? '🐛 ' : '★ '}${escapeHtml(trial.title)}</h2>
            <div class="modal-badges">
              ${hasIntroChoice ? '<span class="pill pill-green">✓ Step 1 Done · ⌨️ Step 2 of 2: Code It!</span>' : ''}
              ${isFixBug ? '<span class="pill pill-rose">🐛 Fix the Bug!</span>' : ''}
              <span class="pill pill-blue">${escapeHtml(realm.name)}</span>
              <span class="pill pill-violet" id="trial-diff-badge">Mode: ${escapeHtml(currentMode)}</span>
              ${
                isPractice
                  ? '<span class="pill pill-green">✓ COMPLETED · Practice Mode (No Extra Shards)</span>'
                  : `<span class="pill pill-gold">+${trial.shardReward} Byte Shards</span>`
              }
              <span id="trial-draft-badge" class="pill pill-gold ${hasRestoredDraft ? '' : 'hidden'}">💾 Restored your saved draft</span>
              ${bonusHints > 0 ? `<span class="pill pill-violet">✨ +${bonusHints} Bonus Hint${bonusHints === 1 ? '' : 's'}</span>` : ''}
              ${conceptLabels.map((l) => `<span class="pill pill-muted">${escapeHtml(l)}</span>`).join('')}
            </div>
          </div>
          <button class="btn btn-sm btn-ghost" data-close>✕</button>
        </div>

        <p class="dialogue-text">${renderSafeMarkdown(trial.storyPrompt)}</p>

        <div id="trial-challenge-banner" class="challenge-banner ${currentMode === 'challenge' ? '' : 'hidden'}">
          <span>🏆 <strong>Challenge Mode Active</strong> — Code spoilers hidden · Hints capped at Tier 1</span>
          <span class="pill pill-gold">+${CHALLENGE_BONUS_SHARDS} Bonus Shards &amp; 🏆 Badge</span>
        </div>

        <div class="objective-box">
          <div id="trial-objective-text">${renderObjectiveInnerHtml()}</div>
          ${unlockItem ? `<div class="muted-text">Unlocks in Bram's Workshop: <strong>${escapeHtml(unlockItem.name)}</strong> (<code>${escapeHtml(unlockItem.functionCall)}</code>)</div>` : ''}
        </div>

        ${
          isFixBug
            ? `
              <div id="trial-bug-banner" class="bug-banner">
                <div class="bug-banner-title">🐛 Fix the Bug!</div>
                <div id="trial-bug-summary">${renderBugBannerBody()}</div>
              </div>
            `
            : ''
        }

        <div id="trial-comment-tip" class="comment-tip-banner ${showCommentTip ? '' : 'hidden'}">
          <strong>💬 What are <code>#</code> lines?</strong>
          Lines starting with <code>#</code> are <strong>comments</strong> — helpful notes that Python completely ignores. Type your real Python code on a <strong>new line without <code>#</code></strong>!
        </div>

        ${
          showIndentTip
            ? `
              <div class="comment-tip-banner">
                <strong>📏 Golden Rule — Colons <code>:</code> &amp; Indentation:</strong>
                End every <code>if</code>, <code>elif</code>, <code>else</code>, <code>for</code>, or <code>def</code> line with a colon <code>:</code>, then indent the lines inside by <strong>4 spaces</strong> (tap <strong>⇥ Indent</strong> or press <strong>Enter</strong> right after <code>:</code>).
              </div>
            `
            : ''
        }

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span class="muted-text">Quick symbol buttons (tap to insert):</span>
          <div style="display:flex; gap:6px; align-items:center;">
            <span class="muted-text" style="font-size:12px;">Starter:</span>
            <button class="btn btn-sm btn-ghost" data-mode="explorer">Explorer</button>
            <button class="btn btn-sm btn-ghost" data-mode="standard">Standard</button>
            <button class="btn btn-sm btn-ghost" data-mode="challenge">Challenge</button>
          </div>
        </div>

        ${renderQuickKeysHtml('trial-quick-keys', trialQuickKeys)}

        <div class="code-editor-shell">
          <div class="code-editor-bar">
            <span class="code-editor-cta">${isFixBug ? '🐛 EDIT &amp; FIX YOUR PYTHON CODE BELOW' : '⌨️ TYPE YOUR PYTHON CODE BELOW'}</span>
            <span class="code-editor-sub">Click or tap inside the box to type</span>
          </div>
          <div class="code-editor-body">
            <div id="trial-code-gutter" class="code-gutter" aria-hidden="true"></div>
            <div class="code-textarea-wrap">
              <div id="trial-code-highlights" class="code-line-highlights" aria-hidden="true"></div>
              <textarea id="trial-code" class="code-editor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" inputmode="text" placeholder="Click or tap here and type your Python spell...">${escapeHtml(editableInitialCode)}</textarea>
            </div>
          </div>
        </div>

        <div class="editor-actions">
          <button id="btn-trial-run" class="btn btn-primary">▶ Run Python Spell</button>
          <button id="btn-trial-hint" class="btn btn-gold" ${initialMaxHints === 0 ? 'disabled' : ''}>
            💡 Ask Pip (Hint 1/${initialMaxHints})
          </button>
          <button id="btn-trial-reset" class="btn btn-ghost">↺ Reset Code</button>
          ${hasIntroChoice ? '<button id="btn-review-intro" class="btn btn-ghost">← Review Concept</button>' : ''}
        </div>

        <div id="trial-hints-area" class="hidden"></div>

        <div id="trial-output" class="pip-console">
          <div class="pip-console-header">🐉 Pip is watching your spellbook:</div>
          <div class="pip-console-body">Write your Python code above and press <strong>Run Python Spell</strong>!</div>
        </div>
        `,
        'modal-wide'
      );

      const codeEl = this.content.querySelector('#trial-code');
      const runBtn = this.content.querySelector('#btn-trial-run');
      const hintBtn = this.content.querySelector('#btn-trial-hint');
      const resetBtn = this.content.querySelector('#btn-trial-reset');
      const hintsArea = this.content.querySelector('#trial-hints-area');
      const outputEl = this.content.querySelector('#trial-output');
      const diffBadge = this.content.querySelector('#trial-diff-badge');
      const draftBadge = this.content.querySelector('#trial-draft-badge');
      const commentTipEl = this.content.querySelector('#trial-comment-tip');
      const challengeBannerEl = this.content.querySelector('#trial-challenge-banner');
      const objectiveTextEl = this.content.querySelector('#trial-objective-text');
      const bugSummaryEl = this.content.querySelector('#trial-bug-summary');
      const trialGutter = attachCodeGutter(
        codeEl,
        this.content.querySelector('#trial-code-gutter'),
        this.content.querySelector('#trial-code-highlights')
      );
      codeEl.addEventListener('input', () => trialGutter.setMarks(new Map()));

      const syncCommentTip = (code) => {
        if (!commentTipEl) return;
        const shouldShow = (Number(realm?.number) || 1) <= 3 && hasHashComment(code);
        commentTipEl.classList.toggle('hidden', !shouldShow);
      };

      const renderRevealedHints = () => {
        const effMax = getEffectiveMaxHints();
        const visibleCount = Math.min(hintsUsed, effMax);
        if (visibleCount <= 0) {
          hintsArea.classList.add('hidden');
          hintsArea.innerHTML = '';
        } else {
          hintsArea.classList.remove('hidden');
          const shown = hintTiers.slice(0, visibleCount).map((t) => {
            const text = t.customText ?? trial.hints?.[t.key] ?? '';
            return `
              <div class="hint-box" style="margin-bottom:8px;">
                <div class="hint-box-title">🐉 ${escapeHtml(t.label)}</div>
                <div>${renderSafeMarkdown(text)}</div>
              </div>
            `;
          });
          hintsArea.innerHTML = shown.join('');
        }
        if (effMax === 0) {
          hintBtn.textContent = '💡 Hints Disabled';
          hintBtn.disabled = true;
        } else if (visibleCount >= effMax) {
          hintBtn.textContent =
            currentMode === 'challenge'
              ? '💡 Challenge Hint Shown (1/1)'
              : `💡 All ${effMax} Hint${effMax === 1 ? '' : 's'} Shown`;
          hintBtn.disabled = true;
        } else {
          hintBtn.textContent = `💡 Ask Pip (Hint ${visibleCount + 1}/${effMax})`;
          hintBtn.disabled = false;
        }
      };

      const syncDifficultyUi = () => {
        this.content.querySelectorAll('[data-mode]').forEach((b) => {
          b.classList.toggle('btn-sky', b.dataset.mode === currentMode);
          b.classList.toggle('btn-ghost', b.dataset.mode !== currentMode);
        });
        diffBadge.textContent =
          currentMode === 'challenge' ? 'Mode: 🏆 challenge' : `Mode: ${currentMode}`;
        challengeBannerEl?.classList.toggle('hidden', currentMode !== 'challenge');
        if (objectiveTextEl) {
          objectiveTextEl.innerHTML = renderObjectiveInnerHtml();
        }
        if (bugSummaryEl) {
          bugSummaryEl.innerHTML = renderBugBannerBody();
        }
        renderRevealedHints();
      };

      // On desktop, auto-focus the coding box with cursor at the end so the blinking caret is obvious.
      if (codeEl && !window.matchMedia?.('(pointer: coarse)')?.matches) {
        requestAnimationFrame(() => {
          codeEl.focus();
          const endPos = codeEl.value.length;
          codeEl.selectionStart = codeEl.selectionEnd = endPos;
        });
      }

      wireQuickKeysBar(this.content.querySelector('#trial-quick-keys'), codeEl, trialQuickKeys);

      const trialSuggestions = buildTrialSuggestions({ realm, era, trial });
      const destroyTrialAc = attachAutocomplete(codeEl, () => trialSuggestions);
      this.addCleanup(destroyTrialAc);

      if (!isPractice) {
        codeEl.addEventListener('input', () => {
          if (onDraftChange) onDraftChange(codeEl.value);
        });
        this.addCleanup(() => {
          if (!skipFlushOnClose && onDraftFlush) {
            onDraftFlush(codeEl.value);
          }
        });
      }

      syncDifficultyUi();

      this.content.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          currentMode = btn.dataset.mode;
          codeEl.value = ensureTrailingEditableLine(trial.starterCode[currentMode] || '');
          syncCommentTip(codeEl.value);
          trialGutter.setMarks(new Map());
          draftBadge?.classList.add('hidden');
          if (!isPractice && onDraftClear) onDraftClear();
          syncDifficultyUi();
          audio.playClick();
        });
      });

      resetBtn.addEventListener('click', () => {
        codeEl.value = ensureTrailingEditableLine(trial.starterCode[currentMode] || '');
        syncCommentTip(codeEl.value);
        trialGutter.setMarks(new Map());
        draftBadge?.classList.add('hidden');
        if (!isPractice && onDraftClear) onDraftClear();
        audio.playClick();
      });

      hintBtn.addEventListener('click', () => {
        const effMax = getEffectiveMaxHints();
        const visibleCount = Math.min(hintsUsed, effMax);
        if (visibleCount >= effMax) return;
        const nextTierNum = visibleCount + 1;
        const gateMsg = getHintGateMessage(nextTierNum, false);
        if (gateMsg) {
          audio.playClick();
          outputEl.className = 'pip-console';
          outputEl.innerHTML = `
            <div class="pip-console-header">🐉 Pip encourages you:</div>
            <div class="pip-console-body">${gateMsg}</div>
          `;
          return;
        }
        audio.playClick();
        hintsUsed = nextTierNum;
        renderRevealedHints();
      });

      let solvedInView = false;
      const runSpell = async () => {
        if (runBtn.disabled || solvedInView) return;
        const code = codeEl.value;
        const nonEmptyLines = code.split('\n').map((l) => l.trim()).filter(Boolean);
        if (nonEmptyLines.length === 0 || nonEmptyLines.every((l) => l.startsWith('#'))) {
          audio.playError();
          outputEl.className = 'pip-console error';
          outputEl.innerHTML =
            nonEmptyLines.length === 0
              ? `
                <div class="pip-console-header">🐉 Pip points at the coding box:</div>
                <div class="pip-console-body">Your coding box is empty! Click or tap inside the <strong>TYPE YOUR PYTHON CODE BELOW</strong> box, type your Python spell, and press <strong>▶ Run Python Spell</strong>!</div>
              `
              : `
                <div class="pip-console-header">🐉 Pip spots a comment-only spell!</div>
                <div class="pip-console-body">Every line in the coding box starts with <code>#</code> — those are <strong>comments</strong> (notes that Python ignores)! Click inside the coding box, start a new line <strong>without <code>#</code></strong>, type your Python spell, and press <strong>▶ Run Python Spell</strong>!</div>
              `;
          codeEl.focus();
          const endPos = codeEl.value.length;
          codeEl.selectionStart = codeEl.selectionEnd = endPos;
          return;
        }
        runBtn.disabled = true;
        runBtn.textContent = 'Running...';
        audio.playCodeRun();

        const result = await pyRunner.runTrial(code, trial.testCode, diff.showRawTracebacks, {
          requiredConstructs: trial.requiredConstructs,
          variants: trial.variants,
        });
        if (!result.passed) {
          runBtn.disabled = false;
          runBtn.textContent = '▶ Run Python Spell';
        } else {
          solvedInView = true;
        }

        const attemptIsPractice = Boolean(isPractice || alreadySolved || isTrialSolvedInSave());
        const difficultyMode = VALID_DIFFICULTY_MODES.has(currentMode) ? currentMode : 'standard';
        const errorType = result.passed
          ? null
          : result.timedOut
            ? 'TimeoutError'
            : sanitizeAttemptErrorType(result.errorType || 'Error');
        const durationMs = computeDurationMs();

        if (onAttempt) {
          onAttempt({
            trialId: trial.id,
            passed: result.passed,
            hintsUsed,
            code,
            difficultyMode,
            isPractice: attemptIsPractice,
            errorType,
            durationMs,
          });
        }

        if (result.passed) {
          audio.playSuccess();
          skipFlushOnClose = true;
          if (!isPractice && onDraftClear) {
            onDraftClear({ skipPersist: true });
          }
          const solvedInChallenge = !isPractice && currentMode === 'challenge';
          const solvedPayload = solvedInChallenge
            ? {
                ...trial,
                shardReward: (Number(trial.shardReward) || 0) + CHALLENGE_BONUS_SHARDS,
                solvedInChallengeMode: true,
              }
            : trial;
          // Immediately persist solved state so closing/Escape can never lose progress!
          if (onSolved) {
            await onSolved(solvedPayload);
          }
          renderCelebrationView({ stdout: result.stdout, isPractice, solvedInChallenge });
        } else {
          failedAttempts += 1;
          if (bugSummaryEl) {
            bugSummaryEl.innerHTML = renderBugBannerBody();
          }
          if (result.errorLine) {
            const errLn = Number(result.errorLine);
            trialGutter.setMarks(
              new Map([[errLn, { kind: 'hl-error', icon: '⚠️', badge: 'check this line' }]])
            );
            trialGutter.scrollToLine(errLn);
          } else {
            trialGutter.setMarks(new Map());
          }
          audio.playError();
          const outputLabel = useTrainingSpells ? "Your spell's output:" : 'Your print() output:';
          outputEl.className = 'pip-console error';
          outputEl.innerHTML = `
            <div class="pip-console-header">🐉 Pip's Clue:</div>
            <div class="pip-console-body">${renderSafeMarkdown(result.pipMessage)}</div>
            ${result.stdout ? `<div class="console-stdout">${outputLabel}\n${escapeHtml(result.stdout)}</div>` : ''}
            ${result.rawTraceback ? `<div class="console-traceback">${escapeHtml(result.rawTraceback)}</div>` : ''}
          `;
        }
      };

      runBtn.addEventListener('click', runSpell);
      attachCodeEditorKeys(codeEl, runSpell);
      this.content.querySelector('#btn-review-intro')?.addEventListener('click', () => {
        audio.playClick();
        if (!isPractice && onDraftFlush) onDraftFlush(trial.id, codeEl.value);
        renderIntroChoiceView(isPractice);
      });
      this.content.querySelectorAll('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.close());
      });
    };

    if (alreadySolved) {
      renderCompletedSummary();
    } else if (trial.trialType === 'multiple_choice') {
      renderMultipleChoiceView(false);
    } else if (hasIntroChoice && !hasExistingDraft) {
      renderIntroChoiceView(false);
    } else {
      renderEditorView(false);
    }
  }

  // ==================== BRAM'S WORKSHOP MODAL ====================
  openWorkshopModal({ catalog, save, eraKey, onSaveUpdated }) {
    audio.playClick();
    music.setDucked(true);
    let workingSave = structuredClone(save);
    if (!workingSave.stats || typeof workingSave.stats !== 'object') {
      workingSave.stats = { charisma: 0, courage: 0 };
    }
    workingSave.stats.arrows = Number(workingSave.stats.arrows) || 0;
    workingSave.stats.potions = Number(workingSave.stats.potions) || 0;
    if (!Array.isArray(workingSave.stats.customItems)) {
      workingSave.stats.customItems = [];
    }
    if (!Array.isArray(workingSave.stats.completedWorkshopChallenges)) {
      workingSave.stats.completedWorkshopChallenges = [];
    }

    let previewDirIndex = 0;
    const dirs = ['down', 'right', 'up', 'left'];
    let previewFrame = 0;
    let activeTab = 'gear'; // 'gear' | 'recipes' | 'challenges'
    let activeChallenge = null;

    const consumables = Array.isArray(catalog.consumables) ? catalog.consumables : [];
    const recipes = Array.isArray(catalog.workshopRecipes) ? catalog.workshopRecipes : [];
    const challenges = Array.isArray(catalog.workshopChallenges) ? catalog.workshopChallenges : [];
    const solvedCount = Array.isArray(workingSave.solvedTrials) ? workingSave.solvedTrials.length : 0;

    const normalizeCall = (line) =>
      String(line || '')
        .trim()
        .replace(/'/g, '"')
        .replace(/\s+/g, '');

    const matchConsumableForLine = (line) => {
      const norm = normalizeCall(line);
      if (!norm || norm.startsWith('#')) return null;
      const arrowMatch = norm.match(/^forge_arrows\((\d*)\)$/);
      if (arrowMatch) {
        const qty = Math.max(1, Math.min(50, arrowMatch[1] ? Number(arrowMatch[1]) : 1));
        return {
          id: 'consumable-arrows',
          name: `Rune Arrows ×${qty}`,
          shardCost: 5 * qty,
          stackable: true,
        };
      }
      const potionMatch = norm.match(/^brew_potion\((\d*)\)$/);
      if (potionMatch) {
        const qty = Math.max(1, Math.min(50, potionMatch[1] ? Number(potionMatch[1]) : 1));
        return {
          id: 'consumable-potions',
          name: `Starlight Potion ×${qty}`,
          shardCost: 10 * qty,
          stackable: true,
        };
      }
      if (/^forge_custom\(/.test(norm)) {
        return {
          id: 'consumable-custom',
          name: 'Custom Relic',
          shardCost: 15,
          stackable: true,
        };
      }
      return null;
    };

    const matchUnlockableForLine = (line) => {
      const norm = normalizeCall(line);
      if (!norm || norm.startsWith('#')) return null;
      const unlockables = catalog.unlockables || [];
      const exact = unlockables.find((u) => normalizeCall(u.functionCall) === norm);
      if (exact) return exact;
      if (/^add_charisma\(\d+\)$/.test(norm)) {
        return unlockables.find((u) => u.id === 'stat-charisma-1') || null;
      }
      if (/^add_courage\(\d+\)$/.test(norm)) {
        return unlockables.find((u) => u.id === 'stat-courage-1') || null;
      }
      return matchConsumableForLine(line);
    };

    const estimateCart = (codeText) => {
      const seenOwned = new Set(workingSave.ownedUnlockIds || []);
      const queuedIds = new Set();
      const currentShards = Number(workingSave.byteShards) || 0;
      let totalCost = 0;
      let runningShards = currentShards;
      let firstOverBudget = null;
      const lines = String(codeText || '').split('\n');
      const items = [];
      lines.forEach((rawLine, idx) => {
        const item = matchUnlockableForLine(rawLine);
        if (!item) return;
        const lineNumber = idx + 1;
        queuedIds.add(item.id);
        const alreadyOwned = !item.stackable && seenOwned.has(item.id);
        const cost = alreadyOwned ? 0 : Number(item.shardCost) || 0;
        const shardsBefore = runningShards;
        if (!alreadyOwned) {
          if (!item.stackable) seenOwned.add(item.id);
          totalCost += cost;
          runningShards -= cost;
        }
        const wentOverHere = !alreadyOwned && shardsBefore >= 0 && runningShards < 0;
        const overBudget = runningShards < 0;
        const entry = {
          id: item.id,
          name: item.name,
          call: rawLine.trim(),
          lineNumber,
          cost,
          alreadyOwned,
          shardsBefore,
          shardsAfter: runningShards,
          wentOverHere,
          overBudget,
        };
        if (wentOverHere && !firstOverBudget) {
          firstOverBudget = entry;
        }
        items.push(entry);
      });
      return {
        currentShards,
        totalCost,
        remaining: currentShards - totalCost,
        items,
        queuedIds,
        firstOverBudget,
      };
    };

    const renderInventoryHtml = () => {
      const arrows = Number(workingSave.stats?.arrows) || 0;
      const potions = Number(workingSave.stats?.potions) || 0;
      const customCount = Array.isArray(workingSave.stats?.customItems)
        ? workingSave.stats.customItems.length
        : 0;
      const customPreview =
        customCount > 0
          ? ` (${escapeHtml(workingSave.stats.customItems[customCount - 1])})`
          : '';
      return `
        <span>🎒 <strong>Pack:</strong></span>
        <span class="pill pill-muted">🏹 ${arrows} Arrows</span>
        <span class="pill pill-muted">🧪 ${potions} Potions</span>
        <span class="pill pill-violet">✨ ${customCount} Relic${customCount === 1 ? '' : 's'}${customPreview}</span>
      `;
    };

    const renderGearCatalogHtml = (cart = null) => {
      const owned = new Set(workingSave.ownedUnlockIds || []);
      const currentShards = Number(workingSave.byteShards) || 0;
      const effectiveBudget = cart ? Math.max(0, cart.remaining) : currentShards;
      const queuedIds = cart ? cart.queuedIds : new Set();

      const consumableHtml = consumables
        .map((item) => {
          const cost = Number(item.shardCost) || 0;
          const canAfford = effectiveBudget >= cost;
          const count =
            item.inventoryKey === 'customItems'
              ? (workingSave.stats.customItems || []).length
              : Number(workingSave.stats[item.inventoryKey]) || 0;
          const stateClass = canAfford ? 'affordable' : 'unaffordable';
          const badge = canAfford
            ? `<span class="pill pill-gold">💎 ${cost} each · Owned: ${count}</span>`
            : `<span class="pill pill-rose">💎 ${cost} each · Owned: ${count}</span>`;
          return `
            <div class="catalog-item ${stateClass}" data-call="${escapeHtml(item.functionCall)}" data-stackable="1">
              <div>
                <div class="catalog-item-title">${escapeHtml(item.name)}</div>
                <div class="catalog-item-call">${escapeHtml(item.functionCall)}</div>
                <div class="catalog-item-desc">${renderSafeMarkdown(item.description)}</div>
              </div>
              <div class="catalog-item-badge">${badge}</div>
            </div>
          `;
        })
        .join('');

      const gearHtml = (catalog.unlockables || [])
        .map((item) => {
          const isOwned = owned.has(item.id);
          const isQueued = !isOwned && queuedIds.has(item.id);
          const cost = Number(item.shardCost) || 0;
          const canAfford = effectiveBudget >= cost;
          const missing = Math.max(0, cost - effectiveBudget);
          const stateClass = isOwned
            ? 'owned'
            : isQueued
              ? 'queued'
              : canAfford
                ? 'affordable'
                : 'unaffordable';
          const badge = isOwned
            ? '<span class="pill pill-green">✓ Owned (Free to Equip)</span>'
            : isQueued
              ? `<span class="pill pill-sky">🛒 In Code (${cost} 💎)</span>`
              : canAfford
                ? `<span class="pill pill-gold">💎 ${cost} Shards · Ready to Forge!</span>`
                : `<span class="pill pill-rose">${cost} 💎 · 🔒 Need ${missing} more</span>`;
          return `
            <div class="catalog-item ${stateClass}" data-call="${escapeHtml(item.functionCall)}">
              <div>
                <div class="catalog-item-title">${escapeHtml(item.name)}</div>
                <div class="catalog-item-call">${escapeHtml(item.functionCall)}</div>
                <div class="catalog-item-desc">${renderSafeMarkdown(item.description)}</div>
              </div>
              <div class="catalog-item-badge">${badge}</div>
            </div>
          `;
        })
        .join('');

      return `${consumableHtml}${gearHtml}`;
    };

    const renderRecipesHtml = () => {
      if (recipes.length === 0) {
        return '<div class="muted-text">No recipes available yet.</div>';
      }
      return recipes
        .map((r) => {
          const unlocked = solvedCount >= (Number(r.minSolvedTrials) || 0);
          return `
            <div class="ws-recipe-card">
              <div class="ws-card-top">
                <strong style="font-size:14px;">${escapeHtml(r.title)}</strong>
                <span class="pill ${unlocked ? 'pill-violet' : 'pill-muted'}">${renderSafeMarkdown(r.concept)}</span>
              </div>
              <div class="catalog-item-desc">${renderSafeMarkdown(r.description)}</div>
              <pre class="ws-card-code">${escapeHtml(r.starterCode.trim())}</pre>
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <span class="muted-text" style="font-size:12px; margin:0;">
                  ${unlocked ? '✨ Ready to tinker!' : `💡 Preview (recommended after ${r.minSolvedTrials} trials)`}
                </span>
                <button type="button" class="btn btn-sm btn-sky" data-load-recipe="${escapeHtml(r.id)}">
                  Load Recipe →
                </button>
              </div>
            </div>
          `;
        })
        .join('');
    };

    const renderChallengesHtml = () => {
      const doneSet = new Set(workingSave.stats.completedWorkshopChallenges || []);
      if (challenges.length === 0) {
        return '<div class="muted-text">No review challenges available yet.</div>';
      }
      return challenges
        .map((c) => {
          const isDone = doneSet.has(c.id);
          const isSelected = activeChallenge?.id === c.id;
          return `
            <div class="ws-challenge-card ${isDone ? 'completed' : ''}">
              <div class="ws-card-top">
                <strong style="font-size:14px;">${isDone ? '✓ ' : '🎯 '}${escapeHtml(c.title)}</strong>
                <span class="pill ${isDone ? 'pill-green' : 'pill-gold'}">
                  ${isDone ? '✓ Cleared' : `+${c.shardReward} 💎`}
                </span>
              </div>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <span class="pill pill-blue">${escapeHtml(c.realmHint || 'Spaced Review')}</span>
                <span class="pill pill-muted">${renderSafeMarkdown(c.concept)}</span>
              </div>
              <div class="catalog-item-desc">${renderSafeMarkdown(c.prompt)}</div>
              <div style="display:flex; justify-content:flex-end;">
                <button type="button" class="btn btn-sm ${isSelected ? 'btn-gold' : 'btn-primary'}" data-load-challenge="${escapeHtml(c.id)}">
                  ${isSelected ? 'Active in Editor' : isDone ? 'Practice Again →' : 'Try Challenge →'}
                </button>
              </div>
            </div>
          `;
        })
        .join('');
    };

    const wsQuickKeys = getQuickKeysForContext({ useTrainingSpells: false });

    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>⚒ Bram's Tinkerer Workshop</h2>
          <div class="modal-badges">
            <span class="pill pill-gold" id="ws-shards-pill">💎 ${Number(workingSave.byteShards) || 0} Byte Shards</span>
            <span class="pill pill-blue" id="ws-stats-pill">Charisma: ${Number(workingSave.stats?.charisma) || 0} · Courage: ${Number(workingSave.stats?.courage) || 0}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>

      <p class="muted-text" style="margin-top:-6px;">
        "No buttons in my shop, kid! Write real Python — loops, <code>if</code> checks, functions, or classes — to forge gear, stock stackable items, or try spaced-review challenges!"
      </p>

      <div class="workshop-grid">
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div class="preview-stage" style="padding:10px;">
            <canvas id="ws-preview-canvas" width="160" height="104" class="pixel-canvas" style="width:200px; height:130px;"></canvas>
            <div class="preview-controls">
              <button id="ws-turn-btn" class="btn btn-sm btn-ghost">↻ Turn Hero</button>
            </div>
          </div>
          <div id="ws-balance-banner" class="ws-balance-banner">
            💎 Your Byte Shards: <strong id="ws-balance-value">${Number(workingSave.byteShards) || 0}</strong>
          </div>
          <div id="ws-inventory-bar" class="ws-inventory-bar">
            ${renderInventoryHtml()}
          </div>
          <div class="ws-tabs" role="tablist">
            <button type="button" class="ws-tab-btn active" data-ws-tab="gear">⚒ Gear &amp; Items</button>
            <button type="button" class="ws-tab-btn" data-ws-tab="recipes">📜 Recipes (${recipes.length})</button>
            <button type="button" class="ws-tab-btn" data-ws-tab="challenges">🎯 Challenges (${challenges.length})</button>
          </div>
          <div id="ws-catalog" class="catalog-list">
            ${renderGearCatalogHtml()}
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:12px;">
          <div id="ws-challenge-banner" class="challenge-banner hidden"></div>
          <div id="ws-cart-bar" class="ws-cart-bar"></div>
          ${renderQuickKeysHtml('ws-quick-keys', wsQuickKeys)}
          <div class="code-editor-shell">
            <div class="code-editor-bar">
              <span id="ws-editor-cta" class="code-editor-cta">⚒ FORGE CODE BOX</span>
              <span class="code-editor-sub">Click items on the left or write Python below</span>
            </div>
            <div class="code-editor-body">
              <div id="ws-code-gutter" class="code-gutter" aria-hidden="true"></div>
              <div class="code-textarea-wrap">
                <div id="ws-code-highlights" class="code-line-highlights" aria-hidden="true"></div>
                <textarea id="ws-code" class="code-editor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" inputmode="text" placeholder="Click a blueprint, load a recipe, or write Python (loops, if, def, class)..."></textarea>
              </div>
            </div>
          </div>
          <div class="editor-actions">
            <button id="ws-run-btn" class="btn btn-gold">⚒ Run Forge Code</button>
            <button id="ws-exit-challenge-btn" class="btn btn-ghost hidden">← Back to Free Forge</button>
            <button id="ws-clear-btn" class="btn btn-ghost">Clear</button>
          </div>
          <div id="ws-output" class="pip-console">
            <div class="pip-console-header">⚒ Bram says:</div>
            <div class="pip-console-body">Click a blueprint, try a <strong>📜 Concept Recipe</strong> (like a <code>for</code> loop with <code>forge_arrows(1)</code>), or earn extra shards in <strong>🎯 Challenges</strong>!</div>
          </div>
        </div>
      </div>
      `,
      'modal-wide'
    );

    const previewCanvas = this.content.querySelector('#ws-preview-canvas');
    const catalogEl = this.content.querySelector('#ws-catalog');
    const cartBarEl = this.content.querySelector('#ws-cart-bar');
    const inventoryBarEl = this.content.querySelector('#ws-inventory-bar');
    const challengeBannerEl = this.content.querySelector('#ws-challenge-banner');
    const editorCtaEl = this.content.querySelector('#ws-editor-cta');
    const exitChallengeBtn = this.content.querySelector('#ws-exit-challenge-btn');
    const codeEl = this.content.querySelector('#ws-code');
    const wsGutter = attachCodeGutter(
      codeEl,
      this.content.querySelector('#ws-code-gutter'),
      this.content.querySelector('#ws-code-highlights')
    );
    const runBtn = this.content.querySelector('#ws-run-btn');
    const clearBtn = this.content.querySelector('#ws-clear-btn');
    const outputEl = this.content.querySelector('#ws-output');
    const shardsPill = this.content.querySelector('#ws-shards-pill');
    const balanceVal = this.content.querySelector('#ws-balance-value');
    const statsPill = this.content.querySelector('#ws-stats-pill');

    wireQuickKeysBar(this.content.querySelector('#ws-quick-keys'), codeEl, wsQuickKeys);

    const destroyWsAc = attachAutocomplete(codeEl, () => buildWorkshopSuggestions(catalog, workingSave));
    this.addCleanup(destroyWsAc);

    const animInterval = setInterval(() => {
      previewFrame += 1;
      this.sprites.drawHeroAndPipPreview(
        previewCanvas,
        workingSave.appearance,
        eraKey,
        dirs[previewDirIndex],
        previewFrame
      );
    }, 240);
    this.addCleanup(() => clearInterval(animInterval));

    this.sprites.drawHeroAndPipPreview(previewCanvas, workingSave.appearance, eraKey, dirs[previewDirIndex], 0);

    this.content.querySelector('#ws-turn-btn')?.addEventListener('click', () => {
      previewDirIndex = (previewDirIndex + 1) % dirs.length;
      audio.playClick();
    });

    const syncChallengeModeUi = () => {
      if (activeChallenge) {
        challengeBannerEl.classList.remove('hidden');
        challengeBannerEl.innerHTML = `
          <div>
            <strong>🎯 Review Challenge: ${escapeHtml(activeChallenge.title)}</strong>
            <div style="margin-top:3px;">${renderSafeMarkdown(activeChallenge.prompt)}</div>
          </div>
          <span class="pill pill-gold">+${activeChallenge.shardReward} 💎 Reward</span>
        `;
        cartBarEl.classList.add('hidden');
        editorCtaEl.textContent = `🎯 CHALLENGE: ${activeChallenge.title.toUpperCase()}`;
        runBtn.textContent = '▶ Check Challenge Code';
        runBtn.className = 'btn btn-primary';
        exitChallengeBtn.classList.remove('hidden');
      } else {
        challengeBannerEl.classList.add('hidden');
        cartBarEl.classList.remove('hidden');
        editorCtaEl.textContent = '⚒ FORGE CODE BOX';
        runBtn.textContent = '⚒ Run Forge Code';
        runBtn.className = 'btn btn-gold';
        exitChallengeBtn.classList.add('hidden');
      }
    };

    const renderActiveTabList = (cart = null) => {
      if (activeTab === 'recipes') {
        catalogEl.innerHTML = renderRecipesHtml();
        catalogEl.querySelectorAll('[data-load-recipe]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const recipe = recipes.find((r) => r.id === btn.dataset.loadRecipe);
            if (!recipe) return;
            activeChallenge = null;
            syncChallengeModeUi();
            codeEl.value = recipe.starterCode;
            codeEl.focus();
            refreshCartAndCatalog();
            audio.playClick();
          });
        });
      } else if (activeTab === 'challenges') {
        catalogEl.innerHTML = renderChallengesHtml();
        catalogEl.querySelectorAll('[data-load-challenge]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const chal = challenges.find((c) => c.id === btn.dataset.loadChallenge);
            if (!chal) return;
            activeChallenge = chal;
            syncChallengeModeUi();
            codeEl.value = chal.starterCode || '';
            codeEl.focus();
            wsGutter.setMarks(new Map());
            renderActiveTabList();
            audio.playClick();
          });
        });
      } else {
        catalogEl.innerHTML = renderGearCatalogHtml(cart);
        wireCatalogClicks();
      }
    };

    const refreshCartAndCatalog = () => {
      if (inventoryBarEl) {
        inventoryBarEl.innerHTML = renderInventoryHtml();
      }
      const cart = activeChallenge ? null : estimateCart(codeEl.value);
      const marks = new Map();
      if (cart) {
        for (const it of cart.items) {
          if (it.wentOverHere) {
            const need = Math.max(1, it.cost - Math.max(0, it.shardsBefore));
            marks.set(it.lineNumber, {
              kind: 'hl-error',
              icon: '⚠️',
              badge: `⚠️ OVER BUDGET (need ${need} more 💎)`,
            });
          } else if (it.overBudget) {
            marks.set(it.lineNumber, {
              kind: 'hl-over-after',
              icon: '🔒',
              badge: 'over budget',
            });
          } else if (cart.remaining < 0) {
            marks.set(it.lineNumber, {
              kind: 'hl-ok',
              badge: `✓ ${it.shardsAfter} 💎 left`,
            });
          }
        }
      }
      wsGutter.setMarks(marks);
      if (cartBarEl && cart) {
        if (cart.items.length === 0) {
          cartBarEl.className = 'ws-cart-bar';
          cartBarEl.innerHTML = `
            <span>💎 Have: <strong>${cart.currentShards}</strong></span>
            <span class="muted-text">Add blueprints or run loops, <code>if</code>, <code>def</code>, or <code>class</code> code!</span>
          `;
        } else if (cart.remaining >= 0) {
          cartBarEl.className = 'ws-cart-bar ok';
          cartBarEl.innerHTML = `
            <span>💎 Have: <strong>${cart.currentShards}</strong></span>
            <span>− 🛒 Order (${cart.items.length}): <strong>${cart.totalCost}</strong></span>
            <span>= ✨ Left After: <strong>${cart.remaining}</strong></span>
          `;
        } else {
          const shortBy = Math.abs(cart.remaining);
          const overLine = cart.firstOverBudget;
          const lineRows = cart.items
            .map((it) => {
              if (it.alreadyOwned) {
                return `<div class="ws-cart-line ok">Line ${it.lineNumber}: ${escapeHtml(it.name)} (Owned · 0 💎) ✓</div>`;
              }
              if (it.wentOverHere) {
                const need = Math.max(1, it.cost - Math.max(0, it.shardsBefore));
                return `<div class="ws-cart-line over-trigger">⚠️ <strong>Line ${it.lineNumber}</strong>: ${escapeHtml(it.name)} (−${it.cost} 💎) — <strong>went over budget here!</strong> (had ${Math.max(0, it.shardsBefore)} 💎, need ${need} more)</div>`;
              }
              if (it.overBudget) {
                return `<div class="ws-cart-line over-after">Line ${it.lineNumber}: ${escapeHtml(it.name)} (−${it.cost} 💎) — still over budget</div>`;
              }
              return `<div class="ws-cart-line ok">Line ${it.lineNumber}: ${escapeHtml(it.name)} (−${it.cost} 💎 → ${it.shardsAfter} left) ✓</div>`;
            })
            .join('');
          cartBarEl.className = 'ws-cart-bar over';
          cartBarEl.innerHTML = `
            <div class="ws-cart-summary">
              <span>💎 Have: <strong>${cart.currentShards}</strong></span>
              <span>− 🛒 Order (${cart.items.length}): <strong>${cart.totalCost}</strong></span>
              <span>= 🔒 <strong>Short by ${shortBy} 💎</strong>${overLine ? ` (over budget on <strong>Line ${overLine.lineNumber}</strong>)` : ''}</span>
            </div>
            <div class="ws-cart-lines">${lineRows}</div>
          `;
        }
      }
      renderActiveTabList(cart);
    };

    const wireCatalogClicks = () => {
      catalogEl.querySelectorAll('.catalog-item').forEach((el) => {
        el.addEventListener('click', () => {
          activeChallenge = null;
          syncChallengeModeUi();
          const call = el.dataset.call;
          const isStackable = el.dataset.stackable === '1';
          const current = codeEl.value.trim();
          const lines = current ? current.split('\n').filter((l) => l.trim()) : [];
          if (isStackable || !lines.some((l) => normalizeCall(l) === normalizeCall(call))) {
            lines.push(call);
          }
          codeEl.value = lines.join('\n') + '\n';
          codeEl.focus();
          refreshCartAndCatalog();
          audio.playClick();
        });
      });
    };

    this.content.querySelectorAll('[data-ws-tab]').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        activeTab = tabBtn.dataset.wsTab;
        this.content.querySelectorAll('[data-ws-tab]').forEach((b) => {
          b.classList.toggle('active', b.dataset.wsTab === activeTab);
        });
        renderActiveTabList(activeChallenge ? null : estimateCart(codeEl.value));
        audio.playClick();
      });
    });

    exitChallengeBtn.addEventListener('click', () => {
      activeChallenge = null;
      syncChallengeModeUi();
      codeEl.value = '';
      refreshCartAndCatalog();
      audio.playClick();
    });

    codeEl.addEventListener('input', refreshCartAndCatalog);
    syncChallengeModeUi();
    refreshCartAndCatalog();

    clearBtn.addEventListener('click', () => {
      codeEl.value = '';
      codeEl.focus();
      refreshCartAndCatalog();
      audio.playClick();
    });

    const runForge = async () => {
      const code = codeEl.value.trim();
      if (!code) return;

      if (activeChallenge) {
        const chal = activeChallenge;
        runBtn.disabled = true;
        runBtn.textContent = 'Checking...';
        audio.playCodeRun();

        const res = await pyRunner.runTrial(code, chal.testCode, false, {
          requiredConstructs: chal.requiredConstructs,
        });
        runBtn.disabled = false;
        runBtn.textContent = '▶ Check Challenge Code';

        if (res.passed) {
          audio.playSuccess();
          const doneList = workingSave.stats.completedWorkshopChallenges || [];
          const firstTime = !doneList.includes(chal.id);
          if (firstTime) {
            doneList.push(chal.id);
            workingSave.stats.completedWorkshopChallenges = doneList;
            workingSave.byteShards = (Number(workingSave.byteShards) || 0) + (Number(chal.shardReward) || 0);
            shardsPill.textContent = `💎 ${workingSave.byteShards} Byte Shards`;
            if (balanceVal) balanceVal.textContent = String(workingSave.byteShards);
            if (onSaveUpdated) {
              onSaveUpdated(workingSave);
            }
          }
          wsGutter.setMarks(new Map());
          renderActiveTabList();
          outputEl.className = 'pip-console success';
          outputEl.innerHTML = `
            <div class="pip-console-header">🎯 Challenge Cleared!</div>
            <div class="pip-console-body">
              ${
                firstTime
                  ? `Bram rings the anvil! You earned <strong style="color:var(--accent-gold);">+${chal.shardReward} Byte Shards</strong> for completing <strong>${escapeHtml(chal.title)}</strong>!`
                  : `Spot-on practice run on <strong>${escapeHtml(chal.title)}</strong>! (Bonus shards already claimed.)`
              }
              ${res.stdout ? `<div class="console-stdout" style="margin-top:6px;">Output:\n${escapeHtml(res.stdout)}</div>` : ''}
            </div>
          `;
        } else {
          if (res.errorLine) {
            const errLn = Number(res.errorLine);
            wsGutter.setMarks(
              new Map([[errLn, { kind: 'hl-error', icon: '⚠️', badge: 'check this line' }]])
            );
            wsGutter.scrollToLine(errLn);
          }
          audio.playError();
          outputEl.className = 'pip-console error';
          outputEl.innerHTML = `
            <div class="pip-console-header">🐉 Pip's Challenge Clue:</div>
            <div class="pip-console-body">${renderSafeMarkdown(res.pipMessage)}</div>
            ${res.stdout ? `<div class="console-stdout">Output:\n${escapeHtml(res.stdout)}</div>` : ''}
          `;
        }
        return;
      }

      const startShards = Number(workingSave.byteShards) || 0;
      runBtn.disabled = true;
      runBtn.textContent = 'Forging...';
      audio.playCodeRun();

      const workshopSaveInput = {
        ...workingSave,
        inventory: {
          arrows: Number(workingSave.stats?.arrows) || 0,
          potions: Number(workingSave.stats?.potions) || 0,
        },
        customItems: Array.isArray(workingSave.stats?.customItems)
          ? [...workingSave.stats.customItems]
          : [],
      };
      const res = await pyRunner.runWorkshop(code, catalog.unlockables || [], workshopSaveInput);
      runBtn.disabled = false;
      runBtn.textContent = '⚒ Run Forge Code';

      if (res.passed) {
        workingSave.appearance = { ...workingSave.appearance, ...res.appearance };
        workingSave.stats = {
          ...workingSave.stats,
          ...res.stats,
          arrows: Number(res.inventory?.arrows ?? workingSave.stats?.arrows) || 0,
          potions: Number(res.inventory?.potions ?? workingSave.stats?.potions) || 0,
          customItems: Array.isArray(res.customItems)
            ? [...res.customItems]
            : Array.isArray(workingSave.stats?.customItems)
              ? [...workingSave.stats.customItems]
              : [],
          completedWorkshopChallenges: Array.isArray(workingSave.stats?.completedWorkshopChallenges)
            ? [...workingSave.stats.completedWorkshopChallenges]
            : [],
        };
        workingSave.ownedUnlockIds = [...res.ownedUnlockIds];
        workingSave.byteShards = res.byteShards;

        shardsPill.textContent = `💎 ${workingSave.byteShards} Byte Shards`;
        if (balanceVal) balanceVal.textContent = String(workingSave.byteShards);
        statsPill.textContent = `Charisma: ${workingSave.stats.charisma} · Courage: ${workingSave.stats.courage}`;
        codeEl.value = '';
        refreshCartAndCatalog();

        audio.playForge();
        outputEl.className = 'pip-console success';
        outputEl.innerHTML = `
          <div class="pip-console-header">⚒ Bram cheers!</div>
          <div class="pip-console-body" style="white-space:pre-line;">${escapeHtml(res.stdout.trim() || 'Gear forged and equipped!')}</div>
        `;

        if (onSaveUpdated) {
          onSaveUpdated(workingSave);
        }
      } else {
        audio.playError();
        const shardMatch = String(res.errorMessage || '').match(
          /Not enough Byte Shards for (.+?)! You need (\d+) Shards, but you have (\d+)/i
        );
        if (shardMatch) {
          const itemName = shardMatch[1];
          const neededCost = Number(shardMatch[2]);
          const leftAtFailure = Number(shardMatch[3]);
          const spentEarlier = Math.max(0, startShards - leftAtFailure);
          const missing = Math.max(1, neededCost - leftAtFailure);
          const lineTag = res.errorLine ? ` on <strong>Line ${Number(res.errorLine)}</strong>` : '';
          if (res.errorLine) {
            const errLn = Number(res.errorLine);
            wsGutter.setMarks(
              new Map([[errLn, { kind: 'hl-error', icon: '⚠️', badge: `⚠️ OVER BUDGET (need ${missing} more 💎)` }]])
            );
            wsGutter.scrollToLine(errLn);
          }
          outputEl.className = 'pip-console error ws-insufficient-alert';
          outputEl.innerHTML = `
            <div class="pip-console-header">🔒 Over budget${lineTag} — nothing was spent!</div>
            <div class="pip-console-body">
              ${
                spentEarlier > 0
                  ? `You have <strong>${startShards} 💎</strong> total. Earlier lines used <strong>${spentEarlier} 💎</strong> (leaving <strong>${leftAtFailure} 💎</strong>), then <strong>${escapeHtml(itemName)}</strong>${lineTag} costs <strong>${neededCost} 💎</strong> (short by <strong>${missing} 💎</strong>). Delete${res.errorLine ? ` Line ${Number(res.errorLine)}` : ' a line'} and run again!`
                  : `You have <strong>${startShards} 💎</strong>, and <strong>${escapeHtml(itemName)}</strong>${lineTag} costs <strong>${neededCost} 💎</strong> — earn <strong>${missing} more Byte Shards</strong> from Trials or hidden chests!`
              }
            </div>
          `;
        } else {
          if (res.errorLine) {
            const errLn = Number(res.errorLine);
            wsGutter.setMarks(
              new Map([[errLn, { kind: 'hl-error', icon: '⚠️', badge: 'check this line' }]])
            );
            wsGutter.scrollToLine(errLn);
          }
          outputEl.className = 'pip-console error';
          outputEl.innerHTML = `
            <div class="pip-console-header">🐉 Pip's Forge Clue:</div>
            <div class="pip-console-body">${renderSafeMarkdown(res.pipMessage)}</div>
          `;
        }
      }
    };

    runBtn.addEventListener('click', runForge);
    attachCodeEditorKeys(codeEl, runForge);
    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }

  // ==================== DRAGON RESCUE MODAL ====================
  openDragonRescueModal({ realm, spriteKey, eraKey, alreadyRescued, onConfirm }) {
    audio.playDragonRescue();
    const dragon = realm.dragon;
    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>🐉 ${escapeHtml(dragon.name)} Rescued!</h2>
          <div class="modal-badges">
            <span class="pill pill-gold">${escapeHtml(dragon.title)}</span>
            <span class="pill pill-blue">Element: ${escapeHtml(dragon.element)}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>

      <div class="dragon-rescue-banner">
        <canvas id="dragon-rescue-canvas" width="64" height="64" class="pixel-canvas dragon-rescue-canvas"></canvas>
        <p class="dialogue-text">"${escapeHtml(dragon.rescueDialogue)}"</p>
      </div>

      <div class="upgrade-callout">
        ✨ ${escapeHtml(realm.miniVisualUpgrade)}
      </div>

      <p class="muted-text">${escapeHtml(realm.storyOutro)}</p>

      <div class="modal-footer">
        <button id="btn-dragon-continue" class="btn btn-primary btn-lg">
          ${alreadyRescued ? 'Continue Exploring' : '✦ Claim Dragon Bit & Unlock Portal!'}
        </button>
      </div>
      `,
      'modal-compact'
    );

    const canvas = this.content.querySelector('#dragon-rescue-canvas');
    if (canvas) {
      let tick = 0;
      const drawDragon = () => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;
        const bob = Math.round(Math.sin(tick * 0.45) * 3);
        this.sprites.drawNpc(ctx, spriteKey, eraKey, 8, 8 + bob, 48, 48);
        tick += 1;
      };
      drawDragon();
      const iv = setInterval(drawDragon, 140);
      this.addCleanup(() => clearInterval(iv));
    }

    const done = () => {
      this.close();
      if (onConfirm) onConfirm();
    };
    this.content.querySelector('#btn-dragon-continue')?.addEventListener('click', done);
    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', done);
    });
  }

  // ==================== HERO CODE DISPLAY MODAL ====================
  openHeroCodeDisplayModal({ heroName, heroCode, parentLinkToken = '', title, subtitle, onPollLinked }) {
    audio.playSuccess();
    const linkUrl = parentLinkToken
      ? `${window.location.origin}/console?link=${encodeURIComponent(parentLinkToken)}`
      : '';
    let qrSvg = '';
    if (linkUrl) {
      try {
        qrSvg = renderQrSvg(linkUrl, {
          size: 168,
          quietZone: 4,
          label: `Scan to link ${heroName || 'Hero'} to Parent Console`,
        });
      } catch {
        qrSvg = '';
      }
    }

    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>${escapeHtml(title || '☁️ Saved to Cloud!')}</h2>
          <div class="modal-badges">
            <span class="pill pill-gold">🧙 ${escapeHtml(heroName || 'Hero')}</span>
            <span class="pill pill-green">☁️ Cloud Save Active</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close aria-label="Close">✕</button>
      </div>

      <div class="hero-code-zones">
        <div class="hero-code-box">
          <div class="hero-code-zone-label">🔑 For You — Secret Hero Code</div>
          <div id="hero-code-value" class="hero-code-display"></div>
          <button id="btn-copy-hero-code" type="button" class="btn btn-gold">📋 Copy Hero Code</button>
          <p class="muted-text" style="margin:0; font-size:12.5px;">
            ${escapeHtml(
              subtitle ||
                'Your secret key to play on any tablet or computer! Shown only once — write it down or copy it.'
            )}
          </p>
        </div>

        ${
          linkUrl
            ? `
            <div id="hero-code-parent-zone" class="parent-link-zone">
              <div class="hero-code-zone-label">👤 Back Up &amp; Track Progress</div>
              <h3>Scan to Link to an Account</h3>
              <p class="muted-text" style="margin:0; font-size:12.5px;">
                Connect to your account or a parent's phone to sync progress, tune difficulty &amp; Pip hints, and recover this hero anytime.
              </p>
              ${qrSvg ? `<div class="qr-card">${qrSvg}</div>` : ''}
              <a href="${escapeHtml(linkUrl)}" class="parent-same-device-link">
                Already on your device? Link in Console →
              </a>
            </div>
            `
            : ''
        }
      </div>

      <p class="muted-text" style="margin-top:6px; font-size:12.5px;">
        <strong>Want to link later?</strong> No problem — tap <strong>🔗 Link Account</strong> on the title screen anytime.
      </p>

      <div class="modal-footer">
        <button class="btn btn-primary" data-close>I Saved My Code — Keep Playing!</button>
      </div>
      `,
      'modal-compact',
      { allowBackdropClose: false }
    );

    const codeEl = this.content.querySelector('#hero-code-value');
    if (codeEl) codeEl.textContent = String(heroCode || '');

    const copyBtn = this.content.querySelector('#btn-copy-hero-code');
    copyBtn?.addEventListener('click', async () => {
      audio.playClick();
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

    if (linkUrl && typeof onPollLinked === 'function') {
      const iv = setInterval(async () => {
        try {
          const linked = await onPollLinked();
          if (linked) {
            clearInterval(iv);
            audio.playSuccess();
            const zone = this.content.querySelector('#hero-code-parent-zone');
            if (zone) {
              zone.classList.add('linked');
              zone.innerHTML = `
                <div class="pill pill-green">✓ Linked to Account!</div>
                <h3>${escapeHtml(heroName || 'Your hero')} is connected to an account</h3>
                <p class="muted-text" style="margin:0; font-size:12.5px;">
                  You can now track progress and generate a fresh Hero Code anytime in the Console.
                </p>
              `;
            }
          }
        } catch {
          // ignore transient poll errors
        }
      }, 3000);
      this.addCleanup(() => clearInterval(iv));
    }

    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }

  // ==================== LINK TO PARENT LATER MODAL ====================
  openLinkToParentModal({ heroName, parentLinkToken, expiresInSeconds = 900, onPollLinked }) {
    audio.playClick();
    const linkUrl = `${window.location.origin}/console?link=${encodeURIComponent(parentLinkToken || '')}`;
    let qrSvg = '';
    try {
      qrSvg = renderQrSvg(linkUrl, {
        size: 184,
        quietZone: 4,
        label: `Scan to link ${heroName || 'Hero'} to Parent Console`,
      });
    } catch {
      qrSvg = '';
    }
    const mins = Math.max(1, Math.round((Number(expiresInSeconds) || 900) / 60));

    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>🔗 Link ${escapeHtml(heroName || 'Hero')} to an Account</h2>
          <div class="modal-badges">
            <span class="pill pill-blue">Valid for ${mins} minutes</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close aria-label="Close">✕</button>
      </div>

      <div id="link-parent-zone" class="parent-link-zone">
        <h3>Scan with a Phone or Open Console</h3>
        <p class="muted-text" style="margin:0; font-size:13px;">
          Scan this QR code on your phone (or a parent's phone) to view live progress, tune settings, and back up your hero. You can create a fresh link anytime.
        </p>
        ${qrSvg ? `<div class="qr-card">${qrSvg}</div>` : ''}
        <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin-top:4px;">
          <button id="btn-copy-parent-link" type="button" class="btn btn-sm btn-gold">🔗 Copy Link</button>
          <a href="${escapeHtml(linkUrl)}" class="btn btn-sm btn-ghost">Open on This Device →</a>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-primary" data-close>Done</button>
      </div>
      `,
      'modal-compact'
    );

    const copyBtn = this.content.querySelector('#btn-copy-parent-link');
    copyBtn?.addEventListener('click', async () => {
      audio.playClick();
      try {
        await navigator.clipboard.writeText(linkUrl);
        copyBtn.textContent = '✓ Link Copied!';
      } catch {
        const ta = document.createElement('textarea');
        ta.value = linkUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          copyBtn.textContent = '✓ Link Copied!';
        } catch {
          copyBtn.textContent = 'Copy Failed';
        }
        ta.remove();
      }
    });

    if (typeof onPollLinked === 'function') {
      const iv = setInterval(async () => {
        try {
          const linked = await onPollLinked();
          if (linked) {
            clearInterval(iv);
            audio.playSuccess();
            const zone = this.content.querySelector('#link-parent-zone');
            if (zone) {
              zone.classList.add('linked');
              zone.innerHTML = `
                <div class="pill pill-green" style="font-size:13px;">✓ Linked to Account!</div>
                <h3>${escapeHtml(heroName || 'Your hero')} is now connected!</h3>
                <p class="muted-text" style="margin:0; font-size:13px;">
                  You can now track progress and recover your hero anytime in the Console.
                </p>
              `;
            }
          }
        } catch {
          // ignore transient poll errors
        }
      }, 3000);
      this.addCleanup(() => clearInterval(iv));
    }

    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }

  // ==================== ENTER HERO CODE MODAL ====================
  openEnterHeroCodeModal({ onRedeem }) {
    audio.playClick();
    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>🔑 Enter Hero Code</h2>
          <div class="modal-badges">
            <span class="pill pill-blue">Load Your Hero</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>

      <p class="dialogue-text">
        Type your secret Hero Code below to continue your adventure on this device!
      </p>

      <div style="display:flex; flex-direction:column; gap:10px;">
        <input
          id="input-hero-code"
          type="text"
          class="hero-code-input"
          placeholder="EMBER-DRAGON-482103"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="40"
        />
        <div class="hero-code-hint">Dashes optional — spaces or no dashes work too!</div>
        <div id="hero-code-error" class="forge-error hidden"></div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button id="btn-submit-hero-code" type="button" class="btn btn-primary">✦ Load Hero</button>
      </div>
      `,
      'modal-compact'
    );

    const inputEl = this.content.querySelector('#input-hero-code');
    const errEl = this.content.querySelector('#hero-code-error');
    const submitBtn = this.content.querySelector('#btn-submit-hero-code');

    const submit = async () => {
      const code = String(inputEl?.value || '').trim().toUpperCase();
      if (!code) {
        if (errEl) {
          errEl.textContent = 'Please enter your Hero Code first!';
          errEl.classList.remove('hidden');
        }
        audio.playError();
        return;
      }
      if (errEl) errEl.classList.add('hidden');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Loading Hero...';
      }
      try {
        await onRedeem(code);
        this.close();
      } catch (err) {
        audio.playError();
        if (errEl) {
          errEl.textContent = err?.detail || err?.message || 'Could not redeem Hero Code. Check spelling and try again.';
          errEl.classList.remove('hidden');
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = '✦ Load Hero';
        }
      }
    };

    submitBtn?.addEventListener('click', submit);
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
    setTimeout(() => inputEl?.focus(), 30);
  }

  // ==================== HERO SESSION EXPIRED MODAL ====================
  openHeroSessionExpiredModal({ heroName, onEnterHeroCode }) {
    audio.playError();
    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>🔑 Hero Code Changed</h2>
          <div class="modal-badges">
            <span class="pill pill-gold">💾 Local Backup Saved</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>

      <p class="dialogue-text">
        Your Hero Code session for <strong>${escapeHtml(heroName || 'your hero')}</strong> was updated or expired.
      </p>
      <p class="muted-text">
        Don't worry — Pip saved a safe backup of your progress right on this device! Get a fresh Hero Code from the Console, or keep playing locally.
      </p>

      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-close>Keep Playing Locally</button>
        <button id="btn-expired-enter-code" type="button" class="btn btn-sky">🔑 Enter Hero Code</button>
      </div>
      `,
      'modal-compact'
    );

    this.content.querySelector('#btn-expired-enter-code')?.addEventListener('click', () => {
      this.close();
      if (onEnterHeroCode) onEnterHeroCode();
    });
    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }

  // ==================== PAUSE / GAME MENU MODAL ====================
  openGameMenuModal({
    save,
    realm,
    eraLabel,
    isGuestCloudflare = false,
    musicEnabled = true,
    muted = false,
    onOpenWorkshop,
    onSaveNow,
    onReturnToTitle,
    onToggleMusic,
    onToggleMute,
    onCycleEra,
    onGetHeroCode,
  }) {
    const heroName = save?.heroName || 'Code-Tamer';
    const realmName = realm?.name || save?.realmId || 'Whispering Meadow';
    const shards = Number(save?.byteShards) || 0;
    const dragons = Array.isArray(save?.rescuedDragons) ? save.rescuedDragons.length : 0;

    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>☰ Game Menu</h2>
          <div class="modal-badges">
            <span class="pill pill-blue">${escapeHtml(eraLabel || '8-Bit NES')}</span>
            <span class="pill pill-muted">${escapeHtml(realmName)}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close aria-label="Close Menu">✕</button>
      </div>

      <div class="game-menu-summary">
        <div class="game-menu-hero-name">${escapeHtml(heroName)}</div>
        <div class="game-menu-stats">
          <span>✦ ${shards} Shards</span>
          <span>·</span>
          <span>🐉 ${dragons} Dragons</span>
        </div>
      </div>

      <div class="game-menu-actions">
        <button id="btn-menu-resume" type="button" class="btn btn-primary btn-lg" data-close>
          ▶ Resume Adventure
        </button>
        <button id="btn-menu-workshop" type="button" class="btn btn-gold">
          ⚒ Open Bram's Workshop
        </button>
        ${
          isGuestCloudflare
            ? '<button id="btn-menu-hero-code" type="button" class="btn btn-sky">☁️ Save to Cloud (Get Hero Code)</button>'
            : ''
        }
        <button id="btn-menu-save" type="button" class="btn btn-ghost">
          💾 Save Progress Now
        </button>
        <button id="btn-menu-title" type="button" class="btn btn-ghost game-menu-title-btn">
          ← Save &amp; Return to Main Title
        </button>
      </div>

      <div class="game-menu-settings">
        <button id="btn-menu-music" type="button" class="btn btn-sm btn-ghost">
          ${musicEnabled ? '🎵 Music: On' : '🎵 Music: Off'}
        </button>
        <button id="btn-menu-mute" type="button" class="btn btn-sm btn-ghost">
          ${muted ? '🔇 SFX: Off' : '🔊 SFX: On'}
        </button>
        <button id="btn-menu-era" type="button" class="btn btn-sm btn-ghost">
          🎨 Style: ${escapeHtml(eraLabel || '8-Bit NES')}
        </button>
      </div>
      `,
      'modal-compact'
    );

    this.content.querySelector('#btn-menu-workshop')?.addEventListener('click', () => {
      audio.playClick();
      this.close();
      if (onOpenWorkshop) onOpenWorkshop();
    });

    this.content.querySelector('#btn-menu-hero-code')?.addEventListener('click', () => {
      audio.playClick();
      this.close();
      if (onGetHeroCode) onGetHeroCode();
    });

    this.content.querySelector('#btn-menu-save')?.addEventListener('click', async () => {
      audio.playClick();
      const btn = this.content.querySelector('#btn-menu-save');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '💾 Saving...';
      }
      try {
        if (onSaveNow) await onSaveNow();
      } finally {
        if (btn && btn.isConnected) {
          btn.disabled = false;
          btn.textContent = '✓ Progress Saved';
        }
      }
    });

    this.content.querySelector('#btn-menu-title')?.addEventListener('click', async () => {
      audio.playClick();
      const btn = this.content.querySelector('#btn-menu-title');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving...';
      }
      this.close();
      if (onReturnToTitle) await onReturnToTitle();
    });

    this.content.querySelector('#btn-menu-music')?.addEventListener('click', () => {
      const nextOn = onToggleMusic ? onToggleMusic() : music.isEnabled();
      const btn = this.content.querySelector('#btn-menu-music');
      if (btn) btn.textContent = nextOn ? '🎵 Music: On' : '🎵 Music: Off';
    });

    this.content.querySelector('#btn-menu-mute')?.addEventListener('click', () => {
      const nextMuted = onToggleMute ? onToggleMute() : audio.isMuted();
      const btn = this.content.querySelector('#btn-menu-mute');
      if (btn) btn.textContent = nextMuted ? '🔇 SFX: Off' : '🔊 SFX: On';
    });

    this.content.querySelector('#btn-menu-era')?.addEventListener('click', async () => {
      const nextLabel = onCycleEra ? await onCycleEra() : eraLabel;
      const btn = this.content.querySelector('#btn-menu-era');
      if (btn && nextLabel) btn.textContent = `🎨 Style: ${nextLabel}`;
      const eraBadge = this.content.querySelector('.modal-badges .pill-blue');
      if (eraBadge && nextLabel) eraBadge.textContent = nextLabel;
    });

    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        audio.playClick();
        this.close();
      });
    });
  }

  // ==================== STYLED CONFIRMATION MODAL ====================
  confirmDialog({
    title = 'Are you sure?',
    badge = '',
    message = '',
    subtext = '',
    confirmLabel = 'Continue',
    confirmClass = 'btn-primary',
    cancelLabel = 'Cancel',
  } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        resolve(Boolean(val));
      };

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>${escapeHtml(title)}</h2>
            ${badge ? `<div class="modal-badges"><span class="pill pill-gold">${escapeHtml(badge)}</span></div>` : ''}
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-cancel aria-label="Close">✕</button>
        </div>
        ${message ? `<p class="dialogue-text">${escapeHtml(message)}</p>` : ''}
        ${subtext ? `<p class="muted-text" style="margin-top:0;">${escapeHtml(subtext)}</p>` : ''}
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button id="btn-confirm-ok" type="button" class="btn ${escapeHtml(confirmClass)}">${escapeHtml(confirmLabel)}</button>
        </div>
        `,
        'modal-compact'
      );

      this.addCleanup(() => finish(false));

      this.content.querySelector('#btn-confirm-ok')?.addEventListener('click', () => {
        audio.playClick();
        finish(true);
        this.close();
      });
      this.content.querySelectorAll('[data-cancel]').forEach((btn) => {
        btn.addEventListener('click', () => {
          audio.playClick();
          finish(false);
          this.close();
        });
      });
    });
  }

  // ==================== SCAN-TO-PLAY CONFIRMATION MODAL ====================
  openPlayLinkConfirmModal({ heroName, currentHeroName = '', onConfirm }) {
    audio.playClick();
    const isSwitching = Boolean(currentHeroName && currentHeroName !== heroName);
    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>${isSwitching ? '🔄 Switch Hero?' : '🔑 Ready to Play!'}</h2>
          <div class="modal-badges">
            <span class="pill pill-gold">🧙 ${escapeHtml(heroName || 'Hero')}</span>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-close aria-label="Close">✕</button>
      </div>

      <p class="dialogue-text">
        ${
          isSwitching
            ? `Switch from <strong>${escapeHtml(currentHeroName)}</strong> to <strong>${escapeHtml(heroName || 'Hero')}</strong> on this device?`
            : `Ready to play as <strong>${escapeHtml(heroName || 'Hero')}</strong> on this device?`
        }
      </p>
      <p class="muted-text" style="margin-top:0;">
        ${
          isSwitching
            ? `${escapeHtml(currentHeroName)}'s cloud progress stays completely safe.`
            : 'Your progress will save automatically to the cloud!'
        }
      </p>
      <div id="play-link-error" class="forge-error hidden"></div>

      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button id="btn-confirm-play-link" type="button" class="btn btn-primary">
          ${isSwitching ? '✦ Switch Hero' : '✦ Play Now!'}
        </button>
      </div>
      `,
      'modal-compact'
    );

    const confirmBtn = this.content.querySelector('#btn-confirm-play-link');
    const errEl = this.content.querySelector('#play-link-error');
    confirmBtn?.addEventListener('click', async () => {
      audio.playClick();
      if (errEl) errEl.classList.add('hidden');
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Loading Hero...';
      try {
        if (onConfirm) await onConfirm();
        this.close();
      } catch (err) {
        audio.playError();
        if (errEl) {
          errEl.textContent = err?.detail || err?.message || 'Could not load hero. Try entering the Hero Code instead.';
          errEl.classList.remove('hidden');
        }
        confirmBtn.disabled = false;
        confirmBtn.textContent = isSwitching ? '✦ Switch Hero' : '✦ Play Now!';
      }
    });

    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }

  // ==================== SCAN-TO-PLAY EXPIRED / INVALID MODAL ====================
  openPlayLinkInvalidModal({ message, onEnterHeroCode }) {
    audio.playError();
    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>🐉 Play Link Expired</h2>
          <div class="modal-badges">
            <span class="pill pill-rose">Link Unavailable</span>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-close aria-label="Close">✕</button>
      </div>

      <p class="dialogue-text">
        ${escapeHtml(message || 'That play link has expired or was replaced by a newer Hero Code.')}
      </p>
      <p class="muted-text" style="margin-top:0;">
        Generate a fresh QR code in the Console, or type your Hero Code below!
      </p>

      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-close>Close</button>
        <button id="btn-invalid-enter-code" type="button" class="btn btn-sky">🔑 Enter Hero Code Instead</button>
      </div>
      `,
      'modal-compact'
    );

    this.content.querySelector('#btn-invalid-enter-code')?.addEventListener('click', () => {
      this.close();
      if (onEnterHeroCode) onEnterHeroCode();
    });
    this.content.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });
  }
}
