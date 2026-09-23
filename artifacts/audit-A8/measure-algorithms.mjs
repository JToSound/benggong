/**
 * A8 — 演算法成本微基準（純 node，可重跑）
 *
 * 複製 production code 嘅關鍵演算法，量度其成本：
 *   1. ChronicleView.visibleEntries() + grouped() —— 每次 render 實際呼叫 8 次
 *   2. VectorBasemap.drawLabels() 嘅 sort（每次 canvas draw 都做）
 *   3. SearchBox 線性掃描（330 char + 1796 event + 704 loc）
 *
 * 執行：node artifacts/audit-A8/measure-algorithms.mjs
 * 輸出：artifacts/audit-A8/algorithm-cost.json
 */

import fs from "node:fs";

const OUT = "artifacts/audit-A8/algorithm-cost.json";

function ms(fn, iters = 1) {
  const t0 = process.hrtime.bigint();
  let r;
  for (let i = 0; i < iters; i++) r = fn();
  const t1 = process.hrtime.bigint();
  return { ms: Number(t1 - t0) / 1e6 / iters, result: r };
}

const rd = (f) => JSON.parse(fs.readFileSync("data/public/" + f, "utf8"));

const chronicle = rd("chronicle.json");
const labels = JSON.parse(fs.readFileSync("public/assets/vector/labels.json", "utf8"));
const characters = rd("characters.json");
const events = rd("events.geojson");
const locations = rd("locations.geojson");

// ---------- 1. Chronicle ----------
const PERIOD_ORDER = ["pre_outbreak", "outbreak", "early", "basecamp", "lohas", "endgame"];
const PERIOD_LABEL = { pre_outbreak: "爆發前", outbreak: "病毒爆發", early: "爆發初期", basecamp: "大本營時期", lohas: "康城時期", endgame: "終局" };

function periodOf(e) {
  const src = e.story_time.source;
  return src === "llm_period" || src === "chapter_boundary" ? e.story_time.label : null;
}
function visibleEntries(filterChapter, entries) {
  let list = entries;
  if (filterChapter !== null) list = list.filter((e) => e.chapters.some((c) => c.chapter === filterChapter));
  const periodIdx = (e) => {
    const label = periodOf(e);
    const key = Object.keys(PERIOD_LABEL).find((k) => PERIOD_LABEL[k] === label);
    return key ? PERIOD_ORDER.indexOf(key) : PERIOD_ORDER.length;
  };
  return [...list].sort((a, b) => periodIdx(a) - periodIdx(b) || a.first_mention_chapter - b.first_mention_chapter || a.title.localeCompare(b.title));
}
function grouped(filterChapter, entries) {
  const out = [];
  for (const key of PERIOD_ORDER) {
    const items = visibleEntries(filterChapter, entries).filter((e) => periodOf(e) === PERIOD_LABEL[key]);
    if (items.length) out.push({ key, items });
  }
  const rest = visibleEntries(filterChapter, entries).filter((e) => periodOf(e) === null);
  if (rest.length) out.push({ key: "_unknown", items: rest });
  return out;
}
// 一次完整 render = grouped()（7 次 visibleEntries）+ total（1 次）
function oneRenderPass(filterChapter) {
  const g = grouped(filterChapter, chronicle.entries);
  const total = visibleEntries(filterChapter, chronicle.entries).length;
  return { groups: g.length, total };
}
const chronicleFull = ms(() => oneRenderPass(null), 20);
const chronicleFiltered = ms(() => oneRenderPass(131), 20);
// 只計一次 visibleEntries
const oneVisible = ms(() => visibleEntries(null, chronicle.entries), 50);

// ---------- 2. Canvas label sort（每次 draw） ----------
const labelArr = labels.labels;
const labelSort = ms(() => [...labelArr].sort((p, q) => p.r - q.r), 50);

// ---------- 3. Search 線性掃描 ----------
function searchScan(q0) {
  const q = q0.toLowerCase();
  const results = [];
  for (const c of characters) {
    if (c.name.toLowerCase().includes(q) || (c.aliases || []).some((a) => a.toLowerCase().includes(q))) results.push(c.name);
  }
  for (const ev of events.features) {
    const p = ev.properties;
    if (p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) results.push(p.title);
  }
  for (const loc of locations.features) {
    if (loc.properties.name.toLowerCase().includes(q)) results.push(loc.properties.name);
  }
  return results.length;
}
const searchCosts = {};
for (const term of ["大本營", "陳", "將軍澳", "病", "a"]) {
  searchCosts[term] = ms(() => searchScan(term), 30).ms;
}
// 逐字（無 debounce → 每個 keystroke 都掃一次）
const typingCost = ms(() => {
  let acc = 0;
  for (const p of ["將", "將軍", "將軍澳", "將軍澳大", "將軍澳大本", "將軍澳大本營"]) acc += searchScan(p);
  return acc;
}, 10);

// ---------- 4. SvgMap.render() 內嘅線性掃描 ----------
// routeVertex: 每個 waypoint 對 704 locations 做 find
const routes = rd("routes.geojson");
let waypointCount = 0;
for (const r of routes.features) waypointCount += (r.properties.waypoints || []).length;
const findCost = ms(() => {
  let hits = 0;
  for (const r of routes.features) {
    for (const wp of r.properties.waypoints || []) {
      const loc = locations.features.find((l) => l.properties.id === wp.location_id);
      if (loc) hits++;
    }
  }
  return hits;
}, 5);
// render() 內 locationsToShow filter
const locFilter = ms(() => locations.features.filter((l) => {
  if (l.properties.map_hidden) return false;
  const fp = l.properties.first_appearance;
  const chs = l.properties.chapters || [fp];
  return chs.some((c) => Math.abs(c - 100) <= 3) || fp === 100;
}), 50);

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  counts: {
    chronicleEntries: chronicle.entries.length,
    labels: labelArr.length,
    characters: characters.length,
    events: events.features.length,
    locations: locations.features.length,
    routes: routes.features.length,
    routeWaypoints: waypointCount,
  },
  chronicle: {
    oneRenderPassFullMs: Math.round(chronicleFull.ms * 100) / 100,
    oneRenderPassFilteredMs: Math.round(chronicleFiltered.ms * 100) / 100,
    oneVisibleEntriesCallMs: Math.round(oneVisible.ms * 100) / 100,
    visibleEntriesCallsPerRender: 8,
    note: "render() = grouped() 內 7 次 visibleEntries() + total 1 次 = 8 次",
  },
  canvas: {
    labelSortPerDrawMs: Math.round(labelSort.ms * 100) / 100,
    labelsCount: labelArr.length,
    note: "每次 canvas draw（每個 rAF）都 [...labels].sort()",
  },
  search: {
    perTermMs: Object.fromEntries(Object.entries(searchCosts).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    typingTotalMs: Math.round(typingCost.ms * 100) / 100,
    note: "無 debounce；每個 keystroke 都掃 330+1796+704",
  },
  svgMap: {
    routeWaypointFindMs: Math.round(findCost.ms * 100) / 100,
    routeWaypoints: waypointCount,
    locationsFilterMs: Math.round(locFilter.ms * 100) / 100,
  },
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log("→", OUT);
