/**
 * A2 Visual / Motion Director —— 只讀視覺審計擷取腳本
 *
 * 用途：對現行 production 版本擷取 dark / light 兩種主題、desktop / tablet /
 *      mobile 三種 viewport 嘅截圖，同時抽取**實測**視覺事實（色彩分佈、
 *      對比、字級、glass 面板、animation / transition 清單、tap target）。
 *
 * 限制：
 *   - 只讀 production code（唔會寫入 src/、data/、public/、tests/、config）。
 *   - 只寫 `artifacts/audit-A2/`。
 *   - 唔會讀取或輸出 data/private/ 任何內容。
 *
 * 執行：node artifacts/audit-A2/theme-capture.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

// ⚠️ 必須用 localhost：vite preview 只綁 IPv6 [::1]。
const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A2";
const SHOTS = path.join(OUT, "screenshots");

fs.mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "tablet", width: 768, height: 1024 },
  { id: "mobile", width: 390, height: 844 },
];

const THEMES = ["dark", "light"];

/**
 * 注入到頁面：色彩／動效／對比審計。
 * 全部用 DOM API 讀**實際 computed style**，唔靠讀 CSS 原始碼。
 */
const AUDIT_FN = `(() => {
  const toRgb = (s) => {
    if (!s || s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return null;
    const m = s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    const a = p.length > 3 ? p[3] : 1;
    if (a === 0) return null;
    return { r: p[0], g: p[1], b: p[2], a };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const blend = (fg, bg) => {
    const a = fg.a === undefined ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  };
  // 往上找第一個唔透明背景
  const bgOf = (el) => {
    let n = el, acc = null;
    while (n && n !== document.documentElement) {
      const c = toRgb(getComputedStyle(n).backgroundColor);
      if (c) { acc = acc ? blend(acc, c) : c; if ((c.a === undefined ? 1 : c.a) >= 0.98) break; }
      n = n.parentElement;
    }
    if (!acc) acc = toRgb(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    return acc;
  };

  const all = Array.from(document.querySelectorAll('*'));

  // ---- 色彩分佈（computed）----
  const colorCount = {}, bgCount = {}, borderCount = {};
  const bump = (o, k) => { if (!k) return; o[k] = (o[k] || 0) + 1; };

  // ---- 動效清單 ----
  const anims = [];
  const transitions = new Map();
  // ---- 字級 ----
  const fontSizes = {};
  // ---- glass 面板 ----
  const glass = [];
  // ---- 對比 ----
  const contrasts = [];
  // ---- tap target ----
  const smallTargets = [];

  for (const el of all) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;

    bump(colorCount, cs.color);
    bump(bgCount, cs.backgroundColor);
    bump(borderCount, cs.borderTopColor);

    if (cs.animationName && cs.animationName !== 'none') {
      anims.push({
        selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''),
        name: cs.animationName, duration: cs.animationDuration, delay: cs.animationDelay,
        timing: cs.animationTimingFunction, iteration: cs.animationIterationCount,
        playState: cs.animationPlayState, visible,
      });
    }
    if (cs.transitionDuration && cs.transitionDuration !== '0s') {
      const durs = cs.transitionDuration.split(',').map((s) => s.trim());
      const props = cs.transitionProperty.split(',').map((s) => s.trim());
      const tim = cs.transitionTimingFunction.split(',').map((s) => s.trim());
      for (let i = 0; i < durs.length; i++) {
        if (durs[i] === '0s') continue;
        const key = (props[i] || props[0]) + '|' + durs[i] + '|' + (tim[i] || tim[0]);
        if (!transitions.has(key)) transitions.set(key, { property: props[i] || props[0], duration: durs[i], timing: tim[i] || tim[0], count: 0, sample: '' });
        const t = transitions.get(key); t.count++;
        if (!t.sample) t.sample = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '');
      }
    }

    if (cs.backdropFilter && cs.backdropFilter !== 'none') {
      glass.push({ selector: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''), backdropFilter: cs.backdropFilter, bg: cs.backgroundColor, w: Math.round(rect.width), h: Math.round(rect.height), areaPct: +(rect.width * rect.height / (innerWidth * innerHeight) * 100).toFixed(1) });
    }

    if (visible) {
      // 只計有直接文字嘅元素
      const directText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').trim();
      if (directText.length > 1) {
        const fs = parseFloat(cs.fontSize);
        bump(fontSizes, String(Math.round(fs * 2) / 2));
        const fg = toRgb(cs.color);
        if (fg) {
          const bg = bgOf(el);
          const r = ratio(fg, bg);
          contrasts.push({
            text: directText.slice(0, 28),
            selector: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''),
            fontSize: fs, fontWeight: cs.fontWeight, ratio: +r.toFixed(2),
            aa: r >= (fs >= 18 || (fs >= 14 && +cs.fontWeight >= 700) ? 3 : 4.5),
            fg: cs.color, bg: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
          });
        }
      }
    }

    // tap target：只計互動元素
    if (['BUTTON','A','INPUT','SELECT'].includes(el.tagName) && visible) {
      if (rect.width < 44 || rect.height < 44) {
        smallTargets.push({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 16), w: Math.round(rect.width), h: Math.round(rect.height) });
      }
    }
  }

  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  const mapBBox = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), areaPct: +(r.width * r.height / (innerWidth * innerHeight) * 100).toFixed(1) }; };

  const cs0 = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const p of ['--hud-cyan','--hud-danger','--hud-safe','--hud-amber','--hud-violet','--glass','--hairline','--bg-dark','--bg-mid','--fg-primary','--fg-muted','--accent-red','--accent-orange','--border','--transition','--transition-fast','--ease-out','--ease-in-out','--shadow-md','--sp-1','--r-md','--fs-xs']) {
    tokens[p] = cs0.getPropertyValue(p).trim();
  }

  return {
    theme: document.documentElement.getAttribute('data-theme'),
    url: location.href,
    innerWidth, innerHeight,
    bodyTextLength: document.body.innerText.length,
    colorCount: sortObj(colorCount),
    bgCount: sortObj(bgCount),
    borderCount: sortObj(borderCount),
    uniqueColor: Object.keys(colorCount).length,
    uniqueBg: Object.keys(bgCount).length,
    uniqueBorder: Object.keys(borderCount).length,
    anims, transitions: Array.from(transitions.values()).sort((a,b)=>b.count-a.count),
    animCount: anims.length,
    transitionCount: transitions.size,
    fontSizes: sortObj(fontSizes),
    glass,
    contrasts,
    contrastFail: contrasts.filter((c) => !c.aa).length,
    contrastTotal: contrasts.length,
    smallTargets,
    mapBBox: mapBBox('#svg-map-mount'),
    legendBBox: mapBBox('.map-overlay'),
    tokens,
    elementCount: all.length,
  };
})()`;

async function capture(browser, vp, theme, opts = {}) {
  const { reducedMotion = "no-preference", zoomSteps = 0, suffix = "" } = opts;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
    reducedMotion,
  });
  // 用 localStorage 決定主題（theme.ts 讀 'binggang-theme'）
  await context.addInitScript(
    ([t]) => {
      try { localStorage.setItem("binggang-theme", t); } catch {}
    },
    [theme],
  );

  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 核實主題真的套用（唔可以只信 localStorage）
  const applied = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));

  const audit = await page.evaluate(AUDIT_FN);

  const stem = `${theme}-${vp.id}${suffix}`;
  await page.screenshot({ path: path.join(SHOTS, `${stem}.png`), fullPage: false });
  await page.screenshot({ path: path.join(SHOTS, `${stem}-fullpage.png`), fullPage: true });

  // 最大 zoom：檢查 zone / label 喺 max zoom 下嘅清晰度
  let zoomInfo = null;
  if (zoomSteps > 0) {
    for (let i = 0; i < zoomSteps; i++) {
      const btn = await page.$("#map-zoom-in");
      if (!btn) break;
      await btn.click().catch(() => {});
      await page.waitForTimeout(160);
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, `${stem}-zoommax.png`), fullPage: false });
    zoomInfo = await page.evaluate(() => {
      const svg = document.querySelector("#svg-map-mount svg");
      const canvas = document.querySelector("#svg-map-mount canvas");
      return {
        viewBox: svg ? svg.getAttribute("viewBox") : null,
        zonePaths: document.querySelectorAll(".zone").length,
        zoneLabels: document.querySelectorAll(".zone-label").length,
        canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
        canvasCss: canvas ? { w: Math.round(canvas.getBoundingClientRect().width), h: Math.round(canvas.getBoundingClientRect().height) } : null,
      };
    });
  }

  await context.close();
  return { stem, applied, audit, zoomInfo, consoleErrors };
}

const main = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-proxy-server"],
  });

  const results = [];

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const r = await capture(browser, vp, theme);
      results.push({ viewport: vp.id, theme, ...r });
      console.log(`✓ ${theme} / ${vp.id} — applied=${r.applied} anim=${r.audit.animCount} trans=${r.audit.transitionCount} contrastFail=${r.audit.contrastFail}/${r.audit.contrastTotal}`);
    }
  }

  // reduced-motion 對照（desktop dark）
  const rm = await capture(browser, VIEWPORTS[0], "dark", { reducedMotion: "reduce", suffix: "-reducedmotion" });
  results.push({ viewport: "desktop", theme: "dark", reducedMotion: "reduce", ...rm });
  console.log(`✓ dark / desktop reduced-motion — anim=${rm.audit.animCount}`);

  // max zoom（desktop dark）
  const zm = await capture(browser, VIEWPORTS[0], "dark", { zoomSteps: 16, suffix: "-zoom" });
  results.push({ viewport: "desktop", theme: "dark", zoom: 16, ...zm });
  console.log(`✓ dark / desktop zoommax — ${JSON.stringify(zm.zoomInfo)}`);

  await browser.close();

  fs.writeFileSync(path.join(OUT, "theme-audit.json"), JSON.stringify(results, null, 2), "utf8");
  console.log(`\n寫入 ${path.join(OUT, "theme-audit.json")}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
