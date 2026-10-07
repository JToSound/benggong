// D4-9 —— `docs/contracts/` 嘅 **class 契約**自動檢查
//
// 為何要有呢個檔
// ==============
// D4-3 指出一個判斷盲點：「`docs/` 提及唔算使用」（因為文件提及唔代表
// 執行期會出現）。但反過來：如果 `docs/contracts/` **明文要求**某個 class
// 必須存在，就唔應該靠人記得 —— 否則一次 `prune_dead_css.py` 就會
// 靜默刪走佢 ✗。
//
// 所以本檔令契約**可執行**：
//   1. `docs/contracts/class-contract.json` 係 machine-readable（每個 entry
//      有 `reason` ＋ `producedBy`）；
//   2. 每個契約 class 必須**真係**有 `.class` 選擇器喺目標 CSS；
//   3. `audit_dead_css.py` / `prune_dead_css.py` 都要**讀呢個契約**
//      （列入嘅一律唔判死、唔剪）；
//   4. CI 要**帶 `--contract`** 跑（唔靠 default 值碰巧正確）。
//
// 全部程式化、可重跑、零人手。

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CONTRACT = "docs/contracts/class-contract.json";
const TARGET = "src/styles/legacy-migrated.css";

interface Entry {
  producedBy: string;
  reason: string;
}
const contract = JSON.parse(readFileSync(CONTRACT, "utf-8")) as {
  target: string;
  entries: Record<string, Entry>;
};
const css = readFileSync(TARGET, "utf-8");

/** 目標 CSS 內有冇 `.cls` 選擇器（詞邊界，唔會誤中 `.cls-extra`）。 */
function hasSelector(src: string, cls: string): boolean {
  return new RegExp(`\\.${cls}(?![\\w-])`).test(src);
}

describe("D4-9：class 契約（必須存在）", () => {
  it("契約檔格式正確（每個 entry 有 reason ＋ producedBy，而且檔案存在）", () => {
    expect(contract.target, "契約要指明目標 CSS").toBe(TARGET);
    const names = Object.keys(contract.entries);
    expect(names.length, "契約唔應該係空").toBeGreaterThan(0);
    for (const [cls, e] of Object.entries(contract.entries)) {
      expect(e.reason?.trim(), `${cls} 要有非空 reason`).toBeTruthy();
      expect(e.producedBy?.trim(), `${cls} 要有 producedBy`).toBeTruthy();
      expect(
        existsSync(e.producedBy),
        `${cls} 嘅 producedBy（${e.producedBy}）要存在`,
      ).toBe(true);
    }
  });

  it("⭐ 每個契約 class 都真係存在（唔會被誤刪）", () => {
    const missing = Object.keys(contract.entries).filter((c) => !hasSelector(css, c));
    expect(
      missing,
      `契約要求存在但目標 CSS 冇咗：${missing.join(", ")}\n` +
        "（如果真係要刪，先改 docs/contracts/class-contract.json）",
    ).toEqual([]);
  });

  it("⭐ 對照：偵測器捉得到唔存在嘅 class（唔係恆真）", () => {
    expect(hasSelector(css, "zzz-definitely-not-a-real-class")).toBe(false);
    // 邊界：`bg-error`（已剪）唔應該令 `bg-error-panel` 誤中，反之亦然
    expect(hasSelector(".bg-error-panel{x:1}", "bg-error")).toBe(false);
    expect(hasSelector(".bg-error{x:1}", "bg-error-panel")).toBe(false);
  });

  it("分析／剪除工具都讀呢個契約（D4-9 閉環）", () => {
    const audit = readFileSync("scripts/audit_dead_css.py", "utf-8");
    const prune = readFileSync("scripts/prune_dead_css.py", "utf-8");
    for (const [name, src] of [
      ["audit_dead_css.py", audit],
      ["prune_dead_css.py", prune],
    ] as const) {
      expect(src, `${name} 要認得 class-contract.json`).toMatch(/class-contract\.json/);
      expect(src, `${name} 要支援 --contract`).toMatch(/--contract/);
    }
    // audit 要將契約 class 判為 "contract" 而唔係 "dead"
    expect(audit).toMatch(/verdict\s*=\s*"contract"/);
  });

  it("CI 帶 --contract 跑（唔靠 default 碰巧正確）", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf-8");
    expect(ci, "CI 要跑 audit_dead_css.py").toMatch(/audit_dead_css\.py/);
    expect(ci, "CI 要帶 --contract").toMatch(/--contract\s+docs\/contracts\/class-contract\.json/);
    expect(ci, "CI 要帶 --fail-on-dead").toMatch(/--fail-on-dead/);
  });
});
