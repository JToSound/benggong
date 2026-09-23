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
import type { ZoneFeature } from "../types/dataset";

/** 三種區域嘅視覺語言（同地圖上嘅顏色一致）。 */
const KIND_META: Record<
  string,
  { label: string; sub: string; color: string; glyph: string }
> = {
  survivor: {
    label: "倖存區",
    sub: "人類聚居 · 安全",
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

export class ZoneDossier {
  private root: HTMLElement;
  private app: App;

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

  update(zoneId: string | null): void {
    if (!zoneId) {
      this.root.innerHTML = "";
      return;
    }
    const zone = this.app.data.zones.features.find(
      (z: ZoneFeature) => z.properties.id === zoneId,
    );
    if (!zone) {
      this.root.innerHTML = "";
      return;
    }
    const p = zone.properties;
    const meta = KIND_META[p.kind] ?? KIND_META.nest;

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
        </header>

        ${p.location_hint ? `<p class="zd-hint"><span>◐</span>${this.esc(p.location_hint)}</p>` : ""}
        ${p.summary ? `<p class="zd-summary">${this.esc(p.summary)}</p>` : ""}

        <div class="zd-body">${sectionHtml}</div>

        <section class="zd-section zd-section--meta" style="--zd-accent:${meta.color}">
          <h4 class="zd-section-title"><span class="zd-icon">◇</span>資料來源</h4>
          <ul class="zd-audit">
            <li><i>範圍</i><span>${this.esc(p.range_evidence || "—")}</span></li>
            <li><i>範圍可信度</i><span>${radiusSrc}</span></li>
            <li><i>座標</i><span>${this.esc(p.coords_evidence || "—")}</span></li>
            <li><i>抽取來源</i><span>${(p.sources || []).join("、") || "—"}</span></li>
          </ul>
          ${
            p.evidence
              ? `<details class="zd-evidence"><summary>原文證據</summary><p>${this.esc(p.evidence)}</p></details>`
              : ""
          }
        </section>

        <section class="zd-section" style="--zd-accent:${meta.color}">
          <h4 class="zd-section-title"><span class="zd-icon">≡</span>出現章節</h4>
          <div class="zd-chapters">${chapterChips}</div>
        </section>
      </article>
    `;

    this.root.querySelectorAll<HTMLButtonElement>(".zd-ch").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ch = Number(btn.getAttribute("data-ch"));
        if (Number.isFinite(ch)) this.app.goToChapter(ch);
      });
    });
  }
}
