import {readFile} from "node:fs/promises";
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
const servedHtml = (await response.text()).replace(/\r\n/g, "\n");
assert.match(servedHtml, /← 回儀表板/);
const workerHtml = (await readFile(new URL("./recall/public/index.html", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const pagesHtml = (await readFile(new URL("../docs/recall/index.html", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
assert.equal(servedHtml, workerHtml, "generated Worker HTML matches its source");
assert.equal(pagesHtml, workerHtml, "Pages and Worker Recall Room stay identical");
const headerImage = /<img class="brand-mark" src="https:\/\/chan0ir\.github\.io\/study-dashboard\/icons\/recall-hippocampus-256\.png\?v=hippocampus-1" width="36" height="36" alt="" aria-hidden="true">/;
for (const html of [servedHtml, pagesHtml]) {
  assert.match(html, headerImage, "header reuses the existing 256px PNG");
  assert.match(html, /\.brand-mark\{[^}]*object-fit:contain;flex-shrink:0\}/);
  assert.doesNotMatch(html, /class="avatar"|\.avatar\{|>學<|recall-hippocampus-1920/);
  for (const id of ["rrAuthGate", "rrAuthForm", "rrEmail", "rrPassword", "rrPasswordConfirm", "rrAuthSubmit", "rrSyncStatus", "rrUserEmail", "rrLogoutBtn", "todayLabel"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} remains available`);
  }
  assert.match(html, /<input id="rrEmail"[^>]*type="email"[^>]*required/);
  assert.match(html, /<input id="rrPassword"[^>]*type="password"[^>]*required/);
  assert.match(html, /<script src="auth-ui\.js"><\/script>/);
}
const headerPng = await readFile(new URL("../docs/icons/recall-hippocampus-256.png", import.meta.url));
assert.equal(headerPng.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(headerPng.readUInt32BE(16), 256);
assert.equal(headerPng.readUInt32BE(20), 256);

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

assert.match(await readFile(new URL("./recall/auth.js", import.meta.url), "utf8"), /PASSWORD_ITERATIONS = 100_000/);
