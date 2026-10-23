import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { authApi } from "./recall/auth.js";
import { createInviteRecord } from "./recall/invite-record.js";

const root = await mkdtemp(path.join(tmpdir(), "study-single-use-invites-"));
let outbound = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { outbound++; throw new Error("network forbidden in invitation tests"); };
const options = {
  rootPath: root, name: "single-use-invites-local", modules: true, script: "export default {fetch(){return new Response('offline fixture');}}",
  compatibilityDate: "2026-01-01", d1Databases: { DB: "single-use-invites-fixture" }, resourcePersistencePath: path.join(root, "storage"),
  outboundService: async () => { outbound++; throw new Error("external network forbidden"); },
};
const rateKey = "offline-invite-test-rate-key-not-production";
let runtime, db, serial = 0;
const hash = async code => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))).toString("base64url");
const env = () => ({ DB: db, AUTH_RATE_LIMIT_KEY: rateKey, REGISTRATION_ENABLED: "true" });
async function mint(email, overrides = {}) {
  const code = Buffer.alloc(32, ++serial).toString("base64url"); // Deterministic dummy fixture only.
  const tokenHash = await hash(code);
  const now = Date.now();
  await db.prepare("INSERT INTO registration_invites (token_hash, allowed_email, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(tokenHash, email, now - 10000, overrides.expiresAt ?? now + 60000, overrides.revokedAt ?? null).run();
  return { code, tokenHash };
}
async function send(route, body, environment = env(), api = authApi) {
  const response = await api(new Request(`https://offline.example/api/auth/${route}`, {
    method: "POST", headers: { origin: "https://offline.example", "cf-connecting-ip": `198.51.100.${++serial}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), environment, `/api/auth/${route}`);
  return { response, body: await response.json() };
}
const register = (email, code, environment, api) => send("register", { email, password: "correct-password", inviteCode: code }, environment, api);
async function count(table) { return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n; }
async function noRegistration() {
  for (const table of ["users", "sessions", "registration_invite_redemptions"]) assert.equal(await count(table), 0, table);
}
async function reset() {
  await db.batch(["sessions", "registration_invite_redemptions", "registration_invites", "users", "auth_attempt_windows"].map(table => db.prepare(`DELETE FROM ${table}`)));
}
try {
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database("DB");
  const migrations = ["0001_auth_and_progress.sql", "0002_auth_attempt_windows.sql", "0003_single_use_invites.sql"];
  for (const file of migrations) {
    const sql = (await readFile(new URL(`./recall/migrations/${file}`, import.meta.url), "utf8")).replace(/^--.*$/gm, "");
    // Split only between CREATE statements; a trigger contains internal semicolons.
    for (const statement of sql.split(/;\s*(?=CREATE\s)/i).map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const prepared = await createInviteRecord(" Prepared@Example.Test ", Date.now() + 60000);
  assert.equal(prepared.allowedEmail, "prepared@example.test");
  assert.match(prepared.inviteCode, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(prepared.tokenHash, await hash(prepared.inviteCode));
  const secondRecord = await createInviteRecord(prepared.allowedEmail, prepared.expiresAt);
  assert.notEqual(prepared.inviteCode, secondRecord.inviteCode, "offline preparer uses independent random tokens");
  for (const [email, expires] of [["invalid", Date.now() + 60000], [prepared.allowedEmail, 0]]) {
    await assert.rejects(createInviteRecord(email, expires));
  }
  assert.equal(await count("registration_invites"), 0, "preparation alone never inserts a record");
  await db.prepare("INSERT INTO registration_invites VALUES (?, ?, ?, ?, NULL)")
    .bind(prepared.tokenHash, prepared.allowedEmail, prepared.createdAt, prepared.expiresAt).run();
  assert.equal((await register(prepared.allowedEmail, prepared.inviteCode)).response.status, 201);
  await reset();
  for (const enabled of [undefined, "false", true, "TRUE"]) {
    const result = await register("disabled@example.test", "x".repeat(43), { DB: { prepare() { throw Error("disabled registration must not touch storage"); } }, REGISTRATION_ENABLED: enabled, REGISTRATION_INVITE_CODE: "x".repeat(43) });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.code, "REGISTRATION_DISABLED");
  }
  const legacyOnly = await register("legacy-shared@example.test", "x".repeat(43), { ...env(), REGISTRATION_INVITE_CODE: "x".repeat(43) });
  assert.equal(legacyOnly.response.status, 403, "enabled registration never falls back to a matching old shared secret");
  await noRegistration();
  for (const scenario of ["missing", "wrong", "expired", "revoked", "wrong-email"]) {
    await reset();
    const invitation = await mint("student@example.test", scenario === "expired" ? { expiresAt: Date.now() - 1000 } : scenario === "revoked" ? { revokedAt: Date.now() } : {});
    const result = await register(scenario === "wrong-email" ? "other@example.test" : "student@example.test", scenario === "missing" ? undefined : scenario === "wrong" ? "x".repeat(43) : invitation.code);
    assert.equal(result.response.status, 403, scenario);
    assert.equal(result.body.code, "INVALID_INVITE_CODE");
    assert.equal(result.response.headers.get("set-cookie"), null);
    await noRegistration();
  }
  await reset();
  let invitation = await mint("student@example.test");
  const badPassword = await send("register", { email: "student@example.test", password: "short", inviteCode: invitation.code });
  assert.equal(badPassword.response.status, 422);
  await noRegistration();
  const created = await register(" Student@Example.Test ", invitation.code);
  assert.equal(created.response.status, 201);
  assert.match(created.response.headers.get("set-cookie"), /rr_session=/);
  for (const table of ["users", "sessions", "registration_invite_redemptions"]) assert.equal(await count(table), 1);
  assert.ok(!JSON.stringify(await db.prepare("SELECT * FROM registration_invites").all()).includes(invitation.code), "no raw invitation code in storage");
  assert.equal((await register("student@example.test", invitation.code)).response.status, 403);
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database("DB");
  assert.equal((await register("student@example.test", invitation.code)).response.status, 403, "redemption survives restart");
  assert.equal((await send("login", { email: "student@example.test", password: "correct-password" }, { DB: db, AUTH_RATE_LIMIT_KEY: rateKey })).response.status, 200, "existing login needs no registration opt-in");

  await reset();
  invitation = await mint("race@example.test");
  const independent = await import("./recall/auth.js?invitation-race-instance");
  const raced = await Promise.all(Array.from({ length: 8 }, (_, i) => register("race@example.test", invitation.code, env(), i % 2 ? independent.authApi : authApi)));
  assert.equal(raced.filter(result => result.response.status === 201).length, 1);
  for (const result of raced) assert.ok([201, 403, 409].includes(result.response.status));
  for (const table of ["users", "sessions", "registration_invite_redemptions"]) assert.equal(await count(table), 1, "concurrent redemption creates exactly one complete account");

  for (const target of ["users", "sessions"]) {
    await reset();
    invitation = await mint("failure@example.test");
    await db.prepare(`CREATE TRIGGER injected_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT, 'INJECTED_STORAGE_FAILURE'); END`).run();
    const result = await register("failure@example.test", invitation.code);
    assert.equal(result.response.status, 503, target);
    await noRegistration();
    await db.prepare("DROP TRIGGER injected_failure").run();
    assert.equal((await register("failure@example.test", invitation.code)).response.status, 201, "failed transaction did not burn invite");
  }
  await reset();
  invitation = await mint("duplicate@example.test");
  await db.prepare("INSERT INTO users VALUES ('existing-id', 'duplicate@example.test', 'fixture-hash', 0)").run();
  assert.equal((await register("duplicate@example.test", invitation.code)).response.status, 409);
  assert.equal(await count("registration_invite_redemptions"), 0);
  assert.equal(await count("sessions"), 0);
  await db.prepare("DELETE FROM users").run();
  assert.equal((await register("duplicate@example.test", invitation.code)).response.status, 201);

  for (const change of ["revocation", "expiry"]) {
    await reset();
    invitation = await mint("changed@example.test");
    const changingDb = { prepare: sql => db.prepare(sql), async batch(statements) {
      await db.prepare(change === "revocation" ? "UPDATE registration_invites SET revoked_at = ? WHERE token_hash = ?" : "UPDATE registration_invites SET expires_at = ? WHERE token_hash = ?")
        .bind(change === "expiry" ? Date.now() - 1000 : Date.now(), invitation.tokenHash).run();
      return db.batch(statements);
    } };
    const result = await register("changed@example.test", invitation.code, { ...env(), DB: changingDb });
    assert.equal(result.response.status, 403, "batch trigger rechecks " + change);
    await noRegistration();
  }
  await reset();
  invitation = await mint("no-trigger@example.test");
  await db.prepare("DROP TRIGGER registration_invite_validate_redemption").run();
  assert.equal((await register("no-trigger@example.test", invitation.code)).response.status, 403, "partial schema cannot bypass redemption guard");
  await noRegistration();
  await db.prepare("DROP TABLE registration_invite_redemptions").run();
  assert.equal((await register("no-trigger@example.test", invitation.code)).response.status, 503, "missing table fails closed");
  assert.equal(outbound, 0);
  console.log("single-use invitations: PASS (real D1 atomic registration/redemption/session, 8-way race, restart, email binding, expiry/revocation, partial schema, rollback and retry; zero network)");
} finally {
  globalThis.fetch = originalFetch;
  if (runtime) await runtime.dispose();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith("study-single-use-invites-"));
  await rm(root, { recursive: true, force: true });
}
