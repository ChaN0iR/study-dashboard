import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { authRateLimited } from "./recall/auth-rate-limit.js";
import { authApi } from "./recall/auth.js";

const root = await mkdtemp(path.join(tmpdir(), "study-auth-limits-"));
const bundle = path.join(root, "auth.mjs");
await build({ stdin: { contents: `import { authApi } from ${JSON.stringify(fileURLToPath(new URL("./recall/auth.js", import.meta.url)))};
export default {fetch(request, env) { return authApi(request, env, new URL(request.url).pathname); }};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)) }, bundle: true, format: "esm", outfile: bundle });
const key = "offline-auth-rate-key-not-for-production-32";
const invite = "offline-invite-for-runtime";
let outbound = 0;
const options = {
  rootPath: root, name: "auth-limits-local", scriptPath: bundle, modules: true, compatibilityDate: "2026-01-01",
  d1Databases: { DB: "auth-limits-offline-fixture" }, resourcePersistencePath: path.join(root, "storage"),
  bindings: { AUTH_RATE_LIMIT_KEY: key, REGISTRATION_INVITE_CODE: invite },
  outboundService: async () => { outbound++; throw new Error("external network forbidden"); },
};
const req = ip => new Request("https://offline.example/api/auth/login", { headers: ip ? { "cf-connecting-ip": ip } : {} });
const HOUR = 3600000;
let runtime;
try {
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  let db = await runtime.getD1Database("DB");
  for (const file of ["0001_auth_and_progress.sql", "0002_auth_attempt_windows.sql"]) {
    const sql = await readFile(new URL(`./recall/migrations/${file}`, import.meta.url), "utf8");
    for (const statement of sql.replace(/^--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  let env = { DB: db, AUTH_RATE_LIMIT_KEY: key, REGISTRATION_INVITE_CODE: invite };
  const other = await import("./recall/auth-rate-limit.js?independent-worker");
  const concurrent = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    (i % 2 ? authRateLimited : other.authRateLimited)(req("198.51.100.10"), env, 1000)));
  assert.equal(concurrent.filter(blocked => !blocked).length, 12, "atomic D1 update admits exactly twelve concurrent attempts");
  assert.equal(concurrent.filter(Boolean).length, 12);
  const stored = await db.prepare("SELECT * FROM auth_attempt_windows").first();
  assert.equal(stored.attempts, 13, "blocked counter saturates");
  assert.equal(stored.window_start, 1000);
  assert.equal(stored.expires_at, 1000 + HOUR);
  assert.match(stored.subject_digest, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes("198.51.100.10"), "raw IP is never stored");
  assert.equal(await authRateLimited(req("198.51.100.10"), env, 1000 + HOUR - 1), true);
  assert.equal((await db.prepare("SELECT expires_at FROM auth_attempt_windows WHERE subject_digest = ?").bind(stored.subject_digest).first()).expires_at, 1000 + HOUR, "rejected attempts do not extend lockout");
  assert.equal(await authRateLimited(req("198.51.100.11"), env, 2000), false, "another IP has independent budget");

  // Recreate workerd and reopen the actual on-disk D1 state, not a JS counter mock.
  await runtime.dispose();
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database("DB");
  env = { ...env, DB: db };
  assert.equal(await other.authRateLimited(req("198.51.100.10"), env, 1000 + HOUR - 1), true, "restart preserves exhausted window");
  assert.equal(await authRateLimited(req("198.51.100.10"), env, 1000 + HOUR), false, "window resets at exact expiry");

  // Exercise the real auth handler against the local D1 binding. This avoids
  // Miniflare's host proxy Origin restrictions without bypassing handler checks.
  const send = (route, ip) => authApi(new Request(`https://offline.example/api/auth/${route}`, {
    method: "POST", headers: { origin: "https://offline.example", "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ email: "invalid", password: "wrong-password", inviteCode: invite }),
  }), env, `/api/auth/${route}`);
  const statuses = [];
  for (let i = 0; i < 13; i++) statuses.push((await send(i % 2 ? "register" : "login", "198.51.100.20")).status);
  assert.deepEqual(statuses.slice(0, 12), Array.from({ length: 12 }, (_, i) => i % 2 ? 422 : 401));
  assert.equal(statuses[12], 429, "login/register share the same persistent budget");
  assert.equal((await send("login", "198.51.100.21")).status, 401);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM users").first()).n, 0);

  for (const value of [undefined, "", "short", 12345]) {
    for (const route of ["login", "register"]) {
      const response = await authApi(new Request(`https://offline.example/api/auth/${route}`, {
        method: "POST", headers: { origin: "https://offline.example" }, body: JSON.stringify({ email: "student@example.test", password: "valid-password", inviteCode: invite }),
      }), { DB: db, REGISTRATION_INVITE_CODE: invite, AUTH_RATE_LIMIT_KEY: value }, `/api/auth/${route}`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "AUTH_STORAGE_ERROR" });
      assert.equal(response.headers.get("set-cookie"), null);
    }
  }
  const missingDb = { prepare() { throw new Error("missing table or failed storage"); } };
  const failed = await authApi(new Request("https://offline.example/api/auth/login", { method: "POST", headers: { origin: "https://offline.example" }, body: "{}" }), { DB: missingDb, AUTH_RATE_LIMIT_KEY: key }, "/api/auth/login");
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("set-cookie"), null);
  const cleanupFailureDb = { prepare(sql) {
    if (/DELETE FROM auth_attempt_windows/.test(sql)) throw new Error("simulated cleanup failure");
    return db.prepare(sql);
  } };
  const cleanupFailure = await authApi(new Request("https://offline.example/api/auth/login", {
    method: "POST", headers: { origin: "https://offline.example", "cf-connecting-ip": "198.51.100.99" }, body: "{}",
  }), { ...env, DB: cleanupFailureDb }, "/api/auth/login");
  assert.equal(cleanupFailure.status, 503, "cleanup storage errors also fail closed");

  await db.prepare("DELETE FROM auth_attempt_windows").run();
  // Bounded cleanup must leave active rows untouched and remove at most 100 expired rows.
  await db.batch(Array.from({ length: 105 }, (_, i) => db.prepare("INSERT INTO auth_attempt_windows VALUES (?, 0, 1, 1)").bind(i.toString(16).padStart(64, "0"))));
  assert.equal(await authRateLimited(req("198.51.100.30"), env, 5000), false);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM auth_attempt_windows WHERE expires_at <= 5000").first()).n, 5);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM auth_attempt_windows WHERE expires_at > 5000").first()).n, 1);
  assert.equal(await authRateLimited(req(), env, 5000), false, "missing IP has a shared conservative budget");
  assert.equal(await other.authRateLimited(req(), env, 5000), false);
  await db.prepare("DROP TABLE auth_attempt_windows").run();
  const missingTable = await authApi(new Request("https://offline.example/api/auth/login", { method: "POST", headers: { origin: "https://offline.example" }, body: "{}" }), env, "/api/auth/login");
  assert.equal(missingTable.status, 503, "missing actual D1 migration fails closed");
  assert.deepEqual(await missingTable.json(), { code: "AUTH_STORAGE_ERROR" });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n, 0);
  assert.equal(outbound, 0);
  console.log("persistent auth limits: PASS (real local D1 concurrency, independent handlers, restart, expiry, route sharing, failure closure, bounded cleanup; zero network)");
} finally {
  if (runtime) await runtime.dispose();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith("study-auth-limits-"), "delete only this test-owned temp directory");
  await rm(root, { recursive: true, force: true });
}
