const CACHE_NAME = "hermes-control-clean-shell-v2";
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

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event.data);
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: payload.icon || "/assets/pwa-clean-icon-192.png",
    badge: payload.badge || "/assets/pwa-clean-icon-192.png",
    data: payload.data || { url: "/" },
    renotify: false
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(openOrFocus(target));
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

function readPushPayload(data) {
  try {
    const parsed = data?.json();
    return {
      title: String(parsed?.title || "Hermes Control").slice(0, 80),
      body: String(parsed?.body || "Task update available.").slice(0, 160),
      tag: String(parsed?.tag || "hermes-control-task").slice(0, 120),
      icon: parsed?.icon,
      badge: parsed?.badge,
      data: parsed?.data
    };
  } catch {
    return {
      title: "Hermes Control",
      body: "Task update available.",
      tag: "hermes-control-task",
      data: { url: "/" }
    };
  }
}

async function openOrFocus(target) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = windows.find((item) => new URL(item.url).origin === self.location.origin);
  if (client) {
    if ("navigate" in client) await client.navigate(target);
    return await client.focus();
  }
  return await self.clients.openWindow(target);
}
