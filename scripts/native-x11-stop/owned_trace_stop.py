"""Observer-only controlled scheduling of an explicitly owned Linux descendant."""
import ctypes
import errno
import os
from pathlib import Path
import signal
import select
import sys
import time


ATTACH, DETACH, SYSCALL, SETOPTIONS, GETSIGINFO = 16, 17, 24, 0x4200, 0x4202
TRACESYSGOOD, WALL = 1, 0x40000000


def process_identity(pid):
    try:
        fields = Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
        return int(fields[1]), fields[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def process_status(pid):
    try:
        return dict(line.split(':', 1) for line in Path('/proc/%d/status' % pid).read_text().splitlines())
    except (FileNotFoundError, ProcessLookupError):
        return None


class TraceUnavailable(RuntimeError):
    pass


class OwnedTraceStop:
    def __init__(self, *, pid, expected_start, parent, executable, deadline):
        self.pid = pid
        self.expected_start = expected_start
        self.parent = parent
        self.executable = executable
        self.deadline = deadline
        self.pidfd = None
        self.touched = False
        self.at_stop = False
        self.phase = 'bound'
        if sys.platform != 'linux' or pid <= 1 or pid == os.getpid():
            raise TraceUnavailable('TRACE_NOT_OWNED_DESCENDANT')
        if not time.monotonic() < deadline <= time.monotonic() + 10:
            raise TraceUnavailable('TRACE_DEADLINE_INVALID')
        self._validate()
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.ptrace.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
        self.libc.ptrace.restype = ctypes.c_long
        try:
            self.pidfd = os.pidfd_open(pid)
            self._validate()
        except BaseException:
            if self.pidfd is not None:
                os.close(self.pidfd)
                self.pidfd = None
            raise

    def _validate(self):
        parent_identity = process_identity(self.parent[0])
        if self._pidfd_exited() or process_identity(self.pid) != (self.parent[0], self.expected_start) or parent_identity is None or parent_identity[1] != self.parent[1]:
            raise TraceUnavailable('TRACE_IDENTITY_LOST')
        current = self.parent[0]
        for _ in range(64):
            if current == os.getpid():
                break
            identity = process_identity(current)
            if current <= 1 or identity is None:
                raise TraceUnavailable('TRACE_NOT_OWNED_DESCENDANT')
            current = identity[0]
        else:
            raise TraceUnavailable('TRACE_NOT_OWNED_DESCENDANT')
        try:
            executable = os.readlink('/proc/%d/exe' % self.pid)
        except (FileNotFoundError, ProcessLookupError):
            raise TraceUnavailable('TRACE_IDENTITY_LOST') from None
        if not Path(self.executable).is_absolute() or executable != self.executable:
            raise TraceUnavailable('TRACE_EXECUTABLE_CHANGED')
        status = process_status(self.pid)
        if status is None or int(status['Threads']) != 1 or len(list(Path('/proc/%d/task' % self.pid).iterdir())) != 1:
            raise TraceUnavailable('TRACE_NOT_SINGLE_THREADED')
        if int(status['TracerPid']) not in [0, os.getpid()]:
            raise TraceUnavailable('TRACE_OTHER_TRACER')

    def _pidfd_exited(self):
        if self.pidfd is None:
            return False
        ready = select.poll()
        ready.register(self.pidfd, select.POLLIN)
        return bool(ready.poll(0))

    def _request(self, request, data=0):
        ctypes.set_errno(0)
        value = ctypes.c_void_p(data) if isinstance(data, int) else ctypes.cast(data, ctypes.c_void_p)
        if self.libc.ptrace(request, self.pid, None, value) == -1:
            raise TraceUnavailable('TRACE_OPERATION_REFUSED')

    def _wait_stop(self):
        while time.monotonic() < self.deadline:
            try:
                pid, status = os.waitpid(self.pid, os.WNOHANG | WALL)
            except ChildProcessError:
                raise TraceUnavailable('TRACE_EXITED') from None
            if pid:
                if os.WIFEXITED(status) or os.WIFSIGNALED(status):
                    self.phase = 'exited'
                    raise TraceUnavailable('TRACE_EXITED')
                if os.WIFSTOPPED(status):
                    self.at_stop = True
                    return status
            time.sleep(.0002)
        raise TraceUnavailable('TRACE_BOUNDARY_TIMEOUT')

    def _delivery_signal(self, status):
        stopped = os.WSTOPSIG(status)
        if stopped == signal.SIGTRAP | 0x80:
            return 0
        info = ctypes.create_string_buffer(128)
        ctypes.set_errno(0)
        result = self.libc.ptrace(GETSIGINFO, self.pid, None, ctypes.cast(info, ctypes.c_void_p))
        if result == -1:
            if ctypes.get_errno() == errno.EINVAL:
                raise TraceUnavailable('TRACE_UNEXPECTED_GROUP_STOP')
            raise TraceUnavailable('TRACE_SIGNAL_INFO_UNAVAILABLE')
        if ctypes.c_int.from_buffer(info).value != stopped:
            raise TraceUnavailable('TRACE_SIGNAL_INFO_INVALID')
        return stopped

    def _resume(self, delivery):
        self._validate()
        self._request(SYSCALL, delivery)
        self.at_stop = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def hold_when(self, predicate):
        self._validate()
        if self.touched or int(process_status(self.pid)['TracerPid']) != 0:
            raise TraceUnavailable('TRACE_ALREADY_ACTIVE')
        # Responsibility exists even if a signal interrupts after ATTACH but
        # before its result is observed in Python.
        self.touched = True
        self.phase = 'attaching'
        self._request(ATTACH)
        # ptrace accepts a numeric PID rather than the retained pidfd. Detect
        # replacement before consuming stops or issuing further tracing work.
        self._validate()
        while True:
            status = self._wait_stop()
            delivery = self._delivery_signal(status)
            if delivery == signal.SIGSTOP:
                break
            self._resume(delivery)
        self._request(SETOPTIONS, TRACESYSGOOD)
        self.phase = 'observing'
        self._resume(0)
        while True:
            status = self._wait_stop()
            self._validate()
            delivery = self._delivery_signal(status)
            if predicate():
                # A signal argument to DETACH at a syscall-stop can be ignored.
                # Reach a real signal-delivery-stop before reinjecting SIGSTOP.
                signal.pidfd_send_signal(self.pidfd, signal.SIGSTOP)
                self.phase = 'stopping'
                self._resume(delivery)
                while True:
                    status = self._wait_stop()
                    delivery = self._delivery_signal(status)
                    if delivery == signal.SIGSTOP:
                        break
                    self._resume(delivery)
                self._validate()
                self._request(DETACH, signal.SIGSTOP)
                self.at_stop = False
                self.phase = 'detached-stop'
                while time.monotonic() < self.deadline:
                    if self.detached_stopped():
                        return
                    time.sleep(.0002)
                raise TraceUnavailable('TRACE_DETACHED_STOP_UNVERIFIED')
            self._resume(delivery)

    def detached_stopped(self):
        self._validate()
        status = process_status(self.pid)
        return int(status['TracerPid']) == 0 and status['State'].strip().startswith('T')

    def close(self):
        try:
            if not self.touched or self.pidfd is None:
                return
            identity = process_identity(self.pid)
            if identity is None:
                return
            status = process_status(self.pid)
            if status is None:
                return
            tracer = int(status['TracerPid'])
            if identity[1] != self.expected_start or self._pidfd_exited():
                if tracer == os.getpid():
                    self._unwind_replaced_attachment()
                return
            if tracer not in [0, os.getpid()]:
                raise TraceUnavailable('TRACE_OTHER_TRACER_DURING_CLEANUP')
            signal.pidfd_send_signal(self.pidfd, signal.SIGKILL)
            if tracer == os.getpid():
                end = time.monotonic() + .25
                while time.monotonic() < end:
                    try:
                        pid, state = os.waitpid(self.pid, os.WNOHANG | WALL)
                    except ChildProcessError:
                        return
                    if pid and (os.WIFEXITED(state) or os.WIFSIGNALED(state)):
                        return
                    time.sleep(.0002)
                raise TraceUnavailable('TRACE_REAP_TIMEOUT')
        finally:
            if self.pidfd is not None:
                os.close(self.pidfd)
                self.pidfd = None

    def _unwind_replaced_attachment(self):
        # A successful numeric ATTACH can have selected a reused PID. We own
        # that attachment, not that process: only detach, with no injected
        # signal, and never use the old pidfd to signal this replacement.
        end = time.monotonic() + .25
        while time.monotonic() < end:
            try:
                pid, state = os.waitpid(self.pid, os.WNOHANG | WALL)
            except ChildProcessError:
                return
            if pid:
                if os.WIFEXITED(state) or os.WIFSIGNALED(state):
                    return
                if os.WIFSTOPPED(state):
                    self._request(DETACH, 0)
                    return
            time.sleep(.0002)
        raise TraceUnavailable('TRACE_REPLACEMENT_DETACH_TIMEOUT')
