import importlib.util
import copy
import hashlib
import json
from pathlib import Path
import socket
import stat
import struct
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('wayland_peer', Path(__file__).with_name('wayland-peer-observer.py'))
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


class Connection:
    def __init__(self, owner, fault=None):
        self.owner, self.fault = owner, fault
        self.buffer, self.sent, self.closed = b'', [], False
        self.timeouts = []

    def settimeout(self, value):
        self.timeouts.append(value)

    def connect(self, path):
        self.path = path

    def getsockopt(self, *_):
        return struct.pack('3i', *self.owner, 1000)

    def sendall(self, payload):
        magic, length, kind = peer.HEADER.unpack(payload)
        assert magic == b'i3-ipc' and length == 0
        self.sent.append(kind)
        body = json.dumps({'kind': kind}).encode()
        header = peer.HEADER.pack(b'i3-ipc', len(body), kind)
        if self.fault == 'bad-type':
            header = peer.HEADER.pack(b'i3-ipc', len(body), 0)
        elif self.fault == 'bad-magic':
            header = peer.HEADER.pack(b'notipc', len(body), kind)
        elif self.fault == 'oversized':
            header = peer.HEADER.pack(b'i3-ipc', peer.MAX_REPLY + 1, kind)
        elif self.fault == 'invalid-json':
            body = b'{'
            header = peer.HEADER.pack(b'i3-ipc', len(body), kind)
        self.buffer = header + (b'' if self.fault == 'truncated' else body)

    def recv(self, count):
        count = min(count, 2)  # Exercise fragmented headers and payloads.
        value, self.buffer = self.buffer[:count], self.buffer[count:]
        return value

    def close(self):
        self.closed = True


class PeerObserverTests(unittest.TestCase):
    def probe(self, fault=None):
        connections, inspections = [], {}

        def factory(*_):
            owner = (999, 1000) if fault == 'wrong-pid' else (32, 999) if fault == 'wrong-uid' else (32, 1000)
            connection = Connection(owner, fault)
            connections.append(connection)
            return connection

        def inspect(path):
            inspections[path] = inspections.get(path, 0) + 1
            changed = fault == 'replaced' and inspections[path] > 1
            return types.SimpleNamespace(st_mode=stat.S_IFLNK if fault == 'symlink' else stat.S_IFSOCK,
                                         st_uid=1000, st_dev=1, st_ino=(11 if path == 'sway' else 12) + changed,
                                         st_ctime_ns=42)

        return connections, factory, inspect

    def observe(self, fault=None):
        connections, factory, inspect = self.probe(fault)
        with mock.patch.object(socket, 'SO_PEERCRED', 17, create=True):
            try:
                result = peer.observe('sway', 'display', 32, 1000, 3500,
                                      factory=factory, inspect=inspect, clock=lambda: 0)
                return result, connections
            finally:
                self.assertTrue(all(connection.closed for connection in connections))

    def test_same_peer_connection_sends_only_three_read_only_query_types(self):
        result, connections = self.observe()
        self.assertEqual(connections[0].sent, [])
        self.assertEqual(connections[1].sent, [7, 3, 4])
        self.assertEqual((result['peerPid'], result['peerUid']), (32, 1000))
        self.assertTrue(all(0 < value <= 3.5 for connection in connections for value in connection.timeouts))

    def test_foreign_server_or_replaced_socket_cannot_supply_owned_metadata(self):
        for fault in ['wrong-pid', 'wrong-uid', 'symlink', 'replaced']:
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.observe(fault)

    def test_malformed_or_unbounded_reply_fails_closed(self):
        for fault in ['bad-type', 'bad-magic', 'oversized', 'invalid-json', 'truncated']:
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                self.observe(fault)

    def test_expired_budget_does_not_open_a_socket(self):
        _, factory, inspect = self.probe()
        values = iter([0, 4])
        with self.assertRaises(TimeoutError):
            peer.observe('sway', 'display', 32, 1000, 3500,
                         factory=factory, inspect=inspect, clock=lambda: next(values))


class FakeMetadata:
    def __init__(self):
        self.config = {
            'runtimeRoot': '/owned/run', 'swaySocket': '/owned/run/sway-ipc.1000.32.sock',
            'waylandDisplay': 'wayland-1', 'compositorPid': 32, 'compositorStartTicks': '100',
            'fixturePid': 42, 'fixtureStartTicks': '123',
            'compositorExecutablePath': '/usr/bin/sway', 'fixtureExecutablePath': '/usr/bin/python3.11',
            'fixtureSourcePath': '/owned/fixture.py', 'fixtureStatePath': '/owned/state.json',
            'fixtureTitle': 'Owned Fixture', 'swayConfigPath': '/owned/sway-config',
            'peerObserverPath': '/owned/observer.py',
        }
        self.reads, self.paths, self.info = {}, {}, {}
        self.info['/owned/run'] = self.stat(stat.S_IFDIR | 0o700, 10)
        for index, path in enumerate([self.config['swaySocket'], '/owned/run/wayland-1']):
            self.info[path] = self.stat(stat.S_IFSOCK | 0o600, 20 + index)
        for role in ('compositor', 'fixture'):
            pid = self.config[role + 'Pid']
            birth = self.config[role + 'StartTicks']
            self.paths[f'/proc/{pid}/exe'] = self.config[role + 'ExecutablePath']
            # State is stat field 3; starttime is field 22, even with ')' in comm.
            self.reads[f'/proc/{pid}/stat'] = f'{pid} (owned ) name) S ' .encode() + ('0 ' * 18 + birth + '\n').encode()
            self.reads[f'/proc/{pid}/status'] = b'Name:\towned\nUid:\t1000\t1000\t1000\t1000\n'
            self.reads[f'/proc/{pid}/cmdline'] = ('\0'.join(peer.expected_argv(self.config, role)) + '\0').encode()
        self.reads['/proc/32/environ'] = b'WLR_BACKENDS=headless\0WLR_RENDERER=pixman\0WLR_HEADLESS_OUTPUTS=1\0WLR_LIBINPUT_NO_DEVICES=1\0XDG_RUNTIME_DIR=/owned/run\0'
        for path_key, hash_key in [('fixtureSourcePath', 'fixtureSourceSha256'), ('swayConfigPath', 'swayConfigSha256'), ('peerObserverPath', 'peerObserverSha256')]:
            path = self.config[path_key]
            self.reads[path] = path.encode()
            self.info[path] = self.stat(stat.S_IFREG | 0o600, 30)
            self.config[hash_key] = hashlib.sha256(self.reads[path]).hexdigest()
        self.observed = {'peerPid': 32, 'peerUid': 1000, 'version': {'loaded_config_file_name': '/owned/sway-config'},
                         'socketIdentities': [peer.socket_identity(path, 1000, self.inspect) for path in (self.config['swaySocket'], '/owned/run/wayland-1')]}
        self.probe_called = False

    @staticmethod
    def stat(mode, inode):
        return types.SimpleNamespace(st_mode=mode, st_uid=1000, st_dev=1, st_ino=inode, st_ctime_ns=42)

    def path(self, path):
        return self.paths.get(path, path)

    def inspect(self, path):
        return self.info[path]

    def read(self, path, limit):
        value = self.reads[path]
        assert len(value) <= limit
        return value

    def check(self):
        return 1

    def probe(self, *_args, **_kwargs):
        self.probe_called = True
        return copy.deepcopy(self.observed)

    def collect(self):
        return peer.collect_descriptor(self.config, 1000, files=self, uid=1000,
                                       platform='linux', environment={'NATIVE_OWNED_DISPOSABLE_DISPLAY': 'yes'}, probe=self.probe)


class DescriptorTests(unittest.TestCase):
    def test_exact_owned_process_socket_environment_and_source_bindings(self):
        files = FakeMetadata()
        self.assertEqual(files.collect(), files.observed)
        self.assertTrue(files.probe_called)

    def test_ownership_preconditions_reject_before_ipc(self):
        def wrong_uid(files):
            files.reads['/proc/42/status'] = b'Uid:\t1000\t0\t1000\t1000\n'
        def wrong_birth(files):
            files.config['fixtureStartTicks'] = '124'
        def broad_launch(files):
            files.reads['/proc/42/cmdline'] += b'--extra\0'
        def hardware_backend(files):
            files.reads['/proc/32/environ'] = files.reads['/proc/32/environ'].replace(b'headless', b'drm')
        def changed_source(files):
            files.reads['/owned/fixture.py'] += b'changed'
        def symlink_source(files):
            files.info['/owned/fixture.py'].st_mode = stat.S_IFLNK | 0o777
        def public_runtime(files):
            files.info['/owned/run'].st_mode = stat.S_IFDIR | 0o755
        def foreign_executable(files):
            files.paths['/proc/42/exe'] = '/foreign/python3.11'
        for mutation in [wrong_uid, wrong_birth, broad_launch, hardware_backend, changed_source, symlink_source, public_runtime, foreign_executable]:
            with self.subTest(mutation=mutation.__name__):
                files = FakeMetadata()
                mutation(files)
                with self.assertRaises(ValueError):
                    files.collect()
                self.assertFalse(files.probe_called)

    def test_changed_server_config_and_socket_identity_reject_after_ipc(self):
        for field, value in [('peerPid', 99), ('peerUid', 99), ('socketIdentities', [])]:
            with self.subTest(field=field):
                files = FakeMetadata()
                files.observed[field] = value
                with self.assertRaises(ValueError):
                    files.collect()
        files = FakeMetadata()
        files.observed['version']['loaded_config_file_name'] = '/foreign/config'
        with self.assertRaises(ValueError):
            files.collect()


class MetadataLifecycleTests(unittest.TestCase):
    def test_late_open_read_or_close_cannot_return_metadata(self):
        for phase in ['open', 'read', 'close']:
            with self.subTest(phase=phase):
                clock, events = [0], []
                def opened(*_):
                    events.append('open')
                    if phase == 'open':
                        clock[0] = 2
                    return 7
                def read(*_):
                    events.append('read')
                    if phase == 'read':
                        clock[0] = 2
                    return b''
                def close(*_):
                    events.append('close')
                    if phase == 'close':
                        clock[0] = 2
                filesystem = types.SimpleNamespace(open=opened, read=read, close=close,
                    fstat=lambda _: (events.append('stat') or types.SimpleNamespace(st_mode=stat.S_IFREG, st_size=0)))
                files = peer.MetadataFiles(1, clock=lambda: clock[0], filesystem=filesystem)
                with self.assertRaises(TimeoutError):
                    files.read('/owned/file', 10)
                self.assertEqual(events.count('close'), 1)
                if phase == 'open':
                    self.assertEqual(events, ['open', 'close'])

    def test_stream_limit_closes_descriptor_before_rejecting(self):
        events = []
        filesystem = types.SimpleNamespace(open=lambda *_: 7, read=lambda *_: b'123456',
            close=lambda _: events.append('closed'), fstat=lambda _: types.SimpleNamespace(st_mode=stat.S_IFREG, st_size=0))
        files = peer.MetadataFiles(1, clock=lambda: 0, filesystem=filesystem)
        with self.assertRaisesRegex(ValueError, 'METADATA_BYTE_LIMIT_EXCEEDED'):
            files.read('/owned/file', 5)
        self.assertEqual(events, ['closed'])


if __name__ == '__main__':
    unittest.main()
