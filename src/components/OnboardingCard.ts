/**
 * OnboardingCard.ts — 初次入站非阻塞引導卡（B8）
 *
 * 為何要呢個檔（spec IA §5.1 / A1 IA-P0-2 / A7 P1-4）
 * =================================================
 * spec §5.1 要求四個語意入口**全部存在、可鍵盤達、>=44x44**：
 *
 *   | 入口         | 行為                                    |
 *   |-------------|----------------------------------------|
 *   | 探索地區      | 顯示全部 48 zone + 開 zone layer         |
 *   | 搵角色        | 開 search，filter 預設 character          |
 *   | 搵事件        | 開 search，filter 預設 event              |
 *   | 打開編年史     | 切去 chronicle view                     |
 *
 * 現況（A1 實測）：「探索地區」文案**完全唔存在**、「搵角色」／「搵事件」
 * 唔存在；頂部 8 個 nav 掣有 3 個係**純 emoji**（🔗 ⬇ ?）冇文字標籤。
 * 而且首屏除咗 `h1` 之外冇任何 heading（A7 P1-4），螢幕閱讀器用戶用
 * heading 導覽（NVDA/JAWS 嘅 `H` 鍵）完全跳唔到區塊。
 *
 * 契約（見 `docs/contracts/b8-interface-contract.md`）
 * ------------------------------------------------
 *   · **非阻塞**：唔搶 focus、唔擋地圖操作（`pointer-events` 由 CSS 控制）。
 *   · 提供 `h2` heading（解決 P1-4「首屏冇 heading」）。
 *   · 每粒掣 >=44x44 + 可見 focus ring（規則 C3）。
 *   · dismiss 狀態用 `localStorage`，讀寫包 try/catch（私密模式唔可以壞）。
 *   · 四個入口只做**派發 callback** —— 唔自己改 state（規則 C1）。
 */

import type { SearchKind } from "../types/state";

/** 四個主入口（spec IA §5.1）。 */
export type EntryAction = "explore" | "character" | "event" | "chronicle";

export interface OnboardingCardOptions {
  /** 卡附加喺邊（通常 `#map-pane`，令它浮喺地圖上）。 */
  root: HTMLElement;
  /** 用戶揀咗一個入口。 */
  onEntry(action: EntryAction): void;
  /** 「唔再顯示」被按下。 */
  onDismiss?(): void;
}

/** localStorage key（`persistence.ts` 嘅命名慣例：`binggang.` 前綴）。 */
export const ONBOARDING_KEY = "binggang.onboarding.dismissed";

const ENTRIES: ReadonlyArray<{ action: EntryAction; label: string; hint: string }> = [
  { action: "explore", label: "探索地區", hint: "顯示全部 48 個區域" },
  { action: "character", label: "搵角色", hint: "搜角色名同別名" },
  { action: "event", label: "搵事件", hint: "搜事件標題同描述" },
  { action: "chronicle", label: "打開編年史", hint: "按時期睇故事時間軸" },
];

/** 由入口 → 預設搜尋種類（`explore` / `chronicle` 唔開搜尋）。 */
export function kindForEntry(action: EntryAction): SearchKind | null {
  switch (action) {
    case "character":
      return "character";
    case "event":
      return "event";
    default:
      return null;
  }
}

/** 安全讀 dismiss 狀態（localStorage 可能被禁 / 塞滿）。 */
export function isDismissed(storage?: Storage): boolean {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    return s?.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return false;
  }
}

/** 安全寫 dismiss 狀態。 */
export function markDismissed(storage?: Storage): void {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    s?.setItem(ONBOARDING_KEY, "1");
  } catch {
    /* 唔可以因為儲存失敗而壞 */
  }
}

export class OnboardingCard {
  private root: HTMLElement;
  private opts: OnboardingCardOptions;
  private el: HTMLElement | null = null;
  private bound: Array<{ el: EventTarget; type: string; fn: EventListener }> = [];

  constructor(opts: OnboardingCardOptions) {
    this.root = opts.root;
    this.opts = opts;
  }

  /** 建立並顯示（如果未 dismiss 過）。 */
  show(): void {
    if (isDismissed()) return;
    if (!this.el) this.build();
    if (this.el) this.el.hidden = false;
  }

  hide(): void {
    if (this.el) this.el.hidden = true;
  }

  /** 目前可見？ */
  get visible(): boolean {
    return Boolean(this.el && !this.el.hidden);
  }

  private build(): void {
    const el = document.createElement("section");
    el.className = "onboarding-card";
    el.setAttribute("aria-labelledby", "onboarding-title");
    el.innerHTML = `
      <h2 id="onboarding-title">開始探索《病港》世界</h2>
      <p>呢個地圖收錄 48 個區域、704 個地點、1,796 條事件。揀一個入口開始：</p>
      <div class="onboarding-actions">
        ${ENTRIES.map(
          (e) =>
            `<button type="button" class="onboarding-action" data-entry="${e.action}" title="${e.hint}">${e.label}</button>`,
        ).join("")}
      </div>
      <button type="button" class="onboarding-dismiss" data-dismiss="1">唔再顯示</button>
    `;
    this.root.appendChild(el);
    this.el = el;

    const on = (target: EventTarget, type: string, fn: EventListener): void => {
      target.addEventListener(type, fn);
      this.bound.push({ el: target, type, fn });
    };

    on(el, "click", ((e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const entryBtn = t.closest<HTMLElement>("[data-entry]");
      if (entryBtn) {
        const action = entryBtn.dataset.entry as EntryAction;
        this.opts.onEntry(action);
        // 揀咗入口之後收起引導卡（唔再擋地圖）
        this.hide();
        markDismissed();
        return;
      }
      if (t.closest("[data-dismiss]")) {
        this.opts.onDismiss?.();
        this.hide();
        markDismissed();
      }
    }) as EventListener);
  }

  destroy(): void {
    for (const { el, type, fn } of this.bound) el.removeEventListener(type, fn);
    this.bound = [];
    this.el?.remove();
    this.el = null;
  }
}
