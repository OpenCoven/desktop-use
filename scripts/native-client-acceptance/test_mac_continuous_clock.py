"""Clock conversion only, using an injected Mach API and no operating-system calls."""
import unittest

try:
    from mac_owned_processes import DarwinContinuousClock
except ImportError:
    DarwinContinuousClock = None


class FakeMach:
    def __init__(self, numer=125, denom=3, status=0):
        self.numer, self.denom, self.status = numer, denom, status
        self.ticks = 9_007_199_254_741_003
        self.timebase_calls = 0

    def mach_timebase_info(self, pointer):
        self.timebase_calls += 1
        pointer._obj.numer, pointer._obj.denom = self.numer, self.denom
        return self.status

    def mach_continuous_time(self):
        return self.ticks


class ClockTests(unittest.TestCase):
    def clock(self, api=None):
        self.assertTrue(callable(DarwinContinuousClock), 'Darwin continuous clock must be implemented')
        api = api or FakeMach()
        return api, DarwinContinuousClock(api=api)

    def test_large_nanoseconds_are_exact_and_timebase_is_cached(self):
        api, clock = self.clock()
        self.assertEqual(clock.now_ns(), api.ticks * 125 // 3)
        api.ticks += 1
        self.assertEqual(clock.now_ns(), api.ticks * 125 // 3)
        self.assertEqual(api.timebase_calls, 1)
        self.assertIsInstance(clock.now_ns(), int)

    def test_uint64_multiply_wrap_matches_audited_libuv_and_swift(self):
        api, clock = self.clock()
        api.ticks = (1 << 64) - 2
        self.assertEqual(clock.now_ns(), ((api.ticks * 125) & ((1 << 64) - 1)) // 3)

    def test_unavailable_or_invalid_timebase_is_not_a_qualified_clock(self):
        self.assertTrue(callable(DarwinContinuousClock), 'Darwin continuous clock must be implemented')
        for api in [FakeMach(status=1), FakeMach(numer=0), FakeMach(denom=0)]:
            with self.assertRaises(ValueError):
                DarwinContinuousClock(api=api)


if __name__ == '__main__':
    unittest.main()
