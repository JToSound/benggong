import json
import sys
from collections import defaultdict
sys.path.insert(0, 'scripts')
from build_public_dataset import apply_manual_resolutions, load_manual_resolutions, apply_parenthetical_merge

cands = []
for line in open('data/private/evidence/candidates.jsonl', encoding='utf-8'):
    if not line.strip(): continue
    cands.append(json.loads(line))
chars = [c for c in cands if c.get('entity_kind') == 'character' and c.get('status') == 'pending']
chars = apply_parenthetical_merge(chars)
manual = load_manual_resolutions()
chars, _ = apply_manual_resolutions(chars, manual['decisions'])

# alias_map
alias_map = defaultdict(set)
for i, c in enumerate(chars):
    names = {c.get('name'), *(c.get('aliases') or [])}
    for n in names:
        if n:
            alias_map[n].add(i)

# 揾 '敘事者' 個 row 嘅 alias 連接到邊
xs = [(i, c) for i, c in enumerate(chars) if c.get('name') == '敘事者']
print(f'敘事者 rows: {len(xs)}')

# 揾第一個 敘事者 row 嘅 alias 連接
for i, c in xs[:3]:
    print(f'\nRow {i} (ch={c.get("chapter")}):')
    names = {c.get('name'), *(c.get('aliases') or [])}
    for n in names:
        if n == '敘事者':
            continue
        if not n:
            continue
        matches = alias_map.get(n, set())
        other_rows = matches - {i}
        if other_rows:
            for o in list(other_rows)[:3]:
                oname = chars[o].get('name', '?')
                och = chars[o].get('chapter', '?')
                print(f'    "{n}" -> row {o}: name={oname}, ch={och}')
