import assert from 'node:assert/strict';
import { readFile, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute, basename, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyArchiveFiles } from './archive-files.mjs';
import { verifyHostRuntimeStage } from './runtime-stage.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readJson(path) {
  const bytes = await readFile(path);
  assert.ok(bytes.length <= 2 * 1024 * 1024, 'Bounded metadata required');
  return JSON.parse(bytes.toString('utf8'));
}
export async function preflight(d, { runNative = false } = {}) {
  assert.equal(d.schemaVersion, 1);
  assert.match(d.sourceCommit, /^[a-f0-9]{40}$/); assert.match(d.sourceTree, /^[a-f0-9]{40}$/);
  assert.match(d.packageSha256, /^[a-f0-9]{64}$/); assert.match(d.adapterSha256, /^[a-f0-9]{64}$/);
  assert.ok(['darwin', 'linux'].includes(d.platform) && d.platform === process.platform, 'Selected native platform must match runner');
  for (const key of ['host', 'pluginRoot', 'adapter', 'fixtureState', 'packageArchive']) assert.ok(isAbsolute(d[key]), 'Explicit absolute selected paths required');
  const [pluginRoot, host, adapter, fixtureState] = await Promise.all([d.pluginRoot, d.host, d.adapter, d.fixtureState].map(path => realpath(path)));
  const [pkg, hostPkg, fixture, archiveBytes, nativeBytes] = await Promise.all([readJson(join(pluginRoot, 'package.json')), readJson(join(host, 'package.json')), readJson(fixtureState), readFile(d.packageArchive), readFile(adapter)]);
  assert.equal(pkg.name, '@opencoven/openclaw-desktop-use'); assert.equal(pkg.version, d.packageVersion);
  assert.equal(hostPkg.name, 'openclaw'); assert.equal(hostPkg.version, d.hostVersion);
  assert.ok(['2026.4.26', '2026.11.3'].includes(d.hostVersion), 'Explicit declared official host lane required');
  assert.equal(sha256(archiveBytes), d.packageSha256, 'Packed archive hash must match handoff');
  assert.equal(sha256(nativeBytes), d.adapterSha256, 'Native binary hash must match handoff');
  let identity;
  try { identity = await readJson(join(pluginRoot, 'dist/release-identity.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (identity) {
    assert.equal(identity.source.repository, 'OpenCoven/desktop-use');
    assert.equal(identity.source.commit, d.sourceCommit, 'Embedded package source must match handoff');
    assert.equal(identity.source.dirty, false); assert.equal(identity.releaseVersion, d.packageVersion);
  }
  assert.equal(fixture.ready, true); assert.equal(fixture.pid, d.fixturePid);
  assert.equal(fixture.windowNumber, d.fixtureWindowId, 'Exact owned fixture window required');
  assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0 && Number.isSafeInteger(fixture.windowNumber) && fixture.windowNumber > 0);
  if (d.platform === 'darwin') assert.match(d.fixtureBundleId, /^org\.opencoven\.desktopuse\.[a-z0-9.-]+$/);
  else assert.equal(d.ownedDisposableDisplay, true, 'Linux requires an explicitly owned disposable display');
  const packageInventory = await verifyArchiveFiles(pluginRoot, archiveBytes);
  let hostInventory;
  if (d.hostArchive) {
    const bytes = await readFile(d.hostArchive);
    const official = { '2026.4.26': 'sha512-KBKI7gu9d/6NxBfqnojTFcHNJvrOyyYGJ6oczaBKF7zUHVKdm78zZNQOBmwiaHQMrvhjNRo0ry9xXtaAJwhV3A==', '2026.11.3': 'sha512-FBq/q0TCaoA2b7qfdV0q81fHhI6RBB1zAQfJQREc1u2TlK5khVgCUsAlXskLWthyVqRz5PWEj+oOmfYgK58dHg==' };
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), official[d.hostVersion], 'Host archive must match pinned official registry integrity');
    hostInventory = await verifyArchiveFiles(host, bytes);
  }
  const hostRuntimeStage = await verifyHostRuntimeStage(d.hostRuntimeStage, { host, hostVersion: d.hostVersion, officialHostVerified: Boolean(hostInventory) });
  let helper;
  if (d.helperExecutable) {
    assert.match(d.helperSha256, /^[a-f0-9]{64}$/);
    const path = await realpath(d.helperExecutable);
    assert.equal(d.platform, 'darwin', 'A single Peekaboo helper selector is macOS-only');
    await access(d.helperExecutable, constants.X_OK);
    if (d.platform === 'darwin') {
      assert.equal(basename(d.helperExecutable), 'peekaboo', 'Selected helper must be the literal executable the adapter invokes');
      const effectivePath = `${dirname(d.helperExecutable)}${delimiter}${process.env.PATH ?? ''}`;
      const first = effectivePath.split(delimiter)[0];
      assert.equal(await realpath(join(first, 'peekaboo')), path, 'Effective child PATH must select exactly the pinned helper');
    }
    assert.equal(sha256(await readFile(path)), d.helperSha256, 'Selected helper bytes must match handoff');
    helper = { sha256: d.helperSha256, version: d.helperVersion, sourceCommit: d.helperSourceCommit };
  }
  if (runNative) {
    const lease = d.fixtureLease;
    assert.equal(lease?.acknowledgement, 'native-openclaw-fixture-exclusive', 'Explicit exclusive fixture handoff required');
    assert.ok(typeof lease.ownerThread === 'string' && lease.ownerThread.length > 0);
    for (const key of ['fixturePid', 'fixtureWindowId', 'adapterSha256', 'packageSha256', 'sourceCommit']) assert.equal(lease[key], d[key], 'Lease must bind selected identities');
    const expires = Date.parse(lease.expiresAt);
    assert.ok(expires > Date.now() && expires < Date.now() + 3_600_000, 'A current bounded fixture lease is required');
    assert.ok(hostInventory, 'Official host archive byte verification is required for native execution');
    assert.equal(d.hostOrigin, 'unchanged-official-package', 'Patched-host diagnostics cannot certify an official host');
    if (d.platform === 'darwin') assert.ok(helper, 'Pinned helper identity is required for native execution');
    process.kill(fixture.pid, 0);
  }
  return { schemaVersion: 1, preflightOnly: !runNative, nativeExecuted: false, sourceAssociation: 'owner-handoff', sourceCommit: d.sourceCommit, sourceTree: d.sourceTree, packageVersion: pkg.version, packageSha256: d.packageSha256, adapterSha256: d.adapterSha256, helper, embeddedPackageIdentityChecked: Boolean(identity), installedPackageFilesChecked: packageInventory.files, hostInventory, hostRuntimeStage, hostVersion: hostPkg.version, platform: d.platform, node: process.version, selected: { pluginRoot, host, adapter, fixtureState } };
}
