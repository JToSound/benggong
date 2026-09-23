/**
 * A4 —— 最大 zoom 視窗內「實際有幾多嘢」量測
 * 對兩個視窗做統計：(a) 預設中心（葵涌／荔枝角一帶）(b) 將軍澳（故事主場景）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const VEC = path.join(ROOT, "public/assets/vector");
const PUB = path.join(ROOT, "public/data/public");
const OUT = path.join(ROOT, "artifacts/audit-A4");
const Q = 100000;
const TD = 0.05;
const BB = { lon_min: 113.79, lon_max: 114.49, lat_min: 22.11, lat_max: 22.61 };

const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** 由 label-probe 實測得到嘅兩個 max-zoom 視窗。 */
const WINDOWS = [
  { tag: "default-center (葵涌/荔枝角)", lon_min: 114.13, lon_max: 114.15, lat_min: 22.352857, lat_max: 22.367143 },
  { tag: "tko (將軍澳/寶琳)", lon_min: 114.257215, lon_max: 114.277215, lat_min: 22.318087, lat_max: 22.332373 },
];

const inWin = (w, lon, lat) => lon >= w.lon_min && lon <= w.lon_max && lat >= w.lat_min && lat <= w.lat_max;

// 圖磚
const tiles = {};
for (const f of fs.readdirSync(path.join(VEC, "tiles"))) {
  tiles[f] = readJSON(path.join(VEC, "tiles", f));
}
const labels = readJSON(path.join(VEC, "labels.json")).labels;

const out = [];
for (const w of WINDOWS) {
  const r = { tag: w.tag, window: w };
  // 相關圖磚
  const c0 = Math.floor((w.lon_min - BB.lon_min) / TD), c1 = Math.floor((w.lon_max - BB.lon_min) / TD);
  const r0 = Math.floor((w.lat_min - BB.lat_min) / TD), r1 = Math.floor((w.lat_max - BB.lat_min) / TD);
  let roads = 0, bld = 0, poi = 0, roadsOut = 0, bldOut = 0, poiOut = 0;
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) {
      const t = tiles[`r${String(rr).padStart(2, "0")}c${String(cc).padStart(2, "0")}.json`];
      if (!t) continue;
      const inside = (x, y) => inWin(w, x / Q, y / Q);
      for (const rd of t.roads) { if (inside(rd[2], rd[3])) roads++; }
      for (const b of t.bld) { if (inside(b[0], b[1])) bld++; }
      for (const p of t.poi) { if (inside(p.x, p.y)) poi++; }
      roadsOut += t.roads.length; bldOut += t.bld.length; poiOut += t.poi.length;
    }
  }
  r.canvasTiles = { roads, buildings: bld, poi };
  r.tilesLoadedInWindow = { roads: roadsOut, buildings: bldOut, poi: poiOut };
  r.labels = labels.filter((l) => inWin(w, l.x / Q, l.y / Q)).length;
  r.labelsByRank = labels.filter((l) => inWin(w, l.x / Q, l.y / Q)).reduce((a, l) => { a[l.r] = (a[l.r] || 0) + 1; return a; }, {});

  // 故事內容（zones / locations / events）
  const zones = readJSON(path.join(PUB, "zones.geojson"));
  let zoneIn = 0;
  for (const z of zones.features) {
    const ring = z.geometry.coordinates[0];
    if (ring.some((p) => inWin(w, p[0], p[1]))) zoneIn++;
  }
  r.zonesOverlapping = zoneIn;
  const locs = readJSON(path.join(PUB, "locations.geojson"));
  r.locations = locs.features.filter((f) => inWin(w, f.geometry.coordinates[0], f.geometry.coordinates[1])).length;
  const evs = readJSON(path.join(PUB, "events.geojson"));
  r.events = evs.features.filter((f) => inWin(w, f.geometry.coordinates[0], f.geometry.coordinates[1])).length;
  out.push(r);
  console.log(`\n=== ${w.tag} ===`);
  console.log(`  視窗內：道路 ${roads} 條、建築 ${bld} 幢、tile-POI ${poi} 個、global label ${r.labels} 個`);
  console.log(`  （相關圖磚總量：道路 ${roadsOut}、建築 ${bldOut}、POI ${poiOut}）`);
  console.log(`  故事層：zone 重疊 ${zoneIn}、location ${r.locations}、event ${r.events}`);
}

fs.writeFileSync(path.join(OUT, "viewport-density.json"), JSON.stringify(out, null, 2));
console.log("\n已寫入 artifacts/audit-A4/viewport-density.json");
