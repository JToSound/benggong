// 診斷：為何 #search-input 收唔到 focus
import { chromium } from "@playwright/test";

const URL = "http://localhost:5175/";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(URL, { waitUntil: "networkidle" });

  const diag = await page.evaluate(() => {
    const shell = document.getElementById("search-shell");
    const appRoot = document.getElementById("app-root");
    return {
      shellExists: !!shell,
      shellHasPopoverAttr: shell?.hasAttribute("popover"),
      showPopoverFn: typeof shell?.showPopover,
      shellIsOpen: shell?.matches(":popover-open") ?? null,
      appRootTag: appRoot?.tagName,
      supportsPopover: CSS.supports("position-anchor: auto"),
      supportsAnchorName: CSS.supports("anchor-name: auto"),
    };
  });
  console.log("BEFORE OPEN:", JSON.stringify(diag, null, 2));

  await page.click("#btn-search");
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => {
    const shell = document.getElementById("search-shell");
    const overlay = document.getElementById("search-overlay");
    const input = document.getElementById("search-input");
    return {
      shellIsOpen: shell?.matches(":popover-open") ?? null,
      overlayExists: !!overlay,
      overlayOpenClass: overlay?.classList.contains("is-open"),
      overlayParentId: overlay?.parentElement?.id,
      overlayOffsetParent: overlay?.offsetParent !== null,
      inputExists: !!input,
      inputDisabled: input?.disabled,
      inputTabIndex: input?.tabIndex,
      activeEl: document.activeElement?.tagName + "#" + document.activeElement?.id,
      appRootInert: document.getElementById("app-root")?.hasAttribute("inert"),
      inputRect: input?.getBoundingClientRect().toJSON(),
    };
  });
  console.log("AFTER OPEN:", JSON.stringify(after, null, 2));

  await browser.close();
})();
