// 《病港》— Sidebar：圖層、角色、劇透控制（master prompt §10.2）
// 左側 320px 可收合；鍵盤 S 開關、L 圖層。

import type { BingGangDataset, CharacterRecord } from "../types/dataset";
import { getUIState, setUIState } from "../lib/uiStore";

export interface SidebarCallbacks {
  onSpoilerChange: (maxLevel: number) => void;
  onSelectCharacter: (id: string | null) => void;
}

export function mountSidebar(
  dataset: BingGangDataset,
  callbacks: SidebarCallbacks,
): void {
  if (document.getElementById("bg-sidebar")) return;

  const aside = document.createElement("aside");
  aside.id = "bg-sidebar";
  aside.setAttribute("aria-label", "地圖控制面板");

  const { maxSpoiler } = getUIState();
  const chars = [...dataset.characters].sort(
    (a, b) => b.chapter_refs.length - a.chapter_refs.length,
  );

  aside.innerHTML = `
    <button id="bg-sidebar-toggle" type="button" aria-expanded="true" title="開關面板（S）">☰</button>
    <div class="bg-sidebar-inner">
      <section aria-label="劇透控制">
        <h3>劇透控制</h3>
        <div class="bg-spoiler-btns" role="radiogroup" aria-label="劇透等級">
          ${[0, 1, 2, 3]
            .map(
              (lv) =>
                `<button type="button" role="radio" data-level="${lv}"
                  aria-checked="${lv === maxSpoiler}" class="${lv === maxSpoiler ? "active" : ""}">${lv}</button>`,
            )
            .join("")}
        </div>
        <p class="bg-hint">預設只顯示 0–1 級，避免未讀部分被劇透。</p>
      </section>

      <section aria-label="角色">
        <h3>角色（${chars.length}）</h3>
        <ul class="bg-char-list">
          <li><button type="button" data-char="" class="active">全部</button></li>
          ${chars
            .map(
              (c: CharacterRecord) => `
              <li>
                <button type="button" data-char="${c.id}">
                  <span class="char-dot" style="background:${c.color}"></span>
                  ${c.name}
                  <small>${c.chapter_refs.length}章</small>
                </button>
              </li>`,
            )
            .join("")}
        </ul>
        <p class="bg-hint">路線顯示待全書抽取完成後啟用。</p>
      </section>

      <section aria-label="關於">
        <h3>關於</h3>
        <p>《病港》互動地圖係粉絲製作嘅小說世界導覽工具。</p>
        <p class="bg-hint">所有資料為暫定版本（provisional），位置只供故事瀏覽，唔代表真實地理。AI 生成內容會清楚標示。</p>
      </section>
    </div>
  `;

  document.body.appendChild(aside);

  // ---- 收合 ----
  const toggle = aside.querySelector<HTMLButtonElement>("#bg-sidebar-toggle")!;
  const setCollapsed = (collapsed: boolean): void => {
    aside.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  toggle.addEventListener("click", () =>
    setCollapsed(!aside.classList.contains("collapsed")),
  );

  // ---- 劇透按鈕 ----
  for (const btn of Array.from(aside.querySelectorAll<HTMLButtonElement>(".bg-spoiler-btns button"))) {
    btn.addEventListener("click", () => {
      const level = Number(btn.dataset.level);
      setUIState({ maxSpoiler: level });
      for (const b of Array.from(aside.querySelectorAll(".bg-spoiler-btns button"))) {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-checked", String(active));
      }
      callbacks.onSpoilerChange(level);
    });
  }

  // ---- 角色選擇 ----
  for (const btn of Array.from(aside.querySelectorAll<HTMLButtonElement>("[data-char]"))) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.char || null;
      for (const b of Array.from(aside.querySelectorAll("[data-char]"))) {
        b.classList.toggle("active", b === btn);
      }
      callbacks.onSelectCharacter(id);
    });
  }

  // ---- 鍵盤 S / L ----
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "s" || e.key === "S") {
      setCollapsed(!aside.classList.contains("collapsed"));
    }
  });
}
