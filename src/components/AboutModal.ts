/**
 * AboutModal: 顯示版權、資料來源、limitation 嘅 modal.（B8 改寫）
 *
 * ⚠️ 相對 V1 版本嘅關鍵改動（A7 P0-4 / 驗收矩陣 §2「關於 modal」）
 * ==========================================================
 *
 * 舊版只有 `classList.add("open")` / `remove("open")`：
 *   · 冇 `role="dialog"`、冇 `aria-modal`、冇 `aria-labelledby`
 *   · 冇 focus trap（Tab 好快就逃離到背景）
 *   · 關閉之後 focus **冇還原**（留喺隱藏元素 → 連鎖令快捷鍵失效）
 *
 * 而家：
 *   1. `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（指向 `h2`）。
 *   2. Focus trap：Tab / Shift+Tab 循環喺 modal 內。
 *   3. 開啟時 focus 移入第一個可聚焦元素（close 掣）。
 *   4. 關閉時 focus **還原**去觸發者（`#btn-about` / `#btn-help`）。
 *   5. 背景 `#app-root` 加 `inert`（Chromium 102+ / Safari 15.5+ / FF 112+）。
 *   6. Esc 由本元件自己處理（`handleKeydown`），令行為可測。
 *
 * 契約：
 *   · `show()` / `hide()` / `isOpen()` 簽名**維持不變**（`app.ts` 依賴）。
 *   · 唔改任何上游 export。
 */

import type { AppData, LocationFeature } from "../data/loadAllData";

export class AboutModal {
  root: HTMLElement;
  data: AppData;

  /** 開啟前嘅 focus 目標（還原用）。 */
  private prevFocus: HTMLElement | null = null;
  private bound: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];

  constructor(root: HTMLElement, data: AppData) {
    this.root = root;
    this.data = data;
  }

  show(): void {
    let modal = this.root.querySelector<HTMLElement>("#about-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "about-modal";
      modal.className = "modal-backdrop";
      /*
       * P0-4 同源問題：dialog 語意。`aria-labelledby` 指向內部 `h2`，
       * 令 AT 讀出正確嘅對話框名稱（唔用 `aria-label` —— 令文案可共用）。
       */
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-labelledby", "about-modal-title");
      modal.innerHTML = this.html();
      this.root.appendChild(modal);

      const on = (target: EventTarget, type: string, fn: EventListener): void => {
        target.addEventListener(type, fn);
        this.bound.push({ el: target, type, fn });
      };
      on(modal, "click", ((e: MouseEvent) => {
        if ((e.target as Element).classList.contains("modal-backdrop")) this.hide();
      }) as EventListener);
      on(modal, "keydown", ((e: KeyboardEvent) => {
        this.handleKeydown(e);
      }) as EventListener);
      modal.querySelector("#about-close")?.addEventListener("click", () => this.hide());
    }

    this.prevFocus = document.activeElement as HTMLElement | null;
    modal.classList.add("open");

    // 背景隔離（唔可以 Tab 到、唔入 AT）
    const appRoot = document.getElementById("app-root");
    if (appRoot && appRoot !== this.root) appRoot.setAttribute("inert", "");

    // 開啟時 focus 移入 modal（焦點管理 = 驗收矩陣要求）
    const first = this.focusables(modal)[0];
    first?.focus();
  }

  /** 目前有冇開住（Esc 處理要用）。 */
  isOpen(): boolean {
    const modal = this.root.querySelector("#about-modal");
    return Boolean(modal?.classList.contains("open"));
  }

  hide(): void {
    const modal = this.root.querySelector<HTMLElement>("#about-modal");
    if (!modal?.classList.contains("open")) return;
    modal.classList.remove("open");
    const appRoot = document.getElementById("app-root");
    if (appRoot && appRoot !== this.root) appRoot.removeAttribute("inert");
    /*
     * Focus 還原：唔還原嘅話 focus 會留喺（已經隱藏嘅）modal 內，
     * 令 app.ts 嘅 `if (target instanceof HTMLInputElement) return`
     * 之後所有快捷鍵靜默失效（A7 P0-4 同源問題）。
     */
    const target = this.prevFocus;
    this.prevFocus = null;
    if (target && document.contains(target)) target.focus();
    else (document.activeElement as HTMLElement | null)?.blur?.();
  }

  /**
   * 鍵盤處理（公開，方便 e2e / 單測）。
   *
   * @returns 有冇消費事件。
   */
  handleKeydown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      e.preventDefault();
      this.hide();
      return true;
    }
    if (e.key !== "Tab") return false;
    const modal = this.root.querySelector<HTMLElement>("#about-modal");
    if (!modal) return false;
    const f = this.focusables(modal);
    if (f.length === 0) return false;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
      return true;
    }
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  /** Modal 內嘅可聚焦元素（過濾離屏 / `display:none`）。 */
  private focusables(modal: HTMLElement): HTMLElement[] {
    return Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  }

  destroy(): void {
    for (const { el, type, fn } of this.bound) el.removeEventListener(type, fn);
    this.bound = [];
  }

  private html(): string {
    const nLoc = this.data.locations.features.length;
    const nEv = this.data.events.features.length;
    const nCh = this.data.characters.length;
    const nRoute = this.data.routes.features.length;
    return `
      <div class="modal-content">
        <header class="modal-header">
          <h2 id="about-modal-title">關於《病港》互動地圖</h2>
          <button id="about-close" class="close-btn" type="button" aria-label="關閉">×</button>
        </header>
        <div class="modal-body">
          <section>
            <h3>本互動地圖</h3>
            <p>粉絲製作嘅香港網絡小說《病港》互動故事地圖。完全離線、完全靜態、可部署 GitHub Pages。</p>
          </section>
          <section>
            <h3>資料統計</h3>
            <ul>
              <li>${nLoc} 個地點（${this.data.locations.features.filter((f: LocationFeature) => !f.properties.fictional).length} 真實 HK / ${this.data.locations.features.filter((f: LocationFeature) => f.properties.fictional).length} 虛構）</li>
              <li>${nEv} 個事件</li>
              <li>${nCh} 個角色</li>
              <li>${nRoute} 條角色路線</li>
              <li>198 章</li>
            </ul>
          </section>
          <section>
            <h3>地圖</h3>
            <p>將軍澳為主嘅 SVG 簡化地圖（手繪 outline），唔使用任何 online map service、tile、geocoder。</p>
            <p>虛構地名（艾寶琳、倖存區等）以 fictional precision 標示；真實 HK 將軍澳地名以 district precision 標示。</p>
          </section>
          <section>
            <h3>版權</h3>
            <p>本項目純粹係《病港》fans 製作嘅 fan-project，唔屬於原作作者。詳細版權見 <code>NOTICE.md</code> 同 <code>LICENSE</code>。</p>
            <p>公開 dataset 嚴格遵守：只含經審閱短摘要、章節參照、結構化事件／位置資料、原作視覺資產。</p>
          </section>
          <section>
            <h3>使用</h3>
            <ul>
              <li><kbd>←</kbd> / <kbd>→</kbd> 或 <kbd>j</kbd> / <kbd>k</kbd>：上一章 / 下一章</li>
              <li><kbd>Home</kbd> / <kbd>End</kbd>：第一章 / 最後一章</li>
              <li><kbd>/</kbd>：搜尋</li>
              <li><kbd>Esc</kbd>：關閉浮層 / 收合面板 / 取消選擇</li>
              <li>地圖：<kbd>滾輪</kbd> 縮放 · <kbd>拖拽</kbd> 平移</li>
              <li>面板拖曳把手：<kbd>↑</kbd> / <kbd>↓</kbd> 或 <kbd>End</kbd> 調整高度</li>
            </ul>
          </section>
        </div>
      </div>
    `;
  }
}
