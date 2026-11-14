"""Disposable PTY operator: drives the real reference UI, never an approval provider stub."""
import re, errno, fcntl, os, pty, select, signal, subprocess, sys, termios
if sys.argv[1] == 'no-tty':
    child = subprocess.Popen(sys.argv[2:], stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer, start_new_session=True)
    signal.signal(signal.SIGTERM, lambda signum, frame: child.send_signal(signum))
    signal.signal(signal.SIGINT, lambda signum, frame: child.send_signal(signum))
    sys.exit(child.wait())
master, slave = pty.openpty()
mode = sys.argv[1]
def child_setup():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
child = subprocess.Popen(sys.argv[2:], stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer, pass_fds=(slave,), preexec_fn=child_setup)
os.close(slave)
def stop(signum, frame):
    child.send_signal(signum)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
pending = b''
prompts = 0
while child.poll() is None:
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
        if mode == 'stale':
            if prompts == 2:
                os.write(master, b'allow\n')
        elif mode != 'wait':
            os.write(master, mode.encode() + b' ' + match.group(1) + b'\n')
status = child.wait()
os.close(master)
sys.exit(status)
