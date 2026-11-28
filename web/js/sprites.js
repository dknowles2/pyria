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
  }

  loadImage(src) {
    if (this.imageCache.has(src)) {
      return this.imageCache.get(src);
    }
    const entry = { img: new Image(), loaded: false, failed: false };
    entry.img.onload = () => {
      entry.loaded = true;
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
    const entry = this.loadImage(`/assets/sprites/${relPath}?v=20261127i`);
    return entry.loaded ? entry.img : null;
  }

  normalizeEra(eraKey = '8bit') {
    return eraKey === '8bit' ? '8bit' : '16bit';
  }

  getTilesetImage(eraKey = '8bit') {
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    const entry = this.loadImage(`/assets/tilesets/${era.tilesetImage}?v=20261127i`);
    return entry.loaded ? entry.img : null;
  }

  getNpcsImage(eraKey = '8bit') {
    const key = this.normalizeEra(eraKey);
    const era = this.tilesetManifest.eras[key] || this.tilesetManifest.eras['8bit'];
    const entry = this.loadImage(`/assets/tilesets/${era.npcsImage}?v=20261127i`);
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
   * Renders a crisp Hero + Pip preview diorama on a preview canvas.
   */
  drawHeroAndPipPreview(canvas, appearance, eraKey = '8bit', direction = 'down', frameIndex = 0) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
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
    }

    // Soft ground shadow pads
    ctx.fillStyle = eraKey === '64bit' ? 'rgba(10, 14, 24, 0.36)' : 'rgba(52, 211, 153, 0.16)';
    ctx.beginPath();
    ctx.ellipse(w * 0.44, h * 0.80, w * 0.22, h * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = eraKey === '64bit' ? 'rgba(10, 14, 24, 0.30)' : 'rgba(246, 201, 69, 0.16)';
    ctx.beginPath();
    ctx.ellipse(w * 0.75, h * 0.81, w * 0.12, h * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();

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
