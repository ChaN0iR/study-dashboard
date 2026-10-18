import assert from "node:assert/strict";
import worker from "./index.js";

const env = {
  DB: {
    prepare() { return { bind() { return this; }, async first() { return null; }, async run() { return {}; } }; },
  },
  GEMINI_API_KEY: "test-only-no-network",
  ALLOWED_ORIGIN: "https://chan0ir.github.io",
};

const redirect = await worker.fetch(new Request("https://dashboard.example/recall"), env);
assert.equal(redirect.status, 308);
assert.equal(redirect.headers.get("location"), "/recall/");

const response = await worker.fetch(new Request("https://dashboard.example/recall/"), env);
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type"), /^text\/html/);
assert.equal(response.headers.get("x-content-type-options"), "nosniff");
assert.equal(response.headers.get("cache-control"), "no-store");
assert.match(await response.text(), /← 回儀表板/);

const asset = await worker.fetch(new Request("https://dashboard.example/recall/auth-ui.js"), env);
assert.equal(asset.status, 200);
assert.match(asset.headers.get("content-type"), /^text\/javascript/);
assert.match(await asset.text(), /async function boot/);

const unknown = await worker.fetch(new Request("https://dashboard.example/recall/nope"), env);
assert.equal(unknown.status, 404);
const postAsset = await worker.fetch(new Request("https://dashboard.example/recall/", { method: "POST" }), env);
assert.equal(postAsset.status, 405);

const me = await worker.fetch(new Request("https://dashboard.example/api/auth/me"), env);
assert.equal(me.status, 200);
assert.deepEqual(await me.json(), { authenticated: false });
const progress = await worker.fetch(new Request("https://dashboard.example/api/progress"), env);
assert.equal(progress.status, 401);
assert.deepEqual(await progress.json(), { code: "UNAUTHORIZED" });

const noKey = await worker.fetch(new Request("https://dashboard.example/api/state", { headers: { origin: "https://chan0ir.github.io" } }), { ...env, APP_KEY: "expected" });
assert.equal(noKey.status, 401);
assert.equal(noKey.headers.get("access-control-allow-origin"), "https://chan0ir.github.io");
const wrongKey = await worker.fetch(new Request("https://dashboard.example/api/state", { headers: { "x-app-key": "wrong", origin: "https://chan0ir.github.io" } }), { ...env, APP_KEY: "expected" });
assert.equal(wrongKey.status, 401);
assert.equal(wrongKey.headers.get("access-control-allow-origin"), "https://chan0ir.github.io");
console.log("recall integration routes/security: ok");
