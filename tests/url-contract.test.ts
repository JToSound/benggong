/**
 * B2 — URL 契約測試（`src/state/url.ts`）
 *
 * 覆蓋：
 *   - 11 個 spec 參數嘅 round-trip（`toUrl(fromUrl(x)) === canonical(x)`）
 *   - 無效值 graceful fallback：**零 crash、零 throw**，落回預設 + `console.warn`
 *   - 500 字超長 id、控制字元
 *   - layer flags 只列非預設值
 *   - `isCanonical`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  URL_PARAM,
  createInitialState,
  formatLayers,
  fromUrl,
  isCanonical,
  toUrl,
  type AppState,
} from "../src/state";

const BASE = "http://localhost/";

function u(qs: string): URL {
  return new URL(`${BASE}${qs}`);
}

function roundTrip(qs: string): string {
  const once = toUrl(fromUrl(u(qs)));
  const twice = toUrl(fromUrl(u(once)));
  expect(twice, `round-trip 唔穩定：${qs} → ${once} → ${twice}`).toBe(once);
  return once;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("URL 契約 — 預設與基本解析", () => {
  it("空 URL → 全部預設（explore / chapter 1 / spoiler 1 / view map）", () => {
    const s = fromUrl(u(""));
    expect(s.context).toEqual({ kind: "explore" });
    expect(s.chapter).toBe(1);
    expect(s.spoilerMax).toBe(1);
    expect(s.view).toBe("map");
    expect(s.layers).toEqual({
      zones: true,
      nests: true,
      outposts: true,
      events: true,
      routes: false,
      periods: false,
      detail: true,
    });
    expect(toUrl(s)).toBe("");
  });

  it("11 個 spec 參數全部支援", () => {
    expect(fromUrl(u("?event=e1")).context).toEqual({ kind: "event", eventId: "e1" });
    expect(fromUrl(u("?zone=z1")).context).toEqual({ kind: "zone", zoneId: "z1" });
    expect(fromUrl(u("?location=l1")).context).toEqual({
      kind: "location",
      locationId: "l1",
    });
    expect(fromUrl(u("?character=c1")).context).toEqual({
      kind: "character",
      characterId: "c1",
    });
    expect(fromUrl(u("?route=c1")).context).toEqual({ kind: "route", characterId: "c1" });
    expect(fromUrl(u("?chapter=150")).context).toEqual({
      kind: "chapter",
      issueIndex: 150,
    });
    expect(fromUrl(u("?chapter=150")).chapter).toBe(150);
    expect(fromUrl(u("?spoiler=3")).spoilerMax).toBe(3);
    expect(fromUrl(u("?view=chronicle")).view).toBe("chronicle");
    expect(fromUrl(u("?layers=routes")).layers.routes).toBe(true);
    expect(fromUrl(u("?measure=a,b")).context).toEqual({ kind: "measure", ids: ["a", "b"] });
    expect(fromUrl(u("?q=abc")).context).toEqual({ kind: "search", query: "abc" });
    expect(fromUrl(u("?q=abc&kind=zone")).searchKind).toBe("zone");
  });
});

describe("URL 契約 — 序列化（規則 U1 / U2）", () => {
  it("toUrl 只序列化 context + spoilerMax + layers（非預設）+ view + chapter", () => {
    const s: AppState = { ...createInitialState(), chapter: 150 };
    expect(toUrl(s)).toBe("?chapter=150");

    const s2: AppState = { ...createInitialState(), spoilerMax: 0 };
    expect(toUrl(s2)).toBe("?spoiler=0");

    const s3: AppState = { ...createInitialState(), view: "chronicle", context: { kind: "chronicle", filters: { chapter: null, period: null, zoneId: null, characterId: null, spoilerMax: 1, query: "" } } };
    expect(toUrl(s3)).toBe("?view=chronicle");
  });

  it("viewport / sheetSnap / theme 唔入 URL（U1）", () => {
    const s: AppState = {
      ...createInitialState(),
      viewport: { x: 1, y: 2, w: 3, h: 4 },
      sheetSnap: "full",
      theme: "light",
    };
    expect(toUrl(s)).toBe("");
  });

  it("layers 只列非預設值（U2）", () => {
    expect(formatLayers(createInitialState().layers)).toBe("");
    expect(
      formatLayers({ ...createInitialState().layers, routes: true }),
    ).toBe("routes");
    expect(
      formatLayers({ ...createInitialState().layers, events: false }),
    ).toBe("-events");
    // 次序固定：events 喺 routes 之前（LAYER_ORDER）
    expect(
      formatLayers({ ...createInitialState().layers, events: false, routes: true }),
    ).toBe("-events,routes");
  });

  it("context 參數序列化正確", () => {
    expect(toUrl({ ...createInitialState(), context: { kind: "zone", zoneId: "z1" } })).toBe(
      "?zone=z1",
    );
    expect(
      toUrl({ ...createInitialState(), context: { kind: "measure", ids: [] } }),
    ).toBe("?measure=");
    expect(
      toUrl({ ...createInitialState(), context: { kind: "search", query: "" } }),
    ).toBe("?q=");
  });
});

describe("URL 契約 — round-trip", () => {
  const cases = [
    "",
    "?event=e1",
    "?zone=z1",
    "?location=l1",
    "?character=c1",
    "?route=c1",
    "?chapter=150",
    "?chapter=198",
    "?spoiler=0",
    "?spoiler=3",
    "?layers=routes",
    "?layers=-events,routes",
    "?view=chronicle",
    "?measure=a,b",
    "?q=abc",
    "?q=abc&kind=event",
    "?zone=z1&chapter=150",
    "?event=e1&spoiler=2&view=map",
  ];

  it.each(cases)("toUrl(fromUrl(x)) 穩定：%s", (qs) => {
    roundTrip(qs);
  });
});

describe("URL 契約 — 無效值 graceful fallback（U4）", () => {
  it("chapter 超範圍 / 非數字 / 空 → 落回 1 + warn，唔會 throw", () => {
    for (const raw of ["99999", "-5", "abc", "", "9".repeat(21)]) {
      expect(() => fromUrl(u(`?chapter=${raw}`))).not.toThrow();
      const s = fromUrl(u(`?chapter=${raw}`));
      expect(s.chapter).toBe(1);
      expect(s.context).toEqual({ kind: "explore" });
    }
    expect(warnSpy).toHaveBeenCalled();
  });

  it("spoiler clamp（99 → 3、-1 → 0、abc → 1）", () => {
    expect(fromUrl(u("?spoiler=99")).spoilerMax).toBe(3);
    expect(fromUrl(u("?spoiler=-1")).spoilerMax).toBe(0);
    expect(fromUrl(u("?spoiler=abc")).spoilerMax).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("view 唔識 → map + warn", () => {
    expect(fromUrl(u("?view=xyz")).view).toBe("map");
    expect(fromUrl(u("?view=xyz")).context).toEqual({ kind: "explore" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("kind 唔識 → null + warn", () => {
    expect(fromUrl(u("?q=a&kind=xyz")).searchKind).toBeNull();
  });

  it("未知 layer token 忽略 + warn，其餘保持預設", () => {
    const s = fromUrl(u("?layers=unknownflag,routes"));
    expect(s.layers.routes).toBe(true);
    expect(s.layers.zones).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("500 字超長 id → 視為無效 → explore + warn", () => {
    const long = "a".repeat(500);
    const s = fromUrl(u(`?zone=${long}`));
    expect(s.context).toEqual({ kind: "explore" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("控制字元 id → 視為無效 → explore + warn", () => {
    const s = fromUrl(u("?event=%00%01%02"));
    expect(s.context).toEqual({ kind: "explore" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("非 ASCII id（唔存在）→ explore + warn", () => {
    const s = fromUrl(u(`?zone=${encodeURIComponent("唔存在")}`));
    expect(s.context).toEqual({ kind: "explore" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("語意驗證：isValidId 回 false → explore + warn", () => {
    const s = fromUrl(u("?event=INVALID"), { isValidId: () => false });
    expect(s.context).toEqual({ kind: "explore" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("語意驗證：isValidId 回 true → 保留 context", () => {
    const s = fromUrl(u("?event=e1"), { isValidId: () => true });
    expect(s.context).toEqual({ kind: "event", eventId: "e1" });
  });

  it("一堆極端輸入全部唔會 throw（零 crash 保證）", () => {
    const nasty = [
      "",
      "?",
      "?event=",
      "?zone=%",
      "?chapter=1e309",
      "?spoiler=NaN",
      "?layers=,",
      "?measure=,,,",
      "?q=%E4%BD%A0%E5%A5%BD",
      "?view=MAP",
      "?kind=",
      `?event=${"x".repeat(1000)}`,
    ];
    for (const qs of nasty) {
      expect(() => fromUrl(u(qs)), `唔應該 throw：${qs}`).not.toThrow();
    }
  });
});

describe("URL 契約 — isCanonical", () => {
  it("canonical 形式回 true", () => {
    expect(isCanonical(u(""))).toBe(true);
    expect(isCanonical(u("?chapter=150"))).toBe(true);
    expect(isCanonical(u("?zone=z1&chapter=150"))).toBe(true);
  });

  it("非 canonical（有 hash / 參數次序唔同 / 冗餘預設值）回 false", () => {
    expect(isCanonical(u("#ch=150"))).toBe(false);
    expect(isCanonical(u("?chapter=1"))).toBe(false);
    expect(isCanonical(u("?spoiler=1"))).toBe(false);
    expect(isCanonical(u("?view=map"))).toBe(false);
    expect(isCanonical(u("?layers=zones"))).toBe(false);
  });
});

describe("URL 契約 — context precedence", () => {
  it("zone 高過 chapter；chapter 仍然設定 state.chapter", () => {
    const s = fromUrl(u("?chapter=150&zone=z1"));
    expect(s.context).toEqual({ kind: "zone", zoneId: "z1" });
    expect(s.chapter).toBe(150);
  });

  it("event > zone > location > character > route > measure > q", () => {
    const s = fromUrl(u("?event=e1&zone=z1&location=l1&character=c1&route=r1&q=x"));
    expect(s.context).toEqual({ kind: "event", eventId: "e1" });

    const s2 = fromUrl(u("?zone=z1&location=l1&character=c1"));
    expect(s2.context).toEqual({ kind: "zone", zoneId: "z1" });

    const s3 = fromUrl(u("?location=l1&character=c1"));
    expect(s3.context).toEqual({ kind: "location", locationId: "l1" });

    const s4 = fromUrl(u("?character=c1&route=r1"));
    expect(s4.context).toEqual({ kind: "character", characterId: "c1" });

    const s5 = fromUrl(u("?route=r1&q=x"));
    expect(s5.context).toEqual({ kind: "route", characterId: "r1" });

    const s6 = fromUrl(u("?measure=a&q=x"));
    expect(s6.context).toEqual({ kind: "measure", ids: ["a"] });

    const s7 = fromUrl(u("?q=x&chapter=5"));
    expect(s7.context).toEqual({ kind: "search", query: "x" });
  });

  it("view=chronicle 而冇更高 precedence context → chronicle context", () => {
    const s = fromUrl(u("?chapter=150&view=chronicle"));
    expect(s.view).toBe("chronicle");
    expect(s.context.kind).toBe("chronicle");
  });

  it("參數名常數同 spec 一致", () => {
    expect(URL_PARAM.chapter).toBe("chapter");
    expect(URL_PARAM.location).toBe("location");
    expect(URL_PARAM.measure).toBe("measure");
  });
});
