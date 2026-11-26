// Pyria: Return of the Bits — Main Application Controller

import {
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
} from './api.js';
import { audio } from './audio.js';
import { pyRunner } from './pyRunner.js';
import { SpriteManager } from './sprites.js';
import { WorldEngine } from './world.js';
import { ModalManager, attachCodeEditorKeys } from './modals.js';

const state = {
  gameConfig: null,
  catalog: null,
  era: null,
  sprites: null,
  world: null,
  modals: null,
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
  ccEraKey: '8bit',
  ccAnimTimer: null,
  titleAnimTimer: null,
};

const DIRS = ['down', 'right', 'up', 'left'];

// ==================== DOM HELPERS ====================
const $ = (sel) => document.querySelector(sel);

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const target = $(`#${screenId}`);
  if (target) target.classList.add('active');

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

function getRealm(realmId) {
  return (state.era?.realms || []).find((r) => r.id === realmId) || state.era?.realms?.[0];
}

function getTrial(trialId) {
  for (const realm of state.era?.realms || []) {
    const found = (realm.trials || []).find((t) => t.id === trialId);
    if (found) return { trial: found, realm };
  }
  return { trial: null, realm: null };
}

// ==================== PERSISTENCE ====================
async function persistSave() {
  if (!state.activeSave || !state.activeSave.id) return;
  try {
    if (state.world && state.activeMap) {
      state.activeSave.position = {
        realmId: state.activeMap.realmId,
        x: Math.floor(state.world.hero.x),
        y: Math.floor(state.world.hero.y),
      };
    }
    const updated = await updateSave(state.activeSave.id, state.activeSave);
    state.activeSave = { ...state.activeSave, ...updated };
  } catch (err) {
    console.warn('Could not persist save:', err);
  }
}

// ==================== HUD UPDATES ====================
function updateHud() {
  const save = state.activeSave;
  if (!save) return;

  $('#hud-hero-name').textContent = save.heroName || 'Code-Tamer';
  const eraKey = save.visualEra === '16bit' ? '16bit' : '8bit';
  $('#hud-era-badge').textContent = eraKey === '16bit' ? '16-Bit View' : '8-Bit Era';
  $('#btn-hud-era-toggle').textContent = eraKey === '16bit' ? '16-Bit' : '8-Bit';
  $('#hud-realm-name').textContent = state.activeRealm?.name || 'Whispering Meadow';
  $('#hud-shards').textContent = String(save.byteShards ?? 0);
  $('#btn-hud-mute').textContent = audio.isMuted() ? '🔇' : '🔊';

  // Hero mini portrait
  const portraitCanvas = $('#hud-portrait');
  if (portraitCanvas && state.sprites) {
    const ctx = portraitCanvas.getContext('2d');
    ctx.clearRect(0, 0, portraitCanvas.width, portraitCanvas.height);
    state.sprites.drawHero(ctx, save.appearance, eraKey, 'down', 0, 0, 0, 32, 32);
  }

  // Rescued dragon badges
  const dragonsEl = $('#hud-dragons');
  const rescued = new Set(save.rescuedDragons || []);
  const verticalSliceDragons = [
    { id: 'dragon-spark', name: 'Spark', icon: '⚡' },
    { id: 'dragon-pebble', name: 'Pebble', icon: '🪨' },
  ];
  dragonsEl.innerHTML = verticalSliceDragons
    .map((d) => {
      const has = rescued.has(d.id);
      return `<span class="dragon-badge ${has ? 'rescued' : ''}">${d.icon} ${d.name}${has ? ' ✓' : ''}</span>`;
    })
    .join('');

  // Dynamic Pip objective tip
  const completed = new Set(save.completedTrials || []);
  let tip = 'Explore the realm! Press E or click nearby to interact.';
  if (save.realmId === 'realm-01-meadow') {
    if (!completed.has('trial-01-01')) {
      tip = 'Talk to Elder Ada or walk north to the Password Statues (Trial 1.1)!';
    } else if (!completed.has('trial-01-02')) {
      tip = 'Head east to the Broken Meadow Bridge (Trial 1.2) to repair the crossing!';
    } else if (!completed.has('trial-01-03')) {
      tip = "Cross the repaired bridge and unlock Spark's Mossy Vault Gate (Trial 1.3)!";
    } else if (!rescued.has('dragon-spark')) {
      tip = "Step into Spark's Logic Vault to rescue Spark and restore Bit 1!";
    } else {
      tip = 'Spark is free! Step into the glowing Portal north of Spark to enter Mossy Ruins!';
    }
  } else if (save.realmId === 'realm-02-ruins') {
    if (!completed.has('trial-02-01')) {
      tip = 'Inspect the Moss Stone Pillars (Trial 2.1) to open the gate into the Chasm Hall!';
    } else if (!completed.has('trial-02-02')) {
      tip = 'Balance the Broken Ruin Bridge (Trial 2.2) to cross into the Ancient Treasury!';
    } else if (!completed.has('trial-02-03')) {
      tip = "Solve Pebble's Treasure Split (Trial 2.3) to unseal Pebble's Vault Gate!";
    } else if (!rescued.has('dragon-pebble')) {
      tip = "Rescue Pebble inside Pebble's Logic Vault to restore Bit 2!";
    } else {
      tip = 'You rescued both Spark and Pebble! Visit the Portal or Bram\'s Workshop to spend your Byte Shards!';
    }
  }
  $('#hud-objective').textContent = tip;
}

// ==================== TITLE & SAVE PICKER ====================
async function refreshSavesList() {
  const listEl = $('#saves-list');
  const countEl = $('#saves-count');
  try {
    const saves = await listSaves();
    countEl.textContent = `${saves.length} ${saves.length === 1 ? 'Hero' : 'Heroes'}`;
    if (saves.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state">No saved heroes yet. Click <strong>Start New Adventure</strong> to forge your first Code-Tamer!</div>';
      return;
    }

    listEl.innerHTML = '';
    for (const s of saves) {
      const realm = getRealm(s.realmId);
      const card = document.createElement('div');
      card.className = 'save-card';
      card.innerHTML = `
        <div class="save-card-info">
          <div class="save-card-name">${s.heroName}</div>
          <div class="save-card-meta">
            ${realm ? realm.name : s.realmId} · ✦ ${s.byteShards} Shards · 🐉 ${(s.rescuedDragons || []).length} Dragons
          </div>
        </div>
        <button class="btn btn-sm btn-primary">Continue →</button>
      `;
      card.addEventListener('click', async () => {
        audio.playClick();
        try {
          const fullSave = s.id ? await getSave(s.id) : s;
          await enterOverworld(fullSave);
        } catch (err) {
          console.error(err);
          await enterOverworld(s);
        }
      });
      listEl.appendChild(card);
    }
  } catch (err) {
    countEl.textContent = 'Offline';
    listEl.innerHTML = `<div class="empty-state">Could not reach save server: ${err.message}</div>`;
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
  $('#preview-val-name').textContent = state.ccAppearance.name || 'Code-Tamer';
  $('#preview-val-skin').textContent = state.ccAppearance.skin;
  $('#preview-val-hair').textContent = state.ccAppearance.hair;
  $('#preview-val-tunic').textContent = state.ccAppearance.tunic;
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
  state.ccEraKey = '8bit';
  $('#btn-preview-era').textContent = '8-Bit View';
  $('#charcreate-code').value = cc.starterCode || '';
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
    state.sprites.drawHeroAndPipPreview(canvas, state.ccAppearance, state.ccEraKey, DIRS[state.ccDirIndex], frame);
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
    updateCharCreateSummary();
  }

  if (res.passed) {
    audio.playSuccess();
    outEl.className = 'pip-console success';
    outEl.innerHTML = `
      <div class="pip-console-header">🎉 Hero Forged!</div>
      <div class="pip-console-body">${res.stdout ? res.stdout.trim() : 'Preview updated!'}</div>
    `;

    if (res.confirmed) {
      if (state.ccAnimTimer) {
        clearInterval(state.ccAnimTimer);
        state.ccAnimTimer = null;
      }
      const newSavePayload = createDefaultSaveState(state.ccAppearance.name || 'Rowan', {
        skin: state.ccAppearance.skin,
        hair: state.ccAppearance.hair,
        tunic: state.ccAppearance.tunic,
      });
      try {
        const created = await createSave(newSavePayload);
        await enterOverworld(created);
        showToast(`Welcome to Pyria, ${created.heroName}!`);
      } catch (err) {
        outEl.className = 'pip-console error';
        outEl.innerHTML = `
          <div class="pip-console-header">⚠️ Could not save hero</div>
          <div class="pip-console-body">${err.message}</div>
        `;
      }
    }
  } else {
    audio.playError();
    outEl.className = 'pip-console error';
    outEl.innerHTML = `
      <div class="pip-console-header">🐉 Pip's Clue:</div>
      <div class="pip-console-body">${res.pipMessage}</div>
    `;
  }
}

// ==================== OVERWORLD ENTRY & REALM LOADING ====================
async function loadRealm(realmId, spawnOverride = null) {
  const realm = getRealm(realmId);
  if (!realm) return;
  state.activeRealm = realm;
  state.activeSave.realmId = realm.id;

  let mapData = state.mapsCache.get(realm.id);
  if (!mapData) {
    mapData = await fetchMap(realm.id);
    state.mapsCache.set(realm.id, mapData);
  }
  state.activeMap = mapData;
  state.world.loadMap(mapData, state.activeSave, spawnOverride);
  updateHud();
  showToast(`Entered ${realm.name}!`);
}

async function enterOverworld(save) {
  if (state.titleAnimTimer) {
    clearInterval(state.titleAnimTimer);
    state.titleAnimTimer = null;
  }
  state.activeSave = save;
  showScreen('screen-game');
  state.world.setPaused(false);

  const targetRealm = save.realmId === 'realm-02-ruins' ? 'realm-02-ruins' : 'realm-01-meadow';
  const spawnOverride =
    save.position && save.position.realmId === targetRealm
      ? { x: save.position.x, y: save.position.y }
      : null;

  await loadRealm(targetRealm, spawnOverride);
}

// ==================== ENTITY INTERACTIONS ====================
async function handleEntityInteract(entity) {
  const save = state.activeSave;
  const eraKey = save.visualEra === '16bit' ? '16bit' : '8bit';
  const completed = new Set(save.completedTrials || []);
  const rescued = new Set(save.rescuedDragons || []);

  if (entity.type === 'npc') {
    const npc = getNpc(entity.refId);
    if (entity.refId === 'elder-ada') {
      let msg = state.activeRealm?.storyIntro || npc.personality;
      if (rescued.has('dragon-spark')) {
        msg = `Wonderful work, ${save.heroName}! Spark is free and Bit 1 is restored. Step through the shimmering Portal north of Spark's vault to reach Mossy Ruins and rescue Pebble!`;
      } else if (completed.has('trial-01-01')) {
        msg = `You woke the Signal Stone, ${save.heroName}! Now head east to the Broken Meadow Bridge and cast a two-line print() spell to cross the stream.`;
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

  if (entity.type === 'trial') {
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
    state.modals.openTrialModal({
      trial,
      realm,
      gameConfig: state.gameConfig,
      catalog: state.catalog,
      save,
      alreadySolved,
      onAttempt: (attempt) => {
        logAttempt(save.id, attempt).catch((err) => console.warn('Attempt log failed:', err));
      },
      onSolved: async (solvedTrial) => {
        if (!save.completedTrials.includes(solvedTrial.id)) {
          save.completedTrials.push(solvedTrial.id);
          save.byteShards += Number(solvedTrial.shardReward) || 0;
          showToast(`+${solvedTrial.shardReward} Byte Shards! Path unlocked!`);
        } else {
          showToast(`Re-solved ${solvedTrial.title}!`);
        }
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
    state.modals.openDragonRescueModal({
      realm,
      spriteKey: entity.spriteKey,
      eraKey,
      alreadyRescued,
      onConfirm: async () => {
        if (!alreadyRescued) {
          save.rescuedDragons.push(entity.refId);
          // Automatic visual flourish when rescuing Spark!
          if (entity.refId === 'dragon-spark') {
            showToast('✨ Bit 1 Restored! Meadow fireflies awakened & Portal unlocked!');
          } else if (entity.refId === 'dragon-pebble') {
            showToast('✨ Bit 2 Restored! Mossy Ruins awakened!');
          }
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
    if (entity.refId === 'realm-02-ruins') {
      if (!rescued.has('dragon-spark')) {
        showToast('Talk to Spark in the vault right below first to rescue them!');
        return;
      }
      audio.playPortal();
      await loadRealm('realm-02-ruins');
      await persistSave();
    } else if (entity.refId === 'realm-03-cavern') {
      audio.playDragonRescue();
      state.modals.openNpcDialogue({
        npc: getNpc('elder-ada'),
        spriteKey: 'elder_ada',
        eraKey,
        message: `Bravo, ${save.heroName}! You conquered both Whispering Meadow and Mossy Ruins and rescued Spark & Pebble! Cinder Cavern awaits in the next chapter — feel free to return to Whispering Meadow or forge more gear at Bram's Workshop!`,
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
  const eraKey = save.visualEra === '16bit' ? '16bit' : '8bit';
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

// ==================== WIRE UI EVENTS ====================
function wireControls() {
  // Title
  $('#btn-new-adventure').addEventListener('click', () => {
    audio.playClick();
    openCharCreateScreen();
  });

  // Character Creation
  $('#btn-charcreate-back').addEventListener('click', async () => {
    audio.playClick();
    if (state.ccAnimTimer) {
      clearInterval(state.ccAnimTimer);
      state.ccAnimTimer = null;
    }
    showScreen('screen-title');
    startTitlePreview();
    await refreshSavesList();
  });

  $('#btn-preview-turn').addEventListener('click', () => {
    state.ccDirIndex = (state.ccDirIndex + 1) % DIRS.length;
    audio.playClick();
  });

  $('#btn-preview-era').addEventListener('click', () => {
    state.ccEraKey = state.ccEraKey === '8bit' ? '16bit' : '8bit';
    $('#btn-preview-era').textContent = state.ccEraKey === '16bit' ? '16-Bit View' : '8-Bit View';
    audio.playClick();
  });

  $('#btn-charcreate-run').addEventListener('click', runCharCreateCode);
  $('#btn-charcreate-reset').addEventListener('click', () => {
    $('#charcreate-code').value = state.catalog?.characterCreation?.starterCode || '';
    audio.playClick();
  });
  attachCodeEditorKeys($('#charcreate-code'), runCharCreateCode);

  // HUD
  $('#btn-hud-workshop').addEventListener('click', () => openWorkshop());
  $('#btn-hud-era-toggle').addEventListener('click', async () => {
    if (!state.activeSave) return;
    audio.playClick();
    state.activeSave.visualEra = state.activeSave.visualEra === '16bit' ? '8bit' : '16bit';
    state.world.setEraKey(state.activeSave.visualEra);
    updateHud();
    showToast(`Switched graphics to ${state.activeSave.visualEra === '16bit' ? '16-Bit SNES' : '8-Bit NES'} style!`);
    await persistSave();
  });

  $('#btn-hud-mute').addEventListener('click', () => {
    audio.toggleMute();
    updateHud();
  });

  $('#btn-hud-menu').addEventListener('click', async () => {
    audio.playClick();
    await persistSave();
    showScreen('screen-title');
    startTitlePreview();
    await refreshSavesList();
  });

  // Interact prompt + touch buttons
  $('#interact-prompt').addEventListener('click', () => {
    state.world?.triggerInteract();
  });
  $('#btn-touch-interact').addEventListener('click', () => {
    state.world?.triggerInteract();
  });

  document.querySelectorAll('.dpad-btn').forEach((btn) => {
    const dir = btn.dataset.dir;
    const action = btn.dataset.action;
    if (action === 'interact') {
      btn.addEventListener('click', () => state.world?.triggerInteract());
      return;
    }
    if (!dir) return;
    const start = (e) => {
      e.preventDefault();
      state.world?.setDpadDirection(dir);
    };
    const stop = (e) => {
      e.preventDefault();
      state.world?.setDpadDirection(null);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  });

  // Pyodide status indicators
  pyRunner.onStatusChange((status) => {
    const els = [$('#charcreate-py-status'), $('#hud-py-status')];
    for (const el of els) {
      if (!el) continue;
      el.textContent = status.label;
      el.className = `py-status pill ${
        status.state === 'ready' ? 'pill-green' : status.state === 'error' ? 'pill-rose' : 'pill-muted'
      }`;
    }
  });
}

// ==================== BOOTSTRAP ====================
async function init() {
  try {
    const [config, era, spriteManifest, tilesetManifest] = await Promise.all([
      fetchConfig(),
      fetchEra('era-01-8bit'),
      fetchSpriteManifest(),
      fetchTilesetManifest(),
    ]);

    state.gameConfig = config.game;
    state.catalog = config.catalog;
    state.era = era;
    state.sprites = new SpriteManager(spriteManifest, tilesetManifest);
    state.sprites.preloadCore('8bit');

    state.modals = new ModalManager($('#modal-backdrop'), $('#modal-content'), {
      sprites: state.sprites,
      onPauseChange: (paused) => state.world?.setPaused(paused),
    });

    let regionHideTimer = null;
    state.world = new WorldEngine($('#world-canvas'), state.sprites, {
      onRegionChange: (region) => {
        const banner = $('#region-banner');
        if (!banner || !region) return;
        banner.textContent = region.name;
        banner.classList.remove('hidden');
        if (regionHideTimer) clearTimeout(regionHideTimer);
        regionHideTimer = setTimeout(() => banner.classList.add('hidden'), 2600);
      },
      onNearestEntityChange: (entity) => {
        const prompt = $('#interact-prompt');
        const label = $('#interact-prompt-label');
        if (!prompt || !label) return;
        if (!entity) {
          prompt.classList.add('hidden');
          return;
        }
        let verb = 'Inspect';
        if (entity.type === 'npc') verb = 'Talk to';
        else if (entity.type === 'workshop') verb = 'Open';
        else if (entity.type === 'chest') verb = 'Open';
        else if (entity.type === 'vault') verb = 'Enter';
        else if (entity.type === 'portal') verb = 'Step into';
        else if (entity.type === 'trial') verb = 'Begin';
        label.textContent = `${verb} ${entity.label}`;
        prompt.classList.remove('hidden');
      },
      onInteract: (entity) => handleEntityInteract(entity),
    });

    wireControls();
    buildCharCreateSpellbook();
    startTitlePreview();
    await refreshSavesList();
  } catch (err) {
    console.error('Pyria boot failed:', err);
    const listEl = $('#saves-list');
    if (listEl) {
      listEl.innerHTML = `<div class="empty-state">Failed to boot Pyria: ${err.message}</div>`;
    }
  }
}

init();
