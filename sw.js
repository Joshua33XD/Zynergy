const CACHE_NAME = "zynergy-cache-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./workouts.html",
  "./nutrition.html",
  "./sleep.html",
  "./status.html",
  "./common.css",
  "./index.css",
  "./workouts.css",
  "./nutrition.css",
  "./sleep.css",
  "./status.css",
  "./script.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Cache-first for offline, but refresh cache in background so updates (like CSS theme changes) appear.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
