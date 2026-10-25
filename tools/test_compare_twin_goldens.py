import json
from pathlib import Path
import tempfile
import unittest

try:
    import numpy as np
    from PIL import Image
except ImportError:
    np = Image = None
from compare_twin_goldens import compare_pair


class GoldenRoiTests(unittest.TestCase):
    @unittest.skipIf(np is None, 'optional tools/visual-requirements.txt is not installed')
    def test_dpr_two_excludes_the_whole_css_sidebar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference = np.full((400, 800, 3), 180, dtype=np.uint8)
            actual = reference.copy()
            actual[:, :656] = 0  # 328 CSS pixels at DPR 2, outside the scene.
            for side, pixels in [('original', reference), ('next', actual)]:
                Image.fromarray(pixels).save(root / f'{side}-sample.png')
                (root / f'{side}-sample.json').write_text(json.dumps({
                    'viewport': {'width': 400, 'height': 200, 'devicePixelRatio': 2},
                }), encoding='utf-8')
            result = compare_pair(root, 'sample')
            self.assertEqual(result['scene_roi']['rect'], [656, 164, 800, 304])
            self.assertEqual(result['scene_roi']['mae_rgb'], 0)
            self.assertGreater(result['full_frame']['mae_rgb'], 0)


if __name__ == '__main__':
    unittest.main()
