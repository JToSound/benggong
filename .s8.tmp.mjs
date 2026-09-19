import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e).slice(0, 100)));
await p.goto("http://localhost:5176/", { waitUntil: "networkidle" });
await p.waitForTimeout(2500);
const s = await p.evaluate(() => ({
  periods: Array.from(document.querySelectorAll(".chr-period-title")).map(t => t.textContent.replace(/\s+/g," ").trim()),
  entries: document.querySelectorAll(".chr-entry").length,
  flash: document.querySelectorAll(".chr-entry.is-flashback").length,
}));
console.log(JSON.stringify(s, null, 1));
// 搵有伏筆連結嘅條目
const found = await p.evaluate(async () => {
  const toggles = Array.from(document.querySelectorAll(".chr-toggle"));
  for (const t of toggles.slice(0, 150)) {
    t.click(); await new Promise(r => setTimeout(r, 50));
    const links = document.querySelectorAll(".chr-link");
    if (links.length) return { title: t.closest(".chr-entry")?.querySelector(".chr-entry-title")?.textContent?.trim(), links: links.length, sample: Array.from(links).slice(0,3).map(x=>x.textContent.trim()) };
  }
  return { title: null, links: 0 };
});
console.log("伏筆連結樣本:", JSON.stringify(found, null, 1));
await p.screenshot({ path: "C:/Users/User/AppData/Local/Temp/benggong-phase-i-final/chronicle-final3.png" });
console.log("errors:", errs.length ? errs : "無");
await b.close();
