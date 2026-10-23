-- Additive migration; existing users, sessions and progress are unchanged.
-- Source only: do not apply to a remote database during development.
CREATE TABLE IF NOT EXISTS auth_attempt_windows (
  subject_digest TEXT PRIMARY KEY NOT NULL CHECK(length(subject_digest) = 64),
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 13),
  expires_at INTEGER NOT NULL CHECK(expires_at > window_start)
);
CREATE INDEX IF NOT EXISTS auth_attempt_windows_expiry_idx ON auth_attempt_windows(expires_at);
