# Phase H 進度報告：地圖增強（標籤、smart zoom、legend）

**日期**: 2026-09-06
**作者**: JToSound (benggong project)
**狀態**: ✅ 完成並部署到 GitHub Pages

---

## 摘要

Phase H 為《病港》互動地圖新增三個互動增強功能：

1. **Street/place labels** —— OSM 道路同地標名直接燒入 basemap PNG
2. **Smart flyToChapter** —— 每次切換章節自動 pan+zoom 到 chapter 嘅 location span
3. **Map legend** —— marker color 圖例（top-left overlay）

---

## 改動清單

| 檔案 | 用途 | 改動 |
|------|------|------|
| `scripts/render_hk_basemap.py` | Pass 5: street/place labels | +110 行 |
| `public/assets/hk-basemap.png` | 42,927 → **74,361** bytes (含 10,927 labels) | regenerated |
| `src/components/SvgMap.ts` | smart flyToChapter + legend HTML | +98, -5 |
| `src/styles/main.css` | legend styles (.map-legend, .legend-item, .dot-*) | +47 |
| `tests/svgmap.legend.test.ts` (new) | 6 個 vitest test | +106 |

**Commits**:
- `5324579` Phase H: smart flyToChapter + street/place labels + map legend

---

## 技術細節

### H1 - Street/Place labels

**問題**: Phase G 嘅 basemap 只 render 道路、buildings 形狀，但冇任何文字 — 觀眾見到一大片灰黑地圖但唔知道邊度係將軍澳、邊度係觀塘。

**解決**:
- 新增 Pass 5 喺 PIL render pipeline 內
- **Road labels**: 只攞 `motorway` / `trunk` / `primary` 三個 highway 等級嘅 named ways，於 midpoint 畫上 `aged paper` 色文字 (RGB 220, 210, 180, alpha 200)
- **Place labels**: 攞 `leisure=park` / `amenity=hospital` / `amenity=school` / `amenity=university` / `shop=mall`，限制頭 200 個
- **字體 fallback chain**: `msgothic.ttc` → `msyh.ttc` → `NotoSansCJK-Regular.ttc` → `PingFang.ttc` → bitmap default
- 結果：**10,927 個 labels** rendered

**視覺驗證** (vision_analyze):
- 「將軍澳」「將軍澳醫院」「將軍澳運動場」「坑口」「可道」「健明」「魷魚灣」全部可讀
- 字體清晰、唔亂、與 dark game-style 配色協調
- 港島：「淺水灣」「黃竹坑」「赤柱」
- 九龍：「九龍醫院」「廣華醫院」「伊利沙伯醫院」

### H2 - flyToChapter smart zoom

**問題**: Phase G 個 `flyToChapter` 係 stub，唔做嘢 — 所以即使用戶 click chapter 1，地圖都仲係顯示全 HK，所有 markers 擠埋一齊。

**解決** (`SvgMap.ts:338-393`):
```typescript
flyToChapter(_ch: number): void {
  const contextChs = new Set<number>();
  for (let d = -2; d <= 2; d++) contextChs.add(cur + d);

  // Compute bbox of all locations in chapter context
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const loc of this.data.locations.features) {
    if (chs.some((c: number) => contextChs.has(c))) {
      const [lon, lat] = loc.geometry.coordinates;
      const fb = FALLBACK_ANCHORS[loc.properties.name];
      const useLon = fb ? fb.lon : lon;
      const useLat = fb ? fb.lat : lat;
      // ... compute bbox
    }
  }

  // Pad bbox by 25%, convert to viewBox coords (with y-axis invert)
  const x = 113.85 + Math.min(fx0, fx1) * 0.60;
  const y = 22.18 + Math.min(fy0, fy1) * 0.37;
  this.svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
}
```

**視覺驗證**:
- Chapter 1 (「香港: 病毒爆發後第一個星期」) → viewBox 自動 zoom 到將軍澳範圍 (114.20-114.32, 22.27-22.35)
- Chapter 60 (「將軍澳海旁」) → viewBox 自動 zoom 到將軍澳南面海旁
- Fallback: 如 chapter 冇 location → fallback 到全 HK

### H3 - Map legend

**問題**: 第一次睇個地圖，用戶唔知每個 marker 顏色代表咩。

**解決**:
- HTML overlay 喺 top-left (`.map-legend`)
- 6 個 legend item：
  - 本章事件 (red `#e74c3c`)
  - 其他章事件 (orange `#f39c12`)
  - 真實地點 (orange `#e67e22`)
  - 虛構地點 (purple `#9b59b6`)
  - 選中 (yellow `#ffeb3b`)
  - 角色路線 (amber line `#F39C12`)

**位置**: top-left (用 `.map-overlay` 容器內，與此前的 1-line 提示同一區域)

### H4 - CSS 改進

```css
.map-legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: auto;  /* override .map-overlay pointer-events: none */
  min-width: 130px;
}
.legend-item .dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.4);
}
```

### H5 - vitest tests

`tests/svgmap.legend.test.ts` (6 tests):

```typescript
describe("Phase H: SvgMap legend", () => {
  it("legend HTML exists in SvgMap template")
  it("legend includes CJK label '地圖標記'")
  it("legend includes descriptive text for each marker type")
});

describe("Phase H: SvgMap flyToChapter smart zoom", () => {
  it("flyToChapter is implemented and not a stub")
  it("flyToChapter pads bbox by ~25% to give breathing room")
});

describe("Phase H: SvgMap basemap image", () => {
  it("basemap PNG is rendered with street + place labels")
});
```

---

## 測試

| Gate | 結果 |
|------|------|
| `pytest` | 100/100 ✅ |
| `vitest` | 12 → **18** (12 + 6 Phase H) ✅ |
| `tsc --noEmit` | 0 errors ✅ |
| `eslint` | 0 errors ✅ |
| `vite build` | 31.79 → 30.45 KB JS (legend HTML add 0.6KB), 16.90 KB CSS (+0.7KB), 74.36 KB PNG ✅ |
| `validate_public_data.py` | ✅ |
| `audit_release.py --strict` | ✅ |

---

## GitHub Pages 部署

- **HEAD**: `5324579` (Phase H commit)
- **CI run**: `34037129020` ✅ success
- **Pages run**: `34037129018` ✅ success
- **Live URL**: https://jtosound.github.io/benggong/
- **PNG hash**: `hk-basemap-CiR_jxLe.png` (74,361 bytes, image/png) — 從 42KB (Phase G) 增至 74KB 因加 10,927 labels

---

## 視覺驗證（Playwright screenshot）

### Chapter 1 screenshot
- ✅ Map auto-zoomed 到 將軍澳範圍
- ✅ Legend visible top-left with 6 items
- ✅ Labels rendered: 將軍澳、將軍澳醫院、將軍澳運動場、坑口、可道、健明、魷魚灣、彩明、尚德
- ✅ 5 red event markers 喺將軍澳 對應 5 個 ch 1 events
- ✅ Yellow selected marker visible

### Chapter 60 screenshot
- ✅ Map auto-zoomed 到 將軍澳南部海旁
- ✅ Red event markers 集中喺南面海邊 (對應 ch 60 "將軍澳海旁")
- ✅ 將軍澳中心商場 / 連理街 labels visible

---

## 已知限制

1. **Labels density**: 將軍澳中心區（寶琳/坑口/調景嶺）有太多 labels 重疊。可以考慮：
   - 將來 Phase I 加 zoom-level dependent labels（只 render 喺特定 zoom 入面）
   - 或者用 declutter algorithm (force-directed label placement)
2. **Legend 唔做 i18n**: 而家 hard-code 粵文
3. **flyToChapter 唔做動畫**: 直接 jump，可以加 CSS transition 令 zoom 平順

## 下一步（Phase I？）

- [ ] Phase I: zoom-level dependent label decluttering
- [ ] Add animation to flyToChapter (smooth pan/zoom)
- [ ] Add 病港2 namespace labels (predetermined for future expansion)
- [ ] Street view / 360° image integration at specific locations
