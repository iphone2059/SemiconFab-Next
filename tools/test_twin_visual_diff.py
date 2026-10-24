import importlib.util
import unittest
from compare_twin_goldens import image_metrics


@unittest.skipUnless(importlib.util.find_spec('numpy'), 'Optional visual tooling: tools/visual-requirements.txt')
class GoldenDifferenceTests(unittest.TestCase):
    def test_identity_and_visible_difference(self):
        import numpy as np
        original = np.full((24, 24, 3), 128, dtype='uint8')
        self.assertAlmostEqual(image_metrics(original, original)['ssim'], 1)
        changed = original.copy(); changed[5:18, 5:18] = 0
        result = image_metrics(original, changed)
        self.assertLess(result['ssim'], 0.5)
        self.assertGreater(result['changed_fraction_gt8'], 0.2)

    def test_rejects_resizing_instead_of_silently_aligning(self):
        import numpy as np
        with self.assertRaises(ValueError):
            image_metrics(np.zeros((24, 24, 3)), np.zeros((25, 24, 3)))
