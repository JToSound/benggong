import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
await p.goto("http://localhost:5176/", { waitUntil: "networkidle" });
await p.waitForTimeout(2500);
await p.evaluate(async () => {
  const toggles = Array.from(document.querySelectorAll(".chr-toggle"));
  for (const t of toggles.slice(0, 200)) {
    t.click(); await new Promise(r => setTimeout(r, 35));
    if (document.querySelectorAll(".chr-link").length >= 2) break;
  }
});
await p.waitForTimeout(800);
await p.screenshot({ path: "C:/Users/User/AppData/Local/Temp/benggong-phase-i-final/chronicle-v2.png" });
await b.close();
