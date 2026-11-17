import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { authApi } from "./recall/auth.js";
import { grade } from "./recall/worker.js";

function oversizedRequest(path, method, bytes) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(bytes)); },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://recall.example" + path, {
    method,
    headers: { origin: "https://recall.example", "cf-connecting-ip": "198.51.100.218" },
    body,
    duplex: "half",
  });
  return { request, wasCancelled: () => cancelled };
}

test("invalid daily record fields do not touch Notion", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected Notion request"); };
  try {
    for (const payload of [{ hours: -1 }, { "心情": "unsupported-mood" }]) {
      const response = await worker.fetch(new Request("https://dashboard.example/api/record", {
        method: "POST",
        headers: { "x-app-key": "test-app-key", "content-type": "application/json" },
        body: JSON.stringify(payload),
      }), { APP_KEY: "test-app-key", NOTION_TOKEN: "dummy-token" });
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0, "invalid fields must not create a record");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown focus action is rejected without Notion reads", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected Notion request"); };
  try {
    const response = await worker.fetch(new Request("https://dashboard.example/api/focus", {
      method: "POST",
      headers: { "x-app-key": "test-app-key", "content-type": "application/json" },
      body: JSON.stringify({ action: "unsupported-action" }),
    }), { APP_KEY: "test-app-key", NOTION_TOKEN: "dummy-token" });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized login stream returns 413 without user-table access in memory-limiter mode", async () => {
  const oversized = oversizedRequest("/api/auth/login", "POST", 8_001);
  let queries = 0;
  const response = await authApi(oversized.request, {
    DB: { prepare() { queries++; throw new Error("unexpected DB access"); } },
  }, "/api/auth/login");
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { code: "REQUEST_TOO_LARGE" });
  assert.equal(oversized.wasCancelled(), true);
  assert.equal(queries, 0);
});

test("opt-in AI grading also rejects oversized streamed input without network", async () => {
  const oversized = oversizedRequest("/api/grade", "POST", 650_001);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected model request"); };
  try {
    const response = await grade(oversized.request, { AI_GRADING_ENABLED: "true" });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { code: "REQUEST_TOO_LARGE" });
    assert.equal(oversized.wasCancelled(), true);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("persistent login limiter counts an oversized attempt before 413", async () => {
  // Unlike the memory-limiter path above, the production persistent limiter
  // intentionally updates its D1 counter before reading the request body.
  const oversized = oversizedRequest("/api/auth/login", "POST", 8_001);
  let counterStatements = 0;
  let cleanupStatements = 0;
  const db = {
    prepare(sql) {
      if (sql.includes("INSERT INTO auth_attempt_windows")) {
        counterStatements++;
        return {
          bind() { return this; },
          async first() { return { attempts: 1, expires_at: Date.now() + 3_600_000 }; },
        };
      }
      if (sql.includes("DELETE FROM auth_attempt_windows")) {
        cleanupStatements++;
        return { bind() { return this; }, async run() { return { success: true }; } };
      }
      throw new Error("user-table access is not expected");
    },
  };
  const response = await authApi(oversized.request, {
    DB: db,
    AUTH_RATE_LIMIT_ENABLED: "true",
    AUTH_RATE_LIMIT_KEY: "test-only-in-memory-secret-not-for-production-1234",
  }, "/api/auth/login");
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { code: "REQUEST_TOO_LARGE" });
  assert.equal(oversized.wasCancelled(), true);
  assert.equal(counterStatements, 1);
  assert.equal(cleanupStatements, 1);
});
