#!/usr/bin/env python3
"""Opt-in disposable GTK fixture. Run only on a dedicated test display/container."""
import argparse
import json
import os
from pathlib import Path
import signal
import time


def schedule_state_write(GLib, callback):
    # Default-priority timer cannot starve behind continuously ready GTK input.
    return GLib.timeout_add(16, callback, priority=GLib.PRIORITY_DEFAULT)


class StateWriter:
    """Write complete history once after a burst, without delaying event capture."""
    def __init__(self, schedule, write):
        self.schedule = schedule
        self.write = write
        self.pending = False

    def request(self):
        if not self.pending:
            self.pending = True
            self.schedule(self.flush)

    def flush_pending(self):
        if self.pending:
            self.pending = False
            self.write()

    def flush(self):
        self.flush_pending()
        return False


def app(state_path, session, title):
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk, Gdk, GLib
    state = {'clicks': [], 'keys': [], 'ready': False, 'pid': os.getpid()}
    window = Gtk.Window(title=title)
    window.set_decorated(False)
    window.set_default_size(640, 480)
    window.move(100, 120)
    area = Gtk.Fixed()
    window.set_name('fixture-background')
    window.add(area)
    target = Gtk.EventBox()
    target.set_name('fixture-target')
    target.set_size_request(120, 80)
    target.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
    area.put(target, 20, 20)
    yellow = Gtk.EventBox()
    yellow.set_name('fixture-reference')
    yellow.set_size_request(120, 80)
    area.put(yellow, 20, 140)
    label = Gtk.Label(label='Fixture 21 | clicks 0 | keys 0')
    area.put(label, 170, 45)
    css = Gtk.CssProvider()
    css.load_from_data(b'#fixture-background { background: rgb(20,40,80); } #fixture-target { background: rgb(224,48,64); } #fixture-target.clicked { background: rgb(32,192,96); } #fixture-reference { background: rgb(240,210,40); } label { color: white; font-size: 22px; }')
    Gtk.StyleContext.add_provider_for_screen(window.get_screen(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def save():
        native_window = window.get_window()
        if native_window is not None:
            state['size'] = [area.get_allocated_width(), area.get_allocated_height()]
            if session == 'x11':
                _, x, y = native_window.get_origin()
                state['origin'] = [x, y]
        temp = state_path.with_suffix('.tmp')
        temp.write_text(json.dumps(state))
        temp.replace(state_path)

    writer = StateWriter(lambda callback: schedule_state_write(GLib, callback), save)

    def click(widget, event):
        state['clicks'].append({'x': event.x+20, 'y': event.y+20, 'button': event.button})
        target.get_style_context().add_class('clicked')
        label.set_text('Fixture 21 | clicks %d | keys %d' % (len(state['clicks']), len(state['keys'])))
        writer.request()
        return True

    def key(widget, event):
        state['keys'].append({'name': Gdk.keyval_name(event.keyval), 'text': event.string,
                              'serverTimeMs': event.time, 'receivedMonotonicMs': time.monotonic_ns() // 1_000_000})
        label.set_text('Fixture 21 | clicks %d | keys %d' % (len(state['clicks']), len(state['keys'])))
        writer.request()
        return True

    def ready():
        state['ready'] = True
        save()
        return False

    def configured(*_):
        # A window manager can finish placement after the initial ready event.
        # Persist the applied GDK position before consumers map returned pixels.
        writer.request()
        return False

    target.connect('button-press-event', click)
    window.connect('key-press-event', key)
    window.connect('configure-event', configured)
    GLib.timeout_add(300, ready)
    window.connect('destroy', Gtk.main_quit)
    window.show_all()
    if session == 'wayland':
        window.fullscreen()
    window.present()
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, lambda: (Gtk.main_quit(), False)[1])
    try:
        Gtk.main()
    finally:
        # Persist captured events even when destroy/SIGTERM beats the timer.
        writer.flush_pending()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--state', type=Path, required=True)
    p.add_argument('--session', choices=['x11', 'wayland'], required=True)
    p.add_argument('--title', default='DesktopuseFixture21')
    a = p.parse_args()
    app(a.state, a.session, a.title)
