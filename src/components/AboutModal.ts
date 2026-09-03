/**
 * AboutModal: 顯示版權、資料來源、limitation 嘅 modal.
 */

import type { AppData, LocationFeature } from "../data/loadAllData";

export class AboutModal {
  root: HTMLElement;
  data: AppData;

  constructor(root: HTMLElement, data: AppData) {
    this.root = root;
    this.data = data;
  }

  show(): void {
    let modal = this.root.querySelector("#about-modal") as HTMLElement | null;
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "about-modal";
      modal.className = "modal-backdrop";
      modal.innerHTML = this.html();
      this.root.appendChild(modal);
      modal.addEventListener("click", (e) => {
        if ((e.target as Element).classList.contains("modal-backdrop")) this.hide();
      });
      modal.querySelector("#about-close")?.addEventListener("click", () => this.hide());
    }
    modal.classList.add("open");
  }

  hide(): void {
    const modal = this.root.querySelector("#about-modal");
    if (modal) modal.classList.remove("open");
  }

  private html(): string {
    const nLoc = this.data.locations.features.length;
    const nEv = this.data.events.features.length;
    const nCh = this.data.characters.length;
    const nRoute = this.data.routes.features.length;
    return `
      <div class="modal-content">
        <header class="modal-header">
          <h2>關於《病港》互動地圖</h2>
          <button id="about-close" class="close-btn">×</button>
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
              <li><kbd>Esc</kbd>：取消選擇</li>
              <li>地圖：<kbd>滾輪</kbd> 縮放 · <kbd>拖拽</kbd> 平移</li>
            </ul>
          </section>
        </div>
      </div>
    `;
  }
}
