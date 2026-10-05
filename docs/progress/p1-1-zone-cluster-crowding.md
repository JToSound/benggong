# P1-1 交付報告 —— 世界視圖 zone 圖層擁擠（cluster badge 被淹沒）

> 對應：C8 對抗驗收 P1-1（`docs/audits/c8-hostile-product-review.md` §P1-1）
> 前置：P1-6（story pane 改浮層）已完成
> 硬規則：**零人手參與**（`AGENTS.md`）—— 全部驗證程式化、可重跑。

---

## 0. 一句話總結

世界視圖（L-Z0）**同時**畫咗 48 個 per-zone 圖騰（`.zone-badge`，實測直徑
**21.4 px**）＋ 6 個 cluster badge（**9.2–11.3 px**）→ 21px 圖騰完全淹沒
10px badge。

但 spec `rendering-lod-strategy.md` §3.2 明文：**L-Z0 = cluster glyph**、
per-zone icon 係 **L-Z2** 嘅元素。即係話呢個唔係「兩個 spec 要求衝突、
需要裁決」，而係**實作偏離 spec** → 修得，唔需要放寬任何 spec 數字。

修法：**已被 cluster 代表嘅 zone 唔再畫 per-zone 圖騰**（交畀 cluster badge
表示），**單獨 zone 照畫**（否則佢哋喺 L-Z0 完全冇表示，違反 D2）。
實測圖騰 **48 → 9**，簇成員 **39** → 9 + 39 = **48**（每個 zone 恰好表示一次）。

---

## 1. ⚠️ 先推翻上一輪「需要 spec 裁決」嘅判斷

`docs/progress/c8-p0-p1-fixes.md` §3.8 寫：

> **兩個 spec 要求合起來就係「10px badge + 48 個 21px 圓」= 必然擁擠**
> → 仍然未解決（需要 spec 層面裁決）：A 放寬 badge 直徑／B 降低 zone 圓視覺權重／C 接受

**呢個 framing 唔準確**。逐項核對 spec 原文：

| spec 條文 | 原文 | 真正含義 |
|---|---|---|
| LOD §3.2 L-Z0 | 「**Cluster glyph**（直徑 8–12 px 嘅 badge，帶 kind icon + 數量）」 | L-Z0 嘅 zone **表示法**就係 cluster glyph |
| LOD §3.2 L-Z2 | 「**完整**：pattern + **icon** + 內部 landmark + danger」 | per-zone **icon** 係 **L-Z2** 嘅元素 |
| 規則 L1 | 「zone **永遠** render（D2）—— 章節只影響 emphasis，**唔過濾**」 | 係講**唔可以按章節過濾**，唔係「每個 zone 都要有獨立 glyph」 |
| D2 | 「48 個 zone 永遠全部 render。章節只作強調，唔作過濾」 | 同上（重點係「唔過濾」） |

→ 「L-Z0 要畫 48 個 21px per-zone 圖騰」**唔係** spec 要求，而係實作自己加嘅
（`SvgMap.ts` 原本嘅註釋寫「cluster 層冇 polygon 光暈做視覺重量，所以徽記畫
大少少」—— 即係刻意放大去補償，冇 spec 依據）。

**結論：唔需要放寬 badge 直徑、唔需要降 zone 圓權重、唔需要「接受」——
照 spec 嘅 L-Z0 定義修就得。**

---

## 2. 診斷（實測，唔靠估）

工具：`artifacts/phase3-resume/probe-zone-crowding.mjs`（可重跑；
`deviceScaleFactor: 3` 出 3× 截圖）。

### 2.1 修復前（1440×900，世界視圖 viewW = 0.70）

```
nZones 48  nAreas 48  nBadges(cluster) 6
.zone-area   n=48  w=3.9–15.3 px   fill-opacity=0.04  pointer-events=auto
.zone-badge  n=48  w=21.4–21.4 px  ← 真正主導視覺嘅元素
zone-cluster n= 6  直徑 9.81–11.25 px
```

- 48 個 zone 全部只佔 **228×218 px**（即 48 個 glyph 塞喺一個細區）
- `.zone-badge` **21.4 px** vs cluster badge **9.8–11.3 px** → **2 倍**差距
- C8 audit 原文：「被 48 個 ~21px 半透明 zone 圓淹沒」→ **完全吻合**（21px 就係 `.zone-badge`）

### 2.2 ⚠️ 為何唔可以「令 cluster badge 可點」（兩個硬約束）

一度考慮「點 badge → 飛去該簇」以解「世界視圖揀唔到特定 zone」，但：

1. **`tests/map-css-contract.test.ts:223`** 明文契約：
   `#svg-map .zone-cluster { pointer-events: none }`（裝飾元素唔搶命中）✗
2. **spec §3 C3 + `mobile-layout.e2e.test.ts`**：可見互動元素要 **≥44×44 px**。
   10px badge 做互動目標會直接違規 ✗

→ 所以唔做。世界視圖揀 zone 仍然靠「點 zone → `flyToZone()` 放大」（P1-2 已修），
鍵盤則用 roving tabindex + Enter。

---

## 3. 修法

`src/components/SvgMap.ts`：

```ts
// cluster 層之下，已被 cluster 代表嘅 zone 唔再畫 per-zone 圖騰
const clusteredZoneIds = new Set(zoneClusters.flatMap((c) => c.memberIds));
...
if (!(zoneIsCluster && clusteredZoneIds.has(zm.id))) {
  // 建 .zone-badge（單獨 zone 照畫）
}
```

**刻意保留嘅嘢**（唔可以改）：
- `.zone` ／ `.zone-area` 總數**不變**（規則 L1；`tests/map-render.test.ts` Q5 有斷言）
- `.zone-area` 嘅 `pointer-events: auto`、可點性、`flyToZone` 全部不變
- cluster badge 直徑、`pointer-events: none` 不變
- 非 cluster 層（L-Z1／L-Z2）嘅 per-zone 圖騰完全不變

---

## 4. 驗證

### 4.1 實測（1440×900）

| 指標 | 前 | 後 |
|---|---|---|
| `.zone-badge`（per-zone 圖騰）數 | **48** | **9** |
| cluster badge 數 / 成員合計 | 6 / 39 | 6 / **39** |
| 圖騰 ＋ 簇成員 | 48 + 39 = 87 ✗（重複表示） | **9 + 39 = 48** ✓ |
| `.zone` ／ `.zone-area` | 48 / 48 | **48 / 48** ✓（不變） |
| cluster badge 直徑 | 9.81–11.25 px | **9.2–11.25 px** ✓ ∈ [8,12] |
| cluster badge 數字／底色對比 | — | **16.45:1** ✓（WCAG AA 要 4.5） |
| cluster badge 繪製次序 | — | **喺全部 `.zone` 之後** ✓（喺上層） |

### 4.2 視覺證據（3× 截圖）

`artifacts/phase3-resume/zones3x-1440x900.png`：
cluster badge（細小深色圓 + 青色環 + 數字「5」「3」「2」）**清楚可讀**，
唔再被 21px 圖騰淹沒 ✓

### 4.3 新增守衛測試（`tests/map-interaction.e2e.test.ts`）

> ⭐ C8 P1-1：每個 zone 恰好被表示一次，cluster badge 唔會被圖騰淹沒

| 斷言 | 內容 |
|---|---|
| ⭐ 表示不變式 | `nTotems + sumClusterCounts === nZones`（48）—— 回歸到「48 個圖騰」會即刻變紅 |
| ⭐ 繪製次序 | `#zones-layer` 內全部 `.zone-cluster` 都排喺全部 `.zone` **之後**（SVG 冇 z-index，後畫者喺上層 → badge 一定喺圖騰之上） |
| ⭐ 對比 | cluster badge 數字／底色對比 **≥4.5**（WCAG AA） |
| 規則 L1 | `.zone-area` 總數 === `.zone` 總數 |

⚠️ **刻意唔斷言「幾何零重疊」**：48 個 zone 只佔 0.1°（1440×900 之下全部落喺
228×218 px），21px 單獨圖騰同 10px badge **必然**幾何相交（實測：最多 4 個
矩形相交、1 個中心落喺 badge 內）。嗰個係密度事實，唔係遮蓋 —— 遮蓋與否由
**繪製次序**決定。硬性斷言零相交會變成長期 flaky。

### 4.4 閘門

| 閘門 | 結果 |
|---|---|
| `typecheck` / `lint` | 0 / 0 |
| `npm run test`（全套 vitest） | 見 `artifacts/phase3-resume/full-vitest9.log` |
| `pytest` / `validate` / `audit` | 見 §6 |

---

## 5. 已知限制（誠實記錄）

| ID | 限制 | 說明 |
|---|---|---|
| P1-1-1 | **單獨 zone 圖騰仍然係 21.4 px** | 冇改（唔係 C8 投訴對象）。spec 只定義 cluster glyph 嘅 8–12 px，冇定義「非簇 zone」喺 L-Z0 嘅尺寸。若果要統一成 8–12 px，係另一個設計決定。 |
| P1-1-2 | **單獨圖騰同 cluster badge 幾何相交** | 密集區必然（實測 1 個中心相交）。因為 badge 後畫（上層），實際唔遮蓋；3× 截圖已驗證可讀。 |
| P1-1-3 | **世界視圖唔可以直接揀特定 zone** | 受 §2.2 兩個硬約束限制（`pointer-events: none` 契約 ＋ C3 44px）。現時做法：點 zone → `flyToZone()` 放大（P1-2）；鍵盤用 roving tabindex + Enter。 |
| P1-1-4 | **`.zone-cluster` 冇 keyboard 入口** | 同上（唔加互動就唔需要）。鍵盤用戶靠 `.zone` 嘅 roving tabindex。 |
| P1-1-5 | **1920×1080 之下係 8 個 cluster**（唔係 6） | cluster 數隨視窗尺寸變（格聚類 cell 係 px-anchored）—— 屬預期行為，唔係缺陷。 |
| P1-1-6 | ⚠️ **e2e 設定步驟要 `force: true`** | `tests/map-interaction.e2e.test.ts`「輕觸要選中、拖曳要平移」嘅「先收面板」步驟，喺**全套測試（CPU 高負載）**之下 Playwright 嘅「visible, enabled and stable」檢查會超時 30 s（單獨跑該檔 14/14 過）。屬**負載 flakiness**，唔係產品問題；已改 `{ force: true, timeout: 15_000 }`（仍然派發真滑鼠 click）。**呢個係專案已知嘅 e2e 不穩定類別**（見 `docs/audits/e2e-instability-diagnosis.md`）。 |

---

## 6. 重跑指令

```bash
# 量測 + 3× 截圖（⚠️ 跑完要手動清 5174）
node artifacts/phase3-resume/probe-zone-crowding.mjs

# 守衛測試（單跑，約 8 秒）
npx vitest run tests/map-interaction.e2e.test.ts -t "C8 P1-1"

# 全套閘門
npm run typecheck && npm run lint && npm run test
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe -m pytest -q
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/validate_public_data.py
C:/Users/User/AppData/Local/Microsoft/WindowsApps/python3.12.exe scripts/audit_release.py
```

⚠️ 環境陷阱：改完 source 一定要 `npm run build`（e2e 讀 `dist/`）；
`dist-stale-*` 要即刻清走，否則 `eslint .` 會爆 400+ 假錯誤（E11）。

---

## 7. 下一步（只限「擴充自動驗證規則／加語義約束」，零人手）

| ID | 建議 | 針對 |
|---|---|---|
| P1-1-6 | 為「非簇 zone 喺 L-Z0 嘅 glyph 尺寸」訂一條明文政策（寫入 `map-lod.ts` ＋ 斷言） | P1-1-1 |
| P1-1-7 | 加「cluster badge 唔可以被同層元素**後畫**」嘅通用守衛（唔止 zone-cluster，`.location-marker-cluster` 亦適用） | P1-1-2 |
| P1-1-8 | 將 `probe-zone-crowding.mjs` 嘅量測納入 CI（記錄 `.zone-badge` 數、對比、繪製次序） | 防止靜默回歸 |
