// 《病港》— 搜尋索引：location / event / character / chapter 統一搜尋
// master prompt §10.3：可搵角色、事件、地點、章節編號。

import type { BingGangDataset } from "../types/dataset";

export interface SearchHit {
  kind: "event" | "location" | "character" | "chapter";
  id: string;
  title: string;
  subtitle: string;
  /** deep link 目標（index.html hash/query） */
  href: string;
}

interface IndexedDoc {
  kind: SearchHit["kind"];
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** 全部可搜尋字串（小寫） */
  haystack: string;
}

let index: IndexedDoc[] = [];

export function buildSearchIndex(dataset: BingGangDataset): void {
  const docs: IndexedDoc[] = [];

  for (const f of dataset.events) {
    const p = f.properties;
    docs.push({
      kind: "event",
      id: p.id,
      title: p.title,
      subtitle: `第${p.chapter}章 · ${p.event_type}`,
      href: `?event=${encodeURIComponent(p.id)}`,
      haystack: `${p.title} ${p.description} 第${p.chapter}章 ${p.characters.join(" ")}`.toLowerCase(),
    });
  }

  for (const f of dataset.locations) {
    const p = f.properties;
    docs.push({
      kind: "location",
      id: p.id,
      title: p.display_name,
      subtitle: p.location_precision,
      href: `#location=${encodeURIComponent(p.id)}`,
      haystack: `${p.name} ${p.display_name} ${p.location_type}`.toLowerCase(),
    });
  }

  for (const c of dataset.characters) {
    docs.push({
      kind: "character",
      id: c.id,
      title: c.name,
      subtitle: `${c.role} · ${c.chapter_refs.length} 章`,
      href: `#character=${encodeURIComponent(c.id)}`,
      haystack: `${c.name} ${(c.aliases || []).join(" ")}`.toLowerCase(),
    });
  }

  const chapters = new Set(dataset.events.map((e) => e.properties.chapter));
  for (const ch of [...chapters].sort((a, b) => a - b)) {
    docs.push({
      kind: "chapter",
      id: `ch${ch}`,
      title: `第${ch}章`,
      subtitle: `${dataset.timeline.filter((t) => t.chapter === ch).length} 個時間軸記錄`,
      href: `timeline.html#ch${String(ch).padStart(3, "0")}`,
      haystack: `第${ch}章 ch${ch} chapter ${ch}`.toLowerCase(),
    });
  }

  index = docs;
}

/** 按關鍵字搜尋；空查詢回傳空陣列。 */
export function search(query: string, limit = 12): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return index
    .filter((doc) => terms.every((t) => doc.haystack.includes(t)))
    .slice(0, limit)
    .map(({ kind, id, title, subtitle, href }) => ({ kind, id, title, subtitle, href }));
}
