export const HERO_SESSION_COOKIE = 'pyria_hero_session';
export const PARENT_SESSION_COOKIE = 'pyria_parent_session';
export const OAUTH_STATE_COOKIE = 'pyria_oauth_state';

export const HERO_SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
export const PARENT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
export const OAUTH_STATE_TTL_SECONDS = 60 * 10; // 10 minutes
export const PARENT_LINK_TTL_SECONDS = 60 * 15; // 15 minutes
export const HERO_PLAY_TTL_SECONDS = 60 * 15; // 15 minutes

const HERO_WORDS_FIRST = [
  'AMBER', 'AZURE', 'BLAZE', 'BRIGHT', 'CEDAR', 'COBALT', 'COMET', 'CORAL',
  'CRISP', 'CRYSTAL', 'DAWN', 'EMBER', 'FERN', 'FLINT', 'FROST', 'GLEAM',
  'GOLDEN', 'HARBOR', 'IVORY', 'JADE', 'JASPER', 'LUNA', 'MAPLE', 'MEADOW',
  'MISTY', 'MOSS', 'NEBULA', 'NOVA', 'OAKEN', 'ONYX', 'OPAL', 'ORBIT',
  'PEBBLE', 'PINE', 'PIXEL', 'PRISM', 'QUARTZ', 'RAPID', 'RIVER', 'RUBY',
  'RUNE', 'SABLE', 'SAGE', 'SAPPHIRE', 'SCARLET', 'SHADOW', 'SILVER', 'SOLAR',
  'SPARK', 'STAR', 'STORM', 'SUNNY', 'SWIFT', 'THORN', 'TIDE', 'TIMBER',
  'TOPAZ', 'TRAIL', 'VALE', 'VELVET', 'VERDANT', 'VIOLET', 'WILLOW', 'ZEPHYR',
] as const;

const HERO_WORDS_SECOND = [
  'ACORN', 'ANVIL', 'ARROW', 'BADGER', 'BEACON', 'BEAR', 'BLADE', 'BRIDGE',
  'BROOK', 'CANYON', 'CASTLE', 'CAVERN', 'CITADEL', 'CLOVER', 'COMPASS', 'CROWN',
  'DRAGON', 'EAGLE', 'FALCON', 'FLAME', 'FORGE', 'FOX', 'GARDEN', 'GLADE',
  'GRIFFIN', 'GROVE', 'HAWK', 'HELM', 'HERON', 'ISLAND', 'KEEP', 'KNIGHT',
  'LANTERN', 'LYNX', 'MAGE', 'MANOR', 'OWL', 'PEAK', 'PHOENIX', 'PILLAR',
  'PORTAL', 'QUILL', 'RANGER', 'RAVEN', 'REEF', 'RIDGE', 'ROBIN', 'SCEPTER',
  'SCROLL', 'SHIELD', 'SPIRE', 'SPRITE', 'STAG', 'STONE', 'SUMMIT', 'SWORD',
  'TEMPLE', 'TORCH', 'TOWER', 'TIGER', 'VALLEY', 'VAULT', 'WIZARD', 'WOLF',
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(str: string): Uint8Array | null {
  if (!str || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(
  secret: string,
  usages: ('sign' | 'verify')[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

export async function signToken(payload: object, secret: string): Promise<string> {
  const data = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return `${data}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifyToken<T extends { typ: string; exp: number }>(
  token: string | undefined,
  secret: string,
  expectedTyp: T['typ']
): Promise<T | null> {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;

  const dataPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  const sigBytes = base64UrlDecode(sigPart);
  if (!sigBytes || sigBytes.length !== 32) return null;

  const key = await importHmacKey(secret, ['verify']);
  // Web Crypto HMAC verify performs constant-time comparison
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    encoder.encode(dataPart)
  );
  if (!valid) return null;

  const payloadBytes = base64UrlDecode(dataPart);
  if (!payloadBytes) return null;

  try {
    const parsed = JSON.parse(decoder.decode(payloadBytes)) as T;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.typ !== expectedTyp ||
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (parsed.exp <= nowSec) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('Cookie');
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      out[key] = val;
    }
  }
  return out;
}

export function isHttpsRequest(request: Request): boolean {
  const fwdProto = (request.headers.get('X-Forwarded-Proto') || '').split(',')[0].trim().toLowerCase();
  if (fwdProto === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    path?: string;
    httpOnly?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    secure?: boolean;
  } = {}
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearCookie(name: string, secure: boolean, path = '/'): string {
  return serializeCookie(name, '', {
    maxAge: 0,
    path,
    httpOnly: true,
    sameSite: 'Lax',
    secure,
  });
}

function randomIntBelow(maxExclusive: number): number {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) {
      return buf[0] % maxExclusive;
    }
  }
}

export function generateHeroCode(): string {
  const w1 = HERO_WORDS_FIRST[randomIntBelow(HERO_WORDS_FIRST.length)];
  const w2 = HERO_WORDS_SECOND[randomIntBelow(HERO_WORDS_SECOND.length)];
  // 64 * 64 * 1,000,000 = 4.096e9 (~32 bits of entropy)
  const num = randomIntBelow(1_000_000).toString().padStart(6, '0');
  return `${w1}-${w2}-${num}`;
}

const HERO_WORDS_FIRST_SET = new Set<string>(HERO_WORDS_FIRST);
const HERO_WORDS_SECOND_SET = new Set<string>(HERO_WORDS_SECOND);

export function normalizeHeroCode(raw: string): string {
  const basic = raw
    .trim()
    .toUpperCase()
    .replace(/[\s_–—]+/g, '-')
    .replace(/-+/g, '-');

  // Also accept dashless codes like "EMBERDRAGON482103" by matching known word lists
  if (!basic.includes('-')) {
    const m = basic.match(/^([A-Z]+)(\d{6})$/);
    if (m) {
      const letters = m[1];
      const digits = m[2];
      for (const w1 of HERO_WORDS_FIRST_SET) {
        if (letters.startsWith(w1)) {
          const rest = letters.slice(w1.length);
          if (HERO_WORDS_SECOND_SET.has(rest)) {
            return `${w1}-${rest}-${digits}`;
          }
        }
      }
    }
  }

  return basic;
}

export async function hashHeroCode(normalizedCode: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`pyria:hero-code:v1:${normalizedCode}`)
  );
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function generateRandomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}
