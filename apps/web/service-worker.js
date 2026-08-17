const CACHE_NAME = "hermes-control-clean-shell-v1";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/manifest-clean.webmanifest",
  "/assets/codex-logo.svg",
  "/assets/hermes-logo.png",
  "/assets/pwa-icon.svg",
  "/assets/pwa-icon-180.png",
  "/assets/pwa-icon-192.png",
  "/assets/pwa-icon-512.png",
  "/assets/pwa-clean-icon-180.png",
  "/assets/pwa-clean-icon-192.png",
  "/assets/pwa-clean-icon-512.png",
  "/assets/pwa-clean-icon-1024.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/events") return;

  if (isShellAsset(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match("/index.html"));
    })
  );
});

function isShellAsset(pathname) {
  return pathname === "/"
    || pathname.endsWith(".html")
    || pathname.endsWith(".js")
    || pathname.endsWith(".css")
    || pathname.endsWith(".webmanifest")
    || pathname.endsWith("service-worker.js");
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
    return response;
  } catch {
    return await caches.match(request) || await caches.match("/index.html");
  }
}
