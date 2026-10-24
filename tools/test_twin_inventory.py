"""The source ledger must not silently drop duplicate or generated controls."""
import unittest
from build_twin_inventory import inventory_controls, inventory_functions, layout_identities


class TwinInventoryTests(unittest.TestCase):
    def test_keeps_occurrences_templates_and_dom_created_ids_separate(self):
        text = '<button id="same" onclick="go()">Go</button>\n<div id="same"></div>\n<script>const s = `<b id="generated">X</b>`; el.id = "created";</script>'
        rows = inventory_controls(text)
        self.assertEqual([row['original_id'] for row in rows], ['same', 'same', 'generated', 'created'])
        self.assertEqual([row['occurrence'] for row in rows], [1, 2, 1, 1])
        self.assertEqual(rows[0]['inline_events'], 'onclick=go()')
        self.assertEqual(rows[2]['source_kind'], 'script-template')
        self.assertEqual(rows[3]['source_kind'], 'dom-property')
        self.assertEqual(rows[0]['runtime_box_status'], 'PENDING')

    def test_names_async_functions_and_excludes_anonymous_functions(self):
        rows = inventory_functions('function setCamera() {}\nasync function initResearch() {}\nconst cb = function() {};')
        self.assertEqual([(r['name'], r['category']) for r in rows], [('setCamera', 'Camera'), ('initResearch', 'Research')])

    def test_aliases_preserve_original_family_insertion_winner_and_unique_instances(self):
        bays = {'lithography': {'mimacTg': 'TG01'}, 'packaging': {'mimacTg': 'TG01'}}
        layout = {'tools': [
            {'tool_id': 'repeat', 'bay': 'lithography', 'category': 'lithography'},
            {'tool_id': 'repeat', 'bay': 'lithography', 'category': 'lithography'},
            {'tool_id': 'pkg', 'bay': 'packaging', 'category': 'packaging'},
        ]}
        catalog = [{'record_id': 'repeat', 'category': 'lithography'}, {'record_id': 'pkg', 'category': 'packaging'}]
        rows = layout_identities(layout, catalog, bays)
        self.assertEqual(len({row['instance_id'] for row in rows}), 3)
        self.assertEqual([row['machine_id'] for row in rows], ['TG01_01', 'TG01_02', 'TG01_01'])
        self.assertEqual([row['original_replay_target'] for row in rows], [False, True, True])
        self.assertEqual(rows[0]['alias_collision_indices'], [0, 2])


if __name__ == '__main__':
    unittest.main()
