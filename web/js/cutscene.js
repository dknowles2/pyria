// Retro RPG Letterbox Cinematic Cut-Scene Player for Pyria

import { audio } from './audio.js?v=20261126v';

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
        <canvas id="cutscene-canvas" width="320" height="148" class="pixel-canvas cutscene-canvas"></canvas>
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
      ctx.imageSmoothingEnabled = false;

      // Subtle screen shake on glitch / shatter
      if (vfx === 'glitch' || (vfx === 'shatter' && elapsedSec < 0.45)) {
        const mag = vfx === 'shatter' ? 3 : 1.5;
        ctx.translate(
          Math.round((Math.random() - 0.5) * mag * 2),
          Math.round((Math.random() - 0.5) * mag * 2)
        );
      }

      // 1. Backdrop gradient
      const [cTop, cBot] = BIOME_BACKDROPS[realmId] || ['#182342', '#0b1020'];
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, cTop);
      grad.addColorStop(1, cBot);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Ground horizon platform
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(0, 108, canvas.width, 40);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(0, 108, canvas.width, 2);

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
