import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
const cacheName = source.match(/^const CACHE = "([^"]+)";$/m)?.[1];
assert.equal(cacheName, "sd-v138");

function harness() {
  const origin = "https://example.test";
  const scope = origin + "/study-dashboard/";
  const handlers = new Map();
  const stores = new Map();
  const calls = [];
  let online = true;
  let installResponse;
  let networkResponse = () => new Response("network body", {
    headers: { "cache-control": "public, max-age=3600" },
  });
  const key = (req) => new URL(typeof req === "string" ? req : req.url, scope).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async addAll(paths) {
          for (const path of paths) store.set(key(path), new Response("offline shell: " + path));
        },
        async match(req) { return store.get(key(req))?.clone(); },
        async put(req, resp) { store.set(key(req), resp.clone()); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    registration: { scope },
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting() {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(source, {
    self, caches, URL, Request, Response, Headers, location: { origin },
    fetch: async (request, options) => {
      calls.push({ url: request.url, options });
      if (!online) throw new Error("offline");
      if (request.credentials === "omit" && !installResponse) {
        return new Response("offline shell: " + request.url.slice(scope.length));
      }
      return (request.credentials === "omit" ? installResponse : networkResponse)(request);
    },
  });
  const request = (path, { mode = "cors", headers = {} } = {}) => ({
    url: new URL(path, scope).href,
    method: "GET",
    mode,
    headers: new Headers(headers),
  });
  async function event(name, req) {
    let completion;
    handlers.get(name)({
      request: req,
      waitUntil: (promise) => { completion = promise; },
      respondWith: (promise) => { completion = promise; },
    });
    return completion && await completion;
  }
  return {
    event, request, caches, calls,
    offline() { online = false; },
    response(fn) { networkResponse = fn; },
    installResponse(fn) { installResponse = fn; },
  };
}

test("cookie-bearing or private runtime GET is never cached, including browser HTTP cache", async () => {
  const sw = harness();
  await sw.event("install");
  const paths = ["/study-dashboard/private-cookie", "/study-dashboard/api/progress", "/api/state"];
  sw.response(() => new Response("synthetic confidential response", {
    headers: { "set-cookie": "sid=synthetic", "cache-control": "public, max-age=3600" },
  }));
  for (const path of paths) {
    assert.equal(await (await sw.event("fetch", sw.request(path))).text(),
      "synthetic confidential response");
    assert.equal(await (await sw.caches.open(cacheName)).match(sw.request(path)), undefined);
  }
  const runtimeCalls = sw.calls.filter((entry) => entry.options);
  assert.equal(runtimeCalls.length, paths.length);
  assert.ok(runtimeCalls.every((entry) => entry.options?.cache === "no-store"),
    "every same-origin runtime fetch must bypass browser HTTP cache");
  sw.offline();
  for (const path of paths) {
    const response = await sw.event("fetch", sw.request(path));
    assert.equal(response.type, "error", "private API/runtime response must be unavailable offline");
  }
});

test("offline fallback serves only explicit static shell and dashboard entry navigation", async () => {
  const sw = harness();
  await sw.event("install");
  sw.offline();
  const shell = await sw.event("fetch", sw.request("/study-dashboard/app.js?v=123"));
  assert.equal(await shell.text(), "offline shell: app.js?v=123");
  const navigation = await sw.event("fetch", sw.request("/study-dashboard/?demo=1", { mode: "navigate" }));
  assert.equal(await navigation.text(), "offline shell: index.html");
  const navHtml = await sw.event("fetch", sw.request("/study-dashboard/index.html?demo=1", { mode: "navigate" }));
  assert.equal(await navHtml.text(), "offline shell: index.html");
  for (const path of ["/study-dashboard/app.js?v=wrong", "/study-dashboard/custom.json", "/study-dashboard/recall/"]) {
    const mode = path.endsWith("/recall/") ? "navigate" : "cors";
    assert.equal((await sw.event("fetch", sw.request(path, { mode }))).type, "error", path);
  }
});

test("authenticated static requests never receive fallback from pre-cached shell", async () => {
  const sw = harness();
  await sw.event("install");
  sw.offline();
  for (const headers of [{ Authorization: "Bearer synthetic" }, { "X-App-Key": "secret" }, { Range: "bytes=0-10" }]) {
    assert.equal((await sw.event("fetch", sw.request("/study-dashboard/index.html", { headers }))).type, "error");
  }
});

test("stale dashboard cache is evicted, sibling caches are preserved and never used for fallback", async () => {
  const sw = harness();
  const stale = await sw.caches.open("sd-v136");
  await stale.put("/study-dashboard/private", new Response("old private body"));
  const sibling = await sw.caches.open("sibling-pwa-v1");
  await sibling.put("/study-dashboard/custom.json", new Response("foreign private body"));
  await sw.event("install");
  await sw.event("activate");
  const keys = await sw.caches.keys();
  assert.deepEqual(keys.sort(), [cacheName, "sibling-pwa-v1"].sort());
  sw.offline();
  assert.equal((await sw.event("fetch", sw.request("/study-dashboard/custom.json"))).type, "error");
  const owned = await sw.caches.open(cacheName);
  assert.equal(await owned.match("/study-dashboard/private"), undefined);
});

test("install requests omit credentials, bypass HTTP cache and reject redirects", async () => {
  const sw = harness();
  sw.installResponse((request) => {
    assert.equal(request.credentials, "omit");
    assert.equal(request.cache, "no-store");
    assert.equal(request.redirect, "error");
    return new Response("anonymous static shell");
  });
  await sw.event("install");
  assert.ok(sw.calls.length > 0);
});

test("unsafe install response rejects the entire shell before any cache write", async () => {
  for (const options of [
    { headers: { "Cache-Control": "private, max-age=60" } },
    { headers: { "Cache-Control": "public, no-store" } },
    { headers: { Vary: "Accept-Encoding, *" } },
    { status: 404 }, { status: 206 },
  ]) {
    const sw = harness();
    sw.installResponse((request) => new Response("body",
      request.url.includes("app.js") ? options : {}));
    await assert.rejects(sw.event("install"), /Unsafe static shell response/);
    assert.deepEqual(await sw.caches.keys(), [], "no partial shell may be written");
  }
});
