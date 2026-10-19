import assert from "node:assert/strict";
import worker from "./index.js";

// All external calls are stubbed; no Notion, Cloudflare, or model service is contacted.
const originalFetch = globalThis.fetch;
const calls = [];
const env = { APP_KEY: "offline-test-key", NOTION_TOKEN: "offline-token" };
const request = (payload) => new Request("https://local.example/api/note", {
  method: "POST",
  headers: { "x-app-key": env.APP_KEY, "content-type": "application/json" },
  body: JSON.stringify(payload),
});

try {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const pathname = new URL(url).pathname;
    const id = pathname.endsWith("/file_uploads") ? "upload-offline" : "page-offline";
    return new Response(JSON.stringify({ id }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // The second picture must be rejected before creating the note or even
  // reserving an upload for the first (valid) picture.
  const invalid = await worker.fetch(request({
    title: "offline note",
    photos: [
      { type: "image/png", data: "iVBORw0KGgo=" },
      { type: "image/png", data: "not-valid%%" },
    ],
  }), env);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid image data" });
  assert.deepEqual(calls, [], "malformed photo must not cause partial writes");

  const nullPhoto = await worker.fetch(request({
    title: "null upload",
    photos: [null],
  }), env);
  assert.equal(nullPhoto.status, 400);
  assert.deepEqual(await nullPhoto.json(), { error: "invalid image data" });
  assert.deepEqual(calls, [], "null photo must not create a note");

  // A note without pictures still creates exactly one Notion page.
  const empty = await worker.fetch(request({ title: "without image" }), env);
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).photos, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/v1\/pages$/);

  // A valid base64 upload still follows the existing page/upload/block flow.
  calls.length = 0;
  const valid = await worker.fetch(request({
    title: "with image",
    photos: [{ type: "image/png", data: "iVBORw0KGgo=" }],
  }), env);
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).photos, 1);
  assert.equal(calls.length, 4);
  assert.match(calls[0], /\/v1\/pages$/);
  assert.match(calls[1], /\/v1\/file_uploads$/);
  assert.match(calls[2], /\/v1\/file_uploads\/upload-offline\/send$/);
  assert.match(calls[3], /\/v1\/blocks\/page-offline\/children$/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Offline note image pre-validation tests passed");
