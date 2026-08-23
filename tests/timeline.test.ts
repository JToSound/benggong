// 時間軸入口最小測試 — Phase D 將擴充完整前端測試
import { describe, expect, it } from "vitest";
import { initTimeline } from "../src/timeline";

describe("initTimeline", () => {
  it("回傳 ready 狀態字串", () => {
    expect(initTimeline()).toBe("timeline-ready");
  });
});
