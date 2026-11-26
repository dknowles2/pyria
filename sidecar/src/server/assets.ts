import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  RealmMap,
  SpriteBundle,
  SpriteManifest,
  TilesetManifest,
  WorldBundle,
} from "../shared/types.js";

async function readPngAsDataUri(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export async function loadSpriteBundle(assetsDir: string): Promise<SpriteBundle> {
  const spritesDir = path.join(assetsDir, "sprites");
  const manifestPath = path.join(spritesDir, "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as SpriteManifest;

  const images: Record<string, string> = {};
  for (const eraFolder of ["8bit", "16bit"]) {
    const dirPath = path.join(spritesDir, eraFolder);
    let entries: string[] = [];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue;
    }
    entries.sort();
    for (const file of entries) {
      if (!file.endsWith(".png")) continue;
      const relKey = `${eraFolder}/${file}`;
      images[relKey] = await readPngAsDataUri(path.join(dirPath, file));
    }
  }

  return { manifest, images };
}

export async function loadWorldBundle(
  contentDir: string,
  assetsDir: string
): Promise<WorldBundle> {
  const tilesetsDir = path.join(assetsDir, "tilesets");
  const manifestPath = path.join(tilesetsDir, "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const tilesetManifest = JSON.parse(manifestRaw) as TilesetManifest;

  const tilesetImages: Record<string, string> = {};
  const expectedFiles = [
    "8bit/meadow_ruins.png",
    "16bit/meadow_ruins.png",
    "8bit/npcs_and_dragons.png",
    "16bit/npcs_and_dragons.png",
  ];
  for (const rel of expectedFiles) {
    const full = path.join(tilesetsDir, rel);
    tilesetImages[rel] = await readPngAsDataUri(full);
  }

  const mapsDir = path.join(contentDir, "maps");
  const maps: RealmMap[] = [];
  try {
    const entries = (await readdir(mapsDir)).sort();
    for (const file of entries) {
      if (!file.endsWith(".json") || file === "schema.json") continue;
      const raw = await readFile(path.join(mapsDir, file), "utf8");
      maps.push(JSON.parse(raw) as RealmMap);
    }
  } catch {
    // maps/ directory might not exist
  }

  return { tilesetManifest, tilesetImages, maps };
}
