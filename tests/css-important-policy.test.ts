// D 階段 2 —— CSS `!important` 契約（防止再次蔓延）
//
// 為何要有呢個檔
// ==============
// 2026-10-05 P1-6 實測事故：新規則
// `.workspace.is-pane-open #map-controls { right: … }`（特異度 (1,2,0)）
// 明明高過 `mobile.css` 嘅 `#map-controls { right: … !important }`（(1,0,0)），
// 但仍然**靜默輸** —— 因為 `!important` 之間才比特異度，而**有 `!important`
// 就贏冇 `!important`**。要量 `getComputedStyle()` 才捉得到。
//
// 所以 `!important` 唔可以自由增加：每一條都要有**書面理由**。
// 本檔把呢個規則變成可重跑斷言：
//   · 清點 V2 自有 stylesheet（`legacy-migrated.css` 豁免 —— 舊檔原文照搬）
//     所有 `!important`，key = `file:line:property`；
//   · 同 `docs/contracts/css-important-allowlist.json` 對比，**兩邊都要相等**
//     （新加未登記 → 紅；登記咗但已刪 → 紅，避免 stale entry）；
//   · 每一條都要有非空 `reason`。
//
// 維護方式（改完 CSS 之後）：
//   C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe \
//     scripts/audit_css_important.py \
//     --json artifacts/phase3-resume/important-inventory.json \
//     --allowlist docs/contracts/css-important-allowlist.json
//
// ⚠️ 本檔係**靜態原始碼契約**，唔係瀏覽器行為證據。
// 「移除某條 `!important` 會唔會改變畫面」由
// `artifacts/phase3-resume/probe-css-important.mjs` 實測（真 Chromium，
// 4 個 config × 153 個 computed value 量度）。

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STYLES_DIR = "src/styles";
const ALLOWLIST = "docs/contracts/css-important-allowlist.json";

/** 舊檔原文照搬 —— 豁免（唔可以改，改咗就唔係「原文」）。 */
const EXEMPT = new Set(["legacy-migrated.css"]);

interface Found {
  key: string;
  file: string;
  line: number;
  property: string;
  media: string;
}

/**
 * 抽出 `file:line:property` 形式嘅 `!important` key。
 *
 * ⚠️ `line` 用**規則起始行**（`{` 之前嗰行），同
 * `scripts/audit_css_important.py` 一致 —— 兩邊唔一致會令契約對唔上。
 */
function scanImportant(file: string, raw: string): Found[] {
  // 去註解但保留換行（令行號唔飄）
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1));
  const out: Found[] = [];
  const stack: Array<{ kind: "at" | "rule"; head: string; line: number }> = [];
  let buf = "";
  let line = 1;
  let ruleLine = 1;

  for (const ch of text) {
    if (ch === "\n") line++;
    if (ch === "{") {
      const head = buf.trim();
      stack.push({
        kind: head.startsWith("@") ? "at" : "rule",
        head,
        line: ruleLine,
      });
      buf = "";
      ruleLine = line;
      continue;
    }
    if (ch === "}") {
      buf = "";
      stack.pop();
      continue;
    }
    if (ch === ";") {
      const decl = buf.trim();
      buf = "";
      const top = stack[stack.length - 1];
      if (top && top.kind === "rule" && /!important/i.test(decl)) {
        const m = /^\s*([a-zA-Z-]+)\s*:/.exec(decl);
        if (m) {
          out.push({
            key: `${file}:${top.line}:${m[1].toLowerCase()}`,
            file,
            line: top.line,
            property: m[1].toLowerCase(),
            media: stack
              .filter((s) => s.kind === "at")
              .map((s) => s.head.replace(/^@media\s*/, ""))
              .join(" "),
          });
        }
      }
      continue;
    }
    buf += ch;
  }
  return out;
}

const files = readdirSync(STYLES_DIR).filter(
  (f) => f.endsWith(".css") && !EXEMPT.has(f),
);
const found: Found[] = files.flatMap((f) =>
  scanImportant(f, readFileSync(`${STYLES_DIR}/${f}`, "utf-8")),
);

interface AllowEntry {
  file: string;
  line: number;
  property: string;
  selector: string;
  media: string;
  reason: string;
}
const allow = JSON.parse(readFileSync(ALLOWLIST, "utf-8")) as {
  exempt: string[];
  entries: Record<string, AllowEntry>;
};

describe("D 階段 2：CSS !important 契約", () => {
  it("豁免清單同掃描範圍一致（legacy-migrated.css 唔會被掃）", () => {
    expect(allow.exempt).toContain("legacy-migrated.css");
    expect(files).not.toContain("legacy-migrated.css");
    // 掃描到嘢（否則呢個測試係空轉）
    expect(found.length).toBeGreaterThan(0);
  });

  it("⭐ 冇未登記嘅 !important（新增一定要連理由登記）", () => {
    const unlisted = found.filter((f) => !(f.key in allow.entries));
    expect(
      unlisted,
      `有 ${unlisted.length} 條 !important 未登記落 ${ALLOWLIST}：\n` +
        unlisted
          .map((u) => `  ${u.key}  (${u.media || "冇 media"})`)
          .join("\n") +
        "\n（維護方式見本檔頂部註解）",
    ).toEqual([]);
  });

  it("⭐ 冇 stale 登記（登記咗但原始碼已經冇咗）", () => {
    const keys = new Set(found.map((f) => f.key));
    const stale = Object.keys(allow.entries).filter((k) => !keys.has(k));
    expect(stale, `allowlist 有 ${stale.length} 條已經唔存在：${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("每一條都有非空理由", () => {
    const noReason = Object.entries(allow.entries)
      .filter(([, v]) => !v.reason || v.reason.trim() === "" || v.reason === "(冇 section 註解)")
      .map(([k]) => k);
    expect(noReason, `以下條目冇理由：${noReason.join(", ")}`).toEqual([]);
  });

  it("登記嘅 line / property 同原始碼一致（唔可以張冠李戴）", () => {
    const byKey = new Map(found.map((f) => [f.key, f]));
    const mismatch: string[] = [];
    for (const [k, v] of Object.entries(allow.entries)) {
      const f = byKey.get(k);
      if (!f) continue; // stale 由上面嘅測試覆蓋
      if (f.property !== v.property) mismatch.push(`${k} property ${v.property} → ${f.property}`);
    }
    expect(mismatch).toEqual([]);
  });
});
