"""One owned-fixture click cancellation experiment; never run on a shared display."""
from pathlib import Path
import argparse
import ctypes
import datetime
import hashlib
import json
import os
import re
import select
import signal
import subprocess
import sys
import time
from owned_process_guard import install_recovery_handlers, begin_recovery
from owned_trace_stop import OwnedTraceStop, TraceUnavailable


def consumer_fulfillment_ns(consumer):
    if consumer.get('fulfillmentBoundary') != 'supported-api-first-fulfillment':
        return None
    value = consumer.get('resultSettledMonotonicNs')
    return int(value) if isinstance(value,str) and value.isdecimal() and 0 < int(value) < 2**64 else None


def completion_precedes_fulfillment(button_up_ns, helper_gone_ns, fulfillment_ns):
    return all(type(value) is int and value > 0 for value in [button_up_ns,helper_gone_ns,fulfillment_ns]) and button_up_ns < fulfillment_ns and helper_gone_ns < fulfillment_ns


def shared_monotonic_clock_probe():
    if sys.platform != 'linux' or time.get_clock_info('monotonic').implementation != 'clock_gettime(CLOCK_MONOTONIC)':
        raise TraceUnavailable('CLOCK_DOMAIN_UNVERIFIED')
    code = "console.log('ready');process.stdin.once('data',()=>{console.log(JSON.stringify({ns:process.hrtime.bigint().toString(),node:process.version,uv:process.versions.uv}));process.stdin.destroy()})"
    child = subprocess.Popen(['node','-e',code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    def line():
        if not select.select([child.stdout],[],[],2)[0]:
            raise TraceUnavailable('CLOCK_PROBE_TIMEOUT')
        return child.stdout.readline()
    try:
        assert line() == 'ready\n', 'CLOCK_PROBE_NOT_READY'
        before = time.monotonic_ns()
        child.stdin.write('clock\n');child.stdin.flush()
        raw = line()
        after = time.monotonic_ns()
        value = json.loads(raw)
        assert value['ns'].isdecimal() and before <= int(value['ns']) <= after, 'CLOCK_PROBE_OUTSIDE_BRACKET'
        assert child.wait(timeout=2) == 0
        return {'clockDomain':'linux-CLOCK_MONOTONIC','beforeNs':str(before),'nodeNs':value['ns'],'afterNs':str(after),
                'nodeVersion':value['node'],'libuvVersion':value['uv']}
    finally:
        if child.poll() is None:
            child.kill();child.wait(timeout=2)
        for stream in [child.stdin,child.stdout,child.stderr]:
            stream.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ['adapter', 'adapter-sha256', 'fixture-state', 'fixture-script', 'fixture-sha256', 'display', 'lease-expires', 'receipt']:
        parser.add_argument('--' + field, required=True)
    parser.add_argument('--trace-owned-helper', action='store_true')
    parser.add_argument('--consumer')
    parser.add_argument('--surface', choices=['sdk','mcp-modern','mcp-legacy'])
    parser.add_argument('--mode', choices=['stop','abort','timeout'])
    parser.add_argument('--pty-host')
    parser.add_argument('--package-tarball')
    parser.add_argument('--package-sha256')
    parser.add_argument('--fixture-title')
    parser.add_argument('--fixture-pid', type=int, required=True)
    parser.add_argument('--server-pid', type=int, required=True)
    parser.add_argument('--fixture-window', type=int, required=True)
    args = parser.parse_args()
    if not args.trace_owned_helper:
        parser.error('cancellation requires --trace-owned-helper')
    assert sys.platform == 'linux' and os.environ.get('NATIVE_OWNED_DISPOSABLE_DISPLAY') == 'yes'
    lease = datetime.datetime.fromisoformat(args.lease_expires.replace('Z', '+00:00')).timestamp()
    assert time.time() + 30 < lease < time.time() + 1200
    for path in [args.adapter, args.fixture_state, args.fixture_script, args.receipt]:
        assert Path(path).is_absolute()
    assert not Path(args.receipt).exists()
    assert hashlib.sha256(Path(args.adapter).read_bytes()).hexdigest() == args.adapter_sha256
    if args.consumer:
        assert args.surface and args.mode and args.pty_host and args.package_tarball and args.package_sha256 and args.fixture_title
        assert args.surface == 'sdk' or args.mode != 'abort'
        assert all(Path(value).is_absolute() for value in [args.consumer,args.pty_host,args.package_tarball])
        assert hashlib.sha256(Path(args.package_tarball).read_bytes()).hexdigest() == args.package_sha256
    assert hashlib.sha256(Path(args.fixture_script).read_bytes()).hexdigest() == args.fixture_sha256
    env = {**os.environ, 'DISPLAY': args.display, 'XDG_SESSION_TYPE': 'x11'}

    def identity(pid):
        root = Path('/proc') / str(pid)
        try:
            fields = (root/'stat').read_text().rsplit(')', 1)[1].split()
            return {'start': fields[19], 'argv': (root/'cmdline').read_bytes().split(b'\0')[:-1]}
        except (FileNotFoundError, ProcessLookupError):
            return None

    def descendants(pid):
        try:
            children = [int(value) for value in Path(f'/proc/{pid}/task/{pid}/children').read_text().split()]
        except (FileNotFoundError, ProcessLookupError):
            return []
        return children + [child for parent in children for child in descendants(parent)]

    server = identity(args.server_pid); fixture_process = identity(args.fixture_pid)
    assert server and server['argv'] == [b'Xvfb', args.display.encode(), b'-screen', b'0', b'1280x960x24', b'-nolisten', b'tcp']
    assert fixture_process and fixture_process['argv'][1] == args.fixture_script.encode()
    assert b'--state' in fixture_process['argv'] and fixture_process['argv'][fixture_process['argv'].index(b'--state')+1] == args.fixture_state.encode()

    def fixture():
        assert time.time() < lease
        assert identity(args.server_pid) == server and identity(args.fixture_pid) == fixture_process
        state = json.loads(Path(args.fixture_state).read_text())
        assert state['ready'] and state['pid'] == args.fixture_pid
        return state

    state = fixture(); origin = state['origin']; size = state['size']
    assert len(origin) == len(size) == 2 and all(isinstance(x, int) for x in origin + size)
    assert size[0] >= 140 and size[1] >= 100
    point = (origin[0] + 80, origin[1] + 60)
    assert 0 <= origin[0] and 0 <= origin[1] and origin[0] + size[0] <= 1280 and origin[1] + size[1] <= 960

    def verify_window():
        active = subprocess.check_output(['xdotool','getactivewindow'], env=env, timeout=2).strip()
        assert active == str(args.fixture_window).encode()
        assert subprocess.check_output(['xdotool','getwindowpid',str(args.fixture_window)], env=env, timeout=2).strip() == str(args.fixture_pid).encode()
        if args.consumer:
            assert subprocess.check_output(['xdotool','getwindowname',str(args.fixture_window)], env=env, timeout=2).strip() == args.fixture_title.encode()
        geometry = subprocess.check_output(['xwininfo','-id',str(args.fixture_window)], env=env, timeout=2).decode()
        def field(name):
            match = re.search(r'^\s*' + re.escape(name) + r':\s*(-?\d+)\s*$', geometry, re.M)
            assert match is not None
            return int(match[1])
        assert [field('Absolute upper-left X'),field('Absolute upper-left Y')] == origin
        assert [field('Width'),field('Height')] == size and field('Border width') == 0

    verify_window()
    install_recovery_handlers()
    x11 = ctypes.CDLL('libX11.so.6'); xtst = ctypes.CDLL('libXtst.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]; x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]; x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x11.XOpenDisplay(args.display.encode()); assert display
    root_window = x11.XDefaultRootWindow(display)

    def pointer():
        root = ctypes.c_ulong(); child = ctypes.c_ulong(); rx = ctypes.c_int(); ry = ctypes.c_int(); wx = ctypes.c_int(); wy = ctypes.c_int(); mask = ctypes.c_uint()
        assert x11.XQueryPointer(display, root_window, ctypes.byref(root), ctypes.byref(child), ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
        return {'x': rx.value, 'y': ry.value, 'buttons': (mask.value >> 8) & 31}

    original = pointer(); assert original['buttons'] == 0
    report = {'schemaVersion': 1, 'session': 'owned-virtual-X11', 'physicalDisplayVerified': False, 'decisionSource': 'explicit-fixture-owner-click-test', 'adapterSha256': args.adapter_sha256, 'fixtureSha256': args.fixture_sha256, 'actualHeldButtonObserved': False, 'qualified': False, 'defectObserved': False}
    current = None; helpers = {}; held = None; cancelled_at = None; spawn_attempted = False; observer = None
    report['controlledSchedulingFaultInjection'] = args.trace_owned_helper
    report['tracingPermissionsChanged'] = False
    report['surface'] = args.surface if args.consumer else 'cli'
    report['mode'] = args.mode if args.consumer else 'sigterm'
    if args.consumer: report['packageSha256'] = args.package_sha256
    consumer_workspace = Path(args.consumer).parent / ('pointer-run-' + str(time.monotonic_ns())) if args.consumer else None

    def lease_budget(limit):
        remaining = lease - time.time() - 15
        if remaining <= 0:
            report['leaseCancellationBeforeExpiry'] = True
            raise TimeoutError('POINTER_PROBE_LEASE_WINDOW')
        return min(limit, remaining)

    def lease_cancelled(_number, _frame):
        report['leaseCancellationBeforeExpiry'] = True
        raise TimeoutError('POINTER_PROBE_LEASE_WINDOW')

    try:
        # Capture only the existing owned target; do not change keyboard state.
        assert fixture()['origin'] == origin
        verify_window()
        assert time.time() + 30 < lease, 'Fresh lease margin required immediately before input'
        signal.signal(signal.SIGALRM, lease_cancelled)
        signal.setitimer(signal.ITIMER_REAL, lease_budget(1200))
        if args.consumer:
            report['sharedMonotonicClock'] = shared_monotonic_clock_probe()
        spawn_attempted = True
        command = (['node',args.consumer,args.surface,args.mode,str(consumer_workspace),args.adapter,args.adapter_sha256,
                    args.fixture_state,str(args.fixture_pid),args.fixture_title,args.pty_host,str(point[0]),str(point[1])]
                   if args.consumer else [args.adapter,'click','--coords',f'{point[0]},{point[1]}','--double','--confirm','--timeout-ms','3000'])
        current = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        end = time.monotonic() + (12 if args.consumer else 2)
        while time.monotonic() < end and current.poll() is None:
            lease_budget(2)
            for pid in descendants(current.pid):
                born = identity(pid)
                if not born or not born['argv'] or Path(os.fsdecode(born['argv'][0])).name != 'xdotool':
                    continue
                expected_click = [b'mousemove',b'--',str(point[0]).encode(),str(point[1]).encode(),b'click',b'--repeat',b'2',b'1']
                if born['argv'][1:] != expected_click:
                    continue
                helpers[pid] = born['start']
                if args.trace_owned_helper:
                    parent_pid = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[1])
                    parent = identity(parent_pid)
                    assert parent is not None and Path(os.fsdecode(parent['argv'][0])).resolve() == Path(args.adapter).resolve()
                    observer = OwnedTraceStop(pid=pid, expected_start=born['start'], parent=(parent_pid,parent['start']),
                                              executable=str(Path('/usr/bin/xdotool').resolve()), deadline=min(end,time.monotonic()+2))
                    try:
                        observer.hold_when(lambda: bool(pointer()['buttons'] & 1))
                    except TraceUnavailable as error:
                        allowed = ['TRACE_OPERATION_REFUSED','TRACE_BOUNDARY_TIMEOUT','TRACE_EXITED','TRACE_IDENTITY_LOST',
                                   'TRACE_OTHER_TRACER','TRACE_NOT_SINGLE_THREADED','TRACE_DETACHED_STOP_UNVERIFIED',
                                   'TRACE_UNEXPECTED_GROUP_STOP','TRACE_SIGNAL_INFO_UNAVAILABLE','TRACE_SIGNAL_INFO_INVALID',
                                   'TRACE_EXECUTABLE_CHANGED','TRACE_NOT_OWNED_DESCENDANT','TRACE_ALREADY_ACTIVE']
                        report['traceFailureCode'] = error.args[0] if error.args and error.args[0] in allowed else 'TRACE_UNQUALIFIED'
                        raise
                    assert observer.detached_stopped() and pointer()['buttons'] & 1
                    time.sleep(.025)
                    assert identity(pid) == born and observer.detached_stopped() and pointer()['buttons'] & 1
                    report['helperDetachedBeforeCancellation'] = True
                    held = pid
                    break
            if held: break
            time.sleep(.001)
        if held:
            report['actualHeldButtonObserved'] = True; report['heldBoundaryStableMs'] = 25
            cancelled_at = time.monotonic_ns()
            if args.consumer:
                consumer_workspace.joinpath('held-button-observed').write_text('ready')
            else:
                current.send_signal(signal.SIGTERM)
        button_up_ns = helper_gone_ns = None
        if args.consumer and held:
            observe_end = time.monotonic() + lease_budget(15)
            samples = 0
            while time.monotonic() < observe_end:
                samples += 1
                buttons = pointer()['buttons']
                sampled = time.monotonic_ns()
                if not buttons & 1 and button_up_ns is None:
                    button_up_ns = sampled
                gone = identity(held) is None
                sampled = time.monotonic_ns()
                if gone and helper_gone_ns is None:
                    helper_gone_ns = sampled
                if button_up_ns is not None and helper_gone_ns is not None or current.poll() is not None:
                    break
                time.sleep(.0002)
            report['completionObservationSamples'] = samples
        stdout, stderr = current.communicate(timeout=lease_budget(15 if args.consumer else 5))
        report['consumerExitCode' if args.consumer else 'nativeExitCode'] = current.returncode
        try:
            if args.consumer:
                assert current.returncode == 0 and not stdout and not stderr, 'POINTER_CONSUMER_FAILED'
                consumer = json.loads(consumer_workspace.joinpath('consumer-receipt.json').read_text())
                assert consumer['surface'] == args.surface and consumer['mode'] == args.mode
                native = {'ok':consumer['nativeOk'],'code':consumer['nativeCode'],'inputCleanup':consumer['inputCleanup'],
                          'inputMayHaveStarted':consumer['inputMayHaveStarted']}
                report['consumerSettledMonotonicMs'] = consumer['resultSettledMonotonicMs']
                fulfillment = consumer_fulfillment_ns(consumer)
                assert fulfillment is not None, 'RAW_API_FULFILLMENT_BOUNDARY_REQUIRED'
                report['consumerSettledMonotonicNs'] = str(fulfillment)
                report['fulfillmentBoundary'] = consumer['fulfillmentBoundary']
                report['buttonUpObservedMonotonicNs'] = str(button_up_ns) if button_up_ns is not None else None
                report['helperGoneObservedMonotonicNs'] = str(helper_gone_ns) if helper_gone_ns is not None else None
                report['cleanupObservedBeforeFulfillment'] = completion_precedes_fulfillment(button_up_ns,helper_gone_ns,int(fulfillment))
            else:
                native = json.loads(stdout)
            report['cancelledReported'] = native.get('code') == 'CANCELLED'
            report['interruptedReported'] = native.get('code') == ('ETIMEDOUT' if args.consumer and args.mode == 'timeout' else 'CANCELLED')
            cleanup = native.get('inputCleanup', {})
            report['safeNativeOutcome'] = {
                'ok': native.get('ok') if type(native.get('ok')) is bool else None,
                'code': native.get('code') if native.get('code') in ['CANCELLED','ETIMEDOUT','PROCESS_ERROR','BACKEND_ERROR','COORDINATES_OUT_OF_RANGE','X11_CLEANUP_FAILED'] else 'OTHER_OR_ABSENT',
                'inputMayHaveStarted': native.get('inputMayHaveStarted') if type(native.get('inputMayHaveStarted')) is bool else None,
                'cleanupState': cleanup.get('state') if isinstance(cleanup,dict) and cleanup.get('state') in ['verified','unverified','not-needed'] else None,
                'releasedButtons': cleanup.get('releasedButtons') if isinstance(cleanup,dict) and type(cleanup.get('releasedButtons')) is int and 0 <= cleanup['releasedButtons'] <= 5 else None,
                'helperSightings': len(helpers)}
        except (ValueError, AttributeError, TypeError): report['cancelledReported'] = False
        if held:
            report['settlementMs'] = (time.monotonic_ns() - cancelled_at) // 1_000_000
            time.sleep(.1)
            report['buttonHeldAfterSettlement'] = bool(pointer()['buttons'] & 1)
            report['helperReaped'] = identity(held) is None
            cleanup_proved = report.get('safeNativeOutcome', {}).get('cleanupState') == 'verified' and report.get('safeNativeOutcome', {}).get('releasedButtons') == 1
            if args.consumer:
                cleanup_proved = cleanup_proved and report.get('cleanupObservedBeforeFulfillment') is True
            report['qualified'] = report['helperReaped'] and not report['buttonHeldAfterSettlement'] and report['interruptedReported'] and cleanup_proved
            report['defectObserved'] = report['helperReaped'] and report['buttonHeldAfterSettlement']
        else:
            report['unqualifiedReason'] = 'ACTUAL_HELD_BUTTON_NOT_OBSERVED'
        # Do not persist raw native output or a fixture input payload.
        report['nativeOutputBytes'] = len(stdout) + len(stderr)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, signal.SIG_IGN)
        for number in [signal.SIGTERM, signal.SIGINT]: signal.signal(number, signal.SIG_IGN)
        contained = True
        try:
            if current and current.poll() is None:
                current.send_signal(signal.SIGTERM)
            if observer is not None:
                observer.close()
            if current and current.poll() is None:
                try: current.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    current.kill(); current.communicate(timeout=2)
        except BaseException:
            report['nativeSettlementFailed'] = True; report['qualified'] = False
        finally:
            try: begin_recovery()
            except BaseException: contained = False; report['qualified'] = False
            finally:
                try:
                    if contained and identity(args.server_pid) == server:
                        now = pointer()
                        if spawn_attempted and now['buttons'] & 1:
                            assert xtst.XTestFakeButtonEvent(display, 1, 0, 0)
                            x11.XSync(display, 0)
                        now = pointer()
                        if (now['x'], now['y']) == point:
                            x11.XWarpPointer(display, 0, root_window, 0, 0, 0, 0, original['x'], original['y']); x11.XSync(display, 0)
                        report['recovery'] = {'buttonReleased': not bool(pointer()['buttons'] & 1), 'ownedHelpersGone': all(identity(pid) is None for pid in helpers), 'nativeSettled': current is None or current.poll() is not None, 'ownedContainmentComplete': True}
                    else:
                        report['recovery'] = {'serverIdentityLost': identity(args.server_pid) != server, 'ownedContainmentComplete': contained}
                        report['qualified'] = False
                except BaseException:
                    report['qualified'] = False
                    report['recovery'] = {'ownedContainmentComplete': contained, 'inputRecoveryFailed': True}
                finally:
                    try: x11.XCloseDisplay(display)
                    finally:
                        with Path(args.receipt).open('x') as file:
                            os.chmod(args.receipt, 0o600); json.dump(report, file, indent=2); file.write('\n')
    print(json.dumps({key: report[key] for key in ['actualHeldButtonObserved','qualified','defectObserved','recovery']}))
    return 0 if report['qualified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
