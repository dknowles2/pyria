// Interactive Modals: NPC Dialogue, Chest Pickup, Python Trial, Bram's Workshop, Dragon Rescue

import { audio } from './audio.js';
import { pyRunner } from './pyRunner.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
          You found <strong style="color: var(--accent-gold);">+${shardReward} Byte Shards</strong>!
        </p>
        <p class="muted-text">You now have <strong>${totalShards} Byte Shards</strong> to spend at Bram's Workshop.</p>
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
  openTrialModal({ trial, realm, gameConfig, catalog, save, alreadySolved, onSolved, onAttempt }) {
    audio.playClick();
    const diff = resolveDifficulty(gameConfig, realm, trial);
    let currentMode = diff.mode || 'standard';
    let hintsUsed = 0;
    const maxHints = diff.maxHintsAllowed ?? 3;
    const hintTiers = [
      { key: 'tier1_nudge', label: 'Tier 1: Gentle Nudge' },
      { key: 'tier2_pattern', label: 'Tier 2: Code Pattern' },
      { key: 'tier3_walkthrough', label: 'Tier 3: Step-by-Step' },
    ];

    const unlockItem = trial.unlockId
      ? (catalog.unlockables || []).find((u) => u.id === trial.unlockId)
      : null;

    const conceptLabels = (trial.concepts || []).map((cid) => {
      const found = (gameConfig.conceptProgression || []).find((c) => c.id === cid);
      return found ? found.label : cid;
    });

    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>★ ${escapeHtml(trial.title)}</h2>
          <div class="modal-badges">
            <span class="pill pill-blue">${escapeHtml(realm.name)}</span>
            <span class="pill pill-violet" id="trial-diff-badge">Mode: ${escapeHtml(currentMode)}</span>
            <span class="pill pill-gold">+${trial.shardReward} Byte Shards</span>
            ${alreadySolved ? '<span class="pill pill-green">✓ Solved</span>' : ''}
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

      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <span class="muted-text">Write real Python 3 below (Tab indents 4 spaces, Ctrl/Cmd+Enter runs):</span>
        <div style="display:flex; gap:6px; align-items:center;">
          <span class="muted-text" style="font-size:12px;">Starter:</span>
          <button class="btn btn-sm btn-ghost" data-mode="explorer">Explorer</button>
          <button class="btn btn-sm btn-ghost" data-mode="standard">Standard</button>
          <button class="btn btn-sm btn-ghost" data-mode="challenge">Challenge</button>
        </div>
      </div>

      <textarea id="trial-code" class="code-editor" spellcheck="false" autocomplete="off" autocapitalize="off">${escapeHtml(trial.starterCode[currentMode] || trial.starterCode.standard || '')}</textarea>

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

      <div id="trial-victory-bar" class="modal-footer hidden">
        <button id="btn-trial-claim" class="btn btn-primary btn-lg">✦ Claim Reward & Continue!</button>
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
    const victoryBar = this.content.querySelector('#trial-victory-bar');
    const claimBtn = this.content.querySelector('#btn-trial-claim');
    const diffBadge = this.content.querySelector('#trial-diff-badge');

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
        codeEl.value = trial.starterCode[currentMode] || '';
        updateModeButtons();
        audio.playClick();
      });
    });

    resetBtn.addEventListener('click', () => {
      codeEl.value = trial.starterCode[currentMode] || '';
      audio.playClick();
    });

    hintBtn.addEventListener('click', () => {
      if (hintsUsed >= maxHints) return;
      audio.playClick();
      hintsUsed += 1;
      hintsArea.classList.remove('hidden');

      const shown = hintTiers.slice(0, hintsUsed).map((t) => {
        const text = trial.hints?.[t.key] || '';
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
        outputEl.className = 'pip-console success';
        outputEl.innerHTML = `
          <div class="pip-console-header">🎉 Trial Complete! Pip does a backflip!</div>
          <div class="pip-console-body">${escapeHtml(result.pipMessage)}</div>
          ${result.stdout ? `<div class="console-stdout">Output:\n${escapeHtml(result.stdout)}</div>` : ''}
        `;
        victoryBar.classList.remove('hidden');
        claimBtn.onclick = () => {
          this.close();
          if (onSolved) onSolved(trial);
        };
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
  }

  // ==================== BRAM'S WORKSHOP MODAL ====================
  openWorkshopModal({ catalog, save, eraKey, onSaveUpdated }) {
    audio.playClick();
    let workingSave = structuredClone(save);
    let previewDirIndex = 0;
    const dirs = ['down', 'right', 'up', 'left'];
    let previewFrame = 0;

    const renderCatalogHtml = () => {
      const owned = new Set(workingSave.ownedUnlockIds || []);
      return (catalog.unlockables || [])
        .map((item) => {
          const isOwned = owned.has(item.id);
          const canAfford = workingSave.byteShards >= item.shardCost;
          const badge = isOwned
            ? '<span class="pill pill-green">Owned</span>'
            : canAfford
              ? `<span class="pill pill-gold">✦ ${item.shardCost}</span>`
              : `<span class="pill pill-rose">✦ ${item.shardCost}</span>`;
          return `
            <div class="catalog-item ${isOwned ? 'owned' : ''}" data-call="${escapeHtml(item.functionCall)}">
              <div>
                <div class="catalog-item-title">${escapeHtml(item.name)}</div>
                <div class="catalog-item-call">${escapeHtml(item.functionCall)}</div>
                <div class="catalog-item-desc">${escapeHtml(item.description)}</div>
              </div>
              <div>${badge}</div>
            </div>
          `;
        })
        .join('');
    };

    this.open(
      `
      <div class="modal-header">
        <div>
          <h2>⚒ Bram's Tinkerer Workshop</h2>
          <div class="modal-badges">
            <span class="pill pill-gold" id="ws-shards-pill">✦ ${workingSave.byteShards} Byte Shards</span>
            <span class="pill pill-blue" id="ws-stats-pill">Charisma: ${workingSave.stats.charisma} · Courage: ${workingSave.stats.courage}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" data-close>✕</button>
      </div>

      <p class="muted-text" style="margin-top:-6px;">
        "No buttons in my shop, kid! Click any blueprint below to insert its Python call, then press <strong>Run Forge Code</strong>!"
      </p>

      <div class="workshop-grid">
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div class="preview-stage" style="padding:10px;">
            <canvas id="ws-preview-canvas" width="160" height="104" class="pixel-canvas" style="width:200px; height:130px;"></canvas>
            <div class="preview-controls">
              <button id="ws-turn-btn" class="btn btn-sm btn-ghost">↻ Turn Hero</button>
            </div>
          </div>
          <div id="ws-catalog" class="catalog-list">
            ${renderCatalogHtml()}
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:12px;">
          <textarea id="ws-code" class="code-editor" spellcheck="false" autocomplete="off" autocapitalize="off"># Click any item on the left or type Python calls here!
# Example:
# wear_hat("explorer")
</textarea>
          <div class="editor-actions">
            <button id="ws-run-btn" class="btn btn-gold">⚒ Run Forge Code</button>
            <button id="ws-clear-btn" class="btn btn-ghost">Clear</button>
          </div>
          <div id="ws-output" class="pip-console">
            <div class="pip-console-header">⚒ Bram says:</div>
            <div class="pip-console-body">Write a function call like <code>wear_hat("explorer")</code> and run it to forge & equip gear!</div>
          </div>
        </div>
      </div>
      `,
      'modal-wide'
    );

    const previewCanvas = this.content.querySelector('#ws-preview-canvas');
    const catalogEl = this.content.querySelector('#ws-catalog');
    const codeEl = this.content.querySelector('#ws-code');
    const runBtn = this.content.querySelector('#ws-run-btn');
    const clearBtn = this.content.querySelector('#ws-clear-btn');
    const outputEl = this.content.querySelector('#ws-output');
    const shardsPill = this.content.querySelector('#ws-shards-pill');
    const statsPill = this.content.querySelector('#ws-stats-pill');

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

    const wireCatalogClicks = () => {
      catalogEl.querySelectorAll('.catalog-item').forEach((el) => {
        el.addEventListener('click', () => {
          const call = el.dataset.call;
          const current = codeEl.value.trim();
          const lines = current ? current.split('\n').filter((l) => !l.trim().startsWith('#')) : [];
          lines.push(call);
          codeEl.value = lines.join('\n') + '\n';
          codeEl.focus();
          audio.playClick();
        });
      });
    };
    wireCatalogClicks();

    clearBtn.addEventListener('click', () => {
      codeEl.value = '';
      codeEl.focus();
      audio.playClick();
    });

    const runForge = async () => {
      const code = codeEl.value.trim();
      if (!code) return;
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

        shardsPill.textContent = `✦ ${workingSave.byteShards} Byte Shards`;
        statsPill.textContent = `Charisma: ${workingSave.stats.charisma} · Courage: ${workingSave.stats.courage}`;
        catalogEl.innerHTML = renderCatalogHtml();
        wireCatalogClicks();

        audio.playForge();
        outputEl.className = 'pip-console success';
        outputEl.innerHTML = `
          <div class="pip-console-header">⚒ Bram cheers!</div>
          <div class="pip-console-body">${escapeHtml(res.stdout.trim() || 'Gear forged and equipped!')}</div>
        `;

        if (onSaveUpdated) {
          onSaveUpdated(workingSave);
        }
      } else {
        audio.playError();
        outputEl.className = 'pip-console error';
        outputEl.innerHTML = `
          <div class="pip-console-header">🐉 Pip's Forge Clue:</div>
          <div class="pip-console-body">${escapeHtml(res.pipMessage)}</div>
        `;
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
