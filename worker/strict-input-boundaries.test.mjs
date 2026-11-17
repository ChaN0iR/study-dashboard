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

test("oversized login stream returns 413 and cancels before DB access", async () => {
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
