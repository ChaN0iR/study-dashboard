const CACHE = "sd-v136";
const SHELL = ["icons/recall-hippocampus-256.png?v=hippocampus-1", "./", "index.html", "style.css?v=124", "task-policy.js?v=3", "app.js?v=121", "config.js?v=90", "recall-room.js?v=1", "recall-room.css?v=1", "manifest.webmanifest?v=stethoscope-1", "icons/icon.svg?v=stethoscope-1", "icons/icon-32.png?v=stethoscope-1", "icons/icon-180.png?v=stethoscope-1", "icons/icon-192.png?v=stethoscope-1", "icons/icon-512.png?v=stethoscope-1"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  // Controlled pages may fetch same-origin APIs outside the SW's own path.
  // Never inspect, cache, or serve an offline HTML fallback for API responses.
  if (e.request.method !== "GET" || u.origin !== location.origin ||
      /(?:^|\/)api(?:\/|$)/.test(u.pathname) ||
      e.request.headers.has("authorization")) return;
  e.respondWith((async () => {
    try {
      const response = await fetch(e.request);
      const directive = response.headers.get("cache-control") || "";
      if (response.ok && !/(?:^|,)\s*(?:private|no-store)(?:\s*[,=]|$)/i.test(directive) &&
          !response.headers.has("set-cookie")) {
        try {
          const cache = await caches.open(CACHE);
          await cache.put(e.request, response.clone());
        } catch { /* Cache failure must not turn a successful network response into an offline error. */ }
      }
      return response;
    } catch {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      if (e.request.mode === "navigate") return (await caches.match("index.html")) || Response.error();
      return Response.error();
    }
  })());
});
