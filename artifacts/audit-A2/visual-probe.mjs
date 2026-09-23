/**
 * A2 深度探測：pseudo-element 動效、地圖圖層計數、對比失敗分佈、
 * tap target 分佈、zone dossier / chronicle 視覺狀態。
 *
 * 只讀 production，只寫 artifacts/audit-A2/。
 * 執行：node artifacts/audit-A2/visual-probe.mjs
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5180/";
const OUT = "artifacts/audit-A2";
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const PROBE = `(() => {
  const toRgb = (s) => {
    if (!s || s === 'transparent') return null;
    const m = s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    const a = p.length > 3 ? p[3] : 1;
    if (a === 0) return null;
    return { r: p[0], g: p[1], b: p[2], a };
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1,l2), lo = Math.min(l1,l2); return (hi+0.05)/(lo+0.05); };
  const blend = (fg, bg) => { const a = fg.a === undefined ? 1 : fg.a; return { r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a), a: 1 }; };
  const bgOf = (el) => {
    let n = el, acc = null;
    while (n && n !== document.documentElement) {
      const c = toRgb(getComputedStyle(n).backgroundColor);
      if (c) { acc = acc ? blend(acc, c) : c; if ((c.a === undefined ? 1 : c.a) >= 0.98) break; }
      n = n.parentElement;
    }
    if (!acc) acc = { r: 255, g: 255, b: 255, a: 1 };
    return acc;
  };

  const all = Array.from(document.querySelectorAll('*'));

  // ---- pseudo-element 動效（querySelectorAll('*') 捉唔到）----
  const pseudoAnims = [];
  for (const el of all) {
    for (const pe of ['::before','::after']) {
      const cs = getComputedStyle(el, pe);
      if (cs.content === 'none' && cs.animationName === 'none') continue;
      if (cs.animationName && cs.animationName !== 'none') {
        pseudoAnims.push({
          host: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''),
          pseudo: pe, name: cs.animationName, duration: cs.animationDuration,
          timing: cs.animationTimingFunction, iteration: cs.animationIterationCount,
        });
      }
    }
  }

  // ---- 地圖圖層實測 ----
  const q = (s) => document.querySelectorAll(s).length;
  const layers = {
    zones: q('.zone'), zoneAreas: q('.zone-area'), zonePulses: q('.zone-pulse'),
    zoneBadges: q('.zone-badge'), zoneLabels: q('.zone-label'),
    locationMarkers: q('.location-marker'), eventMarkers: q('.event-marker'),
    clusters: q('.location-marker-cluster'), routes: q('.route'), routeLines: q('path.route'),
    svgChildren: q('#svg-map-mount svg > *'),
  };
  const svg = document.querySelector('#svg-map-mount svg');
  const legendItems = Array.from(document.querySelectorAll('.legend-item')).map((el) => ({
    text: el.textContent.trim(),
    // 圖例記號嘅形狀／顏色（檢查「只靠色彩」）
    swatchTag: (el.querySelector('.dot, .area, .line') || {}).className || null,
    swatchColor: (() => { const s = el.querySelector('.dot, .area, .line'); return s ? getComputedStyle(s).color + ' / border:' + getComputedStyle(s).borderColor + ' / bg:' + getComputedStyle(s).backgroundColor : null; })(),
    swatchShape: (() => { const s = el.querySelector('.dot, .area, .line'); if (!s) return null; const cs = getComputedStyle(s); return { w: Math.round(s.getBoundingClientRect().width), h: Math.round(s.getBoundingClientRect().height), radius: cs.borderRadius, style: cs.borderStyle }; })(),
  }));

  // ---- 對比失敗分佈 ----
  const fails = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0) continue;
    const t = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').trim();
    if (t.length < 2) continue;
    const fg = toRgb(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const cr = ratio(fg, bg);
    const fs = parseFloat(cs.fontSize);
    const need = (fs >= 18 || (fs >= 14 && +cs.fontWeight >= 700)) ? 3 : 4.5;
    if (cr < need) {
      fails.push({ text: t.slice(0, 24), cls: (typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') || el.tagName.toLowerCase(), fs, fw: cs.fontWeight, ratio: +cr.toFixed(2), need, fg: cs.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')' });
    }
  }
  const failByClass = {};
  for (const f of fails) failByClass[f.cls] = (failByClass[f.cls] || 0) + 1;

  // ---- tap target 分佈 ----
  const targets = [];
  for (const el of all) {
    if (!['BUTTON','A','INPUT','SELECT'].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(el).display === 'none') continue;
    targets.push({ cls: (typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '') || el.tagName.toLowerCase(), id: el.id || '', w: Math.round(r.width), h: Math.round(r.height) });
  }
  const targetByClass = {};
  for (const t of targets) {
    const k = t.cls + (t.id ? '#' + t.id : '');
    if (!targetByClass[k]) targetByClass[k] = { count: 0, minW: 999, minH: 999, fail44: 0 };
    const o = targetByClass[k]; o.count++;
    o.minW = Math.min(o.minW, t.w); o.minH = Math.min(o.minH, t.h);
    if (t.w < 44 || t.h < 44) o.fail44++;
  }

  return {
    theme: document.documentElement.getAttribute('data-theme'),
    pseudoAnims, layers, legendItems,
    viewBox: svg ? svg.getAttribute('viewBox') : null,
    failCount: fails.length, failByClass: Object.fromEntries(Object.entries(failByClass).sort((a,b)=>b[1]-a[1])),
    failSamples: fails.slice(0, 25),
    targetByClass: Object.fromEntries(Object.entries(targetByClass).sort((a,b)=>b[1].count-a[1].count)),
  };
})()`;

async function run(browser, theme, vp, fn, opts = {}) {
  const ctx = await browser.newContext({
    viewport: vp,
    deviceScaleFactor: 1,
    locale: "zh-HK",
    timezoneId: "Asia/Hong_Kong",
    reducedMotion: opts.reducedMotion || "no-preference",
  });
  await ctx.addInitScript(([t]) => { try { localStorage.setItem("binggang-theme", t); } catch {} }, [theme]);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "load", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const out = await fn(page);
  await ctx.close();
  return out;
}

const main = async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
  const desktop = { width: 1440, height: 900 };
  const mobile = { width: 390, height: 844 };
  const report = {};

  // 1) 預設視圖深度探測（dark desktop）
  report.darkDesktop = await run(browser, "dark", desktop, async (page) => page.evaluate(PROBE));
  console.log('✓ dark desktop probe: zones=' + report.darkDesktop.layers.zones + ' pseudoAnims=' + report.darkDesktop.pseudoAnims.length + ' fails=' + report.darkDesktop.failCount);

  // 2) light desktop
  report.lightDesktop = await run(browser, "light", desktop, async (page) => page.evaluate(PROBE));
  console.log('✓ light desktop probe: fails=' + report.lightDesktop.failCount);

  // 3) mobile tap target
  report.darkMobile = await run(browser, "dark", mobile, async (page) => page.evaluate(PROBE));
  console.log('✓ dark mobile probe: targets=' + Object.keys(report.darkMobile.targetByClass).length);

  // 4) light max zoom（同 dark 對比海面／無資料區）
  await run(browser, "light", desktop, async (page) => {
    for (let i = 0; i < 16; i++) { const b = await page.$("#map-zoom-in"); if (!b) break; await b.click().catch(() => {}); await page.waitForTimeout(150); }
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOTS, "light-desktop-zoommax.png") });
    const info = await page.evaluate(() => ({
      viewBox: document.querySelector('#svg-map-mount svg')?.getAttribute('viewBox'),
      zones: document.querySelectorAll('.zone').length,
      markers: document.querySelectorAll('.location-marker, .event-marker').length,
      routes: document.querySelectorAll('.route').length,
      zoomInDisabled: document.querySelector('#map-zoom-in')?.hasAttribute('disabled'),
      zoomInAria: document.querySelector('#map-zoom-in')?.getAttribute('aria-disabled'),
    }));
    report.lightZoomMax = info;
    console.log('✓ light zoommax: ' + JSON.stringify(info));
  });

  // 5) 打開 zone dossier（點地圖上 zone badge）
  await run(browser, "dark", desktop, async (page) => {
    const badge = await page.$('.zone-badge');
    if (badge) {
      await badge.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(SHOTS, "dark-desktop-zone-dossier.png") });
      report.zoneDossier = await page.evaluate(() => ({
        dossierVisible: !!document.querySelector('.zd'),
        zoneSelected: document.querySelectorAll('.zone.is-selected').length,
        panelText: (document.querySelector('.zone-dossier-mount')?.innerText || '').slice(0, 300),
        panelBBox: (() => { const e = document.querySelector('.zone-dossier-mount'); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }));
      console.log('✓ zone dossier: visible=' + report.zoneDossier.dossierVisible + ' selected=' + report.zoneDossier.zoneSelected);
    } else {
      report.zoneDossier = { dossierVisible: false, note: '預設視圖冇 .zone-badge（章節可見性 filter 之下冇 zone）' };
      console.log('⚠ 預設視圖冇 .zone-badge');
    }
  });

  // 6) chronicle 視圖
  await run(browser, "dark", desktop, async (page) => {
    const btn = await page.$('#btn-chronicle, [data-i18n="nav.chronicle"], button:has-text("編年史")');
    if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(1500); }
    await page.screenshot({ path: path.join(SHOTS, "dark-desktop-chronicle.png") });
    report.chronicle = await page.evaluate(() => ({
      cards: document.querySelectorAll('.chr-card, .chronicle-card, [class*=card]').length,
      view: document.querySelector('#app-root')?.className || null,
    }));
    console.log('✓ chronicle: ' + JSON.stringify(report.chronicle));
  });

  // 7) theme toggle 按鈕核實
  await run(browser, "light", desktop, async (page) => {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('#btn-theme').catch(() => {});
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const canvasStillDark = await page.evaluate(() => {
      const c = document.querySelector('#svg-map-mount canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height*0.75), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    report.themeToggle = { before, after, canvasSamplePixel: canvasStillDark };
    console.log('✓ theme toggle: ' + before + ' → ' + after + ' canvasPx=' + JSON.stringify(canvasStillDark));
  });

  await browser.close();
  fs.writeFileSync(path.join(OUT, "visual-probe.json"), JSON.stringify(report, null, 2), "utf8");
  console.log('寫入 ' + path.join(OUT, "visual-probe.json"));
};

main().catch((e) => { console.error(e); process.exit(1); });
