import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachAutocomplete,
  buildCharCreateSuggestions,
  buildTrialSuggestions,
  buildWorkshopSuggestions,
} from './autocomplete.js';

test('buildCharCreateSuggestions includes base commands and allowed appearance arg values', () => {
  const list = buildCharCreateSuggestions({
    characterCreation: {
      allowedValues: {
        skin: ['ivory', 'warm_tan'],
        hair: ['spiky'],
        tunic: ['emerald', 'crimson'],
      },
    },
  });

  const fnNames = list.filter((i) => i.category === 'fn').map((i) => i.matchText);
  assert.deepEqual(fnNames, ['set_name', 'preview_skin', 'preview_hair', 'preview_tunic', 'confirm_hero']);

  const skinArgs = list.filter((i) => i.category === 'arg' && i.fnName === 'preview_skin').map((i) => i.matchText);
  assert.deepEqual(skinArgs, ['ivory', 'warm_tan']);

  const tunicArgs = list.filter((i) => i.category === 'arg' && i.fnName === 'preview_tunic').map((i) => i.matchText);
  assert.deepEqual(tunicArgs, ['emerald', 'crimson']);
});

test('buildTrialSuggestions adapts by realm/era progression and extracts trial helpers & variables', () => {
  // Realm 1 (8-bit): training spells say/shout first, no if/for/def
  const r1 = buildTrialSuggestions({
    era: { id: 'era-01-8bit' },
    realm: { number: 1 },
    trial: {
      objective: 'Call activate_beacon() with power_level',
      starterCode: { explorer: 'power_level = 5\n', standard: '', challenge: '' },
    },
  });
  const r1Names = r1.map((i) => i.matchText);
  assert.equal(r1Names[0], 'say');
  assert.ok(r1Names.includes('shout'));
  assert.ok(r1Names.includes('activate_beacon'));
  assert.ok(r1Names.includes('power_level'));
  assert.equal(r1Names.includes('if'), false);
  assert.equal(r1Names.includes('for'), false);
  assert.equal(r1Names.includes('def'), false);

  // Realm 7 (8-bit): print at top (no say/shout), has conditionals, string methods, loops
  const r7 = buildTrialSuggestions({
    era: { id: 'era-01-8bit' },
    realm: { number: 7 },
    trial: {},
  });
  const r7Names = r7.map((i) => i.matchText);
  assert.equal(r7Names[0], 'print');
  assert.equal(r7Names.includes('say'), false);
  assert.ok(r7Names.includes('abs'));
  assert.ok(r7Names.includes('elif'));
  assert.ok(r7Names.includes('.lower'));
  assert.ok(r7Names.includes('range'));
  assert.equal(r7Names.includes('def'), false);

  // Era 2 (16-bit): includes def, return, while, .append
  const e2 = buildTrialSuggestions({
    era: { id: 'era-02-16bit' },
    realm: { number: 1 },
    trial: {},
  });
  const e2Names = e2.map((i) => i.matchText);
  assert.ok(e2Names.includes('def'));
  assert.ok(e2Names.includes('return'));
  assert.ok(e2Names.includes('while'));
  assert.ok(e2Names.includes('.append'));
});

test('buildWorkshopSuggestions marks owned vs unowned items and generates quoted arg completions', () => {
  const list = buildWorkshopSuggestions(
    {
      unlockables: [
        { id: 'hat-explorer', name: 'Explorer Hat', functionCall: 'wear_hat("explorer")', shardCost: 25 },
        { id: 'stat-courage-1', name: 'Courage +1', functionCall: 'add_courage(1)', shardCost: 40 },
      ],
    },
    { ownedUnlockIds: ['hat-explorer'] }
  );

  const hatEntry = list.find((i) => i.category === 'workshop' && i.matchText === 'wear_hat("explorer")');
  assert.ok(hatEntry.description.includes('Owned'));

  const statEntry = list.find((i) => i.category === 'workshop' && i.matchText === 'add_courage(1)');
  assert.ok(statEntry.description.includes('40 Shards'));

  const hatArg = list.find((i) => i.category === 'arg' && i.fnName === 'wear_hat' && i.matchText === 'explorer');
  assert.ok(hatArg);

  const tunicArgs = list.filter((i) => i.category === 'arg' && i.fnName === 'set_tunic_color');
  assert.equal(tunicArgs.length, 4);
});

test('attachAutocomplete handles ident/arg/method modes, keyboard nav, Ctrl+Enter, Escape, viewport flip & teardown', () => {
  // No-op guard on invalid args
  assert.equal(typeof attachAutocomplete(null, null), 'function');

  const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWinDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');

  class FakeEl {
    constructor(tag) {
      this.tag = tag;
      this.className = '';
      this.style = {};
      this.attrs = {};
      this.listeners = new Map(); // key: `${type}:${capture}`
      this.children = [];
      this.innerHTML = '';
      this.textContent = '';
      this.offsetLeft = 10;
      this.offsetTop = 20;
      this.offsetHeight = 120;
      this.removed = false;
      this._rectTop = 100;
      this.classList = {
        add: (c) => {
          if (!this.className.split(/\s+/).includes(c)) this.className = `${this.className} ${c}`.trim();
        },
        remove: (c) => {
          this.className = this.className
            .split(/\s+/)
            .filter((x) => x && x !== c)
            .join(' ');
        },
        contains: (c) => this.className.split(/\s+/).includes(c),
      };
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    remove() {
      this.removed = true;
    }
    addEventListener(type, fn, capture = false) {
      const key = `${type}:${Boolean(capture)}`;
      if (!this.listeners.has(key)) this.listeners.set(key, new Set());
      this.listeners.get(key).add(fn);
    }
    removeEventListener(type, fn, capture = false) {
      this.listeners.get(`${type}:${Boolean(capture)}`)?.delete(fn);
    }
    dispatchEvent(evt) {
      for (const cap of [true, false]) {
        for (const fn of this.listeners.get(`${evt.type}:${cap}`) || []) fn(evt);
      }
    }
    querySelectorAll() {
      return [];
    }
    querySelector() {
      return null;
    }
    getBoundingClientRect() {
      return { left: 100, top: this._rectTop };
    }
    focus() {}
  }

  const body = new FakeEl('body');
  Object.defineProperty(globalThis, 'document', {
    value: {
      body,
      activeElement: null,
      createElement: (tag) => new FakeEl(tag),
    },
    configurable: true,
    writable: true,
  });
  const winListeners = new Map();
  Object.defineProperty(globalThis, 'window', {
    value: {
      innerWidth: 1024,
      innerHeight: 300,
      getComputedStyle: () => ({ lineHeight: '20px', fontSize: '14px' }),
      addEventListener: (t, fn) => {
        if (!winListeners.has(t)) winListeners.set(t, new Set());
        winListeners.get(t).add(fn);
      },
      removeEventListener: (t, fn) => winListeners.get(t)?.delete(fn),
    },
    configurable: true,
    writable: true,
  });

  try {
    const textarea = new FakeEl('textarea');
    textarea.scrollLeft = 0;
    textarea.scrollTop = 0;

    const suggestions = [
      { label: 'print("<script>")', matchText: 'print', snippet: 'print("$0")', category: 'fn', description: 'Output <text>' },
      { label: 'preview_skin()', matchText: 'preview_skin', snippet: 'preview_skin("$0")', category: 'fn' },
      { label: '"ivory"', matchText: 'ivory', snippet: 'ivory', category: 'arg', fnName: 'preview_skin' },
      { label: '"emerald"', matchText: 'emerald', snippet: 'emerald', category: 'arg', fnName: 'preview_tunic' },
      { label: '.lower()', matchText: '.lower', snippet: '.lower()', category: 'method' },
      { label: '.upper()', matchText: '.upper', snippet: '.upper()', category: 'method' },
    ];

    const teardown = attachAutocomplete(textarea, () => suggestions);
    const dropdown = body.children[0];

    // 1. Identifier completion + HTML escaping + ArrowUp wrap + Tab accept
    textarea.value = 'pr';
    textarea.selectionStart = textarea.selectionEnd = 2;
    textarea.dispatchEvent({ type: 'input' });
    assert.equal(dropdown.classList.contains('hidden'), false);
    assert.ok(dropdown.innerHTML.includes('&lt;script&gt;'));
    assert.ok(!dropdown.innerHTML.includes('<script>'));

    // ArrowUp wraps from index 0 to index 1 (preview_skin)
    textarea.dispatchEvent({
      type: 'keydown',
      key: 'ArrowUp',
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    textarea.dispatchEvent({
      type: 'keydown',
      key: 'Tab',
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
    });
    assert.equal(textarea.value, 'preview_skin("")');
    assert.equal(textarea.selectionStart, 14);

    // 2. String-argument completion inside preview_skin("iv
    textarea.value = 'preview_skin("iv';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent({ type: 'input' });
    assert.equal(dropdown.classList.contains('hidden'), false);
    assert.ok(dropdown.innerHTML.includes('ivory'));
    assert.ok(!dropdown.innerHTML.includes('emerald'));

    // Ctrl+Enter closes without accepting (so Run Code shortcut works)
    textarea.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      ctrlKey: true,
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
    });
    assert.equal(textarea.value, 'preview_skin("iv');
    assert.equal(dropdown.classList.contains('hidden'), true);

    // 3. Dot-method completion + viewport flip above caret + Escape close
    textarea._rectTop = 240; // near bottom of 300px viewport -> flips above caret
    textarea.value = 'word.lo';
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent({ type: 'input' });
    assert.equal(dropdown.classList.contains('hidden'), false);
    assert.ok(dropdown.innerHTML.includes('.lower()'));
    assert.ok(parseInt(dropdown.style.top, 10) < 240);

    textarea.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault: () => {},
      stopImmediatePropagation: () => {},
    });
    assert.equal(dropdown.classList.contains('hidden'), true);

    // 4. Non-token context closes dropdown
    textarea.value = '123 ';
    textarea.selectionStart = textarea.selectionEnd = 4;
    textarea.dispatchEvent({ type: 'input' });
    assert.equal(dropdown.classList.contains('hidden'), true);

    // 5. Teardown removes dropdown and ALL listeners (including capture keydown & window resize)
    teardown();
    assert.equal(dropdown.removed, true);
    assert.equal(textarea.listeners.get('input:false').size, 0);
    assert.equal(textarea.listeners.get('keydown:true').size, 0);
    assert.equal(textarea.listeners.get('blur:false').size, 0);
    assert.equal(textarea.listeners.get('scroll:false').size, 0);
    assert.equal(winListeners.get('resize').size, 0);
  } finally {
    if (prevDocDesc) Object.defineProperty(globalThis, 'document', prevDocDesc);
    else delete globalThis.document;
    if (prevWinDesc) Object.defineProperty(globalThis, 'window', prevWinDesc);
    else delete globalThis.window;
  }
});

test('buildTrialSuggestions does not turn variables followed by prose parentheticals into function calls', () => {
  const suggestions = buildTrialSuggestions({
    era: { id: 'era-01-8bit' },
    realm: { number: 2 },
    trial: {
      objective:
        'Add left_gems (8) and right_gems (5) into total_gems, then use say() with str() to output: Gems: 13',
      starterCode: {
        explorer: 'left_gems = 8\nright_gems = 5\ntotal_gems = left_gems + right_gems\nsay("Gems: " + str(???))\n',
        standard: 'left_gems = 8\nright_gems = 5\n',
        challenge: '',
      },
    },
  });

  const leftGems = suggestions.find((s) => s.matchText === 'left_gems');
  assert.ok(leftGems, 'left_gems should be suggested');
  assert.equal(leftGems.label, 'left_gems');
  assert.equal(leftGems.snippet, 'left_gems');
  assert.equal(leftGems.category, 'keyword');

  const rightGems = suggestions.find((s) => s.matchText === 'right_gems');
  assert.ok(rightGems, 'right_gems should be suggested');
  assert.equal(rightGems.label, 'right_gems');
  assert.equal(rightGems.snippet, 'right_gems');
  assert.equal(rightGems.category, 'keyword');

  const totalGems = suggestions.find((s) => s.matchText === 'total_gems');
  assert.ok(totalGems, 'total_gems should be suggested');
  assert.equal(totalGems.snippet, 'total_gems');
});

test('buildTrialSuggestions ignores prose parentheticals, dot-methods, and placeholder underscores as standalone functions', () => {
  const suggestions = buildTrialSuggestions({
    era: { id: 'era-02-16bit' },
    realm: { number: 5 },
    trial: {
      objective:
        'Call activate_beacon() on raw_word.strip().upper(), flap twice (10, then 15), and sort descending (reverse=True).',
      starterCode: {
        explorer: 'raw_word = "  ok  "\nresult = raw_word.___()\n',
        standard: '',
        challenge: '',
      },
    },
  });

  const fnNames = suggestions.filter((s) => s.category === 'fn').map((s) => s.matchText);
  assert.ok(fnNames.includes('activate_beacon'), 'real function call should be extracted');
  assert.equal(fnNames.includes('strip'), false, 'dot-method should not be suggested as standalone fn');
  assert.equal(fnNames.includes('upper'), false, 'dot-method should not be suggested as standalone fn');
  assert.equal(fnNames.includes('twice'), false, 'prose word before parenthetical should not be a fn');
  assert.equal(fnNames.includes('descending'), false, 'prose word before parenthetical should not be a fn');
  assert.equal(fnNames.includes('___'), false, 'underscore placeholder should not be a fn');
});
