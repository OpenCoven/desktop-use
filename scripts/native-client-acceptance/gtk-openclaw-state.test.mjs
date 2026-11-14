import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeGtkFixture } from './gtk-openclaw-state.mjs';

// X11 replies and Linux command identities are synthetic contract data. Only
// process liveness is exercised here; these tests establish no desktop proof.
async function sample() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gtk-openclaw-state-')));
  const fixture = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const server = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const statePath = join(root, 'fixture-state.json'), pidFile = join(root, 'client-fixture.pid'), fixtureScript = join(root, 'fixture/fixture.py');
  await mkdir(join(root, 'fixture')); await writeFile(fixtureScript, '# controlled fixture source\n');
  const state = { ready: true, pid: fixture.pid, origin: [140, 160], size: [640, 480], clicks: [{ x: 80, y: 60 }], keys: [{ text: 'PRIVATE_KEY_CONTENT' }] };
  await writeFile(statePath, JSON.stringify(state)); await writeFile(pidFile, String(fixture.pid));
  const env = { PATH: process.env.PATH, DISPLAY: ':91', XDG_SESSION_TYPE: 'x11', NATIVE_OWNED_DISPOSABLE_DISPLAY: 'yes', SECRET_MUST_NOT_FORWARD: 'private' };
  const options = { statePath, pidFile, fixtureScript, serverPid: server.pid, env,
    inspectProcess: async pid => ({ pid, start: '100', argv: pid === fixture.pid ? ['python3', fixtureScript, '--state', statePath, '--session', 'x11'] : ['Xvfb', ':91', '-screen', '0', '1280x960x24'] }),
    query: async (program, args, childEnv) => {
      assert.equal(childEnv.SECRET_MUST_NOT_FORWARD, undefined);
      if (program === 'xdotool' && args[0] === 'getactivewindow') return '12345\n';
      if (program === 'xdotool' && args[0] === 'getwindowpid' && ['12345', '67890'].includes(args[1])) return String(fixture.pid);
      if (program === 'xwininfo' && args[0] === '-id' && args[1] === '12345') return 'xwininfo: Window id: 0x3039 "owned"\n Absolute upper-left X: 140\n Absolute upper-left Y: 160\n Width: 640\n Height: 480\n Border width: 0\n';
      throw new Error('Unexpected non-read-only helper request');
    }
  };
  return { root, fixture, server, state, options, async cleanup() {
    for (const child of [fixture, server]) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
    await rm(root, { recursive: true, force: true });
  } };
}

test('projects independently matched GTK/X11 metadata without private event content', async () => {
  const s = await sample();
  try {
    const result = await observeGtkFixture(s.options);
    assert.equal(result.ready, true); assert.equal(result.pid, s.fixture.pid); assert.equal(result.windowNumber, 12345);
    assert.equal(result.clicks, 1); assert.equal(result.keys, 1);
    assert.deepEqual(result.desktopRect, { x: 140, y: 160, width: 640, height: 480 });
    assert.deepEqual(result.targetRect, [20, 20, 120, 80]);
    assert.equal(result.session, 'virtual-x11'); assert.equal(result.bridgePid, process.pid);
    assert.ok(Date.now() - result.observedAtMs < 1_000);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_KEY_CONTENT|fixture-state|fixture\.py/);
  } finally { await s.cleanup(); }
});

for (const variant of ['dead-fixture', 'dead-server', 'wrong-window-pid', 'changed-focus', 'wrong-geometry', 'bordered-window', 'pid-reuse', 'unowned-display', 'wrong-fixture-command', 'wrong-server-display', 'not-ready']) test(`rejects unsafe GTK oracle: ${variant}`, async () => {
  const s = await sample();
  try {
    if (variant === 'dead-fixture' || variant === 'dead-server') {
      const child = variant === 'dead-fixture' ? s.fixture : s.server;
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    }
    const query = s.options.query; let activeCalls = 0;
    s.options.query = async (...args) => {
      const [program, argv] = args;
      if (variant === 'wrong-window-pid' && program === 'xdotool' && argv[0] === 'getwindowpid') return String(s.server.pid);
      if (variant === 'changed-focus' && program === 'xdotool' && argv[0] === 'getactivewindow' && activeCalls++ > 0) return '67890';
      const value = await query(...args);
      if (program === 'xwininfo' && variant === 'wrong-geometry') return value.replace('X: 140', 'X: 141');
      if (program === 'xwininfo' && variant === 'bordered-window') return value.replace('Border width: 0', 'Border width: 1');
      return value;
    };
    const inspect = s.options.inspectProcess; let fixtureReads = 0;
    s.options.inspectProcess = async pid => {
      const value = await inspect(pid);
      if (variant === 'pid-reuse' && pid === s.fixture.pid && fixtureReads++ > 0) value.start = '200';
      if (variant === 'wrong-fixture-command' && pid === s.fixture.pid) value.argv = ['unrelated-app'];
      if (variant === 'wrong-server-display' && pid === s.server.pid) value.argv[1] = ':92';
      return value;
    };
    if (variant === 'unowned-display') delete s.options.env.NATIVE_OWNED_DISPOSABLE_DISPLAY;
    if (variant === 'not-ready') { s.state.ready = false; await writeFile(s.options.statePath, JSON.stringify(s.state)); }
    const reason = {
      'dead-fixture': /ESRCH/,
      'dead-server': /ESRCH/,
      'wrong-window-pid': /actual X11 input focus/,
      'changed-focus': /Focus changed/,
      'wrong-geometry': /Independent X11 geometry/,
      'bordered-window': /borderless GTK/,
      'pid-reuse': /process identity changed/,
      'unowned-display': /owned disposable display/,
      'wrong-fixture-command': /Live process must own/,
      'wrong-server-display': /Xvfb must own/,
      'not-ready': /GTK fixture must be ready/,
    }[variant];
    await assert.rejects(observeGtkFixture(s.options), reason);
  } finally { await s.cleanup(); }
});

for (const variant of ['late-fixture-death', 'late-gtk-move', 'late-x11-move', 'slow-acquisition', 'script-as-operand']) test(`rejects review boundary: ${variant}`, async () => {
  const s = await sample();
  try {
    let activeCalls = 0, geometryCalls = 0;
    const query = s.options.query;
    s.options.query = async (...args) => {
      if (args[0] === 'xdotool' && args[1][0] === 'getactivewindow' && ++activeCalls === 2) {
        if (variant === 'late-fixture-death') { const ended = once(s.fixture, 'exit'); s.fixture.kill('SIGKILL'); await ended; }
        if (variant === 'late-gtk-move') { s.state.origin = [800, 600]; await writeFile(s.options.statePath, JSON.stringify(s.state)); }
        if (variant === 'slow-acquisition') await new Promise(resolve => setTimeout(resolve, 1_100));
      }
      const value = await query(...args);
      if (args[0] === 'xwininfo' && ++geometryCalls === 2 && variant === 'late-x11-move') return value.replace('X: 140', 'X: 800');
      return value;
    };
    if (variant === 'script-as-operand') {
      const inspect = s.options.inspectProcess;
      s.options.inspectProcess = async pid => { const p = await inspect(pid); if (pid === s.fixture.pid) p.argv = ['python3', '-c', 'pass', ...p.argv.slice(1)]; return p; };
    }
    await assert.rejects(observeGtkFixture(s.options));
  } finally { await s.cleanup(); }
});
