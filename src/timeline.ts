// 《病港》互動地圖 — 時間軸入口（瀏覽器專用）
// 測試請 import ./pages/timelinePage.ts 入面嘅純函式。
import "./styles/timeline.css";
import { renderTimeline } from "./pages/timelinePage";

export function initTimeline(): string {
  return "timeline-ready";
}

function boot(): void {
  void renderTimeline().catch((e) => console.error("[病港時間軸] 初始化失敗", e));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
