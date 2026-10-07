/**
 * 探測腳本共用工具（P1-6-8 / D5-10）。
 *
 * 為何要有呢個檔
 * ==============
 * 本目錄所有 `.mjs` 探測腳本都需要兩件事：
 *   1. 確保 5174 preview server 喺度（唔喺就起一個）；
 *   2. 用完**可靠地**收檔。
 *
 * ⚠️ 為何唔可以 `process.kill(-pid)`（專案 MEMORY E18）
 * ---------------------------------------------------
 * 專案環境係 Windows。`spawn(..., { detached: true })` 之後用
 * `process.kill(-pid)` 收**成個 process group** 喺 Windows **冇效** ——
 * `vite preview` 會殘留，佔住 5174。之後嘅 e2e／視覺守衛就會連去
 * **舊 build** → 比對「舊 vs 舊」→ **假綠**（比假紅危險得多）。
 * 正確做法：Windows 用 `taskkill /PID <pid> /T /F`（`/T` 連子孫）。
 *
 * 統一放呢度，令所有探測腳本收檔行為一致、可稽核。
 */
import { execFileSync, spawn } from "node:child_process";

export const PORT = 5174;
export const BASE = `http://localhost:${PORT}/`;

/** 探測專用 browser 啟動參數（環境有 http_proxy，見 MEMORY E3）。 */
export const LAUNCH_ARGS = ["--no-proxy-server"];

async function reachable(url, ms = 3000) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}

/**
 * 若 5174 未有 server 就起一個。
 * @returns child process（**已有** server 時回 `null` —— 唔應該由我哋收檔）。
 */
export async function ensurePreviewServer() {
  if (await reachable(BASE)) return null;
  const child = spawn(
    "npx",
    ["vite", "preview", "--port", String(PORT), "--strictPort"],
    { cwd: process.cwd(), shell: true, stdio: "ignore", detached: true },
  );
  for (let i = 0; i < 40; i++) {
    if (await reachable(BASE)) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  stopPreviewServer(child);
  throw new Error("preview server 起唔到");
}

/** 可靠地收 server 檔（Windows: taskkill /T /F；其他平台: process group SIGTERM）。 */
export function stopPreviewServer(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    /* 已經死咗就冇所謂 */
  }
}

/**
 * 跑一段探測主體，**保證**收檔（browser ＋ server）。
 *
 * 用法：
 * ```js
 * const server = await ensurePreviewServer();
 * const browser = await chromium.launch({ args: LAUNCH_ARGS });
 * await withTeardown(browser, server, async () => { ... });
 * ```
 */
export async function withTeardown(browser, server, body) {
  try {
    return await body();
  } finally {
    try {
      await browser.close();
    } catch {
      /* */
    }
    stopPreviewServer(server);
  }
}
