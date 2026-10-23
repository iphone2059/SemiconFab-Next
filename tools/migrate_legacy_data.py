"""Import legacy catalog assets into immutable, hash-checked snapshots (stdlib only).

Validation here covers import structure and references. Legacy L1/draft labels
are preserved claims, not a new full Schema/conformance certification.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import uuid

VERSION = 'semiconfab-legacy-import-v1'
DATASETS = {'catalog': 'catalog.json', 'oem': 'data/semiconductor_equipment_database.json',
            'osat': 'data/osat-86-ground-truth.json', 'prices': 'data/price_estimates.json',
            'bom': 'data/twin_bom_costs.json', 'layout': 'twin/layout-default.json',
            'schema': 'schema.json', 'license': 'LICENSE'}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict_json(raw):
    def invalid(value):
        raise ValueError('Non-finite JSON number: ' + value)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON property: ' + key)
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8-sig'), parse_constant=invalid, object_pairs_hook=unique)


def verify(output):
    pointer = strict_json((output / 'current.json').read_bytes())
    import_id = pointer['importId']
    if not isinstance(import_id, str) or len(import_id) != 64 or any(c not in '0123456789abcdef' for c in import_id):
        raise ValueError('Invalid snapshot importId')
    bundle = output / import_id
    manifest_raw = (bundle / 'manifest.json').read_bytes()
    if digest(manifest_raw) != pointer['manifestSha256']:
        raise ValueError('Manifest hash mismatch')
    manifest = strict_json(manifest_raw)
    if manifest['importId'] != import_id or manifest['issues']:
        raise ValueError('Snapshot is not publishable')
    for item in manifest['files']:
        if item['path'] not in DATASETS.values():
            raise ValueError('Unknown asset path')
        raw = (bundle / 'raw' / item['path']).read_bytes()
        if digest(raw) != item['sha256'] or len(raw) != item['bytes']:
            raise ValueError('Asset hash mismatch: ' + item['path'])
    if len(manifest['files']) != len(DATASETS) or {f['path'] for f in manifest['files']} != set(DATASETS.values()):
        raise ValueError('Incomplete asset manifest')
    if digest((bundle / 'catalog.snapshot.json').read_bytes()) != manifest['snapshotSha256']:
        raise ValueError('Catalog snapshot hash mismatch')
    return manifest


def migrate(source, output):
    source, output = source.resolve(), output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError('Source and output directories must not overlap')
    blobs = {name: (source / path).read_bytes() for name, path in DATASETS.items()}
    data = {name: strict_json(raw) for name, raw in blobs.items() if name != 'license'}
    for name in ('catalog', 'oem', 'osat', 'bom'):
        if not isinstance(data[name], list):
            raise ValueError(name + ' must be an array')
    for name in ('prices', 'layout', 'schema'):
        if not isinstance(data[name], dict):
            raise ValueError(name + ' must be an object')
    if not isinstance(data['layout'].get('tools'), list):
        raise ValueError('layout.tools must be an array')
    identity = hashlib.sha256(VERSION.encode())
    for name, path in DATASETS.items():
        identity.update(path.encode() + b'\0' + blobs[name] + b'\0')
    import_id = identity.hexdigest()
    entries, issues, seen = [], [], set()

    def issue(dataset, index, field, code, detail):
        issues.append(dict(dataset=dataset, index=index, field=field, code=code, detail=detail))

    for index, row in enumerate(data['catalog']):
        start = len(issues)
        if not isinstance(row, dict):
            issue('catalog', index, '', 'INVALID_RECORD', 'Expected object')
            continue
        record_id = row.get('record_id')
        try:
            if str(uuid.UUID(record_id)) != record_id:
                raise ValueError()
        except (ValueError, AttributeError, TypeError):
            issue('catalog', index, 'record_id', 'INVALID_ID', 'Canonical UUID required')
        if isinstance(record_id, str) and record_id in seen:
            issue('catalog', index, 'record_id', 'DUPLICATE_ID', 'Duplicate catalog record_id')
        if isinstance(record_id, str):
            seen.add(record_id)
        record = row.get('record')
        if not isinstance(record, dict) or record.get('record_id') != record_id:
            issue('catalog', index, 'record', 'INVALID_RECORD', 'Inner record and ID required')
            continue
        for field in ('vendor', 'model', 'category'):
            value = row.get(field)
            inner = record.get('identity', {}).get(field, {}) if isinstance(record.get('identity'), dict) else {}
            if not isinstance(value, str) or not value.strip() or not isinstance(inner, dict) or inner.get('value') != value:
                issue('catalog', index, field, 'IDENTITY_MISMATCH', 'Wrapper and inner identity must agree')
        percentage = row.get('completeness_pct')
        if type(percentage) not in (int, float) or not 0 <= percentage <= 100 or not math.isfinite(percentage):
            issue('catalog', index, 'completeness_pct', 'INVALID_PERCENT', 'Expected percentage in [0,100]')
        if row.get('conformance_level') not in ('draft', 'L1', 'L2', 'L3') or not isinstance(row.get('missing_fields'), list) or any(not isinstance(v, str) for v in row.get('missing_fields', [])):
            issue('catalog', index, 'conformance_level', 'INVALID_METADATA', 'Expected legacy level and missing-fields array')
        if len(issues) == start:
            entries.append(dict(recordId=record_id, vendor=row['vendor'], model=row['model'], category=row['category'],
                                domain='OSAT' if row['category'].startswith('osat_') else 'FAB',
                                conformanceLevel=row['conformance_level'], completenessPct=percentage,
                                missingFields=row['missing_fields'], record=record, legacy=row,
                                price=data['prices'].get(record_id)))
    accepted_ids = {e['recordId'] for e in entries}
    for key, price in data['prices'].items():
        if key not in seen:
            issue('prices', key, 'record_id', 'UNKNOWN_REFERENCE', 'Price has no catalog record')
        if not isinstance(price, dict):
            issue('prices', key, '', 'INVALID_PRICE', 'Expected object')
            continue
        low, high = price.get('low_usd'), price.get('high_usd')
        if low is not None and (type(low) not in (int, float) or not 0 <= low <= 9007199254740991 or not math.isfinite(low)) or high is not None and (type(high) not in (int, float) or not 0 <= high <= 9007199254740991 or not math.isfinite(high)) or low is not None and high is not None and low > high:
            issue('prices', key, 'low_usd/high_usd', 'INVALID_PRICE', 'Invalid price interval')
    for name, rows in [('layout', data['layout']['tools']), ('bom', data['bom'])]:
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or not isinstance(row.get('tool_id'), str) or row['tool_id'] not in accepted_ids:
                issue(name, index, 'tool_id', 'UNKNOWN_REFERENCE', 'No accepted catalog record')
    snapshot = dict(contractVersion=1, importId=import_id, source='SemiconFab-main', entries=entries)
    snapshot_raw = encoded(snapshot)
    manifest = dict(transformVersion=VERSION, importId=import_id, inputCount=len(data['catalog']),
                    acceptedCount=len(entries), rejectedCount=len(data['catalog']) - len(entries),
                    counts={name: len(data[name]['tools']) if name == 'layout' else len(data[name])
                            for name in ('catalog', 'oem', 'osat', 'prices', 'bom', 'layout')},
                    issues=issues, snapshotSha256=digest(snapshot_raw),
                    files=[dict(path=path, bytes=len(blobs[name]), sha256=digest(blobs[name]))
                           for name, path in DATASETS.items()])
    manifest_raw = encoded(manifest)
    output.mkdir(parents=True, exist_ok=True)
    bundle = output / import_id
    contents = {'catalog.snapshot.json': snapshot_raw, 'manifest.json': manifest_raw,
                **{'raw/' + path: blobs[name] for name, path in DATASETS.items()}}
    if bundle.exists():
        for name, raw in contents.items():
            if not (bundle / name).is_file() or (bundle / name).read_bytes() != raw:
                raise ValueError('Existing immutable bundle hash/content mismatch: ' + name)
    else:
        # Keep incomplete writes out of the published namespace.
        with tempfile.TemporaryDirectory(prefix='.import-', dir=output) as staging:
            stage = Path(staging) / 'bundle'
            for name, raw in contents.items():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
            stage.rename(bundle)
    if not issues:
        pointer_raw = encoded(dict(importId=import_id, manifestSha256=digest(manifest_raw)))
        current = output / 'current.json'
        if not current.exists() or current.read_bytes() != pointer_raw:
            fd, temporary = tempfile.mkstemp(prefix='.current-', dir=output)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(pointer_raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, current)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'assets/legacy')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        if args.check:
            manifest = verify(args.output.resolve())
        else:
            if args.source is None:
                parser.error('--source is required unless --check is used')
            manifest = migrate(args.source, args.output)
        print(json.dumps(manifest, ensure_ascii=True))
        return 2 if manifest['issues'] else 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
