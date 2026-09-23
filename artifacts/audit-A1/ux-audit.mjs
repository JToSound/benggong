/**
 * A1 Product/UX Auditor —— 現行 production 版本只讀實測腳本。
 *
 * 只讀 production code；只寫 artifacts/audit-A1/。
 * 執行：node artifacts/audit-A1/ux-audit.mjs
 *
 * ⚠️ 必須用 localhost（vite preview 只綁 IPv6 [::1]）；Chromium 要
 *    --no-proxy-server（環境有 http_proxy）。
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A1";
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const report = { baseUrl: BASE, capturedAt: new Date().toISOString() };

/** 等到 app boot 完成（#topbar 出現）。 */
async function ready(page, ms = 40000) {
  await page.waitForSelector("#topbar", { timeout: ms });
  await page.waitForTimeout(1200);
}

/** 首屏資訊密度 / entry point 快照。 */
async function snapshot(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
    };
    const mapEl = q("#map-pane");
    const r = mapEl?.getBoundingClientRect();
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      title: document.title,
      h1: q("#topbar h1")?.textContent?.trim() ?? null,
      tagline: q("#topbar .tagline")?.textContent?.trim() ?? null,
      bodyInnerTextLen: (document.body.innerText || "").length,
      domNodeCount: document.querySelectorAll("*").length,
      navButtons: qa("#topbar .nav-btn").map((b) => ({
        id: b.id,
        text: (b.textContent || "").trim(),
        title: b.getAttribute("title"),
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
        emojiOnly: !/[\u4e00-\u9fffA-Za-z]/.test((b.textContent || "").trim()),
      })),
      // Journey A：4 個入口文案是否存在
      entryPointTexts: {
        探索地區: !!document.body.innerText.match(/探索地區|探索區域/),
        搵角色: !!document.body.innerText.match(/搵角色|找角色|角色/),
        搵事件: !!document.body.innerText.match(/搵事件|找事件|事件/),
        打開編年史: !!document.body.innerText.match(/打開編年史|編年史/),
      },
      // Spoiler 控制
      spoilerControl: {
        hasButtons: qa("[class*=spoiler] button, [id*=spoiler]").length,
        hasSelect: !!q("select[id*=spoil], select[class*=spoil]"),
        text: (document.body.innerText.match(/劇透[^\n]{0,20}/g) || []).slice(0, 5),
      },
      // 地圖區
      map: {
        rect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
        svgViewBox: q("#svg-map")?.getAttribute("viewBox") ?? null,
        hasCanvas: !!q("#basemap-canvas"),
        zoneCount: qa("#zones-layer .zone").length,
        zoneAreaCount: qa("#zones-layer .zone-area").length,
        routeCount: qa("#routes-layer .route-line").length,
        locationMarkerCount: qa("#locations-layer .location-marker, #locations-layer .location-marker-cluster").length,
        eventMarkerCount: qa("#events-layer .event-marker").length,
        legendVisible: vis(q("#map-legend")),
        legendRect: (() => {
          const el = q("#map-legend");
          if (!el) return null;
          const rr = el.getBoundingClientRect();
          return { w: Math.round(rr.width), h: Math.round(rr.height) };
        })(),
      },
      // 右側面板
      panel: {
        storyPaneHidden: q("#story-pane")?.classList.contains("is-collapsed") ?? null,
        storyPanelVisible: vis(q("#story-panel-mount")),
        zoneDossierVisible: vis(q("#zone-dossier-mount")),
        chronicleEntries: qa("#story-panel-mount .chr-entry").length,
        chroniclePeriodSections: qa("#story-panel-mount .chr-period").length,
        chronicleTimelineBars: qa("#story-panel-mount .chr-tl-bar").length,
        panelScrollHeight: q("#story-panel-mount")?.scrollHeight ?? null,
        panelClientHeight: q("#story-panel-mount")?.clientHeight ?? null,
        storyHeaderText: q("#story-panel-mount h2")?.textContent?.trim() ?? null,
      },
      chapterStrip: {
        pills: qa("#chapter-strip-mount .ch-pill").length,
        current: q("#strip-ch-num")?.textContent ?? null,
      },
      // 主 context 判斷：同一時間有幾多個「大標題」
      h2Count: qa("h2").filter(vis).length,
      h3Count: qa("h3").filter(vis).length,
      // 捲動容器
      scrollContainers: qa("#story-panel-mount *")
        .filter((el) => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== "visible")
        .length,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const consoleLog = [];

  // ============ 1. Desktop 首屏 ============
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-HK",
      timezoneId: "Asia/Hong_Kong",
    });
    const page = await ctx.newPage();
    page.on("console", (m) => consoleLog.push(`[desktop ${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => consoleLog.push(`[desktop pageerror] ${e}`));
    await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await ready(page);
    report.desktop = await snapshot(page);
    await page.screenshot({ path: path.join(SHOTS, "a1-desktop-default.png") });

    // ---- 第一個可見 zone 嘅屏幕尺寸 ----
    report.zoneGeometry = await page.evaluate(() => {
      const zones = [...document.querySelectorAll("#zones-layer .zone")];
      const svg = document.querySelector("#svg-map");
      const sr = svg?.getBoundingClientRect();
      return zones.map((z) => {
        const area = z.querySelector(".zone-area");
        const b = area?.getBoundingClientRect();
        const label = z.querySelector(".zone-label");
        return {
          id: z.getAttribute("data-zone-id"),
          name: z.getAttribute("data-zone-name"),
          cls: z.getAttribute("class"),
          screenW: b ? Math.round(b.width * 10) / 10 : null,
          screenH: b ? Math.round(b.height * 10) / 10 : null,
          pctOfMapW: b && sr ? Math.round((b.width / sr.width) * 1000) / 10 : null,
          hasLabel: !!label,
        };
      });
    });

    // ---- Journey A：3 秒內可發現性（首屏文字／可點元素）----
    report.journeyA = await page.evaluate(() => {
      const qa = (s) => [...document.querySelectorAll(s)];
      const clickable = qa("button, a, [role=button]").filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return {
        visibleClickables: clickable.length,
        // 首次入站有冇任何 onboarding / empty-context 提示
        hasOnboarding: /歡迎|第一次|開始探索|導覽|教學/.test(document.body.innerText),
        // 地圖以外嘅大面積文字（右側面板）
        panelTextLen: (document.querySelector("#story-panel-mount")?.innerText || "").length,
        mapPaneTextLen: (document.querySelector("#map-pane")?.innerText || "").length,
        headerTextLen: (document.querySelector("#topbar")?.innerText || "").length,
      };
    });

    // ---- Journey B：click 地圖上第一個 zone ----
    const zoneSel = "#zones-layer .zone .zone-area";
    const zoneCount = await page.locator(zoneSel).count();
    report.journeyB = { zoneElementsAtDefault: zoneCount };
    if (zoneCount > 0) {
      await page.locator(zoneSel).first().click({ force: true }).catch((e) => {
        report.journeyB.clickError = String(e);
      });
      await page.waitForTimeout(600);
      report.journeyB.afterClick = await page.evaluate(() => ({
        viewModeBtnText: document.querySelector("#btn-mode")?.textContent?.trim(),
        dossierVisible: !!document.querySelector("#zone-dossier-mount")?.innerText,
        dossierTitle: document.querySelector("#zone-dossier-mount h2")?.textContent?.trim() ?? null,
        hash: location.hash,
        dossierTextLen: (document.querySelector("#zone-dossier-mount")?.innerText || "").length,
      }));
      await page.screenshot({ path: path.join(SHOTS, "a1-desktop-zone-click.png") });
    }

    // ---- Journey C：搜尋角色 ----
    report.journeyC = await page.evaluate(async () => {
      // 直接讀 characters.json 攞第一個主要角色
      const r = await fetch("./data/public/characters.json");
      const cs = await r.json();
      const main = cs.find((c) => c.role === "protagonist") || cs.find((c) => c.role === "main") || cs[0];
      return { name: main?.name, role: main?.role, id: main?.id, count: cs.length };
    });
    // 開搜尋，打角色名
    await page.click("#btn-search");
    await page.waitForTimeout(300);
    const charName = report.journeyC.name;
    await page.fill("#search-input", charName);
    await page.waitForTimeout(400);
    report.journeyC.searchResults = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#search-results .search-result-item")];
      return {
        count: items.length,
        types: items.slice(0, 10).map((i) => i.querySelector(".result-type")?.textContent),
        first: items[0]?.innerText?.replace(/\n/g, " | "),
        hasCategoryTabs: !!document.querySelector("#search-modal .search-cats, #search-modal [role=tablist]"),
        keyboardNav: !!document.querySelector("#search-modal [aria-activedescendant]"),
      };
    });
    await page.screenshot({ path: path.join(SHOTS, "a1-desktop-search-char.png") });
    // click 第一個結果
    const firstRes = page.locator("#search-results .search-result-item").first();
    if (await firstRes.count()) {
      await firstRes.click();
      await page.waitForTimeout(900);
      report.journeyC.afterPickResult = await page.evaluate(() => ({
        modalClosed: !document.querySelector("#search-modal")?.classList.contains("open"),
        hash: location.hash,
        chapter: document.querySelector("#strip-ch-num")?.textContent,
        routeLines: document.querySelectorAll("#routes-layer .route-line").length,
        viewModeBtnText: document.querySelector("#btn-mode")?.textContent?.trim(),
        panelTextLen: (document.querySelector("#story-panel-mount")?.innerText || "").length,
      }));
    }
    await page.screenshot({ path: path.join(SHOTS, "a1-desktop-after-char-search.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ---- Journey C 補充：char-chip click（StoryPanel 內）----
    await page.evaluate(() => {
      // 切到 chapter 模式並去一個有角色嘅章節
      const btn = document.querySelector("#btn-mode");
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(500);
    report.journeyC.chapterMode = await page.evaluate(() => ({
      viewModeBtnText: document.querySelector("#btn-mode")?.textContent?.trim(),
      charChips: document.querySelectorAll("#story-panel-mount .char-chip").length,
      charChipHasHandler: null,
    }));
    await page.screenshot({ path: path.join(SHOTS, "a1-desktop-chapter-mode.png") });

    // ---- Journey D：搜尋分類 + fly-to ----
    await page.click("#btn-search");
    await page.waitForTimeout(200);
    await page.fill("#search-input", "將軍澳");
    await page.waitForTimeout(400);
    report.journeyD = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#search-results .search-result-item")];
      const types = {};
      items.forEach((i) => {
        const t = i.querySelector(".result-type")?.textContent || "?";
        types[t] = (types[t] || 0) + 1;
      });
      return { total: items.length, typeCounts: types };
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ---- Journey E：編年史 ----
    report.journeyE = await page.evaluate(() => {
      const root = document.querySelector("#story-panel-mount");
      const qa = (s) => [...(root?.querySelectorAll(s) || [])];
      return {
        entries: qa(".chr-entry").length,
        periods: qa(".chr-period").map((p) => p.getAttribute("data-period")),
        timelineBars: qa(".chr-tl-bar").length,
        filterControls: {
          hasPeriodFilter: !!root?.querySelector("[data-filter-period]"),
          hasZoneFilter: !!root?.querySelector("[data-filter-zone]"),
          hasCharacterFilter: !!root?.querySelector("[data-filter-char]"),
          hasTypeFilter: !!root?.querySelector("[data-filter-type]"),
          hasSpoilerFilter: !!root?.querySelector("[data-filter-spoiler]"),
        },
        exportButtons: qa(".chr-actions button").map((b) => b.textContent?.trim()),
        entryTextTotal: (root?.innerText || "").length,
        // virtualization 檢查：有冇固定高度 scroll container 只 render 一部分
        renderedVsTotal: null,
      };
    });
    // 讀 chronicle 總數對比 render 數
    report.journeyE.totalInDataset = await page.evaluate(async () => {
      const r = await fetch("./data/public/chronicle.json");
      const d = await r.json();
      return d.entries.length;
    });
    await page.screenshot({ path: path.join(SHOTS, "a1-desktop-chronicle.png") });

    // ---- 資訊層級：右側面板預設 render 幾多 card ----
    report.infoHierarchy = await page.evaluate(() => {
      const root = document.querySelector("#story-panel-mount");
      return {
        panelRenderedNodes: root?.querySelectorAll("*").length ?? 0,
        documentNodes: document.querySelectorAll("*").length,
        // 「一個主 context」檢查：同時有幾多個獨立資訊模組
        visibleModules: {
          map: !!document.querySelector("#map-pane"),
          legend: !!document.querySelector("#map-legend")?.getBoundingClientRect().width,
          chapterStrip: !!document.querySelector("#chapter-strip-mount")?.children.length,
          chronicle: !!root?.querySelector(".chronicle"),
          storyPanel: !!document.querySelector("#story-panel-mount .story-header"),
          zoneDossier: !!document.querySelector("#zone-dossier-mount")?.innerText,
        },
      };
    });

    await ctx.close();
  }

  // ============ 2. Router 深層連結（refresh persistence）============
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
    const page = await ctx.newPage();
    const cases = [
      { hash: "#ch=1&loc=loc_0001", label: "loc (支援)" },
      { hash: "#ch=1&zone=zone_51bf7d8190", label: "zone (spec 要求)" },
      { hash: "?event=ev_0001", label: "event (spec 要求)" },
      { hash: "?character=xxx", label: "character (spec 要求)" },
      { hash: "?spoiler=0", label: "spoiler (spec 要求)" },
      { hash: "?view=chronicle", label: "view (spec 要求)" },
    ];
    report.router = [];
    for (const c of cases) {
      await page.goto(BASE + c.hash, { waitUntil: "load", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
      await ready(page, 30000);
      const st = await page.evaluate(() => ({
        hash: location.hash,
        chapter: document.querySelector("#strip-ch-num")?.textContent,
        zoneDossier: !!document.querySelector("#zone-dossier-mount")?.innerText,
        selectedMarker: document.querySelectorAll("#locations-layer .location-marker[fill='#ffeb3b']").length,
        viewMode: document.querySelector("#btn-mode")?.textContent?.trim(),
        theme: document.documentElement.getAttribute("data-theme"),
      }));
      report.router.push({ case: c.label, input: c.hash, result: st });
    }
    await ctx.close();
  }

  // ============ 3. Mobile 390×844 ============
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: "zh-HK",
    });
    const page = await ctx.newPage();
    page.on("console", (m) => consoleLog.push(`[mobile ${m.type()}] ${m.text()}`));
    await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await ready(page);
    report.mobile = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const qa = (s) => [...document.querySelectorAll(s)];
      const btns = qa("#topbar .nav-btn");
      const rows = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)));
      const header = q("#topbar")?.getBoundingClientRect();
      const legend = q("#map-legend")?.getBoundingClientRect();
      const mapR = q("#map-pane")?.getBoundingClientRect();
      const tooSmall = qa("button").filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
      }).length;
      return {
        headerH: header ? Math.round(header.height) : null,
        navButtonRows: rows.size,
        navButtons: btns.map((b) => ({
          id: b.id,
          text: (b.textContent || "").trim(),
          w: Math.round(b.getBoundingClientRect().width),
          h: Math.round(b.getBoundingClientRect().height),
        })),
        legend: legend
          ? {
              w: Math.round(legend.width),
              h: Math.round(legend.height),
              pctW: Math.round((legend.width / window.innerWidth) * 100),
              pctH: Math.round((legend.height / window.innerHeight) * 100),
            }
          : null,
        mapRect: mapR ? { w: Math.round(mapR.width), h: Math.round(mapR.height) } : null,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        buttonsUnder44px: tooSmall,
        hasBottomSheet: !!q("[class*=sheet], [class*=bottom-sheet], [role=dialog][class*=mobile]"),
        safeAreaInset: getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-bottom") || null,
      };
    });
    await page.screenshot({ path: path.join(SHOTS, "a1-mobile-default.png") });
    await ctx.close();
  }

  fs.writeFileSync(path.join(OUT, "ux-audit-results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, "console.log"), consoleLog.join("\n") + "\n");
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("A1 audit 失敗:", e);
  process.exit(1);
});
