// Retro RPG Letterbox Cinematic Cut-Scene Player for Pyria

import { audio } from './audio.js?v=20261127i';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BIOME_BACKDROPS = {
  'realm-01-meadow': ['#14281d', '#0b1510'],
  'realm-02-ruins': ['#1c2434', '#0c101a'],
  'realm-03-cavern': ['#311612', '#140908'],
  'realm-04-hollow': ['#12263a', '#09121e'],
  'realm-05-woods': ['#15281c', '#0a140e'],
  'realm-06-crypt': ['#10262b', '#071216'],
  'realm-07-keep': ['#261a36', '#0d0917'],
  'realm-08-citadel': ['#2b123f', '#0b0614'],
};

const SNES_STAGE_THEMES = {
  tideglass: {
    skyTop: '#0369a1',
    skyMid: '#38bdf8',
    skyBot: '#bae6fd',
    ridgeFar: '#0e7490',
    ridgeNear: '#15803d',
    floorTile: 'sand',
    edgeTile: 'water',
    sunColor: '254, 243, 199',
  },
  clockwork: {
    skyTop: '#451a03',
    skyMid: '#b45309',
    skyBot: '#fcd34d',
    ridgeFar: '#78350f',
    ridgeNear: '#451a03',
    floorTile: 'brass_floor',
    edgeTile: 'stone_floor',
    sunColor: '253, 224, 71',
  },
  caldera: {
    skyTop: '#2e1065',
    skyMid: '#991b1b',
    skyBot: '#f97316',
    ridgeFar: '#581c87',
    ridgeNear: '#450a0a',
    floorTile: 'obsidian_floor',
    edgeTile: 'lava',
    sunColor: '251, 146, 60',
  },
  skyway: {
    skyTop: '#1e1b4b',
    skyMid: '#3730a3',
    skyBot: '#7dd3fc',
    ridgeFar: '#312e81',
    ridgeNear: '#4338ca',
    floorTile: 'cloud_floor',
    edgeTile: 'star_tile',
    sunColor: '186, 230, 253',
  },
  meadow: {
    skyTop: '#1d4ed8',
    skyMid: '#38bdf8',
    skyBot: '#dcfce7',
    ridgeFar: '#1e40af',
    ridgeNear: '#15803d',
    floorTile: 'grass',
    edgeTile: 'dirt_path',
    sunColor: '254, 243, 199',
  },
  ruins: {
    skyTop: '#1e293b',
    skyMid: '#475569',
    skyBot: '#94a3b8',
    ridgeFar: '#334155',
    ridgeNear: '#1e293b',
    floorTile: 'stone_floor',
    edgeTile: 'grass',
    sunColor: '226, 232, 240',
  },
  frost: {
    skyTop: '#0c4a6e',
    skyMid: '#0284c7',
    skyBot: '#e0f2fe',
    ridgeFar: '#0369a1',
    ridgeNear: '#075985',
    floorTile: 'ice_floor',
    edgeTile: 'water',
    sunColor: '224, 242, 254',
  },
};

function resolveSnesStageTheme(realmId = '') {
  const id = String(realmId || '').toLowerCase();
  if (/shallows|market|grotto|lighthouse/.test(id)) return SNES_STAGE_THEMES.tideglass;
  if (/64-02-courtyard|ruins|crypt/.test(id)) return SNES_STAGE_THEMES.ruins;
  if (/32-03-caverns|hollow|glacier|ice/.test(id)) return SNES_STAGE_THEMES.frost;
  if (/courtyard|pendulum|foundry|chronometer/.test(id)) return SNES_STAGE_THEMES.clockwork;
  if (/terrace|alembic|vault|core|cavern/.test(id)) return SNES_STAGE_THEMES.caldera;
  if (/clouddock|starbridge|bastion|throne|citadel|keep|observatory|sanctum/.test(id)) return SNES_STAGE_THEMES.skyway;
  return SNES_STAGE_THEMES.meadow;
}

const CUTSCENE_IMG_CACHE = new Map();
function getCutsceneImage(src) {
  if (!src) return null;
  if (CUTSCENE_IMG_CACHE.has(src)) {
    const entry = CUTSCENE_IMG_CACHE.get(src);
    return entry.loaded ? entry.img : null;
  }
  const entry = { img: new Image(), loaded: false };
  entry.img.onload = () => { entry.loaded = true; };
  entry.img.src = src;
  CUTSCENE_IMG_CACHE.set(src, entry);
  return null;
}

function drawCoverImage(ctx, img, w, h) {
  if (!img || !img.width || !img.height) return;
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export const STORY_CUTSCENES = {
  opening: {
    id: 'opening',
    label: '📖 Opening Story: The Shattering of Pyria',
    title: '✨ PROLOGUE: THE SHATTERING OF PYRIA',
    subtitle: 'How the Bits Were Lost — and How Python Brings Them Back',
    eraKey: '8bit',
    realmId: 'realm-01-meadow',
    finalButtonLabel: 'Begin Adventure! ▸',
    beats: [
      {
        speaker: 'Elder Ada',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'vault_glow',
        eraKey: '16bit',
        text: 'Long ago, the kingdom of Pyria shone in full, vibrant color! Great Dragons soared above crystal valleys, and ancient Python spells kept every realm alive.',
      },
      {
        speaker: 'Lord Null',
        spriteKey: 'lord_null',
        side: 'right',
        vfx: 'glitch',
        eraKey: '8bit',
        text: 'Mwahahaha! Far too colorful! With my Glitch Storm, I drained Pyria all the way down to flat 8-bit pixels and locked every Dragon inside a Logic Vault! Soon all of Pyria will return None!',
      },
      {
        speaker: 'Elder Ada',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'none',
        eraKey: '8bit',
        text: 'Our only hope is a brave young Code-Tamer with a Python Spellbook — YOU, {heroName}! Every Dragon you rescue restores another Bit of reality and levels up the world.',
      },
      {
        speaker: 'Bram the Tinkerer',
        spriteKey: 'bram',
        side: 'right',
        vfx: 'none',
        eraKey: '8bit',
        text: "Earn Byte Shards from Trials and hidden chests, kid! Bring 'em to my Workshop and write real Python calls to forge hats, armor, boots, and power-ups!",
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        eraKey: '8bit',
        text: "Chirp! I'm Pip — your dragon sidekick! I'll fly right beside you with hints whenever you get stuck. Let's rescue Spark in Whispering Meadow and start the Return of the Bits!",
      },
    ],
  },

  'era-transition-16bit': {
    id: 'era-transition-16bit',
    label: '🌅 Era Upgrade: 8-Bit NES → 16-Bit SNES',
    title: '✨ ERA EVOLUTION: 8-BIT ➔ 16-BIT SNES!',
    subtitle: 'All 8 Bits Restored — The Sunken Isles Awaken!',
    eraKey: '16bit',
    realmId: 'realm-01-meadow',
    finalButtonLabel: 'Sail into 16-Bit! ▸',
    beats: [
      {
        speaker: 'Nova',
        spriteKey: 'emberwing',
        side: 'right',
        vfx: 'bit_restore',
        text: 'ALL EIGHT BITS ARE WHOLE, {heroName}! Feel the starlight surge across the flatlands as our 8 dragons unite their power!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromEraKey: '8bit',
          toEraKey: '16bit',
          fromLabel: '8-BIT NES',
          toLabel: '16-BIT SNES',
        },
        text: 'WHOA!! The flat 8-bit pixels burst into lush 16-Bit SNES color, rich layered sprites, and sweeping multi-voice synth music!',
      },
      {
        speaker: 'Lord Null',
        spriteKey: 'lord_null',
        side: 'right',
        vfx: 'glitch',
        realmId: 'realm-16-01-shallows',
        text: 'GAAAH! Too many colors! My eyes! Retreat to the Sunken Isles — try surviving 16 Realms of Lists, Functions, and Dictionaries, {heroName}!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        realmId: 'realm-16-01-shallows',
        text: 'WOOHOO!! Look at those shimmering 16-bit waves, {heroName}! Next stop: Coral Shallows in the Tideglass Archipelago!',
      },
    ],
  },

  'era-transition-32bit': {
    id: 'era-transition-32bit',
    label: '🧊 Era Upgrade: 16-Bit SNES → 32-Bit Isometric 2.5D',
    title: '✨ ERA EVOLUTION: 16-BIT ➔ 32-BIT ISOMETRIC!',
    subtitle: 'All 16 Bits Restored — The World Rises into 2.5D!',
    eraKey: '32bit',
    realmId: 'realm-32-01-highlands',
    finalButtonLabel: 'Climb into 32-Bit! ▸',
    beats: [
      {
        speaker: 'Zenith',
        spriteKey: 'emberwing',
        side: 'right',
        vfx: 'bit_restore',
        realmId: 'realm-16-16-throne',
        text: 'Incredible, {heroName}! You conquered all four Acts of the 16-Bit Era and shattered Lord Null’s Throne! Watch the horizon tilt upward!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromEraKey: '16bit',
          toEraKey: '32bit',
          fromLabel: '16-BIT SNES',
          toLabel: '32-BIT ISOMETRIC 2.5D',
        },
        text: 'RUMBLE-SHIFT!! Flat 2D tiles extrude upward into towering 32-Bit Isometric cliffs, waterfalls, and elevated (x, y, z) highlands!',
      },
      {
        speaker: 'Lord Null',
        spriteKey: 'lord_null',
        side: 'right',
        vfx: 'glitch',
        realmId: 'realm-32-04-citadel',
        text: 'A THIRD DIMENSION?! Impossible! Wait until you try navigating 3D Tuples, Sets, and Error Traps inside my Polygon Citadel!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        realmId: 'realm-32-01-highlands',
        text: 'Chirp-WHOA!! We have HEIGHT now, {heroName}! Welcome to Blockstone Highlands in glorious 32-Bit Isometric 2.5D!',
      },
    ],
  },

  'era-transition-64bit': {
    id: 'era-transition-64bit',
    label: '🏔️ Era Upgrade: 32-Bit Isometric → 64-Bit Nintendo 64 3D',
    title: '✨ ERA EVOLUTION: 32-BIT ➔ 64-BIT NINTENDO 64!',
    subtitle: 'All 32 Bits Restored — Welcome to Free-Roam 3D!',
    eraKey: '64bit',
    realmId: 'realm-64-01-valley',
    finalButtonLabel: 'Enter 64-Bit 3D! ▸',
    beats: [
      {
        speaker: 'Vortex',
        spriteKey: 'spark',
        side: 'right',
        vfx: 'bit_restore',
        realmId: 'realm-32-04-citadel',
        text: 'ALL 32 BITS ARE RESTORED!! Hold onto your spellbook, {heroName} — the Isometric Frontier is breaking wide open into full 3D space!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromEraKey: '32bit',
          toEraKey: '64bit',
          fromLabel: '32-BIT ISOMETRIC',
          toLabel: '64-BIT NINTENDO 64 3D',
        },
        text: 'BOOM!! Chunky Gouraud-shaded low-poly hills, cobalt skies, distant mountains, and sweeping N64 brass fill the horizon!',
      },
      {
        speaker: 'Lord Null',
        spriteKey: 'lord_null',
        side: 'right',
        vfx: 'glitch',
        realmId: 'realm-64-04-sanctum',
        text: 'NO!! FULL 64-BIT POLYGONS?! Fine — face my 64-Bit Sanctum! Only a true master of Python Classes, Inheritance, and 3D Scripting can claim the 64-Bit Crown!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        realmId: 'realm-64-01-valley',
        text: 'WOOHOO!! Look at those 3D mountains, {heroName}! Let’s soar into Polygon Valley and win the 64-Bit Crown!',
      },
    ],
  },
};

/**
 * Plays a full-screen retro letterbox cut-scene and resolves when finished or skipped.
 */
export function playCutscene({
  title = '⚔️ BOSS ENCOUNTER',
  subtitle = '',
  beats = [],
  save = null,
  sprites = null,
  eraKey = '8bit',
  realmId = 'realm-01-meadow',
  finalButtonLabel = 'Continue ▸',
}) {
  if (!Array.isArray(beats) || beats.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const heroName = save?.heroName || 'Code-Tamer';
    const appearance = save?.appearance || {
      skin: 'warm_tan',
      hair: 'spiky',
      tunic: 'emerald',
      boots: 'boots_default',
    };

    const overlay = document.createElement('div');
    overlay.className = 'cutscene-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="cutscene-bar cutscene-top">
        <div class="cutscene-title-wrap">
          <div class="cutscene-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="cutscene-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <button id="cutscene-skip-btn" type="button" class="btn btn-sm btn-ghost">Skip ▸▸</button>
      </div>

      <div class="cutscene-stage-wrap">
        <canvas id="cutscene-canvas" width="640" height="296" class="pixel-canvas cutscene-canvas"></canvas>
      </div>

      <div class="cutscene-bar cutscene-bottom">
        <div class="cutscene-dialogue-box" id="cutscene-dialogue-box">
          <div class="cutscene-meta-row">
            <span id="cutscene-speaker" class="pill pill-gold">Pip</span>
            <span id="cutscene-progress" class="cutscene-progress">1 / ${beats.length}</span>
          </div>
          <p id="cutscene-text" class="cutscene-text"></p>
          <div class="cutscene-actions">
            <span class="cutscene-hint">Tap anywhere or press Space / Enter</span>
            <button id="cutscene-next-btn" type="button" class="btn btn-primary btn-sm">Next ▸</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector('#cutscene-canvas');
    const ctx = canvas.getContext('2d');
    const speakerEl = overlay.querySelector('#cutscene-speaker');
    const progressEl = overlay.querySelector('#cutscene-progress');
    const textEl = overlay.querySelector('#cutscene-text');
    const nextBtn = overlay.querySelector('#cutscene-next-btn');
    const skipBtn = overlay.querySelector('#cutscene-skip-btn');

    let beatIndex = 0;
    let beatStartTime = performance.now();
    let fullText = '';
    let charCount = 0;
    let lastTypeTime = performance.now();
    let rightSpriteKey = null;
    let rightSlide = 0;
    let rafId = null;
    let finished = false;

    // Seed reusable VFX particles
    const vfxParticles = Array.from({ length: 36 }, (_, i) => ({
      angle: (i / 36) * Math.PI * 2 + Math.random() * 0.3,
      speed: 24 + Math.random() * 68,
      x: Math.random() * 320,
      y: Math.random() * 148,
      phase: Math.random() * Math.PI * 2,
      color: ['#f6c945', '#38bdf8', '#34d399', '#fb7185', '#fef08a'][i % 5],
    }));

    const resolveRightSprite = (beat) => {
      if (beat.side === 'right' && beat.spriteKey && beat.spriteKey !== 'hero' && beat.spriteKey !== 'pip') {
        if (rightSpriteKey !== beat.spriteKey) {
          rightSpriteKey = beat.spriteKey;
          rightSlide = 0;
        }
      }
      // Fallback: look ahead for first right-side sprite so stage is populated on beat 0
      if (!rightSpriteKey) {
        const firstRight = beats.find(
          (b) => b.side === 'right' && b.spriteKey && b.spriteKey !== 'hero' && b.spriteKey !== 'pip'
        );
        if (firstRight) rightSpriteKey = firstRight.spriteKey;
      }
    };

    const loadBeat = (idx) => {
      beatIndex = idx;
      beatStartTime = performance.now();
      const beat = beats[beatIndex];
      resolveRightSprite(beat);

      fullText = String(beat.text || '').replace(/\{heroName\}/g, heroName);
      charCount = 0;
      lastTypeTime = performance.now();

      speakerEl.textContent = beat.speaker || 'Pip';
      speakerEl.className = `pill ${
        beat.spriteKey === 'lord_null'
          ? 'pill-rose'
          : beat.side === 'right'
            ? 'pill-gold'
            : 'pill-blue'
      }`;
      progressEl.textContent = `${beatIndex + 1} / ${beats.length}`;
      textEl.textContent = '';

      const isLast = beatIndex === beats.length - 1;
      nextBtn.textContent = isLast ? finalButtonLabel : 'Next ▸';
    };

    const cleanupAndFinish = () => {
      if (finished) return;
      finished = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve();
    };

    const advance = () => {
      if (charCount < fullText.length) {
        charCount = fullText.length;
        textEl.textContent = fullText;
        audio.playClick();
        return;
      }
      audio.playClick();
      if (beatIndex + 1 < beats.length) {
        loadBeat(beatIndex + 1);
      } else {
        cleanupAndFinish();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cleanupAndFinish();
      } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopImmediatePropagation();
        advance();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);

    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.playClick();
      cleanupAndFinish();
    });

    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      advance();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === skipBtn || e.target === nextBtn) return;
      advance();
    });

    // Preload core tilesets + hero layers in both 8bit and 16bit so transition sweeps never flash blank
    if (sprites) {
      sprites.preloadCore('8bit');
      sprites.preloadCore('16bit');
      sprites.preloadHero(appearance, '8bit');
      sprites.preloadHero(appearance, '16bit');
    }
    for (const b of beats) {
      if (b.backdropImage) getCutsceneImage(b.backdropImage);
      if (b.eraTransition?.fromImage) getCutsceneImage(b.eraTransition.fromImage);
      if (b.eraTransition?.toImage) getCutsceneImage(b.eraTransition.toImage);
    }

    // Track if this cutscene contains an eraTransition beat (so pre-transition beats render in fromEraKey)
    const transitionBeatIdx = beats.findIndex((b) => Boolean(b.eraTransition));

    // Character-free live stage renderer using actual 8-bit or 16-bit game tiles & biome scenery
    const drawLiveStage = (stageEraKey, beatRealmId, now) => {
      const theme = resolveSnesStageTheme(beatRealmId || realmId);
      const is16 = stageEraKey !== '8bit';

      if (!is16) {
        // Authentic 8-Bit NES stage: flat dark cobalt sky, chunky stars, 8-bit tiles & trees
        const [cTop, cBot] = BIOME_BACKDROPS[beatRealmId || realmId] || ['#12203d', '#0b1020'];
        const grad = ctx.createLinearGradient(0, 0, 0, 108);
        grad.addColorStop(0, cTop);
        grad.addColorStop(1, cBot);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 320, 148);

        // Simple 8-bit pixel stars
        ctx.fillStyle = 'rgba(226, 232, 240, 0.55)';
        for (const [sx, sy] of [[24, 18], [86, 26], [148, 14], [218, 24], [286, 16], [52, 46], [262, 42]]) {
          ctx.fillRect(sx, sy, 2, 2);
        }

        // 8-bit horizon treeline using real 8-bit tileset
        if (sprites) {
          for (const tx of [6, 34, 134, 258, 286]) {
            sprites.drawTile(ctx, 'tree', '8bit', tx, 82, 26, 26);
          }
          for (let tx = 0; tx < 10; tx++) {
            const floorTile = tx === 4 || tx === 5 ? 'bridge_wood' : 'dirt_path';
            sprites.drawTile(ctx, floorTile, '8bit', tx * 32, 108, 32, 24);
            sprites.drawTile(ctx, tx === 4 || tx === 5 ? 'water' : 'grass', '8bit', tx * 32, 132, 32, 16);
          }
        }
        ctx.fillStyle = 'rgba(8, 12, 24, 0.36)';
        ctx.fillRect(0, 108, 320, 40);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
        ctx.fillRect(0, 108, 320, 2);
        return;
      }

      // Lush 16-Bit SNES multi-layer parallax stage (zero duplicate characters!)
      const sky = ctx.createLinearGradient(0, 0, 0, 112);
      sky.addColorStop(0, theme.skyTop);
      sky.addColorStop(0.62, theme.skyMid);
      sky.addColorStop(1, theme.skyBot);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 320, 148);

      // Soft drifting SNES clouds
      const cloudShift = (now * 0.008) % 360;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      for (let i = 0; i < 4; i++) {
        const cx = ((i * 95 + cloudShift) % 360) - 20;
        const cy = 18 + (i % 2) * 16;
        ctx.beginPath();
        ctx.ellipse(cx, cy, 26, 7, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + 14, cy - 3, 18, 6, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Far mountain ridge silhouette
      ctx.fillStyle = theme.ridgeFar;
      ctx.beginPath();
      ctx.moveTo(0, 108);
      for (let i = 0; i <= 10; i++) {
        const rx = i * 32;
        const ry = 68 + Math.sin(i * 1.4) * 14 + (i % 2 === 0 ? -8 : 6);
        ctx.lineTo(rx, ry);
      }
      ctx.lineTo(320, 108);
      ctx.closePath();
      ctx.fill();

      // Near rolling hills / tree-line ridge
      ctx.fillStyle = theme.ridgeNear;
      ctx.beginPath();
      ctx.moveTo(0, 108);
      for (let i = 0; i <= 12; i++) {
        const rx = i * 28;
        const ry = 88 + Math.cos(i * 1.7) * 7;
        ctx.lineTo(rx, ry);
      }
      ctx.lineTo(320, 108);
      ctx.closePath();
      ctx.fill();

      // Warm top-left golden SNES sunbeam
      const sun = ctx.createRadialGradient(48, 20, 4, 48, 20, 165);
      sun.addColorStop(0, `rgba(${theme.sunColor}, 0.34)`);
      sun.addColorStop(1, `rgba(${theme.sunColor}, 0)`);
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, 320, 148);

      // 16-bit horizon foliage/props & textured SNES stage floor using real 32x32 tileset
      if (sprites) {
        const propPair =
          theme.floorTile === 'sand' ? ['coral', 'tree']
            : theme.floorTile === 'brass_floor' ? ['gear_prop', 'column']
              : theme.floorTile === 'obsidian_floor' ? ['crystal_pillar', 'torch']
                : theme.floorTile === 'cloud_floor' || theme.floorTile === 'ice_floor' ? ['crystal_pillar', 'column']
                  : ['tree', 'pine_tree'];
        const [propTile, propAlt] = propPair;
        for (const [tx, tile] of [[4, propAlt], [28, propTile], [132, propAlt], [260, propTile], [288, propAlt]]) {
          ctx.fillStyle = 'rgba(10, 18, 24, 0.3)';
          ctx.beginPath();
          ctx.ellipse(tx + 15, 109, 12, 3.5, 0, 0, Math.PI * 2);
          ctx.fill();
          sprites.drawTile(ctx, tile, '16bit', tx, 78, 30, 32);
        }
        const topRowTile = theme.floorTile === 'grass' ? 'dirt_path' : theme.floorTile;
        const botRowTile = theme.floorTile === 'grass' ? 'grass' : theme.edgeTile;
        for (let tx = 0; tx < 10; tx++) {
          const isBridge = (theme.floorTile === 'grass' || theme.floorTile === 'sand') && (tx === 4 || tx === 5);
          sprites.drawTile(ctx, isBridge ? 'bridge_wood' : topRowTile, '16bit', tx * 32, 108, 32, 24);
          sprites.drawTile(ctx, isBridge ? 'water' : botRowTile, '16bit', tx * 32, 132, 32, 16);
        }
        // Subtle sunlit horizon lip + depth shade
        const floorShade = ctx.createLinearGradient(0, 108, 0, 148);
        floorShade.addColorStop(0, 'rgba(254, 243, 199, 0.2)');
        floorShade.addColorStop(0.28, 'rgba(15, 23, 42, 0.08)');
        floorShade.addColorStop(1, 'rgba(8, 12, 24, 0.52)');
        ctx.fillStyle = floorShade;
        ctx.fillRect(0, 108, 320, 40);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.fillRect(0, 108, 320, 1.5);
      }
    };

    const renderFrame = (now) => {
      if (finished) return;
      const beat = beats[beatIndex];
      const elapsedSec = (now - beatStartTime) / 1000;
      const vfx = beat.vfx || 'none';

      // Advance typewriter text
      if (charCount < fullText.length && now - lastTypeTime >= 22) {
        const steps = Math.max(1, Math.floor((now - lastTypeTime) / 22));
        charCount = Math.min(fullText.length, charCount + steps);
        textEl.textContent = fullText.slice(0, charCount);
        lastTypeTime = now;
      }

      rightSlide = Math.min(1, rightSlide + 0.06);

      // Compute active era for this beat (and live laser sweep splitX on eraTransition beats)
      let sweep = 0;
      let splitX = -1;
      let activeEraKey = beat.eraKey || eraKey;
      if (transitionBeatIdx >= 0 && beatIndex < transitionBeatIdx && beats[transitionBeatIdx].eraTransition?.fromEraKey) {
        activeEraKey = beats[transitionBeatIdx].eraTransition.fromEraKey;
      } else if (beat.eraTransition) {
        sweep = Math.min(1, Math.max(0, (elapsedSec - 0.25) / 2.2));
        splitX = Math.round(sweep * 320);
        activeEraKey = sweep >= 0.5 ? (beat.eraTransition.toEraKey || eraKey) : (beat.eraTransition.fromEraKey || '8bit');
      }
      const isRichEra = activeEraKey !== '8bit';
      const beatRealmId = beat.realmId || realmId;

      ctx.save();
      ctx.scale(2, 2);
      ctx.imageSmoothingEnabled = false;

      // Subtle screen shake on glitch / shatter
      if (vfx === 'glitch' || (vfx === 'shatter' && elapsedSec < 0.45)) {
        const mag = vfx === 'shatter' ? 3 : 1.5;
        ctx.translate(
          Math.round((Math.random() - 0.5) * mag * 2),
          Math.round((Math.random() - 0.5) * mag * 2)
        );
      }

      // 1. Live Stage Backdrop OR Era-Transition Wipe
      if (beat.eraTransition) {
        const tr = beat.eraTransition;
        const fromImg = tr.fromImage ? getCutsceneImage(tr.fromImage) : null;
        const toImg = tr.toImage ? getCutsceneImage(tr.toImage) : null;
        if (fromImg && (toImg || !tr.toImage)) {
          ctx.save();
          ctx.imageSmoothingEnabled = true;
          drawCoverImage(ctx, fromImg, 320, 148);
          if (toImg && splitX > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, splitX, 148);
            ctx.clip();
            drawCoverImage(ctx, toImg, 320, 148);
            ctx.restore();
          }
          ctx.restore();
          ctx.fillStyle = 'rgba(8, 12, 24, 0.34)';
          ctx.fillRect(0, 0, 320, 148);
          ctx.fillStyle = 'rgba(11, 16, 32, 0.52)';
          ctx.fillRect(0, 108, 320, 40);
        } else {
          // Pure live-engine sweep (zero duplicate background characters & works offline/production!)
          drawLiveStage(tr.fromEraKey || '8bit', beatRealmId, now);
          if (splitX > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, splitX, 148);
            ctx.clip();
            drawLiveStage(tr.toEraKey || '16bit', beatRealmId, now);
            ctx.restore();
          }
        }

        // Glowing golden evolution laser sweep bar
        if (sweep > 0.01 && sweep < 0.99) {
          const glow = ctx.createLinearGradient(splitX - 10, 0, splitX + 10, 0);
          glow.addColorStop(0, 'rgba(250, 204, 21, 0)');
          glow.addColorStop(0.5, 'rgba(254, 240, 138, 0.95)');
          glow.addColorStop(1, 'rgba(56, 189, 248, 0)');
          ctx.fillStyle = glow;
          ctx.fillRect(splitX - 10, 0, 20, 148);
        }

        // Era badge pill at top center
        ctx.fillStyle = 'rgba(11, 16, 32, 0.82)';
        ctx.fillRect(46, 6, 228, 18);
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1;
        ctx.strokeRect(46, 6, 228, 18);
        ctx.fillStyle = '#fef08a';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${tr.fromLabel}  ➔  ${tr.toLabel}`, 160, 18);
      } else if (beat.backdropImage) {
        const bgImg = getCutsceneImage(beat.backdropImage);
        if (bgImg) {
          ctx.save();
          ctx.imageSmoothingEnabled = true;
          drawCoverImage(ctx, bgImg, 320, 148);
          ctx.restore();
          ctx.fillStyle = 'rgba(8, 12, 24, 0.42)';
          ctx.fillRect(0, 0, 320, 148);
          ctx.fillStyle = 'rgba(11, 16, 32, 0.52)';
          ctx.fillRect(0, 108, 320, 40);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
          ctx.fillRect(0, 108, 320, 2);
        } else {
          drawLiveStage(activeEraKey, beatRealmId, now);
        }
      } else {
        drawLiveStage(activeEraKey, beatRealmId, now);
      }

      // 2. Bit restore rising light pillars (behind characters)
      if (vfx === 'bit_restore') {
        const pillarAlpha = 0.22 + 0.14 * Math.sin(elapsedSec * 5);
        ctx.fillStyle = `rgba(246, 201, 69, ${pillarAlpha.toFixed(2)})`;
        ctx.fillRect(212, 0, 44, 114);
        ctx.fillStyle = `rgba(52, 211, 153, ${(pillarAlpha * 0.75).toFixed(2)})`;
        ctx.fillRect(62, 0, 38, 114);
      }

      const animFrame = Math.floor(now / (isRichEra ? 190 : 260));
      const bob = Math.round(Math.sin(now / 180) * 2);

      // Per-actor era resolution: during eraTransition laser sweep, actors upgrade the instant the beam crosses them!
      const actorEraAt = (actorCenterX) => {
        if (beat.eraTransition && beat.eraTransition.fromEraKey && beat.eraTransition.toEraKey) {
          return splitX >= actorCenterX ? beat.eraTransition.toEraKey : beat.eraTransition.fromEraKey;
        }
        return activeEraKey;
      };

      // 3. Left side: Customized Hero + hovering Pip
      const heroEra = actorEraAt(80);
      const heroAlpha = beat.side === 'left' ? 1.0 : 0.78;
      if (heroEra !== '8bit') {
        // Soft SNES speaker spotlight + grounded contact shadows
        if (beat.side === 'left') {
          const sp = ctx.createRadialGradient(84, 92, 4, 84, 92, 42);
          sp.addColorStop(0, 'rgba(254, 243, 199, 0.24)');
          sp.addColorStop(1, 'rgba(254, 243, 199, 0)');
          ctx.fillStyle = sp;
          ctx.fillRect(40, 50, 88, 80);
        }
        ctx.fillStyle = 'rgba(10, 16, 28, 0.34)';
        ctx.beginPath();
        ctx.ellipse(117, 108, 10, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = heroAlpha;
      if (sprites) {
        sprites.drawHero(ctx, appearance, heroEra, 'right', animFrame, 56, 66, 48, 48);
        sprites.drawPip(ctx, appearance, heroEra, 'right', animFrame, 104, 72 + bob, 26, 26);
      }
      ctx.globalAlpha = 1.0;

      // 4. Right side: Antagonist (Lord Null) or Realm Dragon Guardian
      if (rightSpriteKey && sprites) {
        const slideOffset = Math.round((1 - rightSlide) * 44);
        const rx = 210 + slideOffset;
        const rightEra = actorEraAt(rx + 24);
        let rightAlpha = beat.side === 'right' ? 1.0 : 0.8;
        if (vfx === 'shatter' && rightSpriteKey === 'lord_null') {
          rightAlpha = Math.max(0.08, 1 - elapsedSec * 0.85);
        }
        if (rightEra !== '8bit') {
          if (beat.side === 'right') {
            const sp = ctx.createRadialGradient(rx + 24, 90, 4, rx + 24, 90, 44);
            sp.addColorStop(0, rightSpriteKey === 'lord_null' ? 'rgba(244, 63, 94, 0.24)' : 'rgba(250, 204, 21, 0.26)');
            sp.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = sp;
            ctx.fillRect(rx - 20, 46, 88, 88);
          }
          ctx.fillStyle = 'rgba(10, 16, 28, 0.38)';
          ctx.beginPath();
          ctx.ellipse(rx + 24, 113, 18, 5.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = rightAlpha;
        sprites.drawNpc(ctx, rightSpriteKey, rightEra, rx, 64 + bob, 48, 48);
        ctx.globalAlpha = 1.0;
      }

      // 5. Foreground VFX overlays
      if (vfx === 'vault_glow') {
        const pulse = 0.45 + 0.4 * Math.sin(elapsedSec * 6);
        ctx.strokeStyle = `rgba(246, 201, 69, ${pulse.toFixed(2)})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(202, 54, 64, 62);
        for (let bx = 212; bx <= 256; bx += 11) {
          ctx.fillStyle = `rgba(56, 189, 248, ${(pulse * 0.65).toFixed(2)})`;
          ctx.fillRect(bx, 54, 2, 62);
        }
      } else if (vfx === 'glitch') {
        for (let i = 0; i < 6; i++) {
          const gy = Math.floor(((now * 0.15 + i * 29) % 148));
          ctx.fillStyle = i % 2 === 0 ? 'rgba(167, 139, 250, 0.35)' : 'rgba(56, 189, 248, 0.32)';
          ctx.fillRect(0, gy, canvas.width, 3);
        }
      } else if (vfx === 'shatter') {
        if (elapsedSec < 0.22) {
          ctx.fillStyle = `rgba(255, 255, 255, ${(0.85 * (1 - elapsedSec / 0.22)).toFixed(2)})`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        for (const p of vfxParticles) {
          const dist = elapsedSec * p.speed;
          const px = 234 + Math.cos(p.angle) * dist;
          const py = 86 + Math.sin(p.angle) * dist;
          ctx.fillStyle = p.color;
          ctx.fillRect(Math.round(px), Math.round(py), 3, 3);
        }
      } else if (vfx === 'bit_restore' || vfx === 'celebrate') {
        for (const p of vfxParticles) {
          const px = (p.x + Math.sin(elapsedSec * 2 + p.phase) * 10 + 320) % 320;
          const py = (p.y - elapsedSec * 32 + 1480) % 148;
          ctx.fillStyle = p.color;
          ctx.fillRect(Math.round(px), Math.round(py), 3, 3);
        }
      }

      ctx.restore();
      rafId = requestAnimationFrame(renderFrame);
    };

    loadBeat(0);
    rafId = requestAnimationFrame(renderFrame);
  });
}
