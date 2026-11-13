/** Shared release-lane invariants. These checks never grant publisher trust. */
import assert from 'node:assert/strict';
import { readFile, realpath, mkdir, symlink, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
export const HOSTS = Object.freeze([
  Object.freeze({ version: '2026.4.26', integrity: 'sha512-KBKI7gu9d/6NxBfqnojTFcHNJvrOyyYGJ6oczaBKF7zUHVKdm78zZNQOBmwiaHQMrvhjNRo0ry9xXtaAJwhV3A==' }),
  Object.freeze({ version: '2026.11.3', integrity: 'sha512-FBq/q0TCaoA2b7qfdV0q81fHhI6RBB1zAQfJQREc1u2TlK5khVgCUsAlXskLWthyVqRz5PWEj+oOmfYgK58dHg==' }),
]);
export const NATIVE_MATRIX = Object.freeze([
  { target: 'aarch64-apple-darwin', runner: 'macos-15', platform: 'darwin', arch: 'arm64' },
  { target: 'x86_64-apple-darwin', runner: 'macos-15-intel', platform: 'darwin', arch: 'x64' },
  { target: 'x86_64-unknown-linux-gnu', runner: 'ubuntu-22.04', platform: 'linux', arch: 'x64' },
  { target: 'aarch64-unknown-linux-gnu', runner: 'ubuntu-22.04-arm', platform: 'linux', arch: 'arm64' },
].map(Object.freeze));
const atLeast = (actual, minimum) => {
  const a = actual?.split(/[.-]/).map(Number), b = minimum.split('.').map(Number);
  assert.ok(a && a.slice(0, b.length).every(Number.isFinite), 'Observed version required');
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
};
export function assertRunner(target, observed) {
  const lane = NATIVE_MATRIX.find(item => item.target === target);
  assert.ok(lane, 'Declared native target');
  for (const key of ['platform', 'arch', 'runner']) assert.equal(observed[key], lane[key], `Actual ${key}`);
  assert.equal(observed.rustHost, target, 'Native Rust host, no cross compilation');
  assert.ok(atLeast(observed.osVersion, lane.platform === 'darwin' ? '15.0' : '22.04'));
  if (lane.platform === 'linux') {
    assert.equal(observed.osId, 'ubuntu');
    assert.ok(atLeast(observed.glibc, '2.35'));
    assert.ok(atLeast(observed.kernel, '5.15'));
  }
  return lane;
}
export function assertHostInstallation(version, metadata, lock) {
  const expected = HOSTS.find(host => host.version === version);
  assert.ok(expected, 'Frozen supported or proposed host');
  assert.equal(metadata.version, expected.version, 'Actual host version');
  const entry = lock.packages?.['node_modules/openclaw'];
  assert.equal(entry?.version, expected.version, 'Installed lock host version');
  assert.equal(entry?.integrity, expected.integrity, 'Frozen host tarball integrity');
  return { expectedVersion: version, actualVersion: metadata.version, expectedIntegrity: expected.integrity, actualIntegrity: entry.integrity };
}
export async function assertLaneResolution(packed, host) {
  host = await realpath(host);
  const require = createRequire(join(packed, 'package.json'));
  const receipt = {};
  for (const [field, module] of [['pluginSdk', 'plugin-entry'], ['preflightSdk', 'state-paths']]) {
    const path = await realpath(require.resolve(`openclaw/plugin-sdk/${module}`));
    assert.ok(path.startsWith(host + sep), `${field} must resolve through selected lane host, never checkout`);
    receipt[field] = path;
    receipt[`${field}Sha256`] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return { ...receipt, host, packed: await realpath(packed), ancestorFallback: false };
}
export async function linkLaneHost(packed, host) {
  await mkdir(join(packed, 'node_modules'), { recursive: true });
  const link = join(packed, 'node_modules/openclaw');
  try { await symlink(await realpath(host), link); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(await realpath(link), await realpath(host), 'Existing lane SDK must be the exact host');
  }
  return assertLaneResolution(packed, host);
}
export function assertUpgradePair(previous, current) {
  assert.match(previous.releaseVersion, /^0\.1\.[0-9]+$/);
  assert.match(current.releaseVersion, /^0\.1\.[0-9]+$/);
  assert.ok(Number(previous.releaseVersion.split('.').at(-1)) < Number(current.releaseVersion.split('.').at(-1)), 'Real update requires a newer version');
  assert.notEqual(previous.source.commit, current.source.commit, 'Each version has its own real source identity');
}

export async function assertInstalledPackage(packed, descriptor) {
  const root = await realpath(packed);
  for (const entry of descriptor.entries) {
    assert.ok(entry.path.startsWith('package/'));
    const path = join(root, entry.path.slice('package/'.length));
    assert.ok((await realpath(path)).startsWith(root + sep), 'Installed file stays within packed package');
    assert.ok((await lstat(path)).isFile(), 'Installed runtime entry is a regular file');
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.bytes, `Installed size: ${entry.path}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Installed digest: ${entry.path}`);
  }
}
export async function qualifyCandidateSequence({ previous, current, stage, activate, consume }) {
  if (previous) assertUpgradePair(previous, current);
  for (const candidate of previous ? [previous, current] : [current]) await stage(candidate);
  const sequence = previous ? [previous, current, previous, current] : [current];
  for (let index = 0; index < sequence.length; index++) {
    const candidate = sequence[index];
    const selected = await activate(candidate, index === 2 ? 'rollback' : 'activate');
    // A failed package synchronization or consumer ends qualification with the selection visible.
    await consume(candidate, selected, index);
  }
}
export function assertLoadedSdk(records, lane) {
  assert.ok(Array.isArray(records) && records.length > 0, 'Actual plugin execution must report its loaded SDK');
  for (const record of records) assert.equal(record.sdkEntry, lane.pluginSdk, 'Loaded plugin SDK equals lane preflight SDK host');
}
