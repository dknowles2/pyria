#!/usr/bin/env node
/**
 * Validates game content integrity across content/game.json, content/catalog.json,
 * content/eras/*.json, and content/maps/*.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content');

const VALID_TRIAL_TYPES = new Set(['code', 'multiple_choice', 'fix_bug']);
const errors = [];

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonObject(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    errors.push(`Failed to parse JSON ${path.relative(ROOT, filePath)}: ${err.message}`);
    return null;
  }
  if (!isPlainObject(parsed)) {
    errors.push(`${path.relative(ROOT, filePath)}: root value must be a JSON object`);
    return null;
  }
  return parsed;
}

function main() {
  const game = readJsonObject(path.join(CONTENT_DIR, 'game.json'));
  const catalog = readJsonObject(path.join(CONTENT_DIR, 'catalog.json'));
  if (!game || !catalog) {
    reportAndExit();
    return;
  }

  // 1. Validate game.json concepts and eraOrder
  const eraOrder = Array.isArray(game.eraOrder) ? game.eraOrder : null;
  check(eraOrder !== null && eraOrder.length > 0, 'game.json: eraOrder must be a non-empty array');

  const seenEraOrder = new Set();
  for (const eraId of eraOrder || []) {
    check(typeof eraId === 'string' && eraId.length > 0, 'game.json: eraOrder contains non-string entry');
    check(!seenEraOrder.has(eraId), `game.json: duplicate eraOrder entry "${eraId}"`);
    seenEraOrder.add(eraId);
  }

  const validConcepts = new Set();
  const conceptsList = Array.isArray(game.conceptProgression) ? game.conceptProgression : null;
  check(conceptsList !== null && conceptsList.length > 0, 'game.json: conceptProgression must be a non-empty array');
  for (const concept of conceptsList || []) {
    if (!isPlainObject(concept)) {
      errors.push('game.json: conceptProgression entry must be an object');
      continue;
    }
    check(typeof concept.id === 'string' && concept.id.length > 0, 'game.json: conceptProgression item missing id');
    check(!validConcepts.has(concept.id), `game.json: duplicate concept id "${concept.id}"`);
    validConcepts.add(concept.id);
  }

  // 2. Validate catalog.json unlockables
  const unlockIds = new Set();
  const unlockables = Array.isArray(catalog.unlockables) ? catalog.unlockables : null;
  check(unlockables !== null, 'catalog.json: unlockables must be an array');
  for (const item of unlockables || []) {
    if (!isPlainObject(item)) {
      errors.push('catalog.json: unlockable entry must be an object');
      continue;
    }
    check(typeof item.id === 'string' && item.id.length > 0, 'catalog.json: unlockable missing id');
    check(!unlockIds.has(item.id), `catalog.json: duplicate unlockable id "${item.id}"`);
    unlockIds.add(item.id);
    check(
      Number.isInteger(item.shardCost) && item.shardCost >= 0,
      `catalog.json: unlockable "${item.id}" has invalid shardCost`
    );
  }

  // 3. Validate eras, realms, and trials
  const seenRealmIds = new Set();
  const seenDragonIds = new Set();
  const seenTrialIds = new Set();
  const codingTrials = [];
  let totalRealms = 0;
  let totalTrials = 0;

  for (const eraId of eraOrder || []) {
    if (typeof eraId !== 'string' || !eraId) continue;
    const eraPath = path.join(CONTENT_DIR, 'eras', `${eraId}.json`);
    check(fs.existsSync(eraPath), `Missing era file for eraOrder entry: ${path.relative(ROOT, eraPath)}`);
    if (!fs.existsSync(eraPath)) continue;

    const era = readJsonObject(eraPath);
    if (!era) continue;

    check(era.id === eraId, `${eraId}.json: era.id ("${era.id}") does not match filename`);
    const realms = Array.isArray(era.realms) ? era.realms : null;
    check(realms !== null && realms.length > 0, `${eraId}.json: realms must be a non-empty array`);

    for (const realm of realms || []) {
      if (!isPlainObject(realm)) {
        errors.push(`${eraId}.json: realm entry must be an object`);
        continue;
      }
      totalRealms += 1;
      check(typeof realm.id === 'string' && realm.id.length > 0, `${eraId}.json: realm missing id`);
      check(!seenRealmIds.has(realm.id), `Duplicate realm id "${realm.id}"`);
      seenRealmIds.add(realm.id);

      if (isPlainObject(realm.dragon) && realm.dragon.id) {
        check(!seenDragonIds.has(realm.dragon.id), `Duplicate dragon id "${realm.dragon.id}" in realm "${realm.id}"`);
        seenDragonIds.add(realm.dragon.id);
      }

      const mapPath = path.join(CONTENT_DIR, 'maps', `${realm.id}.json`);
      check(fs.existsSync(mapPath), `Missing map file for realm "${realm.id}": ${path.relative(ROOT, mapPath)}`);

      const trials = Array.isArray(realm.trials) ? realm.trials : null;
      check(trials !== null && trials.length > 0, `Realm "${realm.id}" must have at least one trial`);
      for (const trial of trials || []) {
        if (!isPlainObject(trial)) {
          errors.push(`Realm "${realm.id}": trial entry must be an object`);
          continue;
        }
        totalTrials += 1;
        check(typeof trial.id === 'string' && trial.id.length > 0, `Realm "${realm.id}": trial missing id`);
        check(!seenTrialIds.has(trial.id), `Duplicate trial id "${trial.id}"`);
        seenTrialIds.add(trial.id);

        check(typeof trial.title === 'string' && trial.title.length > 0, `Trial "${trial.id}" missing title`);
        check(typeof trial.objective === 'string' && trial.objective.length > 0, `Trial "${trial.id}" missing objective`);
        check(
          Number.isInteger(trial.shardReward) && trial.shardReward >= 0,
          `Trial "${trial.id}" has invalid shardReward`
        );
        check(
          isPlainObject(trial.hints) && typeof trial.hints.tier1_nudge === 'string',
          `Trial "${trial.id}" missing hints.tier1_nudge`
        );

        if (trial.unlockId != null) {
          check(unlockIds.has(trial.unlockId), `Trial "${trial.id}" references unknown unlockId "${trial.unlockId}"`);
        }

        const trialConcepts = Array.isArray(trial.concepts) ? trial.concepts : null;
        check(trialConcepts !== null && trialConcepts.length > 0, `Trial "${trial.id}" must specify at least one concept`);
        for (const conceptId of trialConcepts || []) {
          check(validConcepts.has(conceptId), `Trial "${trial.id}" references unknown concept "${conceptId}"`);
        }

        const trialType = trial.trialType;
        check(
          typeof trialType === 'string' && VALID_TRIAL_TYPES.has(trialType),
          `Trial "${trial.id}" missing or invalid trialType "${trialType}"`
        );
        if (trialType === 'multiple_choice') {
          const choices = Array.isArray(trial.choices) ? trial.choices : null;
          check(choices !== null && choices.length >= 2, `Multiple-choice trial "${trial.id}" needs >= 2 choices`);
          const choiceIds = new Set();
          for (const choice of choices || []) {
            if (!isPlainObject(choice) || typeof choice.id !== 'string' || choice.id.length === 0) {
              errors.push(`Multiple-choice trial "${trial.id}" has a choice without a valid string id`);
              continue;
            }
            check(!choiceIds.has(choice.id), `Multiple-choice trial "${trial.id}" has duplicate choice id "${choice.id}"`);
            choiceIds.add(choice.id);
          }
          check(
            typeof trial.correctChoiceId === 'string' && choiceIds.has(trial.correctChoiceId),
            `Multiple-choice trial "${trial.id}" correctChoiceId "${trial.correctChoiceId}" not in choices`
          );
        } else if (VALID_TRIAL_TYPES.has(trialType)) {
          check(isPlainObject(trial.starterCode), `Trial "${trial.id}" missing starterCode object`);
          if (isPlainObject(trial.starterCode)) {
            for (const tier of ['explorer', 'standard', 'challenge']) {
              check(
                typeof trial.starterCode[tier] === 'string',
                `Trial "${trial.id}" starterCode.${tier} must be a string`
              );
            }
          }
          check(
            typeof trial.referenceSolution === 'string' && trial.referenceSolution.trim().length > 0,
            `Trial "${trial.id}" missing referenceSolution`
          );
          check(
            typeof trial.testCode === 'string' && trial.testCode.trim().length > 0,
            `Trial "${trial.id}" missing testCode`
          );
          if (
            typeof trial.referenceSolution === 'string' &&
            trial.referenceSolution.trim().length > 0 &&
            typeof trial.testCode === 'string' &&
            trial.testCode.trim().length > 0
          ) {
            codingTrials.push({
              eraId,
              id: trial.id,
              concepts: trialConcepts || [],
              referenceSolution: trial.referenceSolution,
              testCode: trial.testCode,
            });
          }
        }
      }
    }
  }

  // Check for orphan era files not listed in game.eraOrder
  const erasDir = path.join(CONTENT_DIR, 'eras');
  for (const file of fs.readdirSync(erasDir).filter((f) => f.endsWith('.json')).sort()) {
    const eraId = file.replace(/\.json$/, '');
    check(seenEraOrder.has(eraId), `Orphan era file not in game.json eraOrder: content/eras/${file}`);
  }

  // 4. Verify catalog unlockables reference valid realms and eras
  for (const item of unlockables || []) {
    if (!isPlainObject(item)) continue;
    if (item.eraId) {
      check(seenEraOrder.has(item.eraId), `catalog.json: unlockable "${item.id}" references unknown eraId "${item.eraId}"`);
    }
    if (item.unlockRealmId) {
      check(
        seenRealmIds.has(item.unlockRealmId),
        `catalog.json: unlockable "${item.id}" references unknown unlockRealmId "${item.unlockRealmId}"`
      );
    }
  }

  // 5. Validate all map files in content/maps/
  const mapsDir = path.join(CONTENT_DIR, 'maps');
  const mapFiles = fs
    .readdirSync(mapsDir)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .sort();

  for (const file of mapFiles) {
    const expectedRealmId = file.replace(/\.json$/, '');
    check(seenRealmIds.has(expectedRealmId), `Orphan map file with no matching realm: content/maps/${file}`);

    const map = readJsonObject(path.join(mapsDir, file));
    if (!map) continue;
    check(map.realmId === expectedRealmId, `Map ${file}: realmId ("${map.realmId}") does not match filename`);
    check(Number.isInteger(map.width) && map.width > 0, `Map ${file}: invalid width`);
    check(Number.isInteger(map.height) && map.height > 0, `Map ${file}: invalid height`);
    check(
      isPlainObject(map.spawn) && Number.isInteger(map.spawn.x) && Number.isInteger(map.spawn.y),
      `Map ${file}: missing integer spawn`
    );
    const spawnInBounds =
      isPlainObject(map.spawn) &&
      Number.isInteger(map.width) &&
      Number.isInteger(map.height) &&
      map.spawn.x >= 0 &&
      map.spawn.x < map.width &&
      map.spawn.y >= 0 &&
      map.spawn.y < map.height;
    if (isPlainObject(map.spawn) && Number.isInteger(map.width) && Number.isInteger(map.height)) {
      check(
        spawnInBounds,
        `Map ${file}: spawn (${map.spawn.x}, ${map.spawn.y}) out of bounds ${map.width}x${map.height}`
      );
    }

    const layers = isPlainObject(map.layers) ? map.layers : null;
    check(layers !== null, `Map ${file}: missing layers object`);
    for (const layerName of ['ground', 'decor', 'collision']) {
      const layer = layers?.[layerName];
      check(Array.isArray(layer), `Map ${file}: missing layers.${layerName}`);
      if (Array.isArray(layer)) {
        check(
          layer.length === map.height,
          `Map ${file}: layers.${layerName} has ${layer.length} rows, expected ${map.height}`
        );
        for (let r = 0; r < layer.length; r += 1) {
          if (!Array.isArray(layer[r]) || layer[r].length !== map.width) {
            errors.push(
              `Map ${file}: layers.${layerName}[${r}] has length ${layer[r]?.length}, expected ${map.width}`
            );
            break;
          }
          if (layerName === 'collision') {
            const invalidCell = layer[r].find((v) => v !== 0 && v !== 1);
            if (invalidCell !== undefined) {
              errors.push(`Map ${file}: layers.collision[${r}] contains non-binary value ${JSON.stringify(invalidCell)}`);
              break;
            }
          }
        }
      }
    }

    if (spawnInBounds && Array.isArray(layers?.collision) && Array.isArray(layers.collision[map.spawn.y])) {
      check(
        layers.collision[map.spawn.y][map.spawn.x] === 0,
        `Map ${file}: spawn (${map.spawn.x}, ${map.spawn.y}) is blocked by collision tile`
      );
    }
  }

  // 6. Execute coding trial referenceSolutions against testCode and cross-check AST concepts in python3
  let passedCoding = 0;
  if (codingTrials.length > 0) {
    const pyScript = `
import ast, contextlib, io, json, sys
trials = json.loads(sys.stdin.read())
errs = []
passed = 0
for t in trials:
    tid = f"{t['eraId']}/{t['id']}"
    code = t["referenceSolution"]
    concepts = set(t.get("concepts", []))
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        errs.append(f"Trial {tid} referenceSolution SyntaxError: {e}")
        continue
    feats = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.FunctionDef): feats.add("def")
        elif isinstance(n, ast.ClassDef): feats.add("class")
        elif isinstance(n, ast.For): feats.add("for")
        elif isinstance(n, ast.While): feats.add("while")
        elif isinstance(n, ast.Try): feats.add("try")
    if "def" in feats and not (concepts & {"functions_def", "functions_return", "classes_intro", "class_inheritance", "world_scripting_3d", "debugging"}):
        errs.append(f"Trial {tid}: uses 'def' in referenceSolution but concepts={sorted(concepts)}")
    if "class" in feats and not (concepts & {"classes_intro", "class_inheritance", "world_scripting_3d"}):
        errs.append(f"Trial {tid}: uses 'class' in referenceSolution but concepts={sorted(concepts)}")
    if "for" in feats and not (concepts & {"for_loops", "list_iteration", "nested_loops", "list_comprehensions", "dictionaries", "dictionaries_nested", "world_scripting_3d", "debugging", "sorting_lambdas"}):
        errs.append(f"Trial {tid}: uses 'for' in referenceSolution but concepts={sorted(concepts)}")
    if "while" in feats and not (concepts & {"while_loops", "debugging"}):
        errs.append(f"Trial {tid}: uses 'while' in referenceSolution but concepts={sorted(concepts)}")
    if "try" in feats and "error_handling" not in concepts:
        errs.append(f"Trial {tid}: uses 'try' in referenceSolution but concepts={sorted(concepts)}")
    try:
        def shout_fn(*args, **kwargs):
            print(*(a.upper() if isinstance(a, str) else a for a in args), **kwargs)
        ns = {"say": print, "shout": shout_fn}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<student>", "exec"), ns)
        ns["OUTPUT"] = buf.getvalue()
        exec(compile(t["testCode"], "<test>", "exec"), ns)
        passed += 1
    except Exception as e:
        errs.append(f"Trial {tid} referenceSolution failed: {type(e).__name__}: {e}")
print(json.dumps({"passed": passed, "errors": errs}))
`;
    const pyRes = spawnSync('python3', ['-c', pyScript], {
      input: JSON.stringify(codingTrials),
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (pyRes.status !== 0) {
      errors.push(`Python referenceSolution runner failed: ${pyRes.stderr || pyRes.stdout || pyRes.error?.message}`);
    } else {
      const pyOut = JSON.parse(pyRes.stdout);
      passedCoding = pyOut.passed;
      for (const e of pyOut.errors) errors.push(e);
    }
  }

  if (errors.length === 0) {
    console.log(
      `Content validation passed: ${(eraOrder || []).length} eras, ${totalRealms} realms, ${totalTrials} trials (${passedCoding}/${codingTrials.length} referenceSolutions passed), ${mapFiles.length} maps, ${unlockIds.size} unlockables.`
    );
  }
  reportAndExit();
}

function reportAndExit() {
  if (errors.length > 0) {
    console.error(`Content validation failed with ${errors.length} error(s):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}

main();
