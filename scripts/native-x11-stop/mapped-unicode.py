#!/usr/bin/env python3
"""Two-row layout test; requires an explicit temporary-mapping lease addition."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from owned_process_guard import install_recovery_handlers, begin_recovery


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('adapter', 'native-sha256', 'baseline-adapter', 'baseline-sha256', 'display', 'fixture-state', 'receipt', 'lease-expires'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--server-pid', type=int, required=True)
    p.add_argument('--fixture-pid', type=int, required=True)
    p.add_argument('--temporary-two-row-mapping-authorized', action='store_true', required=True)
    p.add_argument('--interrupt-after-layout', action='store_true', help='Exercise SIGTERM recovery immediately after the authorized mapping change.')
    a = p.parse_args()
    install_recovery_handlers()
    from datetime import datetime, timezone
    assert datetime.now(timezone.utc).timestamp() + 60 < datetime.fromisoformat(a.lease_expires.replace('Z', '+00:00')).timestamp()
    for path, sha in ((a.adapter, a.native_sha256), (a.baseline_adapter, a.baseline_sha256)):
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == sha
    server = Path(f'/proc/{a.server_pid}')
    assert server.joinpath('cmdline').read_bytes().split(b'\0')[:-1] == [b'Xvfb', a.display.encode(), b'-screen', b'0', b'1280x960x24', b'-nolisten', b'tcp']
    server_birth = server.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19]
    def fixture():
        state = json.loads(Path(a.fixture_state).read_text())
        assert state['pid'] == a.fixture_pid and state['ready']
        return state
    fixture()
    x = ctypes.CDLL('libX11.so.6')
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]; x.XOpenDisplay.restype = ctypes.c_void_p
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x.XDisplayKeycodes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
    x.XGetKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    x.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
    x.XChangeKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_ulong), ctypes.c_int]
    x.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x.XFree.argtypes = [ctypes.c_void_p]; x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    class ModifierMap(ctypes.Structure):
        _fields_ = [('width', ctypes.c_int), ('codes', ctypes.POINTER(ctypes.c_ubyte))]
    x.XGetModifierMapping.argtypes = [ctypes.c_void_p]; x.XGetModifierMapping.restype = ctypes.POINTER(ModifierMap)
    x.XFreeModifiermap.argtypes = [ctypes.POINTER(ModifierMap)]
    d = x.XOpenDisplay(a.display.encode()); assert d
    low, high = ctypes.c_int(), ctypes.c_int(); x.XDisplayKeycodes(d, ctypes.byref(low), ctypes.byref(high))
    def mapping():
        width = ctypes.c_int(); values = x.XGetKeyboardMapping(d, low.value, high.value - low.value + 1, ctypes.byref(width))
        assert values and 1 <= width.value <= 32
        result = {code: tuple(values[(code - low.value) * width.value + i] for i in range(width.value)) for code in range(low.value, high.value + 1)}
        x.XFree(values); return result
    def modifiers():
        value = x.XGetModifierMapping(d); assert value and 1 <= value.contents.width <= 32
        result = tuple(value.contents.codes[i] for i in range(value.contents.width * 8))
        x.XFreeModifiermap(value); return result
    def keys():
        data = ctypes.create_string_buffer(32); assert x.XQueryKeymap(d, data)
        return {key for key in range(256) if data.raw[key // 8] & (1 << (key % 8))}
    def same_row(left, right):
        width = max(len(left), len(right))
        return all((left[i] if i < len(left) else 0) == (right[i] if i < len(right) else 0) for i in range(width))
    initial = mapping(); initial_modifiers = modifiers(); assert not keys()
    rows = [code for code in reversed(range(low.value, high.value)) if not any(initial[code]) and code not in initial_modifiers][:2]
    assert len(rows) == 2
    symbols = (0xe9, 0x0101f600)
    def set_row(code, values):
        data = (ctypes.c_ulong * len(values))(*values)
        x.XChangeKeyboardMapping(d, code, len(values), data, 1); x.XSync(d, 0)
    env = {**os.environ, 'DISPLAY': a.display, 'XDG_SESSION_TYPE': 'x11'}
    receipt = {'session': 'owned-virtual-x11', 'physicalDisplayVerified': False, 'scope': 'explicitly-mapped-Unicode-only',
               'nativeSha256': a.native_sha256, 'baselineSha256': a.baseline_sha256, 'temporaryRows': rows,
               'originalRows': [list(initial[code]) for code in rows], 'nonmodifierExclusionVerified': True, 'results': []}
    try:
        for code, symbol in zip(rows, symbols):
            set_row(code, (symbol,) + (0,) * (len(initial[code]) - 1))
        active = mapping()
        assert all(active[code][0] == symbol for code, symbol in zip(rows, symbols))
        assert modifiers() == initial_modifiers
        assert all(same_row(initial[code], active[code]) for code in initial if code not in rows)
        receipt['activeRows'] = [list(active[code]) for code in rows]
        if a.interrupt_after_layout:
            os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(.25)  # Let the actual fixture consume its mapping notifications.
        for label, adapter in (('baseline', a.baseline_adapter), ('candidate', a.adapter)):
            before = len(fixture()['keys'])
            run = subprocess.run([adapter, 'type-text', '--text', 'é😀', '--confirm'], env=env, capture_output=True, timeout=5)
            result = json.loads(run.stdout); assert result['ok'] and not run.stderr
            time.sleep(.3)
            events = fixture()['keys'][before:]
            assert ''.join(event['text'] for event in events) == 'é😀', 'mapped sample did not reach the actual fixture'
            assert not keys()
            assert all(same_row(active[code], mapping()[code]) for code in rows)
            if label == 'candidate':
                assert result['inputCleanup']['state'] == 'verified'
            receipt['results'].append({'candidate': label == 'candidate', 'observedFixtureTextMatch': True,
                                       'visibleKeyEvents': len(events), 'inputCleanup': result.get('inputCleanup'), 'passed': True})
        receipt['success'] = True
    finally:
        begin_recovery()
        assert server.joinpath('stat').read_text().rsplit(')', 1)[1].split()[19] == server_birth
        # No global key sweep and no persistent keyboard/layout configuration.
        assert keys() <= set(rows)
        for code in keys():
            subprocess.run(['/usr/bin/xdotool', 'keyup', str(code)], env=env, check=True, timeout=3)
        for code in rows:
            set_row(code, initial[code])
        final = mapping()
        restored = all(same_row(initial[code], final[code]) for code in initial)
        assert restored and modifiers() == initial_modifiers and not keys()
        receipt['recovery'] = {'completeMappingRestored': restored, 'modifierMapPreserved': True, 'keyStateRestored': True}
        x.XCloseDisplay(d)
        Path(a.receipt).write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
