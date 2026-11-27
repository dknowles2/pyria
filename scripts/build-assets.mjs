#!/usr/bin/env node
/**
 * Builds dist/assets/ for Cloudflare Workers Static Assets.
 *
 * Includes:
 *   - web/** (excluding *.test.mjs)
 *   - content/**
 *   - assets/sprites/** (excluding preview.html, *.py, and top-level showcase *.png)
 *   - assets/tilesets/** (excluding preview.html, *.py, and top-level showcase *.png)
 *   - assets/world/maps_bundle.js
 *
 * Excludes:
 *   - assets/concept-art/**
 *   - assets/screenshots/**
 *   - assets/* /preview.html
 *   - assets/* /*.py
 *   - assets/* /*.png (showcase/comparison images directly under assets/<group>/)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'assets');

function copyRecursive(srcDir, dstDir, filterFn = () => true, relPrefix = '') {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (!filterFn(relPath, entry)) continue;
    if (entry.isDirectory()) {
      count += copyRecursive(srcPath, dstPath, filterFn, relPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
      count += 1;
    }
  }
  return count;
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  let total = 0;

  // 1. Copy web/ -> dist/assets/ (excluding test files)
  total += copyRecursive(path.join(ROOT, 'web'), DIST, (relPath, entry) => {
    if (entry.isFile() && /\.test\.(m?js|ts)$/i.test(entry.name)) {
      return false;
    }
    return true;
  });

  // 2. Copy content/ -> dist/assets/content/
  total += copyRecursive(
    path.join(ROOT, 'content'),
    path.join(DIST, 'content')
  );

  // 3. Copy gameplay sprites & tilesets (exclude preview.html, *.py, and direct-child *.png showcase files)
  const gameplayAssetFilter = (relPath, entry) => {
    if (!entry.isFile()) return true;
    const lower = entry.name.toLowerCase();
    if (lower === 'preview.html' || lower.endsWith('.py')) return false;
    // Exclude direct-child showcase/comparison PNGs like assets/sprites/hero_showcase.png
    if (!relPath.includes('/') && lower.endsWith('.png')) return false;
    return true;
  };

  total += copyRecursive(
    path.join(ROOT, 'assets', 'sprites'),
    path.join(DIST, 'assets', 'sprites'),
    gameplayAssetFilter
  );

  total += copyRecursive(
    path.join(ROOT, 'assets', 'tilesets'),
    path.join(DIST, 'assets', 'tilesets'),
    gameplayAssetFilter
  );

  // 4. Copy assets/world/maps_bundle.js only
  const mapsBundleSrc = path.join(ROOT, 'assets', 'world', 'maps_bundle.js');
  if (fs.existsSync(mapsBundleSrc)) {
    const worldDstDir = path.join(DIST, 'assets', 'world');
    fs.mkdirSync(worldDstDir, { recursive: true });
    fs.copyFileSync(mapsBundleSrc, path.join(worldDstDir, 'maps_bundle.js'));
    total += 1;
  }

  console.log(`Built ${total} static asset files into ${path.relative(ROOT, DIST)}/`);
}

main();
