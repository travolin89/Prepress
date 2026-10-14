// Offline support with reliable updates.
// - App code (HTML/JS): network first, so a new upload is picked up on the next
//   launch; the cached copy is used only when offline.
// - Engines (large WebAssembly files): cache first; they only change with a
//   new VERSION, which re-downloads everything.
// - Installs bypass the browser's HTTP cache so a new version never stores stale files.
const VERSION = "prepress-v4";
const SHELL = [
  "./", "index.html", "app.js", "pdfcore.js", "tiff.js", "content.js", "barcode.js", "preflight.js",
  "engine-worker.js", "seps-worker.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
];
const ENGINES = ["mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm", "gs.mjs", "gs.js", "browser.js", "gs.wasm", "bwip-js.mjs", "bwipp.mjs"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll([...SHELL, ...ENGINES].map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const file = url.pathname.split("/").pop();
  if (ENGINES.includes(file)) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith((async () => {
    try {
      const fresh = await fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }));
      if (fresh.ok) { const c = await caches.open(VERSION); c.put(req.url, fresh.clone()); }
      return fresh;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? caches.match("index.html") : Response.error());
    }
  })());
});
