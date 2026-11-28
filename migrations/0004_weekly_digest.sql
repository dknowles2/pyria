-- Pyria D1 weekly progress digest schema (GitHub Issue #71)

CREATE TABLE IF NOT EXISTS parent_preferences (
    owner_email TEXT PRIMARY KEY,
    weekly_digest_enabled INTEGER NOT NULL DEFAULT 1,
    unsubscribed_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digest_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_email TEXT NOT NULL,
    week_key TEXT NOT NULL,            -- e.g. '2026-W48'
    hero_count INTEGER NOT NULL,
    trials_solved INTEGER NOT NULL,
    status TEXT NOT NULL,              -- 'sent' | 'failed'
    provider_message_id TEXT,
    error_message TEXT,
    sent_at TEXT NOT NULL,
    UNIQUE(owner_email, week_key)
);

CREATE INDEX IF NOT EXISTS idx_digest_deliveries_week_status
    ON digest_deliveries(week_key, status);
CREATE INDEX IF NOT EXISTS idx_digest_deliveries_owner
    ON digest_deliveries(owner_email, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_attempts_created_at
    ON trial_attempts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_created_at
    ON activity_events(created_at DESC);
