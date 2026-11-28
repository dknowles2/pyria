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
const VALID_SIMPLE_CONSTRUCTS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'while_true', 'break', 'continue',
  'def', 'return', 'class', 'try', 'except', 'with', 'list_comp', 'gen_exp', 'lambda',
  'str_concat', 'aug_assign', 'assign', 'compare', 'bool_op', 'in_op',
  'math_op', 'fstring', 'self_attr',
  'list', 'dict', 'tuple', 'set', 'slice', 'subscript', 'none', 'bool',
  'str_call', 'int_call', 'float_call',
]);
const CHECK_CHEATS = process.argv.includes('--check-cheats');
const errors = [];

function isValidConstructToken(token) {
  if (typeof token !== 'string' || !token.trim()) return false;
  return token.split('|').every((part) => {
    const p = part.trim();
    if (VALID_SIMPLE_CONSTRUCTS.has(p)) return true;
    if (p.startsWith('call:') && p.length > 5) return true;
    if (p.startsWith('method_call:') && p.length > 12) return true;
    return false;
  });
}

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
  const allTrials = [];
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
        }

        if (trial.requiredConstructs !== undefined) {
          check(
            Array.isArray(trial.requiredConstructs),
            `Trial "${trial.id}" requiredConstructs must be an array`
          );
          if (Array.isArray(trial.requiredConstructs)) {
            for (const tok of trial.requiredConstructs) {
              check(
                isValidConstructToken(tok),
                `Trial "${trial.id}" has invalid requiredConstructs token "${tok}"`
              );
            }
          }
        }

        if (trial.variants !== undefined) {
          check(Array.isArray(trial.variants), `Trial "${trial.id}" variants must be an array`);
          if (Array.isArray(trial.variants)) {
            trial.variants.forEach((v, idx) => {
              check(
                isPlainObject(v) && isPlainObject(v.overrides),
                `Trial "${trial.id}" variants[${idx}] must have an overrides object`
              );
            });
          }
        }

        allTrials.push({
          eraId,
          id: trial.id,
          trialType,
          isBoss: trial.id.endsWith('-06'),
          isBonus: Boolean(trial.isBonus || trial.id.endsWith('-bonus')),
          concepts: trialConcepts || [],
          codeSnippet: typeof trial.codeSnippet === 'string' ? trial.codeSnippet : '',
          referenceSolution: typeof trial.referenceSolution === 'string' ? trial.referenceSolution : '',
          testCode: typeof trial.testCode === 'string' ? trial.testCode : '',
          requiredConstructs: Array.isArray(trial.requiredConstructs) ? trial.requiredConstructs : [],
          variants: Array.isArray(trial.variants) ? trial.variants : [],
        });
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

  // 6. Execute coding trial referenceSolutions against testCode + requiredConstructs + variants, cross-check AST concepts, and check boss/bonus debuts in python3
  let passedCoding = 0;
  let totalCoding = 0;
  let cheatPassed = [];
  if (allTrials.length > 0) {
    const pyScript = `
import ast, contextlib, copy, io, json, math, sys
payload = json.loads(sys.stdin.read())
trials = payload["trials"]
check_cheats = payload.get("checkCheats", False)
errs = []
passed = 0
coding = 0
cheat_passed = []
seen_features = set()

def extract_features(code):
    feats = set()
    if not code.strip():
        return feats
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return feats
    for n in ast.walk(tree):
        if isinstance(n, ast.If):
            feats.add("if")
            if n.orelse:
                if len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If):
                    feats.add("elif")
                else:
                    feats.add("else")
        elif isinstance(n, ast.For): feats.add("for")
        elif isinstance(n, ast.While): feats.add("while")
        elif isinstance(n, ast.FunctionDef): feats.add("def")
        elif isinstance(n, ast.ClassDef): feats.add("class")
        elif isinstance(n, ast.Try): feats.add("try")
        elif isinstance(n, ast.Pass): feats.add("pass")
        elif isinstance(n, ast.Constant) and isinstance(n.value, bool): feats.add("bool_literal")
        elif isinstance(n, ast.Call):
            if isinstance(n.func, ast.Name) and n.func.id in ("len", "range", "str", "int", "float", "print", "say", "shout", "enumerate", "input"):
                feats.add(f"builtin:{n.func.id}")
            elif isinstance(n.func, ast.Attribute) and n.func.attr in ("upper", "lower", "strip", "values", "items", "keys", "split", "replace", "append", "get"):
                feats.add(f"method:.{n.func.attr}()")
    return feats

def shout_fn(*args, **kwargs):
    print(*(a.upper() if isinstance(a, str) else a for a in args), **kwargs)

def has_single_construct(tree, token):
    if token.startswith("call:"):
        target = token[5:]
        return any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == target for n in ast.walk(tree))
    if token.startswith("method_call:"):
        target = token[12:]
        return any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == target for n in ast.walk(tree))
    if token == "str_call": return has_single_construct(tree, "call:str")
    if token == "int_call": return has_single_construct(tree, "call:int")
    if token == "float_call": return has_single_construct(tree, "call:float")
    for n in ast.walk(tree):
        if token == "if" and isinstance(n, ast.If): return True
        elif token == "elif" and isinstance(n, ast.If) and len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If): return True
        elif token == "else" and isinstance(n, ast.If) and n.orelse and not (len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If)): return True
        elif token == "for" and isinstance(n, ast.For): return True
        elif token == "while" and isinstance(n, ast.While): return True
        elif token == "while_true" and isinstance(n, ast.While) and isinstance(n.test, ast.Constant) and n.test.value is True: return True
        elif token == "break" and isinstance(n, ast.Break): return True
        elif token == "continue" and isinstance(n, ast.Continue): return True
        elif token == "def" and isinstance(n, ast.FunctionDef): return True
        elif token == "return" and isinstance(n, ast.Return): return True
        elif token == "class" and isinstance(n, ast.ClassDef): return True
        elif token == "try" and isinstance(n, ast.Try): return True
        elif token == "except" and isinstance(n, ast.ExceptHandler): return True
        elif token == "with" and isinstance(n, ast.With): return True
        elif token == "list_comp" and isinstance(n, ast.ListComp): return True
        elif token == "gen_exp" and isinstance(n, ast.GeneratorExp): return True
        elif token == "lambda" and isinstance(n, ast.Lambda): return True
        elif token == "str_concat" and ((isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add)) or (isinstance(n, ast.AugAssign) and isinstance(n.op, ast.Add))): return True
        elif token == "aug_assign" and isinstance(n, ast.AugAssign): return True
        elif token == "assign" and isinstance(n, (ast.Assign, ast.AnnAssign, ast.AugAssign)): return True
        elif token == "compare" and isinstance(n, ast.Compare): return True
        elif token == "bool_op" and (isinstance(n, ast.BoolOp) or (isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not))): return True
        elif token == "in_op" and isinstance(n, ast.Compare) and any(isinstance(op, (ast.In, ast.NotIn)) for op in n.ops): return True
        elif token == "math_op" and ((isinstance(n, ast.BinOp) and isinstance(n.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow))) or (isinstance(n, ast.AugAssign) and isinstance(n.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)))): return True
        elif token == "fstring" and isinstance(n, ast.JoinedStr): return True
        elif token == "self_attr" and isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "self": return True
        elif token == "list" and (isinstance(n, (ast.List, ast.ListComp)) or (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "list")): return True
        elif token == "dict" and (isinstance(n, (ast.Dict, ast.DictComp)) or (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "dict")): return True
        elif token == "tuple" and (isinstance(n, ast.Tuple) or (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "tuple")): return True
        elif token == "set" and (isinstance(n, (ast.Set, ast.SetComp)) or (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "set")): return True
        elif token == "slice" and isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Slice): return True
        elif token == "subscript" and isinstance(n, ast.Subscript): return True
        elif token == "none" and isinstance(n, ast.Constant) and n.value is None: return True
        elif token == "bool" and isinstance(n, ast.Constant) and isinstance(n.value, bool): return True
    return False

def check_constructs(code, required):
    if not required:
        return []
    tree = ast.parse(code)
    missing = []
    for req in required:
        parts = [p.strip() for p in req.split("|") if p.strip()]
        if parts and not any(has_single_construct(tree, p) for p in parts):
            missing.append(req)
    return missing

def rewrite_overrides(code, overrides):
    tree = ast.parse(code)
    replaced = set()
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            var_name = stmt.targets[0].id
            if var_name in overrides and var_name not in replaced:
                stmt.value = ast.parse(repr(overrides[var_name]), mode="eval").body
                replaced.add(var_name)
    ast.fix_missing_locations(tree)
    return compile(tree, "<variant>", "exec")

def values_match(actual, expected):
    if isinstance(actual, float) and isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return math.isclose(actual, float(expected), rel_tol=1e-6, abs_tol=1e-6)
    if isinstance(expected, float) and isinstance(actual, (int, float)) and not isinstance(actual, bool):
        return math.isclose(float(actual), expected, rel_tol=1e-6, abs_tol=1e-6)
    return actual == expected

def run_trial_code(code, test_code, required, variants):
    missing = check_constructs(code, required)
    if missing:
        return False, f"Missing required constructs: {missing}", {}
    ns = {"say": print, "shout": shout_fn}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, "<student>", "exec"), ns)
    ns["OUTPUT"] = buf.getvalue()
    exec(compile(test_code, "<test>", "exec"), ns)
    for idx, v in enumerate(variants or []):
        overrides = v.get("overrides", {})
        v_ns = {"say": print, "shout": shout_fn}
        v_ns.update(copy.deepcopy(overrides))
        v_buf = io.StringIO()
        compiled = rewrite_overrides(code, overrides)
        with contextlib.redirect_stdout(v_buf):
            exec(compiled, v_ns)
        v_out = v_buf.getvalue().strip()
        v_ns["OUTPUT"] = v_buf.getvalue()
        if "expectOutput" in v and v["expectOutput"] is not None:
            if v_out != str(v["expectOutput"]).strip():
                return False, f"Variant[{idx}] output mismatch: expected {v['expectOutput']!r}, got {v_out!r}", ns
        if "expectVars" in v and v["expectVars"]:
            for k, expected_val in v["expectVars"].items():
                if k not in v_ns or not values_match(v_ns[k], expected_val):
                    return False, f"Variant[{idx}] var {k!r} mismatch: expected {expected_val!r}, got {v_ns.get(k)!r}", ns
        if v.get("testCode"):
            exec(compile(v["testCode"], f"<variant_{idx}>", "exec"), v_ns)
    return True, None, ns

for t in trials:
    tid = f"{t['eraId']}/{t['id']}"
    code = t["referenceSolution"]
    code_for_feats = code or t["codeSnippet"]
    feats = extract_features(code_for_feats)
    if t["isBoss"] or t["isBonus"]:
        new_feats = sorted(feats - seen_features)
        if new_feats:
            kind = "bonus" if t["isBonus"] else "boss"
            errs.append(f"Trial {tid}: debuts features in {kind} trial: {', '.join(new_feats)}")
    else:
        seen_features |= feats

    if t["trialType"] not in ("code", "fix_bug") or not code.strip() or not t["testCode"].strip():
        continue
    coding += 1
    concepts = set(t.get("concepts", []))
    try:
        ast.parse(code)
    except SyntaxError as e:
        errs.append(f"Trial {tid} referenceSolution SyntaxError: {e}")
        continue
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
        ok, msg, ns = run_trial_code(code, t["testCode"], t.get("requiredConstructs") or [], t.get("variants") or [])
        if ok:
            passed += 1
        else:
            errs.append(f"Trial {tid} referenceSolution failed: {msg}")
            continue
    except Exception as e:
        errs.append(f"Trial {tid} referenceSolution failed: {type(e).__name__}: {e}")
        continue

    if check_cheats:
        cheat_lines = []
        for k, v in ns.items():
            if k in ("__builtins__", "say", "shout", "OUTPUT"):
                continue
            if isinstance(v, (int, float, str, bool, type(None), list, dict, tuple)):
                cheat_lines.append(f"{k} = {v!r}")
        out_val = ns.get("OUTPUT", "")
        if out_val:
            for line in out_val.rstrip("\\n").splitlines():
                cheat_lines.append(f"print({line!r})")
        cheat_code = "\\n".join(cheat_lines) + "\\n"
        try:
            c_ok, _, _ = run_trial_code(cheat_code, t["testCode"], t.get("requiredConstructs") or [], t.get("variants") or [])
            if c_ok:
                cheat_passed.append(tid)
        except Exception:
            pass

print(json.dumps({"passed": passed, "coding": coding, "errors": errs, "cheatPassed": cheat_passed}))
`;
    const pyRes = spawnSync('python3', ['-c', pyScript], {
      input: JSON.stringify({ trials: allTrials, checkCheats: CHECK_CHEATS }),
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (pyRes.status !== 0) {
      errors.push(`Python referenceSolution runner failed: ${pyRes.stderr || pyRes.stdout || pyRes.error?.message}`);
    } else {
      const pyOut = JSON.parse(pyRes.stdout);
      passedCoding = pyOut.passed;
      totalCoding = pyOut.coding;
      cheatPassed = pyOut.cheatPassed || [];
      for (const e of pyOut.errors) errors.push(e);
    }
  }

  if (CHECK_CHEATS) {
    console.log(`Anti-cheat check: ${cheatPassed.length}/${totalCoding} hard-coded cheat solutions passed.`);
    if (cheatPassed.length > 0) {
      console.log(`  Cheatable trials: ${cheatPassed.join(', ')}`);
    }
  }

  if (errors.length === 0) {
    console.log(
      `Content validation passed: ${(eraOrder || []).length} eras, ${totalRealms} realms, ${totalTrials} trials (${passedCoding}/${totalCoding} referenceSolutions + constructs + variants passed), ${mapFiles.length} maps, ${unlockIds.size} unlockables.`
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
