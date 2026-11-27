import { jsonResponse } from './security';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp && cfIp.trim()) return cfIp.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
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
