#!/usr/bin/env python3
"""Read only three Sway IPC messages from a PID/UID-bound software compositor."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import sys
import time

HEADER = struct.Struct('=6sII')
READ_ONLY_QUERIES = ((7, 'version'), (3, 'outputs'), (4, 'tree'))
MAX_REPLY = 32768


class MetadataFiles:
    """Synchronous reads inside the single owned worker; no background work."""
    def __init__(self, deadline, clock=time.monotonic, filesystem=os):
        self.deadline, self.clock, self.filesystem = deadline, clock, filesystem

    def check(self):
        return remaining(self.deadline, self.clock)

    def path(self, path):
        self.check()
        result = self.filesystem.path.realpath(path, strict=True)
        self.check()
        return result

    def inspect(self, path):
        self.check()
        result = self.filesystem.lstat(path)
        self.check()
        return result

    def read(self, path, limit):
        self.check()
        if type(limit) is not int or not 0 < limit <= 262144:
            raise ValueError('INVALID_METADATA_BYTE_LIMIT')
        descriptor = None
        try:
            descriptor = self.filesystem.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            self.check()  # A late open must not initiate stat/read work.
            info = self.filesystem.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise ValueError('REGULAR_BOUNDED_METADATA_REQUIRED')
            chunks, count = [], 0
            while True:
                self.check()
                value = self.filesystem.read(descriptor, min(4096, limit + 1 - count))
                self.check()
                if not value:
                    break
                count += len(value)
                if count > limit:
                    raise ValueError('METADATA_BYTE_LIMIT_EXCEEDED')
                chunks.append(value)
            return b''.join(chunks)
        finally:
            if descriptor is not None:
                self.filesystem.close(descriptor)
            self.check()


def process_birth(value, pid):
    if int(value.split(' ', 1)[0]) != pid:
        raise ValueError('PROCESS_PID_CHANGED')
    fields = value.rsplit(')', 1)[1].strip().split()
    if fields[0] not in ('R', 'S', 'D', 'I') or not fields[19].isdigit() or int(fields[19]) <= 0:
        raise ValueError('LIVE_PROCESS_BIRTH_REQUIRED')
    return fields[19]


def expected_argv(config, role):
    if role == 'compositor':
        return [config['compositorExecutablePath'], '--config', config['swayConfigPath']]
    if role != 'fixture':
        raise ValueError('UNKNOWN_ACTOR_ROLE')
    return [config['fixtureExecutablePath'], config['fixtureSourcePath'], '--state',
            config['fixtureStatePath'], '--session', 'wayland', '--title',
            config['fixtureTitle'], '--observe-entry-focus']


def collect_descriptor(config, timeout_ms, *, files=None, uid=None, platform=None,
                       environment=None, probe=None):
    probe = observe if probe is None else probe
    uid = os.getuid() if uid is None else uid
    platform = sys.platform if platform is None else platform
    environment = os.environ if environment is None else environment
    if uid <= 0 or platform != 'linux' or environment.get('NATIVE_OWNED_DISPOSABLE_DISPLAY') != 'yes':
        raise ValueError('OWNED_NONROOT_LINUX_REQUIRED')
    io = files if files is not None else MetadataFiles(time.monotonic() + timeout_ms / 1000)
    runtime = io.path(config['runtimeRoot'])
    info = io.inspect(config['runtimeRoot'])
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('PRIVATE_RUNTIME_DIRECTORY_REQUIRED')
    sway_socket = config['swaySocket']
    if sway_socket != os.path.join(runtime, f"sway-ipc.{uid}.{config['compositorPid']}.sock"):
        raise ValueError('OWNED_IPC_PATH_REQUIRED')
    display = config['waylandDisplay']
    if not isinstance(display, str) or not display.startswith('wayland-') or not display[8:].isdigit():
        raise ValueError('OWNED_DISPLAY_NAME_REQUIRED')
    wayland_socket = os.path.join(runtime, display)
    for path in (sway_socket, wayland_socket):
        if io.path(os.path.dirname(path)) != runtime:
            raise ValueError('SOCKET_OUTSIDE_PRIVATE_RUNTIME')
    before = [socket_identity(path, uid, io.inspect) for path in (sway_socket, wayland_socket)]

    def identity(role):
        pid, birth = config[role + 'Pid'], config[role + 'StartTicks']
        if type(pid) is not int or pid <= 1 or not isinstance(birth, str) or not birth.isdigit():
            raise ValueError('EXPLICIT_ACTOR_IDENTITY_REQUIRED')
        prefix = f'/proc/{pid}'
        if process_birth(io.read(prefix + '/stat', 16384).decode(), pid) != birth:
            raise ValueError('PROCESS_BIRTH_CHANGED')
        executable = io.path(config[role + 'ExecutablePath'])
        if io.path(prefix + '/exe') != executable:
            raise ValueError('PROCESS_EXECUTABLE_CHANGED')
        status = io.read(prefix + '/status', 65536).decode()
        values = [line.split()[1:] for line in status.splitlines() if line.startswith('Uid:')]
        if len(values) != 1 or len(values[0]) != 4 or any(int(value) != uid for value in values[0]):
            raise ValueError('PROCESS_OWNER_CHANGED')
        command = io.read(prefix + '/cmdline', 65536).decode().split('\0')
        if command[-1] != '' or command[:-1] != expected_argv(config, role):
            raise ValueError('PROCESS_LAUNCH_SHAPE_CHANGED')
        if io.path(prefix + '/exe') != executable or process_birth(io.read(prefix + '/stat', 16384).decode(), pid) != birth:
            raise ValueError('PROCESS_IDENTITY_CHANGED_DURING_READ')

    for role in ('compositor', 'fixture'):
        identity(role)
    environment = dict(line.split('=', 1) for line in io.read(f"/proc/{config['compositorPid']}/environ", 262144).decode().split('\0') if line)
    required = {'WLR_BACKENDS': 'headless', 'WLR_RENDERER': 'pixman',
                'WLR_HEADLESS_OUTPUTS': '1', 'WLR_LIBINPUT_NO_DEVICES': '1',
                'XDG_RUNTIME_DIR': runtime}
    if any(environment.get(key) != value for key, value in required.items()):
        raise ValueError('SOFTWARE_HEADLESS_COMPOSITOR_REQUIRED')
    for path_key, hash_key in (('fixtureSourcePath', 'fixtureSourceSha256'),
                               ('swayConfigPath', 'swayConfigSha256'),
                               ('peerObserverPath', 'peerObserverSha256')):
        path, expected = config[path_key], config[hash_key]
        info = io.inspect(path)
        if not os.path.isabs(path) or not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError('REGULAR_BOUND_SOURCE_REQUIRED')
        if hashlib.sha256(io.read(path, 65536)).hexdigest() != expected:
            raise ValueError('SOURCE_BYTES_CHANGED')
    observed = probe(sway_socket, wayland_socket, config['compositorPid'], uid,
                     max(1, min(3500, int(io.check() * 1000))), inspect=io.inspect)
    if (observed['peerPid'], observed['peerUid']) != (config['compositorPid'], uid):
        raise ValueError('IPC_SERVER_IDENTITY_CHANGED')
    if observed['socketIdentities'] != before:
        raise ValueError('SOCKET_REPLACED_BEFORE_IPC')
    if io.path(observed['version']['loaded_config_file_name']) != io.path(config['swayConfigPath']):
        raise ValueError('COMPOSITOR_CONFIG_CHANGED')
    for role in ('compositor', 'fixture'):
        identity(role)
    if [socket_identity(path, uid, io.inspect) for path in (sway_socket, wayland_socket)] != before:
        raise ValueError('SOCKET_REPLACED_AFTER_IPC')
    io.check()
    return observed


def socket_identity(path, uid, inspect=os.lstat):
    info = inspect(path)
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != uid:
        raise ValueError('OWNED_SOCKET_REQUIRED')
    return {'dev': str(info.st_dev), 'ino': str(info.st_ino),
            'ctimeNs': str(info.st_ctime_ns), 'uid': info.st_uid}


def remaining(deadline, clock):
    value = deadline - clock()
    if value <= 0:
        raise TimeoutError('PEER_OBSERVER_DEADLINE')
    return value


def receive_exact(connection, count, deadline, clock):
    chunks = []
    while count:
        connection.settimeout(remaining(deadline, clock))
        chunk = connection.recv(count)
        if not chunk:
            raise ValueError('TRUNCATED_IPC_REPLY')
        chunks.append(chunk)
        count -= len(chunk)
    return b''.join(chunks)


def connect_owned(path, pid, uid, deadline, clock, factory):
    connection = factory(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(remaining(deadline, clock))
        connection.connect(path)
        peer_pid, peer_uid, _ = struct.unpack('3i', connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if (peer_pid, peer_uid) != (pid, uid):
            raise ValueError('SOCKET_SERVER_IDENTITY_CHANGED')
        return connection
    except BaseException:
        connection.close()
        raise


def observe(sway_socket, wayland_socket, pid, uid, timeout_ms,
            factory=socket.socket, inspect=os.lstat, clock=time.monotonic):
    if pid <= 1 or uid <= 0 or not 0 < timeout_ms <= 3500:
        raise ValueError('INVALID_PEER_OBSERVER_ARGUMENT')
    deadline = clock() + timeout_ms / 1000
    before = {path: socket_identity(path, uid, inspect)
              for path in (sway_socket, wayland_socket)}
    # Connecting without a protocol request does not capture or send input.
    display = connect_owned(wayland_socket, pid, uid, deadline, clock, factory)
    display.close()
    connection = connect_owned(sway_socket, pid, uid, deadline, clock, factory)
    values = {}
    try:
        for message_type, name in READ_ONLY_QUERIES:
            connection.settimeout(remaining(deadline, clock))
            connection.sendall(HEADER.pack(b'i3-ipc', 0, message_type))
            magic, length, reply_type = HEADER.unpack(receive_exact(
                connection, HEADER.size, deadline, clock))
            if magic != b'i3-ipc' or reply_type != message_type or length > MAX_REPLY:
                raise ValueError('INVALID_IPC_REPLY')
            values[name] = json.loads(receive_exact(
                connection, length, deadline, clock))
        after = {path: socket_identity(path, uid, inspect)
                 for path in (sway_socket, wayland_socket)}
        if after != before:
            raise ValueError('SOCKET_REPLACED_DURING_IPC')
        remaining(deadline, clock)
        return {**values, 'peerPid': pid, 'peerUid': uid,
                'socketIdentities': [before[sway_socket], before[wayland_socket]]}
    finally:
        connection.close()


def main():
    if '--descriptor-stdin' in sys.argv:
        parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
        parser.add_argument('--descriptor-stdin', action='store_true', required=True)
        parser.add_argument('--timeout-ms', type=int, required=True)
        args = parser.parse_args()
        if not 0 < args.timeout_ms <= 3500:
            raise ValueError('INVALID_METADATA_DEADLINE')
        def expired(*_):
            raise TimeoutError('METADATA_WORKER_DEADLINE')
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, args.timeout_ms / 1000)
        try:
            body = sys.stdin.buffer.read(65537)
            if len(body) > 65536:
                raise ValueError('DESCRIPTOR_BYTE_LIMIT_EXCEEDED')
            value = collect_descriptor(json.loads(body), args.timeout_ms)
            sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
        return
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--sway-socket', required=True)
    parser.add_argument('--wayland-socket', required=True)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--uid', type=int, required=True)
    parser.add_argument('--timeout-ms', type=int, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or not hasattr(socket, 'SO_PEERCRED'):
        raise RuntimeError('LINUX_PEER_CREDENTIALS_REQUIRED')
    value = observe(args.sway_socket, args.wayland_socket,
                    args.pid, args.uid, args.timeout_ms)
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stderr.write(json.dumps({'code': 'OWNED_METADATA_FAILED', 'errorClass': type(error).__name__}) + '\n')
        sys.exit(1)
