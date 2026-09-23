/*
 * 獨立驗收腳本 v2 — B6（地圖互動）／B7（編年史體驗）
 * =====================================================
 * 由 general-purpose-3（獨立驗收代理）撰寫。刻意**唔**重用被驗者或
 * team-lead 草稿嘅任何斷言，改用「可證偽」設計：
 *
 *   1. 每項量度都 print 原始值（唔止 pass/fail）→ 報告可貼真實輸出。
 *   2. 除咗「正向」斷言，仲加「對抗」斷言（例如：故意拖曳 1px、
 *      故意重現原始 bug 場景）去試推翻。
 *   3. 唔用 vitest runner —— 直接 chromium API，避免共同盲點。
 *
 * 執行：node artifacts/verify-b6b7/verify.mjs
 * 前置：npm run build 完成 + http://localhost:5174/ 有 vite preview。
 */

import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "http://localhost:5174/";
const OUT = "artifacts/verify-b6b7";
mkdirSync(OUT, { recursive: true });

const results = [];
let failCount = 0;
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  if (!ok) failCount++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id}`);
  console.log(
    `        ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const errs = { page: [], console: [] };
  page.on("pageerror", (e) => errs.page.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.console.push(m.text());
  });
  return { ctx, page, errs };
}

/** 開頁 + 等底圖 ready。 */
async function openMap(page, query = "") {
  await page.goto(`${BASE}${query}`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector("#svg-map", { timeout: 30_000 });
  await page.waitForFunction(
    () =>
      document.querySelector(".svg-map-wrap")?.classList.contains(
        "basemap-vector-ready",
      ) === true,
    { timeout: 30_000 },
  );
  await sleep(900);
}

/** 去到第 N 章（k 鍵 = 下一章）。 */
async function goToChapter(page, target) {
  const cur = await page.evaluate(() => {
    const m = location.search.match(/chapter=(\d+)/);
    return m ? Number(m[1]) : 1;
  });
  const steps = target - cur;
  const key = steps > 0 ? "k" : "j";
  for (let i = 0; i < Math.abs(steps); i++) await page.keyboard.press(key);
  await sleep(1100);
}

/** 揀一個「夠大 + 完全喺 SVG viewport 內 + 中心冇被遮蓋」嘅 zone。 */
async function pickZone(page, minSize = 18, margin = 14) {
  return page.evaluate(
    ({ minSize, margin }) => {
      const svg = document.querySelector("#svg-map");
      const r = svg.getBoundingClientRect();
      const cands = [];
      for (const z of document.querySelectorAll("#zones-layer .zone")) {
        const a = z.querySelector(".zone-area");
        if (!a) continue;
        const b = a.getBoundingClientRect();
        if (b.width < minSize || b.height < minSize) continue;
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        if (cx < r.x + margin || cx > r.right - margin) continue;
        if (cy < r.y + margin || cy > r.bottom - margin) continue;
        const hit = document.elementFromPoint(cx, cy);
        cands.push({
          id: z.getAttribute("data-zone-id"),
          cx,
          cy,
          area: b.width * b.height,
          hitTag: hit?.tagName ?? null,
          hitClass: hit?.getAttribute?.("class") ?? null,
          // 命中係唔係 zone 系（.zone 或 .zone-area 或 .zone 嘅子孫）
          hitIsZone: Boolean(hit?.closest?.(".zone")),
          hitIsEvent: Boolean(hit?.closest?.(".event-marker")),
          hitIsMarker: Boolean(hit?.closest?.(".location-marker, .location-marker-cluster")),
          hitIsRoute: Boolean(hit?.closest?.(".route-line")),
        });
      }
      // 優先揀「命中係 zone」嘅最大者；否則最大者
      cands.sort((a, b) => {
        if (a.hitIsZone !== b.hitIsZone) return a.hitIsZone ? -1 : 1;
        return b.area - a.area;
      });
      return cands[0] ?? null;
    },
    { minSize, margin },
  );
}

const readSelected = (page) =>
  page.evaluate(() => {
    const sels = Array.from(
      document.querySelectorAll("#zones-layer .zone.is-selected"),
    );
    const url = new URL(location.href);
    return {
      domSelectedIds: sels.map((z) => z.getAttribute("data-zone-id")),
      urlZone: url.searchParams.get("zone"),
      anyIsSelectedEl: document.querySelectorAll(".is-selected").length,
    };
  });

// ══════════════════════════════════════════════════════════════════════════
const browser = await chromium.launch({
  args: ["--no-proxy-server", "--disable-dev-shm-usage"],
});

try {
  // ── 0. 載入 ─────────────────────────────────────────────────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    const info = await page.evaluate(() => ({
      zones: document.querySelectorAll("#zones-layer .zone").length,
      areas: document.querySelectorAll(".zone-area").length,
      clusters: document.querySelectorAll("#zones-layer .zone-cluster").length,
      viewW: Number(
        (document.querySelector("#svg-map").getAttribute("viewBox") ?? "").split(
          /\s+/,
        )[2],
      ),
      mapV2Css: !!document.getElementById("map-v2-css"),
      url: location.href,
    }));
    record("0 頁面載入（全港視圖 = macro LOD）", info.zones > 0, info);
    await ctx.close();
  }

  // ── 1.3 computed pointer-events（真瀏覽器，唔係讀檔）───────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    await goToChapter(page, 198);
    for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
    await sleep(800);

    const pe = await page.evaluate(() => {
      const g = getComputedStyle(document.querySelector("#zones-layer .zone-area"));
      const badge = document.querySelector("#zones-layer .zone-badge");
      const cluster = document.querySelector("#zones-layer .zone-cluster");
      const label = document.querySelector("#zones-layer .zone-label");
      const cs = (el) => (el ? getComputedStyle(el).pointerEvents : "(冇元素)");
      return {
        zoneArea: g.pointerEvents,
        zoneBadge: cs(badge),
        zoneCluster: cs(cluster),
        zoneLabel: cs(label),
        lastMatchingRule: (() => {
          // 搵出令 .zone-area 有 pointer-events 嘅規則（CSSOM 掃）
          const hits = [];
          for (const s of document.styleSheets) {
            try {
              for (const r of [...s.cssRules]) {
                const t = r.cssText || "";
                if (/\.zone-area/.test(t) && /pointer-events/.test(t)) {
                  hits.push({
                    sheet: s.href ? s.href.split("/").pop() : "inline:" + (s.ownerNode?.id || "?"),
                    rule: t.slice(0, 120),
                  });
                }
              }
            } catch {
              /* skip */
            }
          }
          return hits;
        })(),
      };
    });
    record(
      "1.3 .zone-area computed pointer-events === auto（真瀏覽器）",
      pe.zoneArea === "auto",
      pe,
    );
    await ctx.close();
  }

  // ── 1.1 zone 中心 click → 真選中（核心 P0-1）───────────────────────────
  let clickEvidence = null;
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    await goToChapter(page, 198);
    for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
    await sleep(900);

    const pick = await pickZone(page);
    record("1.1-pre 揀到可點 zone + elementFromPoint 命中分析", pick != null, pick);

    if (pick) {
      // 監聽 click / mousedown / mouseup
      await page.evaluate(() => {
        window.__ev = [];
        for (const t of ["mousedown", "mouseup", "click"]) {
          document.addEventListener(
            t,
            (e) =>
              window.__ev.push({
                t,
                cls: e.target?.getAttribute?.("class") ?? e.target?.tagName,
              }),
            true,
          );
        }
      });
      const before = await readSelected(page);
      // 用真滑鼠事件鏈
      await page.mouse.move(pick.cx, pick.cy);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(500);
      const after = await readSelected(page);
      const evLog = await page.evaluate(() => window.__ev);

      const fired = (t) => evLog.filter((e) => e.t === t).length;
      clickEvidence = { pick, before, after, evLog };

      record(
        "1.1a click 事件真派發（唔止 mousedown/up）",
        fired("click") > 0,
        {
          mousedown: fired("mousedown"),
          mouseup: fired("mouseup"),
          click: fired("click"),
          evLog,
        },
      );
      record(
        "1.1b 選中生效（DOM is-selected 或 URL ?zone=）",
        after.domSelectedIds.length === 1 || after.urlZone != null,
        {
          targetId: pick.id,
          命中: `${pick.hitTag}.${pick.hitClass}`,
          命中係zone: pick.hitIsZone,
          before,
          after,
        },
      );
      record(
        "1.1c 選中嘅正正係被點嗰個 zone",
        after.domSelectedIds[0] === pick.id ||
          after.urlZone === pick.id,
        { targetId: pick.id, selected: after.domSelectedIds, urlZone: after.urlZone },
      );
    }
    await ctx.close();
  }

  // ── 1.2 對抗測試 A：大位移拖曳唔可誤選 ─────────────────────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    await goToChapter(page, 198);
    for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
    await sleep(900);
    const pick = await pickZone(page);
    if (!pick) {
      record("1.2 對抗：拖曳唔誤選", false, "搵唔到 zone");
    } else {
      const vb0 = await page.evaluate(
        () => document.querySelector("#svg-map").getAttribute("viewBox"),
      );
      await page.mouse.move(pick.cx, pick.cy);
      await page.mouse.down();
      await page.mouse.move(pick.cx + 100, pick.cy + 60, { steps: 12 });
      await page.mouse.up();
      await sleep(700);
      const after = await readSelected(page);
      const vb1 = await page.evaluate(
        () => document.querySelector("#svg-map").getAttribute("viewBox"),
      );
      record(
        "1.2 對抗：大位移拖曳 → 唔選中，但真平移",
        after.domSelectedIds.length === 0 && vb0 !== vb1,
        {
          selected: after.domSelectedIds,
          urlZone: after.urlZone,
          viewBox: `${vb0} → ${vb1}`,
          panned: vb0 !== vb1,
        },
      );
    }
    await ctx.close();
  }

  // ── 1.2b 對抗測試 B（關鍵）：微位移拖曳（1px）→ 應該當「輕觸」，
  //          呢個係 B6 守衛嘅**邊界**：movedDuringPan = true 即使只行 1px，
  //          即係「手震」會令 click 消失。我哋量度實際行為。 ────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    await goToChapter(page, 198);
    for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
    await sleep(900);
    const pick = await pickZone(page);
    if (!pick) {
      record("1.2b 對抗：1px 微拖", false, "搵唔到 zone");
    } else {
      await page.mouse.move(pick.cx, pick.cy);
      await page.mouse.down();
      await page.mouse.move(pick.cx + 1, pick.cy, { steps: 2 });
      await page.mouse.up();
      await sleep(500);
      const after = await readSelected(page);
      // 記錄事實（唔算 fail，因為「1px 算拖」係可辯論嘅設計）
      record(
        "1.2b [觀察] 1px 微拖 → 選中與否（邊界行為）",
        true,
        {
          selected: after.domSelectedIds,
          urlZone: after.urlZone,
          註解:
            after.domSelectedIds.length === 0
              ? "1px 位移已經被當「拖曳」→ 手震會令 zone 點唔到（潛在 UX 風險）"
              : "1px 仍然算輕觸 → click 正常",
        },
      );
    }
    await ctx.close();
  }

  // ── 1.4 MapControls 點擊唔應該改 selectedZoneId ────────────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    await goToChapter(page, 198);
    for (let i = 0; i < 3; i++) await page.click("#map-zoom-in");
    await sleep(900);
    const pick = await pickZone(page);
    if (!pick) {
      record("1.4 MapControls 唔改 selectedZoneId", false, "搵唔到 zone");
    } else {
      await page.mouse.click(pick.cx, pick.cy);
      await sleep(400);
      const sel0 = await readSelected(page);
      const trace = [];
      for (const id of ["#map-zoom-in", "#map-zoom-out", "#map-reset"]) {
        const exists = await page.$(id);
        if (!exists) {
          trace.push(`${id}: 掣唔存在`);
          continue;
        }
        await page.click(id);
        await sleep(450);
        const s = await readSelected(page);
        trace.push(`${id}: ${JSON.stringify(s.domSelectedIds)} url=${s.urlZone}`);
      }
      const selN = await readSelected(page);
      record(
        "1.4 MapControls 點擊 → selectedZoneId 不變",
        sel0.domSelectedIds.length === 1 &&
          JSON.stringify(selN.domSelectedIds) ===
            JSON.stringify(sel0.domSelectedIds),
        { 選中前: sel0, 點掣後逐項: trace, 最終: selN },
      );
    }
    await ctx.close();
  }

  // ── 1.5 切章節 → URL query 更新 ─────────────────────────────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page, "?chapter=150");
    const u0 = page.url();
    await page.keyboard.press("k");
    await sleep(700);
    const u1 = page.url();
    record(
      "1.5 按 k → 章節 +1 且 URL ?chapter= 更新",
      /chapter=150/.test(u0) && /chapter=151/.test(u1),
      `${u0} → ${u1}`,
    );
    await ctx.close();
  }

  // ── 2. B7 CSS 真生效（computed style + 對照實驗）───────────────────────
  {
    const { page, ctx, errs } = await boot(browser);
    // 探索 chronicle 檢視入口
    await page.goto(BASE, { waitUntil: "load", timeout: 60_000 });
    await sleep(1200);

    const nav = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a, button, [role=tab], [data-view]"));
      const hit = all.find((el) =>
        /chronicle|編年|年表/i.test(
          (el.textContent ?? "") + (el.getAttribute("href") ?? "") + (el.getAttribute("data-view") ?? ""),
        ),
      );
      if (hit) {
        const label = (hit.textContent ?? "").trim().slice(0, 24);
        hit.click();
        return { method: "click", label };
      }
      return { method: "none", label: null };
    });
    await sleep(1500);

    let probe = await page.evaluate(() => {
      const root = document.querySelector(".chronicle");
      if (!root) return { found: false };
      const sample = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, exists: false };
        const c = getComputedStyle(el);
        const o = { sel, exists: true, cls: el.getAttribute("class") };
        for (const p of props) o[p] = c.getPropertyValue(p);
        return o;
      };
      return {
        found: true,
        rootClass: root.getAttribute("class"),
        rootDisplay: getComputedStyle(root).display,
        sub: [
          sample(".chronicle-item", ["padding", "border-bottom-color", "position"]),
          sample(".chronicle-timeline", ["position", "overflow-y"]),
          sample(".chronicle-period", ["font-weight", "position"]),
          sample(".chronicle-rail", ["gap", "position"]),
        ],
        count: document.querySelectorAll('[class*="chronicle-"]').length,
      };
    });

    record("2.0a chronicle 檢視可導航", probe.found, {
      導航方法: nav,
      probe,
    });

    if (probe.found) {
      const nonDefault = probe.sub.filter(
        (s) =>
          s.exists &&
          ["padding", "border-bottom-color", "position", "overflow-y", "font-weight", "gap"].some(
            (k) => s[k] && s[k] !== "0px" && s[k] !== "normal" && s[k] !== "static" && s[k] !== "visible" && s[k] !== "auto" && s[k] !== "rgba(0, 0, 0, 0)",
          ),
      );
      record(
        "2.1 ≥3 個 .chronicle-* 有非預設 computed style",
        nonDefault.length >= 3,
        { 符合數: nonDefault.length, 詳情: probe.sub },
      );

      // 2.2 對照實驗：搵到 chronicle 規則喺邊個 sheet，數規則
      const cssom = await page.evaluate(() => {
        let ruleCount = 0;
        const sheets = [];
        for (const s of document.styleSheets) {
          try {
            const n = [...s.cssRules].filter((r) =>
              /chronicle-/.test(r.cssText || ""),
            ).length;
            if (n > 0) {
              sheets.push({
                sheet: s.href ? s.href.split("/").pop() : "inline:" + (s.ownerNode?.id || "?"),
                chronicleRules: n,
              });
              ruleCount += n;
            }
          } catch {
            /* skip */
          }
        }
        return { ruleCount, sheets };
      });
      record(
        "2.2 chronicle 規則存在於 CSSOM（sheet + 規則數）",
        cssom.ruleCount > 0,
        cssom,
      );

      // 2.3 對照實驗（最強）：暫時停用含 chronicle 規則嘅 sheet → computed 應該變
      const contrast = await page.evaluate(async () => {
        const el = document.querySelector(".chronicle-item, [class*='chronicle-']");
        if (!el) return { ok: false, reason: "冇元素" };
        const snap = (e) => {
          const c = getComputedStyle(e);
          return {
            paddingTop: c.paddingTop,
            display: c.display,
            borderBottomColor: c.borderBottomColor,
            position: c.position,
            fontWeight: c.fontWeight,
          };
        };
        const before = snap(el);
        // 停用所有 sheet（同源 inline/link）
        const disabled = [];
        for (const s of document.styleSheets) {
          try {
            if ([...s.cssRules].some((r) => /chronicle-/.test(r.cssText || ""))) {
              s.disabled = true;
              disabled.push(s.href ? s.href.split("/").pop() : "inline");
            }
          } catch {
            /* skip */
          }
        }
        await new Promise((r) => requestAnimationFrame(r));
        const after = snap(el);
        // 還原
        for (const s of document.styleSheets) {
          try {
            s.disabled = false;
          } catch {
            /* skip */
          }
        }
        return {
          ok: true,
          disabled,
          before,
          after,
          changed: JSON.stringify(before) !== JSON.stringify(after),
        };
      });
      record(
        "2.3 對照實驗：停用 chronicle sheet → computed style 改變（證明樣式真由該 CSS 提供）",
        contrast.ok && contrast.changed,
        contrast,
      );
    }
    record("2.9 chronicle 頁冇 uncaught pageerror", errs.page.length === 0, {
      pageErrors: errs.page,
    });
    await ctx.close();
  }

  // ── 3. ZoneLayer cluster 正規化（spec §3.2 L-Z0）───────────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    const macro = await page.evaluate(() => {
      const zones = Array.from(document.querySelectorAll("#zones-layer .zone"));
      const clusters = Array.from(
        document.querySelectorAll("#zones-layer .zone-cluster"),
      );
      const labels = Array.from(document.querySelectorAll(".zone-label"));
      // 量 cluster badge 有冇「帶數量」（spec: badge 帶 kind icon + 數量）
      const withCount = clusters.filter((c) =>
        /\d/.test(c.textContent || ""),
      ).length;
      // cluster 內文字
      const texts = clusters.slice(0, 6).map((c) =>
        (c.textContent || "").trim().slice(0, 12),
      );
      // cluster 嘅半徑（screen px）應該 8–12 px（spec L-Z0）
      const radii = clusters.slice(0, 6).map((c) => {
        const el = c.querySelector("circle, .zone-cluster-ring");
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return Math.round((b.width / 2) * 10) / 10;
      });
      return {
        zoneCount: zones.length,
        clusterCount: clusters.length,
        clusterWithCountText: withCount,
        clusterTexts: texts,
        clusterRadiiPx: radii,
        labelCount: labels.length,
        lodSet: Array.from(
          new Set(zones.map((z) => z.getAttribute("data-zone-lod"))),
        ),
        clusterAttr: document
          .querySelector("#zones-layer")
          ?.getAttribute("data-zone-cluster-count"),
        viewW: Number(
          (document.querySelector("#svg-map").getAttribute("viewBox") ?? "").split(/\s+/)[2],
        ),
      };
    });
    record(
      "3.1 macro（viewW>0.175）→ 單一 cluster badge + 數量，zone-area 全保留",
      macro.viewW > 0.175 &&
        macro.clusterCount > 0 &&
        macro.clusterCount < macro.zoneCount &&
        macro.clusterWithCountText === macro.clusterCount &&
        macro.labelCount === 0,
      macro,
    );

    // 放大 → cluster 消失，LOD 轉 boundary/full
    for (let i = 0; i < 8; i++) await page.click("#map-zoom-in");
    await sleep(1200);
    const zoomed = await page.evaluate(() => ({
      clusters: document.querySelectorAll("#zones-layer .zone-cluster").length,
      lodSet: Array.from(
        new Set(
          Array.from(document.querySelectorAll("#zones-layer .zone")).map((z) =>
            z.getAttribute("data-zone-lod"),
          ),
        ),
      ),
      areas: document.querySelectorAll(".zone-area").length,
      viewW: Number(
        (document.querySelector("#svg-map").getAttribute("viewBox") ?? "").split(/\s+/)[2],
      ),
    }));
    record(
      "3.2 放大後 cluster 消失、LOD 前進，zone-area 總數不變（規則 L1）",
      zoomed.clusters === 0 &&
        zoomed.areas === macro.zoneCount &&
        !zoomed.lodSet.includes("cluster"),
      { macroZoneCount: macro.zoneCount, zoomed },
    );
    await ctx.close();
  }

  // ── 4. hit priority 次序（真瀏覽器：疊放場景）───────────────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    // 搵「zone 內有 event-marker / marker」嘅位置，睇邊個贏
    await goToChapter(page, 198);
    for (let i = 0; i < 4; i++) await page.click("#map-zoom-in");
    await sleep(1000);
    const overlap = await page.evaluate(() => {
      // 搵 event-marker 嘅中心，睇 elementFromPoint 命中邊個
      const events = Array.from(document.querySelectorAll("#events-layer .event-marker")).slice(0, 40);
      const out = [];
      for (const e of events) {
        const b = e.getBoundingClientRect();
        if (b.width === 0) continue;
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit) continue;
        out.push({
          eventCenterHit: hit.getAttribute?.("class") ?? hit.tagName,
          inZone: Boolean(hit.closest?.(".zone")),
          inEvent: Boolean(hit.closest?.(".event-marker")),
        });
        if (out.length >= 8) break;
      }
      // 統計
      const inZone = out.filter((o) => o.inZone).length;
      const inEvent = out.filter((o) => o.inEvent).length;
      return { samples: out, inZone, inEvent, total: out.length };
    });
    record(
      "4.1 spec §2.3 原文場景：zone 內 event-marker —— 記錄命中結果",
      true,
      overlap,
    );
    await ctx.close();
  }

  // ── 5. 紅線：dist CSS 是否含 chronicle- 選擇器 ─────────────────────────
  {
    const { page, ctx } = await boot(browser);
    await openMap(page);
    const cssCheck = await page.evaluate(() => {
      const sheets = [...document.styleSheets].map((s) =>
        s.href ? s.href.split("/").pop() : "inline:" + (s.ownerNode?.id || "?"),
      );
      return { sheets, mapV2Css: !!document.getElementById("map-v2-css") };
    });
    record("5.1 頁面 stylesheet 清單 + map-v2-css 注入", true, cssCheck);
    await ctx.close();
  }
} catch (e) {
  console.error("腳本爆咗：", e);
  record("SCRIPT", false, e.message);
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
const summary = {
  base: BASE,
  ranAt: new Date().toISOString(),
  total: results.length,
  passed,
  failed: results.length - passed,
  allPass: passed === results.length,
  results,
};
writeFileSync(`${OUT}/verify-results.json`, JSON.stringify(summary, null, 2));
console.log("");
console.log(`==== ${passed}/${results.length} 通過，${results.length - passed} 失敗 ====`);
console.log(`寫入 ${OUT}/verify-results.json`);
process.exitCode = results.length - passed === 0 ? 0 : 1;
