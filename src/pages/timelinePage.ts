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

  // 角色焦點列（按出現次數，取前 12）
  const charCount = new Map<string, number>();
  for (const r of records) {
    for (const c of r.characters) {
      charCount.set(c, (charCount.get(c) ?? 0) + 1);
    }
  }
  const topChars = [...charCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const listHtml = records
    .map(
      (r: TimelineRecord) => `
      <li class="tl-item" data-chapter="${r.chapter}" data-chars="${escapeHtml(r.characters.join("|"))}">
        <div class="tl-marker" aria-hidden="true"></div>
        <article>
          <header>
            <span class="tl-chapter">第${r.chapter}章</span>
            <span class="tl-date">${escapeHtml(r.date_label)}</span>
            <span class="tl-spoiler">劇透 ${r.spoiler_level}</span>
          </header>
          <p class="tl-desc">${escapeHtml(r.description)}</p>
          <p class="tl-meta">
            ${r.characters.map((c) => `<span class="tl-char-tag">@${escapeHtml(c)}</span>`).join(" ")}
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
    ${
      topChars.length
        ? `<fieldset class="tl-filter">
      <legend>角色焦點（可多選；空白＝全部）</legend>
      ${topChars
        .map(
          ([name, n]) =>
            `<label><input type="checkbox" class="tl-cchar" value="${escapeHtml(name)}" /> @${escapeHtml(name)} <small>(${n})</small></label>`,
        )
        .join("")}
    </fieldset>`
        : ""
    }
    <p id="tl-count" class="tl-count"></p>
    <ol id="tl-list" class="tl-list">${listHtml}</ol>
    <p><a href="./index.html">← 返主地圖</a></p>
  `,
  );

  const listEl = root.querySelector<HTMLUListElement>("#tl-list")!;
  const countEl = root.querySelector<HTMLParagraphElement>("#tl-count")!;
  const applyFilter = () => {
    const checkedChapters = new Set(
      [...root.querySelectorAll<HTMLInputElement>(".tl-chk:checked")].map((el) => Number(el.value)),
    );
    const focusChars = [
      ...root.querySelectorAll<HTMLInputElement>(".tl-cchar:checked"),
    ].map((el) => el.value);
    let visible = 0;
    for (const li of Array.from(listEl.children) as HTMLElement[]) {
      const chapterOk = checkedChapters.has(Number(li.dataset.chapter));
      const itemChars = (li.dataset.chars ?? "").split("|").filter(Boolean);
      const charOk =
        focusChars.length === 0 || focusChars.some((c) => itemChars.includes(c));
      const show = chapterOk && charOk;
      li.style.display = show ? "" : "none";
      if (show) visible++;
    }
    countEl.textContent = `顯示 ${visible} / ${records.length} 條記錄`;
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

  // ---- deep link：?event=<id> 捲到該卡並高亮 ----
  const params = new URLSearchParams(window.location.search);
  const targetEvent = params.get("event");
  if (targetEvent) {
    const card = Array.from(listEl.children as HTMLCollectionOf<HTMLElement>).find(
      (li) => li.querySelector(`a[href*="event=${targetEvent}"]`) != null,
    );
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("tl-highlight");
      setTimeout(() => card.classList.remove("tl-highlight"), 3000);
    }
  }
}

