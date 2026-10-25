import assert from "node:assert/strict";
import worker from "./index.js";

// All Notion calls are intercepted. No credentials, production data, or live
// requests are used by this test.
const originalFetch = globalThis.fetch;
const calls = [];
let uploadNumber = 0;
let failAtSend = null;
let failPageCreate = false;
const env = { APP_KEY: "test-key", NOTION_TOKEN: "fake-token" };
const validBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
const photo = (data = validBase64) => ({ name: "photo.png", type: "image/png", data });

function noteRequest(value) {
  return new Request("https://example.test/api/note", {
    method: "POST",
    headers: { "x-app-key": env.APP_KEY, "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
function reset() {
  calls.length = 0;
  uploadNumber = 0;
  failAtSend = null;
  failPageCreate = false;
}
async function send(value) {
  const response = await worker.fetch(noteRequest(value), env);
  return { response, body: await response.json() };
}

try {
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method || "GET";
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });

    if (path === "/v1/file_uploads" && method === "POST") {
      uploadNumber++;
      return Response.json({ id: "upload-" + uploadNumber });
    }
    const sendMatch = path.match(/^\/v1\/file_uploads\/(upload-\d+)\/send$/);
    if (sendMatch && method === "POST") {
      if (Number(sendMatch[1].slice(7)) === failAtSend)
        return Response.json({ message: "private upload failure" }, { status: 503 });
      assert.ok(init.body instanceof FormData, "send must transfer multipart image bytes");
      return Response.json({ status: "uploaded" });
    }
    if (path === "/v1/pages" && method === "POST") {
      if (failPageCreate) return Response.json({ message: "private Notion failure" }, { status: 503 });
      return Response.json({ id: "note-id" });
    }
    throw new Error("Unexpected Notion endpoint: " + method + " " + path);
  };

  // Malformed later images must never reserve an upload or create a note.
  for (const payload of [
    { title: "bad later photo", pages: [{ photos: [photo()] }, { photos: [photo("invalid%%")] }] },
    { title: "null photo", photos: [null] },
    { title: "empty photo", photos: [photo("")] },
    { title: "invalid mime", photos: [{ type: "image/svg+xml", data: validBase64 }] },
    { title: "invalid page", pages: [null] },
    { title: "invalid photos", pages: [{ photos: "not an array" }] },
    { title: "too many", photos: Array.from({ length: 9 }, () => photo()) },
  ]) {
    reset();
    const { response } = await send(payload);
    assert.equal(response.status, 400, payload.title);
    assert.deepEqual(calls, [], payload.title + " must have no Notion side effects");
  }

  reset();
  const big = await send({ title: "large image", photos: [photo("A".repeat(4_000_001))] });
  assert.equal(big.response.status, 413);
  assert.deepEqual(calls, [], "oversized photo must not reserve uploads");

  reset();
  const text = await send({ title: "text only", subject: "化學" });
  assert.equal(text.response.status, 200);
  assert.deepEqual(text.body, { id: "note-id", title: "text only", photos: 0 });
  assert.deepEqual(calls.map((x) => x.path), ["/v1/pages"]);
  assert.equal(calls[0].body.children, undefined, "text-only page should not gain empty blocks");

  reset();
  const success = await send({ title: "two pages", pages: [{ photos: [photo()] }, { photos: [photo()] }] });
  assert.equal(success.response.status, 200);
  assert.deepEqual(success.body, { id: "note-id", title: "two pages", photos: 2 });
  assert.deepEqual(calls.map((x) => x.path), [
    "/v1/file_uploads", "/v1/file_uploads/upload-1/send",
    "/v1/file_uploads", "/v1/file_uploads/upload-2/send",
    "/v1/pages",
  ], "all uploads must finish before a single atomic page create");
  const blocks = calls[4].body.children;
  assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "image", "paragraph", "image"]);
  assert.equal(blocks[0].paragraph.rich_text[0].text.content, "第 1 頁");
  assert.equal(blocks[1].image.file_upload.id, "upload-1");
  assert.equal(blocks[2].paragraph.rich_text[0].text.content, "第 2 頁");
  assert.equal(blocks[3].image.file_upload.id, "upload-2");
  assert.equal(calls.some((c) => /\/blocks\//.test(c.path)), false,
    "no second append request may leave an empty page");

  reset();
  failAtSend = 2;
  const uploadFailure = await send({ title: "second upload fails", photos: [photo(), photo()] });
  assert.equal(uploadFailure.response.status, 502);
  assert.deepEqual(uploadFailure.body, { error: "internal server error" });
  assert.equal(calls.some((c) => c.path === "/v1/pages"), false,
    "failed second upload must never leave a note page");

  reset();
  failPageCreate = true;
  const pageFailure = await send({ title: "page creation fails", photos: [photo()] });
  assert.equal(pageFailure.response.status, 502);
  assert.deepEqual(pageFailure.body, { error: "internal server error" });
  assert.deepEqual(calls.map((x) => x.path), [
    "/v1/file_uploads", "/v1/file_uploads/upload-1/send", "/v1/pages",
  ], "page creation must remain one non-retried request, without append");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("note preflight and create-with-children mocked tests passed");
