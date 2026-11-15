#!/usr/bin/env python3
"""Outer resume/termination guard, only inside the task-owned Linux container."""
import os
from pathlib import Path
import signal
import subprocess
from owned_process_guard import enable_subreaper, identity, terminate_owned_descendants

assert os.environ.get('NATIVE_OWNED_DISPOSABLE_DISPLAY') == 'yes'
server = int(Path('/owned/xvfb.pid').read_text())
command = Path(f'/proc/{server}/cmdline').read_bytes().split(b'\0')
assert server > 1 and command[0].endswith(b'Xvfb') and command[1] == b':91'
server_birth = identity(server)
enable_subreaper()
def interrupted(number, _frame):
    raise SystemExit(128 + number)
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
child = None
try:
    child = subprocess.Popen(['node','/owned/consumer/active-cancellation.mjs'], start_new_session=True)
    status = child.wait(timeout=180)
    if status: raise SystemExit(status)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    terminate_owned_descendants()
    if identity(server) == server_birth:
        os.kill(server,signal.SIGCONT)
