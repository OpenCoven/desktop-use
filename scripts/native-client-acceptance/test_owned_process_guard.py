"""No desktop needed: real detached Linux descendants must not survive the guard."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'linux', 'Linux subreaper/proc contract')
class OwnedProcessGuardTests(unittest.TestCase):
    def test_orphan_and_timed_out_detached_descendants_are_reaped(self):
        module = str(Path(__file__).resolve().parent)
        for mode in ['orphan', 'timeout']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                pidfile = str(Path(directory)/'pid')
                worker = """import subprocess,sys,time
p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
open(sys.argv[1],'w').write(str(p.pid))
if sys.argv[2]=='timeout':time.sleep(60)
"""
                wrapper = """import subprocess,sys,time
from owned_process_guard import enable_subreaper,terminate_owned_descendants
enable_subreaper()
try:
 p=subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]],start_new_session=True)
 try:p.wait(timeout=1)
 except subprocess.TimeoutExpired:pass
finally:terminate_owned_descendants()
"""
                subprocess.run([sys.executable, '-c', wrapper, worker, pidfile, mode], env={**os.environ, 'PYTHONPATH': module}, check=True, timeout=15)
                pid = int(Path(pidfile).read_text())
                self.assertFalse(Path(f'/proc/{pid}').exists(), 'Detached helper must be reaped before return')


if __name__ == '__main__':
    unittest.main()
