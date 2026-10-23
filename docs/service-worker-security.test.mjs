import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
const origin = "https://example.test";

function setup(network) {
  const listeners = new Map();
  const entries = new Map();
  let fetchCount = 0;
  const fetchOptions = [];
  const scope = `${origin}/study-dashboard/`;
  const key = req => new URL(typeof req === "string" ? req : req.url, scope).href;
  const caches = {
    async open(name) {
      if (!entries.has(name)) entries.set(name, new Map());
      const store = entries.get(name);
      return {
        async addAll(keys) { for (const k of keys) store.set(key(k), new Response("offline shell: " + k)); },
        async put(req, resp) { store.set(key(req), resp.clone()); },
      };
    },
    async match(req) {
      for (const store of entries.values()) {
        const found = store.get(key(req));
        if (found) return found.clone();
      }
      return undefined;
    },
    async keys() { return [...entries.keys()]; },
    async delete(name) { return entries.delete(name); },
  };
  const self = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    skipWaiting() {},
    clients: { claim() {} },
    registration: { scope },
  };
  runInNewContext(script, {
    URL, Response, caches, self, location: { origin },
    fetch: async (req, options) => { fetchCount++; fetchOptions.push(options); return network(req, options); },
  });
  async function event(name, request) {
    let promise;
    let response;
    listeners.get(name)({
      request,
      waitUntil(p) { promise = p; },
      respondWith(p) { response = p; },
    });
    if (promise) await promise;
    return response;
  }
  return { caches, event, fetchOptions, get fetchCount() { return fetchCount; } };
}

const req = (path, options = {}) => ({
  url: new URL(path, origin).href,
  method: options.method ?? "GET",
  mode: options.mode ?? "cors",
  headers: new Headers(options.headers ?? {}),
});

test("API requests, including nested same-origin API paths, bypass SW entirely", async () => {
  const sw = setup(async () => new Response('{"private":"secret"}', { headers: { "content-type": "application/json" } }));
  await sw.event("install");
  for (const path of ["/api/progress", "/api/auth/me", "/study-dashboard/api/state", "/study-dashboard/recall/api/grade"]) {
    assert.equal(await sw.event("fetch", req(path)), undefined, path);
  }
  assert.equal(await sw.caches.match(req("/api/progress")), undefined);
  assert.equal(sw.fetchCount, 0);
  assert.ok(await sw.event("fetch", req("/apiary")), "unrelated path remains fetchable");
});

test("a cookie response with browser-filtered headers never becomes an offline response", async () => {
  let offline = false;
  // A browser exposes no Set-Cookie header on this network response.
  const sw = setup(async () => {
    if (offline) throw Error("offline");
    return new Response("private cookie body");
  });
  await sw.event("install");
  assert.equal(await (await sw.event("fetch", req("/study-dashboard/cookie"))).text(), "private cookie body");
  assert.equal(await sw.caches.match(req("/study-dashboard/cookie")), undefined);
  offline = true;
  assert.equal((await sw.event("fetch", req("/study-dashboard/cookie"))).type, "error");
});

test("runtime responses are never cached, even when Set-Cookie is hidden by Fetch", async () => {
  const responses = [
    new Response("static asset", { status: 200, headers: { "cache-control": "public, max-age=3600" } }),
    new Response("private JSON", { headers: { "cache-control": "private, max-age=3600" } }),
    new Response("secret", { headers: { "cache-control": "no-store" } }),
    new Response("server failure", { status: 503 }),
    (() => {
      const response = new Response("cookie-authenticated private body", { headers: { "set-cookie": "token=secret" } });
      const headers = response.headers;
      Object.defineProperty(response, "headers", { value: {
        get: name => name.toLowerCase() === "set-cookie" ? null : headers.get(name),
        has: name => name.toLowerCase() === "set-cookie" ? false : headers.has(name),
      } });
      return response;
    })(),
  ];
  let next = 0;
  const sw = setup(async () => responses[next++]);
  await sw.event("install");
  for (const path of ["/study-dashboard/app.js?v=121", "/study-dashboard/private", "/study-dashboard/session", "/study-dashboard/failure", "/study-dashboard/cookie"]) {
    await (await sw.event("fetch", req(path)));
  }
  assert.equal(await (await sw.caches.match(req("/study-dashboard/app.js?v=121"))).text(), "offline shell: app.js?v=121");
  assert.ok(sw.fetchOptions.every(options => options?.cache === "no-store"), "network requests bypass the browser HTTP cache");
  for (const path of ["/study-dashboard/private", "/study-dashboard/session", "/study-dashboard/failure", "/study-dashboard/cookie"]) {
    assert.equal(await sw.caches.match(req(path)), undefined, path);
  }
  assert.equal(await sw.event("fetch", req("/study-dashboard/profile", { headers: { authorization: "Bearer secret" } })), undefined);
  assert.equal(sw.fetchCount, 5);
});

test("offline fallback applies only to navigation, not API or non-navigation fetches", async () => {
  const sw = setup(async () => { throw Error("offline"); });
  await sw.event("install");
  const navigation = await sw.event("fetch", req("/study-dashboard/deep-link", { mode: "navigate" }));
  assert.match(await navigation.text(), /offline shell: index.html/);
  const asset = await sw.event("fetch", req("/study-dashboard/image.png"));
  assert.equal(asset.type, "error");
  assert.equal(await sw.event("fetch", req("/study-dashboard/api/progress", { mode: "navigate" })), undefined);
});

test("activation evicts previous PWA cache version and stale responses", async () => {
  const sw = setup(async () => new Response("ok"));
  const old = await sw.caches.open("sd-v136");
  await old.put("stale-api-response", new Response("private stale"));
  await sw.event("install");
  await sw.event("activate");
  assert.deepEqual(await sw.caches.keys(), ["sd-v137"]);
  assert.equal(await sw.caches.match("stale-api-response"), undefined);
});
