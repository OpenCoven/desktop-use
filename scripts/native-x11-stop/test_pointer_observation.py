import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('pointer_driver', Path(__file__).with_name('pointer-driver.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class CompletionObservationTests(unittest.TestCase):
    def test_both_actual_observations_precede_fulfillment(self):
        self.assertTrue(driver.completion_precedes_fulfillment(10, 20, 30))

    def test_eventual_release_after_fulfillment_cannot_qualify(self):
        self.assertFalse(driver.completion_precedes_fulfillment(40, 20, 30))

    def test_eventual_reap_after_fulfillment_cannot_qualify(self):
        self.assertFalse(driver.completion_precedes_fulfillment(10, 40, 30))

    def test_missing_observation_cannot_qualify(self):
        for release, reaped in [(None, 20), (10, None), (None, None)]:
            self.assertFalse(driver.completion_precedes_fulfillment(release, reaped, 30))

    def test_equal_time_is_ambiguous_and_cannot_qualify(self):
        for release, reaped in [(30, 20), (10, 30), (30, 30)]:
            self.assertFalse(driver.completion_precedes_fulfillment(release, reaped, 30))

    def test_non_integer_or_nonpositive_timestamps_cannot_qualify(self):
        for timestamp in [0, -1, True, '10', 10.5]:
            self.assertFalse(driver.completion_precedes_fulfillment(timestamp, 20, 30))
            self.assertFalse(driver.completion_precedes_fulfillment(10, timestamp, 30))
            self.assertFalse(driver.completion_precedes_fulfillment(10, 20, timestamp))


if __name__ == '__main__':
    unittest.main()
