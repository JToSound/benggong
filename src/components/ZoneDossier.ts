/**
 * ZoneDossier — 區域檔案面板。
 *
 * 為何要一個獨立組件
 * ==================
 * 用戶明確要求每個倖存區／病窩要有「政權種類、人文風格、社會結構等等
 * 政治、民生、架構等等嘅詳細內容」。呢啲資料由
 * `scripts/merge_zone_dossiers.py` 從全文抽取，一共有 14 個欄位 ——
 * 塞入原本嘅 StoryPanel 會變成一坨文字。
 *
 * 所以：**分節 + 圖示 + 摺疊**，令用戶可以快速掃描，亦可以深入睇。
 *
 * 為何唔用 tab
 * ------------
 * Tab 會令用戶唔知道「仲有幾多內容未睇」。分節卡片全部展開（證據除外）
 * 可以一眼睇到全貌，亦可以用 Ctrl+F 搜尋 —— 對檔案式內容更重要。
 */

import type { App } from "../app";
import type { ZoneFeature, ZoneDossier as ZoneDossierRecord } from "../types/dataset";
import { loadZoneDossiers } from "../data/loadAllData";

/** 三種區域嘅視覺語言（同地圖上嘅顏色一致）。 */
const KIND_META: Record<
  string,
  { label: string; sub: string; color: string; glyph: string }
> = {
  survivor: {
    label: "倖存區",
    /*
     * ⚠️ F6（C5／C8 對抗驗收 2026-09-25）：原本寫死「人類聚居 · **安全**」。
     * 但 48 個 zone 之中只有 7 個 `validated`，31 個 `auto_inferred`、
     * 10 個 `needs_validation`；實測「心朗村」`confidence 0.4` 都顯示「安全」。
     * `DATA_GOVERNANCE.md §3` 明文「推測絕不可寫成事實」。
     * 所以只保留**唔需要證據**嘅描述（聚居形態），安全性交由下面嘅
     * `review_status` badge 誠實標示。
     */
    sub: "人類聚居",
    color: "#2fd6a8",
    glyph: "🛡",
  },
  nest: {
    label: "病窩",
    sub: "病者巢穴 · 危險",
    color: "#ff5a4d",
    glyph: "☣",
  },
  outpost: {
    label: "據點",
    sub: "敵對組織 · 控制區",
    color: "#a06bd8",
    glyph: "⚑",
  },
};

interface SectionDef {
  key: keyof ZoneFeature["properties"];
  title: string;
  icon: string;
  /** 陣列型欄位用 chip 顯示。 */
  list?: boolean;
}

const SECTIONS: SectionDef[] = [
  { key: "government", title: "政權", icon: "⚖" },
  { key: "leadership", title: "領袖與要員", icon: "★", list: true },
  { key: "social_structure", title: "社會結構", icon: "▤" },
  { key: "economy", title: "經濟", icon: "◈" },
  { key: "defense", title: "防禦", icon: "⛨" },
  { key: "population", title: "人口", icon: "◉" },
  { key: "culture", title: "人文風俗", icon: "✦" },
  { key: "notable_features", title: "地標與設施", icon: "◫", list: true },
  { key: "threats", title: "威脅", icon: "⚠", list: true },
];

/**
 * 誠實標示（F6）：`review_status` → 用戶睇得明嘅標籤 + 顏色。
 *
 * 為何要：`zones.geojson` 每個 zone 都有 `review_status`，但 UI 之前
 * **完全冇 render**（grep 全 `src/components/` 零命中）→ 用戶以為全部都係
 * 已核實事實。`needs_validation` 嘅 zone 一定要講清楚。
 */
const REVIEW_META: Record<string, { label: string; hint: string }> = {
  validated: { label: "已核實", hint: "多來源交叉核實" },
  auto_inferred: { label: "自動推斷", hint: "由規則／代理推斷，未經人手核實" },
  needs_validation: { label: "待核實", hint: "證據不足 —— 內容可能唔準確" },
};

/** dossier 巢狀欄位 → 中文標籤（順序固定，方便閱讀）。 */
const DOSSIER_GROUPS: Array<{ key: string; title: string; icon: string; fields: Record<string, string> }> = [
  { key: "governance", title: "政權", icon: "⚖", fields: { system: "體制", authority: "權力來源", legitimacy: "合法性" } },
  { key: "society", title: "社會", icon: "▤", fields: { population_structure: "人口結構", daily_life: "日常", culture: "文化" } },
  { key: "infrastructure", title: "基礎設施", icon: "◫", fields: { security: "保安", resources: "資源", mobility: "流動" } },
  { key: "risk_profile", title: "風險", icon: "⚠", fields: { danger_level: "危險程度" } },
  { key: "nest_profile", title: "病窩特徵", icon: "☣", fields: { threat_signature: "威脅特徵", activity_pattern: "活動模式", affected_radius: "影響半徑" } },
];

export class ZoneDossier {
  private root: HTMLElement;
  private app: App;
  /** 目前顯示嘅 zone（用嚟防止 async dossier 返嚟時 render 錯 zone）。 */
  private currentZoneId: string | null = null;
  /** 已載入嘅豐富 dossier（`zone-dossiers.json`，48 個）。 */
  private dossier: ZoneDossierRecord | null = null;

  constructor(root: HTMLElement, app: App) {
    this.root = root;
    this.app = app;
  }

  private esc(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * 顯示某個 zone 嘅 dossier。
   *
   * ⚠️ 接線 `zone-dossiers.json`（C8 P1-4，2026-09-25）
   * ----------------------------------------------
   * 先用 `zones.geojson` 嘅 v1 inline 欄位**即刻 render**（唔會白畫面），
   * 再按需載入 48 個豐富 dossier；到咗就用佢**重新 render**（唔會閃，
   * 因為同一個 zone、同一個容器）。
   */
  update(zoneId: string | null): void {
    this.currentZoneId = zoneId;
    if (!zoneId) {
      this.dossier = null;
      this.root.innerHTML = "";
      return;
    }
    const zone = this.app.data.zones.features.find(
      (z: ZoneFeature) => z.properties.id === zoneId,
    );
    if (!zone) {
      this.dossier = null;
      this.root.innerHTML = "";
      return;
    }
    this.dossier = null;
    this.render(zone);
    // 按需載入（memoized；第二次揀 zone 就即時有）
    void loadZoneDossiers().then((m) => {
      if (this.currentZoneId !== zoneId) return; // 用戶已經揀咗第二個
      const d = m.get(zoneId) ?? null;
      if (!d) return;
      this.dossier = d;
      this.render(zone);
    });
  }

  private render(zone: ZoneFeature): void {
    const p = zone.properties;
    const meta = KIND_META[p.kind] ?? KIND_META.nest;
    const d = this.dossier;

    /*
     * ⚠️ 豐富 dossier 區塊（C8 P1-4）：`zone-dossiers.json` 嘅 14 個欄位
     * 之前**從來冇出現喺 UI**（`loadDossiers()` 係死碼）。有咗就取代
     * v1 inline 欄位（更完整），冇就原樣顯示 v1。
     */
    const richSections = d
      ? [
          d.overview && d.overview !== "unknown"
            ? `<p class="zd-summary">${this.esc(d.overview)}</p>`
            : "",
          ...DOSSIER_GROUPS.map((g) => {
            const raw = (d as unknown as Record<string, unknown>)[g.key];
            if (!raw || typeof raw !== "object") return "";
            const obj = raw as Record<string, unknown>;
            const rows = Object.entries(g.fields)
              .map(([k, label]) => {
                const v = obj[k];
                if (v === null || v === undefined || v === "" || v === "unknown") return "";
                const text = Array.isArray(v) ? v.join("、") : String(v);
                return `<li><i>${this.esc(label)}</i><span>${this.esc(text)}</span></li>`;
              })
              .join("");
            if (!rows) return "";
            return `
              <section class="zd-section" style="--zd-accent:${meta.color}">
                <h4 class="zd-section-title"><span class="zd-icon">${g.icon}</span>${g.title}</h4>
                <ul class="zd-audit">${rows}</ul>
              </section>`;
          }),
          (d.key_characters?.length ?? 0) > 0
            ? `
              <section class="zd-section" style="--zd-accent:${meta.color}">
                <h4 class="zd-section-title"><span class="zd-icon">★</span>關鍵角色</h4>
                <div class="zd-chips">${d.key_characters
                  .map((x) => `<span class="zd-chip">${this.esc(x)}</span>`)
                  .join("")}</div>
              </section>`
            : "",
        ].join("")
      : "";

    /*
     * ⚠️ 誠實標示（F6）：`review_status` 一定要顯示。
     * `needs_validation` 嘅 zone 唔可以同 `validated` 睇落一樣。
     */
    const review = REVIEW_META[p.zone_review_status ?? ""] ?? null;
    const reviewBadge = review
      ? `<span class="zd-review zd-review--${this.esc(String(p.zone_review_status))}" title="${this.esc(review.hint)}">${review.label}</span>`
      : "";
    const precisionBadge = p.spatial_precision
      ? `<span class="zd-review zd-review--precision" title="空間精度">精度：${this.esc(String(p.spatial_precision))}</span>`
      : "";

    const sectionHtml = SECTIONS.map((sec) => {
      const raw = p[sec.key];
      if (sec.list) {
        const items = Array.isArray(raw) ? (raw as string[]) : [];
        if (!items.length) return "";
        return `
          <section class="zd-section" style="--zd-accent:${meta.color}">
            <h4 class="zd-section-title"><span class="zd-icon">${sec.icon}</span>${sec.title}</h4>
            <div class="zd-chips">${items
              .map((x) => `<span class="zd-chip">${this.esc(x)}</span>`)
              .join("")}</div>
          </section>`;
      }
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) return "";
      return `
        <section class="zd-section" style="--zd-accent:${meta.color}">
          <h4 class="zd-section-title"><span class="zd-icon">${sec.icon}</span>${sec.title}</h4>
          <p class="zd-text">${this.esc(text)}</p>
        </section>`;
    }).join("");

    const chapterChips = (p.chapters || [])
      .slice(0, 40)
      .map(
        (c) =>
          `<button type="button" class="zd-ch" data-ch="${c}" title="跳到第 ${c} 章">${c}</button>`,
      )
      .join("");

    const conf =
      typeof p.confidence === "number"
        ? `<span class="zd-metric"><b>${Math.round(p.confidence * 100)}%</b><i>信心度</i></span>`
        : "";
    const radiusSrc =
      p.radius_source === "members"
        ? "成員分佈（證據）"
        : p.radius_source === "default"
          ? "估算（示意）"
          : "未知";

    this.root.innerHTML = `
      <article class="zd" style="--zd-accent:${meta.color}">
        <header class="zd-head">
          <div class="zd-kind">
            <span class="zd-glyph">${meta.glyph}</span>
            <span class="zd-kind-label">${meta.label}</span>
            <span class="zd-kind-sub">${meta.sub}</span>
          </div>
          <h2 class="zd-name">${this.esc(p.name)}</h2>
          ${p.aliases?.length ? `<p class="zd-alias">別稱：${p.aliases.slice(0, 6).map((a: string) => this.esc(a)).join("、")}</p>` : ""}
          <div class="zd-metrics">
            <span class="zd-metric"><b>${Math.round(p.radius_m)} m</b><i>範圍半徑</i></span>
            <span class="zd-metric"><b>${p.first_appearance ?? "—"}</b><i>首現章節</i></span>
            <span class="zd-metric"><b>${(p.chapters || []).length}</b><i>出現章數</i></span>
            ${conf}
          </div>
          ${
            reviewBadge || precisionBadge
              ? `<div class="zd-badges">${reviewBadge}${precisionBadge}</div>`
              : ""
          }
        </header>

        ${p.location_hint ? `<p class="zd-hint"><span>◐</span>${this.esc(p.location_hint)}</p>` : ""}
        ${p.summary ? `<p class="zd-summary">${this.esc(p.summary)}</p>` : ""}

        <div class="zd-body">${richSections}${sectionHtml}</div>

        ${/*
           * ⚠️ P1-5（C8）：原本「資料來源」係**預設展開**，直接顯示
           * `抽取來源 A6`、`座標 legacy` 等**內部管線欄位** —— 對用戶冇意義，
           * 而且係「工程師式文案」。改成漸進披露：預設收起，需要時才展開。
           */ ""}
        <details class="zd-section zd-section--meta zd-meta-details" style="--zd-accent:${meta.color}">
          <summary class="zd-section-title"><span class="zd-icon">◇</span>資料來源與可信度</summary>
          <ul class="zd-audit">
            <li><i>範圍</i><span>${this.esc(p.range_evidence || "—")}</span></li>
            <li><i>範圍可信度</i><span>${radiusSrc}</span></li>
            <li><i>座標</i><span>${this.esc(p.coords_evidence || "—")}</span></li>
            <li><i>抽取來源</i><span>${(p.sources || []).join("、") || "—"}</span></li>
          </ul>
          ${
            p.evidence
              ? `<div class="zd-evidence"><p>${this.esc(p.evidence)}</p></div>`
              : ""
          }
        </details>

        <section class="zd-section" style="--zd-accent:${meta.color}">
          <h4 class="zd-section-title"><span class="zd-icon">≡</span>出現章節</h4>
          <div class="zd-chapters">${chapterChips}</div>
        </section>

        ${/*
           * ⚠️ P1-7（C8）：「dossier 打開之後，用戶唔知下一步可以做咩」。
           * 加一行明確嘅 next step（全部用**已有**嘅 app 動作，唔新增 API）。
           */ ""}
        <section class="zd-section zd-next" style="--zd-accent:${meta.color}">
          <h4 class="zd-section-title"><span class="zd-icon">→</span>下一步</h4>
          <div class="zd-actions">
            ${
              p.first_appearance
                ? `<button type="button" class="zd-action" data-goto-ch="${p.first_appearance}">跳到首現章節 ch${p.first_appearance}</button>`
                : ""
            }
            ${
              (p.event_ids || []).length
                ? `<button type="button" class="zd-action" data-goto-ev="${this.esc(String((p.event_ids || [])[0]))}">睇呢區嘅第一個事件</button>`
                : ""
            }
            <button type="button" class="zd-action zd-action--ghost" data-close-zd>收埋</button>
          </div>
        </section>
      </article>
    `;

    this.root.querySelectorAll<HTMLButtonElement>(".zd-ch").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ch = Number(btn.getAttribute("data-ch"));
        if (Number.isFinite(ch)) this.app.goToChapter(ch);
      });
    });

    // P1-7：下一步 CTA
    this.root.querySelectorAll<HTMLButtonElement>(".zd-action").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ch = btn.getAttribute("data-goto-ch");
        const ev = btn.getAttribute("data-goto-ev");
        if (ch !== null) this.app.goToChapter(Number(ch));
        else if (ev) this.app.setSelectedEvent(ev);
        else if (btn.hasAttribute("data-close-zd")) this.app.setSelectedZone(null);
      });
    });
  }
}
