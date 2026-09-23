// 比較方案：唔用 popover，直接將 search-shell 掛喺 body
import { chromium } from "@playwright/test";

const URL = "http://localhost:5175/";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // 攔截：喺 app 載入前，將 #search-shell 移出 #app-root（改為 body 子節點）
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const move = () => {
        const shell = document.getElementById("search-shell");
        const appRoot = document.getElementById("app-root");
        if (shell && appRoot && shell.parentElement === appRoot && document.body) {
          // 停用 popover，純靠 position:fixed + z-index
          shell.removeAttribute("popover");
          document.body.appendChild(shell);
        }
      };
      const t = setInterval(move, 10);
      setTimeout(() => clearInterval(t), 5000);
    });
  });

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.click("#btn-search");
  await page.waitForTimeout(300);

  const res = await page.evaluate(() => ({
    activeEl: document.activeElement?.tagName + "#" + (document.activeElement?.id ?? ""),
    appRootInert: document.getElementById("app-root")?.hasAttribute("inert"),
    overlayInBody: document.getElementById("search-shell")?.parentElement === document.body,
  }));
  console.log("方案 B（移出 #app-root，唔用 popover）:", JSON.stringify(res, null, 2));

  // 打字
  await page.keyboard.type("區");
  await page.waitForTimeout(300);
  const r2 = await page.evaluate(() => ({
    heads: [...document.querySelectorAll(".search-group-head")].map((e) => e.textContent),
    count: document.querySelectorAll(".search-result-item").length,
  }));
  console.log("打「區」:", JSON.stringify(r2, null, 2));

  await browser.close();
})();
