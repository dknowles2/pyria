-- Pyria D1 trial analytics & durable daily rollups (GitHub Issue #70)

ALTER TABLE trial_attempts ADD COLUMN difficulty_mode TEXT;
ALTER TABLE trial_attempts ADD COLUMN is_practice INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trial_attempts ADD COLUMN error_type TEXT;
ALTER TABLE trial_attempts ADD COLUMN duration_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_attempts_trial_id
    ON trial_attempts(trial_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trial_stats_daily (
    day TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
    trial_id TEXT NOT NULL,
    difficulty_mode TEXT NOT NULL,      -- explorer | standard | challenge
    attempts INTEGER NOT NULL DEFAULT 0,
    passes INTEGER NOT NULL DEFAULT 0,
    first_try_passes INTEGER NOT NULL DEFAULT 0,
    unique_solvers INTEGER NOT NULL DEFAULT 0,
    total_hints INTEGER NOT NULL DEFAULT 0,
    tier3_hints INTEGER NOT NULL DEFAULT 0,
    parent_overrides INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, trial_id, difficulty_mode)
);

CREATE INDEX IF NOT EXISTS idx_trial_stats_daily_trial
    ON trial_stats_daily(trial_id, day DESC);
