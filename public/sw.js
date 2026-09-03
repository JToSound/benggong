// 《病港》— Service worker：離線快取（master prompt §10.6）
// 策略：
//   - app shell + 資料檔 → cache-first（版本化 bucket，build hash 即變）
//   - 導航請求 → network falling back to cached shell
//   - 零外部請求：只處理同源；任何 cross-origin 直接放行唔快取

const CACHE = "binggang-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["./", "./index.html"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 外部請求：唔理（本來就應該零）

  // 導航：network-first，offline fallback 到 shell
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return resp;
        })
        .catch(() => caches.match(event.request).then((r) => r ?? caches.match("./index.html"))),
    );
    return;
  }

  // 其餘同源資源（assets/資料檔）：cache-first
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ??
        fetch(event.request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return resp;
        }),
    ),
  );
});
