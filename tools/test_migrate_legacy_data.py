"""Exercise the importer through its CLI against real files and damaged copies."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tools/migrate_legacy_data.py'
POINTER = json.loads((ROOT / 'assets/legacy/current.json').read_text(encoding='utf-8'))
SOURCE = ROOT / 'assets/legacy' / POINTER['importId'] / 'raw'
DATASETS = ['catalog.json', 'data/semiconductor_equipment_database.json',
            'data/osat-86-ground-truth.json', 'data/price_estimates.json',
            'data/twin_bom_costs.json', 'twin/layout-default.json', 'schema.json', 'LICENSE']


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.source = self.root / 'source'
        self.output = self.root / 'imported'
        for name in DATASETS:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / name, target)

    def run_import(self, *extra):
        return subprocess.run([sys.executable, str(SCRIPT), '--source', str(self.source),
                               '--output', str(self.output), *extra], capture_output=True, text=True)

    def bundle(self):
        pointer = json.loads((self.output / 'current.json').read_text(encoding='utf-8'))
        return self.output / pointer['importId']

    def damage_catalog(self, change):
        path = self.source / 'catalog.json'
        rows = json.loads(path.read_text(encoding='utf-8'))
        change(rows)
        path.write_text(json.dumps(rows), encoding='utf-8')

    def test_preserves_all_raw_bytes_records_provenance_prices_and_layout_links(self):
        result = self.run_import()
        self.assertEqual(0, result.returncode, result.stderr)
        bundle = self.bundle()
        manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
        snapshot = json.loads((bundle / 'catalog.snapshot.json').read_text(encoding='utf-8'))
        self.assertEqual(253, len(snapshot['entries']))
        self.assertEqual(86, sum(e['domain'] == 'OSAT' for e in snapshot['entries']))
        old = json.loads((self.source / 'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(old, [e['legacy'] for e in snapshot['entries']])
        self.assertEqual(old[0]['record'], snapshot['entries'][0]['record'])
        self.assertEqual(167, sum(e['price'] is not None for e in snapshot['entries']))
        self.assertEqual({'catalog': 253, 'oem': 116, 'osat': 86, 'prices': 167,
                          'bom': 103, 'layout': 121}, manifest['counts'])
        self.assertEqual(0, manifest['rejectedCount'])
        for name in DATASETS:
            self.assertEqual((self.source / name).read_bytes(), (bundle / 'raw' / name).read_bytes())
        ids = {e['recordId'] for e in snapshot['entries']}
        layout = json.loads((bundle / 'raw/twin/layout-default.json').read_text(encoding='utf-8'))
        self.assertTrue(all(t['tool_id'] in ids for t in layout['tools']))

    def test_same_inputs_are_idempotent_and_check_detects_tampering(self):
        first = self.run_import()
        self.assertEqual(0, first.returncode, first.stderr)
        pointer = self.output / 'current.json'
        stamp = pointer.stat().st_mtime_ns
        before = {p.relative_to(self.output): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.output.rglob('*') if p.is_file()}
        again = self.run_import()
        self.assertEqual(0, again.returncode, again.stderr)
        self.assertEqual(stamp, pointer.stat().st_mtime_ns)
        self.assertEqual(before, {p.relative_to(self.output): hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in self.output.rglob('*') if p.is_file()})
        check = self.run_import('--check')
        self.assertEqual(0, check.returncode, check.stderr)
        (self.bundle() / 'raw/catalog.json').write_text('[]', encoding='utf-8')
        check = self.run_import('--check')
        self.assertNotEqual(0, check.returncode)
        self.assertIn('hash', check.stderr.lower())

    def test_rejected_rows_are_reported_and_never_replace_good_snapshot(self):
        self.assertEqual(0, self.run_import().returncode)
        previous = (self.output / 'current.json').read_bytes()
        self.damage_catalog(lambda rows: rows.append(rows[0]))
        result = self.run_import()
        self.assertNotEqual(0, result.returncode)
        report = json.loads(result.stdout)
        self.assertEqual(254, report['inputCount'])
        self.assertEqual(253, report['acceptedCount'])
        self.assertEqual(1, report['rejectedCount'])
        self.assertEqual('DUPLICATE_ID', report['issues'][0]['code'])
        self.assertEqual(previous, (self.output / 'current.json').read_bytes())

    def test_mismatched_identity_is_not_silently_normalized(self):
        self.damage_catalog(lambda rows: rows[0].update(vendor='Different vendor'))
        result = self.run_import()
        self.assertNotEqual(0, result.returncode)
        report = json.loads(result.stdout)
        self.assertTrue(any(i['field'] == 'vendor' for i in report['issues']))
        self.assertFalse((self.output / 'current.json').exists())

    def test_invalid_json_or_missing_source_never_publishes(self):
        (self.source / 'data/price_estimates.json').write_text('{broken', encoding='utf-8')
        result = self.run_import()
        self.assertNotEqual(0, result.returncode)
        self.assertFalse((self.output / 'current.json').exists())
        (self.source / 'catalog.json').unlink()
        self.assertNotEqual(0, self.run_import().returncode)

    def test_malformed_reference_types_produce_field_issues_in_rejected_bundle(self):
        path = self.source / 'data/twin_bom_costs.json'
        rows = json.loads(path.read_text(encoding='utf-8'))
        rows[0]['tool_id'] = {}
        path.write_text(json.dumps(rows), encoding='utf-8')
        result = self.run_import()
        self.assertNotEqual(0, result.returncode)
        self.assertTrue(result.stdout.strip(), 'Bad references must produce a structured report')
        report = json.loads(result.stdout)
        self.assertTrue(any(i['dataset'] == 'bom' and i['index'] == 0 and i['field'] == 'tool_id' for i in report['issues']))
        self.assertTrue((self.output / report['importId'] / 'manifest.json').is_file())
        self.assertFalse((self.output / 'current.json').exists())

    def test_huge_percentage_is_rejected_with_record_index_instead_of_crashing(self):
        self.damage_catalog(lambda rows: rows[0].update(completeness_pct=10**1000))
        result = self.run_import()
        self.assertNotEqual(0, result.returncode)
        self.assertTrue(result.stdout.strip(), 'Out-of-range percentage must produce a structured report')
        report = json.loads(result.stdout)
        self.assertTrue(any(i['index'] == 0 and i['field'] == 'completeness_pct' for i in report['issues']))
        self.assertFalse((self.output / 'current.json').exists())

    def test_refuses_output_inside_original_source(self):
        self.output = self.source / 'new-data'
        result = self.run_import()
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
