const CACHE_NAME = "zynergy-cache-v1";
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
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
