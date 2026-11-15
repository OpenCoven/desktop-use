"""Actual descendant-process tracing tests; run only in the owned Linux namespace."""
import os
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from owned_trace_stop import ATTACH, OwnedTraceStop, TraceUnavailable


def birth(pid):
    return Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()[19]


class TraceTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(sys.platform, 'linux')
        self.root = tempfile.TemporaryDirectory(prefix='owned-trace-test-')
        self.addCleanup(self.root.cleanup)
        self.next_child = 0

    def child(self, threaded=False):
        self.next_child += 1
        root = Path(self.root.name) / str(self.next_child)
        root.mkdir()
        program = """import os,signal,sys,time,threading
from pathlib import Path
root=Path(sys.argv[1])
signal.signal(signal.SIGUSR1,lambda *_:root.joinpath('signal').write_text(str(os.getpid())))
if sys.argv[2]=='threaded':
 threading.Thread(target=lambda:time.sleep(30),daemon=True).start()
root.joinpath('ready').write_text(str(os.getpid()))
while True:
 root.joinpath('tick').write_text(str(time.monotonic_ns()))
 time.sleep(.002)
"""
        child = subprocess.Popen([sys.executable, '-c', program, str(root), 'threaded' if threaded else 'single'], start_new_session=True)
        pidfd = os.pidfd_open(child.pid)
        def cleanup():
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            end = time.monotonic() + 2
            while time.monotonic() < end:
                try:
                    pid, status = os.waitpid(child.pid, os.WNOHANG | 0x40000000)
                except ChildProcessError:
                    break
                if pid and (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
                    child.returncode = os.waitstatus_to_exitcode(status)
                    break
                time.sleep(.001)
            else:
                raise AssertionError('owned test child was not reaped')
            os.close(pidfd)
            child.wait(timeout=2)
        self.addCleanup(cleanup)
        end = time.monotonic() + 2
        while not root.joinpath('ready').exists() or not root.joinpath('tick').exists():
            self.assertIsNone(child.poll())
            self.assertLess(time.monotonic(), end)
            time.sleep(.002)
        return child, root

    def observer(self, child, **changes):
        args = dict(pid=child.pid, expected_start=birth(child.pid),
                    parent=(os.getpid(), birth(os.getpid())),
                    executable=str(Path(sys.executable).resolve()), deadline=time.monotonic() + 2)
        args.update(changes)
        return OwnedTraceStop(**args)

    def test_actual_syscall_stop_becomes_detached_group_stop(self):
        child, root = self.child()
        with self.observer(child) as observer:
            observer.hold_when(lambda: True)
            status = Path('/proc/%d/status' % child.pid).read_text()
            self.assertIn('TracerPid:\t0\n', status)
            self.assertEqual(status.split('State:\t')[1][0], 'T')
            before = root.joinpath('tick').read_text()
            time.sleep(.025)
            self.assertEqual(root.joinpath('tick').read_text(), before)
            self.assertTrue(observer.detached_stopped())
        child.wait(timeout=2)
        self.assertFalse(Path('/proc/%d' % child.pid).exists())

    def test_boundary_timeout_contains_the_touched_tracee(self):
        child, _ = self.child()
        with self.assertRaises(TraceUnavailable):
            with self.observer(child, deadline=time.monotonic() + .12) as observer:
                observer.hold_when(lambda: False)
        child.wait(timeout=2)
        self.assertFalse(Path('/proc/%d' % child.pid).exists())

    def test_wrong_birth_is_rejected_before_any_signal(self):
        child, _ = self.child()
        with self.assertRaises(TraceUnavailable):
            self.observer(child, expected_start='wrong-birth')
        self.assertIsNone(child.poll())

    def test_wrong_executable_is_rejected_before_any_signal(self):
        child, _ = self.child()
        with self.assertRaises(TraceUnavailable):
            self.observer(child, executable='/not-the-owned-executable')
        self.assertIsNone(child.poll())

    def test_multithreaded_helper_is_rejected_before_any_signal(self):
        child, _ = self.child(threaded=True)
        with self.assertRaises(TraceUnavailable):
            self.observer(child)
        self.assertIsNone(child.poll())

    def test_cannot_attach_to_the_observer_itself(self):
        with self.assertRaises(TraceUnavailable):
            OwnedTraceStop(pid=os.getpid(), expected_start=birth(os.getpid()),
                           parent=(os.getpid(), birth(os.getpid())),
                           executable=str(Path(sys.executable).resolve()), deadline=time.monotonic() + 1)

    def test_unrelated_signal_is_delivered_before_the_hold(self):
        child, root = self.child()
        sent = False
        def boundary():
            nonlocal sent
            if not sent:
                os.kill(child.pid, signal.SIGUSR1)
                sent = True
            return root.joinpath('signal').exists() and root.joinpath('signal').read_text() == str(child.pid)
        with self.observer(child) as observer:
            observer.hold_when(boundary)
            self.assertTrue(root.joinpath('signal').exists())
            self.assertEqual(root.joinpath('signal').read_text(), str(child.pid))
            self.assertTrue(observer.detached_stopped())

    def test_interrupted_observation_cleans_only_its_bound_tracee(self):
        child, _ = self.child()
        unrelated, _ = self.child()
        def interrupted():
            raise RuntimeError('controlled observer interruption')
        with self.assertRaises(RuntimeError):
            with self.observer(child) as observer:
                observer.hold_when(interrupted)
        child.wait(timeout=2)
        self.assertFalse(Path('/proc/%d' % child.pid).exists())
        self.assertIsNone(unrelated.poll())

    def test_replacement_at_numeric_attach_is_detached_without_signals_or_kill(self):
        original, _ = self.child()
        time.sleep(.02)
        replacement, root = self.child()
        observer = self.observer(original)
        request = observer._request
        def attach_replacement(operation, data=0):
            # Controlled boundary fault: numeric ptrace now resolves to a real
            # different process while the retained pidfd still binds original.
            if operation == ATTACH:
                observer.pid = replacement.pid
            return request(operation, data)
        observer._request = attach_replacement
        with self.assertRaises(TraceUnavailable):
            with observer:
                observer.hold_when(lambda: True)
        status = Path('/proc/%d/status' % replacement.pid).read_text()
        self.assertIn('TracerPid:\t0\n', status)
        self.assertNotEqual(status.split('State:\t')[1][0], 'T')
        before = root.joinpath('tick').read_text()
        time.sleep(.025)
        self.assertNotEqual(root.joinpath('tick').read_text(), before)
        self.assertIsNone(original.poll())
        self.assertIsNone(replacement.poll())

    def test_exited_pidfd_detects_replacement_even_when_birth_tokens_match(self):
        original, _ = self.child()
        replacement, root = self.child()
        observer = self.observer(original)
        request = observer._request
        def attach_collision(operation, data=0):
            if operation == ATTACH:
                original.kill()
                original.wait(timeout=2)
                observer.pid = replacement.pid
                # Model a coarse /proc start-tick collision; the original
                # pidfd, unlike that token, still identifies the exited task.
                observer.expected_start = birth(replacement.pid)
            return request(operation, data)
        observer._request = attach_collision
        failure = None
        try:
            with observer:
                observer.hold_when(lambda: True)
        except BaseException as error:
            failure = error
        status = Path('/proc/%d/status' % replacement.pid).read_text()
        self.assertIn('TracerPid:\t0\n', status)
        self.assertNotEqual(status.split('State:\t')[1][0], 'T')
        self.assertIsInstance(failure, TraceUnavailable)
        self.assertIsNone(replacement.poll())

    def test_grandchild_tracing_preserves_the_native_parent_wait_status(self):
        root = Path(self.root.name) / 'grandchild'
        root.mkdir()
        program = """import json,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1])
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])
root.joinpath('ready').write_text(json.dumps({'pid':child.pid}))
code=child.wait()
root.joinpath('settled').write_text(str(code))
sys.exit(23)
"""
        parent = subprocess.Popen([sys.executable, '-c', program, str(root)])
        parent_fd = os.pidfd_open(parent.pid)
        def cleanup_parent():
            try:
                signal.pidfd_send_signal(parent_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            parent.wait(timeout=2)
            os.close(parent_fd)
        self.addCleanup(cleanup_parent)
        end = time.monotonic() + 2
        while not root.joinpath('ready').exists() or not root.joinpath('ready').read_text():
            self.assertLess(time.monotonic(), end)
            time.sleep(.002)
        pid = json.loads(root.joinpath('ready').read_text())['pid']
        helper_fd = os.pidfd_open(pid)
        def cleanup_helper():
            try:
                signal.pidfd_send_signal(helper_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(helper_fd)
        self.addCleanup(cleanup_helper)
        with OwnedTraceStop(pid=pid, expected_start=birth(pid), parent=(parent.pid, birth(parent.pid)),
                            executable=str(Path(sys.executable).resolve()), deadline=time.monotonic()+2) as observer:
            observer.hold_when(lambda: True)
            self.assertTrue(observer.detached_stopped())
        self.assertEqual(parent.wait(timeout=2), 23)
        self.assertEqual(root.joinpath('settled').read_text(), str(-signal.SIGKILL))
        self.assertFalse(Path('/proc/%d' % pid).exists())


if __name__ == '__main__':
    unittest.main()
