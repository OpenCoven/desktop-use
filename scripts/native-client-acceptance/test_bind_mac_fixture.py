import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('bind_mac_fixture',Path(__file__).with_name('bind-mac-fixture.py'))
binding=importlib.util.module_from_spec(spec);spec.loader.exec_module(binding)


class BindMacFixtureTests(unittest.TestCase):
    def prepare(self, directory):
        root=Path(directory);contents=root/'DesktopUseAcceptance.app/Contents'
        (contents/'MacOS').mkdir(parents=True);(root/'consumer').mkdir()
        image=contents/'MacOS/DesktopUseAcceptance';image.write_bytes(b'owned-fixture')
        info=contents/'Info.plist';info.write_bytes(plistlib.dumps({'CFBundleIdentifier':'org.opencoven.desktopuse.acceptance.run-1234'}))
        module=root/'consumer/mac_owned_processes.py';module.write_bytes(b'qualified-module-placeholder')
        sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        (root/'baseline.json').write_text(json.dumps({'fixtureBundleIdentifier':'org.opencoven.desktopuse.acceptance.run-1234','fixtureInfoPlistSha256':sha(info),'fixtureBinarySha256':sha(image),'consumerScriptsSha256':{'mac_owned_processes.py':sha(module)}}))
        (root/'fixture-state.json').write_text(json.dumps({'ready':True,'focused':True,'pid':42,'windowNumber':88}))
        identity={'pid':42,'uid':501,'birthSeconds':100,'birthMicroseconds':200,'path':str(image.resolve())}
        class Table:
            def info(self,pid):
                if pid!=42: raise AssertionError('unexpected PID lookup')
                return dict(identity)
        return root,identity,Table()

    def test_new_launch_binds_exact_process_and_window_once(self):
        self.assertTrue(callable(getattr(binding,'bind_owner',None)))
        with tempfile.TemporaryDirectory() as directory:
            root,identity,table=self.prepare(directory)
            owner=binding.bind_owner(root,42,table)
            self.assertEqual(owner['path'],identity['path']);self.assertEqual(owner['windowNumber'],88)
            with self.assertRaises(FileExistsError):binding.bind_owner(root,42,table)
            self.assertEqual(json.loads((root/'fixture-owner.json').read_text()),owner)

    def test_old_fixture_with_same_executable_name_cannot_be_adopted(self):
        self.assertTrue(callable(getattr(binding,'bind_owner',None)))
        with tempfile.TemporaryDirectory() as directory:
            root,identity,table=self.prepare(directory);identity['path']='/old.app/Contents/MacOS/DesktopUseAcceptance'
            with self.assertRaises(AssertionError):binding.bind_owner(root,42,table)
            self.assertFalse((root/'fixture-owner.json').exists())

    def test_changed_bundle_or_window_state_cannot_create_an_owner_record(self):
        self.assertTrue(callable(getattr(binding,'bind_owner',None)))
        for change in ['plist','pid','focus']:
            with self.subTest(change=change),tempfile.TemporaryDirectory() as directory:
                root,identity,table=self.prepare(directory)
                if change=='plist':(root/'DesktopUseAcceptance.app/Contents/Info.plist').write_bytes(b'changed')
                else:
                    path=root/'fixture-state.json';state=json.loads(path.read_text());state['pid' if change=='pid' else 'focused']=43 if change=='pid' else False;path.write_text(json.dumps(state))
                with self.assertRaises(AssertionError):binding.bind_owner(root,42,table)
                self.assertFalse((root/'fixture-owner.json').exists())


if __name__=='__main__':unittest.main()
