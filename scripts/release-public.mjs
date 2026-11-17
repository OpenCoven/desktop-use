#!/usr/bin/env node
/** Download and verify a public pair. No installation, activation or registry mutation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseManifest, readRegular, describeArchive, inspectPair, sha256, REPOSITORY, WORKFLOW, LIMIT } from './release-manifest.mjs';
import { collectEvidence } from './release-delivery.mjs';
export async function checkPublicPairBytes(directory, { version, sourceCommit }) {
  assert.match(version, /^0\.1\.[0-9]+$/);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const manifest = validateReleaseManifest(JSON.parse(await readRegular(join(directory, 'release.json'))));
  assert.equal(manifest.releaseVersion, version);
  assert.equal(manifest.source.commit, sourceCommit, 'Independently reviewed full source identity required');
  assert.equal(manifest.source.tag, `v${version}`);
  assert.equal(manifest.source.ref, `refs/tags/v${version}`);
  const packageBytes = await readRegular(join(directory, manifest.package.asset));
  for (const descriptor of [manifest.package, ...manifest.artifacts]) {
    const bytes = await readRegular(join(directory, descriptor.asset));
    const actual = describeArchive(descriptor.asset, bytes);
    for (const field of ['bytes', 'sha256', 'entries']) assert.deepEqual(actual[field], descriptor[field]);
    if (descriptor !== manifest.package) inspectPair(manifest, packageBytes, bytes, descriptor);
  }
  return manifest;
}
export function assertRegistryPackage(manifest, metadata, bytes) {
  assert.equal(metadata.name, manifest.package.name);
  assert.equal(metadata.version, manifest.releaseVersion);
  assert.equal(sha256(bytes), manifest.package.sha256, 'Registry must serve the exact attested tarball, never repacked bytes');
  assert.equal(metadata.dist?.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
}
async function download(url, limit = LIMIT) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert.equal(response.status, 200, 'Public asset must be available');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= limit, 'Bounded public download');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function main() {
  const [version, sourceCommit, outputArg] = process.argv.slice(2);
  assert.match(version, /^0\.1\.[0-9]+$/);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(outputArg && process.argv.length === 5, 'Usage: release-public.mjs VERSION FULL_SOURCE_SHA NEW_OUTPUT_DIRECTORY');
  const output = resolve(outputArg);
  await mkdir(output, { mode: 0o700 });
  const receipt = { status: 'running', version, sourceCommit, publication: 'not-verified', installation: 'not-run', graphicalAcceptance: 'not-run' };
  try {
    const base = `https://github.com/${REPOSITORY}/releases/download/v${version}`;
    const manifestBytes = await download(`${base}/release.json`, 2 * 1024 * 1024);
    await writeFile(join(output, 'release.json'), manifestBytes, { flag: 'wx' });
    const manifest = validateReleaseManifest(JSON.parse(manifestBytes));
    assert.equal(manifest.releaseVersion, version);
    assert.equal(manifest.source.commit, sourceCommit);
    assert.equal(manifest.source.ref, `refs/tags/v${version}`);
    assert.equal(manifest.source.tag, `v${version}`);
    const files = ['release.json', manifest.package.asset, ...manifest.artifacts.map(a => a.asset), 'release-evidence.json', 'qualification-receipts.json', 'release-notes.md', 'SHA256SUMS'];
    const sums = [];
    for (const asset of files) {
      const path = join(output, asset);
      if (asset !== 'release.json') await writeFile(path, await download(`${base}/${asset}`), { flag: 'wx' });
      const bytes = await readRegular(path);
      if (asset !== 'SHA256SUMS') sums.push(`${sha256(bytes)}  ${asset}`);
      const result = JSON.parse(execFileSync('gh', ['attestation', 'verify', path, '--repo', REPOSITORY, '--signer-workflow', WORKFLOW, '--source-digest', sourceCommit, '--source-ref', `refs/tags/v${version}`, '--deny-self-hosted-runners', '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json'], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_HOST: 'github.com' } }));
      assert.ok(Array.isArray(result) && result.length > 0, 'Mandatory real GitHub provenance verification');
    }
    assert.equal((await readRegular(join(output, 'SHA256SUMS'))).toString(), sums.join('\n') + '\n');
    await checkPublicPairBytes(output, { version, sourceCommit });
    const evidence = JSON.parse(await readRegular(join(output, 'release-evidence.json')));
    const qualification = JSON.parse(await readRegular(join(output, 'qualification-receipts.json')));
    assert.deepEqual(evidence, collectEvidence(manifestBytes, qualification, { repository: REPOSITORY, commit: sourceCommit, ref: `refs/tags/v${version}`, runId: evidence.runId, runAttempt: evidence.runAttempt }));
    const metadata = JSON.parse(await download(`https://registry.npmjs.org/@opencoven%2fopenclaw-desktop-use/${version}`, 2 * 1024 * 1024));
    const tarball = new URL(metadata.dist.tarball);
    assert.equal(tarball.origin, 'https://registry.npmjs.org');
    assert.equal(tarball.username + tarball.password, '');
    const registryBytes = await download(tarball);
    assertRegistryPackage(manifest, metadata, registryBytes);
    assert.ok(metadata.dist.attestations?.url, 'npm provenance must be present; installed npm audit signatures remains required');
    receipt.status = 'passed';
    receipt.publication = 'public-downloads-and-github-provenance-verified';
    receipt.manifestSha256 = sha256(manifestBytes);
    receipt.packageSha256 = manifest.package.sha256;
    receipt.registryIntegrity = metadata.dist.integrity;
    receipt.npmProvenance = 'present-not-yet-audit-verified';
    receipt.releaseUrl = `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
    receipt.assets = files;
  } catch (error) {
    receipt.status = 'failed';
    receipt.failure = { name: error.name, message: 'Public verification failed; no installation or activation attempted.' };
    throw error;
  } finally {
    await writeFile(join(output, 'public-download.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) await main();
