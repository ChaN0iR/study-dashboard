const CACHE = "sd-v132";
const SHELL = ["icons/recall-hippocampus-256.png?v=hippocampus-1", "./", "index.html", "style.css?v=123", "task-policy.js?v=3", "app.js?v=119", "config.js?v=90", "recall-room.js?v=1", "recall-room.css?v=1", "manifest.webmanifest?v=stethoscope-1", "icons/icon.svg?v=stethoscope-1", "icons/icon-32.png?v=stethoscope-1", "icons/icon-180.png?v=stethoscope-1", "icons/icon-192.png?v=stethoscope-1", "icons/icon-512.png?v=stethoscope-1"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // never touch API calls
  e.respondWith(
    fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("index.html")))
  );
});
