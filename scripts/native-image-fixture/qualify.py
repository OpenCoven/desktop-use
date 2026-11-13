#!/usr/bin/env python3
"""Run ONLY inside an owned isolated Linux graphics container; never a user session.
Requires GTK/PyGObject, real capture/input helpers, and an existing test server.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def wait_for(check, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(.05)
    raise AssertionError('bounded fixture wait expired')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--session', choices=['x11', 'wayland'], required=True)
    p.add_argument('--output-name', choices=['HEADLESS-1', 'HEADLESS-2'])
    p.add_argument('--adapter', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--server-pid', type=int, required=True)
    p.add_argument('--owned-disposable-display', action='store_true', required=True)
    a = p.parse_args()
    root = a.output.resolve()
    root.mkdir(mode=0o700)
    adapter = a.adapter.resolve()
    receipts = {'session': a.session, 'virtualLinux': True, 'physicalAcceptance': False, 'adapterSha256': digest(adapter), 'fixtureSha256': digest(Path(__file__).with_name('fixture.py')), 'captures': [], 'effects': [], 'cancel': None}
    env = {**os.environ, 'XDG_SESSION_TYPE': a.session}
    state_path = root / 'fixture-state.json'
    title = f'DesktopuseFixture21-{os.getpid()}'
    if a.output_name:
        assert a.session == 'wayland'
        setup = subprocess.check_output(['swaymsg', 'focus', 'output', a.output_name], env=env)
        receipts['fixturePlacement'] = {'output': a.output_name, 'setupOnly': True, 'response': json.loads(setup)}
    fixture = subprocess.Popen(['python3', str(Path(__file__).with_name('fixture.py')), '--state', str(state_path), '--session', a.session, '--title', title], env=env, stdout=(root/'fixture.stdout').open('w'), stderr=(root/'fixture.stderr').open('w'))
    def state():
        try:
            return json.loads(state_path.read_text())
        except FileNotFoundError:
            return {}
    def call(label, args, call_env=env):
        proc = subprocess.run([str(adapter), *args], env=call_env, capture_output=True, text=True, timeout=35)
        (root/(label+'.stdout')).write_text(proc.stdout)
        (root/(label+'.stderr')).write_text(proc.stderr)
        result = json.loads(proc.stdout)
        result['_processExit'] = proc.returncode
        return result
    def owned_node():
        tree = json.loads(subprocess.check_output(['swaymsg','-t','get_tree','-r'], env=env))
        found = []
        def walk(node):
            if node.get('name') == title:
                found.append(node)
            for child in node.get('nodes', []) + node.get('floating_nodes', []):
                walk(child)
        walk(tree)
        assert len(found)==1 and found[0].get('pid')==fixture.pid, [(n.get('id'),n.get('pid')) for n in found]
        return found[0]
    def focus_owned(label):
        node = owned_node() if a.session=='wayland' else None
        args = ['--window-id',str(node['id'])] if node else ['--window-title',title]
        result = call(label,['focus',*args,'--confirm'])
        assert result['ok'], result
        if node:
            def exact_focus():
                seats = json.loads(subprocess.check_output(['swaymsg','-t','get_seats','-r'], env=env))
                current = owned_node()
                if current.get('focused') and any(seat.get('focus')==node['id'] for seat in seats):
                    return {'conId':node['id'],'pid':fixture.pid,'title':title,'focused':True,'seats':seats}
            receipts[label+'Identity'] = wait_for(exact_focus)
        return result
    def pixel(path, x, y):
        import gi
        gi.require_version('GdkPixbuf', '2.0')
        from gi.repository import GdkPixbuf
        pic = GdkPixbuf.Pixbuf.new_from_file(str(path))
        offset = y*pic.get_rowstride()+x*pic.get_n_channels()
        return list(pic.get_pixels()[offset:offset+3])
    def capture(label, kind, mode='screen', call_env=env, expected=(224,48,64), expect_geometry=True):
        path = root/(label+'.'+kind)
        result = call(label, ['screenshot', '--mode', mode, '--format', kind, '--path', str(path)], call_env)
        assert result['ok'], result
        r = result['observationV1']
        assert r['primaryImage']['sha256'] == digest(path)
        assert r['geometry']['state'] == ('available' if expect_geometry else 'unavailable'), r['geometry']
        if mode=='screen':
            regions = r['geometry']['regions']
            region = next(region for region in regions if region['desktopRect']['x'] <= origin[0]+30 < region['desktopRect']['x']+region['desktopRect']['width'] and region['desktopRect']['y'] <= origin[1]+30 < region['desktopRect']['y']+region['desktopRect']['height'])
            d, i = region['desktopRect'], region['imageRect']
            x = round(i['x']+(origin[0]+30-d['x'])*i['width']/d['width'])
            y = round(i['y']+(origin[1]+30-d['y'])*i['height']/d['height'])
        else:
            x, y = 30, 30
        actual = pixel(path,x,y)
        assert all(abs(actual[i]-expected[i]) <= (8 if kind=='jpg' else 0) for i in range(3)), (actual,expected,label,x,y)
        receipts['captures'].append({'label':label,'receipt':r,'referencePixel':{'point':[x,y],'expected':expected,'actual':actual},'actualVisibleContent':True})
        return r
    try:
        wait_for(lambda: state().get('ready'))
        if a.session=='x11':
            focused = focus_owned('focus')
            assert focused['ok'], focused
            origin = state()['origin']
        else:
            outputs = json.loads(subprocess.check_output(['swaymsg','-t','get_outputs','-r'], env=env))
            # The disposable app starts fullscreen on the focused output.
            focused = next(o for o in outputs if o['focused'])
            origin = [focused['rect']['x'],focused['rect']['y']]
            receipts['outputs'] = outputs
        if a.session == 'wayland':
            focused = focus_owned('focus')
            assert focused['ok'], focused
            receipts['focus'] = focused
        receipts['fixtureInitial'] = state()
        receipts['fixtureOrigin'] = origin
        capture('before','png')
        if a.session=='x11':
            capture('screen-jpeg','jpg')
            capture('frontmost-png','png','frontmost')
            tools = root/'maim-tools'
            tools.mkdir()
            for name in ['maim','xwininfo','xdotool']:
                (tools/name).symlink_to(shutil.which(name))
            menv = {**env,'PATH':str(tools)}
            capture('maim-screen-png','png',call_env=menv)
            capture('maim-screen-jpeg','jpg',call_env=menv)
            capture('maim-frontmost-png','png','frontmost',call_env=menv)
        else:
            unsupported = call('unsupported-frontmost',['screenshot','--mode','frontmost','--path',str(root/'unsupported.png')])
            assert not unsupported['ok'] and not (root/'unsupported.png').exists()
            receipts['unsupportedFrontmost'] = unsupported
            # Preserve the system grim JPEG-disabled build as a negative receipt.
            negative = call('system-grim-jpeg',['screenshot','--mode','screen','--format','jpg','--path',str(root/'system.jpg')])
            receipts['systemJpeg'] = negative
            jpeg_helper = Path('/home/desktopuse/real-grim-jpeg')
            if jpeg_helper.exists():
                tools = root/'grim-jpeg-tools'
                tools.mkdir()
                for name in ['swaymsg','wayland-info']:
                    (tools/name).symlink_to(shutil.which(name))
                (tools/'grim').symlink_to(jpeg_helper)
                jenv = {**env,'PATH':str(tools)}
                capture('grim-jpeg-enabled','jpg',call_env=jenv)
                receipts['jpegHelperSha256'] = digest(jpeg_helper)
        pointer = call('pointer',['click','--coords',f'{origin[0]+80},{origin[1]+60}','--confirm'])
        time.sleep(.25)
        effects = state()
        if pointer['ok']:
            assert len(effects['clicks'])==1, (pointer,effects)
            assert abs(effects['clicks'][0]['x']-80)<=1 and abs(effects['clicks'][0]['y']-60)<=1, effects
            capture('after-click','png',expected=(32,192,96))
        receipts['effects'].append({'action':'click','result':pointer,'observed':effects,'verified':len(effects['clicks'])==1})
        focused = focus_owned('key-focus')
        assert focused['ok'], focused
        key = call('key',['keypress','--keys','a','--confirm'])
        try:
            wait_for(lambda: len(state().get('keys',[]))>=1)
        except AssertionError:
            pass  # Retain failed effect verdict; independent cancellation still runs.
        keyboard_verified = key['ok'] and bool(state()['keys']) and state()['keys'][0]['name']=='a'
        receipts['effects'].append({'action':'keypress','result':key,'observed':state()['keys'],'verified':keyboard_verified})
        # Stop only the dedicated server to hold its real capture helper in flight.
        destination = root/'cancel.png'
        destination.write_bytes(b'original explicit destination')
        os.kill(a.server_pid,signal.SIGSTOP)
        cancelled = subprocess.Popen([str(adapter),'screenshot','--mode','screen','--path',str(destination)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            def helper_running():
                children = Path(f'/proc/{cancelled.pid}/task/{cancelled.pid}/children').read_text().split()
                for pid in children:
                    comm = Path(f'/proc/{pid}/comm').read_text().strip()
                    if comm in ('scrot','grim'):
                        return {'pid':int(pid),'name':comm}
            helper = wait_for(helper_running,7)
            cancelled.send_signal(signal.SIGTERM)
            stdout,stderr = cancelled.communicate(timeout=5)
            (root/'cancel.stdout').write_text(stdout)
            (root/'cancel.stderr').write_text(stderr)
            result = json.loads(stdout)
            assert result['code']=='CANCELLED' and 'observationV1' not in result, result
            assert destination.read_bytes()==b'original explicit destination'
            assert not Path(f'/proc/{helper["pid"]}').exists()
            assert not list(root.glob('.desktopuse-capture-*'))
            receipts['cancel'] = {'result':result,'actualHelper':helper,'destinationPreserved':True,'helperReaped':True,'privateStagingRemoved':True}
        finally:
            if cancelled.poll() is None:
                cancelled.kill(); cancelled.communicate()
            os.kill(a.server_pid,signal.SIGCONT)
        receipts['completed'] = True
    finally:
        fixture.terminate()
        fixture.wait(timeout=5)
        receipts['fixtureTerminated'] = True
        (root/'receipt.json').write_text(json.dumps(receipts,indent=2)+'\n')
    print(json.dumps({'receipt':str(root/'receipt.json'),'completed':True,'pointerVerified':receipts['effects'][0]['verified'],'keyboardVerified':keyboard_verified}))
    if not keyboard_verified:
        raise SystemExit(1)


if __name__=='__main__':
    main()
