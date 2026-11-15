"""Injected cleanup faults only; no real processes, signals or desktop APIs."""
import importlib.util
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mac_active_coordinator', Path(__file__).with_name('mac-active-coordinator.py'))
coordinator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coordinator)


def actor(pid=11, birth=123, path='/owned/helper', status=2):
    return {'pid': pid, 'parent': 10, 'birthSeconds': 1000, 'birthMicroseconds': birth,
            'path': path, 'status': status}


class FakePipe:
    def close(self):
        pass


class FakeChild:
    pid = 10
    def __init__(self, waits=None):
        self.waits = list(waits or [0])
        self.returncode = None
        self.stdin = FakePipe()
        self.calls = []

    def wait(self, timeout):
        value = self.waits.pop(0) if self.waits else self.returncode
        if value == 'timeout':
            raise subprocess.TimeoutExpired('owned-child', timeout)
        self.returncode = value
        return value

    def terminate(self):
        self.calls.append('terminate')

    def kill(self):
        self.calls.append('kill')


class FakeTable:
    def __init__(self):
        self.rows = {11: actor()}
        self.inspection_error = False

    def info(self, pid):
        if self.inspection_error:
            raise PermissionError('injected denied inspection')
        return dict(self.rows[pid]) if pid in self.rows else None


class FakeTracker:
    def __init__(self, table):
        self.table = table
        self.expected = actor()

    def remaining_owned(self):
        return [dict(self.expected)] if 11 in self.table.rows else []


class CleanupTests(unittest.TestCase):
    def test_case_environment_preserves_prepared_home_without_adopting_global_home(self):
        function=getattr(coordinator,'prepared_home_environment',None)
        self.assertTrue(callable(function),'coordinator must forward prepared POSIX and Foundation homes')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();home=root/'home';home.mkdir()
            self.assertEqual(function(root,{'helperHome':str(home)}),{'HOME':str(home),'CFFIXED_USER_HOME':str(home)})
            with self.assertRaises(ValueError):function(root,{'helperHome':'/global/home'})
            self.assertEqual(function(root,{}),{})

    def test_case_deadline_reserves_cleanup_inside_the_exclusive_lease(self):
        function = getattr(coordinator, 'case_deadline', None)
        self.assertTrue(callable(function), 'lease admission must reserve bounded cleanup')
        for remaining in [0, 70, 90, 100, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                function(remaining, 10)
        deadline = function(101, 10)
        self.assertLessEqual(deadline + 35, 10 + 101)
        self.assertLessEqual(deadline - 10, 55)

    def run_cleanup(self, child=None, table=None, clear_on_term=True, signal_error=False):
        function = getattr(coordinator, 'cleanup_owned', None)
        self.assertTrue(callable(function), 'bounded owned-actor cleanup must be implemented')
        table = table or FakeTable()
        child = child or FakeChild()
        calls = []
        tick = [0.0]
        def now():
            tick[0] += 0.1
            return tick[0]
        def send(pid, number):
            calls.append((pid, number))
            if signal_error:
                raise PermissionError('injected denied signal')
            if clear_on_term or number == signal.SIGKILL:
                table.rows.pop(pid, None)
        result = function(child, FakeTracker(table), table, send_signal=send, now=now, sleep=lambda _: None)
        return result, calls, child

    def test_normal_direct_child_reap_and_bound_helper_term(self):
        result, calls, child = self.run_cleanup()
        self.assertTrue(result['directConsumerReaped'])
        self.assertTrue(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [(11, signal.SIGTERM)])
        self.assertEqual(child.calls, [])

    def test_unreaped_direct_child_has_bounded_term_then_kill_escalation(self):
        child = FakeChild(['timeout', 'timeout', -9])
        result, calls, _ = self.run_cleanup(child=child)
        self.assertEqual(child.calls, ['terminate', 'kill'])
        self.assertTrue(result['directConsumerReaped'])

    def test_same_birth_exec_change_prevents_descendant_signal(self):
        table = FakeTable(); table.rows[11]['path'] = '/different/image'
        result, calls, _ = self.run_cleanup(table=table)
        self.assertFalse(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [])

    def test_pid_reuse_prevents_descendant_signal(self):
        table = FakeTable(); table.rows[11]['birthMicroseconds'] += 1
        result, calls, _ = self.run_cleanup(table=table)
        self.assertFalse(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [])

    def test_zombie_is_unreaped_without_signaling_it(self):
        table = FakeTable(); table.rows[11]['status'] = 5
        result, calls, _ = self.run_cleanup(table=table)
        self.assertFalse(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [])

    def test_denied_signal_retains_unverified_cleanup(self):
        result, calls, _ = self.run_cleanup(signal_error=True)
        self.assertFalse(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [(11, signal.SIGTERM)])

    def test_denied_inspection_does_not_signal_unknown_actor(self):
        table = FakeTable(); table.inspection_error = True
        result, calls, _ = self.run_cleanup(table=table)
        self.assertFalse(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [])

    def test_helper_that_ignores_term_is_revalidated_before_kill(self):
        result, calls, _ = self.run_cleanup(clear_on_term=False)
        self.assertTrue(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [(11, signal.SIGTERM), (11, signal.SIGKILL)])

    def test_closed_control_pipe_does_not_skip_owned_actor_cleanup(self):
        child = FakeChild()
        def broken():
            raise BrokenPipeError('injected closed pipe')
        child.stdin.close = broken
        result, calls, _ = self.run_cleanup(child=child)
        self.assertTrue(result['knownActorCleanupVerified'])
        self.assertEqual(calls, [(11, signal.SIGTERM)])


if __name__ == '__main__':
    unittest.main()
