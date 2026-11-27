export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  PYRIA_SESSION_SECRET?: string;
  PYRIA_ADMIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  MAGIC_LINK_FROM_EMAIL?: string;
  // Optional overrides for quotas, rate limits, and OAuth/email endpoints (useful for tests/tuning)
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
  PYRIA_RATE_LIMIT_MAGIC_LINK?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_USERINFO_URL?: string;
  RESEND_API_URL?: string;
}

export type DifficultyMode = 'explorer' | 'standard' | 'challenge';

export interface SavePreferences {
  difficulty?: DifficultyMode;
  showRawTracebacks?: boolean;
  maxPipHints?: number;
}

export type TokenType = 'hero' | 'parent' | 'oauth_state' | 'magic_link';

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

export interface MagicLinkTokenPayload {
  typ: 'magic_link';
  email: string;
  jti: string;
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
  magicLinkEnabled: boolean;
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
  difficultyMode: DifficultyMode;
  isPractice: boolean;
  errorType: string | null;
  durationMs: number | null;
  createdAt: string;
}

export type TrialCalibrationFlag = 'too_hard' | 'too_easy' | 'possible_bug' | 'low_data' | 'ok';

export interface TrialMetadata {
  trialId: string;
  title: string;
  eraId: string;
  eraName: string;
  realmId: string;
  realmName: string;
  trialType: string;
  concepts: string[];
}

export interface TrialMetricsFilters {
  eraId: string | null;
  realmId: string | null;
  trialType: string | null;
  difficulty: 'all' | DifficultyMode;
  days: '7' | '30' | '90' | 'all';
  since: string | null;
  minHeroes: number;
  includePractice: boolean;
  format: 'json' | 'csv';
}

export interface TrialMetricRow {
  trialId: string;
  title: string;
  eraId: string;
  eraName: string;
  realmId: string;
  realmName: string;
  trialType: string;
  concepts: string[];
  uniqueHeroes: number;
  uniqueSolvers: number;
  attempts: number;
  passes: number;
  completionRate: number | null;
  firstTryPassRate: number | null;
  medianAttemptsToSolve: number | null;
  p75AttemptsToSolve: number | null;
  hintUsageRate: number | null;
  tier3HintRate: number | null;
  hintTierBreakdown: {
    tier0: number;
    tier1: number;
    tier2: number;
    tier3: number;
  };
  parentOverrides: number;
  parentOverrideRate: number | null;
  topErrors: Array<{ errorType: string; count: number }>;
  dailyTrend: Array<{ day: string; attempts: number; passes: number }>;
  flag: TrialCalibrationFlag;
  flagReasons: string[];
}

export interface TrialMetricsSummary {
  totalTrials: number;
  trialsWithData: number;
  flaggedTooHard: number;
  flaggedTooEasy: number;
  flaggedPossibleBug: number;
  flaggedLowData: number;
  overallMedianAttempts: number | null;
  totalOverrides: number;
  truncated?: boolean;
}

export interface TrialMetricsResponse {
  filters: TrialMetricsFilters;
  summary: TrialMetricsSummary;
  trials: TrialMetricRow[];
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
