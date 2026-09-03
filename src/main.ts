// 《病港》互動地圖 — Phase F 主入口
// Single-page app with: Chapter Strip + SVG Map + Story Panel
import "./styles/main.css";
import "./styles/timeline.css";
import { App } from "./app";
import { initRouter } from "./router";
import { loadAllData } from "./data/loadAllData";

// 預載 data 然後啟動 SPA
const root = document.getElementById("app-root") || document.body;
if (root) {
  loadAllData()
    .then((data) => {
      const app = new App(root, data);
      initRouter(app);
    })
    .catch((e) => {
      console.error("[病港地圖] 初始化失敗", e);
      root.innerHTML = `<p class="bg-error">地圖初始化失敗：${String(e)}</p>`;
    });
}
