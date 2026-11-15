import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location('pointer_driver', Path(__file__).with_name('pointer-driver.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class PointerClockTests(unittest.TestCase):
    def test_actual_node_hrtime_is_bracketed_by_linux_monotonic(self):
        self.assertEqual(sys.platform, 'linux', 'run inside the owned Linux namespace')
        proof = driver.shared_monotonic_clock_probe()
        self.assertEqual(proof.get('clockDomain'), 'linux-CLOCK_MONOTONIC')
        self.assertLessEqual(int(proof['beforeNs']), int(proof['nodeNs']))
        self.assertLessEqual(int(proof['nodeNs']), int(proof['afterNs']))
        self.assertTrue(proof['nodeVersion'].startswith('v24.'))


if __name__ == '__main__':
    unittest.main()
