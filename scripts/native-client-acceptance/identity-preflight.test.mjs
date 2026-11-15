import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { verifyMacIdentity, preparedPython, nativeHarnessEnvironment, focusedFixture } from './identity-preflight.mjs';

test('native preflight rejects a substituted PATH helper or changed adapter before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-identity-'));
  try {
    await mkdir(join(root, 'bin')); await mkdir(join(root, 'other'));
    const adapter = join(root, 'bin/coven-desktop-use');
    const helper = join(root, 'helper');
    await writeFile(adapter, 'adapter'); await writeFile(helper, 'prepared-helper'); await chmod(helper, 0o700);
    await symlink(helper, join(root, 'bin/peekaboo'));
    await writeFile(join(root, 'other/peekaboo'), '#!/bin/sh\nexit 99\n'); await chmod(join(root, 'other/peekaboo'), 0o700);
    const hash = text => createHash('sha256').update(text).digest('hex');
    await writeFile(join(root, 'baseline.json'), JSON.stringify({ nativeSha256: hash('adapter'), helperSha256: hash('prepared-helper') }));
    await verifyMacIdentity(root, adapter, join(root, 'bin'));
    await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'other')), /PATH must select/);
    await writeFile(adapter, 'different-adapter');
    await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'bin')), /adapter differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prepared Python keeps a real virtual environment active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-python-'));
  try {
    const venv = join(root, 'venv');
    const made = spawnSync('python3', ['-m', 'venv', '--without-pip', venv], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(made.status, 0, made.stderr);
    const python = await preparedPython(join(venv, 'bin/python'));
    const checked = spawnSync(python, ['-c', 'import sys;assert sys.prefix != sys.base_prefix'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(checked.status, 0, checked.stderr);
    await assert.rejects(preparedPython('python3'), /absolute executable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a changed prepared image proof is rejected before any desktop helper execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-proof-binding-'));
  try {
    await mkdir(join(root, 'bin')); await mkdir(join(root, 'consumer'));
    const adapter = join(root, 'bin/coven-desktop-use');
    await writeFile(adapter, 'adapter'); await writeFile(join(root, 'bin/peekaboo'), 'helper'); await chmod(join(root, 'bin/peekaboo'), 0o700);
    await writeFile(join(root, 'consumer/image-proof.py'), 'original-proof');
    const hash = text => createHash('sha256').update(text).digest('hex');
    await writeFile(join(root, 'baseline.json'), JSON.stringify({ nativeSha256: hash('adapter'), helperSha256: hash('helper'), consumerScriptsSha256: { 'image-proof.py': hash('original-proof') } }));
    await verifyMacIdentity(root, adapter, join(root, 'bin'));
    await writeFile(join(root, 'consumer/image-proof.py'), 'changed-proof');
    await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'bin')), /consumer script/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('environment-selected verifier and terminal broker must be the prepared files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-selected-proof-'));
  try {
    await mkdir(join(root, 'bin')); await mkdir(join(root, 'consumer')); await mkdir(join(root, 'older'));
    const adapter = join(root, 'bin/coven-desktop-use');
    await writeFile(adapter, 'adapter'); await writeFile(join(root, 'bin/peekaboo'), 'helper'); await chmod(join(root, 'bin/peekaboo'), 0o700);
    const hash = text => createHash('sha256').update(text).digest('hex');
    const scripts = { 'image-proof.py': hash('proof'), 'pty-host.py': hash('broker') };
    for (const [name, bytes] of [['image-proof.py', 'proof'], ['pty-host.py', 'broker']]) {
      await writeFile(join(root, 'consumer', name), bytes);
      await writeFile(join(root, 'older', name), bytes);
    }
    await writeFile(join(root, 'baseline.json'), JSON.stringify({ nativeSha256: hash('adapter'), helperSha256: hash('helper'), consumerScriptsSha256: scripts }));
    const env = { NATIVE_ACCEPTANCE_IMAGE_PROOF: join(root, 'consumer/image-proof.py'), NATIVE_ACCEPTANCE_PTY: join(root, 'consumer/pty-host.py') };
    await verifyMacIdentity(root, adapter, join(root, 'bin'), env);
    for (const [key, name] of [['NATIVE_ACCEPTANCE_IMAGE_PROOF', 'image-proof.py'], ['NATIVE_ACCEPTANCE_PTY', 'pty-host.py']]) {
      await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'bin'), { ...env, [key]: join(root, 'older', name) }), /selected consumer script/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real stdio child receives the owned display without unrelated environment data', async () => {
  const env = { PATH: process.env.PATH, DISPLAY: ':91', XDG_SESSION_TYPE: 'x11', NATIVE_OWNED_DISPOSABLE_DISPLAY: 'yes', NATIVE_TEST_SECRET: 'fixture-only-marker' };
  const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify({jsonrpc:"2.0",method:"fixture/env",params:{display:process.env.DISPLAY??null,session:process.env.XDG_SESSION_TYPE??null,secretPresent:process.env.NATIVE_TEST_SECRET!==undefined}}));setInterval(()=>{},1000)'], env: nativeHarnessEnvironment(tmpdir(), env, 'linux'), stderr: 'pipe' });
  let timeout;
  const observed = new Promise((resolve, reject) => {
    transport.onmessage = message => resolve(message.params);
    transport.onerror = reject;
    timeout = setTimeout(() => reject(new Error('Actual stdio child did not report readiness')), 5000);
  });
  try {
    await transport.start();
    assert.deepEqual(await observed, { display: ':91', session: 'x11', secretPresent: false });
  } finally { clearTimeout(timeout); await transport.close(); }
});

test('real Mac stdio child receives the isolated Foundation and POSIX home without unrelated data', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-mac-home-')));
  const home = join(root, 'home');
  const env = { PATH: process.env.PATH, HOME: home, CFFIXED_USER_HOME: home, NATIVE_TEST_SECRET: 'fixture-only-marker' };
  const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify({jsonrpc:"2.0",method:"fixture/env",params:{home:process.env.HOME??null,foundationHome:process.env.CFFIXED_USER_HOME??null,secretPresent:process.env.NATIVE_TEST_SECRET!==undefined}}));setInterval(()=>{},1000)'], env: nativeHarnessEnvironment(root, env, 'darwin'), stderr: 'pipe' });
  let timeout;
  const observed = new Promise((resolve, reject) => { transport.onmessage = message => resolve(message.params); transport.onerror = reject; timeout = setTimeout(() => reject(new Error('Actual stdio child did not report isolated homes')), 5000); });
  try { await transport.start(); assert.deepEqual(await observed, { home, foundationHome: home, secretPresent: false }); }
  finally { clearTimeout(timeout); await transport.close(); await rm(root, { recursive: true, force: true }); }
});

test('Mac helper home must be the exact prepared task home before native execution', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-mac-bound-home-')));
  try {
    await mkdir(join(root, 'bin')); const adapter=join(root, 'bin/coven-desktop-use');
    await writeFile(adapter, 'adapter'); await writeFile(join(root, 'bin/peekaboo'), 'helper'); await chmod(join(root, 'bin/peekaboo'), 0o700);
    const hash = text => createHash('sha256').update(text).digest('hex'); const home=join(root, 'home'); await mkdir(home);
    await writeFile(join(root, 'baseline.json'), JSON.stringify({ nativeSha256: hash('adapter'), helperSha256: hash('helper'), helperHome: home }));
    await verifyMacIdentity(root, adapter, join(root, 'bin'), { HOME: home, CFFIXED_USER_HOME: home });
    for (const env of [{ HOME: home }, { HOME: '/other', CFFIXED_USER_HOME: home }, { HOME: home, CFFIXED_USER_HOME: '/other' }]) {
      await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'bin'), env), /home/);
    }
    await writeFile(join(root, 'baseline.json'), JSON.stringify({ nativeSha256: hash('adapter'), helperSha256: hash('helper'), fixtureBundleIdentifier:'org.opencoven.desktopuse.acceptance.run-1234' }));
    await assert.rejects(verifyMacIdentity(root, adapter, join(root, 'bin'), { HOME: home, CFFIXED_USER_HOME: home }), /home/);
    assert.throws(() => nativeHarnessEnvironment(root, { PATH:process.env.PATH, HOME: '/other', CFFIXED_USER_HOME: home }, 'darwin'), /home/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nested Mac case temporaries preserve the prepared Foundation home through real stdio', async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'native-mac-case-home-')));const caseRoot=join(root,'case');await mkdir(caseRoot);
  const home=join(root,'home');const env={PATH:process.env.PATH,HOME:home,CFFIXED_USER_HOME:home};
  let transport;let timeout;
  try {
    transport=new StdioClientTransport({command:process.execPath,args:['-e','console.log(JSON.stringify({jsonrpc:"2.0",method:"fixture/env",params:{temporary:process.env.TMPDIR,home:process.env.HOME,foundationHome:process.env.CFFIXED_USER_HOME}}));setInterval(()=>{},1000)'],env:nativeHarnessEnvironment(caseRoot,env,'darwin',root),stderr:'pipe'});
    const observed=new Promise((resolve,reject)=>{transport.onmessage=m=>resolve(m.params);transport.onerror=reject;timeout=setTimeout(()=>reject(new Error('nested stdio environment unavailable')),5000);});
    await transport.start();assert.deepEqual(await observed,{temporary:caseRoot,home,foundationHome:home});
  } finally {clearTimeout(timeout);if(transport)await transport.close();await rm(root,{recursive:true,force:true});}
});

test('Linux negative probes reject an unowned or implicit display before dispatch', () => {
  assert.throws(() => nativeHarnessEnvironment(tmpdir(), { DISPLAY: ':91', XDG_SESSION_TYPE: 'x11' }, 'linux'), /owned disposable display/);
  assert.throws(() => nativeHarnessEnvironment(tmpdir(), { NATIVE_OWNED_DISPOSABLE_DISPLAY: 'yes' }, 'linux'), /explicit owned X11 session/);
});

test('stale fixture state cannot provide a no-effect oracle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-stale-fixture-'));
  try {
    const path = join(root, 'fixture.json');
    await writeFile(path, JSON.stringify({ ready: true, pid: 2147483647, focused: true, windowNumber: 1 }));
    await assert.rejects(focusedFixture(path), /ESRCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
