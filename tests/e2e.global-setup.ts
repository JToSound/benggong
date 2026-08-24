// 《病港》— 動態網絡審計（Playwright）
// 需要預覽 server；由 globalSetup 負責起 server，測完自動收檔。

import { spawn, type ChildProcess } from "node:child_process";
import type { FullConfig } from "@playwright/test";

let server: ChildProcess | null = null;

export default async function globalSetup(_config: FullConfig): Promise<() => void> {
  // 先試 ping 5174
  const alreadyUp = await fetch("http://localhost:5174/")
    .then((r) => r.ok)
    .catch(() => false);
  if (alreadyUp) return () => {};

  server = spawn("npx", ["vite", "preview", "--port", "5174", "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });

  // 等 server 起
  for (let i = 0; i < 30; i++) {
    const ok = await fetch("http://localhost:5174/")
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
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
