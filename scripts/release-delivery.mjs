#!/usr/bin/env node
/** Immutable post-qualification index. This script never publishes or changes source artifacts. */
import assert from 'node:assert/strict';
import { writeFile, mkdir, cp, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateReleaseManifest, readRegular, REPOSITORY } from './release-manifest.mjs';
import { NATIVE_MATRIX, HOSTS } from './release-qualification.mjs';
export { sha256 };
export const PROFILES = ['full', 'observation-only', 'desktop-only', 'stop-only', 'sdk-authorization'];
export const workflowContext = () => ({ repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME, delivery: process.env.RELEASE_DELIVERY ?? 'prepare', runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
export function releaseSource(version, context) {
  assert.match(version, /^0\.1\.[0-9]+$/);
  assert.equal(context.repository, REPOSITORY);
  assert.match(context.commit, /^[a-f0-9]{40}$/);
  const tag = context.ref === `refs/tags/v${version}` ? `v${version}` : null;
  assert.ok(tag || /^refs\/heads\/[A-Za-z0-9_./-]+$/.test(context.ref), 'Actual matching version tag or branch context required');
  return { repository: REPOSITORY, commit: context.commit, tag, ref: context.ref, workflow: '.github/workflows/release.yml' };
}
export function assertDelivery(version, evidence, context) {
  const source = releaseSource(version, context);
  assert.equal(source.tag, `v${version}`, 'Delivery requires actual matching tag provenance');
  assert.equal(context.event, 'workflow_dispatch');
  assert.ok(['stage', 'stage-bootstrap'].includes(context.delivery), 'Explicit manual staging intent required');
  for (const key of ['commit', 'ref', 'tag']) assert.equal(evidence.source[key], source[key]);
  for (const key of ['runId', 'runAttempt']) assert.equal(evidence[key], context[key]);
  assert.equal(evidence.qualification, 'passed');
  if (context.delivery === 'stage-bootstrap') {
    assert.equal(version, '0.1.3', 'Bootstrap is only the first paired version');
    assert.equal(context.previousRecordPresent, false, 'Bootstrap forbids any previous qualification record');
    assert.equal(evidence.priorCandidate, null);
    assert.equal(evidence.updateRollback, 'not-run');
  } else assert.equal(evidence.updateRollback, 'passed', 'A full real A to B to A to B is required before subsequent delivery');
}
export function assertPreviousManifest(previous, trusted, requirePublic = false) {
  assert.match(trusted.version, /^0\.1\.[0-9]+$/);
  assert.match(trusted.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(previous.releaseVersion, trusted.version);
  assert.equal(previous.source.commit, trusted.sourceCommit);
  assert.equal(previous.source.ref, trusted.sourceRef);
  if (requirePublic) {
    assert.equal(trusted.sourceRef, `refs/tags/v${trusted.version}`);
    assert.equal(previous.source.tag, `v${trusted.version}`);
  }
}
export function collectEvidence(manifestBytes, { installs, hosts }, context) {
  const manifest = validateReleaseManifest(JSON.parse(manifestBytes));
  assert.deepEqual(manifest.source, releaseSource(manifest.releaseVersion, context));
  assert.match(context.runId, /^[1-9][0-9]*$/);
  assert.match(context.runAttempt, /^[1-9][0-9]*$/);
  const binding = { runId: context.runId, runAttempt: context.runAttempt, sourceCommit: manifest.source.commit, sourceRef: manifest.source.ref, manifestSha256: sha256(manifestBytes), packageSha256: manifest.package.sha256 };
  const expected = [
    ...NATIVE_MATRIX.map(({ runner }) => ({ kind: 'install', runner })),
    ...['ubuntu-22.04', 'macos-15'].flatMap(runner => HOSTS.flatMap(host => PROFILES.map(profile => ({ kind: 'host', runner, expectedVersion: host.version, profile })))),
  ];
  assert.equal(installs.length, 4);
  assert.equal(hosts.length, 20);
  const priorCandidate = installs[0].previous ?? null;
  for (const install of installs) {
    assert.deepEqual(install.previous ?? null, priorCandidate, 'All native install lanes use the same prior pair');
    assert.equal(install.updateRollback, priorCandidate ? 'passed' : 'not-run-no-previous-candidate');
  }
  const lanes = expected.map(lane => {
    const { kind, ...keys } = lane;
    const matches = (kind === 'install' ? installs : hosts).filter(receipt => Object.entries(keys).every(([key, value]) => receipt[key] === value));
    assert.equal(matches.length, 1, 'Exactly one receipt per declared lane');
    const receipt = matches[0];
    assert.equal(receipt.status, 'passed', 'All actual qualification lanes must pass');
    for (const [key, value] of Object.entries(binding)) assert.equal(receipt[key], value, `Receipt ${key} must bind the exact pair`);
    if (kind === 'install') {
      assert.equal(receipt.rustGuard?.active, true);
      assert.deepEqual(receipt.rustGuard.attempts, []);
    }
    return { ...lane, status: 'passed', receiptSha256: sha256(Buffer.from(JSON.stringify(receipt))) };
  });
  return { schemaVersion: 1, releaseVersion: manifest.releaseVersion, source: manifest.source, runId: context.runId, runAttempt: context.runAttempt,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${context.runId}/attempts/${context.runAttempt}`,
    manifest: { asset: 'release.json', sha256: binding.manifestSha256 }, package: { asset: manifest.package.asset, sha256: manifest.package.sha256 },
    artifacts: manifest.artifacts.map(({ asset, sha256: digest, target }) => ({ asset, sha256: digest, target })), lanes,
    priorCandidate, qualification: 'passed', updateRollback: installs.every(receipt => receipt.updateRollback === 'passed') ? 'passed' : 'not-run',
    publication: 'not-run', graphicalAcceptance: 'not-run', identitySigning: 'not-run', notarization: 'not-run' };
}
async function main() {
  const [assetsArg, receiptsArg, outputArg] = process.argv.slice(2);
  assert.ok(assetsArg && receiptsArg && outputArg);
  const assets = resolve(assetsArg), receipts = resolve(receiptsArg), output = resolve(outputArg);
  const manifestBytes = await readRegular(join(assets, 'release.json'));
  const manifest = validateReleaseManifest(JSON.parse(manifestBytes));
  const read = async path => JSON.parse(await readRegular(path));
  const installs = await Promise.all(NATIVE_MATRIX.map(({ runner }) => read(join(receipts, `release-install-${runner}`, 'installation.json'))));
  const hosts = await Promise.all(['ubuntu-22.04', 'macos-15'].flatMap(runner => HOSTS.flatMap(host => PROFILES.map(profile => read(join(receipts, `release-host-${runner}-${host.version}-${profile}`, 'host-lane.json'))))));
  const evidence = collectEvidence(manifestBytes, { installs, hosts }, workflowContext());
  await mkdir(output, { mode: 0o700 });
  // Copy and rehash the already attested bytes; never modify/relabel the input manifest.
  for (const descriptor of [{ asset: 'release.json', sha256: sha256(manifestBytes) }, manifest.package, ...manifest.artifacts]) {
    const bytes = await readRegular(join(assets, descriptor.asset));
    assert.equal(sha256(bytes), descriptor.sha256);
    await writeFile(join(output, descriptor.asset), bytes, { flag: 'wx' });
  }
  await writeFile(join(output, 'release-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'qualification-receipts.json'), JSON.stringify({ installs, hosts }, null, 2) + '\n', { flag: 'wx' });
  await cp(new URL('../docs/release-notes.md', import.meta.url), join(output, 'release-notes.md'), { errorOnExist: true, force: false });
  const files = ['release.json', manifest.package.asset, ...manifest.artifacts.map(a => a.asset), 'release-evidence.json', 'qualification-receipts.json', 'release-notes.md'];
  const sums = await Promise.all(files.map(async asset => `${sha256(await readRegular(join(output, asset)))}  ${asset}`));
  await writeFile(join(output, 'SHA256SUMS'), sums.join('\n') + '\n', { flag: 'wx' });
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) await main();
