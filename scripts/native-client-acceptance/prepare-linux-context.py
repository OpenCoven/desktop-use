#!/usr/bin/env python3
"""Stage only required public source/artifacts; never send a checkout or credentials to Docker."""
import argparse
from pathlib import Path
import shutil

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--package', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
source = Path(__file__).resolve().parents[2]
root = a.output.resolve()
root.mkdir(mode=0o700)
for name in ['Cargo.toml','Cargo.lock']:
    shutil.copy2(source/name,root/name)
for name in ['src','tests','contracts','vendor']:
    shutil.copytree(source/name,root/name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
shutil.copytree(source/'scripts/native-image-fixture',root/'fixture',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
shutil.copytree(Path(__file__).parent,root/'acceptance',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
shutil.copy2(source/'src/mcp/fixtures/pty-host.py',root/'pty-host.py')
shutil.copy2(a.package.resolve(),root/'candidate.tgz')
shutil.copy2(Path(__file__).with_name('Dockerfile'),root/'Dockerfile')
print(root)
