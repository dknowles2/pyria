#!/usr/bin/env node
/**
 * Enforce rule 0 of .agents/rules/lesson-authoring.md on player-facing text.
 *
 * Rule 0 (added in #153) is prose, so nothing checked it. #153 rewrote the
 * content JSON but left web/js untouched, and 42 violations sat in the
 * cutscenes, the fix-the-bug prompt and Pip's error translations for two more
 * PRs. This is that rule, executable.
 *
 * Scanned:
 *   content/eras/*.json, content/game.json  player-facing fields
 *   content/maps/*.json                     region names, entity labels,
 *                                           easter-egg titles and messages
 *   web/js/*.js                             prose string literals
 *   web/index.html                          visible text + a11y attributes
 *
 * Not scanned, deliberately:
 *   site/                the parent-facing website, which AGENTS.md governs
 *                        separately and where terms like "Gouraud-shaded" are
 *                        correct.
 *   assets/world/maps_bundle.js  a dev-preview copy of content/maps read only
 *                        by assets/world/preview.html, and already stale.
 *   docs/, assets/, scripts/, worker/   not read by children.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const JARGON = [
  'syntax', 'snippet', 'parameter', 'argument', 'attribute', 'method', 'override',
  'subclass', 'superclass', 'iterate', 'concatenate', 'invoke', 'negate',
  'immutable', 'mutable', 'deduplicate', 'invariant', 'runtime exception',
  'zero-based index', 'expression', 'comprehension', 'data structure',
];
const PURPLE = [
  'sabotaged', 'diorama', 'isometric', 'Gouraud', 'cascading', 'coral fronds',
  'sea-lanes', 'shimmering', 'gleaming', 'woven from', 'Cistern Gate',
  'silent rune cage',
];
// Rule 0 bans hype *openers* and sound effects, not every capital letter: the
// shout() lessons legitimately print GALE!, FIRE! and NACRE FREE!, and those are
// also the right answers to multiple-choice trials. So match the words rule 0
// names, plus shouted caps carrying a doubled !! or ?!, which ordinary program
// output never has.
const HYPE_WORDS = /\b(WOOHOO|IMPOSSIBLE|BOOM|RUMBLE|GAAAH|WHOA|BZZZT)\b|Splash-sparkle|Squawk-roar|Clink-whirrr/;
const HYPE_SHOUT = /[A-Z]{3,}(!!|\?!|!\?)/;
const isHype = (s) => HYPE_WORDS.test(s) || HYPE_SHOUT.test(s);
const EM_DASH = '—';

// Stems so "parameters", "iterating" and "methods" are caught too.
const JARGON_RE = new Map(
  JARGON.map((w) => [w, new RegExp(`\\b${w.replace(/e$/, '')}(e|es|s|ing|d|ed)?\\b`, 'i')])
);

/** Known non-copy matches. A stale entry is an error so this list cannot rot. */
const ALLOW = [
  { file: 'web/js/modals.js', text: 'mc-code-snippet', why: 'CSS class name (web/css/style.css), not copy' },
  { file: 'web/js/pyRunner.js', text: 'object has no attribute', why: "matches CPython's own AttributeError text" },
];
const allowUsed = new Set();

function allowed(file, text) {
  for (const [i, a] of ALLOW.entries()) {
    if (a.file === file && text.includes(a.text)) {
      allowUsed.add(i);
      return true;
    }
  }
  return false;
}

/** A jargon word inside `backticks` is naming code, not talking to the child. */
function jargonOutsideCode(text, re) {
  const global = new RegExp(re.source, 'gi');
  for (const m of text.matchAll(global)) {
    const before = text.slice(0, m.index);
    if ((before.split('`').length - 1) % 2 === 0) return true;
  }
  return false;
}

const findings = [];
function check(file, where, text) {
  if (allowed(file, text)) return;
  const why = [];
  if (text.includes(EM_DASH)) why.push('em-dash');
  for (const w of PURPLE) if (text.toLowerCase().includes(w.toLowerCase())) why.push(`fancy word "${w}"`);
  for (const [w, re] of JARGON_RE) if (jargonOutsideCode(text, re)) why.push(`jargon "${w}"`);
  if (isHype(text)) why.push('all-caps hype or sound effect');
  if (why.length > 0) {
    findings.push({ file, where, why, text: text.length > 120 ? `${text.slice(0, 117)}...` : text });
  }
}

// ---- content JSON: the player-facing fields rule 0 lists --------------------
const FIELDS = new Set([
  'storyPrompt', 'objective', 'bugSummary', 'prompt', 'label', 'explanation',
  'tier1_nudge', 'tier2_pattern', 'tier3_walkthrough', 'workedExample',
  'storyIntro', 'storyOutro', 'rescueDialogue', 'description', 'text', 'title',
  'name', 'message',
]);

function walkJson(node, keyPath, visit) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkJson(v, `${keyPath}[${i}]`, visit));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkJson(v, keyPath ? `${keyPath}.${k}` : k, visit);
  } else if (typeof node === 'string') {
    visit(keyPath, node);
  }
}

const contentFiles = [
  'content/game.json',
  ...fs.readdirSync(path.join(ROOT, 'content/eras')).filter((f) => f.endsWith('.json')).sort()
    .map((f) => `content/eras/${f}`),
  // Map labels are player-visible: they name the markers on the overworld.
  // schema.json is the JSON Schema, not content.
  ...fs.readdirSync(path.join(ROOT, 'content/maps')).filter((f) => f.endsWith('.json') && f !== 'schema.json').sort()
    .map((f) => `content/maps/${f}`),
];
for (const rel of contentFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  walkJson(data, '', (keyPath, text) => {
    const leaf = keyPath.split('.').pop().replace(/\[\d+\]$/, '');
    if (FIELDS.has(leaf)) check(rel, keyPath, text);
  });
}

// ---- web/js: prose string literals ----------------------------------------
const STRINGS = /'([^'\\\n]{12,})'|"([^"\\\n]{12,})"|`([^`\\\n]{12,})`/g;
const isProse = (s) => / [a-z]/.test(s) && /[a-z] [a-z]/.test(s);

for (const name of fs.readdirSync(path.join(ROOT, 'web/js')).filter((f) => f.endsWith('.js')).sort()) {
  const rel = `web/js/${name}`;
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(STRINGS)) {
      const text = m[1] ?? m[2] ?? m[3];
      if (isProse(text)) check(rel, `line ${i + 1}`, text);
    }
  });
}

// ---- web/index.html: visible text and the attributes a child hears ---------
{
  const rel = 'web/index.html';
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  for (const m of src.matchAll(/>([^<>{}]{12,})</g)) {
    const text = m[1].trim();
    if (isProse(text)) check(rel, `line ${lineOf(m.index)}`, text);
  }
  for (const m of src.matchAll(/(?:title|aria-label|placeholder)="([^"]{12,})"/g)) {
    if (isProse(m[1])) check(rel, `line ${lineOf(m.index)}`, m[1]);
  }
}

// ---- report ---------------------------------------------------------------
const stale = ALLOW.filter((_, i) => !allowUsed.has(i));
if (findings.length > 0) {
  console.error(`Player-facing text check failed with ${findings.length} violation(s) of rule 0 in .agents/rules/lesson-authoring.md:\n`);
  for (const f of findings) {
    console.error(`  ${f.file} (${f.where}): ${f.why.join(', ')}`);
    console.error(`      ${f.text}`);
  }
  console.error('\nRule 0: short everyday words for a 10-year-old. No em-dashes, no fancy words,');
  console.error('no all-caps hype or sound effects, and no unexplained coding jargon.');
}
if (stale.length > 0) {
  console.error(`\n${stale.length} stale ALLOW entr(y/ies) in scripts/lint-player-text.mjs match nothing any more; delete them:`);
  for (const a of stale) console.error(`  - ${a.file}: ${JSON.stringify(a.text)} (${a.why})`);
}
if (findings.length > 0 || stale.length > 0) process.exit(1);
console.log(`Player-facing text check passed: ${contentFiles.length} content files + web/js + web/index.html clean against rule 0.`);
