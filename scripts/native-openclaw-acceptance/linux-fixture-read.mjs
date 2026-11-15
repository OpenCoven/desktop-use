import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, basename } from 'node:path';

async function inspectLinuxProcess(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  assert.notEqual(fields[0], 'Z', 'Bridge cannot be a zombie');
  assert.match(fields[19], /^\d+$/);
  return { start: fields[19], argv: (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0').filter(Boolean) };
}

export async function verifyLinuxFixtureBridge(state, descriptor, { fixtureState, inspectProcess = inspectLinuxProcess }) {
  const selected = descriptor.fixtureBridge;
  assert.ok(selected && typeof selected.script === 'string' && isAbsolute(selected.script), 'Select the exact Linux bridge script');
  assert.match(selected.sha256, /^[a-f0-9]{64}$/);
  assert.equal(state.ready, true); assert.equal(state.pid, descriptor.fixturePid);
  assert.ok(Number.isSafeInteger(state.bridgePid) && state.bridgePid > 1 && state.bridgePid !== state.pid, 'Live bridge identity required');
  function freshAndLive() {
    process.kill(state.pid, 0); process.kill(state.bridgePid, 0);
    const now = Date.now();
    assert.ok(Number.isSafeInteger(state.observedAtMs) && state.observedAtMs <= now && now - state.observedAtMs <= 1_000, 'Fresh Linux bridge observation required');
  }
  freshAndLive();
  const script = await realpath(selected.script);
  assert.equal(createHash('sha256').update(await readFile(script)).digest('hex'), selected.sha256, 'Bridge source changed after selection');
  assert.equal(state.bridgeScriptSha256, selected.sha256, 'Receipt must identify the selected bridge bytes');
  const actual = await inspectProcess(state.bridgePid);
  assert.equal(actual.start, state.bridgeStart, 'Bridge process start identity changed');
  assert.equal(basename(actual.argv[0]), 'node');
  assert.equal(actual.argv.length, 8, 'Exact bridge invocation required');
  assert.equal(await realpath(actual.argv[1]), script, 'Live bridge must execute the selected script');
  assert.equal(actual.argv[6], fixtureState, 'Live bridge must write the selected fixture receipt');
  assert.equal(actual.argv[7], '--owned-disposable-display', 'Live bridge must acknowledge the owned display');
  const fixture = await inspectProcess(state.pid);
  assert.equal(fixture.start, state.processIdentity?.fixtureStart, 'GTK process start identity changed');
  assert.ok(/^python3(?:\.\d+)?$/.test(basename(fixture.argv[0])) && fixture.argv[1] === actual.argv[4] && fixture.argv[fixture.argv.indexOf('--state') + 1] === actual.argv[2], 'Live GTK process must own the bridge input');
  const [closingBridge, closingFixture] = await Promise.all([inspectProcess(state.bridgePid), inspectProcess(state.pid)]);
  assert.deepEqual(closingBridge, actual, 'Bridge identity changed during validation');
  assert.deepEqual(closingFixture, fixture, 'GTK identity changed during validation');
  freshAndLive();
  assert.ok(isAbsolute(actual.argv[2]), 'Independent probes require the absolute raw GTK state path');
  return { rawFixtureState: actual.argv[2] };
}
