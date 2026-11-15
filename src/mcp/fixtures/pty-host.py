"""Disposable PTY operator: drives the real reference UI, never an approval provider stub."""
import re, errno, fcntl, os, pty, select, signal, subprocess, sys, termios
if sys.argv[1] == 'no-tty':
    child = subprocess.Popen(sys.argv[2:], stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer, start_new_session=True)
    signal.signal(signal.SIGTERM, lambda signum, frame: child.send_signal(signum))
    signal.signal(signal.SIGINT, lambda signum, frame: child.send_signal(signum))
    sys.exit(child.wait())
master, slave = pty.openpty()
mode = sys.argv[1]
command = sys.argv[2:]
if mode == 'background':
    # Same terminal, but as a background job: an intermediate keeps the terminal's foreground group and runs
    # the command in a new process group that is not the foreground.
    command = [sys.executable, '-I', '-c', (
        'import os, sys\n'
        'pid = os.fork()\n'
        'if pid == 0:\n'
        '    os.setpgid(0, 0); os.execvp(sys.argv[1], sys.argv[1:])\n'
        'try:\n'
        '    os.setpgid(pid, pid)\n'
        'except OSError:\n'
        '    pass\n'
        'sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))\n')] + command
def child_setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
child = subprocess.Popen(command, stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer, pass_fds=(slave,), preexec_fn=child_setup)
os.close(slave)
def stop(signum, frame):
    child.send_signal(signum)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
# gated-allow: hold every answer until the test sends SIGUSR1, so a second review is provably queued behind the first.
gate = {'open': False, 'held': []}
def release(signum, frame):
    gate['open'] = True
signal.signal(signal.SIGUSR1, release)
pending = b''
prompts = 0
while child.poll() is None:
    if gate['open'] and gate['held']:
        for answer in gate['held']:
            os.write(master, answer)
        gate['held'] = []
    if not select.select([master], [], [], 0.05)[0]:
        continue
    try:
        chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    os.write(2, chunk)
    pending += chunk
    match = re.search(rb'Decision \[allow/deny/cancel\] ([a-f0-9]{8}): ', pending)
    if match:
        pending = b''
        prompts += 1
        if mode == 'gated-allow':
            gate['held'].append(b'allow ' + match.group(1) + b'\n')
        elif mode == 'stale':
            if prompts == 2:
                os.write(master, b'allow\n')
        elif mode not in ('wait', 'background'):
            os.write(master, mode.encode() + b' ' + match.group(1) + b'\n')
status = child.wait()
os.close(master)
sys.exit(status)
