import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_fixture', Path(__file__).with_name('fixture.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class StateWriteCoalescerTests(unittest.TestCase):
    def writer(self, schedule, write):
        return fixture.StateWriter(schedule, write)

    def test_event_burst_writes_one_complete_ordered_receipt(self):
        pending = []
        state = {'keys': []}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'state.json'
            writes = []

            def write():
                path.write_text(json.dumps(state))
                writes.append(len(state['keys']))

            writer = self.writer(pending.append, write)
            for index in range(1_000):
                state['keys'].append({'serverTimeMs': 10_000+index, 'receivedMonotonicMs': 20_000+index})
                writer.request()
            self.assertEqual(writes, [], 'input callbacks must not repeatedly serialize growing history')
            self.assertEqual(len(pending), 1)
            self.assertFalse(pending.pop(0)())
            self.assertEqual(writes, [1_000])
            saved = json.loads(path.read_text())['keys']
            self.assertEqual([event['serverTimeMs'] for event in saved], list(range(10_000, 11_000)))
            self.assertEqual([event['receivedMonotonicMs'] for event in saved], list(range(20_000, 21_000)))

    def test_new_events_after_flush_schedule_another_receipt(self):
        pending, writes = [], []
        writer = self.writer(pending.append, lambda: writes.append('saved'))
        writer.request()
        self.assertEqual(len(pending), 1)
        pending.pop(0)()
        writer.request()
        self.assertEqual(len(pending), 1)
        pending.pop(0)()
        self.assertEqual(writes, ['saved', 'saved'])

    def test_request_during_flush_is_not_lost(self):
        pending, writes = [], []

        def write():
            writes.append('saved')
            if len(writes) == 1:
                writer.request()

        writer = self.writer(pending.append, write)
        writer.request()
        self.assertEqual(len(pending), 1)
        pending.pop(0)()
        self.assertEqual(len(pending), 1)
        pending.pop(0)()
        self.assertEqual(writes, ['saved', 'saved'])

    def test_shutdown_flushes_pending_receipt_once(self):
        pending, writes = [], []
        writer = self.writer(pending.append, lambda: writes.append('saved'))
        writer.request()
        writer.flush_pending()
        writer.flush_pending()
        self.assertEqual(writes, ['saved'])
        self.assertFalse(pending.pop(0)())
        self.assertEqual(writes, ['saved'])

    def test_publication_timer_has_input_priority_and_a_bounded_delay(self):
        class GLib:
            PRIORITY_DEFAULT = 0
            calls = []
            @classmethod
            def timeout_add(cls, milliseconds, callback, **kwargs):
                cls.calls.append((milliseconds, callback, kwargs))
        callback = lambda: False
        fixture.schedule_state_write(GLib, callback)
        self.assertEqual(GLib.calls, [(16, callback, {'priority': GLib.PRIORITY_DEFAULT})])


if __name__ == '__main__':
    unittest.main()
