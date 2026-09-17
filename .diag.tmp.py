"""診斷：模擬前端 resolveCoord，找出最長路線線段。"""

import json
import math
import re
from pathlib import Path

REPO = Path("C:/Users/User/Desktop/benggong")

src = (REPO / "src/components/SvgMap.ts").read_text(encoding="utf-8")
anch = (REPO / "src/data/fallbackAnchors.ts").read_text(encoding="utf-8")

PAT = re.compile(r'"([^"]+)":\s*\{\s*lon:\s*(-?[\d.]+),\s*lat:\s*(-?[\d.]+)')


def grab(text: str) -> dict[str, tuple[float, float]]:
    return {m.group(1): (float(m.group(2)), float(m.group(3))) for m in PAT.finditer(text)}


FB = grab(src)
FH = grab(anch)
print(f"FALLBACK_ANCHORS={len(FB)}  FULL_HK_ANCHORS={len(FH)}")

feats = json.loads((REPO / "data/public/locations.geojson").read_text(encoding="utf-8"))["features"]
byid = {f["properties"]["id"]: f for f in feats}
routes = json.loads((REPO / "data/public/routes.geojson").read_text(encoding="utf-8"))["features"]


def resolve(name: str, lon: float, lat: float, eb: bool) -> tuple[float, float, str]:
    if eb:
        return lon, lat, "raw"
    if name in FB:
        return FB[name][0], FB[name][1], "fallback"
    if name in FH:
        return FH[name][0], FH[name][1], "full-hk"
    return lon, lat, "raw"


def dist(a, b) -> float:
    return math.hypot((b[0] - a[0]) * 111320 * 0.9247, (b[1] - a[1]) * 110570)


rows = []
for f in routes:
    wps = f["properties"].get("waypoints") or []
    for i in range(len(wps) - 1):
        A = byid.get(wps[i].get("location_id"))
        B = byid.get(wps[i + 1].get("location_id"))
        if not A or not B:
            continue
        pa, pb = A["properties"], B["properties"]
        if pa.get("fictional") or pb.get("fictional"):
            continue
        ca = resolve(pa["name"], *A["geometry"]["coordinates"], bool(pa.get("inferred_from")))
        cb = resolve(pb["name"], *B["geometry"]["coordinates"], bool(pb.get("inferred_from")))
        rows.append((
            dist(ca, cb),
            pa["name"], pa["location_precision"], ca[2], bool(pa.get("inferred_from")),
            pb["name"], pb["location_precision"], cb[2], bool(pb.get("inferred_from")),
        ))

rows.sort(reverse=True, key=lambda r: r[0])
print(f"\n{'距離':>7s}  起點（精度／來源／有證據）          終點")
for r in rows[:10]:
    print(
        f"{r[0]:7.0f}m  {r[1][:14]:14s}[{r[2][:5]:5s}/{r[3]:8s}/{str(r[4]):5s}] → "
        f"{r[5][:14]:14s}[{r[6][:5]:5s}/{r[7]:8s}/{str(r[8]):5s}]"
    )

over = [r for r in rows if r[0] > 6000]
print(f"\n>6 km 段數：{len(over)}")
