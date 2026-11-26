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

export type WorldCameraMode = "follow" | "fit";

export interface WorldRenderState {
  map: RealmMap;
  era: SpriteEraKey;
  cameraMode: WorldCameraMode;
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

export interface WorldViewport {
  startX: number;
  startY: number;
  viewTilesW: number;
  viewTilesH: number;
  drawSize: number;
  canvasW: number;
  canvasH: number;
}

export function computeWorldViewport(
  map: RealmMap,
  cameraMode: WorldCameraMode,
  heroX: number,
  heroY: number
): WorldViewport {
  const ts = map.tileSize; // 16
  if (cameraMode === "follow") {
    const viewTilesW = Math.min(20, map.width);
    const viewTilesH = Math.min(14, map.height);
    const startX = Math.max(
      0,
      Math.min(map.width - viewTilesW, heroX - Math.floor(viewTilesW / 2))
    );
    const startY = Math.max(
      0,
      Math.min(map.height - viewTilesH, heroY - Math.floor(viewTilesH / 2))
    );
    const drawSize = ts * 2; // 32px per tile -> 640x448 crisp side-pane viewport
    return {
      startX,
      startY,
      viewTilesW,
      viewTilesH,
      drawSize,
      canvasW: viewTilesW * drawSize,
      canvasH: viewTilesH * drawSize,
    };
  }

  // "fit" mode: show whole map at native 16px (for 64x48 -> 1024x768) or 32px for small maps
  const drawSize = map.width > 40 || map.height > 30 ? ts : ts * 2;
  return {
    startX: 0,
    startY: 0,
    viewTilesW: map.width,
    viewTilesH: map.height,
    drawSize,
    canvasW: map.width * drawSize,
    canvasH: map.height * drawSize,
  };
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
  const vp = computeWorldViewport(map, ws.cameraMode, ws.heroX, ws.heroY);
  const { startX, startY, viewTilesW, viewTilesH, drawSize, canvasW, canvasH } =
    vp;

  if (canvas.width !== canvasW || canvas.height !== canvasH) {
    canvas.width = canvasW;
    canvas.height = canvasH;
  }

  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.imageSmoothingEnabled = false;

  const eraTileset = worldBundle.tilesetManifest.eras[era];
  const tilesetImg = cache.get(eraTileset.tilesetImage);
  const npcsImg = cache.get(eraTileset.npcsImage);

  const { ground, decor } = getEffectiveTileAndCollision(map, ws.solvedTrials);

  const endX = Math.min(map.width, startX + viewTilesW);
  const endY = Math.min(map.height, startY + viewTilesH);

  // 1. Ground + Decor layers within viewport
  for (let y = startY; y < endY; y++) {
    const py = (y - startY) * drawSize;
    for (let x = startX; x < endX; x++) {
      const px = (x - startX) * drawSize;
      const gId = ground[y][x];
      const gRect = eraTileset.tiles[gId];
      if (tilesetImg && gRect) {
        ctx.drawImage(
          tilesetImg,
          gRect.x,
          gRect.y,
          gRect.width,
          gRect.height,
          px,
          py,
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
            px,
            py,
            drawSize,
            drawSize
          );
        }
      }
    }
  }

  // 2. Entities within viewport
  for (const entity of map.entities) {
    if (
      entity.x < startX ||
      entity.x >= endX ||
      entity.y < startY ||
      entity.y >= endY
    ) {
      continue;
    }
    const px = (entity.x - startX) * drawSize;
    const py = (entity.y - startY) * drawSize;
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
  if (
    ws.pipX >= startX &&
    ws.pipX < endX &&
    ws.pipY >= startY &&
    ws.pipY < endY
  ) {
    const pipPx = (ws.pipX - startX) * drawSize;
    const pipPy = (ws.pipY - startY) * drawSize;
    const inset = drawSize >= 24 ? 2 : 1;
    drawPipOnContext(
      ctx,
      spriteBundle,
      cache,
      ws.loadout,
      era,
      ws.heroDir,
      ws.walkTick,
      pipPx + inset,
      pipPy + inset,
      drawSize - inset * 2,
      drawSize - inset * 2
    );
  }

  if (
    ws.heroX >= startX &&
    ws.heroX < endX &&
    ws.heroY >= startY &&
    ws.heroY < endY
  ) {
    const heroPx = (ws.heroX - startX) * drawSize;
    const heroPy = (ws.heroY - startY) * drawSize;
    const heroExtra = era === "16bit" ? Math.round(drawSize * 0.25) : 0;
    const heroDrawSize = drawSize + heroExtra;
    const heroOffset = Math.floor(heroExtra / 2);
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
  }

  // 4. Optional Grid overlay
  if (ws.showGrid) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= viewTilesW; x++) {
      ctx.beginPath();
      ctx.moveTo(x * drawSize + 0.5, 0);
      ctx.lineTo(x * drawSize + 0.5, canvasH);
      ctx.stroke();
    }
    for (let y = 0; y <= viewTilesH; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * drawSize + 0.5);
      ctx.lineTo(canvasW, y * drawSize + 0.5);
      ctx.stroke();
    }
  }
}
