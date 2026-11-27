import { jsonResponse } from './security';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const STALE_WINDOW_SECONDS = 86400; // 24 hours

/**
 * Expand an IPv6 address into 8 canonical 4-hex-digit groups and return its /64 prefix,
 * so rotating addresses within a /64 subnet share the same rate-limit bucket.
 */
export function normalizeIpForRateLimit(rawIp: string): string {
  const trimmed = rawIp.trim().toLowerCase();
  if (!trimmed.includes(':')) {
    return trimmed || '127.0.0.1';
  }
  // Strip optional zone id or brackets
  const clean = trimmed.replace(/^\[|\]$/g, '').split('%', 1)[0];
  const parts = clean.split('::');
  if (parts.length > 2) return clean;

  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];

  // Handle IPv4-mapped IPv6 like ::ffff:192.0.2.1
  if (right.length > 0 && right[right.length - 1].includes('.')) {
    const ipv4 = right.pop()!;
    const octets = ipv4.split('.').map((o) => Number.parseInt(o, 10));
    if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      right.push(((octets[0] << 8) | octets[1]).toString(16));
      right.push(((octets[2] << 8) | octets[3]).toString(16));
    }
  }

  const missing = 8 - (left.length + right.length);
  if (missing < 0) return clean;
  const full = [
    ...left,
    ...Array.from({ length: parts.length === 2 ? missing : 0 }, () => '0'),
    ...right,
  ];
  if (full.length < 4) return clean;
  const prefix = full.slice(0, 4).map((h) => h.padStart(4, '0')).join(':');
  return `${prefix}::/64`;
}

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp && cfIp.trim()) return normalizeIpForRateLimit(cfIp);
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return normalizeIpForRateLimit(first);
  }
  return '127.0.0.1';
}

export async function checkRateLimit(
  db: D1Database,
  bucketKey: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSeconds;

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket_key, count, window_start)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
       RETURNING count, window_start`
    )
    .bind(bucketKey, now, cutoff, cutoff)
    .first<{ count: number; window_start: number }>();

  // Opportunistically prune stale rate_limits rows (>24h old)
  if (Math.random() < 0.05) {
    await db
      .prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(now - STALE_WINDOW_SECONDS)
      .run();
  }

  const count = row?.count ?? 1;
  const windowStart = row?.window_start ?? now;

  if (count > limit) {
    const retryAfter = Math.max(1, windowStart + windowSeconds - now);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export function rateLimitExceededResponse(retryAfterSeconds: number): Response {
  return jsonResponse(
    {
      error: 'Too many requests. Please wait a moment and try again.',
      retryAfterSeconds,
    },
    429,
    { 'Retry-After': String(retryAfterSeconds) }
  );
}

/**
 * Read-only check before Hero Code hash/lookup: if the global failure budget is exhausted
 * AND this IP (/64) has already had >=1 recent failure, reject with 429 before lookup.
 * Clean IPs entering a valid Hero Code on the first try are never blocked by griefers.
 */
export async function checkGlobalHeroCodeThrottle(
  db: D1Database,
  ip: string,
  globalLimit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSeconds;

  const [globalRow, ipFailRow] = await Promise.all([
    db
      .prepare('SELECT count, window_start FROM rate_limits WHERE bucket_key = ?')
      .bind('hero-code-fail:global')
      .first<{ count: number; window_start: number }>(),
    db
      .prepare('SELECT count, window_start FROM rate_limits WHERE bucket_key = ?')
      .bind(`hero-fail-ip:${ip}`)
      .first<{ count: number; window_start: number }>(),
  ]);

  const globalTripped =
    globalRow !== null && globalRow.window_start > cutoff && globalRow.count >= globalLimit;
  const ipHasRecentFail =
    ipFailRow !== null && ipFailRow.window_start > cutoff && ipFailRow.count >= 1;

  if (globalTripped && ipHasRecentFail) {
    const retryAfter = Math.max(1, globalRow.window_start + windowSeconds - now);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Record a failed Hero Code guess against both the global failure bucket and the client IP bucket.
 */
export async function recordHeroCodeFailure(
  db: D1Database,
  ip: string,
  globalLimit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const [globalRl] = await Promise.all([
    checkRateLimit(db, 'hero-code-fail:global', globalLimit, windowSeconds),
    checkRateLimit(db, `hero-fail-ip:${ip}`, 1000, windowSeconds),
  ]);
  return globalRl;
}
