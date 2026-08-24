// 《病港》互動地圖 — 時間軸入口
// v1：垂直時間軸、劇透過濾、deep link「喺地圖睇」（?event=<id> → index.html）

import { filterBySpoiler, loadDataset } from "../data/loadDataset";
import type { TimelineRecord } from "../types/dataset";

export function initTimeline(): string {
  return "timeline-ready";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

export async function renderTimeline(rootId = "timeline-app"): Promise<void> {
  const root = document.getElementById(rootId);
  if (!root) throw new Error(`搵唔到 #${rootId}`);

  const { dataset, config } = await loadDataset();

  if (dataset.meta) {
    const banner = document.createElement("div");
    banner.className = "bg-provisional-banner";
    banner.setAttribute("role", "note");
    banner.textContent = dataset.meta.banner;
    root.prepend(banner);
  }

  const maxSpoiler = config.spoiler.default_max_level ?? 1;
  const records = filterBySpoiler(dataset.timeline, maxSpoiler).sort((a, b) =>
    a.date_sort.localeCompare(b.date_sort),
  );

  // 章節篩選列（有記錄嘅章先顯示）
  const chapters = [...new Set(records.map((r) => r.chapter))].sort((a, b) => a - b);

  const listHtml = records
    .map(
      (r: TimelineRecord) => `
      <li class="tl-item" data-chapter="${r.chapter}">
        <div class="tl-marker" aria-hidden="true"></div>
        <article>
          <header>
            <span class="tl-chapter">第${r.chapter}章</span>
            <span class="tl-date">${escapeHtml(r.date_label)}</span>
            <span class="tl-spoiler">劇透 ${r.spoiler_level}</span>
          </header>
          <p class="tl-desc">${escapeHtml(r.description)}</p>
          <p class="tl-meta">
            ${r.characters.map((c) => `@${escapeHtml(c)}`).join(" ")}
            ${r.event_id ? `<a href="./index.html?event=${encodeURIComponent(r.event_id)}">喺地圖睇</a>` : ""}
          </p>
        </article>
      </li>`,
    )
    .join("");

  root.insertAdjacentHTML(
    "beforeend",
    `
    <h1>《病港》時間軸 <small>按章節先後</small></h1>
    <fieldset class="tl-filter">
      <legend>章節篩選（劇透露 ≤${maxSpoiler}）</legend>
      <label><input type="checkbox" id="tl-all" checked /> 全部</label>
      ${chapters
        .map((c) => `<label><input type="checkbox" class="tl-chk" value="${c}" checked /> 第${c}章</label>`)
        .join("")}
    </fieldset>
    <ol id="tl-list" class="tl-list">${listHtml}</ol>
    <p><a href="./index.html">← 返主地圖</a></p>
  `,
  );

  const listEl = root.querySelector<HTMLUListElement>("#tl-list")!;
  const applyFilter = () => {
    const checked = new Set(
      [...root.querySelectorAll<HTMLInputElement>(".tl-chk:checked")].map((el) => Number(el.value)),
    );
    for (const li of Array.from(listEl.children) as HTMLElement[]) {
      li.style.display = checked.has(Number(li.dataset.chapter)) ? "" : "none";
    }
  };
  root.querySelector("#tl-all")?.addEventListener("change", (e) => {
    const all = (e.target as HTMLInputElement).checked;
    for (const el of Array.from(root.querySelectorAll<HTMLInputElement>(".tl-chk"))) {
      el.checked = all;
    }
    applyFilter();
  });
  for (const el of Array.from(root.querySelectorAll<HTMLInputElement>(".tl-chk"))) {
    el.addEventListener("change", applyFilter);
  }
}

