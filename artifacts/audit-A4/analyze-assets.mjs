/**
 * A4 Map Rendering Engineer —— 離線資產分析
 *
 * 只讀 public/assets/**，輸出 JSON + 可讀報告到 artifacts/audit-A4/。
 * 唔會改任何 production file。
 *
 * 執行：node artifacts/audit-A4/analyze-assets.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const VEC = path.join(ROOT, "public/assets/vector");
const LOD = path.join(ROOT, "public/assets/map-lod");
const OUT = path.join(ROOT, "artifacts/audit-A4");

const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const size = (p) => fs.statSync(p).size;

const PROJ_COS = 0.9247;
const BASE_BBOX = { lon_min: 113.79, lon_max: 114.49, lat_min: 22.11, lat_max: 22.61 };
const BASE_VIEW_W = BASE_BBOX.lon_max - BASE_BBOX.lon_min; // 0.70

/** 由 baseline metrics 實測：預設 zoom-in 到上限之後嘅 viewBox。 */
const MAXZOOM_VIEW = { x: 114.13, y: 22.372633440961547, w: 0.02, h: 0.01544902593891455 };

/** 由 zoomSeries 實測：初始 viewBox。 */
const INITIAL_VIEW = { x: 113.79, y: 22.11, w: 0.7, h: 0.5407159078620093 };

/** 地圖容器 CSS 尺寸（baseline 實測 desktop 1440）。 */
const VIEWPORT_CSS_W = 1060;
const VIEWPORT_CSS_H = 752;

// ------------------------------------------------------------------
// 1. 向量圖層
// ------------------------------------------------------------------

function decodeBBox(arr, quant) {
  // 只計 bbox，唔需要完整解碼
  let x = 0, y = 0, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const n = arr.length >> 1;
  for (let i = 0; i < n; i++) {
    if (i === 0) { x = arr[0]; y = arr[1]; } else { x += arr[i * 2]; y += arr[i * 2 + 1]; }
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return { lon_min: minx / quant, lon_max: maxx / quant, lat_min: miny / quant, lat_max: maxy / quant };
}

const vmanifest = readJSON(path.join(VEC, "manifest.json"));
const Q = vmanifest.quant;

const layerStats = {};

// land / water
for (const name of ["land", "water"]) {
  const d = readJSON(path.join(VEC, `${name}.json`));
  const rings = d.rings;
  let pts = 0;
  const bb = { lon_min: Infinity, lon_max: -Infinity, lat_min: Infinity, lat_max: -Infinity };
  for (const r of rings) {
    pts += r.length >> 1;
    const b = decodeBBox(r, Q);
    bb.lon_min = Math.min(bb.lon_min, b.lon_min); bb.lon_max = Math.max(bb.lon_max, b.lon_max);
    bb.lat_min = Math.min(bb.lat_min, b.lat_min); bb.lat_max = Math.max(bb.lat_max, b.lat_max);
  }
  layerStats[name] = { file: `${name}.json`, bytes: size(path.join(VEC, `${name}.json`)), rings: rings.length, points: pts, bbox: bb };
}

// areas
{
  const d = readJSON(path.join(VEC, "areas.json"));
  const areas = d.areas;
  let pts = 0; const byKind = {};
  for (const a of areas) { pts += a.r.length >> 1; byKind[a.k] = (byKind[a.k] || 0) + 1; }
  layerStats.areas = { file: "areas.json", bytes: size(path.join(VEC, "areas.json")), areas: areas.length, points: pts, byKind };
}

// roads l0 / l1
for (const name of ["roads-l0", "roads-l1"]) {
  const d = readJSON(path.join(VEC, `${name}.json`));
  const roads = d.roads;
  let pts = 0; const byCls = {};
  for (const r of roads) { pts += (r.length - 2) >> 1; byCls[r[0]] = (byCls[r[0]] || 0) + 1; }
  layerStats[name] = { file: `${name}.json`, bytes: size(path.join(VEC, `${name}.json`)), roads: roads.length, points: pts, byCls };
}

// labels
{
  const d = readJSON(path.join(VEC, "labels.json"));
  const labels = d.labels;
  const byRank = {};
  let inMaxZoom = 0;
  const bb = { lon_min: Infinity, lon_max: -Infinity, lat_min: Infinity, lat_max: -Infinity };
  const mz = maxZoomGeo();
  for (const l of labels) {
    byRank[l.r] = (byRank[l.r] || 0) + 1;
    const lon = l.x / Q, lat = l.y / Q;
    bb.lon_min = Math.min(bb.lon_min, lon); bb.lon_max = Math.max(bb.lon_max, lon);
    bb.lat_min = Math.min(bb.lat_min, lat); bb.lat_max = Math.max(bb.lat_max, lat);
    if (lon >= mz.lon_min && lon <= mz.lon_max && lat >= mz.lat_min && lat <= mz.lat_max) inMaxZoom++;
  }
  layerStats.labels = { file: "labels.json", bytes: size(path.join(VEC, "labels.json")), labels: labels.length, byRank, bbox: bb, inMaxZoomViewport: inMaxZoom };
}

// ------------------------------------------------------------------
// 2. viewBox → 地理 bbox
// ------------------------------------------------------------------
function viewToGeo(v) {
  const fx0 = (v.x - BASE_BBOX.lon_min) / BASE_VIEW_W;
  const fx1 = (v.x + v.w - BASE_BBOX.lon_min) / BASE_VIEW_W;
  const fy0 = (v.y - BASE_BBOX.lat_min) / ((BASE_BBOX.lat_max - BASE_BBOX.lat_min) / PROJ_COS);
  const fy1 = (v.y + v.h - BASE_BBOX.lat_min) / ((BASE_BBOX.lat_max - BASE_BBOX.lat_min) / PROJ_COS);
  const lonSpan = BASE_BBOX.lon_max - BASE_BBOX.lon_min;
  const latSpan = BASE_BBOX.lat_max - BASE_BBOX.lat_min;
  return {
    lon_min: BASE_BBOX.lon_min + fx0 * lonSpan,
    lon_max: BASE_BBOX.lon_min + fx1 * lonSpan,
    lat_max: BASE_BBOX.lat_max - fy0 * latSpan,
    lat_min: BASE_BBOX.lat_max - fy1 * latSpan,
  };
}
function maxZoomGeo() { return viewToGeo(MAXZOOM_VIEW); }

// ------------------------------------------------------------------
// 3. 圖磚密度（max zoom viewport）
// ------------------------------------------------------------------
const TD = vmanifest.tile_deg;
const TILE_BBOX = vmanifest.bbox;
const mzGeo = maxZoomGeo();

function tileKeyOf(lon, lat) {
  const c = Math.floor((lon - TILE_BBOX.lon_min) / TD);
  const r = Math.floor((lat - TILE_BBOX.lat_min) / TD);
  return { r, c, file: `tiles/r${String(r).padStart(2, "0")}c${String(c).padStart(2, "0")}.json` };
}

const tileDensity = { viewportGeo: mzGeo, tiles: [], missing: [] };
{
  const r0 = Math.floor((mzGeo.lat_min - TILE_BBOX.lat_min) / TD) - 1;
  const r1 = Math.floor((mzGeo.lat_max - TILE_BBOX.lat_min) / TD) + 1;
  const c0 = Math.floor((mzGeo.lon_min - TILE_BBOX.lon_min) / TD) - 1;
  const c1 = Math.floor((mzGeo.lon_max - TILE_BBOX.lon_min) / TD) + 1;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const f = `tiles/r${String(r).padStart(2, "0")}c${String(c).padStart(2, "0")}.json`;
      const fp = path.join(VEC, f);
      if (!fs.existsSync(fp)) { tileDensity.missing.push(f); continue; }
      const d = readJSON(fp);
      const roads = d.roads || [], bld = d.bld || [], poi = d.poi || [];
      const byCls = {};
      for (const x of roads) byCls[x[0]] = (byCls[x[0]] || 0) + 1;
      tileDensity.tiles.push({ file: f, bytes: size(fp), roads: roads.length, buildings: bld.length, poi: poi.length, byCls });
    }
  }
  tileDensity.totalRoads = tileDensity.tiles.reduce((a, t) => a + t.roads, 0);
  tileDensity.totalBuildings = tileDensity.tiles.reduce((a, t) => a + t.buildings, 0);
  tileDensity.totalPoi = tileDensity.tiles.reduce((a, t) => a + t.poi, 0);
}

// ------------------------------------------------------------------
// 4. 全港圖磚覆蓋（邊啲格有 / 冇）
// ------------------------------------------------------------------
const coverage = { td: TD, cols: 0, rows: 0, present: [], missing: [] };
{
  const nc = Math.ceil((TILE_BBOX.lon_max - TILE_BBOX.lon_min) / TD);
  const nr = Math.ceil((TILE_BBOX.lat_max - TILE_BBOX.lat_min) / TD);
  coverage.cols = nc; coverage.rows = nr; coverage.totalCells = nc * nr;
  for (let r = 0; r < nr; r++) {
    for (let c = 0; c < nc; c++) {
      const f = `r${String(r).padStart(2, "0")}c${String(c).padStart(2, "0")}.json`;
      if (fs.existsSync(path.join(VEC, "tiles", f))) coverage.present.push(`${r},${c}`);
      else coverage.missing.push(`${r},${c}`);
    }
  }
  coverage.presentCount = coverage.present.length;
  coverage.missingCount = coverage.missing.length;
}

// ------------------------------------------------------------------
// 5. LOD tier 尺寸 / 縮放比
// ------------------------------------------------------------------
const lod = readJSON(path.join(LOD, "manifest.json"));
const lodTable = lod.tiers.map((t) => {
  const spanLon = t.bbox.lon_max - t.bbox.lon_min;
  const spanLat = t.bbox.lat_max - t.bbox.lat_min;
  const [iw, ih] = t.output_size;
  const nativePxPerDeg = iw / spanLon;
  const covers = (
    t.bbox.lon_min <= mzGeo.lon_min && t.bbox.lon_max >= mzGeo.lon_max &&
    t.bbox.lat_min <= mzGeo.lat_min && t.bbox.lat_max >= mzGeo.lat_max
  );
  // 視窗喺「剛剛好等於 tier 跨度」時（最佳情況）
  const ratioWhenSelected = (VIEWPORT_CSS_W / spanLon) / nativePxPerDeg;
  // 視窗喺全域 max zoom（0.02°）時
  const ratioAtMaxZoom = (VIEWPORT_CSS_W / MAXZOOM_VIEW.w) / nativePxPerDeg;
  return {
    id: t.id, bytes: t.bytes, output_size: t.output_size, bbox: t.bbox,
    spanLon: +spanLon.toFixed(4), spanLat: +spanLat.toFixed(4),
    nativePxPerDeg: Math.round(nativePxPerDeg),
    coversMaxZoomViewport: covers,
    upscaleRatioWhenSelected: +ratioWhenSelected.toFixed(2),
    upscaleRatioAtMaxZoom: +ratioAtMaxZoom.toFixed(2),
  };
});

// 依「覆蓋 max zoom viewport」篩選，再揀最窄 —— 即前端 pickTier 邏輯
const covering = lodTable.filter((t) => t.coversMaxZoomViewport);
const picked = covering.length
  ? covering.reduce((b, t) => (t.spanLon < b.spanLon ? t : b))
  : lodTable.reduce((b, t) => (t.spanLon < b.spanLon ? t : b));

// 每個 tier 對應「最窄仍然會被選中嘅視窗寬度」= 自己跨度
const lodSelectionTable = lodTable.map((t) => ({
  id: t.id,
  selectedWhenViewWidthLE: t.spanLon,
  approxZoomScale: +(BASE_VIEW_W / t.spanLon).toFixed(2),
}));

const report = {
  generatedAt: new Date().toISOString(),
  constants: { PROJ_COS, BASE_BBOX, BASE_VIEW_W, TD, Q, VIEWPORT_CSS_W, VIEWPORT_CSS_H },
  maxZoomViewport: { view: MAXZOOM_VIEW, geo: mzGeo },
  initialViewport: { view: INITIAL_VIEW, geo: viewToGeo(INITIAL_VIEW) },
  layerStats,
  tileDensity,
  tileCoverage: { presentCount: coverage.presentCount, missingCount: coverage.missingCount, cols: coverage.cols, rows: coverage.rows, totalCells: coverage.totalCells, missing: coverage.missing },
  lodTable,
  lodPickedAtMaxZoom: picked,
  lodSelectionTable,
};

fs.writeFileSync(path.join(OUT, "asset-analysis.json"), JSON.stringify(report, null, 2));

// ------------------------------------------------------------------
// 可讀摘要
// ------------------------------------------------------------------
const L = [];
L.push("# A4 離線資產分析（實測）\n");
L.push(`產生時間：${report.generatedAt}\n`);
L.push("## 向量圖層\n");
L.push("| 檔案 | bytes | 特徵數 | 頂點數 |");
L.push("|---|---|---|---|");
for (const [k, v] of Object.entries(layerStats)) {
  const n = v.rings ?? v.areas ?? v.roads ?? v.labels;
  const p = v.points ?? "—";
  L.push(`| ${v.file} | ${v.bytes} | ${n} | ${p} |`);
}
L.push(`\nlabels byRank：${JSON.stringify(layerStats.labels.byRank)}`);
L.push(`\nlabels 喺 max zoom 視窗內：${layerStats.labels.inMaxZoomViewport}`);
L.push(`\n## max zoom 視窗\n`);
L.push(`viewBox = ${JSON.stringify(MAXZOOM_VIEW)}`);
L.push(`geo = ${JSON.stringify(mzGeo)}`);
L.push(`\n## 圖磚密度（max zoom 視窗 + ±1 格）\n`);
L.push("| tile | bytes | roads | buildings | poi |");
L.push("|---|---|---|---|---|");
for (const t of tileDensity.tiles) L.push(`| ${t.file} | ${t.bytes} | ${t.roads} | ${t.buildings} | ${t.poi} |`);
L.push(`\n合計：roads=${tileDensity.totalRoads} buildings=${tileDensity.totalBuildings} poi=${tileDensity.totalPoi}；缺格=${tileDensity.missing.length}`);
L.push(`\n## 全港圖磚覆蓋\n`);
L.push(`格網 ${coverage.cols}×${coverage.rows} = ${coverage.totalCells} 格；有 ${coverage.presentCount}，缺 ${coverage.missingCount}`);
L.push(`\n## LOD tier 尺寸 / 縮放比\n`);
L.push("| tier | image | spanLon° | native px/° | 覆蓋 max-zoom 視窗? | 選中時放大 | max zoom 放大 |");
L.push("|---|---|---|---|---|---|---|");
for (const t of lodTable) {
  L.push(`| ${t.id} | ${t.output_size[0]}×${t.output_size[1]} | ${t.spanLon} | ${t.nativePxPerDeg} | ${t.coversMaxZoomViewport ? "✅" : "❌"} | ${t.upscaleRatioWhenSelected}× | ${t.upscaleRatioAtMaxZoom}× |`);
}
L.push(`\n**max zoom 時 pickTier 會揀：** ${picked.id}（放大 ${picked.upscaleRatioAtMaxZoom}×）`);

fs.writeFileSync(path.join(OUT, "asset-analysis.md"), L.join("\n") + "\n");
console.log(L.join("\n"));
