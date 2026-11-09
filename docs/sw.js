const CACHE = "sd-v139";
const SHELL = ["icons/recall-hippocampus-256.png?v=hippocampus-1", "./", "index.html", "style.css?v=124", "task-policy.js?v=3", "app.js?v=124", "ui-live-v2.js", "ui-live-v2.css?v=1", "config.js?v=90", "recall-room.js?v=1", "recall-room.css?v=1", "manifest.webmanifest?v=stethoscope-1", "icons/icon.svg?v=stethoscope-1", "icons/icon-32.png?v=stethoscope-1", "icons/icon-180.png?v=stethoscope-1", "icons/icon-192.png?v=stethoscope-1", "icons/icon-512.png?v=stethoscope-1"];
// The static shell is the only intentionally persisted response set.
// Version rotation evicts responses cached by older, broad same-origin handlers.
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    // Fetch anonymously from the network; hidden Set-Cookie cannot be inspected.
    // Validate the complete set before persisting any response.
    const entries = await Promise.all(SHELL.map(async (entry) => {
      const request = new Request(new URL(entry, self.registration.scope), {
        credentials: "omit", cache: "no-store", redirect: "error",
      });
      const response = await fetch(request);
      const policy = response.headers.get("cache-control") || "";
      if (response.status !== 200 || response.type === "opaque" || response.redirected ||
          /(?:^|,)\s*(?:private|no-store)(?:\s|=|,|$)/i.test(policy) ||
          (response.headers.get("vary") || "").split(",").some((v) => v.trim() === "*")) {
        throw new Error("Unsafe static shell response");
      }
      return [request, response];
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(entries.map(([request, response]) => cache.put(request, response)));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  // This PWA may share github.io with other apps. Never remove their caches.
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => /^sd-v\d+$/.test(key) && key !== CACHE)
      .map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const request = e.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;

  const scope = self.registration.scope;
  const isShell = SHELL.some((entry) => new URL(entry, scope).href === url.href);
  const isDashboardNavigation = request.mode === "navigate" && (
    url.pathname === new URL("./", scope).pathname ||
    url.pathname === new URL("index.html", scope).pathname
  );
  const sensitive = ["authorization", "x-app-key", "range"].some(
    (header) => request.headers.has(header)
  );

  e.respondWith((async () => {
    try {
      // Set-Cookie is hidden from service workers. Runtime responses must not
      // enter CacheStorage *or* the browser HTTP cache, regardless of headers.
      return await fetch(request, { cache: "no-store" });
    } catch {
      if (sensitive || (!isShell && !isDashboardNavigation)) return Response.error();
      // Never search all origin caches: other apps can share CacheStorage.
      const cache = await caches.open(CACHE);
      if (isShell) {
        const cached = await cache.match(request);
        if (cached) return cached;
      }
      if (isDashboardNavigation) return (await cache.match("index.html")) || Response.error();
      return Response.error();
    }
  })());
});
