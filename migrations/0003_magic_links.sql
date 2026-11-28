-- Single-use Email Magic Link token consumption log (prevents replay)
CREATE TABLE IF NOT EXISTS magic_link_tokens (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_link_expires ON magic_link_tokens(expires_at);
