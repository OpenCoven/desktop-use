import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRunner, assertHostInstallation, assertLaneResolution, assertUpgradePair, HOSTS, NATIVE_MATRIX } from './release-qualification.mjs';

test('native matrix refuses runner architecture, Rust host and OS substitutions', () => {
  const lane = NATIVE_MATRIX[0];
  const observed = { platform: 'darwin', arch: 'arm64', rustHost: lane.target, runner: lane.runner, osVersion: '15.7', kernel: '24.6.0' };
  assert.doesNotThrow(() => assertRunner(lane.target, observed));
  for (const patch of [{ arch: 'x64' }, { rustHost: 'x86_64-apple-darwin' }, { runner: 'macos-latest' }, { osVersion: '14.0' }]) {
    assert.throws(() => assertRunner(lane.target, { ...observed, ...patch }));
  }
  const linux = { platform: 'linux', arch: 'x64', rustHost: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-22.04', osVersion: '22.04', osId: 'ubuntu', glibc: '2.35', kernel: '5.15.0' };
  assert.doesNotThrow(() => assertRunner(linux.rustHost, linux));
  assert.throws(() => assertRunner(linux.rustHost, { ...linux, glibc: '2.34' }));
});

test('exact host must match frozen version and actual npm lock integrity', () => {
  const expected = HOSTS[0];
  const lock = { packages: { 'node_modules/openclaw': { version: expected.version, integrity: expected.integrity } } };
  assert.doesNotThrow(() => assertHostInstallation(expected.version, { version: expected.version }, lock));
  assert.throws(() => assertHostInstallation(HOSTS[1].version, { version: expected.version }, lock));
  assert.throws(() => assertHostInstallation(expected.version, { version: expected.version }, { packages: { 'node_modules/openclaw': { version: expected.version, integrity: 'sha512-substituted' } } }));
});

test('preflight and plugin resolve exact lane SDK and reject checkout ancestor fallback', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'release-lane-test-')));
  try {
    const host = join(root, 'host');
    const packed = join(root, 'packed');
    await mkdir(host); await mkdir(join(packed, 'node_modules'), { recursive: true });
    await writeFile(join(host, 'package.json'), JSON.stringify({ name: 'openclaw', version: HOSTS[0].version, exports: { './plugin-sdk/plugin-entry': './entry.js', './plugin-sdk/state-paths': './state.js' } }));
    await writeFile(join(host, 'entry.js'), 'export {};'); await writeFile(join(host, 'state.js'), 'export {};');
    await writeFile(join(packed, 'package.json'), '{}');
    await symlink(host, join(packed, 'node_modules/openclaw'));
    const receipt = await assertLaneResolution(packed, host);
    assert.equal(receipt.pluginSdk, join(host, 'entry.js'));
    assert.equal(receipt.preflightSdk, join(host, 'state.js'));
    await assert.rejects(assertLaneResolution(packed, join(root, 'checkout-host')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('upgrade requires two versions and separately source-bound candidates', () => {
  const a = { releaseVersion: '0.1.3', source: { commit: 'a'.repeat(40) } };
  const b = { releaseVersion: '0.1.4', source: { commit: 'b'.repeat(40) } };
  assert.doesNotThrow(() => assertUpgradePair(a, b));
  assert.throws(() => assertUpgradePair(a, a));
  assert.throws(() => assertUpgradePair(a, { ...b, source: a.source }));
});

test('installed package tree rejects substituted runtime despite unchanged identity metadata', async () => {
  const { assertInstalledPackage } = await import('./release-qualification.mjs');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'release-installed-test-'));
  try {
    const bytes = Buffer.from('export const value = 1;');
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.js'), bytes);
    const descriptor = { entries: [{ path: 'package/dist/index.js', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] };
    await assertInstalledPackage(root, descriptor);
    await writeFile(join(root, 'dist/index.js'), 'export const value = 2;');
    await assert.rejects(assertInstalledPackage(root, descriptor));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner executes A to B to A to B with actual consumption after every selection', async () => {
  const { qualifyCandidateSequence } = await import('./release-qualification.mjs');
  const previous = { releaseVersion: '0.1.3', source: { commit: 'a'.repeat(40) } };
  const current = { releaseVersion: '0.1.4', source: { commit: 'b'.repeat(40) } };
  const calls = [];
  await qualifyCandidateSequence({ previous, current,
    stage: async manifest => calls.push(`stage:${manifest.releaseVersion}`),
    activate: async (manifest, operation) => { calls.push(`${operation}:${manifest.releaseVersion}`); return { selected: manifest.releaseVersion }; },
    consume: async (manifest, selected) => { assert.equal(selected.selected, manifest.releaseVersion); calls.push(`consume:${manifest.releaseVersion}`); },
  });
  assert.deepEqual(calls, ['stage:0.1.3', 'stage:0.1.4', 'activate:0.1.3', 'consume:0.1.3', 'activate:0.1.4', 'consume:0.1.4', 'rollback:0.1.3', 'consume:0.1.3', 'activate:0.1.4', 'consume:0.1.4']);
});
test('runner stops on partial package synchronization and never reports rollback success', async () => {
  const { qualifyCandidateSequence } = await import('./release-qualification.mjs');
  const previous = { releaseVersion: '0.1.3', source: { commit: 'a'.repeat(40) } };
  const current = { releaseVersion: '0.1.4', source: { commit: 'b'.repeat(40) } };
  const selections = [];
  await assert.rejects(qualifyCandidateSequence({ previous, current, stage: async () => {},
    activate: async manifest => { selections.push(manifest.releaseVersion); return manifest; },
    consume: async manifest => { if (manifest === current) throw new Error('PACKAGE_INSTALL_FAILED'); },
  }), /PACKAGE_INSTALL_FAILED/);
  assert.deepEqual(selections, ['0.1.3', '0.1.4']);
});

test('loaded SDK receipt rejects a different host and requires actual plugin execution', async () => {
  const { assertLoadedSdk } = await import('./release-qualification.mjs');
  const lane = { host: '/host/exact', pluginSdk: '/host/exact/plugin-entry.js' };
  assert.doesNotThrow(() => assertLoadedSdk([{ sdkEntry: lane.pluginSdk }], lane));
  assert.throws(() => assertLoadedSdk([], lane));
  assert.throws(() => assertLoadedSdk([{ sdkEntry: '/checkout/peer/plugin-entry.js' }], lane));
});

test('minimal model profile does not imply newer authenticated HTTP denial, but the exact safe Stop result is required', async () => {
  const { assertMinimalHttpPolicy } = await import('./release-qualification.mjs');
  const details = { status: 'success', success: true, action: 'stop', cancellationRequested: 0, state: 'idle' };
  const direct = { status: 200, body: { ok: true, result: { details, content: [{ type: 'text', text: JSON.stringify(details) }] } } };
  assert.equal(assertMinimalHttpPolicy('2026.11.3', direct), 'authenticated-request-expands-profile');
  assert.equal(assertMinimalHttpPolicy('2026.4.26', { status: 404, body: { ok: false } }), 'profile-denied');
  assert.throws(() => assertMinimalHttpPolicy('2026.4.26', direct));
  for (const change of [{ action: 'shell' }, { status: 'error' }, { cancellationRequested: 1 }, { state: 'cancelling' }]) {
    const forged = structuredClone(direct); Object.assign(forged.body.result.details, change);
    assert.throws(() => assertMinimalHttpPolicy('2026.11.3', forged));
  }
});

test('clean-install guard blocks Rust tool resolution and records any attempted use', async () => {
  const { createNoRustGuard } = await import('./release-qualification.mjs');
  const { spawnSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'release-no-rust-'));
  try {
    const guard = await createNoRustGuard(root, process.env.PATH);
    await guard.assertUnused();
    assert.equal((await guard.receipt()).active, true);
    for (const tool of ['cargo', 'rustc', 'rustup']) {
      const result = spawnSync(tool, ['--version', 'private-argument'], { env: { ...process.env, PATH: guard.path }, encoding: 'utf8' });
      assert.equal(result.status, 97);
      assert.doesNotMatch(result.stdout + result.stderr, /private-argument/);
    }
    assert.deepEqual((await guard.receipt()).attempts.map(attempt => attempt.tool), ['cargo', 'rustc', 'rustup']);
    await assert.rejects(guard.assertUnused(), /Rust tool invocation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit deny accepts only the exact pre-provider guard or a proven no-tool provider completion', async () => {
  const { assertExplicitDenyModel } = await import('./release-qualification.mjs');
  const error = 'Error: No callable tools remain after resolving explicit tool allowlist (agents.denied-qualification.tools.allow: computer_use, desktop_use); no registered tools matched. Fix the allowlist or enable the plugin that registers the requested tool.';
  const rejected = { hostVersion: '2026.4.26', outcome: { status: 'error', error }, providerCalls: 0, providerResponses: [], messages: [] };
  assert.equal(assertExplicitDenyModel(rejected), 'pre-provider-explicit-allowlist-rejection');
  assert.equal(assertExplicitDenyModel({ ...rejected, hostVersion: '2026.11.3' }), 'pre-provider-explicit-allowlist-rejection');
  const completed = { ...rejected, outcome: { status: 'ok' }, providerCalls: 1, providerResponses: [{ case: 'explicit-deny-model', tools: [], finished: true }], messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Qualification explicit-deny-model complete.' }] }] };
  assert.equal(assertExplicitDenyModel(completed), 'no-tool-provider-completion');
  for (const change of [
    { outcome: { status: 'error', error: 'AI service error' } },
    { outcome: { status: 'error', error: error.replace('denied-qualification', 'computer-use') } },
    { outcome: { status: 'error', error: error.replace('no registered tools matched', 'the selected model does not support tools') } },
    { outcome: { status: 'error', error: `${error} unrelated failure` } },
    { outcome: { status: 'timeout', error } },
    { providerCalls: 1 },
    { hostVersion: 'unqualified' },
    { messages: [{ role: 'toolResult' }] },
    { messages: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'computer_use' }] }] },
  ]) assert.throws(() => assertExplicitDenyModel({ ...rejected, ...change }));
  for (const change of [
    { providerCalls: 0 }, { providerCalls: 2 }, { providerResponses: [] }, { messages: [] },
    { providerResponses: [{ case: 'different-case', tools: [], finished: true }] },
    { providerResponses: [{ case: 'explicit-deny-model', tools: ['computer_use'], finished: true }] },
    { providerResponses: [{ case: 'explicit-deny-model', tools: [], finished: false }] },
    { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'unrelated response' }] }] },
    { messages: [{ role: 'assistant', tool_calls: [{ id: 'forbidden' }], content: [{ type: 'text', text: 'Qualification explicit-deny-model complete.' }] }] },
  ]) assert.throws(() => assertExplicitDenyModel({ ...completed, ...change }));
});

test('sanitized denial needs exact run and session correlated private guard evidence', async () => {
  const { assertExplicitDenyGuard, assertExplicitDenyModel } = await import('./release-qualification.mjs');
  const runId = '9ece0830-b7ca-4c60-9f89-4da7d229b146';
  const sessionKey = 'agent:denied-qualification:qualification';
  const guard = 'No callable tools remain after resolving explicit tool allowlist (agents.denied-qualification.tools.allow: computer_use, desktop_use); no registered tools matched. Fix the allowlist or enable the plugin that registers the requested tool.';
  const record = { '1': { runId, sessionKey, taskKind: 'turn', errorName: 'Error' }, '2': `lane task error: lane=session:${sessionKey} durationMs=12 error=${JSON.stringify(guard)}` };
  const context = { runId, sessionKey };
  const proof = assertExplicitDenyGuard(JSON.stringify(record), context);
  const error = "⚠️ OpenClaw couldn't finish this reply. Check the conversation before trying again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";
  const result = { hostVersion: '2026.11.3', outcome: { runId, status: 'error', error }, providerCalls: 0, providerResponses: [], messages: [], guardEvidence: proof, sessionKey };
  assert.equal(assertExplicitDenyModel(result), 'correlated-pre-provider-explicit-allowlist-rejection');
  for (const bad of [
    { ...record, '1': { ...record['1'], runId: 'other' } },
    { ...record, '1': { ...record['1'], sessionKey: 'agent:other:qualification' } },
    { ...record, '1': { ...record['1'], taskKind: 'cron' } },
    { ...record, '1': { ...record['1'], errorName: 'TypeError' } },
    { ...record, '2': record['2'].replace('lane=session:', 'lane=wrong:') },
    { ...record, '2': record['2'].replace('no registered tools matched', 'runtime failed') },
    { ...record, '2': `${record['2']} extra error` },
    { '2': `[tools] ${guard}` },
  ]) assert.throws(() => assertExplicitDenyGuard(JSON.stringify(bad), context));
  assert.throws(() => assertExplicitDenyGuard([record, record].map(JSON.stringify).join('\n'), context));
  assert.throws(() => assertExplicitDenyGuard([record, { ...record, '2': record['2'].replace('no registered tools matched', 'runtime failed') }].map(JSON.stringify).join('\n'), context));
  for (const change of [
    { guardEvidence: undefined }, { providerCalls: 1 }, { sessionKey: 'other' },
    { hostVersion: '2026.4.26' }, { outcome: { runId: 'other', status: 'error', error } },
    { outcome: { runId, status: 'error', error: 'AI service error' } },
  ]) assert.throws(() => assertExplicitDenyModel({ ...result, ...change }));
});
