"""No desktop needed: real detached Linux descendants must not survive the guard."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == 'linux', 'Linux subreaper/proc contract')
class OwnedProcessGuardTests(unittest.TestCase):
    def test_platform_guard_gets_time_to_finish_parent_cleanup(self):
        module = str(Path(__file__).resolve().parent)
        with tempfile.TemporaryDirectory() as directory:
            guard = """import ctypes,signal,sys,time
from pathlib import Path
ctypes.CDLL(None).prctl(15,b'coven-x11-guard',0,0,0)
signal.signal(signal.SIGTERM,lambda *_:Path(sys.argv[1],'premature-guard-term').write_text('bad'))
Path(sys.argv[1],'guard-ready').write_text('ready')
time.sleep(60)
"""
            parent = """import os,signal,subprocess,sys,time
from pathlib import Path
p=subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]])
while not Path(sys.argv[2],'guard-ready').exists():time.sleep(.01)
def cleanup(*_):
 time.sleep(.1)
 Path(sys.argv[2],'parent-cleaned').write_text('done')
 p.kill();p.wait();sys.exit(0)
signal.signal(signal.SIGTERM,cleanup)
Path(sys.argv[2],'parent-ready').write_text('ready')
time.sleep(60)
"""
            wrapper = """import subprocess,sys,time
from pathlib import Path
from owned_process_guard import install_recovery_handlers,begin_recovery
install_recovery_handlers()
p=subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]])
while not Path(sys.argv[3],'parent-ready').exists():time.sleep(.01)
begin_recovery()
"""
            subprocess.run([sys.executable, '-c', wrapper, parent, guard, directory], env={**os.environ, 'PYTHONPATH': module}, check=True, timeout=15)
            self.assertTrue(Path(directory, 'parent-cleaned').exists())
            self.assertFalse(Path(directory, 'premature-guard-term').exists())

    def test_orphan_and_timed_out_detached_descendants_are_reaped(self):
        module = str(Path(__file__).resolve().parent)
        for mode in ['orphan', 'timeout', 'interrupted']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                pidfile = str(Path(directory)/'pid')
                worker = """import subprocess,sys,time
p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
open(sys.argv[1],'w').write(str(p.pid))
if sys.argv[2] in ['timeout','interrupted']:time.sleep(60)
"""
                wrapper = """import subprocess,sys,time
from owned_process_guard import install_recovery_handlers,begin_recovery
install_recovery_handlers()
try:
 p=subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2],sys.argv[3]],start_new_session=True)
 try:p.wait(timeout=1)
 except subprocess.TimeoutExpired:pass
finally:begin_recovery()
"""
                command = [sys.executable, '-c', wrapper, worker, pidfile, mode]
                env = {**os.environ, 'PYTHONPATH': module}
                if mode == 'interrupted':
                    import signal, time
                    runner = subprocess.Popen(command, env=env)
                    end = time.monotonic() + 5
                    while not Path(pidfile).exists():
                        self.assertLess(time.monotonic(), end)
                        time.sleep(.01)
                    runner.send_signal(signal.SIGTERM)
                    self.assertEqual(runner.wait(timeout=15), 128 + signal.SIGTERM)
                else:
                    subprocess.run(command, env=env, check=True, timeout=15)
                pid = int(Path(pidfile).read_text())
                self.assertFalse(Path(f'/proc/{pid}').exists(), 'Detached helper must be reaped before return')


if __name__ == '__main__':
    unittest.main()
