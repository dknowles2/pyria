import type {
  Direction,
  HeroLoadout,
  SpriteBundle,
  SpriteEraKey,
  SpriteManifest,
} from "../shared/types.js";

export type ImageCache = Map<string, HTMLImageElement>;

export async function preloadDataUris(
  images: Record<string, string>,
  cache: ImageCache
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const [key, uri] of Object.entries(images)) {
    if (cache.has(key)) continue;
    tasks.push(
      new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => {
          cache.set(key, img);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = uri;
      })
    );
  }
  await Promise.all(tasks);
}

export function getDirectionRow(
  manifest: SpriteManifest,
  dir: Direction
): number {
  const idx = manifest.directions.indexOf(dir);
  return idx >= 0 ? idx : 0;
}

export function resolveHeroLayerKeys(
  manifest: SpriteManifest,
  loadout: HeroLoadout,
  era: SpriteEraKey,
  dir: Direction
): string[] {
  const order =
    dir === "up" ? manifest.layerOrder.up : manifest.layerOrder.default;
  const fullCoverage = new Set(manifest.fullCoverageHeadgear || []);
  const hatSpec = loadout.hat ? manifest.layers.headgear[loadout.hat] : null;
  const tuckHair = Boolean(
    loadout.hat && (fullCoverage.has(loadout.hat) || hatSpec?.tucksHair)
  );

  const paths: string[] = [];

  for (const slot of order) {
    switch (slot) {
      case "shadow": {
        const p = manifest.layers.shadow.default?.[era];
        if (p) paths.push(p);
        break;
      }
      case "skin": {
        const p = manifest.layers.skin[loadout.skin]?.[era];
        if (p) paths.push(p);
        break;
      }
      case "footwear": {
        const p = manifest.layers.footwear[loadout.boots]?.[era];
        if (p) paths.push(p);
        break;
      }
      case "torso": {
        const key = loadout.tunic.startsWith("tunic_")
          ? loadout.tunic
          : `tunic_${loadout.tunic}`;
        const p = manifest.layers.torso[key]?.[era];
        if (p) paths.push(p);
        break;
      }
      case "hair": {
        const entry = manifest.layers.hair[loadout.hair];
        if (entry) {
          const p = tuckHair
            ? entry[`${era}_tucked` as "8bit_tucked" | "16bit_tucked"] ||
              entry[era]
            : entry[era];
          if (p) paths.push(p);
        }
        break;
      }
      case "headgear": {
        if (loadout.hat) {
          const p = manifest.layers.headgear[loadout.hat]?.[era];
          if (p) paths.push(p);
        }
        break;
      }
      case "back_behind": {
        if (loadout.cloak) {
          const entry = manifest.layers.back[loadout.cloak];
          const p =
            entry?.[`${era}_back` as "8bit_back" | "16bit_back"] ?? null;
          if (p) paths.push(p);
        }
        break;
      }
      case "back_front": {
        if (loadout.cloak) {
          const entry = manifest.layers.back[loadout.cloak];
          const p =
            entry?.[`${era}_front` as "8bit_front" | "16bit_front"] ?? null;
          if (p) paths.push(p);
        }
        break;
      }
      case "offhand": {
        if (loadout.shield) {
          const p = manifest.layers.offhand[loadout.shield]?.[era];
          if (p) paths.push(p);
        }
        break;
      }
      case "aura": {
        if (loadout.aura) {
          const p = manifest.layers.aura[loadout.aura]?.[era];
          if (p) paths.push(p);
        }
        break;
      }
    }
  }

  return paths;
}

export function drawHeroOnContext(
  ctx: CanvasRenderingContext2D,
  bundle: SpriteBundle,
  cache: ImageCache,
  loadout: HeroLoadout,
  era: SpriteEraKey,
  dir: Direction,
  frameIndex: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  const eraSpec =
    era === "8bit"
      ? bundle.manifest.eras["era-01-8bit"]
      : bundle.manifest.eras["era-02-16bit"];
  if (!eraSpec) return;

  const fw = eraSpec.heroFrameSize.width;
  const fh = eraSpec.heroFrameSize.height;
  const row = getDirectionRow(bundle.manifest, dir);
  const col = frameIndex % eraSpec.heroFramesPerDirection;
  const sx = col * fw;
  const sy = row * fh;

  const layerKeys = resolveHeroLayerKeys(bundle.manifest, loadout, era, dir);
  ctx.imageSmoothingEnabled = false;
  for (const key of layerKeys) {
    const img = cache.get(key);
    if (!img) continue;
    ctx.drawImage(img, sx, sy, fw, fh, dx, dy, dw, dh);
  }
}

export function drawPipOnContext(
  ctx: CanvasRenderingContext2D,
  bundle: SpriteBundle,
  cache: ImageCache,
  loadout: HeroLoadout,
  era: SpriteEraKey,
  dir: Direction,
  frameIndex: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  const eraSpec =
    era === "8bit"
      ? bundle.manifest.eras["era-01-8bit"]
      : bundle.manifest.eras["era-02-16bit"];
  if (!eraSpec) return;

  const fw = eraSpec.pipFrameSize.width;
  const fh = eraSpec.pipFrameSize.height;
  const row = getDirectionRow(bundle.manifest, dir);
  const col = frameIndex % eraSpec.pipFramesPerDirection;
  const sx = col * fw;
  const sy = row * fh;

  ctx.imageSmoothingEnabled = false;
  const baseKey = bundle.manifest.layers.companion.pip_base?.[era];
  if (baseKey) {
    const baseImg = cache.get(baseKey);
    if (baseImg) {
      ctx.drawImage(baseImg, sx, sy, fw, fh, dx, dy, dw, dh);
    }
  }
  if (loadout.pipScarf) {
    const scarfKey =
      bundle.manifest.layers.companion_neck.pip_scarf_ember?.[era];
    if (scarfKey) {
      const scarfImg = cache.get(scarfKey);
      if (scarfImg) {
        ctx.drawImage(scarfImg, sx, sy, fw, fh, dx, dy, dw, dh);
      }
    }
  }
}

export function renderHeroPreviewCanvas(
  canvas: HTMLCanvasElement,
  bundle: SpriteBundle,
  cache: ImageCache,
  loadout: HeroLoadout,
  mode: "8bit" | "16bit" | "side-by-side",
  dir: Direction,
  tick: number
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;

  // Subtle checkerboard backdrop
  const cell = 12;
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      ctx.fillStyle =
        ((x / cell + y / cell) & 1) === 0
          ? "rgba(255,255,255,0.04)"
          : "rgba(0,0,0,0.08)";
      ctx.fillRect(x, y, cell, cell);
    }
  }

  const drawPanel = (
    era: SpriteEraKey,
    panelX: number,
    panelW: number,
    label: string
  ) => {
    const heroSize = mode === "side-by-side" ? 96 : 128;
    const pipSize = mode === "side-by-side" ? 48 : 64;
    const centerX = panelX + Math.floor(panelW / 2);
    const heroX = centerX - Math.floor(heroSize / 2) - Math.floor(pipSize / 4);
    const heroY = Math.floor((h - heroSize) / 2) + 6;
    const pipX = heroX + heroSize - 6;
    const pipY = heroY + heroSize - pipSize - 4;

    drawHeroOnContext(
      ctx,
      bundle,
      cache,
      loadout,
      era,
      dir,
      tick,
      heroX,
      heroY,
      heroSize,
      heroSize
    );
    drawPipOnContext(
      ctx,
      bundle,
      cache,
      loadout,
      era,
      dir,
      tick,
      pipX,
      pipY,
      pipSize,
      pipSize
    );

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(panelX + 8, 8, 92, 18);
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 11px monospace";
    ctx.fillText(label, panelX + 14, 21);
  };

  if (mode === "side-by-side") {
    const half = Math.floor(w / 2);
    drawPanel("8bit", 0, half, "8-Bit (16x16)");
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(half + 0.5, 0);
    ctx.lineTo(half + 0.5, h);
    ctx.stroke();
    drawPanel("16bit", half, w - half, "16-Bit (32x32)");
  } else {
    drawPanel(
      mode,
      0,
      w,
      mode === "8bit" ? "8-Bit (16x16)" : "16-Bit (32x32)"
    );
  }
}

export function executePythonCallConsole(
  script: string,
  loadout: HeroLoadout,
  manifest: SpriteManifest
): { next: HeroLoadout; logs: string[] } {
  const next: HeroLoadout = { ...loadout };
  const logs: string[] = [];
  const lines = script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const validSkins = new Set(Object.keys(manifest.layers.skin));
  const validHairs = new Set(Object.keys(manifest.layers.hair));
  const validTunics = new Set(
    Object.keys(manifest.layers.torso).map((k) => k.replace(/^tunic_/, ""))
  );
  const validHats = new Set(Object.keys(manifest.layers.headgear));
  const validBoots = new Set(Object.keys(manifest.layers.footwear));
  const validCloaks = new Set(Object.keys(manifest.layers.back));
  const validShields = new Set(Object.keys(manifest.layers.offhand));
  const validAuras = new Set(Object.keys(manifest.layers.aura));

  const normalizeKey = (val: string, prefix: string): string | null => {
    const v = val.trim().toLowerCase();
    if (!v || v === "none" || v === "null" || v === "off") return null;
    return v.startsWith(prefix) ? v : `${prefix}${v}`;
  };

  for (const line of lines) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)\s*$/);
    if (!m) {
      logs.push(`SyntaxError: Pip couldn't read "${line}"`);
      continue;
    }
    const fn = m[1];
    const rawArg = m[2].trim();
    const strMatch = rawArg.match(/^["']([^"']*)["']$/);
    const arg = strMatch ? strMatch[1] : rawArg;

    switch (fn) {
      case "set_name": {
        if (!arg) {
          logs.push('set_name(): pass a name like set_name("Rowan")');
        } else {
          next.name = arg;
          logs.push(`Hero renamed to "${arg}"!`);
        }
        break;
      }
      case "preview_skin": {
        if (validSkins.has(arg)) {
          next.skin = arg;
          logs.push(`Skin set to "${arg}".`);
        } else {
          logs.push(`Unknown skin "${arg}". Try: ${[...validSkins].join(", ")}`);
        }
        break;
      }
      case "preview_hair": {
        if (validHairs.has(arg)) {
          next.hair = arg;
          logs.push(`Hair set to "${arg}".`);
        } else {
          logs.push(`Unknown hair "${arg}". Try: ${[...validHairs].join(", ")}`);
        }
        break;
      }
      case "preview_tunic":
      case "set_tunic_color": {
        const clean = arg.replace(/^tunic_/, "");
        if (validTunics.has(clean)) {
          next.tunic = clean;
          logs.push(`Tunic set to "${clean}".`);
        } else {
          logs.push(`Unknown tunic "${arg}". Try: ${[...validTunics].join(", ")}`);
        }
        break;
      }
      case "wear_hat": {
        const k = normalizeKey(arg, "hat_");
        if (k === null) {
          next.hat = null;
          logs.push("Removed headgear.");
        } else if (validHats.has(k)) {
          next.hat = k;
          logs.push(`Equipped ${k}!`);
        } else {
          logs.push(`Unknown hat "${arg}". Try: explorer, dragon_helm, wizard_cap, none`);
        }
        break;
      }
      case "equip_boots": {
        const k = normalizeKey(arg, "boots_") || "boots_default";
        if (validBoots.has(k)) {
          next.boots = k;
          logs.push(`Equipped ${k}!`);
        } else {
          logs.push(`Unknown boots "${arg}". Try: default, swift`);
        }
        break;
      }
      case "equip_cloak": {
        const k = normalizeKey(arg, "cloak_");
        if (k === null) {
          next.cloak = null;
          logs.push("Removed cloak.");
        } else if (validCloaks.has(k)) {
          next.cloak = k;
          logs.push(`Equipped ${k}!`);
        } else {
          logs.push(`Unknown cloak "${arg}". Try: tide, none`);
        }
        break;
      }
      case "equip_shield": {
        const k = normalizeKey(arg, "shield_");
        if (k === null) {
          next.shield = null;
          logs.push("Removed shield.");
        } else if (validShields.has(k)) {
          next.shield = k;
          logs.push(`Equipped ${k}!`);
        } else {
          logs.push(`Unknown shield "${arg}". Try: oak, coral, none`);
        }
        break;
      }
      case "equip_aura":
      case "add_charisma":
      case "add_courage": {
        if (fn === "add_charisma") {
          next.aura = "aura_charisma_1";
          logs.push("Activated aura_charisma_1!");
        } else if (fn === "add_courage") {
          next.aura = "aura_courage_1";
          logs.push("Activated aura_courage_1!");
        } else {
          const k = normalizeKey(arg, "aura_");
          if (k === null) {
            next.aura = null;
            logs.push("Cleared aura.");
          } else if (validAuras.has(k)) {
            next.aura = k;
            logs.push(`Activated ${k}!`);
          } else {
            logs.push(`Unknown aura "${arg}". Try: charisma_1, courage_1, none`);
          }
        }
        break;
      }
      case "equip_pip_scarf": {
        const v = arg.trim().toLowerCase();
        if (v === "none" || v === "false" || v === "off") {
          next.pipScarf = false;
          logs.push("Removed Pip's scarf.");
        } else {
          next.pipScarf = true;
          logs.push("Pip is wearing the Ember Scarf!");
        }
        break;
      }
      default:
        logs.push(
          `Unknown function ${fn}(). Supported: set_name, preview_skin, preview_hair, preview_tunic, wear_hat, equip_cloak, equip_boots, equip_shield, equip_pip_scarf.`
        );
    }
  }

  return { next, logs };
}
