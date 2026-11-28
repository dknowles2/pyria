// Reusable IDE-style Dropdown Autocomplete for Pyria's Python Terminals
// Supports identifiers, dot-methods, string-argument completions, $0 caret placement,
// desktop keyboard navigation, and iPadOS Safari touch selection without keyboard blur.

const MAX_ITEMS = 8;

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inspects the token immediately before the textarea caret.
 */
function getTokenContext(textarea) {
  const pos = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, pos);

  // 1. Inside a string argument: e.g. wear_hat("ex  or  preview_tunic('em
  const argMatch = before.match(/([a-zA-Z_]\w*)\s*\(\s*["']([a-zA-Z0-9_-]*)$/);
  if (argMatch) {
    const fnName = argMatch[1];
    const prefix = argMatch[2];
    return {
      kind: 'arg',
      fnName,
      prefix,
      replaceStart: pos - prefix.length,
    };
  }

  // 2. Dot method: e.g. word.lo  or  word.
  const dotMatch = before.match(/\.([a-zA-Z_]\w*)?$/);
  if (dotMatch) {
    const raw = dotMatch[1] || '';
    return {
      kind: 'method',
      prefix: `.${raw}`,
      rawPrefix: raw,
      replaceStart: pos - dotMatch[0].length,
    };
  }

  // 3. Identifier / keyword / function name: e.g. pr  or  wear_
  const identMatch = before.match(/([a-zA-Z_]\w*)$/);
  if (identMatch && identMatch[1].length >= 1) {
    return {
      kind: 'ident',
      prefix: identMatch[1],
      replaceStart: pos - identMatch[1].length,
    };
  }

  return null;
}

/**
 * Measures caret viewport coordinates using a hidden mirror div.
 */
function getCaretViewportCoords(textarea, pos) {
  const rect = textarea.getBoundingClientRect();
  const cs = window.getComputedStyle(textarea);

  const mirror = document.createElement('div');
  const props = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'wordSpacing', 'tabSize',
  ];
  mirror.style.position = 'fixed';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflow = 'hidden';
  for (const p of props) {
    mirror.style[p] = cs[p];
  }

  mirror.textContent = textarea.value.slice(0, pos);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(pos, pos + 1) || '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
  const x = rect.left + marker.offsetLeft - textarea.scrollLeft;
  const y = rect.top + marker.offsetTop - textarea.scrollTop;

  mirror.remove();
  return { x, y, lineHeight };
}

/**
 * Attaches an IDE-style floating autocomplete dropdown to a textarea.
 * Returns a teardown function to remove listeners and DOM nodes cleanly.
 */
export function attachAutocomplete(textarea, getSuggestions) {
  if (!textarea || typeof getSuggestions !== 'function') {
    return () => {};
  }

  const dropdown = document.createElement('div');
  dropdown.className = 'py-ac-dropdown hidden';
  dropdown.setAttribute('role', 'listbox');
  document.body.appendChild(dropdown);

  let items = [];
  let activeIndex = 0;
  let currentCtx = null;
  let isOpen = false;

  const close = () => {
    isOpen = false;
    items = [];
    currentCtx = null;
    dropdown.classList.add('hidden');
    dropdown.innerHTML = '';
  };

  const positionDropdown = () => {
    if (!isOpen) return;
    const pos = textarea.selectionStart ?? 0;
    const { x, y, lineHeight } = getCaretViewportCoords(textarea, pos);

    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const vTop = vv ? vv.offsetTop : 0;
    const vLeft = vv ? vv.offsetLeft : 0;

    const dropW = Math.min(360, vw - 16);
    dropdown.style.width = `${dropW}px`;

    const dropH = dropdown.offsetHeight || 200;
    let left = Math.max(vLeft + 8, Math.min(x, vLeft + vw - dropW - 8));
    let top = y + lineHeight + 4;

    // Flip above caret if dropdown would clip below viewport / iPad keyboard
    if (top + dropH > vTop + vh - 8) {
      const aboveTop = y - dropH - 6;
      if (aboveTop >= vTop + 8) {
        top = aboveTop;
      } else {
        top = Math.max(vTop + 8, vTop + vh - dropH - 8);
      }
    }

    dropdown.style.left = `${Math.round(left)}px`;
    dropdown.style.top = `${Math.round(top)}px`;
  };

  const accept = (item) => {
    if (!item || !currentCtx) return;
    const snippet = item.snippet ?? item.label;
    const markerIdx = snippet.indexOf('$0');
    const cleanText = markerIdx >= 0 ? snippet.replace('$0', '') : snippet;
    const caretOffset = markerIdx >= 0 ? markerIdx : cleanText.length;

    const val = textarea.value;
    const start = currentCtx.replaceStart;
    const end = textarea.selectionStart ?? start;

    textarea.value = val.slice(0, start) + cleanText + val.slice(end);
    const nextPos = start + caretOffset;
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = nextPos;
    close();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const render = () => {
    if (!items.length) {
      close();
      return;
    }
    isOpen = true;
    dropdown.classList.remove('hidden');
    dropdown.innerHTML = items
      .map(
        (item, idx) => `
        <div class="py-ac-row ${idx === activeIndex ? 'active' : ''}" role="option" aria-selected="${idx === activeIndex}" data-ac-idx="${idx}">
          <div class="py-ac-top">
            <code class="py-ac-sig">${escapeHtml(item.label)}</code>
            <span class="py-ac-cat cat-${escapeHtml(item.category || 'fn')}">${escapeHtml(item.category || 'fn')}</span>
          </div>
          ${item.description ? `<div class="py-ac-desc">${escapeHtml(item.description)}</div>` : ''}
        </div>
      `
      )
      .join('');

    dropdown.querySelectorAll('.py-ac-row').forEach((row) => {
      row.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const idx = Number(row.dataset.acIdx);
        accept(items[idx]);
      });
      row.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    positionDropdown();
    const activeRow = dropdown.querySelector('.py-ac-row.active');
    activeRow?.scrollIntoView({ block: 'nearest' });
  };

  const update = () => {
    const ctx = getTokenContext(textarea);
    if (!ctx) {
      close();
      return;
    }

    const all = getSuggestions(ctx) || [];
    const prefixLower = (ctx.prefix || '').toLowerCase();

    const matched = all
      .filter((s) => {
        if (ctx.kind === 'arg') {
          if (s.category !== 'arg') return false;
          if (s.fnName && s.fnName !== ctx.fnName) return false;
          return !prefixLower || s.matchText.toLowerCase().startsWith(prefixLower);
        }
        if (ctx.kind === 'method') {
          if (s.category !== 'method') return false;
          return s.matchText.toLowerCase().startsWith(prefixLower);
        }
        if (s.category === 'arg' || s.category === 'method') return false;
        const m = (s.matchText || s.label).toLowerCase();
        return m.startsWith(prefixLower) && m !== prefixLower;
      })
      .slice(0, MAX_ITEMS);

    if (!matched.length) {
      close();
      return;
    }

    currentCtx = ctx;
    items = matched;
    activeIndex = Math.min(activeIndex, items.length - 1);
    render();
  };

  const onInput = () => {
    activeIndex = 0;
    update();
  };

  const onKeyDown = (e) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      activeIndex = (activeIndex + 1) % items.length;
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey) {
        close();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      accept(items[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };

  const onBlur = () => {
    setTimeout(() => {
      if (document.activeElement !== textarea) {
        close();
      }
    }, 120);
  };

  const onScrollOrResize = () => {
    if (isOpen) positionDropdown();
  };

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeyDown, true);
  textarea.addEventListener('blur', onBlur);
  textarea.addEventListener('scroll', onScrollOrResize);
  window.addEventListener('resize', onScrollOrResize);
  window.visualViewport?.addEventListener('resize', onScrollOrResize);

  return () => {
    close();
    textarea.removeEventListener('input', onInput);
    textarea.removeEventListener('keydown', onKeyDown, true);
    textarea.removeEventListener('blur', onBlur);
    textarea.removeEventListener('scroll', onScrollOrResize);
    window.removeEventListener('resize', onScrollOrResize);
    window.visualViewport?.removeEventListener('resize', onScrollOrResize);
    dropdown.remove();
  };
}

// ==================== PROGRESSION-AWARE CATALOG BUILDERS ====================

export function buildCharCreateSuggestions(catalog) {
  const cc = catalog?.characterCreation;
  const list = [
    { label: 'set_name("Rowan")', matchText: 'set_name', snippet: 'set_name("$0")', category: 'fn', description: "Set your hero's display name (2–16 chars)" },
    { label: 'preview_skin("warm_tan")', matchText: 'preview_skin', snippet: 'preview_skin("$0")', category: 'fn', description: 'Change hero skin tone' },
    { label: 'preview_hair("spiky")', matchText: 'preview_hair', snippet: 'preview_hair("$0")', category: 'fn', description: 'Change hero hairstyle' },
    { label: 'preview_tunic("emerald")', matchText: 'preview_tunic', snippet: 'preview_tunic("$0")', category: 'fn', description: 'Change starter tunic color' },
    { label: 'confirm_hero()', matchText: 'confirm_hero', snippet: 'confirm_hero()', category: 'fn', description: 'Lock in your hero & start the adventure!' },
  ];

  const allowed = cc?.allowedValues || {};
  for (const tone of allowed.skin || []) {
    list.push({ label: `"${tone}"`, matchText: tone, snippet: tone, category: 'arg', fnName: 'preview_skin', description: 'Skin tone option' });
  }
  for (const style of allowed.hair || []) {
    list.push({ label: `"${style}"`, matchText: style, snippet: style, category: 'arg', fnName: 'preview_hair', description: 'Hairstyle option' });
  }
  for (const color of allowed.tunic || []) {
    list.push({ label: `"${color}"`, matchText: color, snippet: color, category: 'arg', fnName: 'preview_tunic', description: 'Tunic color option' });
  }
  return list;
}

export function buildTrialSuggestions({ realm, era, trial }) {
  const realmNum = Number(realm?.number) || 1;
  // Any era after the 8-bit era: the player has finished the whole 8-bit curriculum.
  const isLaterEra = Boolean(era?.id) && era.id !== 'era-01-8bit';
  const effectiveRealm = isLaterEra ? 99 : realmNum;
  const usesTrainingSpells = !isLaterEra && realmNum <= 3;

  const list = usesTrainingSpells
    ? [
        // Realms 1–3: Pyria training spells first, with real print() also available
        { label: 'say("...")', matchText: 'say', snippet: 'say("$0")', category: 'fn', description: 'Speak a message or value (Pyria training spell for print)' },
        { label: 'shout("...")', matchText: 'shout', snippet: 'shout("$0")', category: 'fn', description: 'Shout a password or command (Pyria training spell for print)' },
        { label: 'print("...")', matchText: 'print', snippet: 'print("$0")', category: 'fn', description: 'Real Python built-in (same as say/shout)' },
      ]
    : [
        // Realm 4+ and later eras: real print() right at the top!
        { label: 'print("...")', matchText: 'print', snippet: 'print("$0")', category: 'fn', description: 'Display text or numbers in the output' },
      ];

  if (effectiveRealm >= 2) {
    list.push(
      { label: 'abs(num)', matchText: 'abs', snippet: 'abs($0)', category: 'fn', description: 'Make a negative number positive' },
      { label: 'min(a, b)', matchText: 'min', snippet: 'min($0)', category: 'fn', description: 'Find the smallest number' },
      { label: 'max(a, b)', matchText: 'max', snippet: 'max($0)', category: 'fn', description: 'Find the biggest number' },
      { label: 'round(num)', matchText: 'round', snippet: 'round($0)', category: 'fn', description: 'Round a decimal to the nearest whole number' }
    );
  }

  if (effectiveRealm >= 3) {
    list.push(
      { label: 'if condition:', matchText: 'if', snippet: 'if $0:', category: 'keyword', description: 'Run indented code when a check is True' },
      { label: 'elif condition:', matchText: 'elif', snippet: 'elif $0:', category: 'keyword', description: 'Otherwise check another condition' },
      { label: 'else:', matchText: 'else', snippet: 'else:\n    $0', category: 'keyword', description: 'Run if earlier checks were False' },
      { label: 'True', matchText: 'True', snippet: 'True', category: 'keyword', description: 'Boolean yes / on value' },
      { label: 'False', matchText: 'False', snippet: 'False', category: 'keyword', description: 'Boolean no / off value' }
    );
  }

  if (effectiveRealm >= 5) {
    list.push(
      { label: 'and', matchText: 'and', snippet: 'and ', category: 'keyword', description: 'True only if BOTH sides are True' },
      { label: 'or', matchText: 'or', snippet: 'or ', category: 'keyword', description: 'True if EITHER side is True' },
      { label: 'not', matchText: 'not', snippet: 'not ', category: 'keyword', description: 'Flips True to False and False to True' }
    );
  }

  if (effectiveRealm >= 7 && !isLaterEra) {
    // 8-bit loops walk through the letters of a word; range() arrives in the 16-bit era.
    list.push(
      { label: 'for letter in word:', matchText: 'for', snippet: 'for letter in $0:\n    ', category: 'keyword', description: 'Repeat indented code once for every letter' }
    );
  }

  if (isLaterEra) {
    list.push(
      { label: 'len(items)', matchText: 'len', snippet: 'len($0)', category: 'fn', description: 'Count how many letters or items are inside' },
      { label: 'str(value)', matchText: 'str', snippet: 'str($0)', category: 'fn', description: 'Turn a number into text' },
      { label: 'int(value)', matchText: 'int', snippet: 'int($0)', category: 'fn', description: 'Turn text into a whole number' },
      { label: 'for i in range(n):', matchText: 'for', snippet: 'for i in range($0):\n    ', category: 'keyword', description: 'Repeat indented code a set number of times' },
      { label: 'range(stop)', matchText: 'range', snippet: 'range($0)', category: 'fn', description: 'Count from 0 up to just before stop' },
      { label: '.upper()', matchText: '.upper', snippet: '.upper()', category: 'method', description: 'Turn text into ALL CAPS' },
      { label: '.lower()', matchText: '.lower', snippet: '.lower()', category: 'method', description: 'Turn text into lowercase letters' },
      { label: '.strip()', matchText: '.strip', snippet: '.strip()', category: 'method', description: 'Trim extra spaces from both ends' },
      { label: '.replace(old, new)', matchText: '.replace', snippet: '.replace("$0", "")', category: 'method', description: 'Swap part of a string for new text' },
      { label: 'def name():', matchText: 'def', snippet: 'def $0():\n    ', category: 'keyword', description: 'Define a reusable Python function' },
      { label: 'return value', matchText: 'return', snippet: 'return $0', category: 'keyword', description: 'Send a result back from a function' },
      { label: 'while condition:', matchText: 'while', snippet: 'while $0:\n    ', category: 'keyword', description: 'Repeat while a condition stays True' },
      { label: '.append(item)', matchText: '.append', snippet: '.append($0)', category: 'method', description: 'Add an item to the end of a list' }
    );
  }

  // Parse puzzle-specific starter variables & helpers from current Trial.
  // Extract variables first so starter variable names can never be misclassified as functions.
  const seen = new Set(list.map((i) => i.matchText));
  const starterSources = [
    trial?.starterCode?.explorer || '',
    trial?.starterCode?.standard || '',
    trial?.starterCode?.challenge || '',
  ].join('\n');
  const allSources = [starterSources, trial?.objective || ''].join('\n');

  const varMatches = starterSources.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?!=)/gm);
  for (const m of varMatches) {
    const name = m[1];
    if (seen.has(name) || /^_+$/.test(name)) continue;
    seen.add(name);
    list.push({
      label: name,
      matchText: name,
      snippet: name,
      category: 'keyword',
      description: 'Variable in this Trial',
    });
  }

  // Require `(` immediately after the identifier (no whitespace) and not preceded by `.`
  // so prose parentheticals like `left_gems (8)` and dot-methods like `.strip()` are not
  // suggested as standalone function calls.
  const ignoredFnNames = new Set([
    'if', 'elif', 'while', 'for', 'return', 'assert',
    'and', 'or', 'not', 'in', 'is', 'del', 'yield', 'lambda', 'with', 'except', 'raise',
  ]);
  const fnMatches = allSources.matchAll(/(?<![.\w])([a-zA-Z_][a-zA-Z0-9_]*)\(/g);
  for (const m of fnMatches) {
    const name = m[1];
    if (seen.has(name) || /^_+$/.test(name) || ignoredFnNames.has(name.toLowerCase())) continue;
    seen.add(name);
    list.push({
      label: `${name}()`,
      matchText: name,
      snippet: `${name}($0)`,
      category: 'fn',
      description: 'Function mentioned in this Trial',
    });
  }

  return list;
}

export function buildWorkshopSuggestions(catalog, save) {
  const owned = new Set(save?.ownedUnlockIds || []);
  const list = [];

  for (const item of catalog?.unlockables || []) {
    const isOwned = owned.has(item.id);
    const costLabel = isOwned ? '✓ Owned (free to equip)' : `✦ ${item.shardCost} Shards`;
    const call = item.functionCall || '';
    const fnMatch = call.match(/^([a-zA-Z_]\w*)\((.*)\)$/);
    const fnName = fnMatch ? fnMatch[1] : call;

    list.push({
      label: call,
      matchText: call,
      snippet: call,
      category: 'workshop',
      description: `${item.name} — ${costLabel}`,
    });

    // Also provide argument completions inside quotes, e.g. wear_hat("ex
    if (fnMatch) {
      const argStrMatch = fnMatch[2].match(/^["']([^"']+)["']$/);
      if (argStrMatch) {
        const argVal = argStrMatch[1];
        list.push({
          label: `"${argVal}"`,
          matchText: argVal,
          snippet: argVal,
          category: 'arg',
          fnName,
          description: `${item.name} (${costLabel})`,
        });
      }
    }
  }

  // Starter free tunic colors inside set_tunic_color("...")
  for (const c of ['emerald', 'amber', 'violet', 'slate']) {
    list.push({
      label: `"${c}"`,
      matchText: c,
      snippet: c,
      category: 'arg',
      fnName: 'set_tunic_color',
      description: 'Starter tunic color (free)',
    });
  }

  return list;
}
