#!/usr/bin/env python3
"""角色合併核心 —— **唯一實作**（`merge_characters.py` 同 `build_public_dataset.py` 共用）。

為何要抽出嚟（C 項全鏈重建）
==========================
「合併」係一個**決定性函數**：`(characters, decisions) → characters'`。
佢有兩個呼叫者：

1. `merge_characters.py` —— 對**已凍結**嘅 `data/public/characters.json`
   做破壞性合併（歷史做法）；
2. `build_public_dataset.py --merge-decisions` —— 喺 provisional 輸出
   **之前**就合併（即「合併決定前移入產生器」）。

⚠️ 兩者一定要用**同一份**實作 —— 否則「產生器出嘅已合併狀態」同
「`merge_characters` 出嘅」會**靜默分歧**，而分歧通常只會喺幾個月後嘅
稽核度浮現（同 D4-1 嘅教訓一樣：兩份來源 = 兩套真相）。

本模組**零 I/O**（唔讀檔、唔寫檔）→ 可以直接單元測試、可以喺任何
輸出目錄重用。
"""

from __future__ import annotations

from typing import Any


def build_merge_map(
    chars: list[dict[str, Any]], decisions: dict[str, Any]
) -> dict[str, str]:
    """回傳 {被合併角色 id: canonical 角色 id}（已做**傳遞閉包**）。

    為何要傳遞閉包
    --------------
    決定可能形成鏈：`主角 ~ 鳥嘴`、`鳥嘴 ~ 敘事者`。如果只摺一層，
    `敘事者` 就會漏咗。所以要一直摺到不動點。

    ⚠️ 決定檔用**名**（唔係 id）指定 —— 因為名係人手可讀嘅審閱單位。
    名對唔上就**跳過**（並出警告），唔會硬套。
    """
    by_name = {c["name"]: c for c in chars}
    direct: dict[str, str] = {}
    for m in decisions.get("merges", []):
        canon = by_name.get(m["into"])
        if canon is None:
            print(f"  ⚠️ 跳過：canonical「{m['into']}」唔存在")
            continue
        for src_name in m["from"]:
            src = by_name.get(src_name)
            if src is None:
                print(f"  ⚠️ 跳過：「{src_name}」唔存在")
                continue
            if src["id"] == canon["id"]:
                continue
            direct[src["id"]] = canon["id"]

    resolved: dict[str, str] = {}
    for sid in direct:
        seen = {sid}
        cur = direct[sid]
        while cur in direct and cur not in seen:
            seen.add(cur)
            cur = direct[cur]
        resolved[sid] = cur
    # 唔可以有任何 id 指向自己
    for sid, dst in list(resolved.items()):
        if sid == dst:
            del resolved[sid]
    return resolved


def build_name_map(
    chars: list[dict[str, Any]], merge_map: dict[str, str]
) -> dict[str, str]:
    """{被合併名: canonical 名} —— 用嚟改**字串**引用（例如 `character_name`）。"""
    by_id = {c["id"]: c for c in chars}
    out: dict[str, str] = {}
    for sid, dst in merge_map.items():
        if sid in by_id and dst in by_id:
            out[by_id[sid]["name"]] = by_id[dst]["name"]
    return out


def merge_records_inplace(
    chars: list[dict[str, Any]], merge_map: dict[str, str]
) -> list[dict[str, Any]]:
    """將被合併角色嘅**名／別名併入 canonical**，再移除被合併嘅記錄。

    ⚠️ 會**原地改** `chars` 入面嘅 canonical 記錄（aliases / chapter_refs）。
    回傳嘅係新 list（唔含被合併嘅 id）。

    兩件事：
      1. aliases 併入 → 保留可追溯性（被合併嘅名唔會消失）；
      2. `chapter_refs` 取**聯集** → canonical 應該覆蓋兩者嘅章節。
    """
    by_id = {c["id"]: c for c in chars}
    for sid, dst in merge_map.items():
        canon = by_id.get(dst)
        src = by_id.get(sid)
        if canon is None or src is None:
            continue
        if canon.get("aliases") is None:
            canon["aliases"] = []
        for nm in (src["name"], *(src.get("aliases") or [])):
            if nm and nm != canon["name"] and nm not in canon["aliases"]:
                canon["aliases"].append(nm)
        canon["chapter_refs"] = sorted(
            set(canon.get("chapter_refs") or []) | set(src.get("chapter_refs") or [])
        )
    return [c for c in chars if c["id"] not in merge_map]


def propagate_references_inplace(
    node: Any, merge_map: dict[str, str], name_map: dict[str, str]
) -> int:
    """更新**所有**引用被合併角色嘅資料（原地）。

    - id 引用（`character_id` / `id` / 字串清單成員）→ 用 `merge_map`；
    - 其他字串引用 → 用 `name_map`。

    回傳改咗幾多處。⚠️ 冇呢步就會出現「指向唔存在角色」嘅斷鏈。
    """
    n = 0

    def walk(x: Any) -> None:
        nonlocal n
        if isinstance(x, dict):
            for k, v in list(x.items()):
                if isinstance(v, str):
                    if k in ("character_id", "id") and v in merge_map:
                        x[k] = merge_map[v]
                        n += 1
                    elif v in name_map:
                        x[k] = name_map[v]
                        n += 1
                elif isinstance(v, list):
                    for i, item in enumerate(v):
                        if isinstance(item, str):
                            if item in merge_map:
                                v[i] = merge_map[item]
                                n += 1
                            elif item in name_map:
                                v[i] = name_map[item]
                                n += 1
                        else:
                            walk(item)
                else:
                    walk(v)
        elif isinstance(x, list):
            for item in x:
                walk(item)

    walk(node)
    return n
