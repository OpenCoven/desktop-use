"""Actual held-lock startup regression inside one fresh, isolated Xvfb namespace."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def main():
    assert sys.platform == 'linux' and os.environ.get('NATIVE_OWNED_DISPOSABLE_DISPLAY') == 'yes'
    assert len(sys.argv) == 4
    adapter, expected_hash, receipt = sys.argv[1:]
    assert Path(adapter).is_absolute() and not Path(receipt).exists()
    assert hashlib.sha256(Path(adapter).read_bytes()).hexdigest() == expected_hash
    assert Path('/.dockerenv').is_file(), 'fresh owned namespace required'
    assert not Path('/tmp/.X11-unix/X91').exists() and not Path('/tmp/.X91-lock').exists()
    def interrupted(number, _frame):
        raise SystemExit(128 + number)
    for number in [signal.SIGTERM, signal.SIGINT, signal.SIGALRM]: signal.signal(number, interrupted)
    signal.alarm(30)
    env = {**os.environ, 'DISPLAY': ':91', 'XDG_SESSION_TYPE': 'x11'}
    server = None
    x11 = ctypes.CDLL('libX11.so.6'); xtst = ctypes.CDLL('libXtst.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]; x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]; x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    class KeyboardState(ctypes.Structure):
        _fields_ = [('group', ctypes.c_ubyte), ('locked_group', ctypes.c_ubyte), ('base_group', ctypes.c_ushort), ('latched_group', ctypes.c_ushort),
                    *[(name, ctypes.c_ubyte) for name in ('mods','base_mods','latched_mods','locked_mods','compat','grab','compat_grab','lookup','compat_lookup')], ('buttons', ctypes.c_ushort)]
    x11.XkbGetState.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(KeyboardState)]
    x11.XkbLockModifiers.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint]
    x11.XkbLockGroup.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]
    display = None; initial_keys = initial_state = None; held = None
    report = {'schemaVersion':1, 'session':'owned-virtual-X11', 'physicalDisplayVerified':False,
              'nativeSha256':expected_hash, 'cases':[], 'qualified':False}
    def state():
        value = KeyboardState(); assert x11.XkbGetState(display, 0x100, ctypes.byref(value)) == 0
        return value.locked_mods, value.locked_group
    def keys():
        value = ctypes.create_string_buffer(32); assert x11.XQueryKeymap(display, value)
        return value.raw
    try:
        server = subprocess.Popen(['Xvfb', ':91', '-screen', '0', '1280x960x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.monotonic() + 8
        while time.monotonic() < end and server.poll() is None:
            display = x11.XOpenDisplay(b':91')
            if display: break
            time.sleep(.02)
        assert display and server.poll() is None
        birth = Path(f'/proc/{server.pid}/stat').read_text().rsplit(')',1)[1].split()[19]
        initial_keys, initial_state = keys(), state()
        assert initial_keys == bytes(32)
        for name, symbol in [('Num_Lock',0xff7f),('Scroll_Lock',0xff14)]:
            assert server.poll() is None and Path(f'/proc/{server.pid}/stat').read_text().rsplit(')',1)[1].split()[19] == birth
            code = int(x11.XKeysymToKeycode(display,symbol)); assert code > 0
            held = code; assert xtst.XTestFakeKeyEvent(display,code,1,0); x11.XSync(display,0)
            before = keys(); assert before[code // 8] & (1 << (code % 8))
            for action, args in [('keyboard',['keypress','--keys','a']),('pointer',['click','--coords','20,30'])]:
                run = subprocess.run([adapter,*args,'--confirm','--timeout-ms','1000'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
                assert not run.stderr
                outcome = json.loads(run.stdout)
                row = {'heldLock':name,'action':action,'nativeExitCode':run.returncode,'ok':outcome.get('ok'),
                       'code':outcome.get('code'),'cleanupState':outcome.get('inputCleanup',{}).get('state'),
                       'preheldKeyPreserved': bool(keys()[code//8] & (1 << (code%8)))}
                report['cases'].append(row)
            assert xtst.XTestFakeKeyEvent(display,code,0,0); x11.XSync(display,0); held = None
            assert x11.XkbLockModifiers(display,0x100,255,initial_state[0])
            assert x11.XkbLockGroup(display,0x100,initial_state[1]); x11.XSync(display,0)
            assert keys() == initial_keys and state() == initial_state
        report['qualified'] = all(row['ok'] is True and row['preheldKeyPreserved'] for row in report['cases'])
    finally:
        signal.alarm(0)
        for number in [signal.SIGTERM,signal.SIGINT,signal.SIGALRM]: signal.signal(number,signal.SIG_IGN)
        if display:
            if held is not None:
                assert xtst.XTestFakeKeyEvent(display,held,0,0); x11.XSync(display,0)
            if initial_state is not None:
                assert x11.XkbLockModifiers(display,0x100,255,initial_state[0])
                assert x11.XkbLockGroup(display,0x100,initial_state[1]); x11.XSync(display,0)
                report['keyboardRecovered'] = keys() == initial_keys and state() == initial_state
            x11.XCloseDisplay(display)
        if server is not None:
            if server.poll() is None: server.terminate()
            try: server.wait(timeout=3)
            except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=3)
            report['serverReaped'] = True
        with Path(receipt).open('x') as stream: json.dump(report,stream,indent=2); stream.write('\n')
    print(json.dumps(report))
    return 0 if report['qualified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
