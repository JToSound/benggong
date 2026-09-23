/**
 * diag5-strip-overflow.mjs — 釘實 `body.scrollWidth > viewport` 嘅根因。
 *
 * 背景：P1-1 將 `.ch-pill` 由 30×24 改成 44×44 之後，實測
 * `body.scrollWidth = 1716–1726`（viewport 1400），但 `html.scrollWidth = 1400`、
 * `scrollLeft / window.scrollX = 0` → 唔影響互動。呢個腳本量清楚係邊個容器
 * 撐爆 body，同埋係唔係 `.strip-track` 嘅 flex `min-width: 0` 問題。
 *
 * 跑法：PREVIEW_URL=http://localhost:5195/ node artifacts/b8-scratch/diag5-strip-overflow.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PREVIEW_URL || "http://localhost:5195/";
const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE, { waitUntil: "networkidle" });
// 等全部 198 粒 pill render 完（關鍵：太早量會量唔到溢出）
await page
  .waitForFunction(() => document.querySelectorAll(".ch-pill").length >= 198, { timeout: 20_000 })
  .catch(() => {});
await page.waitForTimeout(800);

const r = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel,
      x: Math.round(b.x),
      right: Math.round(b.right),
      w: Math.round(b.width),
      clientW: el.clientWidth,
      scrollW: el.scrollWidth,
      overflowX: cs.overflowX,
      minWidth: cs.minWidth,
      flex: cs.flex,
      display: cs.display,
    };
  };
  // 搵全頁 right 最大嘅元素（唔理 overflow 祖先）
  let maxRight = 0;
  let maxEl = null;
  document.querySelectorAll("*").forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) return;
    if (b.right > maxRight) {
      maxRight = b.right;
      maxEl = `${el.tagName}${el.id ? "#" + el.id : ""}${
        typeof el.className === "string" && el.className ? "." + el.className.split(/\s+/)[0] : ""
      }`;
    }
  });
  return {
    viewport: document.documentElement.clientWidth,
    htmlScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
    pillCount: document.querySelectorAll(".ch-pill").length,
    maxRight: Math.round(maxRight),
    maxEl,
    chain: [
      box("#chapter-strip-mount"),
      box(".chapter-strip"),
      box(".strip-track"),
      box("#strip-track"),
      box(".strip-current"),
    ].filter(Boolean),
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
