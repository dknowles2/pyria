/* eslint-disable no-restricted-globals */
// Dedicated Web Worker running Pyodide v0.26.4 for real Python 3 execution.
// Classic worker (not module) so importScripts works across all browsers.

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

let pyodide = null;
let initPromise = null;

async function ensurePyodide() {
  if (pyodide) return pyodide;
  if (!initPromise) {
    initPromise = (async () => {
      importScripts(PYODIDE_URL);
      const instance = await self.loadPyodide({ indexURL: PYODIDE_INDEX });
      pyodide = instance;
      self.postMessage({ type: 'ready' });
      return instance;
    })().catch((err) => {
      initPromise = null;
      self.postMessage({
        type: 'init_error',
        error: err && err.message ? err.message : String(err),
      });
      throw err;
    });
  }
  return initPromise;
}

// Start warming up Pyodide immediately on worker boot.
ensurePyodide().catch(() => {});

const TRIAL_HARNESS_PY = `
import io
import json
import contextlib
import traceback

def _pyria_run_trial(payload_json):
    payload = json.loads(payload_json)
    student_code = payload.get("studentCode", "")
    test_code = payload.get("testCode", "")

    ns = {
        "say": print,
        "shout": print,
    }
    buf = io.StringIO()
    stage = "student"
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(student_code, "<your_spell>", "exec"), ns)
        ns["OUTPUT"] = buf.getvalue()
        stage = "test"
        if test_code:
            exec(compile(test_code, "<trial_check>", "exec"), ns)
        return json.dumps({
            "passed": True,
            "stdout": buf.getvalue(),
            "errorType": None,
            "errorMessage": None,
            "errorLine": None,
            "rawTraceback": None,
            "stage": "done",
        })
    except SyntaxError as e:
        return json.dumps({
            "passed": False,
            "stdout": buf.getvalue(),
            "errorType": type(e).__name__,
            "errorMessage": e.msg or str(e),
            "errorLine": e.lineno,
            "rawTraceback": traceback.format_exc(),
            "stage": stage,
        })
    except Exception as e:
        tb = e.__traceback__
        line_no = None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == "<your_spell>":
                line_no = tb.tb_lineno
            tb = tb.tb_next
        return json.dumps({
            "passed": False,
            "stdout": buf.getvalue(),
            "errorType": type(e).__name__,
            "errorMessage": str(e),
            "errorLine": line_no,
            "rawTraceback": traceback.format_exc(),
            "stage": stage,
        })
`;

const CHARCREATE_HARNESS_PY = `
import io
import json
import contextlib
import traceback

def _pyria_run_charcreate(payload_json):
    payload = json.loads(payload_json)
    code = payload.get("code", "")
    state = dict(payload.get("currentAppearance", {}))
    allowed = payload.get("allowedValues", {})
    confirmed = {"value": False}
    events = []

    def set_name(hero_name):
        if not isinstance(hero_name, str):
            raise TypeError("set_name() needs text inside quotes, like set_name(\\"Rowan\\")")
        cleaned = hero_name.strip()
        if len(cleaned) < 2 or len(cleaned) > 16:
            raise ValueError("Hero name must be between 2 and 16 characters long!")
        state["name"] = cleaned
        events.append(f"Hero name set to {cleaned}!")
        print(f"Name forged: {cleaned}")

    def preview_skin(tone):
        options = allowed.get("skin", [])
        if not isinstance(tone, str):
            raise TypeError("preview_skin() needs a quoted skin name, like preview_skin(\\"warm_tan\\")")
        if tone not in options:
            raise ValueError(f"Unknown skin '{tone}'. Choose one of: {', '.join(options)}")
        state["skin"] = tone
        events.append(f"Skin tone set to {tone}")
        print(f"Skin preview: {tone}")

    def preview_hair(style):
        options = allowed.get("hair", [])
        if not isinstance(style, str):
            raise TypeError("preview_hair() needs a quoted hairstyle, like preview_hair(\\"spiky\\")")
        if style not in options:
            raise ValueError(f"Unknown hair '{style}'. Choose one of: {', '.join(options)}")
        state["hair"] = style
        events.append(f"Hairstyle set to {style}")
        print(f"Hair preview: {style}")

    def preview_tunic(color):
        options = allowed.get("tunic", [])
        if not isinstance(color, str):
            raise TypeError("preview_tunic() needs a quoted color, like preview_tunic(\\"emerald\\")")
        if color not in options:
            raise ValueError(f"Unknown tunic '{color}'. Choose one of: {', '.join(options)}")
        state["tunic"] = color
        events.append(f"Tunic color set to {color}")
        print(f"Tunic preview: {color}")

    def confirm_hero():
        confirmed["value"] = True
        events.append("Hero confirmed! Entering Whispering Meadow...")
        print(f"Hero {state.get('name', 'Code-Tamer')} confirmed!")

    ns = {
        "set_name": set_name,
        "preview_skin": preview_skin,
        "preview_hair": preview_hair,
        "preview_tunic": preview_tunic,
        "confirm_hero": confirm_hero,
    }
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<hero_forge>", "exec"), ns)
        return json.dumps({
            "passed": True,
            "stdout": buf.getvalue(),
            "appearance": state,
            "confirmed": confirmed["value"],
            "events": events,
            "errorType": None,
            "errorMessage": None,
            "errorLine": None,
            "rawTraceback": None,
        })
    except SyntaxError as e:
        return json.dumps({
            "passed": False,
            "stdout": buf.getvalue(),
            "appearance": state,
            "confirmed": False,
            "events": events,
            "errorType": type(e).__name__,
            "errorMessage": e.msg or str(e),
            "errorLine": e.lineno,
            "rawTraceback": traceback.format_exc(),
        })
    except Exception as e:
        tb = e.__traceback__
        line_no = None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == "<hero_forge>":
                line_no = tb.tb_lineno
            tb = tb.tb_next
        return json.dumps({
            "passed": False,
            "stdout": buf.getvalue(),
            "appearance": state,
            "confirmed": False,
            "events": events,
            "errorType": type(e).__name__,
            "errorMessage": str(e),
            "errorLine": line_no,
            "rawTraceback": traceback.format_exc(),
        })
`;

const WORKSHOP_HARNESS_PY = `
import io
import json
import contextlib
import traceback

def _pyria_run_workshop(payload_json):
    payload = json.loads(payload_json)
    code = payload.get("code", "")
    unlockables = payload.get("unlockables", [])
    save = payload.get("saveState", {})

    appearance = dict(save.get("appearance", {}))
    stats = dict(save.get("stats", {"charisma": 0, "courage": 0}))
    owned = list(save.get("ownedUnlockIds", []))
    shards = [int(save.get("byteShards", 0))]
    purchased = []
    equipped = []

    by_id = {item["id"]: item for item in unlockables}

    def _buy_or_use(item_id, label):
        item = by_id.get(item_id)
        if not item:
            raise ValueError(f"Bram scratches his beard: I don't have a blueprint for '{label}'!")
        if item_id in owned:
            return item, False
        cost = int(item.get("shardCost", 0))
        if shards[0] < cost:
            raise ValueError(
                f"Not enough Byte Shards for {item['name']}! You need {cost} Shards, but you have {shards[0]}."
            )
        shards[0] -= cost
        owned.append(item_id)
        purchased.append(item["name"])
        return item, True

    def wear_hat(hat_name):
        if not isinstance(hat_name, str):
            raise TypeError('wear_hat() needs a quoted hat name, like wear_hat("explorer")')
        key = hat_name.strip().lower()
        if key in ("none", "off", ""):
            appearance["hat"] = None
            equipped.append("Hat removed")
            print("Took off hat.")
            return
        mapping = {
            "explorer": ("hat-explorer", "hat_explorer"),
            "dragon_helm": ("hat-dragon-helm", "hat_dragon_helm"),
            "wizard_cap": ("hat-wizard-cap", "hat_wizard_cap"),
        }
        if key not in mapping:
            raise ValueError(f"Unknown hat '{hat_name}'. Try: explorer, dragon_helm, wizard_cap, or none")
        item_id, sprite_key = mapping[key]
        item, bought = _buy_or_use(item_id, hat_name)
        appearance["hat"] = sprite_key
        equipped.append(item["name"])
        verb = "Forged and equipped" if bought else "Equipped"
        print(f"{verb} {item['name']}! ({shards[0]} Shards left)")

    def set_tunic_color(color):
        if not isinstance(color, str):
            raise TypeError('set_tunic_color() needs a quoted color, like set_tunic_color("crimson")')
        key = color.strip().lower()
        paid_map = {
            "crimson": "tunic-crimson",
            "navy": "tunic-navy",
        }
        free_colors = {"emerald", "amber", "violet", "slate"}
        if key in paid_map:
            if appearance.get("tunic") == key:
                print(f"Already wearing the {key} tunic!")
                return
            item, bought = _buy_or_use(paid_map[key], color)
            appearance["tunic"] = key
            equipped.append(item["name"])
            verb = "Dyed and equipped" if bought else "Equipped"
            print(f"{verb} {item['name']}! ({shards[0]} Shards left)")
        elif key in free_colors:
            appearance["tunic"] = key
            equipped.append(f"{key} tunic")
            print(f"Switched tunic color to {key}!")
        else:
            raise ValueError(f"Unknown tunic color '{color}'. Try: emerald, crimson, navy, amber, violet, slate")

    def equip_boots(boots_name):
        if not isinstance(boots_name, str):
            raise TypeError('equip_boots() needs a quoted name, like equip_boots("swift")')
        key = boots_name.strip().lower()
        if key in ("default", "normal", "none"):
            appearance["boots"] = "boots_default"
            equipped.append("Starter Boots")
            print("Equipped Starter Boots.")
            return
        if key != "swift":
            raise ValueError(f"Unknown boots '{boots_name}'. Try: swift or default")
        item, bought = _buy_or_use("boots-swift", boots_name)
        appearance["boots"] = "boots_swift"
        equipped.append(item["name"])
        verb = "Forged and equipped" if bought else "Equipped"
        print(f"{verb} {item['name']}! Walk speed boosted! ({shards[0]} Shards left)")

    def equip_shield(shield_name):
        if not isinstance(shield_name, str):
            raise TypeError('equip_shield() needs a quoted name, like equip_shield("oak")')
        key = shield_name.strip().lower()
        if key in ("none", "off", ""):
            appearance["shield"] = None
            equipped.append("Shield unequipped")
            print("Put away shield.")
            return
        mapping = {
            "oak": ("shield-oak", "shield_oak"),
            "coral": ("shield-coral", "shield_coral"),
        }
        if key not in mapping:
            raise ValueError(f"Unknown shield '{shield_name}'. Try: oak, coral, or none")
        item_id, sprite_key = mapping[key]
        item, bought = _buy_or_use(item_id, shield_name)
        appearance["shield"] = sprite_key
        equipped.append(item["name"])
        verb = "Forged and equipped" if bought else "Equipped"
        print(f"{verb} {item['name']}! ({shards[0]} Shards left)")

    def equip_cloak(cloak_name):
        if not isinstance(cloak_name, str):
            raise TypeError('equip_cloak() needs a quoted name, like equip_cloak("tide")')
        key = cloak_name.strip().lower()
        if key in ("none", "off", ""):
            appearance["cloak"] = None
            equipped.append("Cloak removed")
            print("Removed cloak.")
            return
        if key != "tide":
            raise ValueError(f"Unknown cloak '{cloak_name}'. Try: tide or none")
        item, bought = _buy_or_use("cloak-tide", cloak_name)
        appearance["cloak"] = "cloak_tide"
        equipped.append(item["name"])
        verb = "Wove and equipped" if bought else "Equipped"
        print(f"{verb} {item['name']}! ({shards[0]} Shards left)")

    def add_charisma(amount=1):
        if not isinstance(amount, int) or amount < 1:
            raise ValueError("add_charisma() needs a positive whole number, like add_charisma(1)")
        item, bought = _buy_or_use("stat-charisma-1", "charisma")
        if bought:
            stats["charisma"] = int(stats.get("charisma", 0)) + amount
        appearance["aura"] = "aura_charisma_1"
        equipped.append(item["name"])
        verb = "Unlocked" if bought else "Activated"
        print(f"{verb} {item['name']}! Charisma is now {stats['charisma']}. ({shards[0]} Shards left)")

    def add_courage(amount=1):
        if not isinstance(amount, int) or amount < 1:
            raise ValueError("add_courage() needs a positive whole number, like add_courage(1)")
        item, bought = _buy_or_use("stat-courage-1", "courage")
        if bought:
            stats["courage"] = int(stats.get("courage", 0)) + amount
        appearance["aura"] = "aura_courage_1"
        equipped.append(item["name"])
        verb = "Unlocked" if bought else "Activated"
        print(f"{verb} {item['name']}! Courage is now {stats['courage']}. ({shards[0]} Shards left)")

    def equip_pip_scarf(scarf_name):
        if not isinstance(scarf_name, str):
            raise TypeError('equip_pip_scarf() needs a quoted name, like equip_pip_scarf("ember")')
        key = scarf_name.strip().lower()
        if key in ("none", "off", ""):
            appearance["pipScarf"] = None
            equipped.append("Pip scarf removed")
            print("Took off Pip's scarf.")
            return
        if key != "ember":
            raise ValueError(f"Unknown Pip scarf '{scarf_name}'. Try: ember or none")
        item, bought = _buy_or_use("pip-scarf-ember", scarf_name)
        appearance["pipScarf"] = "pip_scarf_ember"
        equipped.append(item["name"])
        verb = "Stitched and equipped" if bought else "Equipped"
        print(f"{verb} {item['name']}! Pip chirps happily! ({shards[0]} Shards left)")

    ns = {
        "wear_hat": wear_hat,
        "set_tunic_color": set_tunic_color,
        "equip_boots": equip_boots,
        "equip_shield": equip_shield,
        "equip_cloak": equip_cloak,
        "add_charisma": add_charisma,
        "add_courage": add_courage,
        "equip_pip_scarf": equip_pip_scarf,
    }
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<bram_workshop>", "exec"), ns)
        return json.dumps({
            "passed": True,
            "stdout": buf.getvalue(),
            "appearance": appearance,
            "stats": stats,
            "ownedUnlockIds": owned,
            "byteShards": shards[0],
            "purchased": purchased,
            "equipped": equipped,
            "errorType": None,
            "errorMessage": None,
            "errorLine": None,
            "rawTraceback": None,
        })
    except SyntaxError as e:
        return json.dumps({
            "passed": False,
            "stdout": buf.getvalue(),
            "errorType": type(e).__name__,
            "errorMessage": e.msg or str(e),
            "errorLine": e.lineno,
            "rawTraceback": traceback.format_exc(),
        })
    except Exception as e:
        tb = e.__traceback__
        line_no = None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == "<bram_workshop>":
                line_no = tb.tb_lineno
            tb = tb.tb_next
        return json.dumps({
            "passed": False,
            "stdout": buf.getvalue(),
            "errorType": type(e).__name__,
            "errorMessage": str(e),
            "errorLine": line_no,
            "rawTraceback": traceback.format_exc(),
        })
`;

let harnessesLoaded = false;

async function loadHarnesses(py) {
  if (harnessesLoaded) return;
  await py.runPythonAsync(TRIAL_HARNESS_PY);
  await py.runPythonAsync(CHARCREATE_HARNESS_PY);
  await py.runPythonAsync(WORKSHOP_HARNESS_PY);
  harnessesLoaded = true;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || !msg.id) return;

  try {
    const py = await ensurePyodide();
    await loadHarnesses(py);

    const payloadJson = JSON.stringify(msg.payload || {});
    py.globals.set('_pyria_payload_json', payloadJson);

    let fnName = '_pyria_run_trial';
    if (msg.mode === 'charcreate') fnName = '_pyria_run_charcreate';
    else if (msg.mode === 'workshop') fnName = '_pyria_run_workshop';

    const resultJson = py.runPython(`${fnName}(_pyria_payload_json)`);
    py.globals.delete('_pyria_payload_json');

    self.postMessage({
      type: 'result',
      id: msg.id,
      result: JSON.parse(resultJson),
    });
  } catch (err) {
    self.postMessage({
      type: 'result',
      id: msg.id,
      result: {
        passed: false,
        stdout: '',
        errorType: 'RuntimeError',
        errorMessage: err && err.message ? err.message : String(err),
        errorLine: null,
        rawTraceback: String(err),
      },
    });
  }
};
