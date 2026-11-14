import unittest
from x11_state import clock_delta


class ClockTests(unittest.TestCase):
    def test_event_before_return(self):
        self.assertEqual(clock_delta(100, 105), -5)

    def test_event_after_return_across_server_wrap(self):
        self.assertEqual(clock_delta(3, 2 ** 32 - 2), 5)

    def test_old_event_before_a_wrapped_return(self):
        self.assertEqual(clock_delta(2 ** 32 - 2, 2 ** 32 + 3), -5)

    def test_long_host_uptime_preserves_event_age(self):
        self.assertEqual(clock_delta(37, 4 * 2 ** 32 + 42), -5)


if __name__ == '__main__':
    unittest.main()
