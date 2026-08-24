// 《病港》互動地圖 — 主入口
import "./styles/main.css";
import "./styles/timeline.css";
import { initMap } from "./map/initMap";

void initMap("map-root").catch((e) => {
  console.error("[病港地圖] 初始化失敗", e);
  const root = document.getElementById("map-root");
  if (root) {
    root.innerHTML = `<p class="bg-error">地圖初始化失敗：${String(e)}</p>`;
  }
});

