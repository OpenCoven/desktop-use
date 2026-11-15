"""Bind only a newly launched fixture; no app launch, desktop action or signal."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re


def bind_owner(root, pid, table=None):
    if not __debug__:
        raise RuntimeError('fixture binding requires non-optimized Python')
    root=Path(root).resolve(strict=True)
    baseline=json.loads((root/'baseline.json').read_text())
    assert re.fullmatch(r'org\.opencoven\.desktopuse\.acceptance\.run-[a-z0-9-]{4,}',baseline.get('fixtureBundleIdentifier',''))
    contents=root/'DesktopUseAcceptance.app/Contents'
    image=(contents/'MacOS/DesktopUseAcceptance').resolve(strict=True)
    info=(contents/'Info.plist').read_bytes()
    assert len(info)<=65536 and hashlib.sha256(info).hexdigest()==baseline['fixtureInfoPlistSha256']
    assert plistlib.loads(info)['CFBundleIdentifier']==baseline['fixtureBundleIdentifier']
    assert image.stat().st_size<=8*1024*1024 and hashlib.sha256(image.read_bytes()).hexdigest()==baseline['fixtureBinarySha256']
    module=root/'consumer/mac_owned_processes.py'
    assert hashlib.sha256(module.read_bytes()).hexdigest()==baseline['consumerScriptsSha256']['mac_owned_processes.py']
    if table is None:
        spec=importlib.util.spec_from_file_location('owned_fixture_processes',module)
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        table=m.DarwinProcessTable()
    before=table.info(pid)
    assert before and before['pid']==pid and before['path']==str(image)
    assert before['birthSeconds']>0 and 0<=before['birthMicroseconds']<1_000_000
    state=json.loads((root/'fixture-state.json').read_text())
    assert state['ready'] and state['focused'] and state['pid']==pid
    assert isinstance(state['windowNumber'],int) and state['windowNumber']>0
    after=table.info(pid)
    fields=['pid','uid','birthSeconds','birthMicroseconds','path']
    assert after and all(before[k]==after[k] for k in fields)
    owner={k:after[k] for k in fields};owner['windowNumber']=state['windowNumber']
    fd=os.open(root/'fixture-owner.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as out:json.dump(owner,out,indent=2);out.write('\n')
    return owner


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--pid',type=int,required=True)
    args=parser.parse_args()
    print(json.dumps(bind_owner(args.root,args.pid)))
