// Modular Sprite & Tileset Renderer matching assets/sprites/manifest.json & assets/tilesets/manifest.json

import {
  drawHero3DPortrait,
  drawNpc3DPortrait,
  drawPip3DPortrait,
} from './n64Portrait.js?v=20261127v';

const DIRECTION_ROWS = {
  down: 0,
  up: 1,
  left: 2,
  right: 3,
};

export class SpriteManager {
  constructor(spriteManifest, tilesetManifest) {
    this.spriteManifest = spriteManifest;
    this.tilesetManifest = tilesetManifest;
    this.imageCache = new Map();
    this.onImageLoaded = null;
  }

  loadImage(src) {
    if (this.imageCache.has(src)) {
      return this.imageCache.get(src);
    }
    const entry = { img: new Image(), loaded: false, failed: false };
    entry.img.onload = () => {
      entry.loaded = true;
      if (typeof this.onImageLoaded === 'function') {
        this.onImageLoaded(src);
      }
    };
    entry.img.onerror = () => {
      entry.failed = true;
    };
    entry.img.src = src;
    this.imageCache.set(src, entry);
    return entry;
  }

  getSpriteImage(relPath) {
    if (!relPath) return null;
    const entry = this.loadImage(`/assets/sprites/${relPath}?v=20261127m`);
    return entry.loaded ? entry.img : null;
  }

  normalizeEra(eraKey = '8bit') {
    return ['16bit', '32bit', '64bit'].includes(eraKey) ? '16bit' : '8bit';
  }

  getTilesetImage(eraKey = '8bit') {
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    const entry = this.loadImage(`/assets/tilesets/${era.tilesetImage}?v=20261128a`);
    return entry.loaded ? entry.img : null;
  }

  getNpcsImage(eraKey = '8bit') {
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    const entry = this.loadImage(`/assets/tilesets/${era.npcsImage}?v=20261127m`);
    return entry.loaded ? entry.img : null;
  }

  preloadCore(eraKey = '8bit') {
    const key = this.normalizeEra(eraKey);
    this.getTilesetImage(key);
    this.getNpcsImage(key);
    const layers = this.spriteManifest.layers;
    if (layers.shadow?.default?.[key]) this.getSpriteImage(layers.shadow.default[key]);
    if (layers.companion?.pip_base?.[key]) this.getSpriteImage(layers.companion.pip_base[key]);
  }

  preloadHero(appearance, eraKey = '8bit') {
    if (!appearance) return;
    const key = this.normalizeEra(eraKey);
    const order = this.spriteManifest.layerOrder?.default || [];
    for (const slot of order) {
      const relPath = this.resolveHeroLayerPath(slot, appearance, key);
      if (relPath) this.getSpriteImage(relPath);
    }
    if (appearance.pipScarf) {
      const scarfPath = this.spriteManifest.layers.companion_neck?.[appearance.pipScarf]?.[key];
      if (scarfPath) this.getSpriteImage(scarfPath);
    }
  }

  getEraSpec(eraKey = '8bit') {
    if (this.normalizeEra(eraKey) === '16bit') {
      return this.spriteManifest.eras['era-02-16bit'];
    }
    return this.spriteManifest.eras['era-01-8bit'];
  }

  resolveHeroLayerPath(slot, appearance, eraKey) {
    eraKey = this.normalizeEra(eraKey);
    const layers = this.spriteManifest.layers;
    const hatKey = appearance.hat || null;
    const fullCoverage = this.spriteManifest.fullCoverageHeadgear || [];
    const tucksHair = hatKey && fullCoverage.includes(hatKey);

    switch (slot) {
      case 'shadow':
        return layers.shadow?.default?.[eraKey] || null;
      case 'skin': {
        const key = appearance.skin || 'warm_tan';
        return layers.skin?.[key]?.[eraKey] || null;
      }
      case 'hair': {
        const key = appearance.hair || 'spiky';
        const hairObj = layers.hair?.[key];
        if (!hairObj) return null;
        return tucksHair ? (hairObj[`${eraKey}_tucked`] || hairObj[eraKey]) : hairObj[eraKey];
      }
      case 'torso': {
        const color = appearance.tunic || 'emerald';
        const tunicKey = color.startsWith('tunic_') ? color : `tunic_${color}`;
        return layers.torso?.[tunicKey]?.[eraKey] || null;
      }
      case 'footwear': {
        const bootsKey = appearance.boots || 'boots_default';
        return layers.footwear?.[bootsKey]?.[eraKey] || layers.footwear?.boots_default?.[eraKey] || null;
      }
      case 'headgear':
        if (!hatKey) return null;
        return layers.headgear?.[hatKey]?.[eraKey] || null;
      case 'back_behind':
        if (!appearance.cloak) return null;
        return layers.back?.[appearance.cloak]?.[`${eraKey}_back`] || null;
      case 'back_front':
        if (!appearance.cloak) return null;
        return layers.back?.[appearance.cloak]?.[`${eraKey}_front`] || null;
      case 'offhand':
        if (!appearance.shield) return null;
        return layers.offhand?.[appearance.shield]?.[eraKey] || null;
      case 'aura':
        if (!appearance.aura) return null;
        return layers.aura?.[appearance.aura]?.[eraKey] || null;
      default:
        return null;
    }
  }

  /**
   * Draws the modular layered Hero sprite at (dx, dy) with size (dw, dh).
   */
  drawHero(ctx, appearance, eraKey, direction, frameIndex, dx, dy, dw, dh) {
    if (eraKey === '64bit' && drawHero3DPortrait(ctx, appearance, direction, frameIndex, dx, dy, dw, dh)) {
      return;
    }
    const spec = this.getEraSpec(eraKey);
    const row = DIRECTION_ROWS[direction] ?? 0;
    const col = ((frameIndex % spec.heroFramesPerDirection) + spec.heroFramesPerDirection) % spec.heroFramesPerDirection;
    const sx = col * spec.heroFrameSize.width;
    const sy = row * spec.heroFrameSize.height;
    const sw = spec.heroFrameSize.width;
    const sh = spec.heroFrameSize.height;

    const order = direction === 'up'
      ? this.spriteManifest.layerOrder.up
      : this.spriteManifest.layerOrder.default;

    ctx.imageSmoothingEnabled = false;
    for (const slot of order) {
      const relPath = this.resolveHeroLayerPath(slot, appearance, eraKey);
      if (!relPath) continue;
      const img = this.getSpriteImage(relPath);
      if (!img) continue;
      ctx.drawImage(img, sx, sy, sw, sh, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
    }
  }

  /**
   * Draws animated Pip + optional companion_neck scarf.
   */
  drawPip(ctx, appearance, eraKey, direction, frameIndex, dx, dy, dw, dh) {
    if (eraKey === '64bit' && drawPip3DPortrait(ctx, appearance, direction, frameIndex, dx, dy, dw, dh)) {
      return;
    }
    const key = this.normalizeEra(eraKey);
    const spec = this.getEraSpec(key);
    const row = DIRECTION_ROWS[direction] ?? 0;
    const col = ((frameIndex % spec.pipFramesPerDirection) + spec.pipFramesPerDirection) % spec.pipFramesPerDirection;
    const sx = col * spec.pipFrameSize.width;
    const sy = row * spec.pipFrameSize.height;
    const sw = spec.pipFrameSize.width;
    const sh = spec.pipFrameSize.height;

    ctx.imageSmoothingEnabled = false;
    const basePath = this.spriteManifest.layers.companion?.pip_base?.[key];
    const baseImg = this.getSpriteImage(basePath);
    if (baseImg) {
      ctx.drawImage(baseImg, sx, sy, sw, sh, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
    }

    if (appearance && appearance.pipScarf) {
      const scarfPath = this.spriteManifest.layers.companion_neck?.[appearance.pipScarf]?.[key];
      const scarfImg = this.getSpriteImage(scarfPath);
      if (scarfImg) {
        ctx.drawImage(scarfImg, sx, sy, sw, sh, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
      }
    }
  }

  hasTile(tileId, eraKey = '8bit') {
    if (!tileId) return false;
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    return Boolean(era.tiles && era.tiles[tileId]);
  }

  getTileVariantId(tileId, eraKey, x, y) {
    if (!tileId || this.normalizeEra(eraKey) === '8bit') return tileId;
    const era = this.tilesetManifest.eras['16bit'];
    const group = era?.variants?.[tileId];
    if (!Array.isArray(group) || group.length < 4) return tileId;
    // Map (x, y) onto the 2x2 seamless 64x64 world-space macro-tile
    const idx = ((y & 1) << 1) | (x & 1);
    return group[idx] || tileId;
  }

  /**
   * Draws a map tile from meadow_ruins tileset.
   */
  drawTile(ctx, tileId, eraKey, dx, dy, dw, dh) {
    if (!tileId) return false;
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    const rect = era.tiles[tileId];
    if (!rect) return false;
    const img = this.getTilesetImage(key);
    if (!img) return false;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
    return true;
  }

  /**
   * Draws an NPC or Dragon sprite from npcs_and_dragons sheet.
   */
  drawNpc(ctx, npcKey, eraKey, dx, dy, dw, dh, direction = null) {
    if (!npcKey) return false;
    if (eraKey === '64bit' && drawNpc3DPortrait(ctx, npcKey, direction, dx, dy, dw, dh)) {
      return true;
    }
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    const rect = era.npcs[npcKey];
    if (!rect) return false;
    const img = this.getNpcsImage(key);
    if (!img) return false;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, Math.round(dx), Math.round(dy), Math.round(dw), Math.round(dh));
    return true;
  }

  hasNpcKey(npcKey, eraKey = '8bit') {
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    return Boolean(era.npcs && era.npcs[npcKey]);
  }

  /**
   * Draws an era-aware portrait backdrop for NPC dialogue, dragon rescue, and HUD portraits.
   */
  drawPortraitBackdrop(ctx, w, h, eraKey = '8bit', theme = 'meadow') {
    const isRich = this.normalizeEra(eraKey) !== '8bit';
    if (!isRich) {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    if (theme === 'dragon') {
      sky.addColorStop(0, '#1e1b4b');
      sky.addColorStop(0.6, '#312e81');
      sky.addColorStop(1, '#1e293b');
    } else if (theme === 'hud') {
      sky.addColorStop(0, '#1e3a5f');
      sky.addColorStop(1, '#14532d');
    } else {
      sky.addColorStop(0, '#1d4ed8');
      sky.addColorStop(0.55, '#38bdf8');
      sky.addColorStop(0.72, '#43a64a');
      sky.addColorStop(1, '#1b5e2e');
    }
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Warm SNES radial spotlight behind portrait subject
    const glow = ctx.createRadialGradient(w * 0.5, h * 0.45, 2, w * 0.5, h * 0.45, w * 0.58);
    glow.addColorStop(0, theme === 'dragon' ? 'rgba(250, 204, 21, 0.34)' : 'rgba(254, 243, 199, 0.28)');
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * Renders a crisp Hero + Pip preview diorama on a preview canvas (era-aware 8-bit vs 16-bit SNES).
   */
  drawHeroAndPipPreview(canvas, appearance, eraKey = '8bit', direction = 'down', frameIndex = 0) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const isRich = this.normalizeEra(eraKey) !== '8bit';
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = eraKey === '64bit';

    if (eraKey === '64bit') {
      // N64 cobalt sky + emerald hill studio backdrop for 3D character showcase
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#1e3a8a');
      bg.addColorStop(0.62, '#38bdf8');
      bg.addColorStop(0.64, '#2d6a4f');
      bg.addColorStop(1, '#143628');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = 'rgba(10, 14, 24, 0.36)';
      ctx.beginPath();
      ctx.ellipse(w * 0.44, h * 0.80, w * 0.22, h * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(10, 14, 24, 0.30)';
      ctx.beginPath();
      ctx.ellipse(w * 0.75, h * 0.81, w * 0.12, h * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (isRich) {
      // Lush 16-Bit SNES miniature diorama backdrop
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#1e3a8a');
      sky.addColorStop(0.52, '#38bdf8');
      sky.addColorStop(0.56, '#43a64a');
      sky.addColorStop(1, '#1b5e2e');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      const sun = ctx.createRadialGradient(w * 0.25, h * 0.18, 2, w * 0.35, h * 0.35, w * 0.72);
      sun.addColorStop(0, 'rgba(254, 243, 199, 0.32)');
      sun.addColorStop(1, 'rgba(254, 243, 199, 0)');
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = 'rgba(21, 128, 61, 0.55)';
      ctx.beginPath();
      ctx.ellipse(w * 0.54, h * 0.81, w * 0.42, h * 0.14, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
      ctx.beginPath();
      ctx.ellipse(w * 0.44, h * 0.79, w * 0.16, h * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(15, 23, 42, 0.3)';
      ctx.beginPath();
      ctx.ellipse(w * 0.74, h * 0.81, w * 0.1, h * 0.045, 0, 0, Math.PI * 2);
      ctx.fill();

      const sparkleY = frameIndex % 2 === 0 ? 0 : -2;
      ctx.fillStyle = 'rgba(254, 240, 138, 0.85)';
      ctx.fillRect(Math.round(w * 0.18), Math.round(h * 0.28 + sparkleY), 2, 2);
      ctx.fillRect(Math.round(w * 0.84), Math.round(h * 0.24 - sparkleY), 2, 2);
      ctx.fillRect(Math.round(w * 0.62), Math.round(h * 0.16 + sparkleY), 2, 2);
    } else {
      // Classic 8-bit soft pixel ground pad
      ctx.fillStyle = 'rgba(52, 211, 153, 0.16)';
      ctx.beginPath();
      ctx.ellipse(w * 0.44, h * 0.78, w * 0.24, h * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(246, 201, 69, 0.16)';
      ctx.beginPath();
      ctx.ellipse(w * 0.74, h * 0.8, w * 0.13, h * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const heroSize = eraKey === '64bit' ? Math.min(w * 0.68, h * 0.86) : Math.min(w * 0.56, h * 0.72);
    const pipSize = heroSize * 0.56;
    const bob = frameIndex % 2 === 1 ? (eraKey === '64bit' ? -4 : -2) : 0;

    this.drawHero(
      ctx,
      appearance,
      eraKey,
      direction,
      frameIndex,
      w * 0.44 - heroSize / 2,
      h * 0.82 - heroSize * 0.90,
      heroSize,
      heroSize
    );

    this.drawPip(
      ctx,
      appearance,
      eraKey,
      direction,
      frameIndex,
      w * 0.75 - pipSize / 2,
      h * 0.80 - pipSize * 0.92 + bob,
      pipSize,
      pipSize
    );
  }
}
