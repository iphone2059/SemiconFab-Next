import unittest
from serve_twin_reference import inject_clock


class ReferenceCaptureTests(unittest.TestCase):
    def test_declares_injected_inputs_before_original_code_and_preserves_source_bytes(self):
        original = b'<html><head><script>original()</script></head></html>'
        captured = inject_clock(original, b'seedAndClock()')
        self.assertLess(captured.index(b'seedAndClock()'), captured.index(b'original()'))
        self.assertIn(b'data-parity-input="seed-and-clock"', captured)
        self.assertEqual(original, b'<html><head><script>original()</script></head></html>')

    def test_rejects_ambiguous_or_unbounded_injection(self):
        with self.assertRaises(ValueError):
            inject_clock(b'<body></body>', b'')
        with self.assertRaises(ValueError):
            inject_clock(b'<head></head>', b'</script><script>bad()</script>')


if __name__ == '__main__':
    unittest.main()
