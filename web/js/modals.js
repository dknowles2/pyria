// Interactive Modals: NPC Dialogue, Chest Pickup, Python Trial, Bram's Workshop, Dragon Rescue

import { audio } from './audio.js?v=20261126x';
import { music } from './music.js?v=20261126x';
import { pyRunner } from './pyRunner.js?v=20261126x';
import {
  attachAutocomplete,
  buildTrialSuggestions,
  buildWorkshopSuggestions,
} from './autocomplete.js?v=20261126x';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_QUICK_KEYS = [
  { label: 'Tab (4 sp)', insert: '    ', cursorOffset: 4 },
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
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (onRun) onRun();
    }
  });
}

export function resolveDifficulty(gameConfig, realm, trial) {
  const base = {
    mode: 'standard',
    showRawTracebacks: false,
    maxHintsAllowed: 3,
  };
  return {
    ...base,
    ...(gameConfig?.globalDifficultyOverride || {}),
    ...(realm?.difficultyOverride || {}),
    ...(trial?.difficultyOverride || {}),
  };
}

export class ModalManager {
  constructor(backdropEl, contentEl, { sprites, onPauseChange }) {
    this.backdrop = backdropEl;
    this.content = contentEl;
    this.sprites = sprites;
    this.onPauseChange = onPauseChange;
    this.cleanupFns = [];

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) {
        this.close();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.backdrop.classList.contains('hidden')) {
        this.close();
      }
    });
  }

  open(html, sizeClass = '') {
    this.runCleanups();
    this.content.className = `modal-card ${sizeClass}`.trim();
    this.content.innerHTML = html;
    this.backdrop.classList.remove('hidden');
    if (this.onPauseChange) this.onPauseChange(true);
  }

  close() {
    this.runCleanups();
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
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>
      <div class="dragon-rescue-banner">
        <p class="dialogue-text">
          You found <strong style="color: var(--accent-gold);">+${Number(shardReward) || 0} Byte Shards</strong>!
        </p>
        <p class="muted-text">You now have <strong>${Number(totalShards) || 0} Byte Shards</strong> to spend at Bram's Workshop.</p>
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
    const diff = resolveDifficulty(gameConfig, realm, trial);
    let currentMode = diff.mode || 'standard';
    let hintsUsed = 0;
    const baseMaxHints = diff.maxHintsAllowed ?? 3;
    const maxHints = Math.min(4, baseMaxHints + (bonusHints > 0 ? bonusHints : 0));

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

    const renderCompletedSummary = () => {
      const useTrainingSpells = era?.id !== 'era-02-16bit' && (Number(realm?.number) || 1) <= 3;
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
            <strong>Objective:</strong> ${escapeHtml(trial.objective)}
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
        if (trial.trialType === 'multiple_choice') {
          renderMultipleChoiceView(true);
        } else {
          renderEditorView(true);
        }
      });
    };

    const renderCelebrationView = ({ stdout, explanation, isPractice }) => {
      const kit = trial.isBonus && trial.bonusKitReward && !isPractice ? trial.bonusKitReward : null;
      const canEquipKit = Boolean(kit && kit.equipLayer && kit.equipKey);

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>✓ ${escapeHtml(trial.title)}</h2>
            <div class="modal-badges">
              <span class="pill pill-green">${isPractice ? '✓ PRACTICE COMPLETE' : trial.isBonus ? '✦ BONUS TRIAL COMPLETE' : '✓ TRIAL COMPLETE'}</span>
              <span class="pill pill-blue">${escapeHtml(realm.name)}</span>
            </div>
          </div>
          <button class="btn btn-sm btn-ghost" data-close>✕</button>
        </div>

        <div class="trial-complete-card">
          <div class="trial-complete-icon">✓</div>
          <h3 class="trial-complete-title">${isPractice ? 'Great Practice Run!' : trial.isBonus ? '🌟 Hidden Bonus Complete!' : '🎉 Trial Complete!'}</h3>
          <p class="dialogue-text">
            ${
              isPractice
                ? 'Chirp! Spot-on answer again! (Byte Shards were already claimed for this Trial.)'
                : `Chirp! Pip does a backflip! You earned <strong style="color: var(--accent-gold);">+${trial.shardReward} Byte Shards</strong> and saved your progress!`
            }
          </p>
          ${
            kit
              ? `
                <div class="kit-reward-card">
                  <div class="pill pill-violet">🎁 Personal Kit Reward Unlocked (FREE!)</div>
                  <strong style="font-size:16px; color:var(--accent-gold);">${escapeHtml(kit.name)}</strong>
                  <div class="muted-text" style="margin:0;">${escapeHtml(kit.description || '')}</div>
                  <div class="pill pill-gold">✨ +1 Bonus Hint Earned!</div>
                  ${canEquipKit ? `<button id="btn-equip-kit-now" type="button" class="btn btn-gold btn-sm">✨ Equip Now!</button>` : ''}
                </div>
              `
              : ''
          }
          ${explanation ? `<div class="objective-box" style="width:100%; text-align:left;"><strong>🐉 Pip explains:</strong> ${escapeHtml(explanation)}</div>` : ''}
          ${!isPractice && unlockNote ? `<div class="upgrade-callout" style="width:100%;">✨ ${escapeHtml(unlockNote)}</div>` : ''}
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

        <p class="dialogue-text">${escapeHtml(trial.storyPrompt)}</p>

        <div class="objective-box">
          <strong>Question:</strong> ${escapeHtml(trial.objective)}
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
        if (hintsUsed >= maxHints) return;
        audio.playClick();
        hintsUsed += 1;
        hintsArea.classList.remove('hidden');

        const shown = hintTiers.slice(0, hintsUsed).map((t) => {
          const text = t.customText ?? trial.hints?.[t.key] ?? '';
          return `
            <div class="hint-box" style="margin-bottom:8px;">
              <div class="hint-box-title">🐉 ${escapeHtml(t.label)}</div>
              <div>${escapeHtml(text)}</div>
            </div>
          `;
        });
        hintsArea.innerHTML = shown.join('');

        if (hintsUsed >= maxHints) {
          hintBtn.textContent = `💡 All ${maxHints} Hints Shown`;
          hintBtn.disabled = true;
        } else {
          hintBtn.textContent = `💡 Ask Pip (Hint ${hintsUsed + 1}/${maxHints})`;
        }
      });

      this.content.querySelectorAll('.mc-choice-card').forEach((card) => {
        card.addEventListener('click', async () => {
          const choiceId = card.dataset.choiceId;
          const choice = choices.find((c) => c.id === choiceId);
          if (!choice) return;
          const isCorrect = choice.id === trial.correctChoiceId;

          if (onAttempt) {
            onAttempt({
              trialId: trial.id,
              passed: isCorrect,
              hintsUsed,
              code: `choice:${choice.id} (${choice.label})`,
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
            card.classList.add('wrong');
            audio.playError();
            outputEl.className = 'pip-console error';
            outputEl.innerHTML = `
              <div class="pip-console-header">🐉 Not quite — try another choice!</div>
              <div class="pip-console-body">${escapeHtml(choice.explanation || 'Look closely at each line of the Python spell and try again!')}</div>
            `;
          }
        });
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

      const useTrainingSpells = era?.id !== 'era-02-16bit' && (Number(realm?.number) || 1) <= 3;
      const trialQuickKeys = getQuickKeysForContext({ useTrainingSpells });
      const isFixBug = trial.trialType === 'fix_bug';
      const hasHashComment = (code) => /^\s*#/m.test(code || '');
      const showCommentTip = (Number(realm?.number) || 1) <= 3 && hasHashComment(initialCode);
      const ensureTrailingEditableLine = (code) => {
        if (!code) return '';
        const lines = code.split('\n');
        const last = lines[lines.length - 1];
        if (/^\s*#/.test(last)) return `${code}\n`;
        return code;
      };
      const editableInitialCode = ensureTrailingEditableLine(initialCode);

      this.open(
        `
        <div class="modal-header">
          <div>
            <h2>${isPractice ? '✓ ' : isFixBug ? '🐛 ' : '★ '}${escapeHtml(trial.title)}</h2>
            <div class="modal-badges">
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

        <p class="dialogue-text">${escapeHtml(trial.storyPrompt)}</p>

        <div class="objective-box">
          <strong>Objective:</strong> ${escapeHtml(trial.objective)}
          ${unlockItem ? `<div class="muted-text">Unlocks in Bram's Workshop: <strong>${escapeHtml(unlockItem.name)}</strong> (<code>${escapeHtml(unlockItem.functionCall)}</code>)</div>` : ''}
        </div>

        ${
          isFixBug
            ? `
              <div class="bug-banner">
                <div class="bug-banner-title">🐛 Fix the Bug!</div>
                <div>${escapeHtml(trial.bugSummary || 'Lord Null sabotaged this spell — find and fix the bug, then run it!')}</div>
              </div>
            `
            : ''
        }

        <div id="trial-comment-tip" class="comment-tip-banner ${showCommentTip ? '' : 'hidden'}">
          <strong>💬 What are <code>#</code> lines?</strong>
          Lines starting with <code>#</code> are <strong>comments</strong> — helpful notes that Python completely ignores. Type your real Python code on a <strong>new line without <code>#</code></strong>!
        </div>

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
          <textarea id="trial-code" class="code-editor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" inputmode="text" placeholder="Click or tap here and type your Python spell...">${escapeHtml(editableInitialCode)}</textarea>
        </div>

        <div class="editor-actions">
          <button id="btn-trial-run" class="btn btn-primary">▶ Run Python Spell</button>
          <button id="btn-trial-hint" class="btn btn-gold" ${maxHints === 0 ? 'disabled' : ''}>
            💡 Ask Pip (Hint 1/${maxHints})
          </button>
          <button id="btn-trial-reset" class="btn btn-ghost">↺ Reset Code</button>
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

      const syncCommentTip = (code) => {
        if (!commentTipEl) return;
        const shouldShow = (Number(realm?.number) || 1) <= 3 && hasHashComment(code);
        commentTipEl.classList.toggle('hidden', !shouldShow);
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

      const updateModeButtons = () => {
        this.content.querySelectorAll('[data-mode]').forEach((b) => {
          b.classList.toggle('btn-sky', b.dataset.mode === currentMode);
          b.classList.toggle('btn-ghost', b.dataset.mode !== currentMode);
        });
        diffBadge.textContent = `Mode: ${currentMode}`;
      };
      updateModeButtons();

      this.content.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
          currentMode = btn.dataset.mode;
          codeEl.value = ensureTrailingEditableLine(trial.starterCode[currentMode] || '');
          syncCommentTip(codeEl.value);
          draftBadge?.classList.add('hidden');
          if (!isPractice && onDraftClear) onDraftClear();
          updateModeButtons();
          audio.playClick();
        });
      });

      resetBtn.addEventListener('click', () => {
        codeEl.value = ensureTrailingEditableLine(trial.starterCode[currentMode] || '');
        syncCommentTip(codeEl.value);
        draftBadge?.classList.add('hidden');
        if (!isPractice && onDraftClear) onDraftClear();
        audio.playClick();
      });

      hintBtn.addEventListener('click', () => {
        if (hintsUsed >= maxHints) return;
        audio.playClick();
        hintsUsed += 1;
        hintsArea.classList.remove('hidden');

        const shown = hintTiers.slice(0, hintsUsed).map((t) => {
          const text = t.customText ?? trial.hints?.[t.key] ?? '';
          return `
            <div class="hint-box" style="margin-bottom:8px;">
              <div class="hint-box-title">🐉 ${escapeHtml(t.label)}</div>
              <div>${escapeHtml(text)}</div>
            </div>
          `;
        });
        hintsArea.innerHTML = shown.join('');

        if (hintsUsed >= maxHints) {
          hintBtn.textContent = `💡 All ${maxHints} Hints Shown`;
          hintBtn.disabled = true;
        } else {
          hintBtn.textContent = `💡 Ask Pip (Hint ${hintsUsed + 1}/${maxHints})`;
        }
      });

      const runSpell = async () => {
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

        const result = await pyRunner.runTrial(code, trial.testCode, diff.showRawTracebacks);
        runBtn.disabled = false;
        runBtn.textContent = '▶ Run Python Spell';

        if (onAttempt) {
          onAttempt({ trialId: trial.id, passed: result.passed, hintsUsed, code });
        }

        if (result.passed) {
          audio.playSuccess();
          skipFlushOnClose = true;
          if (!isPractice && onDraftClear) {
            onDraftClear({ skipPersist: true });
          }
          // Immediately persist solved state so closing/Escape can never lose progress!
          if (onSolved) {
            await onSolved(trial);
          }
          renderCelebrationView({ stdout: result.stdout, isPractice });
        } else {
          audio.playError();
          outputEl.className = 'pip-console error';
          outputEl.innerHTML = `
            <div class="pip-console-header">🐉 Pip's Clue:</div>
            <div class="pip-console-body">${escapeHtml(result.pipMessage)}</div>
            ${result.stdout ? `<div class="console-stdout">Your print() output:\n${escapeHtml(result.stdout)}</div>` : ''}
            ${result.rawTraceback ? `<div class="console-traceback">${escapeHtml(result.rawTraceback)}</div>` : ''}
          `;
        }
      };

      runBtn.addEventListener('click', runSpell);
      attachCodeEditorKeys(codeEl, runSpell);
      this.content.querySelectorAll('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.close());
      });
    };

    if (alreadySolved) {
      renderCompletedSummary();
    } else if (trial.trialType === 'multiple_choice') {
      renderMultipleChoiceView(false);
    } else {
      renderEditorView(false);
    }
  }

  // ==================== BRAM'S WORKSHOP MODAL ====================
  openWorkshopModal({ catalog, save, eraKey, onSaveUpdated }) {
    audio.playClick();
    music.setDucked(true);
    let workingSave = structuredClone(save);
    let previewDirIndex = 0;
    const dirs = ['down', 'right', 'up', 'left'];
    let previewFrame = 0;

    const normalizeCall = (line) =>
      String(line || '')
        .trim()
        .replace(/'/g, '"')
        .replace(/\s+/g, '');

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
      return null;
    };

    const estimateCart = (codeText) => {
      const seenOwned = new Set(workingSave.ownedUnlockIds || []);
      const queuedIds = new Set();
      let totalCost = 0;
      const lines = String(codeText || '').split('\n');
      const items = [];
      for (const rawLine of lines) {
        const item = matchUnlockableForLine(rawLine);
        if (!item) continue;
        queuedIds.add(item.id);
        const alreadyOwned = seenOwned.has(item.id);
        const cost = alreadyOwned ? 0 : Number(item.shardCost) || 0;
        if (!alreadyOwned) {
          seenOwned.add(item.id);
          totalCost += cost;
        }
        items.push({ id: item.id, name: item.name, cost, alreadyOwned });
      }
      const currentShards = Number(workingSave.byteShards) || 0;
      return {
        currentShards,
        totalCost,
        remaining: currentShards - totalCost,
        items,
        queuedIds,
      };
    };

    const renderCatalogHtml = (cart = null) => {
      const owned = new Set(workingSave.ownedUnlockIds || []);
      const currentShards = Number(workingSave.byteShards) || 0;
      const effectiveBudget = cart ? Math.max(0, cart.remaining) : currentShards;
      const queuedIds = cart ? cart.queuedIds : new Set();
      return (catalog.unlockables || [])
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
                <div class="catalog-item-desc">${escapeHtml(item.description)}</div>
              </div>
              <div class="catalog-item-badge">${badge}</div>
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
        "No buttons in my shop, kid! Click any blueprint below to add its Python call, watch your live shard budget, then press <strong>Run Forge Code</strong>!"
      </p>

      <div class="workshop-grid">
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div class="preview-stage" style="padding:10px;">
            <canvas id="ws-preview-canvas" width="160" height="104" class="pixel-canvas" style="width:200px; height:130px;"></canvas>
            <div class="preview-controls">
              <button id="ws-turn-btn" class="btn btn-sm btn-ghost">↻ Turn Hero</button>
            </div>
          </div>
          <div id="ws-balance-banner" class="ws-balance-banner">
            💎 Your Byte Shards: <strong id="ws-balance-value">${Number(workingSave.byteShards) || 0}</strong>
          </div>
          <div id="ws-catalog" class="catalog-list">
            ${renderCatalogHtml()}
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:12px;">
          <div id="ws-cart-bar" class="ws-cart-bar"></div>
          ${renderQuickKeysHtml('ws-quick-keys', wsQuickKeys)}
          <div class="code-editor-shell">
            <div class="code-editor-bar">
              <span class="code-editor-cta">⚒ FORGE CODE BOX</span>
              <span class="code-editor-sub">Click items on the left or type below</span>
            </div>
            <textarea id="ws-code" class="code-editor" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" inputmode="text" placeholder="Click any blueprint on the left or type wear_hat(&quot;explorer&quot;)..."></textarea>
          </div>
          <div class="editor-actions">
            <button id="ws-run-btn" class="btn btn-gold">⚒ Run Forge Code</button>
            <button id="ws-clear-btn" class="btn btn-ghost">Clear</button>
          </div>
          <div id="ws-output" class="pip-console">
            <div class="pip-console-header">⚒ Bram says:</div>
            <div class="pip-console-body">Click a blueprint on the left (or type a call like <code>wear_hat("explorer")</code>) and press <strong>Run Forge Code</strong>!</div>
          </div>
        </div>
      </div>
      `,
      'modal-wide'
    );

    const previewCanvas = this.content.querySelector('#ws-preview-canvas');
    const catalogEl = this.content.querySelector('#ws-catalog');
    const cartBarEl = this.content.querySelector('#ws-cart-bar');
    const codeEl = this.content.querySelector('#ws-code');
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

    const refreshCartAndCatalog = () => {
      const cart = estimateCart(codeEl.value);
      if (cartBarEl) {
        if (cart.items.length === 0) {
          cartBarEl.className = 'ws-cart-bar';
          cartBarEl.innerHTML = `
            <span>💎 Have: <strong>${cart.currentShards}</strong></span>
            <span class="muted-text">Add blueprints on the left to preview your total cost</span>
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
          cartBarEl.className = 'ws-cart-bar over';
          cartBarEl.innerHTML = `
            <span>💎 Have: <strong>${cart.currentShards}</strong></span>
            <span>− 🛒 Order (${cart.items.length}): <strong>${cart.totalCost}</strong></span>
            <span>= 🔒 <strong>Short by ${shortBy} 💎!</strong> Remove a line before running.</span>
          `;
        }
      }
      catalogEl.innerHTML = renderCatalogHtml(cart);
      wireCatalogClicks();
    };

    const wireCatalogClicks = () => {
      catalogEl.querySelectorAll('.catalog-item').forEach((el) => {
        el.addEventListener('click', () => {
          const call = el.dataset.call;
          const current = codeEl.value.trim();
          const lines = current ? current.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')) : [];
          if (!lines.some((l) => normalizeCall(l) === normalizeCall(call))) {
            lines.push(call);
          }
          codeEl.value = lines.join('\n') + '\n';
          codeEl.focus();
          refreshCartAndCatalog();
          audio.playClick();
        });
      });
    };

    codeEl.addEventListener('input', refreshCartAndCatalog);
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
      const startShards = Number(workingSave.byteShards) || 0;
      runBtn.disabled = true;
      runBtn.textContent = 'Forging...';
      audio.playCodeRun();

      const res = await pyRunner.runWorkshop(code, catalog.unlockables || [], workingSave);
      runBtn.disabled = false;
      runBtn.textContent = '⚒ Run Forge Code';

      if (res.passed) {
        workingSave.appearance = { ...workingSave.appearance, ...res.appearance };
        workingSave.stats = { ...workingSave.stats, ...res.stats };
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
          outputEl.className = 'pip-console error ws-insufficient-alert';
          outputEl.innerHTML = `
            <div class="pip-console-header">🔒 Not enough Byte Shards — nothing was spent!</div>
            <div class="pip-console-body">
              ${
                spentEarlier > 0
                  ? `You have <strong>${startShards} 💎</strong> total. Earlier lines in your code used <strong>${spentEarlier} 💎</strong> (leaving <strong>${leftAtFailure} 💎</strong>), so <strong>${escapeHtml(itemName)}</strong> (<strong>${neededCost} 💎</strong>) is short by <strong>${missing} 💎</strong>. Remove a line or forge one item at a time!`
                  : `You have <strong>${startShards} 💎</strong>, and <strong>${escapeHtml(itemName)}</strong> costs <strong>${neededCost} 💎</strong> — earn <strong>${missing} more Byte Shards</strong> from Trials or hidden chests!`
              }
            </div>
          `;
        } else {
          outputEl.className = 'pip-console error';
          outputEl.innerHTML = `
            <div class="pip-console-header">🐉 Pip's Forge Clue:</div>
            <div class="pip-console-body">${escapeHtml(res.pipMessage)}</div>
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
}
