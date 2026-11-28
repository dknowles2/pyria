import test from 'node:test';
import assert from 'node:assert/strict';

import { AppRouter, buildRoutePath, parseRoute, routesEqual } from './router.js';

function createMockWindow(initialPath = '/') {
  const listeners = new Map();
  const stack = [{ path: initialPath, state: null }];
  let index = 0;

  const win = {
    location: {
      get pathname() {
        return stack[index].path;
      },
    },
    history: {
      pushState(state, _title, url) {
        stack.splice(index + 1);
        stack.push({ path: String(url), state });
        index = stack.length - 1;
      },
      replaceState(state, _title, url) {
        stack[index] = { path: String(url), state };
      },
      back() {
        if (index > 0) {
          index -= 1;
          const handlers = listeners.get('popstate') || [];
          for (const fn of handlers) fn({ state: stack[index].state });
        }
      },
      forward() {
        if (index < stack.length - 1) {
          index += 1;
          const handlers = listeners.get('popstate') || [];
          for (const fn of handlers) fn({ state: stack[index].state });
        }
      },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((f) => f !== fn));
    },
  };

  return { win, stack };
}

test('parseRoute handles title, charcreate, game, trailing slashes, and unknown paths', () => {
  assert.deepEqual(parseRoute('/'), { name: 'title', path: '/' });
  assert.deepEqual(parseRoute('/index.html'), { name: 'title', path: '/' });
  assert.deepEqual(parseRoute('/new'), { name: 'charcreate', path: '/new' });
  assert.deepEqual(parseRoute('/new/'), { name: 'charcreate', path: '/new' });
  assert.deepEqual(parseRoute('/play/abc-123'), {
    name: 'game',
    saveId: 'abc-123',
    path: '/play/abc-123',
  });
  assert.deepEqual(parseRoute('/play/guest-1700000000-ab12cd/'), {
    name: 'game',
    saveId: 'guest-1700000000-ab12cd',
    path: '/play/guest-1700000000-ab12cd',
  });
  assert.deepEqual(parseRoute('/play/hero%20one'), {
    name: 'game',
    saveId: 'hero one',
    path: '/play/hero%20one',
  });
  assert.deepEqual(parseRoute('/play/'), { name: 'title', path: '/', unknown: true });
  assert.deepEqual(parseRoute('/play/a/b'), { name: 'title', path: '/', unknown: true });
  assert.deepEqual(parseRoute('/play/%E0%A4%A'), { name: 'title', path: '/', unknown: true });
  assert.deepEqual(parseRoute('/unknown/route'), { name: 'title', path: '/', unknown: true });
});

test('buildRoutePath and routesEqual round-trip all routes', () => {
  assert.equal(buildRoutePath({ name: 'title' }), '/');
  assert.equal(buildRoutePath({ name: 'charcreate' }), '/new');
  assert.equal(buildRoutePath({ name: 'game', saveId: 'save-42' }), '/play/save-42');
  assert.equal(buildRoutePath({ name: 'game' }), '/');

  assert.equal(routesEqual({ name: 'title' }, { name: 'title' }), true);
  assert.equal(
    routesEqual({ name: 'game', saveId: 'a' }, { name: 'game', saveId: 'a' }),
    true
  );
  assert.equal(
    routesEqual({ name: 'game', saveId: 'a' }, { name: 'game', saveId: 'b' }),
    false
  );
});

test('AppRouter navigates, handles popstate back/forward, and supports silent replace', async () => {
  const { win } = createMockWindow('/play/save-1');
  const events = [];
  const router = new AppRouter({
    win,
    onRoute: (ctx) => {
      events.push({
        name: ctx.route.name,
        saveId: ctx.route.saveId || null,
        source: ctx.source,
        current: ctx.isCurrent(),
      });
    },
  });

  await router.start();
  assert.equal(win.location.pathname, '/play/save-1');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    name: 'game',
    saveId: 'save-1',
    source: 'init',
    current: true,
  });

  // Silent replace updates URL and current() without re-firing onRoute
  await router.replace({ name: 'game', saveId: 'cloud-99' }, { silent: true });
  assert.equal(win.location.pathname, '/play/cloud-99');
  assert.equal(router.current().saveId, 'cloud-99');
  assert.equal(events.length, 1);

  // Navigate to title
  await router.navigate({ name: 'title' });
  assert.equal(win.location.pathname, '/');
  assert.equal(events.length, 2);
  assert.equal(events[1].name, 'title');

  // Navigate to charcreate
  await router.navigate({ name: 'charcreate' });
  assert.equal(win.location.pathname, '/new');
  assert.equal(events.length, 3);
  assert.equal(events[2].name, 'charcreate');

  // Browser back -> title
  win.history.back();
  assert.equal(win.location.pathname, '/');
  assert.equal(events[events.length - 1].name, 'title');
  assert.equal(events[events.length - 1].source, 'popstate');

  // Browser back -> game (cloud-99)
  win.history.back();
  assert.equal(win.location.pathname, '/play/cloud-99');
  assert.equal(events[events.length - 1].name, 'game');
  assert.equal(events[events.length - 1].saveId, 'cloud-99');

  router.destroy();
});

test('AppRouter invalidates stale async navigations via isCurrent()', async () => {
  const { win } = createMockWindow('/');
  const checks = [];
  let releaseFirst;

  const router = new AppRouter({
    win,
    onRoute: async (ctx) => {
      if (ctx.route.name === 'game' && ctx.route.saveId === 'slow') {
        await new Promise((r) => {
          releaseFirst = r;
        });
      }
      checks.push({ route: ctx.route.name, saveId: ctx.route.saveId || null, isCurrent: ctx.isCurrent() });
    },
  });

  await router.start();
  const slowNav = router.navigate({ name: 'game', saveId: 'slow' });
  await router.navigate({ name: 'title' });
  releaseFirst();
  await slowNav;

  const slowResult = checks.find((c) => c.saveId === 'slow');
  assert.equal(slowResult.isCurrent, false);
  router.destroy();
});
