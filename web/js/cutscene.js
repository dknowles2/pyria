// Retro RPG Letterbox Cinematic Cut-Scene Player for Pyria

import { audio } from './audio.js?v=20261127f';

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
};

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
        backdropImage: '/assets/concept-art/eras/era-07-modern-4k-sandbox.jpg',
        text: 'Long ago, the kingdom of Pyria shone in full, vibrant 3D! Great Dragons soared above crystal valleys, and ancient Python spells kept every realm alive.',
      },
      {
        speaker: 'Lord Null',
        spriteKey: 'lord_null',
        side: 'right',
        vfx: 'glitch',
        backdropImage: '/assets/concept-art/eras/era-01-8bit-nes.jpg',
        text: 'Mwahahaha! Far too colorful! With my Glitch Storm, I drained Pyria all the way down to flat 8-bit pixels and locked every Dragon inside a Logic Vault! Soon all of Pyria will return None!',
      },
      {
        speaker: 'Elder Ada',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'none',
        backdropImage: '/assets/concept-art/hero_and_pip.png',
        text: 'Our only hope is a brave young Code-Tamer with a Python Spellbook — YOU, {heroName}! Every Dragon you rescue restores another Bit of reality and levels up the world.',
      },
      {
        speaker: 'Bram the Tinkerer',
        spriteKey: 'bram',
        side: 'right',
        vfx: 'none',
        backdropImage: '/assets/concept-art/modular_hero_sheet.png',
        text: "Earn Byte Shards from Trials and hidden chests, kid! Bring 'em to my Workshop and write real Python calls to forge hats, armor, boots, and power-ups!",
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        backdropImage: '/assets/concept-art/eras/era-01-8bit-nes.jpg',
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
    realmId: 'realm-16-01-shallows',
    finalButtonLabel: 'Sail into 16-Bit! ▸',
    beats: [
      {
        speaker: 'Nova',
        spriteKey: 'emberwing',
        side: 'right',
        vfx: 'bit_restore',
        backdropImage: '/assets/concept-art/eras/era-01-8bit-nes.jpg',
        text: 'ALL EIGHT BITS ARE WHOLE, {heroName}! Feel the starlight surge across the flatlands as our 8 dragons unite their power!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromImage: '/assets/concept-art/eras/era-01-8bit-nes.jpg',
          toImage: '/assets/concept-art/eras/era-02-16bit-snes.jpg',
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
        backdropImage: '/assets/concept-art/eras/era-02-16bit-snes.jpg',
        text: 'GAAAH! Too many colors! My eyes! Retreat to the Sunken Isles — try surviving 16 Realms of Lists, Functions, and Dictionaries, {heroName}!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        backdropImage: '/assets/concept-art/eras/era-02-16bit-snes.jpg',
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
        backdropImage: '/assets/concept-art/eras/era-02-16bit-snes.jpg',
        text: 'Incredible, {heroName}! You conquered all four Acts of the 16-Bit Era and shattered Lord Null’s Throne! Watch the horizon tilt upward!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromImage: '/assets/concept-art/eras/era-02-16bit-snes.jpg',
          toImage: '/assets/concept-art/eras/era-03-32bit-ps1-isometric.jpg',
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
        backdropImage: '/assets/concept-art/biomes/32bit-polygon-citadel.jpg',
        text: 'A THIRD DIMENSION?! Impossible! Wait until you try navigating 3D Tuples, Sets, and Error Traps inside my Polygon Citadel!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        backdropImage: '/assets/concept-art/biomes/32bit-blockstone-highlands.jpg',
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
        backdropImage: '/assets/concept-art/eras/era-03-32bit-ps1-isometric.jpg',
        text: 'ALL 32 BITS ARE RESTORED!! Hold onto your spellbook, {heroName} — the Isometric Frontier is breaking wide open into full 3D space!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromImage: '/assets/concept-art/eras/era-03-32bit-ps1-isometric.jpg',
          toImage: '/assets/concept-art/eras/era-04-64bit-n64.jpg',
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
        backdropImage: '/assets/concept-art/eras/era-04-64bit-n64.jpg',
        text: 'NO!! FULL 64-BIT POLYGONS?! Fine — face my 64-Bit Sanctum! Only a true master of Python Classes, Inheritance, and 3D Scripting can claim the 64-Bit Crown!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        backdropImage: '/assets/concept-art/eras/era-04-64bit-n64.jpg',
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

    // Preload any concept-art backdrops referenced by beats
    for (const b of beats) {
      if (b.backdropImage) getCutsceneImage(b.backdropImage);
      if (b.eraTransition?.fromImage) getCutsceneImage(b.eraTransition.fromImage);
      if (b.eraTransition?.toImage) getCutsceneImage(b.eraTransition.toImage);
    }

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

      // 1. Backdrop gradient OR Concept Art / Animated Era-Transition Wipe
      const [cTop, cBot] = BIOME_BACKDROPS[realmId] || ['#182342', '#0b1020'];
      const grad = ctx.createLinearGradient(0, 0, 0, 148);
      grad.addColorStop(0, cTop);
      grad.addColorStop(1, cBot);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 320, 148);

      if (beat.eraTransition) {
        const tr = beat.eraTransition;
        const fromImg = getCutsceneImage(tr.fromImage);
        const toImg = getCutsceneImage(tr.toImage);
        const sweep = Math.min(1, Math.max(0, (elapsedSec - 0.25) / 2.2));
        const splitX = Math.round(sweep * 320);

        ctx.save();
        ctx.imageSmoothingEnabled = true;
        if (fromImg) drawCoverImage(ctx, fromImg, 320, 148);
        if (toImg && splitX > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, splitX, 148);
          ctx.clip();
          drawCoverImage(ctx, toImg, 320, 148);
          ctx.restore();
        }
        ctx.restore();

        // Dark cinema vignette so characters pop
        ctx.fillStyle = 'rgba(8, 12, 24, 0.36)';
        ctx.fillRect(0, 0, 320, 148);

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
          ctx.fillStyle = 'rgba(8, 12, 24, 0.44)';
          ctx.fillRect(0, 0, 320, 148);
        }
      }

      // Ground horizon platform
      ctx.fillStyle = 'rgba(11, 16, 32, 0.52)';
      ctx.fillRect(0, 108, 320, 40);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(0, 108, 320, 2);

      // 2. Bit restore rising light pillars (behind characters)
      if (vfx === 'bit_restore') {
        const pillarAlpha = 0.22 + 0.14 * Math.sin(elapsedSec * 5);
        ctx.fillStyle = `rgba(246, 201, 69, ${pillarAlpha.toFixed(2)})`;
        ctx.fillRect(212, 0, 44, 114);
        ctx.fillStyle = `rgba(52, 211, 153, ${(pillarAlpha * 0.75).toFixed(2)})`;
        ctx.fillRect(62, 0, 38, 114);
      }

      const animFrame = Math.floor(now / 260);
      const bob = Math.round(Math.sin(now / 180) * 2);

      // 3. Left side: Customized Hero + hovering Pip
      const heroAlpha = beat.side === 'left' ? 1.0 : 0.72;
      ctx.globalAlpha = heroAlpha;
      if (sprites) {
        sprites.drawHero(ctx, appearance, eraKey, 'right', animFrame, 56, 66, 48, 48);
        sprites.drawPip(ctx, appearance, eraKey, 'right', animFrame, 104, 72 + bob, 26, 26);
      }
      ctx.globalAlpha = 1.0;

      // 4. Right side: Antagonist (Lord Null) or Realm Dragon Guardian
      if (rightSpriteKey && sprites) {
        const slideOffset = Math.round((1 - rightSlide) * 44);
        let rightAlpha = beat.side === 'right' ? 1.0 : 0.78;
        if (vfx === 'shatter' && rightSpriteKey === 'lord_null') {
          rightAlpha = Math.max(0.08, 1 - elapsedSec * 0.85);
        }
        ctx.globalAlpha = rightAlpha;
        sprites.drawNpc(ctx, rightSpriteKey, eraKey, 210 + slideOffset, 64 + bob, 48, 48);
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
