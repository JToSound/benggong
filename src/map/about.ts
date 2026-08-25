// 《病港》— 關於對話框（頂欄「關於」按鈕）
// 內容：專案定位、資料來源聲明、provisional 說明、AI 內容政策、版權連結。

export function mountAbout(): void {
  const btn = document.getElementById("btn-about");
  if (!btn) return;

  btn.addEventListener("click", () => {
    let dialog = document.getElementById("bg-about");
    if (dialog) {
      dialog.remove();
      return;
    }
    dialog = document.createElement("aside");
    dialog.id = "bg-about";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "關於本站");
    const version = document.getElementById("data-version-label")?.textContent ?? "";
    dialog.innerHTML = `
      <div class="bg-about-inner">
        <h2>關於《病港》互動地圖</h2>
        <p>呢個係香港網絡小說《病港》嘅<b>非官方粉絲製作</b>導覽工具，標示故事入面嘅事件、地點同角色出場。</p>
        <h3>資料說明</h3>
        <ul>
          <li>全部內容為小說情節<b>短摘要</b>，唔包含原文；請支持原著</li>
          <li>${escapeHtml(version)}</li>
          <li>位置以「故事座標」顯示：<b>唔代表真實地理</b>；真實香港地名只作參考</li>
          <li>距離量度用「故事單位」，比例未經校準</li>
        </ul>
        <h3>鍵盤快速鍵</h3>
        <p class="keys"><kbd>F</kbd> 搜尋 · <kbd>M</kbd> 量度 · <kbd>S</kbd> 面板 · <kbd>T</kbd> 時間軸 · <kbd>Esc</kbd> 關閉</p>
        <h3>版權</h3>
        <p>《病港》內容版權屬原作者。代碼以 MIT 發佈；詳情見 repo 嘅 NOTICE.md。</p>
        <button type="button" id="bg-about-close">關閉</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelector("#bg-about-close")?.addEventListener("click", () => dialog!.remove());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.remove();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.getElementById("bg-about")?.remove();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}
