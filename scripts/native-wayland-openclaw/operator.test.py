import datetime
import hashlib
import importlib.util
import os
import io
import json
from pathlib import Path
import shutil
import tempfile
import tarfile
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('provider_operator', Path(__file__).with_name('provider-operator.py'))
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class ProviderOperatorTests(unittest.TestCase):
    def prepared_fixture(self, root):
        consumer, package, tools, host = root/'consumer', root/'consumer/package', root/'tools', root/'host'
        package.mkdir(parents=True); tools.mkdir(); host.mkdir()
        files = {'package.json': json.dumps({'name':'@opencoven/openclaw-desktop-use','version':'0.1.3','openclaw':{'extensions':['./dist/index.js']}}).encode(), 'dist/index.js':b'export default {};', 'openclaw.plugin.json':b'{}', 'agents/computer-use/openclaw-agent.json':b'{}'}
        archive = root/'package.tgz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, data in files.items():
                path = package/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(data)
                member = tarfile.TarInfo('package/'+name); member.size=len(data); tar.addfile(member,io.BytesIO(data))
        (host/'package.json').write_text(json.dumps({'name':'openclaw','version':'2026.4.26'})); host_archive=root/'host.tgz';host_archive.write_bytes(b'synthetic host, default metadata preflight only')
        sentinel=root/'unexpected-helper-execution'
        for name in operator.TOOLS:
            path=tools/name;path.write_text('#!/bin/sh\ntouch '+str(sentinel)+'\nexit 99\n');path.chmod(0o700)
        native=root/'adapter';native.write_bytes(b'synthetic native, never execute')
        repository=Path(__file__).resolve().parents[2]
        value={'schemaVersion':1,'ownerThread':'fixture-owner','sourceCommit':'1'*40,'sourceTree':'2'*40,'harnessCommit':'3'*40,'harnessTree':'4'*40,'consumerRoot':str(consumer),'packageRoot':str(package),'adapterPath':str(native),'nativeSha256':hashlib.sha256(native.read_bytes()).hexdigest(),'packageArchivePath':str(archive),'packageArchiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'installedFiles':{name:hashlib.sha256(data).hexdigest() for name,data in files.items()},'harnessSources':{name:hashlib.sha256((repository/name).read_bytes()).hexdigest() for name in operator.PUBLIC_SOURCE_FILES},'tools':{name:{'path':str((tools/name).resolve()),'sha256':hashlib.sha256((tools/name).read_bytes()).hexdigest()} for name in operator.TOOLS},'openclaw':{'host':str(host),'hostVersion':'2026.4.26','hostOrigin':'unchanged-official-package','hostArchive':str(host_archive),'hostArchiveSha256':hashlib.sha256(host_archive.read_bytes()).hexdigest(),'hostRuntimeStage':None}}
        return value, sentinel

    def test_default_provider_metadata_preflight_starts_no_graphical_or_input_actor(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();value,sentinel=self.prepared_fixture(root);prepared=root/'prepared.json';prepared.write_text(json.dumps(value));output=root/'must-not-exist'
            result=subprocess.run([sys.executable,'-I','-B',str(Path(__file__).with_name('provider-operator.py')),'--prepared',str(prepared),'--output-root',str(output)],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            proof=json.loads(result.stdout);self.assertTrue(proof['preflightPassed']);self.assertFalse(proof['nativeExecuted']);self.assertTrue(proof['requiresFreshLeaseAndExplicitExecution'])
            self.assertEqual(proof['officialHostArchiveVerification'],'deferred-to-provider-preflight');self.assertFalse(output.exists());self.assertFalse(sentinel.exists())

    def test_provider_shutdown_reserve_leaves_gateway_and_actor_cleanup_time(self):
        self.assertGreaterEqual(operator.TERM_WAIT, 30)
        self.assertGreaterEqual(operator.CLEANUP_RESERVE, operator.MAX_OWNED_CHILDREN * (operator.TERM_WAIT + operator.KILL_WAIT) + operator.DESCENDANT_WAIT + 10)

    def test_default_reserve_is_held_before_provider_work(self):
        lease = operator.Lease('1970-01-01T00:25:00Z', epoch=lambda: 1000, monotonic=lambda: 0)
        self.assertEqual(lease.remaining(), 335)

    def test_clock_rollback_does_not_extend_owned_provider_window(self):
        clock = [1000, 0]
        lease = operator.Lease('1970-01-01T00:25:00Z', epoch=lambda: clock[0], monotonic=lambda: clock[1])
        clock[:] = [900, 100]
        self.assertEqual(lease.remaining(), 235)
        clock[:] = [900, -1]
        with self.assertRaises(ValueError): lease.remaining()

    def test_missing_zone_expired_and_overlong_leases_are_rejected(self):
        for stamp in ['1970-01-01T00:25:00', '1970-01-01T00:16:00Z', '1970-01-01T01:00:00Z']:
            with self.assertRaises(ValueError): operator.Lease(stamp, epoch=lambda: 1000, monotonic=lambda: 0)

    def test_bound_source_copy_cannot_rebind_changed_source(self):
        with tempfile.TemporaryDirectory() as root:
            source, target = Path(root)/'source', Path(root)/'target'
            source.write_bytes(b'old'); expected = hashlib.sha256(b'old').hexdigest()
            self.assertEqual(operator.copy_bound_source(source, target, expected)['sha256'], expected)
            source.write_bytes(b'changed')
            with self.assertRaises(ValueError): operator.copy_bound_source(source, target, expected)

    def test_artifact_hash_rejects_symlinks_and_byte_overflow(self):
        with tempfile.TemporaryDirectory() as root:
            source, link = Path(root)/'source', Path(root)/'link'
            source.write_bytes(b'ninebytes'); link.symlink_to(source)
            with self.assertRaises(ValueError): operator.digest(link)
            with self.assertRaises(ValueError): operator.digest(source, limit=8)

    def test_helper_search_selects_the_declared_jpeg_grim_ahead_of_system_grim(self):
        with tempfile.TemporaryDirectory() as root:
            base, jpeg = Path(root)/'base', Path(root)/'jpeg'
            base.mkdir(); jpeg.mkdir()
            for name in operator.TOOLS:
                path = base/name; path.write_text('#!/bin/sh\nexit 99\n'); path.chmod(0o700)
            special = jpeg/'grim'; special.write_text('#!/bin/sh\nexit 98\n'); special.chmod(0o700)
            tools = {name:{'path':str((special if name=='grim' else base/name).resolve())} for name in operator.TOOLS}
            search = operator.helper_search_path(tools)
            for name in operator.TOOLS: self.assertEqual(str(Path(shutil.which(name, path=search)).resolve()), tools[name]['path'])

    def test_provider_default_preflight_rejects_invalid_source_without_any_actor(self):
        with self.assertRaises(ValueError): operator.prepared_descriptor({'schemaVersion': 1, 'sourceCommit': 'private-invalid'})

    def test_outer_cleanup_removes_killed_provider_private_state_and_atomic_fixture_temp(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);provider=root/'provider';provider.mkdir()
            receipt=b'{"schemaVersion":1,"success":false,"failureCode":"NATIVE21_ACCEPTANCE_INCOMPLETE"}'
            (provider/'receipt.json').write_bytes(receipt)
            program="from pathlib import Path;import os,signal,sys;p=Path(sys.argv[1]);(p/'state').mkdir();(p/'state/session.jsonl').write_text('private-fixture-input');(p/'openclaw.json').write_text('private-token');(p/'console.log').write_text('private-fixture-input');os.kill(os.getpid(),signal.SIGKILL)"
            child=subprocess.Popen([sys.executable,'-I','-B','-c',program,str(provider)]);self.assertEqual(child.wait(timeout=5),-9)
            for name in ['fixture-state-private.json','fixture-state-private.tmp','execution-descriptor-private.json','provider-fixture-binding.json','provider-private.log']:(root/name).write_text('private-fixture-input')
            (root/'home').mkdir();(root/'home/credential').write_text('private-token')
            self.assertEqual(operator.cleanup_private_state(root),[])
            self.assertEqual(sorted(p.name for p in root.iterdir()),['provider'])
            self.assertEqual(sorted(p.name for p in provider.iterdir()),['receipt.json']);self.assertEqual((provider/'receipt.json').read_bytes(),receipt)

    def test_outer_cleanup_never_follows_provider_or_nested_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);outside=root/'outside';outside.mkdir();sentinel=outside/'keep';sentinel.write_text('unrelated')
            owned=root/'owned';owned.mkdir();(owned/'provider').symlink_to(outside,target_is_directory=True)
            self.assertEqual(operator.cleanup_private_state(owned),[]);self.assertFalse((owned/'provider').exists());self.assertEqual(sentinel.read_text(),'unrelated')
            provider=owned/'provider';provider.mkdir();(provider/'nested').symlink_to(outside,target_is_directory=True)
            self.assertEqual(operator.cleanup_private_state(owned),[]);self.assertEqual(list(provider.iterdir()),[]);self.assertEqual(sentinel.read_text(),'unrelated')


if __name__ == '__main__': unittest.main()
