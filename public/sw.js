// 《病港》— Service worker：離線快取（master prompt §10.6）
//
// 策略（按資源性質分三類，唔可以一刀切）
// ========================================
//
// 1. **App shell**（HTML、hash 過嘅 JS/CSS）→ cache-first
//    檔名帶 build hash，內容一變檔名就變，所以 cache-first 安全。
//
// 2. **資料檔**（`data/public/*.json`、`*.geojson`）→ **stale-while-revalidate**
//    ⚠️ 原本用 cache-first —— 呢個係「舊資料」問題嘅根源：用戶重新
//    build 之後，SW 仍然派舊快取，睇唔到新資料。實測 Phase J 期間
//    好幾次「改咗但睇唔到」都同呢類快取有關。
//    改為：即刻派快取（快），同時背景 fetch 更新，下次就係新嘅。
//
// 3. **底圖 PNG**（大，2–3 MB）→ cache-first + **版本化失效**
//    SWR 會令每次瀏覽都背景重下 3 MB，太重。改為 cache-first，但
//    監視 `asset-manifest.json`（細檔，SWR）：一旦內容變（代表重新
//    build 過），就清空圖片快取。
//
// 零外部請求：只處理同源；任何 cross-origin 直接放行唔快取。

const SHELL_CACHE = "binggang-shell-v1";
const DATA_CACHE = "binggang-data-v1";
const IMG_CACHE = "binggang-img-v1";
const ALL_CACHES = [SHELL_CACHE, DATA_CACHE, IMG_CACHE];

/** 上次見到嘅 asset-manifest 內容（用嚟偵測 rebuild）。 */
let lastManifest = null;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(["./", "./index.html"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** 判斷請求屬於邊一類。 */
function classify(url) {
  const p = url.pathname;
  if (/\/data\/public\/.*\.(json|geojson)$/.test(p)) return "data";
  if (/\.(png|jpg|jpeg|webp)$/.test(p)) return "image";
  return "other";
}

/** stale-while-revalidate：即刻派快取，背景更新。 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      if (resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => null);
  return cached ?? (await network) ?? Response.error();
}

/**
 * 監視 asset-manifest：內容一變就清空圖片快取。
 *
 * 為何用 manifest 而唔係自己計 hash：manifest 係 build 產物，內容包含
 * 各資料集嘅數量，一 rebuild 就會變。用佢做「build 世代」嘅代理指標
 * 唔需要額外工具鏈。
 */
async function watchManifest(request, cacheName) {
  const resp = await staleWhileRevalidate(request, cacheName);
  try {
    const text = await resp.clone().text();
    if (lastManifest !== null && lastManifest !== text) {
      await caches.delete(IMG_CACHE);
    }
    lastManifest = text;
  } catch {
    /* 讀唔到都唔緊要 */
  }
  return resp;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // 外部請求：唔理

  // 導航：network-first，offline fallback 到 shell
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy));
          return resp;
        })
        .catch(() =>
          caches.match(event.request).then((r) => r ?? caches.match("./index.html")),
        ),
    );
    return;
  }

  const kind = classify(url);

  if (kind === "data") {
    // 資料檔：SWR。manifest 額外做 rebuild 偵測。
    event.respondWith(
      url.pathname.endsWith("asset-manifest.json")
        ? watchManifest(event.request, DATA_CACHE)
        : staleWhileRevalidate(event.request, DATA_CACHE),
    );
    return;
  }

  // 圖片同其他：cache-first（圖片刻意唔用 SWR —— 2–3 MB 唔應該每次重下）
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ??
        fetch(event.request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(kind === "image" ? IMG_CACHE : SHELL_CACHE).then((c) =>
              c.put(event.request, copy),
            );
          }
          return resp;
        }),
    ),
  );
});
