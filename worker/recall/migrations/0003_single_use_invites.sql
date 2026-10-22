-- Additive schema only. Remote application requires separate owner approval.
CREATE TABLE IF NOT EXISTS registration_invites (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash) = 43),
  allowed_email TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS registration_invite_redemptions (
  invite_hash TEXT PRIMARY KEY NOT NULL REFERENCES registration_invites(token_hash),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  redeemed_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS registration_invite_validate_redemption
BEFORE INSERT ON registration_invite_redemptions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM registration_invites AS i JOIN users AS u ON u.id = NEW.user_id
    WHERE i.token_hash = NEW.invite_hash AND i.allowed_email = u.email COLLATE NOCASE
      AND i.revoked_at IS NULL AND i.created_at <= NEW.redeemed_at
      AND i.expires_at > NEW.redeemed_at
      AND i.expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  ) THEN RAISE(ABORT, 'INVITE_UNAVAILABLE') END;
END;
