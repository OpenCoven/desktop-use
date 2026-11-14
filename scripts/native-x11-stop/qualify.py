#!/usr/bin/env python3
"""Opt-in real XTest regression; requires an exclusive disposable Xvfb lease."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from x11_state import clock_bounds, clock_delta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("adapter", "adapter-sha256", "baseline-adapter", "baseline-sha256", "display", "fixture-state", "fixture-title", "receipt", "lease-expires"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--server-pid", type=int, required=True)
    parser.add_argument("--fixture-pid", type=int, required=True)
    args = parser.parse_args()
    from datetime import datetime, timezone
    expires = datetime.fromisoformat(args.lease_expires.replace("Z", "+00:00"))
    assert datetime.now(timezone.utc).timestamp() + 90 < expires.timestamp(), "lease too short"
    assert args.server_pid > 1 and args.fixture_pid > 1
    for path, expected in ((args.adapter, args.adapter_sha256), (args.baseline_adapter, args.baseline_sha256)):
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == expected
    server = Path(f"/proc/{args.server_pid}")
    expected_server = [b"Xvfb", args.display.encode(), b"-screen", b"0", b"1280x960x24", b"-nolisten", b"tcp"]
    assert server.joinpath("cmdline").read_bytes().split(b"\0")[:-1] == expected_server
    server_start = server.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19]
    env = {**os.environ, "DISPLAY": args.display, "XDG_SESSION_TYPE": "x11"}
    state_path = Path(args.fixture_state)
    def fixture():
        state = json.loads(state_path.read_text())
        assert state["pid"] == args.fixture_pid and state["ready"]
        return state
    fixture()
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(args.display.encode())
    assert display
    offset_lower, offset_upper = clock_bounds(x11, display)
    def keys():
        buffer = ctypes.create_string_buffer(32)
        assert x11.XQueryKeymap(display, buffer)
        return {key for key in range(256) if buffer.raw[key // 8] & (1 << (key % 8))}
    initial = keys()
    assert not initial, "fixture keyboard must start idle"
    introduced = set()
    introduced_buttons = set()
    processes = []
    helpers = set()
    results = []
    receipt = {"schemaVersion": 1, "session": "owned-virtual-x11", "physicalDisplayVerified": False,
               "clockCalibrationMs": {"lower": offset_lower, "upper": offset_upper}, "serverStartTicks": server_start,
               "nativeSha256": args.adapter_sha256, "baselineSha256": args.baseline_sha256, "results": results}

    def invoke(adapter, *argv):
        run = subprocess.run([adapter, *argv], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
        assert not run.stderr, "native diagnostics must be empty"
        return json.loads(run.stdout)

    def xdo(*argv):
        subprocess.run(["/usr/bin/xdotool", *argv], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=3)

    def settle():
        last = None
        stable = 0
        end = time.monotonic() + 5
        while time.monotonic() < end:
            count = len(fixture()["keys"])
            stable = stable + 1 if count == last else 0
            last = count
            if stable >= 4:
                return
            time.sleep(.05)
        raise AssertionError("fixture did not settle")

    def own_key(key, down):
        if down:
            assert key not in keys()
            introduced.add(key)
        xdo("keydown" if down else "keyup", str(key))
        if not down:
            introduced.discard(key)

    x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                 ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                 ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
    def pointer():
        root, child = ctypes.c_ulong(), ctypes.c_ulong()
        rx, ry, wx, wy = (ctypes.c_int() for _ in range(4))
        umask = ctypes.c_uint()
        assert x11.XQueryPointer(display, x11.XDefaultRootWindow(display), ctypes.byref(root), ctypes.byref(child),
                                 ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(umask))
        return rx.value, ry.value, (umask.value >> 8) & 31
    initial_pointer = pointer()
    assert initial_pointer[2] == 0
    class KeyboardState(ctypes.Structure):
        _fields_ = [("group", ctypes.c_ubyte), ("locked_group", ctypes.c_ubyte), ("base_group", ctypes.c_ushort), ("latched_group", ctypes.c_ushort),
                    *[(name, ctypes.c_ubyte) for name in ("mods", "base_mods", "latched_mods", "locked_mods", "compat", "grab", "compat_grab", "lookup", "compat_lookup")],
                    ("buttons", ctypes.c_ushort)]
    x11.XkbGetState.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(KeyboardState)]
    x11.XkbLockModifiers.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    def caps():
        current = KeyboardState()
        assert x11.XkbGetState(display, 0x100, ctypes.byref(current)) == 0
        return current.locked_mods & 2
    initial_caps = caps()
    def set_caps(value):
        assert x11.XkbLockModifiers(display, 0x100, 2, value)
        x11.XSync(display, 0)

    def child_identity(pid):
        path = Path(f"/proc/{pid}")
        try:
            return (path.joinpath("comm").read_text().strip(), path.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19])
        except (FileNotFoundError, ProcessLookupError):
            return None

    def stop_held(mode, preheld=(), concurrent=()):
        for key in preheld:
            own_key(key, True)
        expected = keys()
        sample = "a" * 4000 + ("b" if 56 in concurrent else "")
        proc = subprocess.Popen([args.adapter, "type-text", "--text", sample, "--timeout-ms", "1000" if mode == "timeout" else "15000", "--confirm"],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        processes.append(proc)
        helper = None
        paused = False
        end = time.monotonic() + 7
        while time.monotonic() < end and proc.poll() is None:
            if helper is not None and child_identity(helper[0]) != helper[1]:
                helper = None
            if helper is None:
                try:
                    children = Path(f"/proc/{proc.pid}/task/{proc.pid}/children").read_text().split()
                    for pid in children:
                        identity = child_identity(int(pid))
                        if identity and identity[0] == "xdotool":
                            helper = (int(pid), identity)
                            helpers.add(helper)
                            break
                except (FileNotFoundError, ProcessLookupError):
                    pass
            if helper and 38 in keys():
                try:
                    os.kill(helper[0], signal.SIGSTOP)
                except ProcessLookupError:
                    helper = None
                    continue
                if 38 in keys():
                    paused = True
                    break
                os.kill(helper[0], signal.SIGCONT)
            time.sleep(.001)
        assert paused, "did not observe the actual helper holding the intended key"
        if 38 not in expected:
            introduced.add(38)
        for key in concurrent:
            own_key(key, True)
            expected.add(key)
        if mode == "cancel":
            os.kill(proc.pid, signal.SIGTERM)
        elif mode == "helper-failure":
            os.kill(helper[0], signal.SIGKILL)
        started = time.monotonic()
        out, err = proc.communicate(timeout=5)
        returned_ms = time.monotonic_ns() // 1_000_000
        result = json.loads(out)
        assert not err
        assert result.get("inputCleanup", {}).get("state") == "verified"
        assert result.get("code") == {"cancel": "CANCELLED", "timeout": "ETIMEDOUT", "helper-failure": "BACKEND_ERROR"}[mode]
        assert not Path(f"/proc/{helper[0]}").exists(), "owned helper not reaped"
        assert keys() == expected, "input state differs from scoped expected state"
        late = None
        queued = None
        if not expected:
            before = len(fixture()["keys"])
            time.sleep(.75)
            events = fixture()["keys"][before:]
            queued = sum(clock_delta(event["serverTimeMs"], returned_ms) <= offset_lower for event in events)
            late = len(events) - queued
            assert late == 0, "new or ambiguously timed fixture events after cancellation settled"
        results.append({"case": mode, "preheldKeyCount": len(preheld), "concurrentKeyCount": len(concurrent), "concurrentKeyAlsoOccursLaterInRequest": 56 in concurrent,
                        "actualHeldKeyObserved": True, "helperReaped": True, "keyStatePreserved": True,
                        "postReturnGeneratedOrAmbiguousEvents": late, "queuedPreReturnEventsDeliveredLater": queued,
                        "settlementMs": returned_ms - round(started * 1000),
                        "inputCleanup": result["inputCleanup"], "passed": True})
        for key in list(introduced):
            own_key(key, False)
        settle()
        assert keys() == initial

    try:
        for adapter in (args.baseline_adapter, args.adapter):
            assert invoke(adapter, "focus", "--window-title", args.fixture_title, "--confirm")["ok"]
            own_key(50, True)
            settle()
            before = len(fixture()["keys"])
            outcome = invoke(adapter, "type-text", "--text", "ab", "--confirm")
            assert outcome["ok"]
            settle()
            events = fixture()["keys"][before:]
            assert sum(event["name"] == "Shift_L" for event in events) == 1
            assert keys() == {50}
            results.append({"case": "one-modifier-transaction", "candidate": adapter == args.adapter,
                            "modifierPresses": 1, "visibleKeyEvents": len(events), "preheldStatePreserved": True, "passed": True})
            own_key(50, False)
            settle()
        for mode, preheld, concurrent in (("cancel", (), ()), ("timeout", (), ()), ("helper-failure", (), ()),
                                          ("cancel", (50,), ()), ("cancel", (38,), ()), ("cancel", (), (56,))):
            stop_held(mode, preheld, concurrent)
        before = len(fixture()["keys"])
        outcome = invoke(args.adapter, "type-text", "--text", "aA", "--confirm")
        assert outcome["ok"]
        settle()
        assert keys() == initial
        names = [event["name"] for event in fixture()["keys"][before:] if event["name"] != "Shift_L"]
        assert names == ["a", "A"]
        results.append({"case": "normal-mapped-text", "observedFixtureMatch": True, "inputCleanup": outcome["inputCleanup"], "passed": True})
        literal = "\t\n'\"\\$#- a"
        before = len(fixture()["keys"])
        outcome = invoke(args.adapter, "type-text", "--text", literal, "--confirm")
        assert outcome["ok"]
        settle()
        observed = ''.join(event['text'] for event in fixture()['keys'][before:]).replace('\r', '\n')
        assert observed == literal, 'literal operands changed through helper script mode'
        results.append({"case": "literal-control-operands", "observedFixtureMatch": True, "inputCleanup": outcome["inputCleanup"], "passed": True})
        for label, adapter in (("baseline", args.baseline_adapter), ("candidate", args.adapter)):
            before = len(fixture()["keys"])
            began = time.monotonic()
            outcome = invoke(adapter, "type-text", "--text", "a" * 600, "--timeout-ms", "1000", "--confirm")
            elapsed = time.monotonic() - began
            assert outcome["ok"], 'previously valid short-deadline typing regressed'
            settle()
            assert len(fixture()["keys"]) - before == 600
            assert keys() == initial
            results.append({"case": "600-scalars-1000ms-deadline", "candidate": label == "candidate", "actionMs": round(elapsed * 1000),
                            "observedFixtureCount": 600, "inputCleanup": outcome.get("inputCleanup"), "passed": True})
        # This default US fixture has no durable mapping for the Unicode samples.
        # A separate explicitly authorized layout test must establish their effect;
        # temporary xdotool scratch bindings can vanish before GTK translates them.
        receipt["unmappedUnicodeEffectStatus"] = "unverified-existing-helper-mapping"
        xdo("mousemove", "400", "500")
        introduced_buttons.add(1)
        xdo("mousedown", "1")
        assert pointer()[2] == 1
        outcome = invoke(args.adapter, "type-text", "--text", "ab", "--confirm")
        assert outcome["ok"] and pointer()[2] == 1
        assert outcome["inputCleanup"]["restoredButtons"] == 1
        results.append({"case": "preheld-button", "restoredStateVerified": True, "inputCleanup": outcome["inputCleanup"], "passed": True})
        xdo("mouseup", "1")
        introduced_buttons.discard(1)
        xdo("mousemove", str(initial_pointer[0]), str(initial_pointer[1]))
        set_caps(2)
        outcome = invoke(args.adapter, "type-text", "--text", "ab", "--confirm")
        assert outcome["ok"] and caps() == 2
        assert outcome["inputCleanup"]["restoredLock"]
        results.append({"case": "preexisting-Caps-Lock", "restoredStateVerified": True, "inputCleanup": outcome["inputCleanup"], "passed": True})
        set_caps(initial_caps)
        receipt["regressionsPassed"] = True
        receipt["nativeUnicodeAcceptanceComplete"] = False
    finally:
        # Resume only this lease's exact server before any synchronous state query.
        if server.exists() and server.joinpath("stat").read_text().rsplit(")", 1)[1].split()[19] == server_start:
            os.kill(args.server_pid, signal.SIGCONT)
        for proc in processes:
            if proc.poll() is None:
                os.kill(proc.pid, signal.SIGTERM)
                try:
                    proc.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.communicate(timeout=2)
        for pid, identity in helpers:
            if child_identity(pid) == identity:
                os.kill(pid, signal.SIGKILL)
        for key in list(introduced):
            if key in keys():
                own_key(key, False)
        for button in introduced_buttons:
            xdo("mouseup", str(button))
        xdo("mousemove", str(initial_pointer[0]), str(initial_pointer[1]))
        set_caps(initial_caps)
        settle()
        receipt["recovery"] = {"keyStateMatchesInitial": keys() == initial, "fixtureStable": True,
                               "ownedAdaptersSettled": all(proc.poll() is not None for proc in processes)}
        x11.XCloseDisplay(display)
        Path(args.receipt).write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
