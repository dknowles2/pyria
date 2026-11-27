-- Pyria D1 initial schema (GitHub Issue #65 & #45)

CREATE TABLE IF NOT EXISTS saves (
    id TEXT PRIMARY KEY,
    hero_name TEXT NOT NULL,
    owner_email TEXT,                               -- NULL for standalone Hero Code saves; parent email when created/claimed
    recovery_code_hash TEXT UNIQUE,                 -- HMAC-SHA256 hash of normalized Hero Code (nullable)
    session_version INTEGER NOT NULL DEFAULT 1,     -- incremented when parent rotates/revokes a Hero Code
    preferences_json TEXT NOT NULL DEFAULT '{}',    -- per-hero difficulty/hints/traceback overrides
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    save_id TEXT NOT NULL,
    trial_id TEXT NOT NULL,
    passed INTEGER NOT NULL,
    hints_used INTEGER NOT NULL DEFAULT 0,
    code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (save_id) REFERENCES saves(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    save_id TEXT NOT NULL,
    hero_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    realm_id TEXT,
    trial_id TEXT,
    summary TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    window_start INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saves_updated_at ON saves(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_saves_owner_email ON saves(owner_email);
CREATE INDEX IF NOT EXISTS idx_saves_recovery_hash ON saves(recovery_code_hash);
CREATE INDEX IF NOT EXISTS idx_attempts_save_id ON trial_attempts(save_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_id ON activity_events(id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_save_id ON activity_events(save_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
