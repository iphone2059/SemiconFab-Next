"""Read-only original-source extraction. Does NOT certify runtime or visual parity."""
import argparse
import csv
import hashlib
import io
import json
import re
import subprocess
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'docs/migration/twin-parity'
ORIGINAL_COMMIT = 'd76378c7ae475f77f7a13bae9c093267c13fc5f3'
FAMILIES = ['litho', 'thermal', 'bench', 'cluster_depo', 'cluster_etch', 'cluster_implant', 'neutral_metro', 'neutral_pkg']
CATEGORY_FAMILY = {
    'lithography': 'litho', 'resist_track': 'litho', 'thermal_processing': 'thermal',
    'cmp': 'bench', 'wet_clean': 'bench', 'thin_film_deposition': 'cluster_depo',
    'dry_etch': 'cluster_etch', 'ion_implantation': 'cluster_implant',
    'packaging': 'neutral_pkg', 'test': 'neutral_pkg',
}


class Elements(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = {}

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if 'id' in values:
            self.ids[(self.getpos()[0], values['id'])] = (tag, values)


def inventory_controls(source):
    elements = Elements()
    elements.feed(source)
    occurrences = Counter()
    rows = []
    # Attribute occurrences include template literals; DOM property assignments are separate.
    patterns = [
        ('attribute', r'(?<![\w:.-])id\s*=\s*["\x27]([^"\x27]+)["\x27]'),
        ('dom-property', r'\.id\s*=\s*["\x27]([^"\x27]+)["\x27]'),
    ]
    matches = sorted((m.start(), kind, m) for kind, pattern in patterns for m in re.finditer(pattern, source))
    for _, kind, match in matches:
        ident = match[1]
        line = source.count('\n', 0, match.start()) + 1
        # Opening tags can span several lines; locate the actual opening tag line.
        start = source.rfind('<', 0, match.start())
        opening_line = source.count('\n', 0, start) + 1
        element = elements.ids.get((opening_line, ident)) if kind == 'attribute' else None
        if element:
            tag, attrs = element
            source_kind = 'static-markup'
        else:
            tag = ''
            attrs = {}
            source_kind = 'script-template' if kind == 'attribute' else kind
        occurrences[ident] += 1
        rows.append({
            'key': f'{ident}#{occurrences[ident]}', 'original_id': ident,
            'occurrence': occurrences[ident], 'line': line, 'source_kind': source_kind,
            'tag': tag, 'type': attrs.get('type', ''),
            'inline_events': ' | '.join(f'{k}={v}' for k, v in attrs.items() if k.startswith('on')),
            'title': attrs.get('title', ''), 'i18n': attrs.get('data-i18n', ''),
            'class': attrs.get('class', ''), 'disabled_attribute': 'disabled' in attrs,
            'runtime_box_status': 'PENDING', 'runtime_events_status': 'PENDING',
            'next_locator': '', 'parity_status': 'BASELINED',
        })
    return rows


def inventory_functions(source):
    rows = []
    categories = [('Research', r'research|scrub|utilization'), ('Wafer', r'wafer|foup|route'),
                  ('Industry', r'mes|spc|yield|stdf|simulation|scenario|telemetry|statecounter|signalLight'),
                  ('Camera', r'camera|tour|focus|onboard'),
                  ('Scene', r'build|create|three|render|light|geometry|spatial|xray|cut|laminar|airflow|subfab|roof|level'),
                  ('UI', r'ui|modal|sidebar|inspector|select|toggle|lang|theme|toast|button|entrymode')]
    for match in re.finditer(r'\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', source):
        name = match[1]
        category = next((cat for cat, pattern in categories if re.search(pattern, name, re.I)), 'Utility')
        rows.append({'name': name, 'line': source.count('\n', 0, match.start()) + 1,
                     'category': category, 'next_path': '', 'parity_status': 'BASELINED'})
    return rows


def constant_object(source, name):
    # These original data-only blocks use JSON values and unquoted JS property names.
    match = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*(\{.*?\n      \});', source, re.S)
    if not match:
        raise ValueError(f'Missing original data block: {name}')
    text = re.sub(r'(?m)(^\s*)([A-Za-z_$][\w$]*)(\s*:)', r'\1"\2"\3', match[1])
    text = re.sub(r',\s*([}\]])', r'\1', text)
    return json.loads(text)


def layout_identities(layout, catalog, bays):
    catalog_map = {item.get('record_id', item.get('id')): item for item in catalog}
    counts = Counter()
    rows = []
    render_order = []
    drafts = defaultdict(list)
    for index, tool in enumerate(layout['tools']):
        item = catalog_map[tool['tool_id']]
        category = item.get('category', 'other')
        bay = tool.get('bay') or category
        counts[bay] += 1
        machine = f"{bays.get(bay, bays.get('other'))['mimacTg']}_{counts[bay]:02d}"
        solid = item.get('conformance_level') == 'L1' and bool(item.get('record', {}).get('physical', {}).get('width_mm', {}).get('value'))
        rows.append({'layout_index': index, 'instance_id': f'FAB-01/tool-{index + 1:03d}',
                     'record_id': tool['tool_id'], 'bay': bay, 'category': category,
                     'machine_id': machine, 'original_kind': 'catalog' if solid else 'draft'})
        if solid:
            render_order.append(index)
        else:
            drafts[CATEGORY_FAMILY.get(category, 'neutral_metro')].append(index)
    for family in FAMILIES:
        render_order.extend(drafts[family])
    targets = {}
    for index in render_order:
        targets[rows[index]['machine_id']] = index
    aliases = defaultdict(list)
    for row in rows:
        aliases[row['machine_id']].append(row['layout_index'])
    for row in rows:
        row['original_replay_target'] = targets[row['machine_id']] == row['layout_index']
        row['alias_collision_indices'] = aliases[row['machine_id']] if len(aliases[row['machine_id']]) > 1 else []
    return rows


def csv_text(rows):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-root', type=Path, default=ROOT.parent / 'SemiconFab')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    original = args.original_root.resolve()
    commit = subprocess.check_output(['git', '-C', str(original), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != ORIGINAL_COMMIT:
        raise SystemExit(f'Original commit changed: {commit}; baseline changes require explicit review.')
    paths = ['twin.html', 'catalog.json', 'twin/layout-default.json', 'twin/events-t1-fifo.jsonl', 'benchmark/routes.json', 'js/i18n.js', 'js/translations.js', 'LICENSE']
    hashes = {name: hashlib.sha256((original / name).read_bytes()).hexdigest() for name in paths}
    # Reject a dirty baseline even if the working tree commit still matches.
    for name in paths:
        committed = subprocess.check_output(['git', '-C', str(original), 'show', f'{commit}:{name}'])
        # Git's Windows worktree may use CRLF. The worktree SHA is also retained above.
        if committed.replace(b'\r\n', b'\n') != (original / name).read_bytes().replace(b'\r\n', b'\n'):
            raise SystemExit(f'Original source modified: {name}')
    source = (original / 'twin.html').read_text(encoding='utf-8')
    controls = inventory_controls(source)
    functions = inventory_functions(source)
    layout = json.loads((original / 'twin/layout-default.json').read_text(encoding='utf-8'))
    catalog = json.loads((original / 'catalog.json').read_text(encoding='utf-8'))
    identities = layout_identities(layout, catalog, constant_object(source, 'CATEGORY_BAYS'))
    events = [json.loads(line) for line in (original / 'twin/events-t1-fifo.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
    machine_ids = sorted({e['payload']['machine_id'] for e in events if e['event_type'] == 'tool_state_change'})
    winners = {row['machine_id']: row['instance_id'] for row in identities if row['original_replay_target']}
    replay_map = [{'machine_id': mid, 'instance_id': winners.get(mid, ''),
                   'status': 'MAPPED_ORIGINAL_ALIAS' if mid in winners else 'NO_LAYOUT_ALIAS'} for mid in machine_ids]
    manifest = {'original_repo': 'jinjiefan2020/SemiconFab', 'original_commit': commit,
                'next_commit_before': '060957d', 'source_sha256': hashes,
                'raw_id_attributes': sum(r['source_kind'] != 'dom-property' for r in controls),
                'unique_attribute_ids': len({r['original_id'] for r in controls if r['source_kind'] != 'dom-property'}),
                'dom_property_ids': sum(r['source_kind'] == 'dom-property' for r in controls),
                'named_functions': len(functions), 'layout_instances': len(identities),
                'replay_rows': len(events), 'replay_machines': len(machine_ids),
                'replay_mapped_machines': sum(mid in winners for mid in machine_ids),
                'layout_alias_collisions': sum(bool(r['alias_collision_indices']) for r in identities),
                'runtime_inventory': 'PENDING', 'golden_capture': 'PENDING', 'status': 'BASELINED'}
    outputs = {'controls.csv': csv_text(controls), 'functions.csv': csv_text(functions), 'replay-map.csv': csv_text(replay_map),
               'source-manifest.json': json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
               'layout-identities.json': json.dumps(identities, ensure_ascii=False, indent=2) + '\n',
               'original-scenarios.json': json.dumps(constant_object(source, 'DT_SCENARIOS'), ensure_ascii=False, indent=2) + '\n'}
    failed = []
    for name, content in outputs.items():
        path = DEST / name
        if args.check:
            if not path.exists() or path.read_text(encoding='utf-8') != content:
                failed.append(name)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8', newline='')
    if failed:
        raise SystemExit('Inventory drift: ' + ', '.join(failed))
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
