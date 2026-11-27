// Formal client-side router for Pyria: Return of the Bits
//
// Routes:
//   /               -> { name: 'title', path: '/' }
//   /new            -> { name: 'charcreate', path: '/new' }
//   /play/:saveId   -> { name: 'game', saveId: '<id>', path: '/play/<encoded>' }
//
// Any unrecognized route normalizes to { name: 'title', path: '/', unknown: true }.

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function buildRoutePath(route) {
  if (!route || typeof route !== 'object') return '/';
  if (route.name === 'charcreate') return '/new';
  if (route.name === 'game' && route.saveId) {
    return `/play/${encodeURIComponent(String(route.saveId))}`;
  }
  return '/';
}

export function parseRoute(pathname) {
  const raw = String(pathname || '/').split('?')[0].split('#')[0];
  const cleaned = raw.replace(/\/+$/, '') || '/';

  if (cleaned === '/' || cleaned === '/index.html') {
    return { name: 'title', path: '/' };
  }

  if (cleaned === '/new') {
    return { name: 'charcreate', path: '/new' };
  }

  if (cleaned.startsWith('/play/')) {
    const rest = cleaned.slice('/play/'.length);
    // Only accept a single non-empty saveId segment
    if (rest && !rest.includes('/')) {
      const saveId = safeDecode(rest);
      if (saveId && saveId.trim().length > 0) {
        return {
          name: 'game',
          saveId,
          path: `/play/${encodeURIComponent(saveId)}`,
        };
      }
    }
  }

  return { name: 'title', path: '/', unknown: true };
}

export function routesEqual(a, b) {
  if (!a || !b) return false;
  if (a.name !== b.name) return false;
  if (a.name === 'game') return a.saveId === b.saveId;
  return true;
}

export class AppRouter {
  constructor({ onRoute, win = globalThis.window } = {}) {
    if (typeof onRoute !== 'function') {
      throw new Error('AppRouter requires an onRoute callback');
    }
    this._onRoute = onRoute;
    this._win = win;
    this._started = false;
    this._navSeq = 0;
    this._currentRoute = parseRoute(win?.location?.pathname || '/');
    this._onPopState = (event) => {
      const next = parseRoute(this._win?.location?.pathname || '/');
      this._dispatch(next, { source: 'popstate', navState: event?.state ?? null });
    };
  }

  current() {
    return this._currentRoute;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._win?.addEventListener?.('popstate', this._onPopState);
    const initial = parseRoute(this._win?.location?.pathname || '/');
    // Normalize unknown or trailing-slash paths cleanly in-place
    if (initial.unknown || this._win?.location?.pathname !== initial.path) {
      this._win?.history?.replaceState?.(null, '', initial.path);
    }
    return this._dispatch(initial, { source: 'init', navState: null });
  }

  destroy() {
    if (!this._started) return;
    this._started = false;
    this._win?.removeEventListener?.('popstate', this._onPopState);
  }

  navigate(route, { replace = false, state = null, force = false } = {}) {
    const path = buildRoutePath(route);
    const parsed = parseRoute(path);
    const currentPath = this._win?.location?.pathname || '/';

    if (!force && routesEqual(this._currentRoute, parsed) && currentPath === parsed.path) {
      return Promise.resolve();
    }

    if (replace) {
      this._win?.history?.replaceState?.(state, '', parsed.path);
    } else if (currentPath !== parsed.path) {
      this._win?.history?.pushState?.(state, '', parsed.path);
    }

    return this._dispatch(parsed, {
      source: replace ? 'replace' : 'navigate',
      navState: state,
    });
  }

  replace(route, { silent = false, state = null } = {}) {
    const path = buildRoutePath(route);
    const parsed = parseRoute(path);
    this._win?.history?.replaceState?.(state, '', parsed.path);
    if (silent) {
      this._currentRoute = parsed;
      return Promise.resolve();
    }
    return this._dispatch(parsed, { source: 'replace', navState: state });
  }

  _dispatch(route, { source, navState }) {
    const seq = ++this._navSeq;
    const prevRoute = this._currentRoute;
    this._currentRoute = route;
    const ctx = {
      route,
      prevRoute,
      source,
      navState,
      isCurrent: () => seq === this._navSeq,
    };
    return Promise.resolve(this._onRoute(ctx));
  }
}
