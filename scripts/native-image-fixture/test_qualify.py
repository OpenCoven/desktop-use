"""Side-effect-free cleanup tests: no display, signals, or processes are created."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
import qualify


class CleanupTests(unittest.TestCase):
    def test_spawn_failure_resumes_server_and_persists_receipt(self):
        with tempfile.TemporaryDirectory() as root, patch.object(qualify.os, 'kill') as kill:
            receipt = Path(root)/'receipt.json'
            fixture = Mock()
            fixture.poll.return_value = None
            state = {}
            with self.assertRaises(OSError):
                with qualify.fixture_guard(lambda: fixture, state, receipt):
                    with qualify.cancellation_guard(42, Mock(side_effect=OSError('injected adapter spawn failure')), state):
                        self.fail('must not enter body')
            self.assertEqual(kill.call_args_list, [unittest.mock.call(42, qualify.signal.SIGSTOP), unittest.mock.call(42, qualify.signal.SIGCONT)])
            self.assertTrue(json.loads(receipt.read_text())['fixtureTerminated'])
            self.assertIn('spawn failure', state['failure'])

    def test_adapter_cleanup_failure_cannot_skip_resume(self):
        with tempfile.TemporaryDirectory() as root, patch.object(qualify.os, 'kill') as kill:
            fixture, adapter = Mock(), Mock()
            fixture.poll.return_value = None
            original = qualify.reap_bounded
            def cleanup(proc):
                if proc is adapter:
                    raise RuntimeError('injected cleanup failure')
                return original(proc)
            path = Path(root)/'receipt.json'
            with self.assertRaises(RuntimeError), patch.object(qualify, 'reap_bounded', side_effect=cleanup):
                with qualify.fixture_guard(lambda: fixture, {}, path):
                    with qualify.cancellation_guard(42, lambda: adapter, {}):
                        pass
            self.assertEqual(kill.call_args_list[-1], unittest.mock.call(42, qualify.signal.SIGCONT))
            self.assertTrue(json.loads(path.read_text())['fixtureTerminated'])

    def test_suspend_failure_still_attempts_resume(self):
        with patch.object(qualify.os, 'kill', side_effect=[OSError('stop failed'), None]) as kill:
            with self.assertRaises(OSError):
                with qualify.suspended_server(42):
                    self.fail('must not enter body')
            self.assertEqual(kill.call_args_list[-1], unittest.mock.call(42, qualify.signal.SIGCONT))

    def test_fixture_spawn_failure_still_persists_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'receipt.json'
            with self.assertRaises(OSError):
                with qualify.fixture_guard(Mock(side_effect=OSError('spawn failed')), {}, path):
                    self.fail('must not enter body')
            self.assertFalse(json.loads(path.read_text())['fixtureTerminated'])

    def test_fixture_timeout_escalates_and_records_cleanup_failures(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'receipt.json'
            proc = Mock()
            proc.poll.return_value = None
            proc.terminate.side_effect = OSError('terminate failed')
            proc.wait.side_effect = [subprocess.TimeoutExpired('fixture', 5), subprocess.TimeoutExpired('fixture', 5)]
            with self.assertRaises(RuntimeError):
                with qualify.fixture_guard(lambda: proc, {}, path):
                    pass
            proc.kill.assert_called_once()
            self.assertEqual(proc.wait.call_args_list, [unittest.mock.call(timeout=5), unittest.mock.call(timeout=5)])
            state = json.loads(path.read_text())
            self.assertFalse(state['fixtureTerminated'])
            self.assertEqual(len(state['fixtureCleanup']['errors']), 3)

    def test_fixture_timeout_then_kill_is_reaped(self):
        proc = Mock()
        proc.poll.return_value = None
        proc.wait.side_effect = [subprocess.TimeoutExpired('fixture',5), 0]
        result = qualify.reap_bounded(proc)
        self.assertTrue(result['reaped'])
        proc.kill.assert_called_once()


if __name__ == '__main__':
    unittest.main()
