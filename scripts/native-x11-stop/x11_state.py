"""Clock proof shared by the opt-in, exclusively leased Xvfb regressions."""
import ctypes
import time


def clock_delta(server_ms, monotonic_ms):
    modulus = 2 ** 32
    return (server_ms - monotonic_ms + modulus // 2) % modulus - modulus // 2


def clock_bounds(x11, display):
    class PropertyEvent(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                    ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("atom", ctypes.c_ulong),
                    ("time", ctypes.c_ulong), ("state", ctypes.c_int)]
    class Event(ctypes.Union):
        _fields_ = [("property", PropertyEvent), ("pad", ctypes.c_long * 24)]
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                       ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
    x11.XCreateSimpleWindow.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XSelectInput.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long]
    x11.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
                                   ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    x11.XWindowEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long, ctypes.POINTER(Event)]
    x11.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    window = x11.XCreateSimpleWindow(display, x11.XDefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0)
    assert window
    try:
        atom = x11.XInternAtom(display, b"DESKTOPUSE_OWNED_CLOCK", 0)
        x11.XSelectInput(display, window, 1 << 22)
        offsets = []
        for _ in range(3):
            event = Event()
            start_ms = time.monotonic_ns() // 1_000_000
            x11.XChangeProperty(display, window, atom, 31, 8, 0, ctypes.c_char_p(b"1"), 1)
            x11.XWindowEvent(display, window, 1 << 22, ctypes.byref(event))
            end_ms = time.monotonic_ns() // 1_000_000
            assert event.property.type == 28
            offsets.append((clock_delta(event.property.time, end_ms) - 1, clock_delta(event.property.time, start_ms) + 1))
        lower = max(pair[0] for pair in offsets)
        upper = min(pair[1] for pair in offsets)
        assert lower <= upper
        return lower, upper
    finally:
        x11.XDestroyWindow(display, window)
