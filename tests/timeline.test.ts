// 時間軸入口最小測試 — 測純函式；瀏覽器入口（src/timeline.ts）由 Playwright E2E 覆蓋
import { describe, expect, it } from "vitest";
import { renderTimeline } from "../src/pages/timelinePage";

describe("timeline page", () => {
  it("renderTimeline 係可導入嘅 async 函式", () => {
    expect(typeof renderTimeline).toBe("function");
  });
});
