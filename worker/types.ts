export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PYRIA_SESSION_SECRET?: string;
  PYRIA_ADMIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Optional overrides for quotas, rate limits, and OAuth endpoints (useful for tests/tuning)
  PYRIA_MAX_SAVES_PER_ACCOUNT?: string;
  PYRIA_MAX_UNOWNED_SAVES?: string;
  PYRIA_MAX_DAILY_ANON_CREATES?: string;
  PYRIA_UNOWNED_IDLE_DAYS?: string;
  PYRIA_MAX_ATTEMPT_CODE_ROWS?: string;
  PYRIA_MAX_ATTEMPTS_PER_SAVE?: string;
  PYRIA_MAX_EVENTS_PER_SAVE?: string;
  PYRIA_RATE_LIMIT_CREATE?: string;
  PYRIA_RATE_LIMIT_REDEEM?: string;
  PYRIA_RATE_LIMIT_CLAIM?: string;
  PYRIA_RATE_LIMIT_GLOBAL_FAIL?: string;
  PYRIA_RATE_LIMIT_SAVES?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_USERINFO_URL?: string;
}

export type DifficultyMode = 'explorer' | 'standard' | 'challenge';

export interface SavePreferences {
  difficulty?: DifficultyMode;
  showRawTracebacks?: boolean;
  maxPipHints?: number;
}

export type TokenType = 'hero' | 'parent' | 'oauth_state';

export interface HeroSessionPayload {
  typ: 'hero';
  saveId: string;
  sessionVersion: number;
  exp: number;
}

export interface ParentSessionPayload {
  typ: 'parent';
  email: string;
  exp: number;
}

export interface OAuthStatePayload {
  typ: 'oauth_state';
  state: string;
  codeVerifier: string;
  next: string;
  exp: number;
}

export type AuthRole = 'guest' | 'hero' | 'parent' | 'admin';

export interface AuthContext {
  role: AuthRole;
  heroSaveId: string | null;
  heroName: string | null;
  heroPreferences: SavePreferences | null;
  parentEmail: string | null;
  isAdmin: boolean;
  googleOAuthEnabled: boolean;
}

export interface SaveDbRow {
  id: string;
  hero_name: string;
  owner_email: string | null;
  recovery_code_hash: string | null;
  session_version: number;
  preferences_json: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

export interface SaveRecord {
  id: string;
  heroName: string;
  ownerEmail: string | null;
  createdAt: string;
  updatedAt: string;
  preferences?: SavePreferences;
  [key: string]: unknown;
}

export interface AttemptRecord {
  id: number;
  saveId: string;
  trialId: string;
  passed: boolean;
  hintsUsed: number;
  code: string;
  createdAt: string;
}

export interface ActivityEventRecord {
  id: number;
  saveId: string;
  heroName: string;
  ownerEmail: string | null;
  eventType: string;
  realmId: string | null;
  trialId: string | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface EnrichedSaveRecord {
  id: string;
  heroName: string;
  ownerEmail: string | null;
  sessionVersion: number;
  hasHeroCode: boolean;
  preferences: SavePreferences;
  state: SaveRecord;
  stats: {
    attemptCount: number;
    passCount: number;
    totalHintsUsed: number;
    solvedCount: number;
    rescuedCount: number;
    lastActive: string;
  };
  updatedAt: string;
}
