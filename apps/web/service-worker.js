/*
 * Service worker for the installed app (desktop and phone). `VERSION` and
 * `PRECACHE` (every file of the build) are put in front of this file at build
 * time by vite.config.ts.
 *
 *  - The app's screens open without a network: the page is network-first with
 *    the last copy as fallback, built files (hashed, never change) cache-first.
 *  - Business data is never cached here: /api always goes to the server.
 *  - A new version installs in the background and takes over only when the
 *    user chooses "Reload" (or all windows were closed), so a half-typed
 *    invoice is never lost to an update.
 */
/* global VERSION, PRECACHE */
const CACHE = `vyapaar-${VERSION}`;
const FONTS = "vyapaar-fonts";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.open(CACHE).then((cache) => cache.match("/")).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com") {
    event.respondWith(
      caches.open(FONTS).then(async (cache) => {
        const hit = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok || response.type === "opaque") void cache.put(request, response.clone());
            return response;
          })
          .catch(() => hit ?? Response.error());
        return hit ?? network;
      }),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
  }
});
