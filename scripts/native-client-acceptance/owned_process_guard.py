"""Linux test-process containment: adopt detached descendants before starting work."""
import ctypes
import os
from pathlib import Path
import signal
import time


def enable_subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'Cannot contain owned test descendants')


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return int(fields[1]), fields[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def descendants():
    processes = {}
    for path in Path('/proc').iterdir():
        if path.name.isdecimal():
            value = identity(int(path.name))
            if value is not None:
                processes[int(path.name)] = value
    owned = {os.getpid()}
    while True:
        added = {pid for pid, (parent, _) in processes.items() if parent in owned} - owned
        if not added:
            return {pid: processes[pid][1] for pid in owned if pid != os.getpid()}
        owned.update(added)


def terminate_owned_descendants():
    started = time.monotonic()
    while True:
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
        live = descendants()
        if not live:
            return
        elapsed = time.monotonic() - started
        for pid, birth in live.items():
            current = identity(pid)
            if current is not None and current[1] == birth:
                try:
                    os.kill(pid, signal.SIGKILL if elapsed >= 1 else signal.SIGTERM)
                except ProcessLookupError:
                    pass
        if elapsed >= 10:
            raise RuntimeError('Owned descendants remain; retain exclusive display lease for recovery')
        time.sleep(0.02)
