// Opt-in projection for an owned, borderless GTK fixture on disposable X11.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeHarnessEnvironment } from './identity-preflight.mjs';

const run = promisify(execFile);
async function queryX11(program, args, env) {
  const result = await run(program, args, { env, timeout: 2_000, maxBuffer: 64 * 1024 });
  return result.stdout;
}
async function linuxProcess(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  assert.notEqual(fields[0], 'Z', 'A zombie cannot be an observation oracle');
  assert.match(fields[19], /^\d+$/);
  return { pid, start: fields[19], argv: (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0').filter(Boolean) };
}
function positivePid(value) {
  const pid = Number(String(value).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid <= 0xffffffff, 'Exact positive process/window identity required');
  return pid;
}
function gtkGeometry(state) {
  assert.equal(state.ready, true, 'GTK fixture must be ready');
  assert.ok(Array.isArray(state.clicks) && Array.isArray(state.keys), 'Actual GTK event counters required');
  assert.ok(Array.isArray(state.origin) && state.origin.length === 2 && state.origin.every(Number.isSafeInteger));
  assert.ok(Array.isArray(state.size) && state.size.length === 2 && state.size.every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384));
  return { x: state.origin[0], y: state.origin[1], width: state.size[0], height: state.size[1] };
}
function x11Geometry(text, windowId) {
  const id = text.match(/Window id:\s+(0x[\da-f]+)/i)?.[1];
  assert.equal(Number(id), windowId, 'Independent geometry must identify the active fixture window');
  const field = name => {
    const value = text.match(new RegExp(`^\\s*${name}:\\s*(-?\\d+)\\s*$`, 'm'))?.[1];
    assert.ok(value !== undefined, 'Complete independent X11 geometry required');
    return Number(value);
  };
  assert.equal(field('Border width'), 0, 'Only a borderless GTK client extent is qualified');
  return { x: field('Absolute upper-left X'), y: field('Absolute upper-left Y'), width: field('Width'), height: field('Height') };
}

export async function observeGtkFixture({ statePath, pidFile, fixtureScript, serverPid, env = process.env, query = queryX11, inspectProcess = linuxProcess }) {
  const observedAtMs = Date.now();
  const selected = nativeHarnessEnvironment(dirname(statePath), env, 'linux');
  const [stateFile, script] = await Promise.all([realpath(statePath), realpath(fixtureScript)]);
  const fixturePid = positivePid(await readFile(pidFile, 'utf8'));
  serverPid = positivePid(serverPid); assert.notEqual(fixturePid, serverPid);
  async function identities() {
    // Always check actual liveness, even when unit tests inject kernel metadata.
    process.kill(fixturePid, 0); process.kill(serverPid, 0);
    const [fixture, server] = await Promise.all([inspectProcess(fixturePid), inspectProcess(serverPid)]);
    assert.equal(fixture.pid, fixturePid); assert.equal(server.pid, serverPid);
    assert.ok(/^python3(?:\.\d+)?$/.test(basename(fixture.argv[0])) && fixture.argv[1] === script && fixture.argv.includes('--state') && fixture.argv[fixture.argv.indexOf('--state') + 1] === stateFile, 'Live process must own the selected GTK script and state');
    assert.equal(basename(server.argv[0]), 'Xvfb'); assert.ok(server.argv.includes(selected.DISPLAY), 'Live Xvfb must own the selected display');
    assert.ok(typeof fixture.start === 'string' && fixture.start.length > 0 && typeof server.start === 'string' && server.start.length > 0);
    return { fixturePid, fixtureStart: fixture.start, serverPid, serverStart: server.start };
  }
  async function focusedWindow() {
    const window = positivePid(await query('xdotool', ['getactivewindow'], selected));
    assert.equal(positivePid(await query('xdotool', ['getwindowpid', String(window)], selected)), fixturePid, 'Fixture must hold actual X11 input focus');
    return window;
  }
  const beforeIdentity = await identities();
  const before = JSON.parse(await readFile(stateFile, 'utf8')); assert.equal(before.pid, fixturePid);
  const geometry = gtkGeometry(before), windowNumber = await focusedWindow();
  assert.deepEqual(x11Geometry(await query('xwininfo', ['-id', String(windowNumber)], selected), windowNumber), geometry, 'Independent X11 geometry must match GTK origin and extent');
  const after = JSON.parse(await readFile(stateFile, 'utf8')); assert.equal(after.pid, fixturePid);
  assert.deepEqual(gtkGeometry(after), geometry, 'GTK geometry changed during observation');
  assert.deepEqual(await identities(), beforeIdentity, 'Fixture/server process identity changed during observation');
  assert.equal(await focusedWindow(), windowNumber, 'Focus changed during observation');
  assert.deepEqual(x11Geometry(await query('xwininfo', ['-id', String(windowNumber)], selected), windowNumber), geometry, 'Independent X11 geometry changed during observation');
  const last = JSON.parse(await readFile(stateFile, 'utf8')); assert.equal(last.pid, fixturePid);
  assert.deepEqual(gtkGeometry(last), geometry, 'GTK geometry changed before closing observation');
  assert.deepEqual(await identities(), beforeIdentity, 'Fixture/server identity changed before closing observation');
  process.kill(fixturePid, 0); process.kill(serverPid, 0);
  assert.ok(Date.now() - observedAtMs <= 1_000, 'GTK observation acquisition exceeded its freshness budget');
  assert.ok(last.clicks.length >= before.clicks.length && last.keys.length >= before.keys.length, 'Fixture counters cannot reset inside an observation');
  assert.ok(geometry.width >= 140 && geometry.height >= 100, 'Known target must fit inside the fixture');
  return { ready: true, pid: fixturePid, windowNumber, clicks: last.clicks.length, keys: last.keys.length, desktopRect: geometry, targetRect: [20, 20, 120, 80], session: 'virtual-x11', bridgePid: process.pid, observedAtMs, processIdentity: beforeIdentity };
}

async function main() {
  assert.equal(process.platform, 'linux');
  const [statePath, pidFile, fixtureScript, serverPid, outputPath, acknowledgement] = process.argv.slice(2);
  assert.equal(acknowledgement, '--owned-disposable-display', 'An explicit disposable-display acknowledgement is required');
  assert.ok([statePath, pidFile, fixtureScript, outputPath].every(path => path && resolve(path) === path), 'Explicit absolute private paths required');
  assert.ok(![statePath, pidFile, fixtureScript].includes(outputPath), 'Bridge output must not replace its input or fixture source');
  const initial = await open(outputPath, 'wx', 0o600);
  try { await initial.writeFile(JSON.stringify({ ready: false, code: 'GTK_BRIDGE_STARTING' }) + '\n'); } finally { await initial.close(); }
  const bridge = await linuxProcess(process.pid);
  const bridgeScriptSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  let stopped = false, identity;
  const stop = () => { stopped = true; };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  const save = async value => { const temp = `${outputPath}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); await rename(temp, outputPath); };
  try {
    while (!stopped) {
      const state = await observeGtkFixture({ statePath, pidFile, fixtureScript, serverPid });
      if (identity) assert.deepEqual(state.processIdentity, identity, 'Fixture/server ownership changed after bridge startup');
      identity = state.processIdentity;
      if (stopped) break;
      await save({ ...state, bridgeStart: bridge.start, bridgeScriptSha256 }); await delay(50);
    }
  } catch { process.exitCode = 1; }
  finally {
    await save({ ready: false, bridgePid: process.pid, observedAtMs: Date.now(), code: stopped ? 'GTK_BRIDGE_STOPPED' : 'GTK_BRIDGE_UNAVAILABLE' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
