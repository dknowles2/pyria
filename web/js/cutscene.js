// Retro RPG Letterbox Cinematic Cut-Scene Player for Pyria
// Renders live, era-authentic in-game backdrops (8-Bit NES, 16-Bit SNES, 32-Bit Isometric 2.5D,
// and 64-Bit Nintendo 64 Textured 3D) with real-time era-evolution laser wipes.

import { audio } from './audio.js?v=20261127i';
import {
  ATLAS_GRID,
  CELL_CORE,
  CELL_PAD,
  CELL_SIZE,
  TEX,
  getN64TextureAtlas,
} from './n64Textures.js?v=20261127u';

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
  'realm-64-01-valley': ['#1d4ed8', '#143628'],
  'realm-64-02-courtyard': ['#1e40af', '#334155'],
  'realm-64-03-observatory': ['#0b1026', '#312e81'],
  'realm-64-04-sanctum': ['#2e1065', '#7f1d1d'],
};

// Extract a single 56x56 tileable texture from the procedural N64 atlas as a CanvasPattern
const N64_PATTERNS = new Map();
function getN64Pattern(ctx, slot) {
  if (N64_PATTERNS.has(slot)) return N64_PATTERNS.get(slot);
  try {
    const atlas = getN64TextureAtlas();
    const gx = slot % ATLAS_GRID;
    const gy = Math.floor(slot / ATLAS_GRID);
    const tile = document.createElement('canvas');
    tile.width = CELL_CORE;
    tile.height = CELL_CORE;
    const tctx = tile.getContext('2d');
    tctx.drawImage(
      atlas,
      gx * CELL_SIZE + CELL_PAD,
      gy * CELL_SIZE + CELL_PAD,
      CELL_CORE,
      CELL_CORE,
      0,
      0,
      CELL_CORE,
      CELL_CORE
    );
    const pat = ctx.createPattern(tile, 'repeat');
    N64_PATTERNS.set(slot, pat);
    return pat;
  } catch {
    return null;
  }
}

function drawIsoCube(ctx, cx, cy, hw, hh, h, top, left, right) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
  ctx.fillStyle = top;
  ctx.fill();
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.25)';
  ctx.lineWidth = 0.6;
  ctx.stroke();

  if (h > 0) {
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx, cy + hh + h);
    ctx.lineTo(cx - hw, cy + h);
    ctx.closePath();
    ctx.fillStyle = left;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx, cy + hh + h);
    ctx.lineTo(cx + hw, cy + h);
    ctx.closePath();
    ctx.fillStyle = right;
    ctx.fill();
  }
}

// Live 8-Bit NES / 16-Bit SNES tileset stage using real game tiles
function drawTiledEraStage(ctx, eraKey, realmId, sprites, now) {
  const is16 = eraKey === '16bit';
  const [cTop, cBot] = BIOME_BACKDROPS[realmId] || (is16 ? ['#1d4ed8', '#0f172a'] : ['#0f172a', '#080c17']);
  const sky = ctx.createLinearGradient(0, 0, 0, 88);
  sky.addColorStop(0, is16 ? '#1e3a8a' : cTop);
  sky.addColorStop(0.65, is16 ? '#38bdf8' : '#1e293b');
  sky.addColorStop(1, is16 ? '#bae6fd' : cBot);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 320, 148);

  // Pixel stars (8-bit) or drifting SNES clouds (16-bit)
  if (!is16) {
    for (let i = 0; i < 24; i++) {
      const sx = (i * 47 + 13) % 316;
      const sy = (i * 29 + 7) % 58;
      const tw = Math.sin(now * 0.004 + i) > 0.2 ? 0.85 : 0.35;
      ctx.fillStyle = `rgba(254, 240, 138, ${tw})`;
      ctx.fillRect(sx, sy, 2, 2);
    }
  } else {
    const drift = (now * 0.008) % 360;
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 78 + drift) % 360) - 24;
      const cy = 14 + (i % 3) * 14;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(Math.round(cx), cy, 26, 6);
      ctx.fillRect(Math.round(cx + 5), cy - 4, 16, 4);
    }
  }

  // Distant pixel hills + warm SNES sunbeam in 16-bit
  ctx.fillStyle = is16 ? '#1e6b4a' : '#14281d';
  ctx.beginPath();
  ctx.moveTo(0, 74);
  for (let x = 0; x <= 320; x += 32) {
    const h = 10 + Math.abs(Math.sin(x * 0.03 + 1)) * 16;
    ctx.lineTo(x, 72 - h);
  }
  ctx.lineTo(320, 74);
  ctx.closePath();
  ctx.fill();

  if (is16) {
    const sun = ctx.createRadialGradient(48, 18, 4, 48, 18, 150);
    sun.addColorStop(0, 'rgba(254, 243, 199, 0.28)');
    sun.addColorStop(1, 'rgba(254, 243, 199, 0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, 320, 148);
  }

  // Live in-game ground & decor tiles (16x16 grid across 320x148)
  const T = 16;
  const startY = 68;
  const cols = 20;
  for (let row = 0; row < 5; row++) {
    const y = startY + row * T;
    for (let col = 0; col < cols; col++) {
      const x = col * T;
      let gTile = 'grass';
      if (row === 0 && (col === 8 || col === 9 || col === 10 || col === 11)) {
        gTile = 'water';
      } else if (row === 2 || row === 3) {
        gTile = 'dirt_path';
      } else if ((col + row) % 5 === 0) {
        gTile = 'grass_flower';
      }
      if (sprites) {
        sprites.drawTile(ctx, gTile, eraKey, x, y, T, T);
      } else {
        ctx.fillStyle = gTile === 'dirt_path' ? '#a67c52' : gTile === 'water' ? '#0284c7' : '#2d6a4f';
        ctx.fillRect(x, y, T, T);
      }
      if (gTile === 'water' && Math.sin(now * 0.004 + col) > 0.3) {
        ctx.fillStyle = 'rgba(224, 242, 254, 0.45)';
        ctx.fillRect(x + 3, y + 6, 8, 2);
      }
      // Framing trees & torches on the far back row
      if (row === 0 && sprites) {
        if (col === 1 || col === 2 || col === 17 || col === 18) {
          sprites.drawTile(ctx, is16 ? 'pine_tree' : 'tree', eraKey, x, y - 6, T, T);
        } else if (col === 5 || col === 14) {
          sprites.drawTile(ctx, 'torch', eraKey, x, y - 4, T, T);
        }
      }
    }
  }
}

// Live 32-Bit Isometric 2.5D Diorama stage matching renderIsometric32Bit
function drawIsometric32Stage(ctx, now) {
  const sky = ctx.createLinearGradient(0, 0, 0, 148);
  sky.addColorStop(0, '#0f172a');
  sky.addColorStop(0.55, '#1e293b');
  sky.addColorStop(1, '#0b1020');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 320, 148);

  const HW = 18;
  const HH = 9;
  const originX = 160;
  const originY = 42;

  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 7; gx++) {
      const cx = originX + (gx - gy) * HW;
      const cy = originY + (gx + gy) * HH;
      const isWater = gy === 0 && gx >= 2 && gx <= 4;
      const isPath = gy === 3 || gx === 3;
      const isHigh = (gx === 0 || gy === 0) && !isWater;
      const elev = isWater ? 0 : isHigh ? 14 : 6;
      const wave = isWater ? Math.sin(now * 0.004 + gx + gy) * 1.2 : 0;

      if (isWater) {
        drawIsoCube(ctx, cx, cy - elev + wave, HW, HH, 8, '#29b6f6', '#0288d1', '#01579b');
      } else if (isPath) {
        drawIsoCube(ctx, cx, cy - elev, HW, HH, 12 + elev, '#c79c6e', '#9c7248', '#785230');
      } else if (isHigh) {
        drawIsoCube(ctx, cx, cy - elev, HW, HH, 14 + elev, '#8d99ae', '#64748b', '#475569');
      } else {
        drawIsoCube(ctx, cx, cy - elev, HW, HH, 12 + elev, '#43a047', '#2e7d32', '#1b5e20');
      }

      // Isometric trees & stone pillars framing the stage
      if (gy === 1 && (gx === 1 || gx === 5)) {
        ctx.fillStyle = '#6d4c41';
        ctx.fillRect(Math.round(cx - 2), Math.round(cy - elev - 10), 4, 10);
        drawIsoCube(ctx, cx, cy - elev - 18, HW * 0.62, HH * 0.62, 10, '#22c55e', '#15803d', '#14532d');
      } else if (gx === 0 && gy === 2) {
        drawIsoCube(ctx, cx, cy - elev - 18, HW * 0.48, HH * 0.48, 18, '#f8fafc', '#cbd5e1', '#64748b');
      }
    }
  }
}

// Live 64-Bit Nintendo 64 Textured 3D stage matching n64Renderer.js (cobalt sky, clouds, mountains,
// procedural N64 textures, pine trees, battlements/crystals, and N64 atmospheric horizon fog!)
function drawN64Stage(ctx, realmId, now) {
  const id = String(realmId || '').toLowerCase();
  const isObs = id.includes('observatory') || id.includes('star');
  const isSanctum = id.includes('sanctum') || id.includes('crypt');
  const isCourt = id.includes('courtyard') || id.includes('ruins');

  const horizonY = 66;
  const sky = ctx.createLinearGradient(0, 0, 0, horizonY + 8);
  if (isSanctum) {
    sky.addColorStop(0, '#14081f');
    sky.addColorStop(0.6, '#3b0764');
    sky.addColorStop(1, '#991b1b');
  } else if (isObs) {
    sky.addColorStop(0, '#0b1026');
    sky.addColorStop(0.6, '#1e1b4b');
    sky.addColorStop(1, '#4c3f91');
  } else if (isCourt) {
    sky.addColorStop(0, '#1e40af');
    sky.addColorStop(0.6, '#60a5fa');
    sky.addColorStop(1, '#fde68a');
  } else {
    sky.addColorStop(0, '#1d4ed8');
    sky.addColorStop(0.62, '#38bdf8');
    sky.addColorStop(1, '#bae6fd');
  }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 320, horizonY + 8);

  // Twinkling stars for Observatory/Sanctum or drifting chunky N64 clouds for Valley/Courtyard
  if (isObs || isSanctum) {
    for (let i = 0; i < 36; i++) {
      const sx = (i * 53 + 11) % 318;
      const sy = (i * 23 + 5) % (horizonY - 8);
      const a = 0.4 + 0.6 * Math.abs(Math.sin(now * 0.003 + i));
      ctx.fillStyle = `rgba(254, 249, 195, ${a.toFixed(2)})`;
      ctx.fillRect(sx, sy, i % 4 === 0 ? 2 : 1, i % 4 === 0 ? 2 : 1);
    }
  } else {
    const drift = (now * 0.009) % 380;
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 82 + drift) % 380) - 36;
      const cy = 15 + (i % 3) * 14;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.moveTo(cx - 22, cy + 4);
      ctx.lineTo(cx - 8, cy - 8);
      ctx.lineTo(cx + 8, cy - 10);
      ctx.lineTo(cx + 24, cy + 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Layered low-poly N64 distant mountain ring
  const mFar = isSanctum ? '#4c1d95' : isObs ? '#312e81' : isCourt ? '#7c93b8' : '#60a5fa';
  const mNear = isSanctum ? '#2e1065' : isObs ? '#1e1b4b' : isCourt ? '#4e6485' : '#3b82f6';
  const drawRange = (col, baseH, amp, seed) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, horizonY + 6);
    for (let i = 0; i <= 12; i++) {
      const mx = (320 / 12) * i;
      const pk = baseH + Math.abs(Math.sin(i * 0.8 + seed)) * amp;
      ctx.lineTo(mx, horizonY + 2 - pk);
    }
    ctx.lineTo(320, horizonY + 6);
    ctx.closePath();
    ctx.fill();
  };
  drawRange(mFar, 12, 22, 1.2);
  drawRange(mNear, 5, 15, 3.4);

  // Textured N64 Ground Plane using our actual procedural N64 texture atlas!
  const groundTex = isSanctum ? TEX.OBSIDIAN_FLOOR : isObs ? TEX.STAR_TILE : isCourt ? TEX.STONE_FLOOR : TEX.GRASS;
  const pathTex = isSanctum ? TEX.STONE_FLOOR : isObs ? TEX.ICE_FLOOR : TEX.DIRT_PATH;
  const gPat = getN64Pattern(ctx, groundTex);
  const pPat = getN64Pattern(ctx, pathTex);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = gPat || (isSanctum ? '#2e1b4b' : isObs ? '#1e1b4b' : isCourt ? '#64748b' : '#3a9c46');
  ctx.fillRect(0, horizonY, 320, 148 - horizonY);

  // Central N64 perspective road/platform leading toward the horizon
  ctx.beginPath();
  ctx.moveTo(132, horizonY);
  ctx.lineTo(188, horizonY);
  ctx.lineTo(276, 148);
  ctx.lineTo(44, 148);
  ctx.closePath();
  ctx.fillStyle = pPat || '#b88c58';
  ctx.fill();

  // Sparkling water canal strip in Valley
  if (!isSanctum && !isObs && !isCourt) {
    const wPat = getN64Pattern(ctx, TEX.WATER);
    ctx.save();
    ctx.translate((now * 0.012) % 56, 0);
    ctx.fillStyle = wPat || '#29b6f6';
    ctx.fillRect(-56, horizonY + 4, 432, 14);
    ctx.restore();
  }

  // N64 Atmospheric Distance Fog blending ground smoothly into the horizon
  const fogRgb = isSanctum ? '72, 36, 92' : isObs ? '56, 51, 112' : isCourt ? '194, 214, 235' : '174, 219, 250';
  const fog = ctx.createLinearGradient(0, horizonY, 0, horizonY + 34);
  fog.addColorStop(0, `rgba(${fogRgb}, 0.92)`);
  fog.addColorStop(1, `rgba(${fogRgb}, 0.0)`);
  ctx.fillStyle = fog;
  ctx.fillRect(0, horizonY, 320, 34);

  // Framing N64 low-poly 3D props along left/right edges (3-tier pines, castle battlements, or crystals)
  const drawPine = (px, py, sc) => {
    ctx.fillStyle = '#6b3e1f';
    ctx.fillRect(px - 2.5 * sc, py - 10 * sc, 5 * sc, 10 * sc);
    for (let t = 0; t < 3; t++) {
      const w = (14 - t * 3) * sc;
      const y0 = py - (7 + t * 8) * sc;
      const y1 = y0 - 13 * sc;
      const grad = ctx.createLinearGradient(px - w, y1, px + w, y0);
      grad.addColorStop(0, '#4ade80');
      grad.addColorStop(1, '#14532d');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(px, y1);
      ctx.lineTo(px - w, y0);
      ctx.lineTo(px + w, y0);
      ctx.closePath();
      ctx.fill();
    }
  };

  if (isObs || isSanctum) {
    // Glowing crystal spires framing the cosmic/sanctum stage
    for (const [cx, cy, sc] of [[24, 98, 1.1], [296, 98, 1.1], [46, 82, 0.72], [274, 82, 0.72]]) {
      const cg = ctx.createLinearGradient(cx - 8 * sc, cy - 32 * sc, cx + 8 * sc, cy);
      cg.addColorStop(0, '#f0abfc');
      cg.addColorStop(0.5, '#38bdf8');
      cg.addColorStop(1, '#4c1d95');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 34 * sc);
      ctx.lineTo(cx + 8 * sc, cy - 10 * sc);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - 8 * sc, cy - 10 * sc);
      ctx.closePath();
      ctx.fill();
    }
  } else if (isCourt) {
    // Castle stone rampart silhouette across the background
    const wallPat = getN64Pattern(ctx, TEX.STONE_WALL);
    ctx.fillStyle = wallPat || '#64748b';
    ctx.fillRect(0, horizonY - 12, 320, 22);
    for (let bx = 8; bx < 320; bx += 28) {
      ctx.fillRect(bx, horizonY - 18, 14, 6);
    }
  } else {
    drawPine(26, 98, 1.15);
    drawPine(294, 98, 1.15);
    drawPine(54, 82, 0.75);
    drawPine(266, 82, 0.75);
  }
  ctx.restore();
}

function drawEraStage(ctx, targetEra, realmId, sprites, now) {
  if (targetEra === '64bit') {
    drawN64Stage(ctx, realmId, now);
  } else if (targetEra === '32bit') {
    drawIsometric32Stage(ctx, now);
  } else if (targetEra === '16bit') {
    drawTiledEraStage(ctx, '16bit', realmId, sprites, now);
  } else {
    drawTiledEraStage(ctx, '8bit', realmId, sprites, now);
  }
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
        stageEra: '64bit',
        stageRealm: 'realm-64-01-valley',
        text: 'Long ago, the kingdom of Pyria shone in full, vibrant 3D! Great Dragons soared above crystal valleys, and ancient Python spells kept every realm alive.',
      },
      {
        speaker: 'Lord Null',
        spriteKey: 'lord_null',
        side: 'right',
        vfx: 'glitch',
        stageEra: '8bit',
        stageRealm: 'realm-01-meadow',
        text: 'Mwahahaha! Far too colorful! With my Glitch Storm, I drained Pyria all the way down to flat 8-bit pixels and locked every Dragon inside a Logic Vault! Soon all of Pyria will return None!',
      },
      {
        speaker: 'Elder Ada',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'none',
        stageEra: '8bit',
        stageRealm: 'realm-01-meadow',
        text: 'Our only hope is a brave young Code-Tamer with a Python Spellbook — YOU, {heroName}! Every Dragon you rescue restores another Bit of reality and levels up the world.',
      },
      {
        speaker: 'Bram the Tinkerer',
        spriteKey: 'bram',
        side: 'right',
        vfx: 'none',
        stageEra: '8bit',
        stageRealm: 'realm-01-meadow',
        text: "Earn Byte Shards from Trials and hidden chests, kid! Bring 'em to my Workshop and write real Python calls to forge hats, armor, boots, and power-ups!",
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        stageEra: '8bit',
        stageRealm: 'realm-01-meadow',
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
        stageEra: '8bit',
        stageRealm: 'realm-01-meadow',
        text: 'ALL EIGHT BITS ARE WHOLE, {heroName}! Feel the starlight surge across the flatlands as our 8 dragons unite their power!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromEra: '8bit',
          toEra: '16bit',
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
        stageEra: '16bit',
        stageRealm: 'realm-16-01-shallows',
        text: 'GAAAH! Too many colors! My eyes! Retreat to the Sunken Isles — try surviving 16 Realms of Lists, Functions, and Dictionaries, {heroName}!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        stageEra: '16bit',
        stageRealm: 'realm-16-01-shallows',
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
        stageEra: '16bit',
        stageRealm: 'realm-16-01-shallows',
        text: 'Incredible, {heroName}! You conquered all four Acts of the 16-Bit Era and shattered Lord Null’s Throne! Watch the horizon tilt upward!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromEra: '16bit',
          toEra: '32bit',
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
        stageEra: '32bit',
        stageRealm: 'realm-32-01-highlands',
        text: 'A THIRD DIMENSION?! Impossible! Wait until you try navigating 3D Tuples, Sets, and Error Traps inside my Polygon Citadel!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        stageEra: '32bit',
        stageRealm: 'realm-32-01-highlands',
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
        stageEra: '32bit',
        stageRealm: 'realm-32-01-highlands',
        text: 'ALL 32 BITS ARE RESTORED!! Hold onto your spellbook, {heroName} — the Isometric Frontier is breaking wide open into full 3D space!',
      },
      {
        speaker: 'Pyria World Engine',
        spriteKey: 'elder_ada',
        side: 'right',
        vfx: 'bit_restore',
        eraTransition: {
          fromEra: '32bit',
          toEra: '64bit',
          fromLabel: '32-BIT ISOMETRIC',
          toLabel: '64-BIT NINTENDO 64 3D',
        },
        text: 'Textured 3D hills, deep blue skies, far-off mountains, and big N64 horns fill the view!',
      },
      {
        speaker: 'Lord Null',
        spriteKey: 'lord_null',
        side: 'right',
        vfx: 'glitch',
        stageEra: '64bit',
        stageRealm: 'realm-64-04-sanctum',
        text: 'NO!! FULL 64-BIT POLYGONS?! Fine — face my 64-Bit Sanctum! Only a true master of Python Classes, Inheritance, and 3D Scripting can claim the 64-Bit Crown!',
      },
      {
        speaker: 'Pip',
        spriteKey: 'pip',
        side: 'left',
        vfx: 'celebrate',
        stageEra: '64bit',
        stageRealm: 'realm-64-01-valley',
        text: 'WOOHOO!! Look at those 3D mountains, {heroName}! Let’s soar into Polygon Valley and win the 64-Bit Crown!',
      },
    ],
  },
};

let activeCutscene = null;

/**
 * Returns true if a cutscene overlay is currently playing.
 */
export function isCutsceneActive() {
  return Boolean(activeCutscene);
}

/**
 * Plays a full-screen retro letterbox cut-scene and resolves when finished or skipped.
 * Idempotent: if a cutscene is already active, ignores the duplicate start and resolves immediately.
 */
export function playCutscene({
  id = null,
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
    return Promise.resolve(false);
  }

  // Idempotency guard: never stack or enqueue a second cutscene while one is already active
  if (activeCutscene) {
    return Promise.resolve(false);
  }

  const cutsceneKey = id || `${realmId}:${title}:${subtitle}`;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  activeCutscene = { id: cutsceneKey, promise };

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
  overlay.setAttribute('tabindex', '-1');
  overlay.innerHTML = `
      <div class="cutscene-bar cutscene-top">
        <div class="cutscene-title-wrap">
          <div class="cutscene-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="cutscene-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <button id="cutscene-skip-btn" type="button" class="btn btn-sm btn-ghost">Skip ▸▸</button>
      </div>

      <div class="cutscene-stage-wrap">
        <canvas id="cutscene-canvas" width="640" height="296" class="${eraKey === '64bit' ? 'cutscene-canvas' : 'pixel-canvas cutscene-canvas'}"></canvas>
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
  // Move focus off the game canvas / HUD buttons onto the cutscene overlay
  if (typeof overlay.focus === 'function') {
    overlay.focus({ preventScroll: true });
  }

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
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    if (activeCutscene && activeCutscene.promise === promise) {
      activeCutscene = null;
    }
    resolvePromise(true);
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
    const isSpace = e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space';
    const isEnter = e.key === 'Enter' || e.code === 'Enter';
    const isRight = e.key === 'ArrowRight' || e.code === 'ArrowRight';
    const isEsc = e.key === 'Escape' || e.code === 'Escape';

    if (!isSpace && !isEnter && !isRight && !isEsc) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Ignore held-key auto-repeat so holding Space/Enter/Escape doesn't burn through beats
    if (e.repeat) return;

    if (isEsc) {
      cleanupAndFinish();
    } else {
      advance();
    }
  };

  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keydown', onKeyDown, true);

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

  // Preload 8-bit and 16-bit core + custom hero layers so era-transition sweeps never flash blank
  if (sprites) {
    sprites.preloadCore('8bit');
    sprites.preloadCore('16bit');
    if (typeof sprites.preloadHero === 'function') {
      sprites.preloadHero(appearance, '8bit');
      sprites.preloadHero(appearance, '16bit');
    }
  }

  const renderFrame = (now) => {
    if (finished) return;
    const beat = beats[beatIndex];
    const elapsedSec = (now - beatStartTime) / 1000;
    const vfx = beat.vfx || 'none';
    const activeStageEra = beat.stageEra || eraKey;
    const activeStageRealm = beat.stageRealm || realmId;

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
    ctx.imageSmoothingEnabled = activeStageEra === '64bit';

    // Subtle screen shake on glitch / shatter
    if (vfx === 'glitch' || (vfx === 'shatter' && elapsedSec < 0.45)) {
      const mag = vfx === 'shatter' ? 3 : 1.5;
      ctx.translate(
        Math.round((Math.random() - 0.5) * mag * 2),
        Math.round((Math.random() - 0.5) * mag * 2)
      );
    }

    // 1. Live In-Game Era Stage OR Animated Era-Transition Laser Wipe
    let charEraLeft = activeStageEra;
    let charEraRight = activeStageEra;

    if (beat.eraTransition) {
      const tr = beat.eraTransition;
      const fromEra = tr.fromEra || '8bit';
      const toEra = tr.toEra || eraKey;
      const sweep = Math.min(1, Math.max(0, (elapsedSec - 0.25) / 2.2));
      const splitX = Math.round(sweep * 320);

      // Right side (not yet swept): previous era live stage
      drawEraStage(ctx, fromEra, activeStageRealm, sprites, now);

      // Left side (swept): newly evolved era live stage!
      if (splitX > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, splitX, 148);
        ctx.clip();
        drawEraStage(ctx, toEra, activeStageRealm, sprites, now);
        ctx.restore();
      }

      // Characters evolve live as the golden laser sweeps across their X position!
      charEraLeft = splitX >= 84 ? toEra : fromEra;
      charEraRight = splitX >= 232 ? toEra : fromEra;

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
    } else {
      drawEraStage(ctx, activeStageEra, activeStageRealm, sprites, now);
    }

    // Subtle soft ground shadow pads beneath Left (Hero + Pip) and Right speaker
    ctx.fillStyle = 'rgba(8, 12, 24, 0.36)';
    ctx.beginPath();
    ctx.ellipse(80, 113, 24, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(120, 111, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    if (rightSpriteKey) {
      const slideOffset = Math.round((1 - rightSlide) * 44);
      ctx.beginPath();
      ctx.ellipse(234 + slideOffset, 113, 24, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Bit restore rising light pillars (behind characters)
    if (vfx === 'bit_restore') {
      const pillarAlpha = 0.20 + 0.12 * Math.sin(elapsedSec * 5);
      ctx.fillStyle = `rgba(246, 201, 69, ${pillarAlpha.toFixed(2)})`;
      ctx.fillRect(212, 0, 44, 114);
      ctx.fillStyle = `rgba(52, 211, 153, ${(pillarAlpha * 0.72).toFixed(2)})`;
      ctx.fillRect(62, 0, 38, 114);
    }

    const animFrame = Math.floor(now / 260);
    const bob = Math.round(Math.sin(now / 180) * 2);

    // 3. Left side: Customized Hero + hovering Pip
    const heroAlpha = beat.side === 'left' ? 1.0 : 0.80;
    const leftIs64 = charEraLeft === '64bit';
    ctx.globalAlpha = heroAlpha;
    if (sprites) {
      if (leftIs64) {
        sprites.drawHero(ctx, appearance, charEraLeft, 'right', animFrame, 52, 58, 56, 56);
        sprites.drawPip(ctx, appearance, charEraLeft, 'right', animFrame, 106, 66 + bob, 32, 32);
      } else {
        sprites.drawHero(ctx, appearance, charEraLeft, 'right', animFrame, 56, 66, 48, 48);
        sprites.drawPip(ctx, appearance, charEraLeft, 'right', animFrame, 104, 72 + bob, 26, 26);
      }
    }
    ctx.globalAlpha = 1.0;

    // 4. Right side: Antagonist (Lord Null) or Realm Dragon Guardian
    if (rightSpriteKey && sprites) {
      const slideOffset = Math.round((1 - rightSlide) * 44);
      const rightIs64 = charEraRight === '64bit';
      let rightAlpha = beat.side === 'right' ? 1.0 : 0.84;
      if (vfx === 'shatter' && rightSpriteKey === 'lord_null') {
        rightAlpha = Math.max(0.08, 1 - elapsedSec * 0.85);
      }
      ctx.globalAlpha = rightAlpha;
      if (rightIs64) {
        sprites.drawNpc(ctx, rightSpriteKey, charEraRight, 204 + slideOffset, 56 + bob, 56, 56, 'left');
      } else {
        sprites.drawNpc(ctx, rightSpriteKey, charEraRight, 210 + slideOffset, 64 + bob, 48, 48);
      }
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
  return promise;
}
