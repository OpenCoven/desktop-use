#!/usr/bin/env python3
"""Bounded display faults and parent EOF on an exclusively leased Xvfb."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from owned_process_guard import install_recovery_handlers, begin_recovery


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('adapter', 'native-sha256', 'display', 'fixture-state', 'receipt', 'lease-expires'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--server-pid', type=int, required=True)
    p.add_argument('--fixture-pid', type=int, required=True)
    a = p.parse_args()
    install_recovery_handlers()
    from datetime import datetime, timezone
    assert datetime.now(timezone.utc).timestamp() + 60 < datetime.fromisoformat(a.lease_expires.replace('Z', '+00:00')).timestamp()
    assert hashlib.sha256(Path(a.adapter).read_bytes()).hexdigest() == a.native_sha256
    def identity(pid):
        try:
            root = Path(f'/proc/{pid}')
            return root.joinpath('cmdline').read_bytes(), root.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19]
        except (FileNotFoundError, ProcessLookupError):
            return None
    server_identity = identity(a.server_pid)
    assert server_identity and server_identity[0].split(b'\0')[:-1] == [b'Xvfb', a.display.encode(), b'-screen', b'0', b'1280x960x24', b'-nolisten', b'tcp']
    def server_signal(sig):
        assert identity(a.server_pid) == server_identity
        os.kill(a.server_pid, sig)
    env = {**os.environ, 'DISPLAY': a.display, 'XDG_SESSION_TYPE': 'x11'}
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]; x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(a.display.encode()); assert display
    def keys():
        value = ctypes.create_string_buffer(32); assert x11.XQueryKeymap(display, value)
        return {key for key in range(256) if value.raw[key // 8] & (1 << (key % 8))}
    def children(pid):
        try:
            return [int(v) for v in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
        except (FileNotFoundError, ProcessLookupError):
            return []
    def reap(pid, timeout=2):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                if os.waitpid(pid, os.WNOHANG)[0] == pid:
                    return True
            except ChildProcessError:
                return not Path(f'/proc/{pid}').exists()
            time.sleep(.002)
        return False
    # Adopt only this test's orphaned descendants for its deliberate parent-crash case.
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    def auto_resume(seconds):
        # Independent recovery also runs if this coordinator is interrupted.
        code = ('import os,signal,time;from pathlib import Path;time.sleep(' + repr(seconds) + ');'
                + 'p=Path(' + repr(f'/proc/{a.server_pid}') + ');'
                + 'actual=(p.joinpath("cmdline").read_bytes(),p.joinpath("stat").read_text().rsplit(")",1)[1].split()[19]);'
                + 'assert actual==' + repr(server_identity) + ';os.kill(' + str(a.server_pid) + ',signal.SIGCONT)')
        return subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    assert not keys()
    fixture = json.loads(Path(a.fixture_state).read_text()); assert fixture['pid'] == a.fixture_pid and fixture['ready']
    rows = []
    receipt = {'session': 'owned-virtual-x11', 'physicalDisplayVerified': False, 'nativeSha256': a.native_sha256, 'cases': rows}
    proc = None
    owned = {}
    resumers = []
    try:
        for mode in ('blocked-readiness', 'blocked-cleanup', 'parent-EOF', 'parent-EOF-blocked', 'parent-EOF-probe'):
            assert not keys()
            if mode in ('blocked-readiness', 'parent-EOF-probe'):
                resumers.append(auto_resume(1.7))
                server_signal(signal.SIGSTOP)
            action_started = time.monotonic()
            proc = subprocess.Popen([a.adapter, 'type-text', '--text', 'a' * 4000, '--timeout-ms',
                                     '1000' if mode == 'blocked-readiness' else '15000', '--confirm'],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            deadline = time.monotonic() + 6
            held = None
            guard = None
            while time.monotonic() < deadline and proc.poll() is None:
                for pid in children(proc.pid):
                    birth = identity(pid)
                    if not birth:
                        continue
                    owned[pid] = birth
                    executable = birth[0].split(b'\0')[0]
                    if executable == os.fsencode(a.adapter):
                        guard = pid
                    elif executable in (b'/usr/bin/xdotool', b'xdotool') and mode != 'blocked-readiness' and 38 in keys():
                        try:
                            os.kill(pid, signal.SIGSTOP)
                        except ProcessLookupError:
                            continue
                        if 38 in keys():
                            held = pid
                            break
                        os.kill(pid, signal.SIGCONT)
                if held or mode == 'parent-EOF-probe' and guard or mode == 'blocked-readiness' and proc.poll() is not None:
                    break
                time.sleep(.001)
            assert guard, 'actual guard process not observed'
            started = time.monotonic()
            if mode == 'parent-EOF-probe':
                os.kill(proc.pid, signal.SIGKILL)
            elif mode != 'blocked-readiness':
                assert held, 'actual held helper key not observed'
                if mode in ('blocked-cleanup', 'parent-EOF-blocked'):
                    resumers.append(auto_resume(1))
                    server_signal(signal.SIGSTOP)
                    if mode == 'parent-EOF-blocked':
                        # Keep it blocked in the actual Xlib call rather than
                        # stopped: orphaned stopped groups receive HUP/CONT.
                        os.kill(held, signal.SIGCONT)
                        time.sleep(.02)
                        os.kill(proc.pid, signal.SIGKILL)
                    else:
                        os.kill(proc.pid, signal.SIGTERM)
                else:
                    os.kill(proc.pid, signal.SIGKILL)
            out, err = proc.communicate(timeout=3)
            assert not err
            if mode.startswith('parent-EOF'):
                if held:
                    assert reap(held, timeout=.5), 'orphaned input helper survived parent death'
                assert reap(guard, timeout=.5), 'orphaned guard did not terminate after EOF'
                if mode == 'parent-EOF':
                    assert not keys(), 'EOF guard did not release the intended held key'
                rows.append({'case': mode, 'guardReapedByTestSubreaper': True, 'keyStateRestoredWithoutManualRecovery': mode == 'parent-EOF',
                             'inputHelperNeedsManualCrashRecovery': False, 'helperReapedByTestSubreaper': True,
                             'actualInputHelperStarted': held is not None, 'inputStateRequiresServerRecovery': mode in ('parent-EOF-blocked', 'parent-EOF-probe'), 'passed': True})
            else:
                elapsed = time.monotonic() - started
                result = json.loads(out)
                assert result['code'] == ('ETIMEDOUT' if mode == 'blocked-readiness' else 'CANCELLED')
                assert result['inputCleanup']['state'] == 'unverified'
                assert not Path(f'/proc/{guard}').exists()
                assert not held or not Path(f'/proc/{held}').exists()
                if mode == 'blocked-cleanup':
                    assert elapsed < .5, 'cleanup exceeded the unchanged outer escalation grace'
                rows.append({'case': mode, 'code': result['code'], 'inputCleanup': result['inputCleanup'],
                             'guardReaped': True, 'settlementMsAfterTrigger': round(elapsed * 1000),
                             'wholeActionMs': round((time.monotonic() - action_started) * 1000), 'passed': True})
            server_signal(signal.SIGCONT)
            for resumer in resumers:
                assert resumer.wait(timeout=3) == 0
            for pid, birth in list(owned.items()):
                if identity(pid) == birth:
                    os.kill(pid, signal.SIGKILL)
                    assert reap(pid)
            remaining = keys()
            assert remaining <= {38}
            if remaining:
                subprocess.run(['/usr/bin/xdotool', 'keyup', '38'], env=env, check=True, timeout=3)
            assert not keys()
        receipt['success'] = True
    finally:
        server_signal(signal.SIGCONT)
        begin_recovery()
        if proc and proc.poll() is None:
            os.kill(proc.pid, signal.SIGTERM)
            try:
                proc.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL); proc.communicate(timeout=2)
        for pid, birth in owned.items():
            if identity(pid) == birth:
                os.kill(pid, signal.SIGKILL); reap(pid)
        for resumer in resumers:
            resumer.wait(timeout=3)
        remaining = keys(); assert remaining <= {38}
        if remaining:
            subprocess.run(['/usr/bin/xdotool', 'keyup', '38'], env=env, check=True, timeout=3)
        receipt['recovery'] = {'keyStateRestored': not keys(), 'serverResumed': True}
        x11.XCloseDisplay(display)
        Path(a.receipt).write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
