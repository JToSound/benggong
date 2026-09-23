/**
 * A2 dead-CSS 偵測：把三份 CSS 嘅 class / id selector 抽出來，
 * 喺實際 DOM 檢查有冇任何元素匹配。只讀 production，只寫 artifacts/audit-A2/。
 *
 * 執行：node artifacts/audit-A2/dead-css-probe.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const FILES = ["src/styles/main.css", "src/styles/hud.css", "src/styles/timeline.css"];

// 抽出 CSS 選擇器裡面嘅 class / id（粗略但可稽核：只取 .foo / #foo token）
const classTokens = new Set();
const idTokens = new Set();
for (const f of FILES) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classTokens.add(m[1]);
  for (const m of src.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) idTokens.add(m[1]);
}
const classes = [...classTokens].filter((c) => c.length > 2);
const ids = [...idTokens].filter((c) => c.length > 2);
console.log(`CSS 抽出 class tokens: ${classes.length}, id tokens: ${ids.length}`);

const b = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-HK" });
await ctx.addInitScript(() => { try { localStorage.setItem("binggang-theme", "dark"); } catch {} });
const p = await ctx.newPage();
await p.goto("http://localhost:5180/", { waitUntil: "load" });
await p.waitForTimeout(2500);

const res = await p.evaluate(
  ([cls, ids]) => {
    const deadCls = [], liveCls = [];
    for (const c of cls) {
      let n = 0;
      try { n = document.getElementsByClassName(c).length; } catch {}
      (n > 0 ? liveCls : deadCls).push(c);
    }
    const deadIds = [], liveIds = [];
    for (const i of ids) {
      let n = 0;
      try { n = document.querySelectorAll("#" + CSS.escape(i)).length; } catch {}
      (n > 0 ? liveIds : deadIds).push(i);
    }
    return { deadCls, liveCls, deadIds, liveIds };
  },
  [classes, ids],
);

console.log(`\n預設視圖（dark desktop, chronicle mode）`);
console.log(`live class: ${res.liveCls.length} / dead class: ${res.deadCls.length}`);
console.log(`live id:    ${res.liveIds.length} / dead id:    ${res.deadIds.length}`);
console.log(`\nlive ids: ${JSON.stringify(res.liveIds)}`);
console.log(`\ndead class 樣本 (${res.deadCls.length}): ${JSON.stringify(res.deadCls.slice(0, 90))}`);

// 再測 chapter mode（可能啟用另一批 class）
await p.click("#btn-mode").catch(() => {});
await p.waitForTimeout(1500);
const res2 = await p.evaluate(
  ([cls]) => {
    const live = [];
    for (const c of cls) { try { if (document.getElementsByClassName(c).length > 0) live.push(c); } catch {} }
    return live;
  },
  [classes],
);
console.log(`\nchapter mode live class: ${res2.length}`);
console.log(`chapter-only 新增 live: ${JSON.stringify(res2.filter((c) => !res.liveCls.includes(c)))}`);

const allLive = new Set([...res.liveCls, ...res2]);
const stillDead = classes.filter((c) => !allLive.has(c));
console.log(`\n兩種視圖都 dead 嘅 class: ${stillDead.length} / ${classes.length}`);
console.log(JSON.stringify(stillDead));

fs.writeFileSync(
  "artifacts/audit-A2/dead-css.json",
  JSON.stringify({ classes, ids, chronicleMode: res, chapterModeLive: res2, stillDead }, null, 2),
  "utf8",
);
console.log("\n寫入 artifacts/audit-A2/dead-css.json");
await b.close();
