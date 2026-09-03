import json
import sys
from collections import defaultdict, Counter
from pathlib import Path
sys.path.insert(0, 'scripts')
from build_public_dataset import apply_manual_resolutions, load_manual_resolutions, apply_parenthetical_merge

cands = []
for line in open('data/private/evidence/candidates.jsonl', encoding='utf-8'):
    if not line.strip(): continue
    cands.append(json.loads(line))
chars = [c for c in cands if c.get('entity_kind') == 'character' and c.get('status') == 'pending']
chars = apply_parenthetical_merge(chars)
manual = load_manual_resolutions()
partial = []
for d in manual['decisions']:
    if d.get('action') != 'character_definitions':
        partial.append(d)
chars, _ = apply_manual_resolutions(chars, partial)

all_names = set()
char_alias_freq = defaultdict(Counter)
for c in chars:
    n = (c.get('name') or '').strip()
    if not n: continue
    all_names.add(n)
    for a in set([n] + (c.get('aliases') or [])):
        if a: char_alias_freq[n][a] += 1

KEEP_MIN_FREQ = 2
alias_to_chars = defaultdict(set)
for char, freq in char_alias_freq.items():
    for alias in freq:
        if alias != char:
            alias_to_chars[alias].add(char)

keep_map = {}
remove_map = defaultdict(list)
for char in all_names:
    freq = char_alias_freq[char]
    keep = set()
    for alias, cnt in freq.items():
        if alias == char: continue
        if len(alias_to_chars[alias]) >= 2:
            remove_map[char].append(alias)
            continue
        if cnt < KEEP_MIN_FREQ:
            remove_map[char].append(alias)
            continue
        keep.add(alias)
    keep_map[char] = sorted(keep)

mr_path = Path('data/private/review/manual-resolutions.json')
mr = json.load(open(mr_path, encoding='utf-8'))
mr['decisions'] = [d for d in mr['decisions'] if d.get('action') != 'character_definitions']
mr['decisions'].append({
    'action': 'character_definitions',
    'rationale': f'Phase E v10+: evidence-based after merge_routes. cross-char alias (>=2) + low-freq <{KEEP_MIN_FREQ} removed',
    'approved_by': 'Hermes Agent (Phase E v10+)',
    'remove_map': dict(remove_map),
    'keep_aliases_map': keep_map,
})
mr_path.write_text(json.dumps(mr, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'OK: {sum(len(v) for v in remove_map.values())} removals')
print(f'  主角 keep: {keep_map.get("主角", [])}')
print(f'  敘事者 keep: {keep_map.get("敘事者", [])}')
print(f'  鳥嘴 keep: {keep_map.get("鳥嘴", [])}')
print(f'  W keep: {keep_map.get("W", [])}')
print(f'  老賢 keep: {keep_map.get("老賢", [])}')
print(f'  奎斯 keep: {keep_map.get("奎斯", [])}')
