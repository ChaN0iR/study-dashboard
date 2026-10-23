const CACHE = "sd-v137";
const SHELL = ["icons/recall-hippocampus-256.png?v=hippocampus-1", "./", "index.html", "style.css?v=124", "task-policy.js?v=3", "app.js?v=121", "config.js?v=90", "recall-room.js?v=1", "recall-room.css?v=1", "manifest.webmanifest?v=stethoscope-1", "icons/icon.svg?v=stethoscope-1", "icons/icon-32.png?v=stethoscope-1", "icons/icon-180.png?v=stethoscope-1", "icons/icon-192.png?v=stethoscope-1", "icons/icon-512.png?v=stethoscope-1"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  // Controlled pages may fetch same-origin APIs outside the SW's own path.
  // Only GET requests for the pre-cached shell may use offline responses.
  if (e.request.method !== "GET" || u.origin !== location.origin ||
      /(?:^|\/)api(?:\/|$)/.test(u.pathname) ||
      e.request.headers.has("authorization")) return;
  e.respondWith((async () => {
    try {
      // Set-Cookie is a forbidden response header and is hidden from service
      // workers. Never persist runtime network responses; install pre-caches the
      // explicit static shell, which is the complete offline asset allowlist.
      // Bypass the browser HTTP cache too: Set-Cookie is hidden from workers,
      // and an uncacheable response may otherwise remain available offline.
      return await fetch(e.request, { cache: "no-store" });
    } catch {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      if (e.request.mode === "navigate") return (await caches.match("index.html")) || Response.error();
      return Response.error();
    }
  })());
});
