/**
 * B2 — Legacy alias 測試（`#ch=` / `#loc=`）
 *
 * 紅線：`tests/visual-smoke.e2e.test.ts` 依賴 `#ch=150`（migration plan §6.2
 * 「必須保留（唔可以誤刪）」）。呢個測試係嗰條紅線嘅自動化證據。
 *
 * 規則（IA §3.2 rule 2–4）：
 *   - `#ch=<n>`  → `?chapter=<n>`
 *   - `#loc=<id>` → `?location=<id>`
 *   - precedence：`?chapter=` > `#ch=`；`?location=` > `#loc=`
 *   - 寫入一律 canonical query，**唔會**同時有 `?chapter=150#ch=150`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromUrl, isCanonical, toUrl } from "../src/state";

const BASE = "http://localhost/";

function u(s: string): URL {
  return new URL(`${BASE}${s}`);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("legacy alias — #ch=", () => {
  it("#ch=150 → { kind:'chapter', issueIndex:150 }，chapter = 150", () => {
    const s = fromUrl(u("#ch=150"));
    expect(s.context).toEqual({ kind: "chapter", issueIndex: 150 });
    expect(s.chapter).toBe(150);
  });

  it("#ch=9999（超出範圍）→ 落回第 1 章 + explore", () => {
    const s = fromUrl(u("#ch=9999"));
    expect(s.chapter).toBe(1);
    expect(s.context).toEqual({ kind: "explore" });
  });

  it("#ch= 空 / 非數字 → 落回第 1 章", () => {
    expect(fromUrl(u("#ch=")).chapter).toBe(1);
    expect(fromUrl(u("#ch=abc")).chapter).toBe(1);
  });

  it("自訂 chapterTotal 會用嚟驗證（例如 50）", () => {
    expect(fromUrl(u("#ch=60"), { chapterTotal: 50 }).chapter).toBe(1);
    expect(fromUrl(u("#ch=40"), { chapterTotal: 50 }).chapter).toBe(40);
  });
});

describe("legacy alias — #loc=", () => {
  it("#loc=loc_0029 → { kind:'location', locationId }", () => {
    const s = fromUrl(u("#loc=loc_0029"));
    expect(s.context).toEqual({ kind: "location", locationId: "loc_0029" });
  });

  it("#ch=150&loc=loc_0029 → chapter 150 + location context", () => {
    const s = fromUrl(u("#ch=150&loc=loc_0029"));
    expect(s.chapter).toBe(150);
    expect(s.context).toEqual({ kind: "location", locationId: "loc_0029" });
  });

  it("#loc= 控制字元 → 忽略（唔會 throw）", () => {
    expect(() => fromUrl(u("#loc=%00%01"))).not.toThrow();
    expect(fromUrl(u("#loc=%00%01")).context).toEqual({ kind: "explore" });
  });
});

describe("legacy alias — precedence（rule 3）", () => {
  it("?chapter= 高過 #ch=", () => {
    expect(fromUrl(u("?chapter=5#ch=150")).chapter).toBe(5);
    expect(fromUrl(u("?chapter=5#ch=150")).context).toEqual({
      kind: "chapter",
      issueIndex: 5,
    });
  });

  it("?location= 高過 #loc=", () => {
    const s = fromUrl(u("?location=l1#loc=l2"));
    expect(s.context).toEqual({ kind: "location", locationId: "l1" });
  });

  it("?chapter= 無效時**唔會**退回 #ch=（canonical 存在即抑制 alias）", () => {
    const s = fromUrl(u("?chapter=99999#ch=150"));
    expect(s.chapter).toBe(1);
    expect(s.context).toEqual({ kind: "explore" });
  });

  it("hash + query 混用（A9 實測情境）唔會 throw", () => {
    expect(() => fromUrl(u("#ch=42&loc=x?event=y"))).not.toThrow();
    expect(() => fromUrl(u("#ch=42?view=chronicle"))).not.toThrow();
  });
});

describe("legacy alias — canonicalization（rule 4）", () => {
  it("#ch=150 序列化返做 canonical query（冇 hash）", () => {
    expect(toUrl(fromUrl(u("#ch=150")))).toBe("?chapter=150");
  });

  it("#loc=loc_0029 → ?location=loc_0029", () => {
    expect(toUrl(fromUrl(u("#loc=loc_0029")))).toBe("?location=loc_0029");
  });

  it("#ch=150&loc=loc_0029 → ?location=loc_0029&chapter=150", () => {
    expect(toUrl(fromUrl(u("#ch=150&loc=loc_0029")))).toBe(
      "?location=loc_0029&chapter=150",
    );
  });

  it("canonical 形式唔會同時出現 ?chapter= 同 #ch=", () => {
    const canonical = toUrl(fromUrl(u("#ch=150")));
    expect(canonical).not.toContain("#");
    expect(canonical).not.toContain("ch=");
  });

  it("isCanonical：query 形式 true、hash 形式 false", () => {
    expect(isCanonical(u("?chapter=150"))).toBe(true);
    expect(isCanonical(u("#ch=150"))).toBe(false);
    expect(isCanonical(u("?chapter=150#ch=150"))).toBe(false);
  });
});
