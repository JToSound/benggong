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

/**
 * 由 `index.html` 抽出 `/assets/xxx.js|css` 嘅檔名（排序後串埋）。
 *
 * 為何要咁樣比：Vite 嘅 asset 檔名有 content hash → **檔名變 = build 變** ✓。
 */
function assetNames(html: string): string {
  const names = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+\.(?:js|css))/g)]
    .map((m) => m[1])
    .sort();
  return names.join(",");
}

/**
 * 5174 上面嘅 server 係唔係服務緊**當前** `dist/`？
 *
 * ⚠️ 為何需要（2026-10-07 實測踩過）
 * --------------------------------
 * 原本「5174 已經有 server 就沿用」嘅邏輯，如果嗰個 server 係**改動之前**
 * 起嘅，佢會繼續服務舊 `dist/`（或者 Vite 內部快取）→ 之後所有 e2e 都係
 * 測緊舊 build ✗ —— 而**視覺回歸守衛**會比對「舊 build vs 舊基線」→
 * **假綠** ✗✗（比假紅危險得多）。
 *
 * 修法：沿用之前先核對「server 服務嘅 asset 檔名 == `dist/index.html` 嘅」。
 * ⚠️ 5174 係 e2e 專用 port（`vite.config.ts` 嘅 dev server 係 **5173**）→
 * 判定為「舊 build」時清走重起係安全 ✓。
 */
async function servedDistIsCurrent(): Promise<boolean> {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const served = assetNames(await r.text());
    const local = assetNames(readFileSync(join(process.cwd(), "dist", "index.html"), "utf-8"));
    return local !== "" && served === local;
  } catch {
    return false;
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
    } else if (await servedDistIsCurrent()) {
      console.warn(
        "[e2e] 5174 已經有 server 而且服務緊**當前** dist/ —— 沿用（teardown 唔會關閉佢）。",
      );
      return () => {};
    } else {
      /*
       * ⚠️ 2026-10-07：殘留 server 服務緊**舊 build** → 一定要清走重起。
       * 唔清嘅話之後所有 e2e 都係測舊 build，而**視覺回歸守衛**會變成
       * 「舊 build vs 舊基線」→ **假綠** ✗✗。
       * （5174 係 e2e 專用 port —— dev server 喺 5173 —— 所以清走係安全。）
       */
      console.warn(
        "[e2e] ⚠️ 5174 有殘留 server 但服務緊**舊 build** → 清走重起" +
          "（否則測試會測舊 dist，視覺守衛會假綠）。",
      );
      for (const pid of live) killTree(pid);
      try {
        unlinkSync(PID_FILE);
      } catch {
        /* 已刪 */
      }
      for (let i = 0; i < 20; i++) {
        if (!(await probe(BASE, 1000))) break;
        await sleep(250);
      }
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
