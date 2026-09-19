import { chromium } from "@playwright/test";

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
p.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text().slice(0, 120));
});

await p.goto("http://localhost:5176/", { waitUntil: "networkidle" });
await p.waitForTimeout(2500);

const s = await p.evaluate(() => ({
  periods: Array.from(document.querySelectorAll(".chr-period-title")).map((t) =>
    t.textContent.replace(/\s+/g, " ").trim(),
  ),
  timelineBars: document.querySelectorAll(".chr-tl-bar").length,
  timelineColored: document.querySelectorAll(
    ".chr-tl-bar.is-basecamp, .chr-tl-bar.is-lohas, .chr-tl-bar.is-endgame, .chr-tl-bar.is-early",
  ).length,
  exportBtn: Boolean(document.querySelector("#chr-export-json")),
  entries: document.querySelectorAll(".chr-entry").length,
}));
console.log("時間軸 + 匯出:", JSON.stringify(s, null, 1));

// 測試時間軸點擊 → 篩選
const filtered = await p.evaluate(async () => {
  const bars = document.querySelectorAll(".chr-tl-bar");
  const bar = bars[50];
  if (!bar) return null;
  bar.click();
  await new Promise((r) => setTimeout(r, 500));
  return {
    count: document.querySelector(".chronicle-count")?.textContent?.trim(),
    entries: document.querySelectorAll(".chr-entry").length,
    clear: Boolean(document.querySelector("#chr-clear-filter")),
  };
});
console.log("點時間軸後:", JSON.stringify(filtered));

// 測試匯出（攔截下載）
await p.evaluate(() => {
  document.querySelector("#chr-clear-filter")?.click();
});
await p.waitForTimeout(400);
const dl = await p.evaluate(() => {
  let captured = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (blob) => {
    captured = blob.size;
    return orig.call(URL, blob);
  };
  document.querySelector("#chr-export-json")?.click();
  URL.createObjectURL = orig;
  return captured;
});
console.log("匯出 JSON blob 大小:", dl, "bytes");

await p.screenshot({
  path: "C:/Users/User/AppData/Local/Temp/benggong-phase-i-final/chronicle-timeline.png",
});
console.log("errors:", errs.length ? errs : "無");
await b.close();
