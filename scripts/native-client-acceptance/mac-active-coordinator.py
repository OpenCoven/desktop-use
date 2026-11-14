#!/usr/bin/env python3
"""Opt-in owned macOS fixture coordinator; no app launch or privacy changes."""
import argparse
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from uuid import uuid4

from mac_owned_processes import DarwinContinuousClock, DarwinProcessTable, OwnedProcessTracker, identity


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_private(path, limit=32 * 1024 * 1024):
    data = Path(path).read_bytes()
    if len(data) > limit:
        raise ValueError('private fixture/proof file exceeds its bound')
    return json.loads(data)


def save_private(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(value, output, separators=(',', ':'))


def case_deadline(remaining_seconds, monotonic_now):
    if not math.isfinite(remaining_seconds) or remaining_seconds <= 100:
        raise ValueError('fresh lease must cover case execution and bounded cleanup')
    # 55 s execution + at most 27 s cleanup + 2 s stdout drain, with slack.
    return monotonic_now + min(55, remaining_seconds - 35)


def cleanup_owned(child, tracker, table, send_signal=os.kill, now=time.monotonic, sleep=time.sleep):
    direct_reaped = False
    known_complete = tracker is not None
    if child is None:
        return {'directConsumerReaped': False, 'knownActorCleanupVerified': False}
    try:
        child.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    # This is our unreaped direct Popen child: its PID cannot transfer before
    # wait. Inspection failure must never prevent its bounded termination/reap.
    try:
        try:
            child.wait(timeout=17)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        try:
            if child.returncode is None:
                child.kill()
                child.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
    direct_reaped = child.returncode is not None
    if tracker is not None:
        try:
            for expected in tracker.remaining_owned():
                current = table.info(expected['pid'])
                if identity(current) != identity(expected):
                    raise ValueError('owned actor changed before cleanup')
                if current['status'] != 5:
                    send_signal(current['pid'], signal.SIGTERM)
            deadline = now() + 2
            while tracker.remaining_owned() and now() < deadline:
                sleep(0.01)
            for expected in tracker.remaining_owned():
                current = table.info(expected['pid'])
                if identity(current) != identity(expected):
                    raise ValueError('owned actor changed before escalation')
                if current['status'] != 5:
                    send_signal(current['pid'], signal.SIGKILL)
            deadline = now() + 2
            while tracker.remaining_owned() and now() < deadline:
                sleep(0.01)
            known_complete = not tracker.remaining_owned()
        except (OSError, ValueError):
            known_complete = False
    return {'directConsumerReaped': direct_reaped,
            'knownActorCleanupVerified': direct_reaped and known_complete}


def main():
    if not __debug__:
        raise RuntimeError('owned-fixture assertions require non-optimized Python')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--surface', choices=['sdk', 'mcp-modern', 'mcp-legacy'], required=True)
    parser.add_argument('--mode', choices=['stop', 'abort', 'timeout'], required=True)
    parser.add_argument('--lease-expires-at', required=True)
    parser.add_argument('--owned-unlocked-fixture', action='store_true')
    args = parser.parse_args()
    assert sys.platform == 'darwin' and args.owned_unlocked_fixture
    assert args.mode != 'abort' or args.surface == 'sdk'
    expires = datetime.fromisoformat(args.lease_expires_at.replace('Z', '+00:00'))
    assert expires.utcoffset() is not None
    case_deadline((expires - datetime.now(timezone.utc)).total_seconds(), time.monotonic())
    root = args.root.resolve(strict=True)
    node = args.node.resolve(strict=True)
    baseline = load_private(root / 'baseline.json')
    assert baseline['controlObservationEnabled'] is True
    scripts = baseline['consumerScriptsSha256']
    for name, expected in scripts.items():
        assert '/' not in name and len(expected) == 64
        assert digest(root / 'consumer' / name) == expected, 'prepared consumer script changed'
    assert digest(__file__) == scripts['mac-active-coordinator.py']
    assert baseline['processAbiChecked'] is True
    adapter, helper = root / 'bin/coven-desktop-use', (root / 'bin/peekaboo').resolve(strict=True)
    fixture_image = (root / 'DesktopUseAcceptance.app/Contents/MacOS/DesktopUseAcceptance').resolve(strict=True)
    assert digest(adapter) == baseline['nativeSha256']
    assert digest(helper) == baseline['helperSha256']
    assert digest(fixture_image) == baseline['fixtureBinarySha256']
    table, clock = DarwinProcessTable(), DarwinContinuousClock()
    first_state = load_private(root / 'fixture-state.json')
    fixture = table.info(first_state['pid'])
    assert fixture and Path(fixture['path']).resolve() == fixture_image
    window = first_state['windowNumber']
    assert window > 0

    def state():
        if identity(table.info(fixture['pid'])) != identity(fixture):
            raise ValueError('owned fixture process identity changed')
        value = load_private(root / 'fixture-state.json')
        now = clock.now_ns()
        assert value['ready'] is True and value['focused'] is True
        assert value['pid'] == fixture['pid'] and value['windowNumber'] == window
        observation = value['controlObservationV1']
        assert observation['clockDomain'] == clock.domain and observation['droppedEvents'] == 0
        published = int(observation['publishedContinuousNs'])
        assert 0 <= now - published <= 1_000_000_000, 'owned fixture observation is stale'
        if identity(table.info(fixture['pid'])) != identity(fixture):
            raise ValueError('owned fixture identity changed during state acquisition')
        return value, str(clock.now_ns())

    state()
    case_id = str(uuid4())
    case_root = root / f'mac-active-{case_id}'
    environment = {'PATH': str(root / 'bin') + os.pathsep + os.environ.get('PATH', ''), 'TMPDIR': str(root),
                   'NATIVE_ACCEPTANCE_ROOT': str(root), 'NATIVE_ACCEPTANCE_ADAPTER': str(adapter),
                   'NATIVE_ACCEPTANCE_FIXTURE_STATE': str(root / 'fixture-state.json'),
                   'NATIVE_ACCEPTANCE_PYTHON': sys.executable,
                   'NATIVE_ACCEPTANCE_PTY': str(root / 'consumer/pty-host.py'),
                   'NATIVE_ACCEPTANCE_IMAGE_PROOF': str(root / 'consumer/image-proof.py'),
                   'NATIVE_ACCEPTANCE_OWNED_MAC_INPUT': 'yes'}
    if os.environ.get('PEEKABOO_CAPTURE_ENGINE'):
        environment['PEEKABOO_CAPTURE_ENGINE'] = os.environ['PEEKABOO_CAPTURE_ENGINE']
    log_path = root / f'mac-active-{case_id}-stderr-private.log'
    child = tracker = None
    selector = selectors.DefaultSelector()
    result = {'schemaVersion': 1, 'success': False, 'surface': args.surface, 'mode': args.mode,
              'harnessSourceCommit': baseline.get('harnessSourceCommit', baseline['sourceCommit']),
              'packageSha256': baseline['packageSha256'], 'nativeSha256': baseline['nativeSha256'],
              'helperSha256': baseline['helperSha256'], 'physicalDisplayVerified': False,
              'independentPixelsVerified': False, 'publication': False}
    failure = None
    input_started = False
    active = target_helper = active_first = None
    input_returned = helper_gone = None
    proof_sent = finished = False
    stream = b''
    def interrupted(number, _frame):
        raise SystemExit(128 + number)
    for number in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
        signal.signal(number, interrupted)
    try:
        log_descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(log_descriptor, 'wb') as private_log:
            launch_clock = clock.now_ns()
            deadline = case_deadline((expires - datetime.now(timezone.utc)).total_seconds(), time.monotonic())
            child = subprocess.Popen([str(node), str(root / 'consumer/mac-active-client.mjs'), args.surface, args.mode, case_id],
                                     cwd=root / 'consumer', env=environment, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=private_log, start_new_session=True)
            node_identity = table.info(child.pid)
            assert node_identity and Path(node_identity['path']).resolve() == node
            tracker = OwnedProcessTracker(table, node_identity)
            selector.register(child.stdout, selectors.EVENT_READ)
            control_baseline = None

            def send(kind, **fields):
                data = json.dumps({'caseId': case_id, 'kind': kind, **fields}, separators=(',', ':')).encode() + b'\n'
                assert len(data) <= 512
                child.stdin.write(data)
                child.stdin.flush()

            def growth(events, previous_length):
                values = []
                for event in events:
                    if event['kind'] == 'text' and event['textUtf16Length'] > previous_length:
                        values.append(event)
                    previous_length = event['textUtf16Length']
                return values

            drain_deadline = None
            while True:
                terminal = child.poll() is not None
                if terminal:
                    if not selector.get_map():
                        break
                    if drain_deadline is None:
                        drain_deadline = time.monotonic() + 2
                    if time.monotonic() >= drain_deadline:
                        raise TimeoutError('terminal consumer stdout did not reach EOF')
                elif time.monotonic() >= deadline or (expires - datetime.now(timezone.utc)).total_seconds() <= 35:
                    raise TimeoutError('case budget expired with cleanup slack reserved')
                # After the active boundary, Stop/Abort/timeout introduce no new
                # native actor. Retain and observe the already bound helper;
                # do not confuse a dying descendant's path race with reaping.
                if not terminal and (active is None or (proof_sent and not finished)):
                    tracker.scan()
                for key, _ in selector.select(timeout=0.002):
                    data = os.read(key.fileobj.fileno(), 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    stream += data
                    if len(stream) > 65536:
                        raise ValueError('consumer control stream exceeds its scalar bound')
                    while b'\n' in stream:
                        line, stream = stream.split(b'\n', 1)
                        if len(line) > 4096:
                            raise ValueError('consumer message exceeds its scalar bound')
                        message = json.loads(line)
                        assert message['schemaVersion'] == 1 and message['caseId'] == case_id
                        kind = message['kind']
                        if kind == 'ready':
                            assert control_baseline is None
                            assert message['fixturePid'] == fixture['pid'] and message['windowNumber'] == window
                            acquired = clock.now_ns()
                            node_clock = int(message['clockNowNs'])
                            assert launch_clock <= node_clock <= acquired, 'Python/Node continuous-clock bracket disagrees'
                            result['clockBridge'] = {'domain': clock.domain, 'beforeNs': str(launch_clock),
                                                     'nodeNs': str(node_clock), 'afterNs': str(acquired),
                                                     'fineOffsetCalibrationClaimed': False}
                            control_baseline, _ = state()
                            send('start')
                        elif kind == 'started':
                            assert control_baseline is not None and not input_started
                            input_started = True
                        elif kind == 'input-settled':
                            assert input_returned is None
                            input_returned = message['inputReturnedNs']
                            assert isinstance(input_returned, str) and input_returned.isdecimal()
                            result['inputReturnedNs'] = input_returned
                            if active is None:
                                raise ValueError('actual continuing-input boundary was not observed before settlement')
                        elif kind == 'stop-acknowledged':
                            result['stopReturnedNs'] = message['stopReturnedNs']
                            result['stopState'] = message['state']
                            result['stopAcknowledgementIsCompletion'] = False
                        elif kind == 'failed':
                            raise ValueError('installed consumer failed; retain private first-failure receipt')
                        elif kind == 'finished':
                            assert proof_sent and message['success'] is True
                            finished = True
                        else:
                            raise ValueError('unexpected consumer protocol message')
                if terminal:
                    continue  # Drain all buffered scalar messages before terminal checks.
                if input_started and active is None and input_returned is None:
                    helpers = [row for row in tracker.live_owned() if Path(row['path']).resolve() == helper and row['status'] in [2, 3]]
                    if len(helpers) > 1:
                        raise ValueError('multiple live prepared helpers make the input boundary ambiguous')
                    if helpers:
                        observed, at = state()
                        events = observed['controlObservationV1']['events']
                        baseline_events = control_baseline['controlObservationV1']['events']
                        typed = growth(events[len(baseline_events):], len(control_baseline['text'].encode('utf-16-le')) // 2)
                        if typed and active_first is None:
                            target_helper = helpers[0]
                            active_first = (observed, at, dict(target_helper))
                        elif active_first is not None:
                            first, first_at, first_helper = active_first
                            if identity(helpers[0]) != identity(first_helper):
                                raise ValueError('observed active helper changed before cancellation')
                            more = growth(events[len(first['controlObservationV1']['events']):], len(first['text'].encode('utf-16-le')) // 2)
                            first_growth = growth(first['controlObservationV1']['events'][len(baseline_events):], len(control_baseline['text'].encode('utf-16-le')) // 2)
                            if more and int(at) - int(first_at) >= 25_000_000 and int(more[-1]['continuousNs']) - int(first_growth[-1]['continuousNs']) >= 25_000_000 and int(more[-1]['continuousNs']) > int(first_at):
                                active = {'baseline': control_baseline, 'first': first, 'second': observed,
                                          'helperFirst': first_helper, 'helperSecond': helpers[0],
                                          'firstObservedNs': first_at, 'secondObservedNs': at,
                                          'pendingFirst': True, 'pendingSecond': True}
                                send('active', observedActiveNs=at)
                if active is not None and helper_gone is None:
                    try:
                        current_helper = table.info(target_helper['pid'])
                    except OSError as error:
                        # A path lookup racing exit is ambiguous, not absence.
                        # Preserve that sample and wait for an actual absent PID.
                        if error.errno != errno.ESRCH:
                            raise
                        result['ambiguousHelperReads'] = result.get('ambiguousHelperReads', 0) + 1
                        current_helper = target_helper
                    if current_helper is None:
                        helper_gone = str(clock.now_ns())
                    elif identity(current_helper) != identity(target_helper):
                        raise ValueError('active helper identity changed before disappearance observation')
                if input_returned is not None and not proof_sent and clock.now_ns() >= int(input_returned) + 1_000_000_000:
                    if helper_gone is None:
                        raise ValueError('actual input helper disappearance was not observed')
                    after, _ = state()
                    save_private(case_root / 'coordinator-proof-private.json', {'active': active, 'after': after, 'helperGoneNs': helper_gone})
                    send('proof-ready')
                    proof_sent = True
            if child.poll() is None:
                raise TimeoutError('owned case or exclusive fixture lease expired')
            assert not stream, 'consumer stdout ended with an incomplete scalar message'
            assert child.returncode == 0 and finished and proof_sent, 'installed consumer did not complete its proof'
            receipt = load_private(case_root / 'client-receipt.json')
            assert receipt['success'] is True
            result['clientReceipt'] = receipt
            result['success'] = True
    except BaseException as error:
        failure = error
        result['failureClass'] = type(error).__name__
        result['failureMessagePrivate'] = str(error)
    finally:
        for number in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
            signal.signal(number, signal.SIG_IGN)
        try:
            selector.close()
        except OSError:
            pass
        cleanup = cleanup_owned(child, tracker, table)
        result.update(cleanup)
        if child is not None:
            try:
                child.stdout.close()
            except OSError:
                pass
        result['unobservedOrphanContainmentClaimed'] = False
        result['success'] = result['success'] and result['knownActorCleanupVerified']
        save_private(root / f'mac-active-{case_id}-coordinator-private.json', result)
    print(json.dumps({'success': result['success'], 'surface': args.surface, 'mode': args.mode,
                      'knownActorCleanupVerified': result['knownActorCleanupVerified']}))
    if failure is not None or not result['success']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
