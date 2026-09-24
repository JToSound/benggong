// 圖層同步：SVG overlay 同 canvas 底圖必須喺**同一幀**更新
//
// 用戶報告（2026-09-24）
// ====================
// > 「移動嘅時候啲倖存區等等嘅光圈會漂移…『跟唔上』及移動時
// >   『同底圖分離』，明顯提到係兩層嘢。」
//
// 根因：`SvgMap.applyViewBox()` 係**同步**改 SVG `viewBox`（zone 光環／
// 標記即刻跟住郁），而 canvas 底圖（陸地／道路／建築）係經
// `scheduleDraw()` 排喺**下一個** rAF。`MapViewport` 本身已經用 rAF
// coalesce 指標事件，所以 `setView()` 係喺**一個 rAF callback 之內**被
// 呼叫 —— 再排一個 rAF 就係**下一幀** → canvas 落後 SVG 整整 1 個 frame。
//
// 實測（`artifacts/phase3-resume/probe-layer-sync.mjs`，25 次拖曳、
// 275 次 viewBox 變更）：
//
// | | 修復前 | 修復後 |
// |---|---|---|
// | 中位落後 | 3.4 ms | **−0.2 ms**（同幀） |
// | p90 | 17 ms | **−0.1 ms** |
// | >8 ms（跨 frame）比例 | **48%** | **9%** |
//
// ⚠️ 為何要靜態守門：呢個係**一行之差**（`drawNow()` vs `scheduleDraw()`），
// 而且改返去唔會令任何既有測試變紅 —— 只有真瀏覽器嘅時間量度捉得到。
// 所以一定要有結構守門。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/map/VectorBasemap.ts", "utf-8");

describe("圖層同步（SVG vs canvas）", () => {
  it("有 `drawNow()`（同步重繪，取消已排隊嘅 rAF）", () => {
    expect(SRC).toMatch(/private drawNow\(\): void \{/);
    const i = SRC.indexOf("private drawNow()");
    const body = SRC.slice(i, i + 400);
    expect(body, "要取消 pending rAF").toContain("cancelAnimationFrame(this.raf)");
    expect(body, "要同步繪製").toContain("this.draw()");
  });

  it("⭐ `setView()` 一定要用 `drawNow()`，唔可以 `scheduleDraw()`", () => {
    const i = SRC.indexOf("setView(view: ViewBox");
    expect(i, "搵唔到 setView").toBeGreaterThan(-1);
    // setView body 到 `ensureTiles()` 之後為止
    const body = SRC.slice(i, i + 1600);
    const end = body.indexOf("ensureTiles()");
    const tail = body.slice(end, end + 400);
    expect(tail, "setView 尾部一定要 drawNow()").toContain("this.drawNow()");
    expect(
      tail,
      "⚠️ setView 唔可以再 scheduleDraw() —— 會令 canvas 落後 1 個 frame",
    ).not.toContain("this.scheduleDraw()");
  });

  it("圖磚載入（async）路徑仍然用 `scheduleDraw()`", () => {
    // async 路徑唔喺 rAF 之內，同步重繪冇意義而且會重繪多次
    const i = SRC.indexOf("this.tilePoi.set(k, poi)");
    expect(i).toBeGreaterThan(-1);
    const body = SRC.slice(i, i + 700);
    expect(body).toContain("this.scheduleDraw()");
  });

  it("`draw()` 唔會呼叫 `emitReady()`（否則 drawNow → onReady → setView 會無限遞歸）", () => {
    const i = SRC.indexOf("private draw(): void {");
    expect(i).toBeGreaterThan(-1);
    const next = SRC.indexOf("\n  private ", i + 10);
    const body = SRC.slice(i, next > 0 ? next : i + 40000);
    expect(body).not.toContain("this.emitReady()");
  });
});
