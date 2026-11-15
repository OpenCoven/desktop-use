import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('native_fixture', Path(__file__).with_name('fixture.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ControlTimelineTests(unittest.TestCase):
    def test_change_time_and_value_survive_delayed_state_publication(self):
        timeline_type = getattr(fixture, 'ControlTimeline', None)
        self.assertIsNotNone(timeline_type, 'actual control changes need immediate observation before the state-file timer')
        clock_values = iter([10_000_001, 12_000_003])
        timeline = timeline_type(clock=lambda: next(clock_values))
        pending = []
        state = {'controlChanges': timeline.events}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'state.json'
            writer = fixture.StateWriter(pending.append, lambda: path.write_text(json.dumps(state)))
            timeline.changed('text', text_length=1, scroll_offset=0, key_count=1)
            writer.request()
            timeline.changed('text', text_length=2, scroll_offset=0, key_count=2)
            writer.request()
            self.assertFalse(path.exists(), 'control observation must not write a state file in the callback')
            self.assertEqual(len(pending), 1)
            pending.pop()()
            self.assertEqual(json.loads(path.read_text())['controlChanges'], [
                {'kind': 'text', 'monotonicNs': 10_000_001, 'textLength': 1, 'scrollOffset': 0, 'keyCount': 1},
                {'kind': 'text', 'monotonicNs': 12_000_003, 'textLength': 2, 'scrollOffset': 0, 'keyCount': 2},
            ])

    def test_scroll_changes_are_distinct_from_text_and_keep_submillisecond_order(self):
        timeline_type = getattr(fixture, 'ControlTimeline', None)
        self.assertIsNotNone(timeline_type, 'control observations must distinguish editable text from scrolling')
        clock_values = iter([30_000_001, 30_000_002])
        timeline = timeline_type(clock=lambda: next(clock_values))
        timeline.changed('scroll', text_length=3, scroll_offset=1.25, key_count=3)
        timeline.changed('text', text_length=4, scroll_offset=1.25, key_count=4)
        self.assertEqual([event['kind'] for event in timeline.events], ['scroll', 'text'])
        self.assertEqual([event['monotonicNs'] for event in timeline.events], [30_000_001, 30_000_002])
        self.assertEqual(timeline.events[0]['scrollOffset'], 1.25)
        self.assertNotIn('text', timeline.events[1], 'the observer only retains scalar control evidence')


if __name__ == '__main__':
    unittest.main()
