#!/usr/bin/env node
/**
 * Parse-check every browser-side JS module.
 *
 * `npm run test:web` only loads the 7 modules some test imports, so a syntax
 * error in any of the other 11 (main.js, modals.js, cutscene.js, world.js,
 * sprites.js, audio.js, renderer3d.js and the four n64*.js files) used to ship
 * green: the tests passed while the file would not even parse in a browser.
 * `typecheck` is TypeScript, so it only covers worker/.
 *
 * This spawns `node --check` per file, which is what caught that case.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['web/js', 'scripts'];

const files = [];
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  for (const name of (await readdir(abs)).sort()) {
    if (/\.(js|mjs)$/.test(name)) files.push(path.join(dir, name));
  }
}

const failures = [];
await Promise.all(
  files.map(async (rel) => {
    try {
      await execFileAsync(process.execPath, ['--check', path.join(ROOT, rel)]);
    } catch (err) {
      const detail = String(err.stderr || err.message).trim().split('\n').slice(0, 4).join('\n    ');
      failures.push(`${rel}\n    ${detail}`);
    }
  })
);

if (failures.length > 0) {
  console.error(`Parse check failed for ${failures.length} file(s):\n`);
  for (const f of failures.sort()) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log(`Parse check passed: ${files.length} JS modules compile.`);
