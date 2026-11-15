import assert from 'node:assert/strict';
import { readFile, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function focusedFixture(path, expectedPid) {
  const fixture = JSON.parse(await readFile(path));
  assert.ok(fixture.ready && Number.isInteger(fixture.pid) && fixture.pid > 1, 'fixture must report ready with a real PID');
  if (expectedPid !== undefined) assert.equal(fixture.pid, expectedPid, 'fixture identity changed during the probe');
  process.kill(fixture.pid, 0); // Stale state must never serve as a no-effect oracle.
  if (process.platform === 'linux') {
    const env = nativeHarnessEnvironment(dirname(path));
    assert.equal(Number((await readFile(join(dirname(path), 'client-fixture.pid'), 'utf8')).trim()), fixture.pid);
    const command = (await readFile(`/proc/${fixture.pid}/cmdline`)).toString().split('\0');
    assert.ok(command.some(arg => arg.endsWith('/fixture/fixture.py')) && command.includes(path), 'PID must own the configured GTK fixture');
    const active = spawnSync('xdotool', ['getactivewindow', 'getwindowpid'], { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(active.status, 0, 'owned fixture focus must be observable');
    assert.equal(Number(active.stdout.trim()), fixture.pid, 'owned fixture must hold input focus');
  } else {
    assert.equal(process.platform, 'darwin');
    assert.ok(fixture.focused && fixture.windowNumber > 0, 'owned AppKit fixture must hold input focus');
    const command = spawnSync('/bin/ps', ['-p', String(fixture.pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 });
    assert.equal(command.status, 0);
    assert.ok(command.stdout.trim().endsWith('/DesktopUseAcceptance'), 'PID must own the AppKit acceptance fixture');
  }
  return fixture;
}

export async function preparedPython(executable) {
  assert.ok(typeof executable === 'string' && isAbsolute(executable), 'prepared Python must be an absolute executable path');
  await access(executable, constants.X_OK);
  // A venv's executable is a symlink; resolving it bypasses pyvenv.cfg.
  return resolve(executable);
}

export async function preparedMacFixtureTarget(...args) {
  const target = await import('./mac-fixture-target.mjs');
  return target.preparedMacFixtureTarget(...args);
}

export function nativeHarnessEnvironment(root, env = process.env, platform = process.platform, preparedRoot = root) {
  const selected = { PATH: env.PATH, TMPDIR: root };
  if (platform === 'linux') {
    assert.equal(env.NATIVE_OWNED_DISPOSABLE_DISPLAY, 'yes', 'Linux probes require an owned disposable display');
    assert.ok(env.DISPLAY && env.XDG_SESSION_TYPE === 'x11', 'Linux probes require the explicit owned X11 session');
    selected.DISPLAY = env.DISPLAY;
    selected.XDG_SESSION_TYPE = env.XDG_SESSION_TYPE;
  }
  if (platform === 'darwin' && env.PEEKABOO_CAPTURE_ENGINE) selected.PEEKABOO_CAPTURE_ENGINE = env.PEEKABOO_CAPTURE_ENGINE;
  if (platform === 'darwin' && env.CFFIXED_USER_HOME !== undefined) {
    const home = join(preparedRoot, 'home');
    assert.equal(env.HOME, home, 'POSIX home must be the owned task home');
    assert.equal(env.CFFIXED_USER_HOME, home, 'Foundation home must be the owned task home');
    selected.HOME = home;
    selected.CFFIXED_USER_HOME = home;
  }
  return selected;
}

// Reject a changed/misconfigured consumer before any native action is invoked.
export async function verifyMacIdentity(root, adapter, searchPath = process.env.PATH, selectedEnvironment = process.env) {
  const baseline = JSON.parse(await readFile(join(root, 'baseline.json')));
  if (baseline.fixtureBundleIdentifier?.startsWith('org.opencoven.desktopuse.acceptance.run-')) {
    assert.equal(baseline.helperHome, join(await realpath(root), 'home'), 'isolated fixture requires a prepared helper home');
  }
  if (baseline.helperHome !== undefined) {
    const home = join(await realpath(root), 'home');
    assert.equal(baseline.helperHome, home, 'prepared helper home must remain in the owned root');
    assert.equal(await realpath(home), home, 'prepared helper home cannot alias another directory');
    assert.equal(selectedEnvironment.HOME, home, 'POSIX home differs from prepared helper home');
    assert.equal(selectedEnvironment.CFFIXED_USER_HOME, home, 'Foundation home differs from prepared helper home');
  }
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(await realpath(adapter), await realpath(join(root, 'bin/coven-desktop-use')));
  assert.equal(await hash(adapter), baseline.nativeSha256, 'native adapter differs from prepared bytes');
  let selected;
  for (const directory of (searchPath ?? '').split(':')) {
    const candidate = join(directory || '.', 'peekaboo');
    try { await access(candidate, constants.X_OK); selected = await realpath(candidate); break; } catch {}
  }
  const expected = await realpath(join(root, 'bin/peekaboo'));
  assert.equal(selected, expected, 'PATH must select the prepared Peekaboo helper');
  assert.equal(await hash(selected), baseline.helperSha256, 'Peekaboo helper differs from prepared bytes');
  for (const [name, expectedHash] of Object.entries(baseline.consumerScriptsSha256 ?? {})) {
    assert.match(name, /^[a-zA-Z0-9_.-]+$/, 'consumer script must be a prepared basename');
    assert.equal(await hash(join(root, 'consumer', name)), expectedHash, `prepared consumer script changed: ${name}`);
  }
  for (const [key, name] of [['NATIVE_ACCEPTANCE_IMAGE_PROOF', 'image-proof.py'], ['NATIVE_ACCEPTANCE_PTY', 'pty-host.py']]) {
    if (selectedEnvironment[key] === undefined) continue;
    const selectedScript = await realpath(selectedEnvironment[key]);
    assert.equal(selectedScript, await realpath(join(root, 'consumer', name)), `selected consumer script must be the prepared copy: ${key}`);
    assert.equal(await hash(selectedScript), baseline.consumerScriptsSha256?.[name], `selected consumer script hash changed: ${key}`);
  }
  return baseline;
}
