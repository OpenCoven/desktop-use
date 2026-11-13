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
