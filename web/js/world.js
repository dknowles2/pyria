// Crisp HTML5 Canvas Overworld Engine for Pyria

import { audio } from './audio.js';

const BASE_TILE_PX = 16;
const RENDER_SCALE = 3; // 48x48 screen px per 16x16 map tile
const TILE_PX = BASE_TILE_PX * RENDER_SCALE;

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

    // Camera top-left in world pixels
    this.camera = { x: 0, y: 0 };

    // Input state
    this.keys = new Set();
    this.dpadDir = null;
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
    };

    this._onCanvasClick = (e) => {
      if (this.paused || !this.map) return;
      const rect = this.canvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      const tileX = (cx + this.camera.x) / TILE_PX;
      const tileY = (cy + this.camera.y) / TILE_PX;

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

    this._onResize = () => this.resizeCanvas();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('resize', this._onResize);
    this.canvas.addEventListener('click', this._onCanvasClick);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('click', this._onCanvasClick);
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
    }
  }

  setDpadDirection(dir) {
    this.dpadDir = dir;
  }

  setEraKey(eraKey) {
    this.eraKey = eraKey === '16bit' ? '16bit' : '8bit';
    this.sprites.preloadCore(this.eraKey);
  }

  setSave(save) {
    this.save = save;
    this.eraKey = save?.visualEra === '16bit' ? '16bit' : '8bit';
    this.sprites.preloadCore(this.eraKey);
  }

  loadMap(mapData, save, spawnOverride = null) {
    this.map = mapData;
    this.save = save;
    this.eraKey = save?.visualEra === '16bit' ? '16bit' : '8bit';
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

    this.initParticles();
    this.resizeCanvas();
    this.startLoop();
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
    const completed = new Set(this.save.completedTrials || []);

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

    // Update camera centered on hero, clamped to map bounds
    const desiredX = this.hero.x * TILE_PX - this.canvas.width / 2;
    const desiredY = this.hero.y * TILE_PX - this.canvas.height / 2;
    const maxCamX = Math.max(0, worldW - this.canvas.width);
    const maxCamY = Math.max(0, worldH - this.canvas.height);
    this.camera.x = worldW <= this.canvas.width
      ? -(this.canvas.width - worldW) / 2
      : Math.max(0, Math.min(maxCamX, desiredX));
    this.camera.y = worldH <= this.canvas.height
      ? -(this.canvas.height - worldH) / 2
      : Math.max(0, Math.min(maxCamY, desiredY));

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
    const completed = new Set(this.save.completedTrials || []);
    const openedChests = new Set(this.save.openedChests || []);
    const rescued = new Set(this.save.rescuedDragons || []);

    const startCol = Math.max(0, Math.floor(this.camera.x / TILE_PX) - 1);
    const endCol = Math.min(this.map.width - 1, Math.ceil((this.camera.x + this.canvas.width) / TILE_PX) + 1);
    const startRow = Math.max(0, Math.floor(this.camera.y / TILE_PX) - 1);
    const endRow = Math.min(this.map.height - 1, Math.ceil((this.camera.y + this.canvas.height) / TILE_PX) + 1);

    const sparkRescued = rescued.has('dragon-spark');
    const pebbleRescued = rescued.has('dragon-pebble');

    // 1. Ground & Decor layers
    for (let y = startRow; y <= endRow; y++) {
      for (let x = startCol; x <= endCol; x++) {
        const sx = Math.round(x * TILE_PX - this.camera.x);
        const sy = Math.round(y * TILE_PX - this.camera.y);
        const key = `${x},${y}`;
        const ov = dynamicOverrides.get(key);

        let groundTile = this.map.layers.ground[y][x];
        if (ov && ov.layer === 'ground') {
          groundTile = ov.tile;
        }
        this.sprites.drawTile(ctx, groundTile, this.eraKey, sx, sy, TILE_PX, TILE_PX);

        // Animated water shimmer
        if (groundTile === 'water') {
          const shimmer = Math.sin(this.time * 3 + x * 0.9 + y * 0.7);
          if (shimmer > 0.55) {
            ctx.fillStyle = 'rgba(186, 230, 253, 0.28)';
            ctx.fillRect(sx + 8, sy + 14 + Math.round(shimmer * 4), 16, 4);
          }
        }

        // Bit 1 visual upgrade: swaying flower pixels after Spark is rescued
        if (sparkRescued && groundTile === 'grass_flower') {
          const sway = Math.round(Math.sin(this.time * 4 + x + y) * 2);
          ctx.fillStyle = 'rgba(254, 240, 138, 0.55)';
          ctx.fillRect(sx + 20 + sway, sy + 14, 4, 4);
        }

        let decorTile = this.map.layers.decor[y][x];
        if (ov && ov.layer === 'decor') {
          decorTile = ov.tile;
        }
        if (decorTile) {
          this.sprites.drawTile(ctx, decorTile, this.eraKey, sx, sy, TILE_PX, TILE_PX);
        }
      }
    }

    // 2. Entities (sorted by Y along with Hero & Pip for clean depth)
    const drawList = [];

    for (const ent of this.map.entities || []) {
      drawList.push({
        sortY: ent.y + 0.5,
        draw: () => this.drawEntity(ctx, ent, completed, openedChests, rescued),
      });
    }

    // Pip
    drawList.push({
      sortY: this.pip.y,
      draw: () => {
        const px = this.pip.x * TILE_PX - this.camera.x;
        const py = this.pip.y * TILE_PX - this.camera.y;
        const pipSize = TILE_PX * 0.85;
        const bob = Math.sin(this.time * 6) * 2;
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

    // Hero
    drawList.push({
      sortY: this.hero.y,
      draw: () => {
        const hx = this.hero.x * TILE_PX - this.camera.x;
        const hy = this.hero.y * TILE_PX - this.camera.y;
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

    // 3. Bit Restored Ambiance Particles
    if (sparkRescued || pebbleRescued) {
      for (const p of this.particles) {
        const sx = p.x - this.camera.x;
        const sy = p.y - this.camera.y;
        if (sx < -8 || sy < -8 || sx > this.canvas.width + 8 || sy > this.canvas.height + 8) continue;
        const alpha = 0.35 + 0.45 * Math.sin(this.time * 3.5 + p.phase);
        ctx.fillStyle = this.map.realmId === 'realm-02-ruins'
          ? `rgba(167, 243, 208, ${alpha.toFixed(2)})`
          : `rgba(253, 224, 71, ${alpha.toFixed(2)})`;
        ctx.fillRect(Math.round(sx), Math.round(sy), 4, 4);
      }
    }
  }

  drawEntity(ctx, ent, completed, openedChests, rescued) {
    const sx = Math.round(ent.x * TILE_PX - this.camera.x);
    const sy = Math.round(ent.y * TILE_PX - this.camera.y);
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
      this.sprites.drawNpc(ctx, ent.spriteKey, this.eraKey, sx, sy - 4 + bob, TILE_PX, TILE_PX);
    } else if (ent.type === 'vault') {
      const isRescued = rescued.has(ent.refId);
      // Glowing magic circle under dragon
      ctx.fillStyle = isRescued ? 'rgba(52, 211, 153, 0.25)' : 'rgba(246, 201, 69, 0.28)';
      ctx.beginPath();
      ctx.arc(sx + TILE_PX / 2, sy + TILE_PX / 2, TILE_PX * 0.55, 0, Math.PI * 2);
      ctx.fill();
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
      // Floating glowing Python Rune marker
      const markerColor = isDone ? '#34d399' : '#38bdf8';
      ctx.fillStyle = isDone ? 'rgba(52, 211, 153, 0.22)' : 'rgba(56, 189, 248, 0.25)';
      ctx.beginPath();
      ctx.arc(sx + TILE_PX / 2, sy + TILE_PX / 2, TILE_PX * 0.36, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = markerColor;
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(isDone ? '✓' : '★', sx + TILE_PX / 2, sy + 6 + bob);
    }

    // Highlight ring when hero is close enough to interact
    if (isNear) {
      ctx.strokeStyle = '#f6c945';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 2, sy + 2, TILE_PX - 4, TILE_PX - 4);
    }
  }
}
