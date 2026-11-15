import importlib.util
import json
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('wayland_operator', Path(__file__).with_name('wayland-operator.py'))
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class LeaseTests(unittest.TestCase):
    def test_backward_wall_clock_cannot_extend_monotonic_budget(self):
        clock = [1000, 10]
        lease = operator.Lease('1970-01-01T00:18:40Z', epoch=lambda: clock[0], monotonic=lambda: clock[1])
        self.assertEqual(lease.remaining(), 75)
        clock[:] = [900, 100]
        with self.assertRaisesRegex(ValueError, 'CLEANUP_RESERVED'):
            lease.remaining()

    def test_stale_naive_overlong_or_backward_monotonic_leases_reject(self):
        for value in ['1970-01-01T00:18:40', '1970-01-01T00:00:01Z', '1970-01-01T01:00:00Z']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                operator.Lease(value, epoch=lambda: 1000, monotonic=lambda: 10)
        clock = [10]
        lease = operator.Lease('1970-01-01T00:18:40+00:00', epoch=lambda: 1000, monotonic=lambda: clock[0])
        clock[0] = 9
        with self.assertRaisesRegex(ValueError, 'MONOTONIC_CLOCK_REVERSED'):
            lease.remaining()


class CleanupTests(unittest.TestCase):
    def test_cleanup_reserve_covers_all_child_escalations_and_adopted_sessions(self):
        maximum = operator.MAX_OWNED_CHILDREN * (operator.TERM_WAIT + operator.KILL_WAIT) + operator.DESCENDANT_WAIT
        self.assertGreaterEqual(operator.CLEANUP_RESERVE, maximum + 5)

    def test_subreaper_does_not_return_before_newly_adopted_sessions_are_reaped(self):
        children = iter([[100], [101], []])
        signals = []
        with mock.patch.object(operator, 'direct_children', side_effect=lambda: next(children)), mock.patch.object(operator.os, 'kill', side_effect=lambda pid, sig: signals.append((pid, sig))), mock.patch.object(operator.os, 'waitpid', return_value=(0, 0)), mock.patch.object(operator.time, 'sleep'):
            self.assertEqual(operator.reap_descendants(), [100, 101])
        self.assertEqual(signals, [(100, operator.signal.SIGKILL), (101, operator.signal.SIGKILL)])

    def test_unreaped_children_fail_visibly_instead_of_becoming_cleanup_success(self):
        with mock.patch.object(operator, 'direct_children', return_value=[100]), mock.patch.object(operator.os, 'kill'), mock.patch.object(operator.os, 'waitpid', return_value=(0, 0)), mock.patch.object(operator.time, 'monotonic', side_effect=[0, 16]):
            with self.assertRaisesRegex(RuntimeError, 'NOT_REAPED'):
                operator.reap_descendants()


class PreparedTests(unittest.TestCase):
    def test_copy_cannot_rebind_bytes_changed_after_preflight(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / 'source', root / 'destination'
            source.write_bytes(b'approved source bytes')
            expected = operator.digest(source)
            def changed_copy(_source, output):
                output.write_bytes(b'changed source bytes after preflight')
            with mock.patch.object(operator.shutil, 'copyfile', side_effect=changed_copy):
                with self.assertRaises(ValueError):
                    operator.copy_bound_source(source, destination, expected)

    def sample(self, root):
        consumer = root / 'consumer'
        package = consumer / 'node_modules/fixture-package'
        package.mkdir(parents=True)
        manifest = {'name': '@opencoven/openclaw-desktop-use', 'exports': {'./sdk': {'import': './dist/sdk.js', 'types': './dist/sdk.d.ts'}, './contracts': {'import': './dist/contracts.js'}}, 'bin': {'coven-desktop-use-mcp': './dist/mcp.js'}}
        (package / 'package.json').write_text(json.dumps(manifest))
        for name in ['dist/sdk.js', 'dist/sdk.d.ts', 'dist/contracts.js', 'dist/mcp.js', 'dist/examples/approval-host/main.js', 'dist/src/mcp/schema.js']:
            target = package / name
            target.parent.mkdir(exist_ok=True, parents=True)
            target.write_text('// never executed mock entry\n')
        tools = {}
        for name in operator.TOOLS:
            path = root / 'bin' / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('# prepared mock executable, never run\n')
            path.chmod(0o700)
            tools[name] = {'path': str(path), 'sha256': operator.digest(path)}
        adapter, archive = root / 'native', root / 'package.tgz'
        adapter.write_bytes(b'prepared native mock, never run')
        with tarfile.open(archive, 'w:gz') as packed:
            for path in sorted(package.rglob('*')):
                if path.is_file():
                    packed.add(path, arcname='package/' + str(path.relative_to(package)), recursive=False)
        return {'schemaVersion': 1, 'sourceCommit': 'a' * 40, 'sourceTree': 'b' * 40, 'harnessCommit': 'c' * 40, 'harnessTree': 'd' * 40,
                'harnessSources': {name: operator.digest(operator.HERE.parents[1] / name) for name in operator.PUBLIC_SOURCE_FILES},
                'consumerRoot': str(consumer), 'packageRoot': str(package),
                'installedFiles': {str(path.relative_to(package)): operator.digest(path) for path in package.rglob('*') if path.is_file()},
                'adapterPath': str(adapter), 'nativeSha256': operator.digest(adapter),
                'packageArchivePath': str(archive), 'packageArchiveSha256': operator.digest(archive), 'tools': tools}

    def test_default_preflight_only_reads_exact_package_artifacts_and_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            value = self.sample(Path(temporary).resolve())
            before = sorted(str(path) for path in Path(temporary).rglob('*'))
            with mock.patch.object(operator.subprocess, 'Popen', side_effect=AssertionError('PREFLIGHT_MUST_NOT_EXECUTE')):
                prepared, bindings, _ = operator.prepared_descriptor(value)
            self.assertEqual(prepared['sourceCommit'], 'a' * 40)
            self.assertEqual(len(bindings), len(value['installedFiles']) + 2 + len(operator.TOOLS))
            self.assertEqual(sorted(str(path) for path in Path(temporary).rglob('*')), before)

    def test_prepared_jpeg_helper_wins_over_system_helper_in_another_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            value = self.sample(root)
            replacement = root / 'jpeg-enabled/grim'
            replacement.parent.mkdir()
            replacement.write_text('# prepared JPEG helper mock, never run\n')
            replacement.chmod(0o700)
            value['tools']['grim'] = {'path': str(replacement), 'sha256': operator.digest(replacement)}
            _, _, search = operator.prepared_descriptor(value)
            self.assertEqual(Path(operator.shutil.which('grim', path=search)).resolve(), replacement)

    def test_changed_inventory_bytes_and_symlink_artifacts_reject(self):
        for kind in ['extra-package-file', 'changed-native', 'symlink-native', 'unbound-helper', 'archive-pair-mismatch']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                value = self.sample(root)
                if kind == 'extra-package-file':
                    Path(value['packageRoot'], 'extra.js').write_text('extra')
                elif kind == 'changed-native':
                    Path(value['adapterPath']).write_text('changed')
                elif kind == 'symlink-native':
                    original = Path(value['adapterPath'])
                    moved = root / 'original-native'
                    original.rename(moved)
                    original.symlink_to(moved)
                elif kind == 'unbound-helper':
                    value['tools']['grim']['sha256'] = '0' * 64
                else:
                    entry = Path(value['packageRoot'], 'dist/sdk.js')
                    entry.write_text('// changed installed bytes\n')
                    value['installedFiles']['dist/sdk.js'] = operator.digest(entry)
                with self.assertRaises(ValueError):
                    operator.prepared_descriptor(value)


if __name__ == '__main__':
    unittest.main()
