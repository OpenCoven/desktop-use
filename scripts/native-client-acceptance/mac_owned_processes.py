"""Read-only ownership tracking for a separate macOS acceptance coordinator.

The injected table supplies process observations. This module never enumerates
global processes, signals actors, invokes a desktop helper or establishes reaping.
"""
import ctypes
import errno
import os
import sys


class ProcBSDInfo(ctypes.Structure):
    # The selected SDK layout is checked independently by mac-process-abi-check.c.
    _fields_ = [(name, ctypes.c_uint32) for name in [
        'pbi_flags', 'pbi_status', 'pbi_xstatus', 'pbi_pid', 'pbi_ppid',
        'pbi_uid', 'pbi_gid', 'pbi_ruid', 'pbi_rgid', 'pbi_svuid',
        'pbi_svgid', 'rfu_1']] + [
        ('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32),
        ('pbi_nfiles', ctypes.c_uint32), ('pbi_pgid', ctypes.c_uint32),
        ('pbi_pjobc', ctypes.c_uint32), ('e_tdev', ctypes.c_uint32),
        ('e_tpgid', ctypes.c_uint32), ('pbi_nice', ctypes.c_int32),
        ('pbi_start_tvsec', ctypes.c_uint64), ('pbi_start_tvusec', ctypes.c_uint64)]


class DarwinProcessTable:
    def __init__(self, api=None):
        if api is None:
            if sys.platform != 'darwin':
                raise ValueError('libproc inspection requires Darwin')
            api = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
            api.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
            api.proc_pidinfo.restype = ctypes.c_int
            api.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
            api.proc_pidpath.restype = ctypes.c_int
            api.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
            api.proc_listchildpids.restype = ctypes.c_int
        self.api = api

    def _bsd(self, pid):
        if not isinstance(pid, int) or pid <= 1:
            raise ValueError('invalid process PID')
        value = ProcBSDInfo()
        ctypes.set_errno(0)
        count = self.api.proc_pidinfo(pid, 3, 0, ctypes.byref(value), ctypes.sizeof(value))
        error = ctypes.get_errno()
        if count == 0 and error == errno.ESRCH:
            return None
        if count == 0:
            raise OSError(error or errno.EIO, 'process inspection did not establish identity')
        if count != ctypes.sizeof(value):
            raise ValueError('short BSD process-info result')
        if value.pbi_pid != pid:
            raise ValueError('returned process PID does not match request')
        if value.pbi_uid != os.geteuid():
            raise ValueError('process UID differs from fixture owner')
        if value.pbi_start_tvsec <= 0 or value.pbi_start_tvusec >= 1_000_000:
            raise ValueError('invalid process birth identity')
        return value

    def info(self, pid):
        before = self._bsd(pid)
        if before is None:
            return None
        buffer = ctypes.create_string_buffer(4096)
        ctypes.set_errno(0)
        count = self.api.proc_pidpath(pid, buffer, len(buffer))
        error = ctypes.get_errno()
        if count <= 0:
            # A previously observed actor with an unavailable path is unresolved,
            # even if this particular lookup reports ESRCH. Never claim reaping.
            raise OSError(error or errno.EIO, 'observed process executable is unresolved')
        if count >= len(buffer) or not buffer.value.startswith(b'/'):
            raise ValueError('process path is invalid or truncated')
        after = self._bsd(pid)
        birth = lambda value: None if value is None else (value.pbi_pid, value.pbi_start_tvsec, value.pbi_start_tvusec)
        if birth(before) != birth(after):
            raise ValueError('process identity changed during executable lookup')
        return {'pid': pid, 'parent': after.pbi_ppid, 'group': after.pbi_pgid,
                'uid': after.pbi_uid, 'status': after.pbi_status,
                'birthSeconds': after.pbi_start_tvsec, 'birthMicroseconds': after.pbi_start_tvusec,
                'path': os.fsdecode(buffer.value)}

    def children(self, pid):
        if not isinstance(pid, int) or pid <= 1:
            raise ValueError('invalid parent PID')
        buffer = (ctypes.c_int * 256)()
        ctypes.set_errno(0)
        count = self.api.proc_listchildpids(pid, buffer, ctypes.sizeof(buffer))
        error = ctypes.get_errno()
        if count < 0 or error:
            raise OSError(error or errno.EIO, 'owned child inspection is unresolved')
        # Apple proc_listchildpids returns a PID count, unlike proc_listpids bytes.
        if count >= len(buffer):
            raise ValueError('owned child list may be truncated')
        values = list(buffer[:count])
        if any(value <= 1 for value in values) or len(set(values)) != len(values):
            raise ValueError('invalid owned child list')
        return values


class _MachTimebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


class DarwinContinuousClock:
    domain = 'darwin-mach-continuous-nanoseconds'

    def __init__(self, api=None):
        if api is None:
            if sys.platform != 'darwin':
                raise ValueError('continuous Mach clock requires Darwin')
            api = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
            api.mach_timebase_info.argtypes = [ctypes.POINTER(_MachTimebase)]
            api.mach_timebase_info.restype = ctypes.c_int
            api.mach_continuous_time.argtypes = []
            api.mach_continuous_time.restype = ctypes.c_uint64
        self.api = api
        value = _MachTimebase()
        status = api.mach_timebase_info(ctypes.byref(value))
        if status != 0 or not value.numer or not value.denom:
            raise ValueError('unqualified Mach continuous-clock timebase')
        self.numer, self.denom = value.numer, value.denom

    def now_ns(self):
        ticks = self.api.mach_continuous_time()
        if not isinstance(ticks, int) or not 0 <= ticks < (1 << 64):
            raise ValueError('invalid Mach continuous-clock ticks')
        # Match the audited libuv 1.52.1 and Swift UInt64 multiply/divide exactly.
        return ((ticks * self.numer) & ((1 << 64) - 1)) // self.denom


def identity(row):
    if row is None:
        return None
    return (row['pid'], row['birthSeconds'], row['birthMicroseconds'], row['path'])


class OwnedProcessTracker:
    def __init__(self, table, root):
        if not root or root['pid'] <= 1 or root['birthMicroseconds'] < 0:
            raise ValueError('invalid owned root identity')
        self.table = table
        self.root = dict(root)
        self.owned = {}

    def scan(self):
        if identity(self.table.info(self.root['pid'])) != identity(self.root):
            raise ValueError('owned root identity changed')
        pending = {}
        visited = set()

        def visit(parent):
            pid = parent['pid']
            if pid in visited or len(visited) >= 256:
                raise ValueError('owned process traversal is cyclic or exceeds its bound')
            visited.add(pid)
            if identity(self.table.info(pid)) != identity(parent):
                raise ValueError('parent identity changed before traversal')
            children = self.table.children(pid)
            if len(children) > 256 or len(set(children)) != len(children):
                raise ValueError('invalid owned child list')
            for child_pid in children:
                child = self.table.info(child_pid)
                if child is None:
                    continue  # Already exited; no ownership or reaping claim.
                if child['parent'] != pid:
                    raise ValueError('child parent changed before ownership registration')
                if child_pid <= 1 or child_pid == self.root['pid']:
                    raise ValueError('invalid child identity')
                visit(child)
                after = self.table.info(child_pid)
                if after is None:
                    continue
                if identity(after) != identity(child) or after['parent'] != pid:
                    raise ValueError('child identity or parent changed during traversal')
                pending[identity(child)] = dict(child)
            if identity(self.table.info(pid)) != identity(parent):
                raise ValueError('parent identity changed during traversal')

        visit(self.root)
        if identity(self.table.info(self.root['pid'])) != identity(self.root):
            raise ValueError('owned root identity changed after traversal')
        # Commit only a complete, identity-checked traversal. Retain prior owned
        # identities so known helpers remain observable after reparenting.
        self.owned.update(pending)
        return list(pending.values())

    def remaining_owned(self):
        values = []
        for expected in self.owned.values():
            current = self.table.info(expected['pid'])
            if current is not None and identity(current)[:3] == identity(expected)[:3] and current['path'] != expected['path']:
                raise ValueError('owned actor changed executable; disappearance is unproved')
            if identity(current) == identity(expected):
                values.append(current)
        return values

    def live_owned(self):
        # Darwin SZOMB=5: a zombie is not active, but remaining_owned retains it.
        # Absence from this list alone never proves that a helper was reaped.
        return [row for row in self.remaining_owned() if row['status'] != 5]
