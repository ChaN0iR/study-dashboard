const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const encoder = new TextEncoder();

// One row per keyed IP digest. Never persist raw IP or account identifiers.
const CONSUME = `INSERT INTO auth_attempt_windows (subject_digest, window_start, attempts, expires_at)
VALUES (?1, ?2, 1, ?3)
ON CONFLICT(subject_digest) DO UPDATE SET
  attempts = CASE WHEN auth_attempt_windows.expires_at <= excluded.window_start THEN 1
    ELSE MIN(auth_attempt_windows.attempts + 1, 13) END,
  window_start = CASE WHEN auth_attempt_windows.expires_at <= excluded.window_start
    THEN excluded.window_start ELSE auth_attempt_windows.window_start END,
  expires_at = CASE WHEN auth_attempt_windows.expires_at <= excluded.window_start
    THEN excluded.expires_at ELSE auth_attempt_windows.expires_at END
RETURNING attempts, expires_at`;

export async function authRateLimited(request, env, now = Date.now()) {
  const secret = env.AUTH_RATE_LIMIT_KEY;
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || !Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - WINDOW_MS) {
    throw new Error("auth rate limit configuration unavailable");
  }
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`auth-ip-v1\0${address}`)));
  const subject = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  const row = await env.DB.prepare(CONSUME).bind(subject, now, now + WINDOW_MS).first();
  if (!row || !Number.isInteger(row.attempts) || row.attempts < 1 || row.attempts > MAX_ATTEMPTS + 1 ||
      !Number.isSafeInteger(row.expires_at) || row.expires_at <= now) {
    throw new Error("auth rate limit storage unavailable");
  }
  // Expiry cleanup is bounded; rejected requests never extend the lockout.
  if (row.attempts === 1) {
    await env.DB.prepare(`DELETE FROM auth_attempt_windows WHERE subject_digest IN (
      SELECT subject_digest FROM auth_attempt_windows WHERE expires_at <= ?1 ORDER BY expires_at LIMIT 100
    )`).bind(now).run();
  }
  return row.attempts > MAX_ATTEMPTS;
}
