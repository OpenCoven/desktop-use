#!/usr/bin/env python3
"""Read-only preflight by default; opt in to one owned software Wayland matrix."""
import argparse
import ctypes
import datetime
import hashlib
import itertools
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import uuid

HERE = Path(__file__).resolve().parent
RUNTIME_FILES = ('wayland-client.mjs', 'wayland-owned-snapshot.mjs',
                 'wayland-peer-observer.py', 'wayland-scope-proof.mjs',
                 'wayland-run-contract.mjs', 'linux-scope-proof.mjs', 'identity-preflight.mjs',
                 'linux-image-proof.py')
TOOLS = ('sway', 'swaymsg', 'grim', 'wtype', 'wayland-info', 'node', 'python3')
MAX_OWNED_CHILDREN, TERM_WAIT, KILL_WAIT, DESCENDANT_WAIT = 4, 2, 2, 15
CLEANUP_RESERVE = 45
PUBLIC_SOURCE_FILES = tuple('scripts/native-client-acceptance/' + name for name in (*RUNTIME_FILES, 'wayland-operator.py')) + ('scripts/native-image-fixture/fixture.py', 'src/mcp/fixtures/pty-host.py')


def require(condition, code):
    if not condition:
        raise ValueError(code)


def contained(root, path):
    return root != path and root in path.parents


def digest(path, limit=256 * 1024 * 1024):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'REGULAR_BOUNDED_ARTIFACT_REQUIRED')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        current = os.fstat(descriptor)
        require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino), 'ARTIFACT_CHANGED_DURING_OPEN')
        value, count = hashlib.sha256(), 0
        while True:
            block = os.read(descriptor, min(65536, limit + 1 - count))
            if not block:
                return value.hexdigest()
            count += len(block)
            require(count <= limit, 'ARTIFACT_BYTE_LIMIT_EXCEEDED')
            value.update(block)
    finally:
        os.close(descriptor)


def bound_file(path, expected):
    require(isinstance(expected, str) and re.fullmatch('[a-f0-9]{64}', expected), 'EXPLICIT_ARTIFACT_HASH_REQUIRED')
    require(path.is_absolute() and digest(path) == expected, 'PREPARED_ARTIFACT_CHANGED')
    return {'path': str(path), 'sha256': expected}


def copy_bound_source(source, destination, expected):
    shutil.copyfile(source, destination)
    return bound_file(destination, expected)


def archive_inventory(path):
    result, total = {}, 0
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            parts = PurePosixPath(member.name).parts
            require(parts and parts[0] == 'package' and '..' not in parts, 'UNSAFE_PACKAGE_ARCHIVE_PATH')
            if member.isdir():
                continue
            require(member.isfile() and len(parts) > 1, 'REGULAR_PACKAGE_ARCHIVE_FILES_REQUIRED')
            name = '/'.join(parts[1:])
            total += member.size
            require(name not in result and len(result) < 5000 and 0 <= member.size <= 16 * 1024 * 1024 and total <= 128 * 1024 * 1024, 'PACKAGE_ARCHIVE_LIMIT_EXCEEDED')
            value = hashlib.sha256()
            with archive.extractfile(member) as source:
                while True:
                    block = source.read(65536)
                    if not block:
                        break
                    value.update(block)
            result[name] = value.hexdigest()
    return result


def helper_search_path(tools):
    directories = list(dict.fromkeys(str(Path(tools[name]['path']).parent) for name in TOOLS))
    # At most seven declared directories: cache lookups before the bounded search.
    candidates = {}
    for name in TOOLS:
        candidates[name] = {}
        for directory in directories:
            selected = shutil.which(name, path=directory)
            candidates[name][directory] = str(Path(selected).resolve()) if selected else None
    for ordered in itertools.permutations(directories):
        if all(next((candidates[name][directory] for directory in ordered if candidates[name][directory]), None) == tools[name]['path'] for name in TOOLS):
            return ':'.join(ordered)
    raise ValueError('HELPER_PATH_SELECTION_CHANGED')


def prepared_descriptor(value):
    require(value.get('schemaVersion') == 1, 'PREPARED_SCHEMA_REQUIRED')
    for key in ('sourceCommit', 'sourceTree', 'harnessCommit', 'harnessTree'):
        require(isinstance(value.get(key), str) and re.fullmatch('[a-f0-9]{40}', value[key]), 'EXPLICIT_SOURCE_IDENTITY_REQUIRED')
    consumer, package = (Path(value[key]).resolve(strict=True) for key in ('consumerRoot', 'packageRoot'))
    require(contained(consumer, package), 'PACKAGE_OUTSIDE_DISPOSABLE_CONSUMER')
    repository = HERE.parents[1]
    require(consumer != repository and not contained(repository, consumer), 'CONSUMER_MUST_BE_OUTSIDE_REPOSITORY')
    inventory = value['installedFiles']
    require(isinstance(inventory, dict) and inventory, 'FULL_INSTALLED_PACKAGE_INVENTORY_REQUIRED')
    actual = set()
    for path in package.rglob('*'):
        require(not path.is_symlink(), 'INSTALLED_PACKAGE_SYMLINK_REJECTED')
        if not path.is_dir():
            actual.add(str(path.relative_to(package)))
    require(actual == set(inventory) and 'package.json' in actual, 'INSTALLED_PACKAGE_FILE_SET_CHANGED')
    manifest = json.loads((package / 'package.json').read_text())
    require(manifest.get('name') == '@opencoven/openclaw-desktop-use', 'EXPECTED_INSTALLED_PACKAGE_REQUIRED')
    try:
        required = [manifest['exports']['./sdk']['import'], manifest['exports']['./sdk']['types'],
                    manifest['exports']['./contracts']['import'], manifest['bin']['coven-desktop-use-mcp'],
                    'dist/examples/approval-host/main.js', 'dist/src/mcp/schema.js']
    except (KeyError, TypeError):
        raise ValueError('COMPILED_PUBLIC_SDK_MCP_EXPORTS_REQUIRED') from None
    for name in required:
        require(isinstance(name, str) and name.removeprefix('./') in actual, 'COMPILED_PUBLIC_ENTRY_MISSING')
    bindings = []
    require(set(value['harnessSources']) == set(PUBLIC_SOURCE_FILES), 'COMPLETE_HARNESS_SOURCE_BINDING_REQUIRED')
    for name in PUBLIC_SOURCE_FILES:
        bound_file(repository / name, value['harnessSources'][name])
    for name, expected in inventory.items():
        path = package / name
        require(contained(package, path.resolve(strict=True)), 'PACKAGE_INVENTORY_ESCAPE')
        bindings.append(bound_file(path, expected))
    for path_key, hash_key in (('adapterPath', 'nativeSha256'), ('packageArchivePath', 'packageArchiveSha256')):
        bindings.append(bound_file(Path(value[path_key]), value[hash_key]))
    require(archive_inventory(Path(value['packageArchivePath'])) == inventory, 'INSTALLED_PACKAGE_DIFFERS_FROM_BOUND_ARCHIVE')
    tools = value['tools']
    require(set(tools) == set(TOOLS), 'EXACT_PREPARED_TOOL_SET_REQUIRED')
    for name in TOOLS:
        path = Path(tools[name]['path'])
        require(path.resolve(strict=True) == path and os.access(path, os.X_OK), 'CANONICAL_PREPARED_EXECUTABLE_REQUIRED')
        bindings.append(bound_file(path, tools[name]['sha256']))
    require(re.fullmatch(r'python3(?:\.\d+)?', Path(tools['python3']['path']).name), 'PREPARED_PYTHON3_REQUIRED')
    require(Path(tools['node']['path']).name == 'node', 'PREPARED_NODE_REQUIRED')
    # Tool lookup must select the exact declared helper, including the JPEG build.
    search = helper_search_path(tools)
    return {**value, 'consumerRoot': str(consumer), 'packageRoot': str(package)}, bindings, search


class Lease:
    def __init__(self, expires, epoch=time.time, monotonic=time.monotonic):
        require(isinstance(expires, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)', expires), 'ZONED_LEASE_REQUIRED')
        self.epoch, self.monotonic = epoch, monotonic
        self.end = datetime.datetime.fromisoformat(expires.replace('Z', '+00:00')).timestamp()
        self.started = monotonic()
        self.budget = self.end - epoch()
        require(60 <= self.budget <= 1200, 'FRESH_BOUNDED_LEASE_REQUIRED')

    def remaining(self, reserve=CLEANUP_RESERVE):
        elapsed = self.monotonic() - self.started
        require(elapsed >= 0, 'MONOTONIC_CLOCK_REVERSED')
        value = min(self.end - self.epoch(), self.budget - elapsed) - reserve
        require(value > 0, 'LEASE_EXHAUSTED_CLEANUP_RESERVED')
        return value


def process_birth(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].strip().split()
    require(fields[0] not in ('Z', 'X'), 'OWNED_PROCESS_NOT_LIVE')
    return fields[19]


def direct_children():
    result = []
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[1]) == os.getpid():
                result.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return result


def reap_descendants(timeout=DESCENDANT_WAIT):
    """The operator is a subreaper; escaped child sessions remain task-owned."""
    end, seen = time.monotonic() + timeout, set()
    while True:
        children = direct_children()
        if not children:
            return sorted(seen)
        seen.update(children)
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
            except ChildProcessError:
                break
        if time.monotonic() >= end:
            raise RuntimeError('OWNED_DESCENDANTS_NOT_REAPED')
        time.sleep(.01)


def execute(prepared, bindings, search, output, scale, expires):
    require(sys.platform == 'linux' and os.getuid() > 0, 'NONROOT_LINUX_EXECUTION_REQUIRED')
    require(os.environ.get('NATIVE_OWNED_DISPOSABLE_DISPLAY') == 'yes', 'OWNED_DISPOSABLE_DISPLAY_OPT_IN_REQUIRED')
    require(not Path('/dev/input').exists() and not Path('/dev/uinput').exists(), 'SOFTWARE_NAMESPACE_WITHOUT_INPUT_DEVICES_REQUIRED')
    lease = Lease(expires)
    require(not output.exists() and output.parent.resolve(strict=True) == output.parent, 'FRESH_CANONICAL_OUTPUT_REQUIRED')
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(36, 1, 0, 0, 0) == 0, 'CHILD_SUBREAPER_REQUIRED')
    require(not direct_children(), 'OPERATOR_MUST_START_WITHOUT_EXISTING_CHILDREN')
    output.mkdir(mode=0o700)
    runtime, home = output / 'runtime', output / 'home'
    runtime.mkdir(mode=0o700)
    home.mkdir(mode=0o700)
    harness = Path(prepared['consumerRoot']) / ('.native-wayland-' + uuid.uuid4().hex)
    harness.mkdir(mode=0o700)
    status = {'schemaVersion': 1, 'success': False, 'scale': scale, 'physicalDisplayVerified': False, 'children': []}
    children = []

    def save():
        (output / 'operator-status.json').write_text(json.dumps(status, indent=2) + '\n')

    def interrupted(*_):
        raise InterruptedError('OWNED_OPERATOR_INTERRUPTED')

    def start(argv, name):
        lease.remaining()
        require(len(children) < MAX_OWNED_CHILDREN, 'OWNED_CHILD_BUDGET_EXCEEDED')
        with (output / (name + '-private.log')).open('xb') as log:
            child = subprocess.Popen(argv, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append((name, child))
        return child

    def wait_for(predicate, timeout):
        end = time.monotonic() + min(timeout, lease.remaining())
        while time.monotonic() < end:
            lease.remaining()
            require(all(child.poll() is None for name, child in children if name != 'client'), 'OWNED_ACTOR_EXITED_EARLY')
            if predicate():
                return
            time.sleep(.02)
        raise TimeoutError('OWNED_ACTOR_NOT_READY')

    def query(kind):
        value = subprocess.run([prepared['tools']['swaymsg']['path'], '-t', kind], env=env, capture_output=True, timeout=min(3, lease.remaining()))
        require(value.returncode == 0 and len(value.stdout) <= 131072, 'OWNED_COMPOSITOR_QUERY_FAILED')
        return json.loads(value.stdout)

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        for name in RUNTIME_FILES:
            bindings.append(copy_bound_source(HERE / name, harness / name, prepared['harnessSources']['scripts/native-client-acceptance/' + name]))
        bindings.append(copy_bound_source(HERE.parent / 'native-image-fixture/fixture.py', harness / 'fixture.py', prepared['harnessSources']['scripts/native-image-fixture/fixture.py']))
        bindings.append(copy_bound_source(HERE.parents[1] / 'src/mcp/fixtures/pty-host.py', harness / 'pty-host.py', prepared['harnessSources']['src/mcp/fixtures/pty-host.py']))
        config_path = output / 'sway-config'
        config_path.write_text(f'xwayland disable\noutput HEADLESS-1 mode 1280x960 scale {scale} position 0 0\nseat seat0 fallback true\ndefault_border none\nfont pango:monospace 10\n')
        bindings.append({'path': str(config_path), 'sha256': digest(config_path)})
        env = {'PATH': search, 'HOME': str(home), 'XDG_RUNTIME_DIR': str(runtime),
               'XDG_SESSION_TYPE': 'wayland', 'XDG_CURRENT_DESKTOP': 'sway', 'GDK_BACKEND': 'wayland',
               'WLR_BACKENDS': 'headless', 'WLR_RENDERER': 'pixman', 'WLR_HEADLESS_OUTPUTS': '1',
               'WLR_LIBINPUT_NO_DEVICES': '1', 'NATIVE_OWNED_DISPOSABLE_DISPLAY': 'yes', 'LANG': 'C.UTF-8'}
        sway = start([prepared['tools']['sway']['path'], '--config', str(config_path)], 'compositor')
        sway_socket = runtime / f'sway-ipc.{os.getuid()}.{sway.pid}.sock'
        def sockets_ready():
            displays = [path for path in runtime.glob('wayland-*') if path.is_socket()]
            if sway_socket.is_socket() and len(displays) == 1:
                env.update(SWAYSOCK=str(sway_socket), WAYLAND_DISPLAY=displays[0].name)
                return True
            return False
        wait_for(sockets_ready, 10)
        start([prepared['tools']['wtype']['path'], '-s', '1200000'], 'keyboard-seat-keepalive')
        wait_for(lambda: any(seat.get('capabilities', 0) & 2 for seat in query('get_seats')), 3)
        fixture_state = output / 'fixture-state-private.json'
        title = 'DesktopuseOwnedWaylandAcceptance'
        fixture = start([prepared['tools']['python3']['path'], str(harness / 'fixture.py'), '--state', str(fixture_state), '--session', 'wayland', '--title', title, '--observe-entry-focus'], 'fixture')
        def fixture_ready():
            if not fixture_state.exists():
                return False
            value = json.loads(fixture_state.read_text())
            return value.get('ready') and value.get('pid') == fixture.pid and value.get('size') == [1280 // scale, 960 // scale] and value.get('entryFocused')
        wait_for(fixture_ready, 10)
        descriptor = {**prepared, 'fileBindings': bindings, 'scale': scale, 'runRoot': str(output), 'runtimeRoot': str(runtime), 'harnessRoot': str(harness), 'leaseExpiresAt': expires,
                      'swaySocket': str(sway_socket), 'waylandDisplay': env['WAYLAND_DISPLAY'], 'fixturePid': fixture.pid, 'fixtureStartTicks': process_birth(fixture.pid), 'compositorPid': sway.pid, 'compositorStartTicks': process_birth(sway.pid),
                      'fixtureExecutablePath': prepared['tools']['python3']['path'], 'compositorExecutablePath': prepared['tools']['sway']['path'], 'fixtureSourcePath': str(harness / 'fixture.py'), 'fixtureSourceSha256': digest(harness / 'fixture.py'), 'fixtureStatePath': str(fixture_state), 'fixtureTitle': title,
                      'peerObserverPath': str(harness / 'wayland-peer-observer.py'), 'peerObserverSha256': digest(harness / 'wayland-peer-observer.py'), 'swayConfigPath': str(config_path), 'swayConfigSha256': digest(config_path), 'imageProofPath': str(harness / 'linux-image-proof.py'), 'ptyHostPath': str(harness / 'pty-host.py')}
        descriptor_path = output / 'execution-descriptor-private.json'
        descriptor_path.write_text(json.dumps(descriptor))
        client = start([prepared['tools']['node']['path'], str(harness / 'wayland-client.mjs'), '--execute-owned-descriptor', str(descriptor_path)], 'client')
        code = client.wait(timeout=min(180, lease.remaining()))
        require(code == 0, 'INSTALLED_CLIENT_MATRIX_FAILED')
        receipt = json.loads((output / 'receipt.json').read_text())
        require(receipt['success'] and len(receipt['receipts']) == 3, 'COMPLETE_CLIENT_RECEIPT_REQUIRED')
        independent = subprocess.run([prepared['tools']['grim']['path'], '-t', 'png', '-s', str(scale), '--', str(output / 'independent-after.png')], env=env, capture_output=True, timeout=min(5, lease.remaining()))
        require(independent.returncode == 0, 'INDEPENDENT_FIXTURE_CAPTURE_FAILED')
        status.update(success=True, sourceCommit=prepared['sourceCommit'], sourceTree=prepared['sourceTree'], harnessCommit=prepared['harnessCommit'], harnessTree=prepared['harnessTree'], harnessSources=prepared['harnessSources'], keyboardSetupNoInputRequested=True, softwareRendering=True, noInputDevicesPresent=True, independentAfterSha256=digest(output / 'independent-after.png'))
    except BaseException as error:
        status['failureClass'] = type(error).__name__
        raise
    finally:
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, signal.SIG_IGN)
        cleanup_errors = []
        for name, child in reversed(children):
            try:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=TERM_WAIT)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=KILL_WAIT)
                status['children'].append({'name': name, 'exitCode': child.returncode, 'reaped': child.returncode is not None})
            except BaseException as error:
                cleanup_errors.append(type(error).__name__)
                status['children'].append({'name': name, 'reaped': False})
        try:
            status['adoptedDescendantsReaped'] = reap_descendants()
        except BaseException as error:
            cleanup_errors.append(type(error).__name__)
        status['cleanupErrors'] = cleanup_errors
        status['allKnownChildrenReaped'] = all(row['reaped'] for row in status['children']) and not cleanup_errors
        status['success'] = status['success'] and status['allKnownChildrenReaped']
        save()
        print(json.dumps({'success': status['success'], 'scale': scale, 'allKnownChildrenReaped': status['allKnownChildrenReaped']}), flush=True)
        if cleanup_errors:
            raise RuntimeError('OWNED_CLEANUP_INCOMPLETE_RETAIN_RUNTIME_LEASE')


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--output-root', type=Path)
    parser.add_argument('--scale', type=int, choices=(1, 2), default=1)
    parser.add_argument('--lease-expires-at')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--owned-disposable-display', action='store_true')
    args = parser.parse_args()
    value = json.loads(args.prepared.read_text())
    prepared, bindings, search = prepared_descriptor(value)
    if not args.execute:
        print(json.dumps({'schemaVersion': 1, 'preflightPassed': True, 'nativeExecuted': False, 'installedPackageFilesChecked': len(value['installedFiles']), 'scaleRequested': args.scale, 'requiresFreshLeaseAndExplicitExecution': True}))
        return
    require(args.owned_disposable_display and args.output_root is not None and args.lease_expires_at is not None, 'EXECUTION_REQUIRES_OWNED_DISPLAY_FRESH_ROOT_AND_LEASE')
    execute(prepared, bindings, search, args.output_root.absolute(), args.scale, args.lease_expires_at)


if __name__ == '__main__':
    main()
