#!/usr/bin/env python3
"""Prepare an isolated installed consumer and fixture; never launch or grant permissions."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import subprocess
import sys
import tarfile
import PIL
from PIL import Image, ImageCms  # Verify both decoder and ICC support before preparing a run.


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--package', type=Path, required=True)
    p.add_argument('--adapter', type=Path, required=True)
    p.add_argument('--peekaboo-directory', type=Path, required=True)
    args = p.parse_args()
    assert os.uname().sysname == 'Darwin'
    source = Path(__file__).resolve().parents[2]
    package, adapter, helper = args.package.resolve(), args.adapter.resolve(), args.peekaboo_directory.resolve()
    with tarfile.open(package) as archive:
        members = archive.getmembers()
        assert all(not PurePosixPath(m.name).is_absolute() and '..' not in PurePosixPath(m.name).parts and (m.isfile() or m.isdir()) for m in members)
        assert sum(m.size for m in members) < 64*1024*1024
        names = {m.name for m in members if m.isfile()}
        manifest = json.load(archive.extractfile('package/package.json'))
        assert manifest['name'] == '@opencoven/openclaw-desktop-use'
        required = [manifest['main'], manifest['types'], manifest['exports']['./sdk']['import'], manifest['exports']['./sdk']['types'], manifest['exports']['./contracts']['import'], manifest['bin']['coven-desktop-use-mcp']]
        for name in required:
            assert 'package/'+name.removeprefix('./') in names, f'missing compiled public entry: {name}'
        assert 'package/dist/examples/approval-host/main.js' in names
    root = args.root.resolve()
    root.mkdir(mode=0o700)  # Refuse to reuse another run's files.
    (root/'bin').mkdir(mode=0o700)
    shutil.copy2(adapter, root/'bin/coven-desktop-use')
    shutil.copytree(helper, root/'peekaboo')
    (root/'bin/peekaboo').symlink_to('../peekaboo/peekaboo')
    shutil.copy2(package, root/'candidate.tgz')
    consumer = root/'consumer'; consumer.mkdir(mode=0o700)
    (consumer/'package.json').write_text(json.dumps({'private': True, 'type': 'module'}))
    install = subprocess.run(['npm','install','--ignore-scripts','--no-audit','--no-fund',str(root/'candidate.tgz'),'@modelcontextprotocol/client@2.4.0'], cwd=consumer, capture_output=True, text=True, timeout=180)
    if install.returncode:
        (root/'install-private.log').write_text(install.stdout+install.stderr)
        raise RuntimeError('Consumer installation failed; inspect the task-private log.')
    for name in ['native-client.mjs','sdk-security.mjs','mcp-security.mjs','image-proof.py','identity-preflight.mjs']:
        shutil.copy2(Path(__file__).with_name(name), consumer/name)
    shutil.copy2(source/'src/mcp/fixtures/pty-host.py', consumer/'pty-host.py')
    bundle = root/'DesktopUseAcceptance.app'/'Contents'
    (bundle/'MacOS').mkdir(parents=True)
    (bundle/'Resources').mkdir()
    (bundle/'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'DesktopUseAcceptance','CFBundleIdentifier':'org.opencoven.desktopuse.acceptance','CFBundleName':'Desktop Use Acceptance','CFBundleVersion':'1','CFBundlePackageType':'APPL','NSHighResolutionCapable':True}))
    (bundle/'Resources/runtime.json').write_text(json.dumps({'statePath':str(root/'fixture-state.json')}))
    subprocess.run(['swiftc',str(Path(__file__).with_name('Fixture.swift')),'-o',str(bundle/'MacOS/DesktopUseAcceptance')], check=True, timeout=120, capture_output=True)
    installed = consumer/'node_modules/@opencoven/openclaw-desktop-use'
    with tarfile.open(package) as archive:
        for member in archive.getmembers():
            if member.isfile():
                assert (installed/member.name.removeprefix('package/')).read_bytes() == archive.extractfile(member).read()
    version = subprocess.run([str(root/'bin/peekaboo'),'--version','--json','--no-remote'],check=True,capture_output=True,text=True,timeout=10)
    identity = json.loads(version.stdout)['data']
    git = lambda *parts: subprocess.check_output(['git','-C',str(source),*parts],text=True).strip()
    receipt = {'sourceCommit':git('rev-parse','HEAD'),'sourceTree':git('rev-parse','HEAD^{tree}'),'sourceDiffSha256':hashlib.sha256(git('diff','HEAD','--','src').encode()).hexdigest(),
               'packageSha256':sha(package),'packageVersion':manifest['version'],'packageFiles':len(names),'allInstalledPackageFilesExact':True,'nativeSha256':sha(adapter),
               'helperSha256':sha(helper/'peekaboo'),'helperVersion':identity.get('current'),'helperSourceCommit':identity.get('sourceCommit'),
               'fixtureSourceSha256':sha(Path(__file__).with_name('Fixture.swift')),'pythonExecutable':sys.executable,'pythonVersion':sys.version.split()[0],'pillowVersion':PIL.__version__,'publication':False,'fixtureLaunched':False,'privacyChanges':False}
    (root/'baseline.json').write_text(json.dumps(receipt,indent=2)+'\n')
    (root/'run-env.json').write_text(json.dumps({'PATH':str(root/'bin')+os.pathsep+os.environ.get('PATH',''),'NATIVE_ACCEPTANCE_PYTHON':sys.executable,'NATIVE_ACCEPTANCE_ROOT':str(root),'NATIVE_ACCEPTANCE_ADAPTER':str(root/'bin/coven-desktop-use'),'NATIVE_ACCEPTANCE_FIXTURE_STATE':str(root/'fixture-state.json'),'NATIVE_ACCEPTANCE_IMAGE_PROOF':str(consumer/'image-proof.py'),'NATIVE_ACCEPTANCE_PTY':str(consumer/'pty-host.py')},indent=2)+'\n')
    print(json.dumps({'root':str(root),'fixtureApp':str(bundle.parent),'baseline':receipt}))


if __name__ == '__main__': main()
