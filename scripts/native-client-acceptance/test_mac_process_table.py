"""Darwin libproc binding tests with an injected library; no real process queries."""
import ctypes
import errno
import os
from pathlib import Path
import select
import subprocess
import sys
import unittest

try:
    from mac_owned_processes import DarwinProcessTable, ProcBSDInfo
except ImportError:
    DarwinProcessTable = ProcBSDInfo = None


class FakeLibproc:
    def __init__(self):
        self.pid = 42
        self.birth = 123
        self.path = b'/owned/helper'
        self.error = 0
        self.short = False
        self.change_birth = False
        self.child_count = 2
        self.calls = []

    def proc_pidinfo(self, pid, flavor, argument, buffer, size):
        self.calls.append(('info', pid))
        assert flavor == 3 and argument == 0 and size == 136, 'wrong BSD process-info call shape'
        if self.error:
            ctypes.set_errno(self.error)
            return 0
        value = buffer._obj
        value.pbi_pid = self.pid
        value.pbi_ppid = 40
        value.pbi_pgid = 42
        value.pbi_uid = os.geteuid()
        value.pbi_status = 2
        value.pbi_start_tvsec = 1000
        value.pbi_start_tvusec = self.birth
        return size - 1 if self.short else size

    def proc_pidpath(self, pid, buffer, size):
        self.calls.append(('path', pid))
        ctypes.memmove(buffer, self.path + b'\0', len(self.path) + 1)
        if self.change_birth:
            self.birth += 1
        return len(self.path)

    def proc_listchildpids(self, pid, buffer, size):
        self.calls.append(('children', pid))
        if self.child_count <= 256:
            for index in range(self.child_count):
                buffer[index] = 60 + index
        return self.child_count


class BindingTests(unittest.TestCase):
    def table(self):
        self.assertTrue(callable(DarwinProcessTable), 'Darwin process-table binding must be implemented')
        library = FakeLibproc()
        return library, DarwinProcessTable(api=library)

    def test_sdk_struct_layout_and_bound_birth_executable(self):
        library, table = self.table()
        self.assertEqual(ctypes.sizeof(ProcBSDInfo), 136)
        for field, offset in {'pbi_status': 4, 'pbi_pid': 12, 'pbi_ppid': 16, 'pbi_uid': 20,
                              'pbi_pgid': 100, 'pbi_start_tvsec': 120, 'pbi_start_tvusec': 128}.items():
            self.assertEqual(getattr(ProcBSDInfo, field).offset, offset, field)
        row = table.info(42)
        self.assertEqual((row['pid'], row['parent'], row['birthMicroseconds'], row['path']), (42, 40, 123, '/owned/helper'))
        self.assertEqual(library.calls, [('info', 42), ('path', 42), ('info', 42)])

    def test_missing_process_is_distinct_from_denied_or_unknown_inspection(self):
        library, table = self.table()
        library.error = errno.ESRCH
        self.assertIsNone(table.info(42))
        for error in [errno.EPERM, errno.EACCES, errno.EIO]:
            library.error = error
            with self.assertRaises(OSError):
                table.info(42)

    def test_short_struct_and_wrong_pid_fail_visibly(self):
        library, table = self.table()
        library.short = True
        with self.assertRaisesRegex(ValueError, 'short'):
            table.info(42)
        library.short = False
        library.pid = 43
        with self.assertRaisesRegex(ValueError, 'PID'):
            table.info(42)

    def test_birth_change_during_path_lookup_is_not_an_owned_identity(self):
        library, table = self.table()
        library.change_birth = True
        with self.assertRaisesRegex(ValueError, 'identity'):
            table.info(42)

    def test_child_count_is_a_count_not_bytes_and_full_buffer_is_unproved(self):
        library, table = self.table()
        self.assertEqual(table.children(42), [60, 61])
        self.assertEqual(library.calls, [('children', 42)])
        library.child_count = 256
        with self.assertRaisesRegex(ValueError, 'truncated'):
            table.children(42)

    def test_process_path_capacity_cannot_be_truncated(self):
        library, table = self.table()
        library.path = b'x' * 4096
        # The fake library must not write beyond the buffer on this branch.
        library.proc_pidpath = lambda pid, buffer, size: size
        with self.assertRaisesRegex(ValueError, 'path'):
            table.info(42)

    def test_path_lookup_failure_after_observed_actor_does_not_claim_disappearance(self):
        library, table = self.table()
        def missing_path(pid, buffer, size):
            ctypes.set_errno(errno.ESRCH)
            return 0
        library.proc_pidpath = missing_path
        with self.assertRaises(OSError):
            table.info(42)

    def test_denied_child_query_does_not_claim_an_empty_tree(self):
        library, table = self.table()
        def denied(pid, buffer, size):
            ctypes.set_errno(errno.EPERM)
            return 0
        library.proc_listchildpids = denied
        with self.assertRaises(OSError):
            table.children(42)

    def test_successful_empty_children_clears_stale_errno(self):
        library, table = self.table()
        library.child_count = 0
        for stale_error in [0, errno.EPERM, errno.ESRCH]:
            ctypes.set_errno(stale_error)
            self.assertEqual(table.children(42), [])


@unittest.skipUnless(sys.platform == 'darwin' and os.environ.get('NATIVE_ACCEPTANCE_OWNED_PROCESS_TEST') == 'yes',
                     'opt-in Darwin owned-child integration, no desktop access')
class OwnedChildIntegration(unittest.TestCase):
    def test_actual_owned_child_birth_path_traversal_and_reaping(self):
        self.assertTrue(callable(DarwinProcessTable), 'Darwin process-table binding must be implemented')
        from mac_owned_processes import OwnedProcessTracker
        table = DarwinProcessTable()
        parent = table.info(os.getpid())
        tracker = OwnedProcessTracker(table, parent)
        # Isolated Python startup; this child has no files, input, imports from
        # user configuration, desktop calls or descendants and exits after 2 s.
        child = subprocess.Popen([sys.executable, '-I', '-S', '-c',
                                  "import time; print('owned-ready', flush=True); time.sleep(2)"],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL)
        try:
            ready, _, _ = select.select([child.stdout], [], [], 3)
            self.assertTrue(ready, 'owned child startup did not finish inside its budget')
            self.assertEqual(os.read(child.stdout.fileno(), 64).strip(), b'owned-ready')
            row = table.info(child.pid)
            self.assertEqual(row['parent'], os.getpid())
            # Framework Python's bin/python launcher re-execs Python.app. Bind
            # the child to this parent's exact kernel-observed interpreter image,
            # rather than pretending that the launcher path is the process image.
            self.assertEqual(Path(row['path']).resolve(), Path(parent['path']).resolve())
            self.assertGreater(row['birthSeconds'], 0)
            self.assertEqual(table.info(child.pid)['birthMicroseconds'], row['birthMicroseconds'])
            self.assertIn(child.pid, {value['pid'] for value in tracker.scan()})
            self.assertIn(child.pid, {value['pid'] for value in tracker.live_owned()})
            self.assertEqual(child.wait(timeout=3), 0)
            self.assertIsNone(table.info(child.pid))
            self.assertNotIn(child.pid, {value['pid'] for value in tracker.remaining_owned()})
        finally:
            # This unreaped direct Popen child cannot transfer its PID. Keep
            # cleanup bounded even if the controlled interpreter fails startup.
            if child.returncode is None:
                child.kill()
                child.wait(timeout=3)
            child.stdout.close()
            self.assertIsNone(table.info(child.pid), 'owned child remains observable after explicit wait')


if __name__ == '__main__':
    unittest.main()
