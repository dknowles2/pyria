export const PYODIDE_CDN_ORIGIN_PATH = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

export const CSP_DEFAULT =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "worker-src 'none'; " +
  "frame-src 'self'; " +
  "connect-src 'self'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'self'";

export async function buildPySandboxCsp(htmlText: string): Promise<string> {
  const hashes: string[] = [];
  const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  const encoder = new TextEncoder();

  while ((match = scriptRe.exec(htmlText)) !== null) {
    const body = match[1] ?? '';
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(body));
    const bytes = new Uint8Array(digest);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    hashes.push(`'sha256-${btoa(binary)}'`);
  }

  const scriptSources = [
    ...hashes,
    'blob:',
    PYODIDE_CDN_ORIGIN_PATH,
    "'wasm-unsafe-eval'",
  ].join(' ');

  return (
    'sandbox allow-scripts; ' +
    "default-src 'none'; " +
    `script-src ${scriptSources}; ` +
    'worker-src blob:; ' +
    `connect-src ${PYODIDE_CDN_ORIGIN_PATH}; ` +
    "object-src 'none'; " +
    "base-uri 'none'; " +
    "form-action 'none'; " +
    "frame-ancestors 'self'"
  );
}

export function applySecurityHeaders(
  headers: Headers,
  options?: {
    csp?: string;
    frameOptions?: 'DENY' | 'SAMEORIGIN';
  }
): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', options?.frameOptions ?? 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', options?.csp ?? CSP_DEFAULT);
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(data), { status, headers });
}

export function cacheControlForPath(pathname: string): string {
  const lower = pathname.toLowerCase();
  if (lower.startsWith('/api/')) {
    return 'no-store';
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.ico')
  ) {
    return 'public, max-age=86400';
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.css')) {
    return 'public, max-age=300';
  }
  if (lower.endsWith('.json')) {
    return 'public, max-age=300';
  }
  return 'public, max-age=60';
}

function normalizeHost(host: string, protocol: string): string {
  const clean = host.trim().toLowerCase();
  if (protocol === 'http:' && clean.endsWith(':80')) {
    return clean.slice(0, -3);
  }
  if (protocol === 'https:' && clean.endsWith(':443')) {
    return clean.slice(0, -4);
  }
  return clean;
}

/**
 * Same-origin CSRF check for mutating /api/* requests (POST, PUT, DELETE, PATCH).
 * Mirrors server/app.py's _check_same_origin.
 */
export function checkSameOrigin(request: Request): Response | null {
  const secFetchSite = (request.headers.get('Sec-Fetch-Site') || '').trim().toLowerCase();
  if (secFetchSite === 'cross-site') {
    return jsonResponse({ error: 'Cross-site request blocked' }, 403);
  }

  const origin = request.headers.get('Origin');
  if (origin !== null) {
    const clean = origin.trim();
    if (!clean || clean.toLowerCase() === 'null') {
      return jsonResponse({ error: 'Invalid Origin header' }, 403);
    }
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      return jsonResponse({ error: 'Invalid Origin header' }, 403);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
      return jsonResponse({ error: 'Invalid Origin header' }, 403);
    }
    const originHost = normalizeHost(parsed.host, parsed.protocol);
    const reqUrl = new URL(request.url);
    const fwdHost = (request.headers.get('X-Forwarded-Host') || '').split(',')[0].trim();
    const hostHdr = (request.headers.get('Host') || '').trim();
    const expectedRaw = fwdHost || hostHdr || reqUrl.host;
    const expectedHost = normalizeHost(expectedRaw, parsed.protocol);
    if (!expectedHost || originHost !== expectedHost) {
      return jsonResponse({ error: 'Cross-origin request blocked' }, 403);
    }
  }

  return null;
}

/**
 * Validate a relative post-login redirect path to prevent open redirects.
 */
export function sanitizeNextPath(raw: string | null | undefined, fallback = '/console'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return fallback;
  }
  if (trimmed.includes('\\') || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return fallback;
  }
  try {
    const resolved = new URL(trimmed, 'https://pyria.invalid');
    if (resolved.origin !== 'https://pyria.invalid') {
      return fallback;
    }
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}
