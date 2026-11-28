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

import crypto from 'node:crypto';
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

export function buildAssets({ rootDir = ROOT, distDir = DIST, quiet = false } = {}) {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  let total = 0;

  // 1. Copy web/ -> dist/assets/ (excluding test files)
  total += copyRecursive(path.join(rootDir, 'web'), distDir, (relPath, entry) => {
    if (entry.isFile() && /\.test\.(m?js|ts)$/i.test(entry.name)) {
      return false;
    }
    return true;
  });

  // 2. Copy content/ -> dist/assets/content/
  total += copyRecursive(
    path.join(rootDir, 'content'),
    path.join(distDir, 'content')
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
    path.join(rootDir, 'assets', 'sprites'),
    path.join(distDir, 'assets', 'sprites'),
    gameplayAssetFilter
  );

  total += copyRecursive(
    path.join(rootDir, 'assets', 'tilesets'),
    path.join(distDir, 'assets', 'tilesets'),
    gameplayAssetFilter
  );

  // 4. Copy assets/world/maps_bundle.js only
  const mapsBundleSrc = path.join(rootDir, 'assets', 'world', 'maps_bundle.js');
  if (fs.existsSync(mapsBundleSrc)) {
    const worldDstDir = path.join(distDir, 'assets', 'world');
    fs.mkdirSync(worldDstDir, { recursive: true });
    fs.copyFileSync(mapsBundleSrc, path.join(worldDstDir, 'maps_bundle.js'));
    total += 1;
  }

  // 5. Write Cloudflare Workers Static Assets _headers file so every static route
  //    (/, /js/*, /css/*, /content/*, /assets/*) carries strict security & cache headers
  //    without consuming Worker invocations on static files.
  const cspDefault =
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "worker-src 'none'; " +
    "frame-src 'self'; " +
    "connect-src 'self'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'self'";

  const pyodideCdn = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
  let sandboxCsp = null;
  const sandboxPath = path.join(distDir, 'py-sandbox.html');
  if (fs.existsSync(sandboxPath)) {
    const html = fs.readFileSync(sandboxPath, 'utf-8');
    const hashes = [];
    const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const digest = crypto.createHash('sha256').update(m[1] ?? '', 'utf-8').digest('base64');
      hashes.push(`'sha256-${digest}'`);
    }
    if (hashes.length > 0) {
      sandboxCsp =
        'sandbox allow-scripts; ' +
        "default-src 'none'; " +
        `script-src ${hashes.join(' ')} blob: ${pyodideCdn} 'wasm-unsafe-eval'; ` +
        'worker-src blob:; ' +
        `connect-src ${pyodideCdn}; ` +
        "object-src 'none'; " +
        "base-uri 'none'; " +
        "form-action 'none'; " +
        "frame-ancestors 'self'";
    }
  }

  const headersLines = [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: same-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    `  Content-Security-Policy: ${cspDefault}`,
    '  Cache-Control: public, max-age=60',
    '',
    '/js/*',
    '  ! Cache-Control',
    '  Cache-Control: public, max-age=300',
    '',
    '/css/*',
    '  ! Cache-Control',
    '  Cache-Control: public, max-age=300',
    '',
    '/content/*',
    '  ! Cache-Control',
    '  Cache-Control: public, max-age=300',
    '',
    '/assets/*',
    '  ! Cache-Control',
    '  Cache-Control: public, max-age=86400',
    '',
  ];
  if (sandboxCsp) {
    headersLines.push(
      '/py-sandbox.html',
      '  ! X-Frame-Options',
      '  X-Frame-Options: SAMEORIGIN',
      '  ! Content-Security-Policy',
      `  Content-Security-Policy: ${sandboxCsp}`,
      '  ! Cache-Control',
      '  Cache-Control: public, max-age=300',
      ''
    );
  }

  fs.writeFileSync(path.join(distDir, '_headers'), headersLines.join('\n'), 'utf-8');
  total += 1;

  if (!quiet) {
    console.log(`Built ${total} static asset files into ${path.relative(rootDir, distDir)}/`);
  }
  return total;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  buildAssets();
}
