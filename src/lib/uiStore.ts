// 《病港》— 輕量 UI 狀態 store（零依賴 pub/sub）
// 劇透等級、搜尋字串、當前選中實體等跨模組共享。

export interface UIState {
  maxSpoiler: number;
  searchQuery: string;
  selectedEventId: string | null;
  selectedLocationId: string | null;
}

type Listener = (state: Readonly<UIState>) => void;

const state: UIState = {
  maxSpoiler: 1,
  searchQuery: "",
  selectedEventId: null,
  selectedLocationId: null,
};

const listeners = new Set<Listener>();

export function getUIState(): Readonly<UIState> {
  return state;
}

export function setUIState(patch: Partial<UIState>): void {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof UIState;
    if (state[key] !== v) {
      Object.assign(state, { [key]: v });
      changed = true;
    }
  }
  if (changed) {
    for (const fn of listeners) fn(state);
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
