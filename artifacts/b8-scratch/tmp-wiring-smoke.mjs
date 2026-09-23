// 臨時煙霧測試（接線代理用；驗完即刪）
import { chromium } from "@playwright/test";

const URL = "http://localhost:5176/";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message));

  await page.goto(URL, { waitUntil: "networkidle" });

  const report = {};

  // 1. 元件有冇 mount
  report.sheetHandle = await page.locator(".sheet-handle").count();
  report.storySnap = await page.locator("#story-pane").getAttribute("data-sheet-snap");
  report.onboarding = await page.locator(".onboarding-card").count();
  report.searchShell = await page.locator("#search-shell").count();
  report.b8Css = await page.locator("#b8-mobile-css").count();

  // 2. 開搜尋（click #btn-search）
  await page.click("#btn-search");
  await page.waitForTimeout(200);
  report.overlayOpen = await page.locator(".search-overlay.is-open").count();
  report.appRootInert = await page.locator("#app-root[inert]").count();
  report.activeElAfterOpen = await page.evaluate(() => document.activeElement?.id ?? "none");

  // 3. 打字睇有冇 5 類結果
  await page.fill("#search-input", "區");
  await page.waitForTimeout(300);
  report.groupHeads = await page.locator(".search-group-head").allTextContents();
  report.resultCount = await page.locator(".search-result-item").count();

  // 4. ArrowDown + aria-activedescendant
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  report.activedescendant = await page.locator("#search-input").getAttribute("aria-activedescendant");

  // 5. Esc 關閉 + focus 還原
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  report.overlayAfterEsc = await page.locator(".search-overlay.is-open").count();
  report.activeElAfterEsc = await page.evaluate(() => document.activeElement?.id ?? "none");
  report.appRootInertAfter = await page.locator("#app-root[inert]").count();

  // 6. Esc 之後快捷鍵仍然生效（← →）
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  report.chapterAfterArrowRight = await page.evaluate(
    () => document.querySelector(".ch-pill[aria-current='true']")?.textContent?.trim() ?? "?",
  );

  // 7. sheet Esc 次序（half → peek）—— 用 store 直接切，唔靠隱藏掣
  await page.evaluate(() => {
    const el = document.querySelector("#story-pane");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    void el;
  });
  await page.waitForTimeout(200);
  report.snapAfterEsc1 = await page.locator("#story-pane").getAttribute("data-sheet-snap");
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await page.waitForTimeout(200);
  report.snapAfterEsc2 = await page.locator("#story-pane").getAttribute("data-sheet-snap");
  report.snapAfterEsc3 = await page.locator("#story-pane").getAttribute("data-sheet-snap");

  report.consoleErrors = errs.slice(0, 12);

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
