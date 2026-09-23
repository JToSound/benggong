// 《病港》— 動態網絡審計（Playwright）
// 需要預覽 server；由 globalSetup 負責起 server，測完自動收檔。

import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";

let server: ChildProcess | null = null;

const PORT = 5174;
const BASE = `http://localhost:${PORT}/`;

/**
 * 記錄由本函數啟動嘅 preview server PID。
 *
 * ⚠️ 為何需要（2026-09-24 實測）
 * -----------------------------
 * teardown 原本用 `process.kill(-pid)`。但 `spawn(..., { shell: true })`
 * 之下 `server.pid` 係**外層 shell** 嘅 PID，而 Windows **唔支援**
 * POSIX process group 語義 → `process.kill(-pid)` 基本上係 no-op，
 * 而 `try/catch` 會靜靜吞咗個錯誤。
 *
 * 結果：**每次 `npm run test` 都留低一個 preview server**。下一次跑就會
 * early return「沿用」佢，而 teardown 又變 no-op —— 惡性循環。
 * （配合症狀：之後 `tests/reduced-motion.test.ts` 會間歇卡死 90 秒。）
 *
 * 修法：① teardown 改用 Windows 嘅 `taskkill /T /F`（殺整個 process tree）；
 * ② 寫 PID 落檔，令「上次中斷留低」嘅 server 可以**確定性**辨認同清理。
 */
const PID_FILE = join(process.cwd(), ".preview-server.pid");

/** 帶 timeout 嘅 probe（避免 server hung 令 ping 永遠等）。 */
async function probe(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 讀回上次啟動嘅 PID（冇／格式唔啱 → null）。 */
function readRecordedPid(): number | null {
  try {
    const s = readFileSync(PID_FILE, "utf-8").trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  } catch {
    return null;
  }
}

/** 該 PID 仲活唔活（`process.kill(pid, 0)` 只做存在性檢查）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 陳舊 PID 檔清理。
 *
 * ⚠️ 為何需要：`teardown` **唔保證一定跑**（測試程序被強制結束時唔會）。
 * 實測全套測試之後：5174 已經冇 listener（server 死咗），但 PID 檔仍然
 * 留住舊值。陳舊值本身無害（`listenerPids()` 會對唔上），但會誤導人，
 * 所以開頭順手清走。
 */
function clearStalePidFile(): void {
  const recorded = readRecordedPid();
  if (recorded === null) return;
  if (isAlive(recorded)) return;
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* 已刪 */
  }
}

/** 邊啲 PID 正在 LISTEN 指定 port（Windows `netstat -ano`）。 */
function listenerPids(port: number): number[] {
  try {
    const out = execSync("netstat -ano", { encoding: "utf-8" });
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !line.includes("LISTENING")) continue;
      const m = line.trim().match(/(\d+)$/);
      if (m) pids.add(Number(m[1]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

/**
 * 殺整個 process tree。
 *
 * ⚠️ Windows **一定要** `taskkill /T /F` —— `process.kill(-pid)` 依賴 POSIX
 * process group，Windows 冇。實測 `taskkill /T /F` 會連子進程（真正嘅
 * `vite preview` node 進程）一齊殺。
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      /* 落返 POSIX 路徑 */
    }
  }
  try {
    process.kill(-pid);
  } catch {
    /* 已死 */
  }
}

export default async function globalSetup(_config: FullConfig): Promise<() => void> {
  clearStalePidFile();

  /*
   * 如果 5174 已經有 server，先判斷係唔係**上次中斷留低嘅自己人**：
   *   · PID 檔記錄嘅 PID **正好就係** 5174 嘅 listener → 確定係自己人
   *     → 清走佢，然後照起一個新嘅（今次 teardown 會負責收）。
   *   · 否則（例如用戶自己開咗 dev server）→ 沿用，唔亂殺。
   */
  if (await probe(BASE)) {
    const recorded = readRecordedPid();
    const live = listenerPids(PORT);
    if (recorded !== null && live.includes(recorded)) {
      console.warn(
        `[e2e] 清走上次中斷留低嘅 preview server（PID ${recorded}，來自 .preview-server.pid）`,
      );
      killTree(recorded);
      try {
        unlinkSync(PID_FILE);
      } catch {
        /* 已刪 */
      }
      for (let i = 0; i < 20; i++) {
        if (!(await probe(BASE, 1000))) break;
        await sleep(250);
      }
    } else {
      console.warn(
        "[e2e] ⚠️ 5174 已經有 server 而且唔係本專案記錄嘅 PID —— 沿用（teardown 唔會關閉佢）。" +
          " 如果測試卡死，檢查係否殘留 server（見 globalSetup 註解）。",
      );
      return () => {};
    }
  }

  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: true,
  });
  if (server.pid) {
    try {
      writeFileSync(PID_FILE, String(server.pid), "utf-8");
    } catch {
      /* 寫唔到唔影響測試 */
    }
  }

  // 等 server 起（帶 timeout 嘅 probe，避免 ping 卡住）
  for (let i = 0; i < 30; i++) {
    if (await probe(BASE)) break;
    await sleep(500);
  }

  return () => {
    if (server?.pid) killTree(server.pid);
    server = null;
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* 冇檔案／已刪 */
    }
  };
}
