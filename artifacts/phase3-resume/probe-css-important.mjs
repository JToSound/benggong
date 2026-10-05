/**
 * D 階段 2 驗證：量度每個候選 `!important` 宣告**實際生效嘅 computed value**。
 *
 * 用法：
 *   node artifacts/phase3-resume/probe-css-important.mjs <out.json>
 *
 * 為何可以只比較「同一個屬性」
 * ==========================
 * CSS 每個宣告獨立參與 cascade。移除某條宣告嘅 `!important` **只會影響
 * 嗰個屬性**（同一 block 其他宣告不受影響）→ 所以「移除前 vs 移除後」
 * 只要比對同一個屬性喺同一個選擇器命中嘅元素上嘅 computed value 就足夠。
 *
 * 精確度：簡寫（`padding` / `transition` / `outline` …）由
 * `scripts/audit_css_important.py` 預先展開成長手屬性。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5174;
const BASE = "http://localhost:" + PORT + "/";
const INV = process.env.INV || "artifacts/phase3-resume/important-inventory.json";

const CONFIGS = [
  { name: "1440x900-dark", width: 1440, height: 900, theme: "dark" },
  { name: "1440x900-light", width: 1440, height: 900, theme: "light" },
  { name: "390x844-dark", width: 390, height: 844, theme: "dark" },
  // ⚠️ 要**打開面板**才量得到 `.workspace.is-pane-open` 之下嘅規則
  { name: "1440x900-dark-paneopen", width: 1440, height: 900, theme: "dark", openPane: true },
];

const ok = async (u, ms = 3000) => {
  try {
    return (await fetch(u, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
};
async function ensure() {
  if (await ok(BASE)) return null;
  const s = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 40; i++) {
    if (await ok(BASE)) return s;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("preview server 起唔到");
}

/** 喺頁面內量度：回傳 { key: [values...] }。 */
const MEASURE = (items) => {
  // ⚠️ 一定要喺 evaluate 內部定義 —— Node 側嘅函數唔會傳入瀏覽器 context
  const camel = (p) => p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const out = {};
  for (const it of items) {
    if (it.media && !window.matchMedia(it.media).matches) continue;
    let els = [];
    try {
      els = Array.from(document.querySelectorAll(it.selector));
    } catch {
      out[it.key] = { error: "selector 無效" };
      continue;
    }
    const vals = [];
    for (const el of els) {
      const cs = getComputedStyle(el);
      const row = {};
      for (const lh of it.longhands) {
        row[lh] = String(cs[camel(lh)] ?? "");
      }
      vals.push(row);
    }
    // 排序令次序無關（同一 build 之下 DOM 次序應該一樣，但排序更穩健）
    vals.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    out[it.key] = { n: els.length, vals };
  }
  return out;
};

const inv = JSON.parse(readFileSync(INV, "utf-8"));
const items = inv.candidates.map((c) => ({
  key: c.key,
  selector: c.selector,
  media: c.media,
  longhands: c.longhands,
  property: c.property,
  value: c.value,
}));

const server = await ensure();
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const snapshot = { note: "D 階段 2：!important 候選嘅 computed value 快照", configs: {} };
try {
  for (const cfg of CONFIGS) {
    const page = await browser.newPage({
      viewport: { width: cfg.width, height: cfg.height },
      locale: "zh-HK",
    });
    await page.addInitScript((theme) => {
      try {
        localStorage.setItem("binggang.onboarding.dismissed", "1");
        localStorage.setItem("binggang.theme", theme);
      } catch {
        /* */
      }
    }, cfg.theme);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll(".ch-pill").length > 100, null, {
      timeout: 20000,
    });
    await page.waitForTimeout(800);
    if (cfg.openPane) {
      await page.click("#btn-toggle-panel", { force: true, timeout: 15000 });
      await page.waitForTimeout(600);
    }
    /*
     * ⚠️ `:focus-visible` 選擇器：`.focus()` 唔會令 `:focus-visible` 匹配
     * （要「鍵盤式」聚焦）→ 用真 Tab 逐個行到 `.nav-btn` 為止。
     */
    const needFocus = items.some((i) => i.selector.includes(":focus-visible"));
    if (needFocus) {
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const cls = await page.evaluate(() =>
          (document.activeElement && document.activeElement.getAttribute("class")) || "",
        );
        if (cls.includes("nav-btn")) break;
      }
      await page.waitForTimeout(200);
    }
    snapshot.configs[cfg.name] = await page.evaluate(MEASURE, items);
    await page.close();
  }
} finally {
  await browser.close();
  if (server && server.pid) {
    try {
      process.kill(-server.pid);
    } catch {
      /* */
    }
  }
}

const out = process.argv[2] || "artifacts/phase3-resume/important-values.json";
writeFileSync(out, JSON.stringify(snapshot, null, 1), "utf-8");
console.log("已寫入 " + out);
console.log(
  "量度咗 " +
    Object.values(snapshot.configs).reduce((a, c) => a + Object.keys(c).length, 0) +
    " 條（跨 " +
    CONFIGS.length +
    " 個 config）",
);
