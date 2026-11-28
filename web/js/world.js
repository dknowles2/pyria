// Crisp HTML5 Canvas Overworld Engine for Pyria (8-Bit, 16-Bit, 32-Bit Isometric 2.5D, 64-Bit N64 3D)

import { audio } from './audio.js?v=20261127i';
import { renderIsometric32Bit, renderN643D } from './renderer3d.js?v=20261127i';

const BASE_TILE_PX = 16;
const RENDER_SCALE = 3; // 48x48 screen px per 16x16 map tile
const TILE_PX = BASE_TILE_PX * RENDER_SCALE;

const MINIMAP_COLORS = {
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
  lava: '#ef4444',
  ice_floor: '#bae6fd',
  ice_wall: '#38bdf8',
  sand: '#fde68a',
  coral: '#fb7185',
  obsidian_floor: '#312e4a',
  obsidian_wall: '#6d28d9',
  brass_floor: '#d97706',
  gear_prop: '#f59e0b',
  cloud_floor: '#e0f2fe',
  star_tile: '#1e1b4b',
  crystal_pillar: '#e879f9',
  pine_tree: '#15803d',
  column: '#e2e8f0',
  flower_bed: '#f43f5e',
};

export class WorldEngine {
  constructor(canvas, sprites, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = sprites;
    this.callbacks = callbacks || {};

    this.map = null;
    this.save = null;
    this.eraKey = '8bit';

    // Hero state (in tile units, center of feet)
    this.hero = {
      x: 5,
      y: 17,
      dir: 'down',
      moving: false,
      animTimer: 0,
      frame: 0,
      stepSoundCooldown: 0,
      bumpSoundCooldown: 0,
    };

    // Pip trailing companion state
    this.pip = {
      x: 4,
      y: 17,
      dir: 'down',
      frame: 0,
      animTimer: 0,
    };
    this.trail = [];

    // Camera top-left in world pixels (smoothly lerped toward hero)
    this.camera = { x: 0, y: 0, initialized: false };

    // Cached offscreen terrain layer for the corner minimap + cached radial glow sprites
    this.minimapCanvas = null;
    this.minimapCacheKey = null;
    this.minimapRect = null;
    this.lightSpriteCache = new Map();

    // Input state
    this.keys = new Set();
    this.dpadDir = null;
    this.virtualVec = { dx: 0, dy: 0 };
    this.paused = false;

    // Visual ambiance particles (fireflies for Bit 1, dust motes for Bit 2)
    this.particles = [];
    this.time = 0;
    this.lastTimestamp = 0;
    this.rafId = null;

    // Active region & nearby interactable
    this.currentRegionId = null;
    this.nearestEntity = null;

    this.bindEvents();
  }

  bindEvents() {
    this._onKeyDown = (e) => {
      if (this.paused) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

      const key = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        e.preventDefault();
        this.keys.add(key);
      } else if (key === 'e' || key === ' ' || key === 'enter') {
        e.preventDefault();
        this.triggerInteract();
      }
    };

    this._onKeyUp = (e) => {
      const key = e.key.toLowerCase();
      this.keys.delete(key);
    };

    this._onBlur = () => {
      this.keys.clear();
      this.dpadDir = null;
      this.virtualVec = { dx: 0, dy: 0 };
    };

    const handleCanvasTap = (clientX, clientY) => {
      if (this.paused || !this.map) return;
      const rect = this.canvas.getBoundingClientRect();
      const cx = (clientX - rect.left) * (this.canvas.width / rect.width);
      const cy = (clientY - rect.top) * (this.canvas.height / rect.height);

      // Ignore clicks inside the corner minimap overlay
      if (this.minimapRect) {
        const m = this.minimapRect;
        if (cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h) {
          return;
        }
      }

      const camX = Math.round(this.camera.x);
      const camY = Math.round(this.camera.y);
      const tileX = (cx + camX) / TILE_PX;
      const tileY = (cy + camY) / TILE_PX;

      // Check if user clicked an entity near the hero
      let clicked = null;
      let bestDist = 1.3;
      for (const ent of this.map.entities || []) {
        const dClick = Math.hypot(ent.x + 0.5 - tileX, ent.y + 0.5 - tileY);
        if (dClick < bestDist) {
          bestDist = dClick;
          clicked = ent;
        }
      }
      if (clicked) {
        const dHero = Math.hypot(clicked.x + 0.5 - this.hero.x, clicked.y + 0.5 - this.hero.y);
        if (dHero <= 3.2) {
          if (this.callbacks.onInteract) {
            this.callbacks.onInteract(clicked);
          }
          return;
        }
      }
      // Fallback: interact with whatever is right in front of the hero
      if (this.nearestEntity) {
        this.triggerInteract();
      }
    };

    this._onCanvasClick = (e) => {
      handleCanvasTap(e.clientX, e.clientY);
    };

    let canvasTouchStart = null;
    this._onCanvasTouchStart = (e) => {
      e.preventDefault();
      if (e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        canvasTouchStart = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    };
    this._onCanvasTouchMove = (e) => {
      e.preventDefault();
    };
    this._onCanvasTouchEnd = (e) => {
      e.preventDefault();
      if (!canvasTouchStart) return;
      for (const t of e.changedTouches) {
        if (t.identifier === canvasTouchStart.id) {
          const dist = Math.hypot(t.clientX - canvasTouchStart.x, t.clientY - canvasTouchStart.y);
          canvasTouchStart = null;
          if (dist < 15) {
            handleCanvasTap(t.clientX, t.clientY);
          }
          break;
        }
      }
    };
    this._onCanvasTouchCancel = (e) => {
      e.preventDefault();
      canvasTouchStart = null;
    };

    this._onResize = () => this.resizeCanvas();
    this._onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('resize', this._onResize);
    this.canvas.addEventListener('click', this._onCanvasClick);
    this.canvas.addEventListener('touchstart', this._onCanvasTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._onCanvasTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this._onCanvasTouchEnd, { passive: false });
    this.canvas.addEventListener('touchcancel', this._onCanvasTouchCancel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('click', this._onCanvasClick);
    this.canvas.removeEventListener('touchstart', this._onCanvasTouchStart);
    this.canvas.removeEventListener('touchmove', this._onCanvasTouchMove);
    this.canvas.removeEventListener('touchend', this._onCanvasTouchEnd);
    this.canvas.removeEventListener('touchcancel', this._onCanvasTouchCancel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
  }

  resizeCanvas() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(320, Math.floor(parent.clientWidth));
    const h = Math.max(240, Math.floor(parent.clientHeight));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  setPaused(paused) {
    this.paused = paused;
    if (paused) {
      this.keys.clear();
      this.dpadDir = null;
      this.virtualVec = { dx: 0, dy: 0 };
    }
  }

  setVirtualVector(dx, dy) {
    const mag = Math.hypot(dx || 0, dy || 0);
    if (mag < 0.01) {
      this.virtualVec = { dx: 0, dy: 0 };
      this.dpadDir = null;
      return;
    }
    const clamped = Math.min(1, mag);
    this.virtualVec = { dx: (dx / mag) * clamped, dy: (dy / mag) * clamped };
    this.dpadDir = null;
  }

  setVirtualDirection(dir) {
    this.dpadDir = dir || null;
    this.virtualVec = { dx: 0, dy: 0 };
  }

  setDpadDirection(dir) {
    this.setVirtualDirection(dir);
  }

  normalizeEraKey(eraKey) {
    return ['8bit', '16bit', '32bit', '64bit'].includes(eraKey) ? eraKey : '8bit';
  }

  setEraKey(eraKey) {
    this.eraKey = this.normalizeEraKey(eraKey);
    this.sprites.preloadCore(this.eraKey);
  }

  setSave(save) {
    this.save = save;
    this.eraKey = this.normalizeEraKey(save?.visualEra);
    this.sprites.preloadCore(this.eraKey);
  }

  loadMap(mapData, save, spawnOverride = null) {
    this.map = mapData;
    this.save = save;
    this.eraKey = this.normalizeEraKey(save?.visualEra);
    this.sprites.preloadCore(this.eraKey);

    const startX = (spawnOverride?.x ?? mapData.spawn.x) + 0.5;
    const startY = (spawnOverride?.y ?? mapData.spawn.y) + 0.5;
    this.hero.x = startX;
    this.hero.y = startY;
    this.hero.dir = 'down';
    this.pip.x = startX - 0.9;
    this.pip.y = startY;
    this.trail = [];
    this.currentRegionId = null;
    this.camera.initialized = false;
    this.minimapCacheKey = null;

    this.initParticles();
    this.resizeCanvas();
    this.snapCameraToHero();
    this.startLoop();
  }

  computeTargetCamera() {
    const worldW = this.map.width * TILE_PX;
    const worldH = this.map.height * TILE_PX;
    const desiredX = this.hero.x * TILE_PX - this.canvas.width / 2;
    const desiredY = this.hero.y * TILE_PX - this.canvas.height / 2;
    const maxCamX = Math.max(0, worldW - this.canvas.width);
    const maxCamY = Math.max(0, worldH - this.canvas.height);
    return {
      x: worldW <= this.canvas.width
        ? -(this.canvas.width - worldW) / 2
        : Math.max(0, Math.min(maxCamX, desiredX)),
      y: worldH <= this.canvas.height
        ? -(this.canvas.height - worldH) / 2
        : Math.max(0, Math.min(maxCamY, desiredY)),
    };
  }

  snapCameraToHero() {
    if (!this.map) return;
    const target = this.computeTargetCamera();
    this.camera.x = target.x;
    this.camera.y = target.y;
    this.camera.initialized = true;
  }

  initParticles() {
    this.particles = [];
    if (!this.map) return;
    for (let i = 0; i < 28; i++) {
      this.particles.push({
        x: Math.random() * this.map.width * TILE_PX,
        y: Math.random() * this.map.height * TILE_PX,
        vx: (Math.random() - 0.5) * 14,
        vy: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  startLoop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.lastTimestamp = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - this.lastTimestamp) / 1000);
      this.lastTimestamp = now;
      this.update(dt);
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * Computes dynamic tile & collision overrides from solved trials.
   */
  getDynamicStateMap() {
    const overrides = new Map();
    if (!this.map || !this.save) return overrides;
    const completed = new Set(this.save.solvedTrials || this.save.completedTrials || []);

    for (const ent of this.map.entities || []) {
      if (!Array.isArray(ent.dynamicTiles)) continue;
      const unlocked = Boolean(ent.refId && completed.has(ent.refId));
      for (const dt of ent.dynamicTiles) {
        const key = `${dt.x},${dt.y}`;
        overrides.set(key, {
          layer: dt.layer,
          tile: unlocked ? dt.tileWhenUnlocked : dt.tileWhenLocked,
          collision: unlocked ? dt.collisionWhenUnlocked : dt.collisionWhenLocked,
        });
      }
    }
    return overrides;
  }

  isTileBlocked(tx, ty, dynamicOverrides) {
    if (!this.map) return true;
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return true;

    const key = `${tx},${ty}`;
    if (dynamicOverrides.has(key)) {
      return dynamicOverrides.get(key).collision === 1;
    }

    const row = this.map.layers.collision?.[ty];
    if (row && row[tx] === 1) return true;

    // Solid entities (NPCs, anvil, unopened/opened chests, vaults)
    for (const ent of this.map.entities || []) {
      if (ent.x === tx && ent.y === ty) {
        if (['npc', 'workshop', 'chest', 'vault'].includes(ent.type)) {
          return true;
        }
      }
    }
    return false;
  }

  canStandAt(x, y, dynamicOverrides) {
    const r = 0.28;
    const pts = [
      [x - r, y - r],
      [x + r, y - r],
      [x - r, y + r],
      [x + r, y + r],
    ];
    for (const [px, py] of pts) {
      if (this.isTileBlocked(Math.floor(px), Math.floor(py), dynamicOverrides)) {
        return false;
      }
    }
    return true;
  }

  getMovementVector() {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('w') || this.keys.has('arrowup') || this.dpadDir === 'up') dy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown') || this.dpadDir === 'down') dy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft') || this.dpadDir === 'left') dx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright') || this.dpadDir === 'right') dx += 1;
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }
    if (dx === 0 && dy === 0 && (this.virtualVec.dx !== 0 || this.virtualVec.dy !== 0)) {
      return { dx: this.virtualVec.dx, dy: this.virtualVec.dy };
    }
    return { dx, dy };
  }

  update(dt) {
    this.time += dt;
    if (!this.map || !this.save) return;

    const dynamicOverrides = this.getDynamicStateMap();

    if (!this.paused) {
      const { dx, dy } = this.getMovementVector();
      const hasSwiftBoots = this.save.appearance?.boots === 'boots_swift';
      const speed = hasSwiftBoots ? 6.2 : 4.4; // tiles per second

      this.hero.moving = dx !== 0 || dy !== 0;
      if (this.hero.stepSoundCooldown > 0) this.hero.stepSoundCooldown -= dt;
      if (this.hero.bumpSoundCooldown > 0) this.hero.bumpSoundCooldown -= dt;

      if (this.hero.moving) {
        if (Math.abs(dx) > Math.abs(dy)) {
          this.hero.dir = dx < 0 ? 'left' : 'right';
        } else {
          this.hero.dir = dy < 0 ? 'up' : 'down';
        }

        const nextX = this.hero.x + dx * speed * dt;
        const nextY = this.hero.y + dy * speed * dt;
        let moved = false;

        if (this.canStandAt(nextX, this.hero.y, dynamicOverrides)) {
          this.hero.x = nextX;
          moved = true;
        }
        if (this.canStandAt(this.hero.x, nextY, dynamicOverrides)) {
          this.hero.y = nextY;
          moved = true;
        }

        if (moved) {
          this.trail.push({ x: this.hero.x, y: this.hero.y, dir: this.hero.dir });
          if (this.trail.length > 24) this.trail.shift();
          if (this.hero.stepSoundCooldown <= 0) {
            audio.playStep();
            this.hero.stepSoundCooldown = hasSwiftBoots ? 0.22 : 0.3;
          }
        } else if (this.hero.bumpSoundCooldown <= 0) {
          audio.playBump();
          this.hero.bumpSoundCooldown = 0.35;
        }

        this.hero.animTimer += dt;
        const fps = this.eraKey === '16bit' ? 8 : 5;
        if (this.hero.animTimer >= 1 / fps) {
          this.hero.animTimer = 0;
          this.hero.frame += 1;
        }
      } else {
        this.hero.frame = 0;
        this.hero.animTimer = 0;
      }
    }

    // Update Pip trailing smoothly behind hero
    const targetPip = this.trail.length >= 10
      ? this.trail[0]
      : { x: this.hero.x - 0.85, y: this.hero.y + 0.1, dir: this.hero.dir };
    const pipDx = targetPip.x - this.pip.x;
    const pipDy = targetPip.y - this.pip.y;
    const pipDist = Math.hypot(pipDx, pipDy);
    if (pipDist > 0.12) {
      this.pip.x += pipDx * Math.min(1, dt * 6);
      this.pip.y += pipDy * Math.min(1, dt * 6);
      if (Math.abs(pipDx) > Math.abs(pipDy)) {
        this.pip.dir = pipDx < 0 ? 'left' : 'right';
      } else {
        this.pip.dir = pipDy < 0 ? 'up' : 'down';
      }
    } else {
      this.pip.dir = this.hero.dir;
    }

    this.pip.animTimer += dt;
    if (this.pip.animTimer >= 0.22) {
      this.pip.animTimer = 0;
      this.pip.frame += 1;
    }

    // Update ambiance particles
    const worldW = this.map.width * TILE_PX;
    const worldH = this.map.height * TILE_PX;
    for (const p of this.particles) {
      p.x = (p.x + p.vx * dt + worldW) % worldW;
      p.y = (p.y + p.vy * dt + worldH) % worldH;
    }

    // Smoothly interpolate camera toward hero, clamped cleanly to map edges
    const targetCam = this.computeTargetCamera();
    if (!this.camera.initialized) {
      this.camera.x = targetCam.x;
      this.camera.y = targetCam.y;
      this.camera.initialized = true;
    } else {
      const lerp = 1 - Math.exp(-10 * dt);
      this.camera.x += (targetCam.x - this.camera.x) * lerp;
      this.camera.y += (targetCam.y - this.camera.y) * lerp;
      if (Math.abs(targetCam.x - this.camera.x) < 0.25) this.camera.x = targetCam.x;
      if (Math.abs(targetCam.y - this.camera.y) < 0.25) this.camera.y = targetCam.y;
    }

    // Region detection
    const htx = Math.floor(this.hero.x);
    const hty = Math.floor(this.hero.y);
    let activeRegion = null;
    for (const r of this.map.regions || []) {
      if (htx >= r.x && htx < r.x + r.width && hty >= r.y && hty < r.y + r.height) {
        activeRegion = r;
        break;
      }
    }
    const nextRegionId = activeRegion ? activeRegion.id : null;
    if (nextRegionId !== this.currentRegionId) {
      this.currentRegionId = nextRegionId;
      if (this.callbacks.onRegionChange) {
        this.callbacks.onRegionChange(activeRegion);
      }
    }

    // Nearest interactable entity
    let nearest = null;
    let bestDist = 1.85;
    for (const ent of this.map.entities || []) {
      const d = Math.hypot(ent.x + 0.5 - this.hero.x, ent.y + 0.5 - this.hero.y);
      if (d < bestDist) {
        bestDist = d;
        nearest = ent;
      }
    }
    if (nearest?.id !== this.nearestEntity?.id) {
      this.nearestEntity = nearest;
      if (this.callbacks.onNearestEntityChange) {
        this.callbacks.onNearestEntityChange(nearest);
      }
    }
  }

  triggerInteract() {
    if (this.nearestEntity && this.callbacks.onInteract) {
      this.callbacks.onInteract(this.nearestEntity);
    }
  }

  render() {
    const ctx = this.ctx;
    ctx.fillStyle = '#080c17';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.map || !this.save) return;

    ctx.imageSmoothingEnabled = false;
    const dynamicOverrides = this.getDynamicStateMap();
    const completed = new Set(this.save.solvedTrials || this.save.completedTrials || []);
    const openedChests = new Set(this.save.openedChests || []);
    const rescued = new Set(this.save.rescuedDragons || []);

    const camX = Math.round(this.camera.x);
    const camY = Math.round(this.camera.y);

    // 32-Bit Isometric 2.5D & 64-Bit Nintendo 64 3D Era renderers
    if (this.eraKey === '32bit') {
      renderIsometric32Bit(this, ctx, dynamicOverrides, completed, openedChests, rescued);
      this.renderWayfinder(ctx, completed, rescued);
      this.renderMinimap(ctx, dynamicOverrides, completed, openedChests, camX, camY);
      return;
    }
    if (this.eraKey === '64bit') {
      renderN643D(this, ctx, dynamicOverrides, completed, openedChests, rescued);
      this.renderWayfinder(ctx, completed, rescued);
      this.renderMinimap(ctx, dynamicOverrides, completed, openedChests, camX, camY);
      return;
    }

    const startCol = Math.max(0, Math.floor(camX / TILE_PX) - 1);
    const endCol = Math.min(this.map.width - 1, Math.ceil((camX + this.canvas.width) / TILE_PX) + 1);
    const startRow = Math.max(0, Math.floor(camY / TILE_PX) - 1);
    const endRow = Math.min(this.map.height - 1, Math.ceil((camY + this.canvas.height) / TILE_PX) + 1);

    const sparkRescued = rescued.has('dragon-spark');
    const is16Bit = this.eraKey === '16bit';
    const lightSources = is16Bit ? [] : null;

    // 1. Ground & Decor layers (integer pixel snapped to prevent subpixel seams)
    for (let y = startRow; y <= endRow; y++) {
      for (let x = startCol; x <= endCol; x++) {
        const sx = x * TILE_PX - camX;
        const sy = y * TILE_PX - camY;
        const groundTile = this.getEffectiveGroundTile(x, y, dynamicOverrides);
        this.sprites.drawTile(ctx, groundTile, this.eraKey, sx, sy, TILE_PX, TILE_PX);

        // Animated water, lava & starfield shimmer (before SNES shoreline banks so glints stay in water)
        if (groundTile === 'water') {
          if (is16Bit) {
            this.drawSnesWaterAnimation(ctx, x, y, sx, sy);
          } else {
            const shimmer = Math.sin(this.time * 3 + x * 0.9 + y * 0.7);
            if (shimmer > 0.55) {
              ctx.fillStyle = 'rgba(186, 230, 253, 0.28)';
              ctx.fillRect(sx + 8, sy + 14 + Math.round(shimmer * 4), 16, 4);
            }
          }
        } else if (groundTile === 'lava') {
          const pulse = Math.sin(this.time * 4 + x * 1.1 + y * 0.8);
          if (pulse > 0.4) {
            ctx.fillStyle = is16Bit ? 'rgba(254, 240, 138, 0.52)' : 'rgba(253, 224, 71, 0.42)';
            ctx.fillRect(sx + 10, sy + 16, 14, 5);
          }
          if (is16Bit && x % 2 === 0 && y % 2 === 0) {
            lightSources.push({ x: sx + TILE_PX * 0.5, y: sy + TILE_PX * 0.5, r: TILE_PX * 1.5, rgb: '249, 115, 22', alpha: 0.11 });
          }
        } else if (groundTile === 'star_tile') {
          const twinkle = Math.sin(this.time * 5 + x * 2.3 + y * 1.7);
          if (twinkle > 0.65) {
            ctx.fillStyle = 'rgba(254, 240, 138, 0.75)';
            ctx.fillRect(sx + ((x * 13) % 34) + 4, sy + ((y * 17) % 34) + 4, 4, 4);
          }
        }

        // 16-Bit SNES organic terrain transitions & non-repeating micro-variation
        if (is16Bit) {
          this.drawSnesGroundDetails(ctx, x, y, sx, sy, groundTile, dynamicOverrides);
        }

        // Bit 1 visual upgrade: swaying flower pixels after Spark is rescued
        if (sparkRescued && groundTile === 'grass_flower') {
          const sway = Math.round(Math.sin(this.time * 4 + x + y) * 2);
          ctx.fillStyle = 'rgba(254, 240, 138, 0.55)';
          ctx.fillRect(sx + 20 + sway, sy + 14, 4, 4);
        }
      }
    }

    // 1b. 16-Bit SNES Directional Cast Shadows + Decor Layer
    for (let y = startRow; y <= endRow; y++) {
      for (let x = startCol; x <= endCol; x++) {
        const sx = x * TILE_PX - camX;
        const sy = y * TILE_PX - camY;
        const decorTile = this.getEffectiveDecorTile(x, y, dynamicOverrides);
        if (!decorTile) continue;

        if (is16Bit) {
          this.drawSnesDecorShadow(ctx, x, y, sx, sy, decorTile, dynamicOverrides);
          if (decorTile === 'tree' || decorTile === 'pine_tree') {
            // Fuller overhanging SNES canopy anchored at base
            const h = Math.round(TILE_PX * 1.16);
            const w = Math.round(TILE_PX * 1.1);
            this.sprites.drawTile(ctx, decorTile, this.eraKey, sx - Math.round((w - TILE_PX) / 2), sy - (h - TILE_PX), w, h);
          } else {
            this.sprites.drawTile(ctx, decorTile, this.eraKey, sx, sy, TILE_PX, TILE_PX);
          }
          // Register dynamic SNES point light sources
          if (decorTile === 'campfire' || decorTile === 'torch') {
            const flicker = 0.9 + 0.1 * Math.sin(this.time * 11 + x * 3 + y);
            lightSources.push({
              x: sx + TILE_PX * 0.5,
              y: sy + TILE_PX * 0.35,
              r: TILE_PX * (decorTile === 'campfire' ? 2.5 : 2.1) * flicker,
              rgb: '251, 146, 60',
              alpha: decorTile === 'campfire' ? 0.34 : 0.26,
            });
          } else if (decorTile === 'portal' || decorTile === 'crystal_pillar') {
            const pulse = 0.88 + 0.12 * Math.sin(this.time * 4.5 + x);
            lightSources.push({
              x: sx + TILE_PX * 0.5,
              y: sy + TILE_PX * 0.5,
              r: TILE_PX * 2.1 * pulse,
              rgb: '56, 189, 248',
              alpha: 0.28,
            });
          } else if (decorTile === 'vault_shrine') {
            lightSources.push({
              x: sx + TILE_PX * 0.5,
              y: sy + TILE_PX * 0.45,
              r: TILE_PX * 2.4,
              rgb: '250, 204, 21',
              alpha: 0.28,
            });
          }
        } else {
          this.sprites.drawTile(ctx, decorTile, this.eraKey, sx, sy, TILE_PX, TILE_PX);
        }
      }
    }

    // 2. Entities (sorted by Y along with Hero & Pip for clean depth)
    const drawList = [];

    for (const ent of this.map.entities || []) {
      drawList.push({
        sortY: ent.y + 0.5,
        draw: () => this.drawEntity(ctx, ent, completed, openedChests, rescued, camX, camY),
      });
    }

    // Pip
    drawList.push({
      sortY: this.pip.y,
      draw: () => {
        const px = Math.round(this.pip.x * TILE_PX - camX);
        const py = Math.round(this.pip.y * TILE_PX - camY);
        const pipSize = TILE_PX * 0.85;
        const bob = Math.round(Math.sin(this.time * 6) * 2);
        if (is16Bit) {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
          ctx.beginPath();
          ctx.ellipse(px, py + 2, pipSize * 0.3, pipSize * 0.13, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        this.sprites.drawPip(
          ctx,
          this.save.appearance,
          this.eraKey,
          this.pip.dir,
          this.pip.frame,
          px - pipSize / 2,
          py - pipSize * 0.82 + bob,
          pipSize,
          pipSize
        );
      },
    });

    // Hero (shadow.png is already layer 0 of drawHero, so no extra runtime ellipse)
    drawList.push({
      sortY: this.hero.y,
      draw: () => {
        const hx = Math.round(this.hero.x * TILE_PX - camX);
        const hy = Math.round(this.hero.y * TILE_PX - camY);
        const heroSize = this.eraKey === '16bit' ? TILE_PX * 1.25 : TILE_PX * 1.1;
        this.sprites.drawHero(
          ctx,
          this.save.appearance,
          this.eraKey,
          this.hero.dir,
          this.hero.frame,
          hx - heroSize / 2,
          hy - heroSize * 0.82,
          heroSize,
          heroSize
        );
      },
    });

    drawList.sort((a, b) => a.sortY - b.sortY);
    for (const item of drawList) {
      item.draw();
    }

    // 2b. 16-Bit SNES Dynamic Lighting, Drifting Cloud Shadows & Golden-Hour Atmosphere
    if (is16Bit) {
      this.renderSnesAtmosphere(ctx, lightSources, camX, camY);
    }

    // 3. Biome Ambiance Particles (per-Realm palette; subtle ambient glow or full Bit Restored radiance)
    const BIOME_PARTICLE_RGB = {
      'realm-01-meadow': '253, 224, 71',  // gold fireflies
      'realm-02-ruins': '167, 243, 208',  // emerald dust motes
      'realm-03-cavern': '251, 146, 60',  // glowing orange embers
      'realm-04-hollow': '186, 230, 253', // icy-blue snowflakes
      'realm-05-woods': '190, 242, 100',  // lime/gold wisps
      'realm-06-crypt': '45, 212, 191',   // misty teal spores
      'realm-16-01-shallows': '125, 211, 252', // lagoon spray & sun motes
      'realm-16-02-market': '253, 224, 71',    // harbor sunlit dust
      'realm-16-03-grotto': '196, 181, 253',   // iridescent pearl glints
      'realm-16-04-lighthouse': '186, 230, 253',
    };
    const anyRescued = rescued.size > 0;
    const isAtmosphericBiome = ['realm-03-cavern', 'realm-04-hollow', 'realm-05-woods', 'realm-06-crypt'].includes(
      this.map.realmId
    );
    if (is16Bit || anyRescued || isAtmosphericBiome) {
      const rgb = BIOME_PARTICLE_RGB[this.map.realmId] || '253, 224, 71';
      const intensity = anyRescued ? 1.0 : (is16Bit ? 0.78 : 0.6);
      for (const p of this.particles) {
        const sx = p.x - camX;
        const sy = p.y - camY;
        if (sx < -8 || sy < -8 || sx > this.canvas.width + 8 || sy > this.canvas.height + 8) continue;
        const alpha = (0.3 + 0.48 * Math.sin(this.time * 3.5 + p.phase)) * intensity;
        if (is16Bit) {
          ctx.fillStyle = `rgba(${rgb}, ${(alpha * 0.32).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(Math.round(sx) + 2, Math.round(sy) + 2, 6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `rgba(${rgb}, ${alpha.toFixed(2)})`;
        ctx.fillRect(Math.round(sx), Math.round(sy), 4, 4);
      }
    }

    // 4. Next-Objective Wayfinder Arrow + Corner Minimap Overlay
    this.renderWayfinder(ctx, completed, rescued);
    this.renderMinimap(ctx, dynamicOverrides, completed, openedChests, camX, camY);
  }

  getEffectiveGroundTile(x, y, dynamicOverrides) {
    if (!this.map) return 'grass';
    const cx = Math.max(0, Math.min(this.map.width - 1, x));
    const cy = Math.max(0, Math.min(this.map.height - 1, y));
    const ov = dynamicOverrides.get(`${cx},${cy}`);
    if (ov && ov.layer === 'ground') return ov.tile;
    return this.map.layers.ground[cy]?.[cx] || 'grass';
  }

  getEffectiveDecorTile(x, y, dynamicOverrides) {
    if (!this.map) return null;
    const cx = Math.max(0, Math.min(this.map.width - 1, x));
    const cy = Math.max(0, Math.min(this.map.height - 1, y));
    const ov = dynamicOverrides.get(`${cx},${cy}`);
    if (ov && ov.layer === 'decor') return ov.tile;
    return this.map.layers.decor[cy]?.[cx] || null;
  }

  /**
   * 16-Bit SNES auto-tiled organic shorelines, feathered grass-over-dirt borders,
   * stone curbs, and non-repeating world micro-variation.
   */
  drawSnesGroundDetails(ctx, x, y, sx, sy, groundTile, dynamicOverrides) {
    const isGrass = (t) => t === 'grass' || t === 'grass_flower' || t === 'flower_bed';
    const isWater = (t) => t === 'water';
    const isLiquid = (t) => t === 'water' || t === 'lava';
    const hash = ((x * 73856093) ^ (y * 19349663)) >>> 0;

    // 1. Non-repeating subtle ground micro-variation so large regions feel hand-painted
    if (isGrass(groundTile)) {
      const m = hash % 11;
      if (m === 0) {
        // Warm sunlit clover patch
        ctx.fillStyle = 'rgba(134, 239, 172, 0.22)';
        ctx.fillRect(sx + 6 + (hash % 18), sy + 8 + ((hash >> 4) % 18), 14, 8);
      } else if (m === 3) {
        // Tiny extra wildflower bud
        const fx = sx + 8 + (hash % 28);
        const fy = sy + 8 + ((hash >> 3) % 28);
        ctx.fillStyle = (hash & 1) ? '#fef08a' : '#f8fafc';
        ctx.fillRect(fx, fy, 3, 3);
      } else if (m === 6) {
        // Soft deeper turf cluster
        ctx.fillStyle = 'rgba(22, 101, 52, 0.16)';
        ctx.fillRect(sx + 10 + (hash % 16), sy + 12 + ((hash >> 5) % 16), 12, 6);
      }
    } else if (groundTile === 'dirt_path' || groundTile === 'sand') {
      const m = hash % 7;
      if (m === 0) {
        const px = sx + 6 + (hash % 32);
        const py = sy + 6 + ((hash >> 3) % 32);
        ctx.fillStyle = 'rgba(255, 248, 220, 0.35)';
        ctx.fillRect(px, py, 4, 2);
        ctx.fillStyle = 'rgba(120, 72, 32, 0.32)';
        ctx.fillRect(px, py + 2, 4, 2);
      } else if (m === 4) {
        ctx.fillStyle = 'rgba(138, 94, 52, 0.12)';
        ctx.fillRect(sx + 8, sy + 14 + ((hash >> 4) % 14), 22, 5);
      }
    }

    const n = this.getEffectiveGroundTile(x, y - 1, dynamicOverrides);
    const s = this.getEffectiveGroundTile(x, y + 1, dynamicOverrides);
    const w = this.getEffectiveGroundTile(x - 1, y, dynamicOverrides);
    const e = this.getEffectiveGroundTile(x + 1, y, dynamicOverrides);

    // 2. Auto-tiled SNES Riverbanks & Shorelines on water tiles bordering land
    if (isWater(groundTile)) {
      const foamOffset = Math.round(Math.sin(this.time * 3.2 + x * 0.9 + y * 0.7) * 1.5);
      const SHORE_STYLES = {
        sand: { lip: '#f2d28b', undercut: '#9a7136', bank: '#c2954e' },
        dirt_path: { lip: '#c89e6a', undercut: '#613c1d', bank: '#8a5e34' },
        stone_floor: { lip: '#94a3b8', undercut: '#2f3744', bank: '#475569' },
        ice_floor: { lip: '#e0f2fe', undercut: '#0369a1', bank: '#38bdf8' },
        obsidian_floor: { lip: '#4c1d95', undercut: '#0f0a1e', bank: '#1e1b4b' },
        brass_floor: { lip: '#d97706', undercut: '#451a03', bank: '#78350f' },
        default: { lip: '#3ea647', undercut: '#14331d', bank: '#6b4423' },
      };
      const shoreFor = (t) => SHORE_STYLES[t] || SHORE_STYLES.default;

      if (!isLiquid(n) && n !== 'bridge_wood' && n !== 'bridge_broken') {
        const st = shoreFor(n);
        ctx.fillStyle = st.lip;
        ctx.fillRect(sx, sy, TILE_PX, 4);
        ctx.fillStyle = st.undercut;
        ctx.fillRect(sx, sy + 4, TILE_PX, 2);
        ctx.fillStyle = st.bank;
        ctx.fillRect(sx, sy + 6, TILE_PX, 7);
        ctx.fillStyle = 'rgba(10, 32, 64, 0.45)';
        ctx.fillRect(sx, sy + 13, TILE_PX, 3);
        ctx.fillStyle = 'rgba(224, 247, 255, 0.72)';
        ctx.fillRect(sx + 2, sy + 15 + foamOffset, TILE_PX - 4, 2);
      }
      if (!isLiquid(s) && s !== 'bridge_wood' && s !== 'bridge_broken') {
        const st = shoreFor(s);
        ctx.fillStyle = 'rgba(224, 247, 255, 0.58)';
        ctx.fillRect(sx + 3, sy + TILE_PX - 8 - foamOffset, TILE_PX - 6, 2);
        ctx.fillStyle = st.bank;
        ctx.fillRect(sx, sy + TILE_PX - 6, TILE_PX, 3);
        ctx.fillStyle = st.lip;
        ctx.fillRect(sx, sy + TILE_PX - 3, TILE_PX, 3);
      }
      if (!isLiquid(w) && w !== 'bridge_wood' && w !== 'bridge_broken') {
        const st = shoreFor(w);
        ctx.fillStyle = st.lip;
        ctx.fillRect(sx, sy, 4, TILE_PX);
        ctx.fillStyle = st.bank;
        ctx.fillRect(sx + 4, sy, 4, TILE_PX);
        ctx.fillStyle = 'rgba(10, 32, 64, 0.32)';
        ctx.fillRect(sx + 8, sy, 3, TILE_PX);
        ctx.fillStyle = 'rgba(224, 247, 255, 0.65)';
        ctx.fillRect(sx + 10 + foamOffset, sy + 4, 2, TILE_PX - 8);
      }
      if (!isLiquid(e) && e !== 'bridge_wood' && e !== 'bridge_broken') {
        const st = shoreFor(e);
        ctx.fillStyle = 'rgba(224, 247, 255, 0.62)';
        ctx.fillRect(sx + TILE_PX - 11 - foamOffset, sy + 4, 2, TILE_PX - 8);
        ctx.fillStyle = st.bank;
        ctx.fillRect(sx + TILE_PX - 8, sy, 4, TILE_PX);
        ctx.fillStyle = st.lip;
        ctx.fillRect(sx + TILE_PX - 4, sy, 4, TILE_PX);
      }
    }

    // 3. Organic Feathered Grass-over-Dirt / Grass-over-Sand Path Edges
    if (groundTile === 'dirt_path' || groundTile === 'sand') {
      const grassEdge = '#3ea647';
      const grassDark = '#236b33';
      const dirtRim = 'rgba(120, 74, 34, 0.35)';
      const step = 6;

      if (isGrass(n)) {
        for (let i = 0; i < TILE_PX; i += step) {
          const depth = 4 + (((x * 7 + i) % 3) * 2);
          ctx.fillStyle = dirtRim;
          ctx.fillRect(sx + i, sy + depth, step, 2);
          ctx.fillStyle = grassDark;
          ctx.fillRect(sx + i, sy + depth - 2, step, 2);
          ctx.fillStyle = grassEdge;
          ctx.fillRect(sx + i, sy, step, depth - 2);
        }
      }
      if (isGrass(s)) {
        for (let i = 0; i < TILE_PX; i += step) {
          const depth = 4 + (((x * 5 + i) % 3) * 2);
          ctx.fillStyle = dirtRim;
          ctx.fillRect(sx + i, sy + TILE_PX - depth - 2, step, 2);
          ctx.fillStyle = grassDark;
          ctx.fillRect(sx + i, sy + TILE_PX - depth, step, 2);
          ctx.fillStyle = grassEdge;
          ctx.fillRect(sx + i, sy + TILE_PX - depth + 2, step, depth - 2);
        }
      }
      if (isGrass(w)) {
        for (let i = 0; i < TILE_PX; i += step) {
          const depth = 4 + (((y * 7 + i) % 3) * 2);
          ctx.fillStyle = dirtRim;
          ctx.fillRect(sx + depth, sy + i, 2, step);
          ctx.fillStyle = grassDark;
          ctx.fillRect(sx + depth - 2, sy + i, 2, step);
          ctx.fillStyle = grassEdge;
          ctx.fillRect(sx, sy + i, depth - 2, step);
        }
      }
      if (isGrass(e)) {
        for (let i = 0; i < TILE_PX; i += step) {
          const depth = 4 + (((y * 5 + i) % 3) * 2);
          ctx.fillStyle = dirtRim;
          ctx.fillRect(sx + TILE_PX - depth - 2, sy + i, 2, step);
          ctx.fillStyle = grassDark;
          ctx.fillRect(sx + TILE_PX - depth, sy + i, 2, step);
          ctx.fillStyle = grassEdge;
          ctx.fillRect(sx + TILE_PX - depth + 2, sy + i, depth - 2, step);
        }
      }
      // Smoothly rounded inner corners when two adjacent sides border grass
      if (isGrass(n) && isGrass(w)) {
        ctx.fillStyle = grassEdge;
        ctx.fillRect(sx, sy, 8, 8);
        ctx.fillStyle = grassDark;
        ctx.fillRect(sx + 6, sy + 6, 3, 3);
      }
      if (isGrass(n) && isGrass(e)) {
        ctx.fillStyle = grassEdge;
        ctx.fillRect(sx + TILE_PX - 8, sy, 8, 8);
        ctx.fillStyle = grassDark;
        ctx.fillRect(sx + TILE_PX - 9, sy + 6, 3, 3);
      }
      if (isGrass(s) && isGrass(w)) {
        ctx.fillStyle = grassEdge;
        ctx.fillRect(sx, sy + TILE_PX - 8, 8, 8);
        ctx.fillStyle = grassDark;
        ctx.fillRect(sx + 6, sy + TILE_PX - 9, 3, 3);
      }
      if (isGrass(s) && isGrass(e)) {
        ctx.fillStyle = grassEdge;
        ctx.fillRect(sx + TILE_PX - 8, sy + TILE_PX - 8, 8, 8);
        ctx.fillStyle = grassDark;
        ctx.fillRect(sx + TILE_PX - 9, sy + TILE_PX - 9, 3, 3);
      }
    }

    // 4. Subtle stone floor curb & drop shadow when bordering grass/dirt
    if (groundTile === 'stone_floor' || groundTile === 'brass_floor') {
      if (isGrass(s) || s === 'dirt_path') {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
        ctx.fillRect(sx, sy + TILE_PX - 3, TILE_PX, 3);
      }
      if (isGrass(e) || e === 'dirt_path') {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.22)';
        ctx.fillRect(sx + TILE_PX - 3, sy, 3, TILE_PX);
      }
    }
  }

  /**
   * 16-Bit SNES layered animated water caustics & sun-glint sparkles.
   */
  drawSnesWaterAnimation(ctx, x, y, sx, sy) {
    const wave = Math.sin(this.time * 2.6 + x * 0.8 + y * 0.6);
    const shiftX = Math.round(Math.sin(this.time * 1.8 + y * 1.1) * 4);
    ctx.fillStyle = 'rgba(158, 224, 255, 0.28)';
    ctx.fillRect(sx + 8 + shiftX, sy + 12 + Math.round(wave * 2), 18, 3);
    ctx.fillStyle = 'rgba(186, 230, 253, 0.22)';
    ctx.fillRect(sx + 20 - shiftX, sy + 30 - Math.round(wave * 2), 14, 2);

    const glint = Math.sin(this.time * 4.5 + x * 2.1 + y * 1.7);
    if (glint > 0.72) {
      ctx.fillStyle = 'rgba(240, 249, 255, 0.82)';
      const gx = sx + 10 + ((x * 13 + y * 7) % 26);
      const gy = sy + 10 + ((x * 5 + y * 11) % 26);
      ctx.fillRect(gx, gy, 4, 2);
      ctx.fillRect(gx + 1, gy - 1, 2, 4);
    }
  }

  /**
   * 16-Bit SNES directional cast shadows (sun from top-left -> shadow down-right).
   */
  drawSnesDecorShadow(ctx, x, y, sx, sy, decorTile, dynamicOverrides) {
    const isWall = (t) => t === 'stone_wall' || t === 'ice_wall' || t === 'obsidian_wall' || t === 'mossy_gate_closed';
    if (isWall(decorTile)) {
      const nDecor = this.getEffectiveDecorTile(x, y - 1, dynamicOverrides);
      const sDecor = this.getEffectiveDecorTile(x, y + 1, dynamicOverrides);
      const eDecor = this.getEffectiveDecorTile(x + 1, y, dynamicOverrides);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.3)';
      if (!isWall(sDecor)) {
        ctx.fillRect(sx + 4, sy + TILE_PX, TILE_PX + (isWall(eDecor) ? 0 : 4), 10);
      }
      if (!isWall(eDecor)) {
        const topY = isWall(nDecor) ? sy : sy + 4;
        ctx.fillRect(sx + TILE_PX, topY, 8, sy + TILE_PX - topY);
      }
      return;
    }

    if (decorTile === 'tree' || decorTile === 'pine_tree') {
      ctx.fillStyle = 'rgba(12, 32, 24, 0.34)';
      ctx.beginPath();
      ctx.ellipse(sx + TILE_PX * 0.58, sy + TILE_PX * 0.86, TILE_PX * 0.44, TILE_PX * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (
      decorTile === 'bush' ||
      decorTile === 'statue' ||
      decorTile === 'vault_shrine' ||
      decorTile === 'column' ||
      decorTile === 'crystal_pillar' ||
      decorTile === 'anvil' ||
      decorTile === 'chest_closed' ||
      decorTile === 'chest_open' ||
      decorTile === 'coral' ||
      decorTile === 'gear_prop'
    ) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
      ctx.beginPath();
      ctx.ellipse(sx + TILE_PX * 0.54, sy + TILE_PX * 0.82, TILE_PX * 0.36, TILE_PX * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  getCachedLightSprite(rgb, radius, alpha) {
    const r = Math.max(16, Math.round(radius / 8) * 8);
    const a = Math.round(alpha * 50) / 50;
    const key = `${rgb}:${r}:${a}`;
    if (this.lightSpriteCache.has(key)) return this.lightSpriteCache.get(key);
    const off = document.createElement('canvas');
    off.width = r * 2;
    off.height = r * 2;
    const octx = off.getContext('2d');
    const grad = octx.createRadialGradient(r, r, 2, r, r, r);
    grad.addColorStop(0, `rgba(${rgb}, ${a.toFixed(2)})`);
    grad.addColorStop(0.5, `rgba(${rgb}, ${(a * 0.35).toFixed(2)})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    octx.fillStyle = grad;
    octx.fillRect(0, 0, r * 2, r * 2);
    if (this.lightSpriteCache.size > 48) this.lightSpriteCache.clear();
    this.lightSpriteCache.set(key, off);
    return off;
  }

  /**
   * 16-Bit SNES atmospheric pass: dynamic radial point lights (campfires, torches,
   * portals, shrines), slow drifting cloud shadows, and warm golden-hour sunlight wash.
   */
  renderSnesAtmosphere(ctx, lightSources, camX, camY) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.save();

    // 1. Subtle slow-drifting SNES cloud shadows wrapped cleanly by exact 440px stride
    const stride = 440;
    const cloudOffset = (this.time * 18) % stride;
    const camShiftX = ((camX * 0.25) % stride + stride) % stride;
    const maxCols = Math.ceil(W / stride) + 1;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.055)';
    for (let i = -1; i <= maxCols; i++) {
      const cx = i * stride + cloudOffset - camShiftX;
      const cy = (((i * 190 + 120 - camY * 0.2) % (H + 260)) + (H + 260)) % (H + 260) - 100;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 170, 62, -0.22, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Dynamic point-light glow halos (cached offscreen radial sprites)
    if (lightSources && lightSources.length > 0) {
      ctx.globalCompositeOperation = 'lighter';
      for (const ls of lightSources) {
        const sprite = this.getCachedLightSprite(ls.rgb, ls.r, ls.alpha);
        const half = sprite.width * 0.5;
        ctx.drawImage(sprite, Math.round(ls.x - half), Math.round(ls.y - half));
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // 3. Warm SNES top-left sunlight wash + soft edge depth
    const sunGrad = ctx.createLinearGradient(0, 0, W, H);
    sunGrad.addColorStop(0, 'rgba(254, 243, 199, 0.08)');
    sunGrad.addColorStop(0.55, 'rgba(255, 255, 255, 0)');
    sunGrad.addColorStop(1, 'rgba(15, 23, 42, 0.14)');
    ctx.fillStyle = sunGrad;
    ctx.fillRect(0, 0, W, H);

    ctx.restore();
  }

  getNextObjectiveEntity(completed, rescued) {
    const ents = this.map?.entities || [];
    // 1. First unsolved main Trial whose prerequisite is met
    for (const ent of ents) {
      if (ent.type === 'trial' && !completed.has(ent.refId)) {
        if (!ent.requiredTrialId || completed.has(ent.requiredTrialId)) {
          return { entity: ent, kind: 'trial', text: ent.label || 'Next Trial' };
        }
      }
    }
    // 2. Dragon Vault if not yet rescued
    const vault = ents.find((e) => e.type === 'vault' && !rescued.has(e.refId));
    if (vault) {
      return { entity: vault, kind: 'vault', text: vault.label || 'Dragon Vault' };
    }
    // 3. Forward portal to the next Realm
    const portal = ents.find(
      (e) => e.type === 'portal' && !String(e.id || '').startsWith('portal-back-')
    );
    if (portal) {
      return { entity: portal, kind: 'portal', text: portal.label || 'Next Realm Portal' };
    }
    return null;
  }

  renderWayfinder(ctx, completed, rescued) {
    const next = this.getNextObjectiveEntity(completed, rescued);
    if (!next) return;
    const dx = next.entity.x + 0.5 - this.hero.x;
    const dy = next.entity.y + 0.5 - this.hero.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 4.5) return; // Already right next to it!

    const angle = Math.atan2(dy, dx);
    // 8-way compass arrow
    const dirs = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
    const dirIdx = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    const arrow = dirs[dirIdx];
    const steps = Math.round(dist);
    const shortName = next.text.length > 26 ? `${next.text.slice(0, 24)}…` : next.text;
    const label = `${arrow} ${shortName} (${steps}m)`;

    ctx.save();
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
    const textW = ctx.measureText(label).width;
    const pillW = textW + 22;
    const pillH = 26;
    const px = 14;
    const py = 14;

    const pulse = 0.78 + 0.22 * Math.sin(this.time * 5);
    ctx.fillStyle = 'rgba(11, 16, 32, 0.86)';
    ctx.beginPath();
    ctx.roundRect(px, py, pillW, pillH, 999);
    ctx.fill();
    ctx.strokeStyle =
      next.kind === 'portal'
        ? `rgba(56, 189, 248, ${pulse.toFixed(2)})`
        : next.kind === 'vault'
          ? `rgba(251, 113, 133, ${pulse.toFixed(2)})`
          : `rgba(250, 204, 21, ${pulse.toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = next.kind === 'portal' ? '#bae6fd' : next.kind === 'vault' ? '#fecdd3' : '#fef08a';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px + 11, py + pillH / 2 + 0.5);
    ctx.restore();
  }

  ensureMinimapTerrainCache(dynamicOverrides, completed) {
    const cacheKey = `${this.map.id}:${[...completed].sort().join(',')}`;
    if (this.minimapCanvas && this.minimapCacheKey === cacheKey) {
      return this.minimapCanvas;
    }
    const off = document.createElement('canvas');
    off.width = this.map.width;
    off.height = this.map.height;
    const octx = off.getContext('2d');

    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const ov = dynamicOverrides.get(`${x},${y}`);
        let groundTile = this.map.layers.ground[y][x];
        if (ov && ov.layer === 'ground') groundTile = ov.tile;
        let decorTile = this.map.layers.decor[y][x];
        if (ov && ov.layer === 'decor') decorTile = ov.tile;

        const key = decorTile && MINIMAP_COLORS[decorTile] ? decorTile : groundTile;
        octx.fillStyle = MINIMAP_COLORS[key] || '#1e293b';
        octx.fillRect(x, y, 1, 1);
      }
    }

    this.minimapCanvas = off;
    this.minimapCacheKey = cacheKey;
    return off;
  }

  renderMinimap(ctx, dynamicOverrides, completed, openedChests, camX, camY) {
    if (this.canvas.width < 420 || this.canvas.height < 280) {
      this.minimapRect = null;
      return;
    }

    const scale = this.map.width >= 48 ? 3 : 4;
    const mapW = this.map.width * scale;
    const mapH = this.map.height * scale;
    const pad = 6;
    const boxW = mapW + pad * 2;
    const boxH = mapH + pad * 2;
    const boxX = this.canvas.width - boxW - 14;
    const boxY = 14;

    this.minimapRect = { x: boxX, y: boxY, w: boxW, h: boxH };

    ctx.save();
    // Translucent dark RPG frame
    ctx.fillStyle = 'rgba(11, 16, 32, 0.82)';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = 'rgba(75, 97, 150, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    const mx = boxX + pad;
    const my = boxY + pad;

    // Terrain bitmap scaled crisp
    const terrain = this.ensureMinimapTerrainCache(dynamicOverrides, completed);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(terrain, mx, my, mapW, mapH);

    // Subtle viewport rectangle
    const viewX = Math.max(0, (camX / TILE_PX) * scale);
    const viewY = Math.max(0, (camY / TILE_PX) * scale);
    const viewW = Math.min(mapW - viewX, (this.canvas.width / TILE_PX) * scale);
    const viewH = Math.min(mapH - viewY, (this.canvas.height / TILE_PX) * scale);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(mx + viewX), Math.round(my + viewY), Math.round(viewW), Math.round(viewH));

    // Entity markers
    const foundEggs = new Set(this.save.foundEasterEggs || []);
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    for (const ent of this.map.entities || []) {
      const ex = Math.round(mx + (ent.x + 0.5) * scale);
      const ey = Math.round(my + (ent.y + 0.5) * scale);

      if (ent.type === 'bonus_trial') {
        // Hidden from minimap until discovered/solved!
        if (completed.has(ent.refId)) {
          ctx.fillStyle = '#c084fc';
          ctx.beginPath();
          ctx.arc(ex, ey, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }
      if (ent.type === 'easter_egg') {
        // Hidden from minimap until discovered!
        if (foundEggs.has(ent.id)) {
          ctx.fillStyle = '#c084fc';
          ctx.fillRect(ex - 2, ey - 2, 4, 4);
        }
        continue;
      }

      if (ent.type === 'trial') {
        const isDone = completed.has(ent.refId);
        if (isDone) {
          ctx.fillStyle = '#10b981';
          ctx.beginPath();
          ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#052016';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 7px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('✓', ex, ey + 0.5);
        } else {
          // Pulsing outer halo + unmistakable gold '!' badge
          ctx.fillStyle = `rgba(250, 204, 21, ${(0.25 + 0.35 * pulse).toFixed(2)})`;
          ctx.beginPath();
          ctx.arc(ex, ey, 7.5 + pulse * 2.2, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#facc15';
          ctx.beginPath();
          ctx.arc(ex, ey, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#0b1020';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = '#0b1020';
          ctx.font = '900 9px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('!', ex, ey + 0.5);
        }
      } else if (ent.type === 'chest' && !openedChests.has(ent.id)) {
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(ex - 2.5, ey - 2.5, 5, 5);
        ctx.strokeStyle = '#0b1020';
        ctx.lineWidth = 1;
        ctx.strokeRect(ex - 2.5, ey - 2.5, 5, 5);
      } else if (ent.type === 'vault') {
        ctx.fillStyle = `rgba(239, 68, 68, ${(0.75 + 0.25 * pulse).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(ex, ey, 5 + pulse * 1.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fef2f2';
        ctx.lineWidth = 1.3;
        ctx.stroke();
      } else if (ent.type === 'portal') {
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(ex, ey, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Hero pulsing cyan/white dot
    const hx = Math.round(mx + this.hero.x * scale);
    const hy = Math.round(my + this.hero.y * scale);
    ctx.fillStyle = `rgba(56, 189, 248, ${(0.45 + 0.45 * pulse).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(hx, hy, 4.5 + pulse * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(hx, hy, 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  drawEntity(ctx, ent, completed, openedChests, rescued, camX, camY) {
    const sx = ent.x * TILE_PX - camX;
    const sy = ent.y * TILE_PX - camY;
    const bob = Math.round(Math.sin(this.time * 3.2 + ent.x) * 2);
    const isNear = this.nearestEntity && this.nearestEntity.id === ent.id;

    if (ent.type === 'chest') {
      const isOpen = openedChests.has(ent.id);
      this.sprites.drawTile(ctx, isOpen ? 'chest_open' : 'chest_closed', this.eraKey, sx, sy, TILE_PX, TILE_PX);
      if (!isOpen) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 5 + ent.x);
        ctx.fillStyle = `rgba(246, 201, 69, ${(0.35 + pulse * 0.5).toFixed(2)})`;
        ctx.fillRect(sx + TILE_PX / 2 - 3, sy - 6 + bob, 6, 6);
      }
    } else if (ent.type === 'npc') {
      if (this.eraKey === '16bit') {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.32)';
        ctx.beginPath();
        ctx.ellipse(sx + TILE_PX * 0.5, sy + TILE_PX * 0.86, TILE_PX * 0.32, TILE_PX * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      this.sprites.drawNpc(ctx, ent.spriteKey, this.eraKey, sx, sy - 4 + bob, TILE_PX, TILE_PX);
    } else if (ent.type === 'vault') {
      const isRescued = rescued.has(ent.refId);
      // Glowing magic circle under dragon
      ctx.fillStyle = isRescued ? 'rgba(52, 211, 153, 0.25)' : 'rgba(246, 201, 69, 0.28)';
      ctx.beginPath();
      ctx.arc(sx + TILE_PX / 2, sy + TILE_PX / 2, TILE_PX * 0.55, 0, Math.PI * 2);
      ctx.fill();
      if (this.eraKey === '16bit') {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.32)';
        ctx.beginPath();
        ctx.ellipse(sx + TILE_PX * 0.5, sy + TILE_PX * 0.84, TILE_PX * 0.36, TILE_PX * 0.14, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      this.sprites.drawNpc(ctx, ent.spriteKey, this.eraKey, sx, sy - 6 + bob, TILE_PX, TILE_PX);
    } else if (ent.type === 'portal') {
      const unlocked = !ent.requiredTrialId || completed.has(ent.requiredTrialId);
      this.sprites.drawTile(ctx, 'portal', this.eraKey, sx, sy, TILE_PX, TILE_PX);
      if (unlocked) {
        ctx.strokeStyle = `rgba(56, 189, 248, ${(0.5 + 0.4 * Math.sin(this.time * 5)).toFixed(2)})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(sx + 4, sy + 4, TILE_PX - 8, TILE_PX - 8);
      }
    } else if (ent.type === 'workshop') {
      // Anvil is usually already in decor, draw only if decor empty
      if (!this.map.layers.decor[ent.y]?.[ent.x]) {
        this.sprites.drawTile(ctx, ent.spriteKey || 'anvil', this.eraKey, sx, sy, TILE_PX, TILE_PX);
      }
    } else if (ent.type === 'trial') {
      const isDone = completed.has(ent.refId);
      // Only draw spriteKey if it's not a dynamicTile trigger (whose actual gate/bridge is on adjacent tiles)
      if (!ent.dynamicTiles && !this.map.layers.decor[ent.y]?.[ent.x] && ent.spriteKey) {
        this.sprites.drawTile(ctx, ent.spriteKey, this.eraKey, sx, sy, TILE_PX, TILE_PX);
      }

      const cx = sx + TILE_PX / 2;
      if (isDone) {
        // Unmistakable steady green completed checkmark badge
        const cy = sy + 6;
        ctx.fillStyle = '#059669';
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#a7f3d0';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✓', cx, cy + 1);
        ctx.textBaseline = 'alphabetic';
      } else {
        // Pulsing active Trial beacon
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 5 + ent.x);
        ctx.fillStyle = `rgba(56, 189, 248, ${(0.18 + pulse * 0.22).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(cx, sy + TILE_PX / 2, TILE_PX * 0.4, 0, Math.PI * 2);
        ctx.fill();

        const cy = sy + 4 + bob;
        ctx.fillStyle = '#f6c945';
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#1f1300';
        ctx.font = 'bold 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', cx, cy + 1);
        ctx.textBaseline = 'alphabetic';
      }
    } else if (ent.type === 'bonus_trial' || ent.type === 'easter_egg') {
      const foundEggs = new Set(this.save.foundEasterEggs || []);
      const isFound = ent.type === 'bonus_trial' ? completed.has(ent.refId) : foundEggs.has(ent.id);
      const cx = sx + TILE_PX / 2;
      const cy = sy + TILE_PX / 2;
      const shimmer = 0.45 + 0.5 * Math.sin(this.time * 4.5 + ent.x * 1.3 + ent.y);

      if (isFound) {
        ctx.fillStyle = 'rgba(192, 132, 252, 0.25)';
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#d8b4fe';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✓', cx, cy + 1);
        ctx.textBaseline = 'alphabetic';
      } else {
        // Subtle mysterious violet/gold sparkle rewarding sharp-eyed explorers
        ctx.fillStyle = `rgba(192, 132, 252, ${(0.18 + shimmer * 0.25).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 12 + shimmer * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = shimmer > 0.7 ? '#fde68a' : '#d8b4fe';
        ctx.font = 'bold 15px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✦', cx, cy - 2 + bob);
        ctx.textBaseline = 'alphabetic';
      }
    }

    // Highlight ring when hero is close enough to interact
    if (isNear) {
      ctx.strokeStyle = '#f6c945';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 2, sy + 2, TILE_PX - 4, TILE_PX - 4);
    }
  }
}
