// 《病港》— 動態網絡審計（Playwright）
// 需要預覽 server；由 globalSetup 負責起 server，測完自動收檔。

import { spawn, type ChildProcess } from "node:child_process";
import type { FullConfig } from "@playwright/test";

let server: ChildProcess | null = null;

/** 帶 timeout 嘅 probe（避免 server hung 令 ping 永遠等）。 */
async function probe(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function globalSetup(_config: FullConfig): Promise<() => void> {
  /*
   * ⚠️ 已知陷阱（2026-09-23 診斷，見 `docs/audits/e2e-instability-diagnosis.md`）
   * ------------------------------------------------------------------------
   * 如果 5174 已經有**殘留 server**（由上次測試留低），本函數會 early return
   * —— 唔起新 server，**而且 teardown 係 no-op**，所以嗰個舊 server 永遠留低。
   *
   * 實測後果：`npm run test` 之中 `tests/reduced-motion.test.ts` 嘅 3 個
   * 瀏覽器測試**卡死 90 秒**（恰好 = timeout），但單獨跑（22 秒）／
   * 跑全部 e2e（712 秒）都過。
   *
   * 配合觀察：每次測試完結都報 `something prevents Vite server from exiting`；
   * `tasklist` 見到 25 個殘留 node 進程（約 2.3 GB）。
   *
   * 🔧 遇到「全套卡死但單獨跑過」時嘅檢查步驟：
   *   1. `curl --noproxy '*' -s -o /dev/null -w "%{http_code}" http://localhost:5174/`
   *      返 `000` = 冇 server（正常）；返 200 = 有殘留 server。
   *   2. 有殘留 → 清理之後重跑。
   *
   * ⚠️ 為何唔直接 kill 殘留 server：Windows 之下要搵 PID（`netstat -ano`），
   * 而且 `taskkill` 可能被 sandbox 擋；更重要係**唔應該亂殺用戶其他 node 工作**。
   */
  const alreadyUp = await probe("http://localhost:5174/");
  if (alreadyUp) {
    console.warn(
      "[e2e] ⚠️ 5174 已經有 server —— 沿用（teardown 唔會關閉佢）。" +
        " 如果測試卡死，檢查係否殘留 server（見 globalSetup 註解）。",
    );
    return () => {};
  }

  server = spawn("npx", ["vite", "preview", "--port", "5174", "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });

  // 等 server 起（帶 timeout 嘅 probe，避免 ping 卡住）
  for (let i = 0; i < 30; i++) {
    if (await probe("http://localhost:5174/")) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  return () => {
    if (server?.pid) {
      try {
        process.kill(-server.pid);
      } catch {
        /* 已死 */
      }
    }
    server = null;
  };
}
