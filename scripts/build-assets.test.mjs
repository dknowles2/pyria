import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAssets } from './build-assets.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function parseHeadersBlocks(text) {
  const blocks = new Map();
  let currentRoute = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (!rawLine.startsWith(' ')) {
      currentRoute = rawLine.trim();
      blocks.set(currentRoute, []);
    } else if (currentRoute) {
      blocks.get(currentRoute).push(rawLine.trim());
    }
  }
  return blocks;
}

test('buildAssets builds into an isolated dir, excludes dev/test/showcase files, and scopes _headers routes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyria-assets-test-'));
  try {
    const total = buildAssets({ rootDir: ROOT, distDir: tmpDir, quiet: true });
    const files = walkFiles(tmpDir);
    const fileSet = new Set(files);
    assert.equal(total, files.length);

    // Essential runtime assets & nested gameplay sprites are included
    assert.ok(fileSet.has('index.html'), 'missing index.html');
    assert.ok(fileSet.has('py-sandbox.html'), 'missing py-sandbox.html');
    assert.ok(fileSet.has('_headers'), 'missing _headers');
    assert.ok(fileSet.has('content/game.json'), 'missing content/game.json');
    assert.ok(fileSet.has('assets/world/maps_bundle.js'), 'missing maps_bundle.js');
    assert.ok(fileSet.has('assets/sprites/8bit/shadow.png'), 'missing nested gameplay sprite');

    // Showcase PNGs directly under assets/sprites/ or assets/tilesets/ are excluded
    for (const group of ['sprites', 'tilesets']) {
      const srcGroupDir = path.join(ROOT, 'assets', group);
      if (fs.existsSync(srcGroupDir)) {
        for (const entry of fs.readdirSync(srcGroupDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
            assert.ok(
              !fileSet.has(`assets/${group}/${entry.name}`),
              `showcase PNG leaked: assets/${group}/${entry.name}`
            );
          }
        }
      }
    }

    // Test files, preview HTML, Python scripts, and non-gameplay folders are excluded
    for (const rel of files) {
      assert.ok(!/\.test\.(m?js|ts)$/i.test(rel), `test file leaked: ${rel}`);
      assert.ok(!rel.toLowerCase().endsWith('/preview.html'), `preview.html leaked: ${rel}`);
      assert.ok(!rel.toLowerCase().endsWith('.py'), `python script leaked: ${rel}`);
      assert.ok(!rel.startsWith('assets/concept-art/'), `concept-art leaked: ${rel}`);
      assert.ok(!rel.startsWith('assets/screenshots/'), `screenshots leaked: ${rel}`);
    }

    // _headers route blocks are accurately scoped
    const headersTxt = fs.readFileSync(path.join(tmpDir, '_headers'), 'utf-8');
    const blocks = parseHeadersBlocks(headersTxt);

    const rootHeaders = blocks.get('/*') || [];
    assert.ok(rootHeaders.includes('X-Content-Type-Options: nosniff'));
    assert.ok(rootHeaders.includes('X-Frame-Options: DENY'));

    const sandboxHeaders = blocks.get('/py-sandbox.html') || [];
    assert.ok(sandboxHeaders.includes('X-Frame-Options: SAMEORIGIN'));
    const sandboxCspLine = sandboxHeaders.find((l) => l.startsWith('Content-Security-Policy:'));
    assert.ok(sandboxCspLine, 'missing Content-Security-Policy under /py-sandbox.html');
    assert.ok(sandboxCspLine.includes('sandbox allow-scripts;'));

    const sandboxHtml = fs.readFileSync(path.join(ROOT, 'web', 'py-sandbox.html'), 'utf-8');
    const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    let match;
    let scriptCount = 0;
    while ((match = scriptRe.exec(sandboxHtml)) !== null) {
      scriptCount += 1;
      const digest = crypto.createHash('sha256').update(match[1] ?? '', 'utf-8').digest('base64');
      assert.ok(
        sandboxCspLine.includes(`'sha256-${digest}'`),
        `/py-sandbox.html CSP missing sha256 hash for inline script #${scriptCount}`
      );
    }
    assert.ok(scriptCount > 0, 'expected at least one inline script in py-sandbox.html');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
