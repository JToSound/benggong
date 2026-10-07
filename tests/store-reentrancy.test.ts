// P1-6-9 —— 狀態變更處理器內再寫狀態（re-entrancy）通用守衛
//
// 為何要有呢個檔
// ==============
// MEMORY 教訓 #27：`store.notify()` 係**同步** for-loop。訂閱者（例如
// `App.onStateChange()`）喺 handler 內再 `setXxx()` 時，`commit()` 會
// **同步再入** —— 內層即刻派新狀態，但外層 for-loop 返嚟之後會繼續用
// **舊嘅 `next`** 派畀後面嘅訂閱者 → 佢哋「先新後舊」= **舊蓋新** ✗。
//
// 實測事故：`is-collapsed` 被加返，pane 明明 `data-sheet-snap="half"`
// 但仍然 `visibility: hidden`（撳「編年史」完全冇反應）。
//
// `src/state/store.ts` 嘅 `notify()` 已改為**巢狀通知排隊 ＋ 外層 drain**。
// 本檔將呢個保證變成可重跑斷言。
//
// ⚠️ 對照：如果冇咗呢個守衛，下面嘅「最後觀察值」會係**舊**狀態（紅）。

import { describe, expect, it, vi } from "vitest";
import { createAppStore } from "../src/state/store";

describe("P1-6-9：狀態處理器內再寫狀態（re-entrancy）", () => {
  it("⭐ 巢狀寫入之後，後面嘅訂閱者唔會收到舊狀態（舊蓋新）", () => {
    const store = createAppStore();
    store.setSheetSnap("peek"); // 起始：peek（同下面巢狀寫入嘅值唔同）

    const bSeen: string[] = [];
    let wrote = false;
    // 訂閱者 A：第一次收到通知就**巢狀寫入**（模擬 App 自動開 pane）
    store.subscribe(() => {
      if (!wrote) {
        wrote = true;
        store.setSheetSnap("half");
      }
    });
    // 訂閱者 B：記錄佢收到嘅每一個 sheetSnap
    store.subscribe((s) => bSeen.push(s.sheetSnap));

    store.setChapter(5); // 觸發通知

    /*
     * 舊行為：B 會收到 "half"（內層）然後 "peek"（外層用舊 next）→
     *         最後觀察值 = "peek" ✗（舊蓋新）。
     * 新行為：B 收到 "peek" 然後 "half" → 最後觀察值 = "half" ✓。
     */
    expect(bSeen, "B 收到嘅序列").toEqual(["peek", "half"]);
    expect(bSeen[bSeen.length - 1], "B 最後觀察到嘅一定係最新值").toBe("half");
    expect(store.getState().sheetSnap, "store 最終狀態").toBe("half");
  });

  it("⭐ 觀察序列一定係單調（唔會出現「新之後又舊」）", () => {
    const store = createAppStore({ chapterTotal: 10 });
    const seen: number[] = [];
    let bumps = 0;
    store.subscribe((s) => {
      seen.push(s.chapter);
      if (bumps < 3) {
        bumps++;
        store.setChapter(s.chapter + 1); // 巢狀寫入
      }
    });

    store.setChapter(2);

    for (let i = 1; i < seen.length; i++) {
      expect(
        seen[i],
        `觀察序列要非遞減（實測 ${seen.join(" → ")}）`,
      ).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(seen, "應該逐級遞增").toEqual([2, 3, 4, 5]);
    expect(store.getState().chapter).toBe(5);
  });

  it("單次變更 → 訂閱者只收一次（冇巢狀時唔應該多派）", () => {
    const store = createAppStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.setChapter(7);
    expect(calls).toBe(1);
  });

  it("訂閱者無條件寫狀態 → 有界（唔會 stack overflow）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createAppStore();
    store.setSheetSnap("peek"); // 令下面每次寫入都真係「有變」
    let calls = 0;
    store.subscribe(() => {
      calls++;
      // 每次都寫入一個「唔同」嘅值 → 理論上無限
      store.setSheetSnap(calls % 2 === 1 ? "half" : "peek");
    });
    expect(() => store.setChapter(2), "唔應該 stack overflow").not.toThrow();
    expect(calls, "要喺安全上限內中止").toBeLessThanOrEqual(101);
    expect(warn, "應該出警告").toHaveBeenCalled();
    warn.mockRestore();
  });

  it("通知期間退訂唔會令 drain 卡住", () => {
    const store = createAppStore();
    const seen: number[] = [];
    const holder: { off?: () => void } = {};
    holder.off = store.subscribe((s) => {
      seen.push(s.chapter);
      holder.off?.(); // 收一次就退訂
    });
    store.setChapter(3);
    store.setChapter(4);
    expect(seen).toEqual([3]);
  });
});
