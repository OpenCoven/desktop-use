import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyLinuxFixtureBridge } from './linux-fixture-read.mjs';

async function sample() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-openclaw-linux-reader-')));
  const bridge = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const fixture = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const fixtureState = join(root, 'bridge-state.json'), bridgeScript = join(root, 'gtk-openclaw-state.mjs');
  const source = '// controlled source identity\n'; await writeFile(bridgeScript, source);
  const bridgeScriptSha256 = createHash('sha256').update(source).digest('hex');
  const descriptor = { fixturePid: fixture.pid, fixtureBridge: { script: bridgeScript, sha256: bridgeScriptSha256 } };
  const state = { ready: true, pid: fixture.pid, bridgePid: bridge.pid, bridgeStart: '123', observedAtMs: Date.now(), bridgeScriptSha256, processIdentity: { fixtureStart: '456' } };
  const options = { fixtureState, inspectProcess: async pid => pid === fixture.pid
    ? { start: '456', argv: ['python3', '/owned/fixture/fixture.py', '--state', '/owned/fixture-state.json', '--session', 'x11'] }
    : { start: '123', argv: ['node', bridgeScript, '/owned/fixture-state.json', '/owned/client-fixture.pid', '/owned/fixture/fixture.py', '11', fixtureState, '--owned-disposable-display'] } };
  return { root, bridge, fixture, descriptor, state, options, async cleanup() {
    for (const child of [bridge, fixture]) if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
    await rm(root, { recursive: true, force: true });
  } };
}

test('accepts a fresh receipt from the live, selected Linux bridge only', async () => {
  const s = await sample();
  try { await assert.doesNotReject(verifyLinuxFixtureBridge(s.state, s.descriptor, s.options)); }
  finally { await s.cleanup(); }
});
for (const variant of ['stale', 'future', 'dead-bridge', 'dead-fixture', 'pid-reuse', 'wrong-script', 'wrong-output', 'changed-source', 'missing-selection']) test(`rejects Linux bridge receipt: ${variant}`, async () => {
  const s = await sample();
  try {
    if (variant === 'stale') s.state.observedAtMs = Date.now() - 2_000;
    if (variant === 'future') s.state.observedAtMs = Date.now() + 60_000;
    if (variant === 'dead-bridge' || variant === 'dead-fixture') {
      const child = variant === 'dead-bridge' ? s.bridge : s.fixture;
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    }
    const inspect = s.options.inspectProcess;
    s.options.inspectProcess = async pid => {
      const value = await inspect(pid);
      if (variant === 'pid-reuse') value.start = '456';
      if (variant === 'wrong-script') value.argv[1] = '/owned/unrelated.mjs';
      if (variant === 'wrong-output') value.argv[6] = '/owned/unrelated-state.json';
      return value;
    };
    if (variant === 'changed-source') await writeFile(s.descriptor.fixtureBridge.script, '// changed source\n');
    if (variant === 'missing-selection') delete s.descriptor.fixtureBridge;
    await assert.rejects(verifyLinuxFixtureBridge(s.state, s.descriptor, s.options));
  } finally { await s.cleanup(); }
});

for (const variant of ['expiry-during-validation', 'fixture-dies-during-validation', 'bridge-dies-during-validation']) test(`rejects reader review boundary: ${variant}`, async () => {
  const s = await sample();
  try {
    const inspect = s.options.inspectProcess; let triggered = false;
    s.options.inspectProcess = async pid => {
      if (triggered) return inspect(pid);
      triggered = true;
      if (variant === 'expiry-during-validation') await new Promise(resolve => setTimeout(resolve, 1_100));
      else { const child = variant === 'fixture-dies-during-validation' ? s.fixture : s.bridge; const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
      return inspect(pid);
    };
    await assert.rejects(verifyLinuxFixtureBridge(s.state, s.descriptor, s.options));
  } finally { await s.cleanup(); }
});
