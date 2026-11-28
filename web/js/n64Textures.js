// Procedural Nintendo 64 Style Texture Atlas (512x512 = 8x8 grid of 64x64 cells)
// Each 64x64 cell contains a 56x56 seamlessly tileable core surrounded by a 4px wrapped border
// so WebGL hardware gl.LINEAR bilinear filtering never bleeds across atlas cells.

export const ATLAS_GRID = 8;
export const CELL_SIZE = 64;
export const CELL_PAD = 4;
export const CELL_CORE = CELL_SIZE - CELL_PAD * 2; // 56
export const ATLAS_SIZE = ATLAS_GRID * CELL_SIZE; // 512

export const TEX = {
  GRASS: 0,
  GRASS_FLOWER: 1,
  DIRT_PATH: 2,
  WATER: 3,
  BRIDGE_WOOD: 4,
  BRIDGE_BROKEN: 5,
  STONE_FLOOR: 6,
  STONE_WALL: 7,
  CLIFF_ROCK: 8,
  TREE_BARK: 9,
  FOLIAGE_LEAF: 10,
  FOLIAGE_PINE: 11,
  SAND: 12,
  LAVA: 13,
  ICE_FLOOR: 14,
  ICE_WALL: 15,
  OBSIDIAN_FLOOR: 16,
  OBSIDIAN_WALL: 17,
  BRASS_FLOOR: 18,
  CLOUD_FLOOR: 19,
  STAR_TILE: 20,
  FLOWER_BED: 21,
  MOSSY_GATE: 22,
  SHRINE_STONE: 23,
  CRYSTAL: 24,
  MARBLE_COLUMN: 25,
  CHEST_WOOD: 26,
  CORAL: 27,
  GEAR_METAL: 28,
  FLAME: 29,
  PORTAL_VORTEX: 30,
  BUSH_LEAF: 31,
};

export const GROUND_TO_TEX = {
  grass: TEX.GRASS,
  grass_flower: TEX.GRASS_FLOWER,
  flower_bed: TEX.FLOWER_BED,
  dirt_path: TEX.DIRT_PATH,
  water: TEX.WATER,
  bridge_wood: TEX.BRIDGE_WOOD,
  bridge_broken: TEX.BRIDGE_BROKEN,
  stone_floor: TEX.STONE_FLOOR,
  sand: TEX.SAND,
  lava: TEX.LAVA,
  ice_floor: TEX.ICE_FLOOR,
  obsidian_floor: TEX.OBSIDIAN_FLOOR,
  brass_floor: TEX.BRASS_FLOOR,
  cloud_floor: TEX.CLOUD_FLOOR,
  star_tile: TEX.STAR_TILE,
};

// Deterministic hash in [0, 1)
function hash2(x, y, seed = 0) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// Seamless periodic value noise over period P
function periodicNoise(u, v, period, seed) {
  const fx = u * period;
  const fy = v * period;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);

  const ax = ((x0 % period) + period) % period;
  const bx = (ax + 1) % period;
  const ay = ((y0 % period) + period) % period;
  const by = (ay + 1) % period;

  const n00 = hash2(ax, ay, seed);
  const n10 = hash2(bx, ay, seed);
  const n01 = hash2(ax, by, seed);
  const n11 = hash2(bx, by, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function fbm(u, v, basePeriod, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = basePeriod;
  for (let i = 0; i < octaves; i++) {
    sum += periodicNoise(u, v, p, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

function mixRgb(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

// Render one 56x56 core texture via pixel shader fn(u, v) -> [r, g, b], then pad to 64x64
// When clampV is true (vertically directional textures like cliffs/gates/flames), V is clamped instead of wrapped.
function paintCell(atlasData, slot, pixelFn, clampV = false) {
  const gx = slot % ATLAS_GRID;
  const gy = Math.floor(slot / ATLAS_GRID);
  const core = new Uint8ClampedArray(CELL_CORE * CELL_CORE * 4);

  for (let y = 0; y < CELL_CORE; y++) {
    const v = (y + 0.5) / CELL_CORE;
    for (let x = 0; x < CELL_CORE; x++) {
      const u = (x + 0.5) / CELL_CORE;
      const rgb = pixelFn(u, v, x, y);
      const idx = (y * CELL_CORE + x) * 4;
      core[idx] = clampByte(rgb[0]);
      core[idx + 1] = clampByte(rgb[1]);
      core[idx + 2] = clampByte(rgb[2]);
      core[idx + 3] = rgb[3] !== undefined ? clampByte(rgb[3]) : 255;
    }
  }

  const baseX = gx * CELL_SIZE;
  const baseY = gy * CELL_SIZE;
  for (let cy = 0; cy < CELL_SIZE; cy++) {
    const rawSy = cy - CELL_PAD;
    const sy = clampV
      ? Math.max(0, Math.min(CELL_CORE - 1, rawSy))
      : ((rawSy % CELL_CORE) + CELL_CORE) % CELL_CORE;
    for (let cx = 0; cx < CELL_SIZE; cx++) {
      const sx = ((cx - CELL_PAD) % CELL_CORE + CELL_CORE) % CELL_CORE;
      const src = (sy * CELL_CORE + sx) * 4;
      const dst = ((baseY + cy) * ATLAS_SIZE + (baseX + cx)) * 4;
      atlasData[dst] = core[src];
      atlasData[dst + 1] = core[src + 1];
      atlasData[dst + 2] = core[src + 2];
      atlasData[dst + 3] = core[src + 3];
    }
  }
}

function grassPixel(u, v, seed = 11) {
  const broad = fbm(u, v, 4, 3, seed);
  const fine = periodicNoise(u * 1.0, v * 2.0, 14, seed + 7);
  const blade = Math.sin((u * 18 + broad * 2.2) * Math.PI * 2) * 0.5 + 0.5;
  let c = mixRgb([46, 128, 42], [96, 184, 62], broad);
  c = mixRgb(c, [132, 208, 78], fine * blade * 0.45);
  // Subtle warm sun dapples like Hyrule Field / Bob-omb Battlefield
  if (broad > 0.66) c = mixRgb(c, [156, 218, 86], (broad - 0.66) * 1.4);
  if (broad < 0.34) c = mixRgb(c, [30, 96, 36], (0.34 - broad) * 1.3);
  return c;
}

let cachedAtlasCanvas = null;

export function getN64TextureAtlas() {
  if (cachedAtlasCanvas) return cachedAtlasCanvas;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE);
  const data = img.data;

  // 0: GRASS
  paintCell(data, TEX.GRASS, (u, v) => grassPixel(u, v, 11));

  // 1: GRASS_FLOWER
  paintCell(data, TEX.GRASS_FLOWER, (u, v) => {
    let c = grassPixel(u, v, 23);
    const fx = u * 4;
    const fy = v * 4;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const lx = fx - cx - 0.5;
    const ly = fy - cy - 0.5;
    const jx = (hash2(cx, cy, 401) - 0.5) * 0.42;
    const jy = (hash2(cx, cy, 402) - 0.5) * 0.42;
    const d = Math.hypot(lx - jx, ly - jy);
    if (hash2(cx, cy, 403) > 0.35 && d < 0.16) {
      const palette = [
        [254, 240, 138],
        [255, 255, 255],
        [249, 168, 212],
        [253, 186, 116],
      ];
      const pick = palette[Math.floor(hash2(cx, cy, 404) * palette.length)];
      c = d < 0.06 ? [250, 204, 21] : mixRgb(c, pick, 1 - d / 0.16);
    }
    return c;
  });

  // 2: DIRT_PATH — warm golden packed N64 trail with pebbles
  paintCell(data, TEX.DIRT_PATH, (u, v) => {
    const n1 = fbm(u, v, 4, 3, 51);
    const n2 = periodicNoise(u, v, 16, 59);
    const streak = fbm(u, v * 2.0, 4, 2, 67);
    let c = mixRgb([144, 102, 58], [204, 162, 108], n1 * 0.75 + streak * 0.25);
    if (n2 > 0.8) {
      // Smooth little trail pebble
      c = mixRgb(c, [176, 162, 140], (n2 - 0.8) * 3.5);
    } else if (n2 < 0.18) {
      c = mixRgb(c, [110, 74, 40], (0.18 - n2) * 2.5);
    }
    return c;
  });

  // 3: WATER — vibrant N64 cerulean water with caustic ripples
  paintCell(data, TEX.WATER, (u, v) => {
    const w1 = Math.sin((u * 2 + v * 1) * Math.PI * 2 + fbm(u, v, 4, 2, 71) * 3.0);
    const w2 = Math.cos((u * 1 - v * 3) * Math.PI * 2 + fbm(u, v, 4, 2, 79) * 2.5);
    const caustic = Math.pow(Math.max(0, (w1 * w2 + 1) * 0.5), 2.2);
    let c = mixRgb([24, 118, 204], [64, 182, 242], fbm(u, v, 4, 3, 83));
    c = mixRgb(c, [196, 240, 255], caustic * 0.72);
    return c;
  });

  // 4: BRIDGE_WOOD — N64 timber planks with grain and dark seams
  paintCell(data, TEX.BRIDGE_WOOD, (u, v) => {
    const plank = Math.floor(v * 5);
    const pv = (v * 5) % 1;
    const seam = pv < 0.08 || pv > 0.94;
    const grain = fbm(u * 0.5, v * 4.0, 4, 3, 101 + plank * 13);
    const tint = (hash2(plank, 1, 107) - 0.5) * 22;
    let c = mixRgb([138, 86, 44], [198, 140, 84], grain);
    c = [c[0] + tint, c[1] + tint * 0.8, c[2] + tint * 0.6];
    if (seam) c = [64, 38, 18];
    // Nail heads near edges
    if (!seam && (Math.abs(u - 0.12) < 0.035 || Math.abs(u - 0.88) < 0.035) && Math.abs(pv - 0.5) < 0.13) {
      c = [58, 52, 50];
    }
    return c;
  });

  // 5: BRIDGE_BROKEN — charred/splintered broken planks
  paintCell(data, TEX.BRIDGE_BROKEN, (u, v) => {
    const plank = Math.floor(v * 5);
    const pv = (v * 5) % 1;
    const grain = fbm(u, v * 3, 4, 3, 131 + plank * 7);
    let c = mixRgb([82, 52, 36], [132, 86, 62], grain);
    if (pv < 0.12 || (Math.abs(u - 0.5) < 0.16 && grain < 0.55)) {
      c = [36, 24, 22];
    }
    return c;
  });

  // 6: STONE_FLOOR — N64 courtyard flagstones with mortar & mossy flecks
  paintCell(data, TEX.STONE_FLOOR, (u, v) => {
    const row = Math.floor(v * 3);
    const uShift = (u + (row % 2) * 0.5) % 1;
    const col = Math.floor(uShift * 3);
    const lu = (uShift * 3) % 1;
    const lv = (v * 3) % 1;
    const edge = Math.min(lu, 1 - lu, lv, 1 - lv);
    const rock = fbm(u, v, 6, 3, 151);
    const varTone = (hash2(col, row, 157) - 0.5) * 26;
    let c = mixRgb([124, 134, 150], [176, 184, 196], rock);
    c = [c[0] + varTone, c[1] + varTone, c[2] + varTone * 0.9];
    if (edge < 0.08) {
      c = mixRgb([68, 76, 88], c, edge / 0.08);
    } else if (edge < 0.14) {
      // Subtle bevel highlight on top-left
      if (lu < 0.14 || lv < 0.14) c = mixRgb(c, [215, 224, 236], 0.35);
    }
    if (rock < 0.28 && edge < 0.16) c = mixRgb(c, [76, 128, 70], 0.45);
    return c;
  });

  // 7: STONE_WALL — chunky N64 castle brick masonry
  paintCell(data, TEX.STONE_WALL, (u, v) => {
    const row = Math.floor(v * 4);
    const uShift = (u + (row % 2) * 0.5) % 1;
    const col = Math.floor(uShift * 2);
    const lu = (uShift * 2) % 1;
    const lv = (v * 4) % 1;
    const mortar = lu < 0.05 || lu > 0.95 || lv < 0.09 || lv > 0.91;
    const rock = fbm(u, v, 8, 3, 173);
    const brickTint = (hash2(col, row, 179) - 0.5) * 28;
    let c = mixRgb([106, 114, 128], [164, 170, 180], rock);
    c = [c[0] + brickTint, c[1] + brickTint, c[2] + brickTint * 0.85];
    if (mortar) {
      c = [56, 62, 74];
    } else if (lv < 0.2) {
      c = mixRgb(c, [205, 212, 222], 0.3);
    } else if (lv > 0.82) {
      c = mixRgb(c, [58, 66, 78], 0.35);
    }
    return c;
  });

  // 8: CLIFF_ROCK — rugged N64 layered hillside rock with grassy top lip (clamped V)
  paintCell(data, TEX.CLIFF_ROCK, (u, v) => {
    const strata = fbm(u, v * 2.0, 4, 3, 191);
    const crag = fbm(u, v, 8, 3, 197);
    let c = mixRgb([96, 86, 76], [156, 146, 134], strata * 0.6 + crag * 0.4);
    if (crag < 0.36) c = mixRgb(c, [58, 52, 48], 0.5);
    // Grassy overhang along the top of cliffs (v near 0)
    const overhang = 0.14 + fbm(u, 0.2, 6, 2, 199) * 0.12;
    if (v < overhang) {
      const t = Math.max(0, 1 - v / overhang);
      c = mixRgb(c, grassPixel(u, v, 11), Math.min(1, t * 2.2));
    }
    return c;
  }, true);

  // 9: TREE_BARK — grooved warm brown N64 bark
  paintCell(data, TEX.TREE_BARK, (u, v) => {
    const groove = Math.sin(u * Math.PI * 10 + fbm(u, v, 4, 2, 211) * 3.5) * 0.5 + 0.5;
    const grain = fbm(u * 2, v * 0.5, 6, 3, 223);
    return mixRgb([76, 46, 24], [142, 92, 52], groove * 0.55 + grain * 0.45);
  });

  // 10: FOLIAGE_LEAF — dappled lush leafy N64 canopy
  paintCell(data, TEX.FOLIAGE_LEAF, (u, v) => {
    const clump = fbm(u, v, 6, 3, 233);
    const leaf = periodicNoise(u, v, 16, 239);
    let c = mixRgb([26, 92, 40], [82, 178, 66], clump);
    c = mixRgb(c, [134, 212, 84], Math.max(0, leaf - 0.55) * 1.4);
    if (clump < 0.32) c = mixRgb(c, [16, 56, 26], 0.55);
    return c;
  });

  // 11: FOLIAGE_PINE — layered dark evergreen conifer boughs
  paintCell(data, TEX.FOLIAGE_PINE, (u, v) => {
    const tier = (v * 4) % 1;
    const fan = Math.sin(u * Math.PI * 12 + tier * 2.5) * 0.5 + 0.5;
    const n = fbm(u, v, 6, 3, 251);
    let c = mixRgb([18, 74, 44], [52, 148, 80], n * 0.6 + fan * 0.4);
    if (tier < 0.25) c = mixRgb(c, [12, 48, 30], 0.45);
    if (tier > 0.72) c = mixRgb(c, [98, 190, 112], 0.35);
    return c;
  });

  // 12: SAND — warm sunlit N64 dunes
  paintCell(data, TEX.SAND, (u, v) => {
    const wave = Math.sin((u * 2 + v * 4 + fbm(u, v, 4, 2, 263) * 1.5) * Math.PI * 2) * 0.5 + 0.5;
    const grain = periodicNoise(u, v, 20, 269);
    let c = mixRgb([212, 176, 102], [248, 224, 152], wave * 0.65 + grain * 0.35);
    if (grain > 0.88) c = mixRgb(c, [255, 250, 220], 0.5);
    return c;
  });

  // 13: LAVA — molten incandescent magma with dark crust
  paintCell(data, TEX.LAVA, (u, v) => {
    const n = fbm(u, v, 4, 3, 277);
    const vein = Math.abs(fbm(u + 0.3, v + 0.2, 6, 3, 281) - 0.5) * 2;
    let c = mixRgb([76, 18, 16], [220, 56, 18], n);
    if (vein < 0.24) {
      c = mixRgb([254, 240, 110], [250, 130, 20], vein / 0.24);
    }
    return c;
  });

  // 14: ICE_FLOOR — crystalline frosty glacier ice
  paintCell(data, TEX.ICE_FLOOR, (u, v) => {
    const n = fbm(u, v, 4, 3, 293);
    const streak = Math.abs(Math.sin((u * 3 + v * 2 + n * 1.8) * Math.PI));
    let c = mixRgb([128, 206, 248], [228, 246, 255], n * 0.7 + (1 - streak) * 0.3);
    if (streak < 0.08) c = [250, 254, 255];
    return c;
  });

  // 15: ICE_WALL — faceted translucent glacier blocks (clamped V)
  paintCell(data, TEX.ICE_WALL, (u, v) => {
    const n = fbm(u, v, 6, 3, 307);
    const facet = Math.floor(u * 3 + v * 2) % 2;
    let c = mixRgb([56, 164, 232], [210, 242, 255], n);
    if (facet === 0) c = mixRgb(c, [14, 116, 184], 0.22);
    if (v < 0.14) c = mixRgb(c, [245, 252, 255], 0.6);
    return c;
  }, true);

  // 16: OBSIDIAN_FLOOR — dark volcanic stone with glowing purple rune seams
  paintCell(data, TEX.OBSIDIAN_FLOOR, (u, v) => {
    const n = fbm(u, v, 6, 3, 313);
    const lu = (u * 2) % 1;
    const lv = (v * 2) % 1;
    const edge = Math.min(lu, 1 - lu, lv, 1 - lv);
    let c = mixRgb([34, 28, 54], [66, 56, 98], n);
    if (edge < 0.05) c = mixRgb([138, 72, 232], c, edge / 0.05);
    return c;
  });

  // 17: OBSIDIAN_WALL — dark carved monolith with violet crystal veins
  paintCell(data, TEX.OBSIDIAN_WALL, (u, v) => {
    const n = fbm(u, v, 6, 3, 331);
    const crack = Math.abs(fbm(u, v, 8, 2, 337) - 0.5) * 2;
    let c = mixRgb([44, 22, 76], [98, 48, 168], n);
    if (crack < 0.11) c = mixRgb([216, 128, 255], c, crack / 0.11);
    return c;
  });

  // 18: BRASS_FLOOR — warm riveted steampunk brass plates
  paintCell(data, TEX.BRASS_FLOOR, (u, v) => {
    const n = fbm(u * 2.0, v, 6, 3, 349);
    const lu = (u * 2) % 1;
    const lv = (v * 2) % 1;
    let c = mixRgb([148, 92, 24], [224, 166, 62], n);
    if (lu < 0.04 || lv < 0.04) c = [92, 54, 14];
    const rDist = Math.hypot(Math.min(lu, 1 - lu) - 0.12, Math.min(lv, 1 - lv) - 0.12);
    if (rDist < 0.05) c = [248, 214, 118];
    return c;
  });

  // 19: CLOUD_FLOOR — dreamy billowy cumulus clouds
  paintCell(data, TEX.CLOUD_FLOOR, (u, v) => {
    const n = fbm(u, v, 4, 3, 359);
    return mixRgb([186, 226, 252], [252, 254, 255], Math.pow(n, 0.75));
  });

  // 20: STAR_TILE — deep cosmic indigo nebula with stardust
  paintCell(data, TEX.STAR_TILE, (u, v) => {
    const neb = fbm(u, v, 4, 3, 367);
    const star = periodicNoise(u, v, 24, 373);
    let c = mixRgb([16, 18, 52], [58, 48, 124], neb);
    if (neb > 0.65) c = mixRgb(c, [66, 132, 214], (neb - 0.65) * 1.5);
    if (star > 0.91) c = [254, 248, 198];
    return c;
  });

  // 21: FLOWER_BED — lush colorful garden blossoms
  paintCell(data, TEX.FLOWER_BED, (u, v) => {
    let c = grassPixel(u, v, 383);
    const fx = u * 5;
    const fy = v * 5;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const lx = fx - cx - 0.5;
    const ly = fy - cy - 0.5;
    const d = Math.hypot(lx, ly);
    if (d < 0.24) {
      const cols = [
        [244, 63, 94],
        [250, 204, 21],
        [192, 132, 252],
        [56, 189, 248],
        [251, 146, 60],
      ];
      const pick = cols[Math.floor(hash2(cx, cy, 389) * cols.length)];
      c = d < 0.08 ? [254, 240, 138] : mixRgb(c, pick, 1 - d / 0.24);
    }
    return c;
  });

  // 22: MOSSY_GATE — banded iron & oak gate with creeping moss (clamped V)
  paintCell(data, TEX.MOSSY_GATE, (u, v) => {
    const plank = Math.floor(u * 5);
    const pu = (u * 5) % 1;
    const n = fbm(u, v, 6, 2, 409 + plank);
    let c = mixRgb([118, 42, 34], [174, 72, 54], n);
    if (pu < 0.08) c = [52, 22, 18];
    // Horizontal iron bands
    if (Math.abs(v - 0.25) < 0.07 || Math.abs(v - 0.75) < 0.07) {
      c = mixRgb([72, 78, 92], [134, 144, 160], n);
    }
    if (v > 0.78 && n > 0.45) c = mixRgb(c, [78, 142, 58], 0.65);
    return c;
  }, true);

  // 23: SHRINE_STONE — ornate crimson-gold temple masonry
  paintCell(data, TEX.SHRINE_STONE, (u, v) => {
    const n = fbm(u, v, 6, 3, 419);
    let c = mixRgb([138, 28, 56], [214, 58, 88], n);
    if (Math.abs(v - 0.15) < 0.06 || Math.abs(v - 0.85) < 0.06 || Math.abs(u - 0.5) < 0.05) {
      c = mixRgb([214, 168, 44], [254, 226, 112], n);
    }
    return c;
  });

  // 24: CRYSTAL — glowing magenta-cyan faceted prism
  paintCell(data, TEX.CRYSTAL, (u, v) => {
    const n = fbm(u, v, 4, 2, 431);
    const sheen = Math.pow(Math.abs(Math.sin((u * 2 + v) * Math.PI)), 2);
    let c = mixRgb([96, 56, 204], [232, 121, 249], n);
    c = mixRgb(c, [104, 224, 255], sheen * 0.65);
    if (sheen > 0.86) c = [248, 250, 255];
    return c;
  });

  // 25: MARBLE_COLUMN — classical fluted ivory marble
  paintCell(data, TEX.MARBLE_COLUMN, (u, v) => {
    const flute = Math.sin(u * Math.PI * 10) * 0.5 + 0.5;
    const vein = fbm(u, v, 6, 2, 443);
    let c = mixRgb([186, 194, 206], [244, 246, 250], flute * 0.7 + vein * 0.3);
    if (v < 0.12 || v > 0.88) c = mixRgb(c, [224, 212, 186], 0.45);
    return c;
  });

  // 26: CHEST_WOOD — rich wood chest with gold bands
  paintCell(data, TEX.CHEST_WOOD, (u, v) => {
    const n = fbm(u, v * 2, 6, 2, 457);
    let c = mixRgb([124, 68, 24], [186, 116, 48], n);
    const band = u < 0.12 || u > 0.88 || v < 0.14 || v > 0.86 || Math.abs(v - 0.5) < 0.06;
    if (band) c = mixRgb([196, 146, 26], [254, 224, 88], n);
    return c;
  });

  // 27: CORAL — vibrant reef texture
  paintCell(data, TEX.CORAL, (u, v) => {
    const n = fbm(u, v, 8, 3, 463);
    return mixRgb([36, 178, 168], [248, 112, 138], n);
  });

  // 28: GEAR_METAL — golden brass machinery
  paintCell(data, TEX.GEAR_METAL, (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5);
    const ring = Math.sin(d * 28) * 0.5 + 0.5;
    const n = fbm(u, v, 6, 2, 479);
    return mixRgb([164, 108, 22], [250, 210, 74], ring * 0.5 + n * 0.5);
  });

  // 29: FLAME — glowing torch/campfire flame (clamped V)
  paintCell(data, TEX.FLAME, (u, v) => {
    const n = fbm(u, v, 4, 2, 491);
    const hot = Math.max(0, 1 - v * 1.15 + (n - 0.5) * 0.35);
    let c = mixRgb([234, 68, 16], [254, 208, 42], hot);
    if (hot > 0.65) c = mixRgb(c, [255, 252, 224], (hot - 0.65) * 2.5);
    return c;
  }, true);

  // 30: PORTAL_VORTEX — arcane cyan/indigo swirl
  paintCell(data, TEX.PORTAL_VORTEX, (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    const swirl = Math.sin(ang * 4 + r * 18) * 0.5 + 0.5;
    let c = mixRgb([68, 56, 212], [56, 204, 252], swirl);
    if (r < 0.22) c = mixRgb(c, [232, 248, 255], 1 - r / 0.22);
    return c;
  });

  // 31: BUSH_LEAF — dense hedge foliage with bright specks
  paintCell(data, TEX.BUSH_LEAF, (u, v) => {
    const n = fbm(u, v, 8, 3, 503);
    let c = mixRgb([24, 96, 54], [74, 174, 96], n);
    if (n > 0.84) c = [244, 114, 148];
    return c;
  });

  ctx.putImageData(img, 0, 0);
  cachedAtlasCanvas = canvas;
  return canvas;
}
