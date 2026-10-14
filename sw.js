// Offline cache: after the first visit the whole app works with no internet.
const CACHE = "prepress-v3";
const FILES = [
  "./", "index.html", "app.js", "pdfcore.js", "tiff.js", "content.js", "barcode.js", "preflight.js", "bwip-js.mjs", "bwipp.mjs", "engine-worker.js", "seps-worker.js",
  "mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm", "gs.mjs", "gs.js", "browser.js", "gs.wasm",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
