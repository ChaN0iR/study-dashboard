// Offline record preparation only: no database writes, network calls or logging.
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

export async function createInviteRecord(email, expiresAt, now = Date.now()) {
  const allowedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (allowedEmail.length > 254 || !emailPattern.test(allowedEmail) ||
      !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("valid email and explicit future invitation expiry required");
  }
  const inviteCode = encode(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inviteCode))));
  return { inviteCode, tokenHash, allowedEmail, createdAt: now, expiresAt };
}
