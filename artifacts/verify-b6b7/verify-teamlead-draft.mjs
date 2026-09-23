/*
 * 獨立驗收腳本 — B6（地圖互動）／B7（編年史體驗）
 * ================================================
 * 目的：**唔信單元測試**，喺真實 Chromium 量度實際行為。
 *
 * 刻意唔用 vitest／@playwright/test 嘅 test runner —— 直接用
 * `playwright` 嘅 chromium API，避免「同一套設定」帶嚟嘅共同盲點。
 *
 * 環境陷阱（已知）：
 *   · `vite preview` 只綁 IPv6 [::1] → 一定要用 http://localhost:PORT/
 *   · 環境有 http_proxy → Chromium launch 要 --no-proxy-server
 *   · exit code 唔可以靠 pipeline → 用 process.exitCode
 */

import { chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.VERIFY_BASE || "http://localhost:5174/";
const OUT = "artifacts/verify-b6b7";

mkdirSync(OUT, { recursive: true });

/** @type {{name:string, pass:boolean, detail:any}[]} */
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}`);
  console.log(`        ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const run = async () => {
  const browser = await chromium.launch({
    args: ["--no-proxy-server", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // ── 開頁 ──────────────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("#svg-map", { timeout: 30000 });
  // 等地圖渲染完成（zone 出現）
  await page.waitForFunction(
    () => document.querySelectorAll("#svg-map .zone").length > 0,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200); // 等 LOD / 動畫穩定

  record("0. 頁面載入 + #svg-map + .zone 出現", true, {
    zones: await page.locator("#svg-map .zone").count(),
    url: page.url(),
  });

  // ── 登記 store 探針（若無 window 暴露，就用 DOM 代理）──────────────────
  const storeProbe = await page.evaluate(() => {
    const keys = Object.keys(window).filter(
      (k) =>
        /store|app|__.*(state|atlas)|worldAtlas/i.test(k) &&
        typeof window[k] === "object" &&
        window[k] !== null,
    );
    return keys;
  });
  record("0b. 探測 window 上有冇 store／app 暴露", storeProbe.length > 0, {
    foundKeys: storeProbe,
    note: storeProbe.length === 0 ? "冇暴露 → 全部改用 DOM is-selected 代理" : "有暴露",
  });

  // 讀 selectedZoneId 嘅統一方法（先試 store，再落 DOM）
  const readSelected = async () =>
    page.evaluate((probeKeys) => {
      // 方法 A：window 暴露
      for (const k of probeKeys) {
        try {
          const v = window[k];
          const s =
            v?.getState?.() ?? v?.state?.() ?? v?.store?.getState?.() ?? null;
          if (s && "context" in s && s.context?.kind === "zone") {
            return { via: "store:" + k, zoneId: s.context.zoneId };
          }
          if (s && "selectedZoneId" in s) {
            return { via: "store:" + k, zoneId: s.selectedZoneId };
          }
        } catch {
          /* 略過 */
        }
      }
      // 方法 B：DOM 代理
      const sel = document.querySelector("#svg-map .zone.is-selected");
      return {
        via: "dom",
        zoneId: sel?.getAttribute("data-zone-id") ?? sel?.id ?? null,
      };
    }, storeProbe);

  const urlZone = () => {
    try {
      return new URL(page.url()).searchParams.get("zone");
    } catch {
      return null;
    }
  };

  // ── 驗證 1：點 zone 中心 → 真選中 ────────────────────────────────────────
  const before = await readSelected();
  const target = await page.evaluate(() => {
    const zones = [...document.querySelectorAll("#svg-map .zone")].filter((g) => {
      const r = g.getBoundingClientRect();
      // filter 離屏 + 太細
      return r.width > 6 && r.height > 6 && r.top > 0 && r.left > 0;
    });
    // 揀面積最大嗰個（最穩定命中）
    zones.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    const g = zones[0];
    if (!g) return null;
    const r = g.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // 真正喺嗰點嘅元素（驗證冇被遮蓋）
    const hit = document.elementFromPoint(cx, cy);
    const area = g.querySelector(".zone-area");
    const rArea = area?.getBoundingClientRect();
    const cxA = rArea ? rArea.left + rArea.width / 2 : cx;
    const cyA = rArea ? rArea.top + rArea.height / 2 : cy;
    const hitA = document.elementFromPoint(cxA, cyA);
    return {
      zoneId: g.getAttribute("data-zone-id") ?? g.id ?? null,
      cx,
      cy,
      hitAtCenter: hit ? hit.tagName + "." + (hit.getAttribute("class") || "") : null,
      areaCenterX: cxA,
      areaCenterY: cyA,
      hitAtAreaCenter: hitA
        ? hitA.tagName + "." + (hitA.getAttribute("class") || "")
        : null,
      areaPE: area
        ? getComputedStyle(area).pointerEvents
        : null,
      count: zones.length,
    };
  });

  // 驗證 3（子項）：computed pointer-events 係 auto
  record(
    "1a. .zone-area computed pointer-events === auto",
    target?.areaPE === "auto",
    { pointerEvents: target?.areaPE, hitAtAreaCenter: target?.hitAtAreaCenter },
  );

  // 真滑鼠 click（走完整 mousedown/mouseup/click 合成鏈）
  await page.mouse.move(target.areaCenterX, target.areaCenterY);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterClick = await readSelected();
  const afterClickUrl = urlZone();
  const clicked =
    afterClick.zoneId != null &&
    afterClick.zoneId !== "" &&
    (target.zoneId ? afterClick.zoneId === target.zoneId : true);

  record(
    "1b. 真滑鼠 click zone → 選中生效（store 或 DOM is-selected 非空）",
    clicked,
    {
      targetZoneId: target.zoneId,
      before,
      afterClick,
      urlZone: afterClickUrl,
      matched: clicked,
    },
  );

  if (!clicked) {
    await page.screenshot({
      path: `${OUT}/fail-1b-click.png`,
      fullPage: false,
    });
  }

  // ── 驗證 2：對抗測試 — 拖曳平移唔應該誤選 ────────────────────────────────
  // 先清空選擇（重新載入）令對抗測試乾淨
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(
    () => document.querySelectorAll("#svg-map .zone").length > 0,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1000);

  const dragTarget = await page.evaluate(() => {
    const zones = [...document.querySelectorAll("#svg-map .zone")].filter((g) => {
      const r = g.getBoundingClientRect();
      return r.width > 6 && r.height > 6 && r.top > 0 && r.left > 0;
    });
    zones.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    const g = zones[0];
    if (!g) return null;
    const area = g.querySelector(".zone-area") ?? g;
    const r = area.getBoundingClientRect();
    return {
      zoneId: g.getAttribute("data-zone-id") ?? g.id ?? null,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  });

  const beforeDrag = await readSelected();
  // 大位移拖曳（> 任何 pan threshold）
  await page.mouse.move(dragTarget.x, dragTarget.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(dragTarget.x - i * 12, dragTarget.y - i * 8);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterDrag = await readSelected();

  const dragDidNotSelect =
    afterDrag.zoneId == null ||
    afterDrag.zoneId === "" ||
    afterDrag.zoneId === beforeDrag.zoneId;

  record(
    "2. 對抗：拖曳平移唔會誤觸發選中（movedDuringPan 守衛）",
    dragDidNotSelect,
    {
      dragStartZoneId: dragTarget.zoneId,
      beforeDrag,
      afterDrag,
      dragDidNotSelect,
    },
  );

  // ── 驗證 4：MapControls 掣唔應該改動 selectedZoneId ───────────────────────
  // 先選中一個 zone
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(
    () => document.querySelectorAll("#svg-map .zone").length > 0,
    { timeout: 30000 },
  );
  await page.waitForTimeout(900);

  const ctlTarget = await page.evaluate(() => {
    const zones = [...document.querySelectorAll("#svg-map .zone")].filter((g) => {
      const r = g.getBoundingClientRect();
      return r.width > 6 && r.height > 6 && r.top > 0 && r.left > 0;
    });
    zones.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    const g = zones[0];
    if (!g) return null;
    const area = g.querySelector(".zone-area") ?? g;
    const r = area.getBoundingClientRect();
    return {
      zoneId: g.getAttribute("data-zone-id") ?? g.id ?? null,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  });

  await page.mouse.move(ctlTarget.x, ctlTarget.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterSelect = await readSelected();

  // 搵 MapControls 嘅掣
  const ctlInfo = await page.evaluate(() => {
    const btns = [
      ...document.querySelectorAll(
        ".map-controls button, .map-ctrl, [data-map-control]",
      ),
    ].map((b) => {
      const r = b.getBoundingClientRect();
      return {
        cls: b.getAttribute("class"),
        text: (b.textContent || "").trim().slice(0, 20),
        aria: b.getAttribute("aria-label"),
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        visible: r.width > 0 && r.height > 0,
      };
    });
    return btns.filter((b) => b.visible);
  });

  record("4a. 搵到 MapControls 掣", ctlInfo.length > 0, {
    count: ctlInfo.length,
    buttons: ctlInfo.map((b) => `${b.aria || b.text || b.cls}(${b.w}x${b.h})`),
  });

  if (ctlInfo.length > 0) {
    const btn = ctlInfo[0];
    await page.mouse.click(btn.x, btn.y);
    await page.waitForTimeout(500);
    const afterCtl = await readSelected();
    const ctlDidNotSteal =
      afterCtl.zoneId === afterSelect.zoneId &&
      afterSelect.zoneId != null &&
      afterSelect.zoneId !== "";

    record(
      "4b. 點 MapControls 掣 → selectedZoneId 不變（控制項唔被 zone 偷走）",
      ctlDidNotSteal,
      {
        clickedButton: btn.aria || btn.text || btn.cls,
        beforeControlClick: afterSelect,
        afterControlClick: afterCtl,
        unchanged: ctlDidNotSteal,
      },
    );
  }

  // ── 驗證 5：切章節 → URL query 更新 ──────────────────────────────────────
  const urlBefore = page.url();
  // 搵章節控制（可能存在於 timeline / HUD）
  const chapterCtl = await page.evaluate(() => {
    const cands = [
      ...document.querySelectorAll(
        'input[type="range"][aria-label*="章"], [data-chapter], .timeline input[type="range"], .chapter-slider, .chr-ch',
      ),
    ];
    return cands.map((c) => {
      const r = c.getBoundingClientRect();
      return {
        tag: c.tagName,
        type: c.getAttribute("type"),
        cls: c.getAttribute("class"),
        id: c.id,
        aria: c.getAttribute("aria-label"),
        min: c.getAttribute("min"),
        max: c.getAttribute("max"),
        value: c.value ?? null,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
  });

  record("5a. 搵到章節控制項", chapterCtl.length > 0, {
    count: chapterCtl.length,
    controls: chapterCtl.slice(0, 5),
  });

  if (chapterCtl.length > 0) {
    // 用 JS 直接改 value + 派 input/change（跨瀏覽器最穩）
    const changed = await page.evaluate(() => {
      const el =
        document.querySelector(
          'input[type="range"][aria-label*="章"], .timeline input[type="range"], .chapter-slider',
        ) || document.querySelector('[data-chapter]');
      if (!el) return null;
      const before = el.value;
      const max = Number(el.max || 500);
      const next = Math.min(max, Number(before || 0) + 25);
      el.value = String(next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { before, next };
    });
    await page.waitForTimeout(700);
    const urlAfter = page.url();
    const chapterInUrl =
      new URL(urlAfter).searchParams.has("chapter") ||
      new URL(urlAfter).searchParams.has("ch");
    record(
      "5b. 切章節 → URL query 更新（?chapter= 出現或值改變）",
      urlAfter !== urlBefore && chapterInUrl,
      { urlBefore, urlAfter, chapterInUrl, changed },
    );
  }

  // ── 驗證 6：chronicle CSS 真係喺頁面生效（computed style）───────────────
  // 導航去 chronicle 檢視
  const navToChronicle = async () => {
    // 先試 URL
    const u = new URL(BASE);
    u.searchParams.set("view", "chronicle");
    await page.goto(u.toString(), { waitUntil: "load" });
    await page.waitForTimeout(1200);
    let has = await page.locator(".chronicle, .chronicle-body").count();
    if (has === 0) {
      // 退回：搵 UI 上嘅檢視切換掣
      const btns = await page.locator('[data-view], .view-tab, nav button').all();
      for (const b of btns) {
        const t = ((await b.textContent()) || "").trim();
        if (/編年|chronicle|年表/i.test(t)) {
          await b.click();
          await page.waitForTimeout(1000);
          break;
        }
      }
      has = await page.locator(".chronicle, .chronicle-body").count();
    }
    return has;
  };

  const chrCount = await navToChronicle();
  record("6a. 頁面出現 .chronicle 元素", chrCount > 0, {
    elementCount: chrCount,
    url: page.url(),
  });

  if (chrCount > 0) {
    // 量 .chr-* 元素嘅 computed style，證明唔係「冇樣式」嘅裸 HTML
    const cs = await page.evaluate(() => {
      const out = {};
      const probes = [
        [".chronicle", ["borderColor", "backgroundColor", "fontSize"]],
        [".chr-entry", ["borderColor", "padding", "marginBottom"]],
        [".chr-btn", ["backgroundColor", "borderRadius", "fontSize"]],
        [".chr-ch", ["fontSize", "color"]],
        [".chr-rail", ["gap", "padding"]],
        [".chr-entry-title", ["fontSize", "fontWeight", "color"]],
      ];
      for (const [sel, props] of probes) {
        const el = document.querySelector(sel);
        if (!el) {
          out[sel] = null;
          continue;
        }
        const g = getComputedStyle(el);
        const rec = { __exists: true };
        for (const p of props) rec[p] = g[p];
        out[sel] = rec;
      }
      // 亦記錄 stylesheet 數量同 map-v2-css 存在與否
      out.__stylesheets = [...document.styleSheets].map(
        (s) => (s.href ? s.href.split("/").pop() : "inline:" + (s.ownerNode?.id || "?")),
      );
      out.__mapV2Css = !!document.getElementById("map-v2-css");
      return out;
    });

    // 判斷標準：至少 3 個 .chr-* 元素有「非初始值」嘅樣式
    const isDefault = (v) =>
      v == null ||
      v === "" ||
      v === "normal" ||
      v === "0px" ||
      v === "auto" ||
      v === "rgba(0, 0, 0, 0)";
    let nonDefault = 0;
    const evidence = {};
    for (const [sel, rec] of Object.entries(cs)) {
      if (sel.startsWith("__")) continue;
      if (!rec || rec.__exists !== true) continue;
      const vals = Object.entries(rec).filter(([k]) => k !== "__exists");
      const nonDefProps = vals.filter(([, v]) => !isDefault(v));
      if (nonDefProps.length > 0) nonDefault++;
      evidence[sel] = Object.fromEntries(nonDefProps);
    }

    record(
      "6b. 至少 3 個 .chr-* 元素有非預設 computed style（CSS 真生效）",
      nonDefault >= 3,
      {
        nonDefaultElementCount: nonDefault,
        evidence,
        stylesheets: cs.__stylesheets,
        mapV2CssInjected: cs.__mapV2Css,
      },
    );

    // 6c：對照實驗 —— 停用 chronicle.css 嘅規則，證明樣式真係由佢提供
    const contrast = await page.evaluate(() => {
      // 搵出所有含 .chr-/ .chronicle 規則嘅 stylesheet，數規則數
      let ruleCount = 0;
      let sheetsWithChronicle = 0;
      for (const s of document.styleSheets) {
        try {
          const rules = [...s.cssRules];
          let n = 0;
          for (const r of rules) {
            const t = r.cssText || "";
            if (/\.chr-|\.chronicle/.test(t)) n++;
          }
          if (n > 0) {
            sheetsWithChronicle++;
            ruleCount += n;
          }
        } catch {
          /* CORS 讀唔到（同源應該讀到） */
        }
      }
      return { ruleCount, sheetsWithChronicle };
    });
    record(
      "6c. 頁面 stylesheet 內含 .chr-/.chronicle 規則（CSSOM 真讀到）",
      contrast.ruleCount > 0,
      contrast,
    );
  }

  // ── 收尾：console 錯誤 ───────────────────────────────────────────────────
  record("7. 冇 uncaught pageerror", pageErrors.length === 0, {
    pageErrors,
    consoleErrorCount: consoleErrors.length,
    consoleErrors: consoleErrors.slice(0, 10),
  });

  await browser.close();

  // ── 寫報告 ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
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
  console.log(`==== ${passed}/${results.length} 通過 ====`);
  console.log(`寫入 ${OUT}/verify-results.json`);
  process.exitCode = passed === results.length ? 0 : 1;
};

run().catch((e) => {
  console.error("腳本本身爆咗：", e);
  process.exitCode = 2;
});
