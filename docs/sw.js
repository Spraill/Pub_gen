/* Offline support: cache the app shell and data; the page itself is network-first. */
const VERSION = "f9078b671a1d";
const CACHE = `pubgen-${VERSION}`;
const SHELL = [
  "./",
  "./index.html",
  `./styles.css?v=${VERSION}`,
  `./planner.js?v=${VERSION}`,
  `./app.js?v=${VERSION}`,
  `./config.js?v=${VERSION}`,
  "./fonts/fraunces-latin-700-normal.woff2",
  "./fonts/fraunces-latin-900-normal.woff2",
  `./vendor/leaflet/leaflet.js?v=${VERSION}`,
  `./vendor/leaflet/leaflet.css?v=${VERSION}`,
  `./vendor/markercluster/leaflet.markercluster.js?v=${VERSION}`,
  `./vendor/markercluster/MarkerCluster.css?v=${VERSION}`,
  `./data/cities.json?v=${VERSION}`,
  `./data/places-london.json?v=${VERSION}`,
  "./icon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("pubgen-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // tiles and routing go straight to the network

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && (url.search.includes("v=") || url.pathname.includes("/fonts/"))) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
