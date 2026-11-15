#!/usr/bin/env python3
"""Real packed-client Stop tests; reuse only an explicitly leased disposable X11 display."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from owned_process_guard import install_recovery_handlers, begin_recovery
from x11_state import clock_bounds, clock_delta, unproven_post_settlement_events


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("consumer", "adapter", "native-sha256", "fixture-state", "fixture-title", "display", "pty-host", "receipt", "lease-expires"):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--fixture-pid', type=int, required=True)
    parser.add_argument('--server-pid', type=int, required=True)
    args = parser.parse_args()
    install_recovery_handlers()
    from datetime import datetime, timezone
    assert datetime.now(timezone.utc).timestamp() + 120 < datetime.fromisoformat(args.lease_expires.replace('Z', '+00:00')).timestamp()
    assert hashlib.sha256(Path(args.adapter).read_bytes()).hexdigest() == args.native_sha256
    server = Path(f'/proc/{args.server_pid}')
    assert server.joinpath('cmdline').read_bytes().split(b'\0')[:-1] == [b'Xvfb', args.display.encode(), b'-screen', b'0', b'1280x960x24', b'-nolisten', b'tcp']
    server_birth = server.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19]
    def fixture():
        value = json.loads(Path(args.fixture_state).read_text())
        assert value['pid'] == args.fixture_pid and value['ready']
        return value
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]; x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(args.display.encode()); assert display
    offset_lower, offset_upper = clock_bounds(x11, display)
    def keys():
        value = ctypes.create_string_buffer(32); assert x11.XQueryKeymap(display, value)
        return {key for key in range(256) if value.raw[key // 8] & (1 << (key % 8))}
    def identity(pid):
        try:
            path = Path(f'/proc/{pid}')
            return path.joinpath('comm').read_text().strip(), path.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19]
        except (FileNotFoundError, ProcessLookupError):
            return None
    def descendants(pid):
        try:
            children = [int(value) for value in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
        except (FileNotFoundError, ProcessLookupError):
            return []
        return children + [child for parent in children for child in descendants(parent)]
    assert not keys()
    fixture()
    env = {**os.environ, 'DISPLAY': args.display, 'XDG_SESSION_TYPE': 'x11', 'NATIVE_OWNED_DISPOSABLE_DISPLAY': 'yes'}
    root = Path(args.consumer).parent
    run_root = root / ('native-run-' + str(time.monotonic_ns())); run_root.mkdir(mode=0o700)
    receipt = {'session': 'owned-virtual-x11', 'physicalDisplayVerified': False, 'nativeSha256': args.native_sha256,
               'clockCalibrationMs': {'lower': offset_lower, 'upper': offset_upper}, 'serverStartTicks': server_birth, 'cases': []}
    current = None
    owned_helpers = set()
    try:
        for surface, mode in [('sdk', 'stop'), ('sdk', 'abort'), ('sdk', 'timeout'), ('mcp-modern', 'stop'), ('mcp-modern', 'timeout'), ('mcp-legacy', 'stop'), ('mcp-legacy', 'timeout')]:
            workspace = run_root / (surface + '-' + mode)
            current = subprocess.Popen(['node', args.consumer, surface, mode, str(workspace), args.adapter, args.native_sha256,
                                        args.fixture_state, str(args.fixture_pid), args.fixture_title, args.pty_host], env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            end = time.monotonic() + 12
            held = None
            while time.monotonic() < end and current.poll() is None:
                if workspace.joinpath('input-started').exists():
                    for pid in descendants(current.pid):
                        birth = identity(pid)
                        if birth and birth[0] == 'xdotool' and 38 in keys():
                            try:
                                os.kill(pid, signal.SIGSTOP)
                            except ProcessLookupError:
                                continue
                            if 38 in keys():
                                time.sleep(.025)
                                if identity(pid) == birth and 38 in keys():
                                    held = (pid, birth); owned_helpers.add(held); break
                            if identity(pid) == birth:
                                os.kill(pid, signal.SIGCONT)
                if held:
                    workspace.joinpath('held-key-observed').write_text('ready')
                    break
                time.sleep(.001)
            assert held, 'real held-key boundary not observed'
            out, err = current.communicate(timeout=15)
            assert current.returncode == 0, 'packed consumer assertion failed: ' + err.decode()[-1000:]
            assert not out and not err
            assert not Path(f'/proc/{held[0]}').exists(), 'input helper was not reaped'
            assert not keys(), 'key remained held after packed consumer settlement'
            result = json.loads(workspace.joinpath('consumer-receipt.json').read_text())
            settled = len(fixture()['keys']); time.sleep(.75)
            events = fixture()['keys']
            returned_ms = result['resultSettledMonotonicMs']
            action_events = events[result['eventCursorBeforeInput']:]
            late_events = events[settled:]
            queued = sum(clock_delta(event['serverTimeMs'], returned_ms) < offset_lower for event in late_events)
            post_settlement = unproven_post_settlement_events(events, result['eventCursorBeforeInput'], returned_ms, offset_lower)
            result.update({'actualHeldKeyObserved': True, 'helperReaped': True, 'keyStateRestored': True,
                           'heldBoundaryStableMs': 25,
                           'queuedPreReturnEventsDeliveredLater': queued,
                           'postReturnGeneratedOrAmbiguousEvents': post_settlement, 'allInputEventsClassified': len(action_events)})
            receipt['cases'].append(result)
            assert result['postReturnGeneratedOrAmbiguousEvents'] == 0
        receipt['success'] = True
    finally:
        if server.exists() and server.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19] == server_birth:
            os.kill(args.server_pid, signal.SIGCONT)
        begin_recovery()
        if current and current.poll() is None:
            os.kill(current.pid, signal.SIGTERM)
            try:
                current.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(current.pid, signal.SIGKILL); current.communicate(timeout=2)
        for pid, birth in owned_helpers:
            if identity(pid) == birth:
                os.kill(pid, signal.SIGKILL)
        remaining = keys()
        assert remaining <= {38}, 'unrelated state is outside recovery authority'
        if 38 in remaining:
            subprocess.run(['/usr/bin/xdotool', 'keyup', '38'], env=env, check=True, timeout=3)
        receipt['recovery'] = {'keyStateRestored': not keys(), 'ownedConsumerSettled': current is None or current.poll() is not None}
        x11.XCloseDisplay(display)
        Path(args.receipt).write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'success': receipt['success'], 'cases': len(receipt['cases']), 'recovery': receipt['recovery']}))


if __name__ == '__main__':
    main()
