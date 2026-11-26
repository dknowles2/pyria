import type {
  Direction,
  HeroLoadout,
  MapEntity,
  MapRegion,
  RealmMap,
  SpriteBundle,
  SpriteEraKey,
  WorldBundle,
} from "../shared/types.js";
import {
  drawHeroOnContext,
  drawPipOnContext,
  type ImageCache,
} from "./spriteCanvas.js";

export interface WorldRenderState {
  map: RealmMap;
  era: SpriteEraKey;
  showGrid: boolean;
  heroX: number;
  heroY: number;
  heroDir: Direction;
  pipX: number;
  pipY: number;
  walkTick: number;
  solvedTrials: Set<string>;
  selectedEntityId: string | null;
  loadout: HeroLoadout;
}

export function getEffectiveTileAndCollision(
  map: RealmMap,
  solvedTrials: Set<string>
): {
  ground: string[][];
  decor: (string | null)[][];
  collision: (0 | 1)[][];
} {
  const ground = map.layers.ground.map((row) => [...row]);
  const decor = map.layers.decor.map((row) => [...row]);
  const collision = map.layers.collision.map((row) => [...row]);

  for (const entity of map.entities) {
    if (!entity.dynamicTiles?.length) continue;
    const trialKey = entity.refId || entity.id;
    const unlocked = solvedTrials.has(trialKey);
    for (const dt of entity.dynamicTiles) {
      if (dt.y < 0 || dt.y >= map.height || dt.x < 0 || dt.x >= map.width) {
        continue;
      }
      const tileId = unlocked ? dt.tileWhenUnlocked : dt.tileWhenLocked;
      const coll = unlocked ? dt.collisionWhenUnlocked : dt.collisionWhenLocked;
      if (dt.layer === "ground") {
        ground[dt.y][dt.x] = tileId;
      } else {
        decor[dt.y][dt.x] = tileId;
      }
      collision[dt.y][dt.x] = coll;
    }
  }

  return { ground, decor, collision };
}

export function isTileWalkable(
  map: RealmMap,
  solvedTrials: Set<string>,
  x: number,
  y: number
): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const { collision } = getEffectiveTileAndCollision(map, solvedTrials);
  return collision[y][x] === 0;
}

export function findRegionAt(
  map: RealmMap,
  x: number,
  y: number
): MapRegion | null {
  for (const r of map.regions) {
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
      return r;
    }
  }
  return null;
}

export function findNearbyEntity(
  map: RealmMap,
  x: number,
  y: number
): MapEntity | null {
  let best: MapEntity | null = null;
  let bestDist = 999;
  for (const e of map.entities) {
    const dist = Math.abs(e.x - x) + Math.abs(e.y - y);
    if (dist <= 1 && dist < bestDist) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

export function renderWorldCanvas(
  canvas: HTMLCanvasElement,
  worldBundle: WorldBundle,
  spriteBundle: SpriteBundle,
  cache: ImageCache,
  ws: WorldRenderState
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { map, era } = ws;
  const ts = map.tileSize; // 16
  const scale = 2; // 32px per tile -> 1024x768 internal, CSS fits container crisply
  const drawSize = ts * scale;

  const targetW = map.width * drawSize;
  const targetH = map.height * drawSize;
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.clearRect(0, 0, targetW, targetH);
  ctx.imageSmoothingEnabled = false;

  const eraTileset = worldBundle.tilesetManifest.eras[era];
  const tilesetImg = cache.get(eraTileset.tilesetImage);
  const npcsImg = cache.get(eraTileset.npcsImage);

  const { ground, decor } = getEffectiveTileAndCollision(map, ws.solvedTrials);

  // 1. Ground + Decor layers
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const gId = ground[y][x];
      const gRect = eraTileset.tiles[gId];
      if (tilesetImg && gRect) {
        ctx.drawImage(
          tilesetImg,
          gRect.x,
          gRect.y,
          gRect.width,
          gRect.height,
          x * drawSize,
          y * drawSize,
          drawSize,
          drawSize
        );
      }

      const dId = decor[y][x];
      if (dId) {
        const dRect = eraTileset.tiles[dId];
        if (tilesetImg && dRect) {
          ctx.drawImage(
            tilesetImg,
            dRect.x,
            dRect.y,
            dRect.width,
            dRect.height,
            x * drawSize,
            y * drawSize,
            drawSize,
            drawSize
          );
        }
      }
    }
  }

  // 2. Entities (NPCs, dragons, chests, portals, trial markers)
  for (const entity of map.entities) {
    const px = entity.x * drawSize;
    const py = entity.y * drawSize;
    const npcRect = eraTileset.npcs[entity.spriteKey];
    const tileRect = eraTileset.tiles[entity.spriteKey];

    if (npcRect && npcsImg) {
      ctx.drawImage(
        npcsImg,
        npcRect.x,
        npcRect.y,
        npcRect.width,
        npcRect.height,
        px,
        py,
        drawSize,
        drawSize
      );
    } else if (tileRect && tilesetImg) {
      // If it's a trial entity that's solved, show subtle checkmark highlight
      ctx.drawImage(
        tilesetImg,
        tileRect.x,
        tileRect.y,
        tileRect.width,
        tileRect.height,
        px,
        py,
        drawSize,
        drawSize
      );
    }

    // Highlight selected entity or solved trial
    const isSolved =
      entity.type === "trial" &&
      ws.solvedTrials.has(entity.refId || entity.id);
    if (entity.id === ws.selectedEntityId) {
      ctx.strokeStyle = "#58a6ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, drawSize - 2, drawSize - 2);
    } else if (isSolved) {
      ctx.strokeStyle = "#3fb950";
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 2, py + 2, drawSize - 4, drawSize - 4);
    }
  }

  // 3. Pip & Hero sprites
  const pipPx = ws.pipX * drawSize;
  const pipPy = ws.pipY * drawSize;
  drawPipOnContext(
    ctx,
    spriteBundle,
    cache,
    ws.loadout,
    era,
    ws.heroDir,
    ws.walkTick,
    pipPx + 2,
    pipPy + 2,
    drawSize - 4,
    drawSize - 4
  );

  const heroPx = ws.heroX * drawSize;
  const heroPy = ws.heroY * drawSize;
  // Slightly lift 16-bit 32x32 hero so feet align nicely on the tile
  const heroDrawSize = era === "16bit" ? drawSize + 8 : drawSize;
  const heroOffset = Math.floor((heroDrawSize - drawSize) / 2);
  drawHeroOnContext(
    ctx,
    spriteBundle,
    cache,
    ws.loadout,
    era,
    ws.heroDir,
    ws.walkTick,
    heroPx - heroOffset,
    heroPy - heroOffset * 2,
    heroDrawSize,
    heroDrawSize
  );

  // 4. Optional Grid overlay
  if (ws.showGrid) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= map.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * drawSize + 0.5, 0);
      ctx.lineTo(x * drawSize + 0.5, targetH);
      ctx.stroke();
    }
    for (let y = 0; y <= map.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * drawSize + 0.5);
      ctx.lineTo(targetW, y * drawSize + 0.5);
      ctx.stroke();
    }
  }
}
