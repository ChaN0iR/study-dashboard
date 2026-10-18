import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { authApi } from "./recall/auth.js";
import { readFile } from "node:fs/promises";

const nativeFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async () => { throw new Error("network access is forbidden in auth tests"); };
});
after(() => { globalThis.fetch = nativeFetch; });

function makeDb() {
  const users = new Map();
  const sessions = new Map();
  return {
    users,
    sessions,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (/SELECT id, email, password_hash FROM users/i.test(sql)) {
            const row = [...users.values()].find((u) => u.email.toLowerCase() === String(args[0]).toLowerCase());
            return row ? { id: row.id, email: row.email, password_hash: row.password_hash } : null;
          }
          if (/SELECT users\.id, users\.email FROM sessions JOIN users/i.test(sql)) {
            const [tokenHash, now] = args;
            const session = sessions.get(tokenHash);
            const user = session && session.expires_at > now ? users.get(session.user_id) : null;
            return user ? { id: user.id, email: user.email } : null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO users/i.test(sql)) {
            const [id, email, password_hash, created_at] = args;
            if ([...users.values()].some((u) => u.email === email)) throw new Error("UNIQUE constraint failed: users.email");
            users.set(id, { id, email, password_hash, created_at });
            return { success: true };
          }
          if (/INSERT INTO sessions/i.test(sql)) {
            const [token_hash, user_id, created_at, expires_at, last_seen_at] = args;
            sessions.set(token_hash, { token_hash, user_id, created_at, expires_at, last_seen_at });
            return { success: true };
          }
          if (/DELETE FROM sessions/i.test(sql)) { sessions.delete(args[0]); return { success: true }; }
          return { success: true };
        },
      };
    },
  };
}

function envWithDb(db = makeDb()) { return { DB: db }; }
let sequence = 0;
function ip() { sequence += 1; return `198.51.100.${(sequence % 240) + 1}`; }
function request(path, body, { origin = "https://recall.example", method = "POST", address = ip(), headers = {} } = {}) {
  const init = { method, headers: { origin, "cf-connecting-ip": address, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  return new Request(`https://recall.example${path}`, init);
}
async function call(db, path, body, options = {}) {
  const response = await authApi(request(path, body, options), envWithDb(db), path);
  return { response, body: await response.json() };
}
async function register(db, email, password, options = {}) {
  return call(db, "/api/auth/register", { email, password }, options);
}
async function login(db, email, password, options = {}) {
  return call(db, "/api/auth/login", { email, password }, options);
}

const acceptedPasswords = [
  ["1 character", "a"],
  ["digits only", "1234567890"],
  ["lowercase only", "lowercase"],
  ["Unicode", "密碼🔐é"],
  ["non-empty whitespace", "   "],
  ["129 characters", "x".repeat(129)],
  ["512 characters", "y".repeat(512)],
];
for (const [label, password] of acceptedPasswords) {
  test(`registers and logs in with ${label} without password format/length policy`, async () => {
    const db = makeDb();
    const email = `${label.replace(/[^a-z]/g, "")}@example.com`;
    const created = await register(db, email, password);
    assert.equal(created.response.status, 201);
    assert.notEqual(db.users.values().next().value.password_hash, password);
    const loggedIn = await login(db, email, password);
    assert.equal(loggedIn.response.status, 200);
  });
}

test("rejects missing, null, empty, and non-string registration passwords", async () => {
  for (const password of [undefined, null, "", 12345, {}, []]) {
    const db = makeDb();
    const payload = { email: "required@example.com" };
    if (password !== undefined) payload.password = password;
    const result = await call(db, "/api/auth/register", payload);
    assert.equal(result.response.status, 422, `${String(password)} status`);
    assert.equal(result.body.code, "PASSWORD_REQUIRED");
  }
});

test("rejects missing, null, empty, and non-string login passwords as invalid credentials", async () => {
  const db = makeDb();
  await register(db, "login-required@example.com", "correct");
  for (const password of [undefined, null, "", 12345, {}, []]) {
    const payload = { email: "login-required@example.com" };
    if (password !== undefined) payload.password = password;
    const result = await call(db, "/api/auth/login", payload);
    assert.equal(result.response.status, 401, `${String(password)} status`);
    assert.equal(result.body.code, "INVALID_CREDENTIALS");
  }
});

test("accepts spaces exactly and distinguishes correct from incorrect passwords", async () => {
  const db = makeDb();
  await register(db, "spaces@example.com", "  pass word  ");
  assert.equal((await login(db, "spaces@example.com", "  pass word  ")).response.status, 200);
  assert.equal((await login(db, "spaces@example.com", "pass word")).body.code, "INVALID_CREDENTIALS");
});

test("hashes passwords with PBKDF2-SHA256 100000 iterations, random salts, and no plaintext", async () => {
  const db = makeDb();
  await register(db, "one@example.com", "same-password");
  await register(db, "two@example.com", "same-password");
  const hashes = [...db.users.values()].map((u) => u.password_hash);
  assert.equal(hashes.length, 2);
  assert.notEqual(hashes[0], "same-password");
  assert.notEqual(hashes[1], "same-password");
  assert.notEqual(hashes[0], hashes[1], "same password must receive different salts/hashes");
  for (const encoded of hashes) {
    const [algorithm, iterations, salt, derived] = encoded.split("$");
    assert.equal(algorithm, "pbkdf2-sha256");
    assert.equal(iterations, "100000");
    assert.equal(atob(salt.replace(/-/g, "+").replace(/_/g, "/") + "==").length, 16);
    assert.equal(atob(derived.replace(/-/g, "+").replace(/_/g, "/") + "=").length, 32);
  }
});

test("enforces same-origin protection", async () => {
  const db = makeDb();
  const result = await register(db, "origin@example.com", "password", { origin: "https://evil.example" });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, "SAME_ORIGIN_ONLY");
});

test("returns 429 on the 13th auth request from one IP", async () => {
  const db = makeDb();
  const address = ip();
  const statuses = [];
  for (let i = 0; i < 13; i += 1) {
    const result = await call(db, "/api/auth/login", { email: "nobody@example.com", password: "x" }, { address });
    statuses.push(result.response.status);
  }
  assert.deepEqual(statuses.slice(0, 12), Array(12).fill(401));
  assert.equal(statuses[12], 429);
});

test("returns 413 for an auth body over 8 KiB", async () => {
  const db = makeDb();
  const result = await call(db, "/api/auth/register", JSON.stringify({ email: "large@example.com", password: "x" }) + " ".repeat(8000));
  assert.equal(result.response.status, 413);
  assert.equal(result.body.code, "REQUEST_TOO_LARGE");
});

test("logs in with an existing compatible PBKDF2-SHA256 hash", async () => {
  const db = makeDb();
  const password = "legacy-compatible";
  const salt = new Uint8Array(16);
  salt.fill(7);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
  const hash = `pbkdf2-sha256$100000$${b64(salt)}$${b64(new Uint8Array(bits))}`;
  db.users.set("legacy-id", { id: "legacy-id", email: "legacy@example.com", password_hash: hash, created_at: Date.now() });
  const result = await login(db, "legacy@example.com", password);
  assert.equal(result.response.status, 200);
});

test("UI password fields keep required/confirm validation but remove password length and pattern constraints", async () => {
  const authUi = await readFile(new URL("./recall/public/auth-ui.js", import.meta.url), "utf8");
  assert.match(authUi, /confirmInput\.required\s*=\s*mode\s*===\s*["']register["']/);
  assert.match(authUi, /password\s*!==\s*String\(confirmInput\?\.value/);
  for (const file of ["worker/recall/public/index.html", "docs/recall/index.html"]) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const passwordInput = html.match(/<input[^>]+id="rrPassword"[^>]*>/i)?.[0] || "";
    const confirmInput = html.match(/<input[^>]+id="rrPasswordConfirm"[^>]*>/i)?.[0] || "";
    assert.match(passwordInput, /\brequired\b/);
    assert.doesNotMatch(passwordInput, /\b(?:minlength|maxlength|pattern)\s*=/i);
    assert.doesNotMatch(confirmInput, /\b(?:minlength|maxlength|pattern)\s*=/i);
  }
});
