#!/usr/bin/env node
/** Read-only delivery preflight. Never configures protection, credentials or publishers. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readRegular, sha256, validateReleaseManifest, REPOSITORY, WORKFLOW } from './release-manifest.mjs';
import { collectEvidence, assertDelivery, workflowContext } from './release-delivery.mjs';
const directory = resolve(process.argv[2]);
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_HOST: 'github.com' } });
const manifestBytes = await readRegular(join(directory, 'release.json'));
const manifest = validateReleaseManifest(JSON.parse(manifestBytes));
const evidence = JSON.parse(await readRegular(join(directory, 'release-evidence.json')));
const receipts = JSON.parse(await readRegular(join(directory, 'qualification-receipts.json')));
assert.deepEqual(evidence, collectEvidence(manifestBytes, receipts, workflowContext()));
assertDelivery(manifest.releaseVersion, evidence, { ...workflowContext(), previousRecordPresent: existsSync('qualification/release-previous.json') });
assert.equal(run('git', ['rev-parse', `refs/tags/${manifest.source.tag}^{commit}`]).trim(), manifest.source.commit);
assert.equal(run('git', ['rev-parse', 'HEAD']).trim(), manifest.source.commit);
run('git', ['merge-base', '--is-ancestor', manifest.source.commit, 'origin/main']);
const files = ['release.json', manifest.package.asset, ...manifest.artifacts.map(a => a.asset), 'release-evidence.json', 'qualification-receipts.json', 'release-notes.md'];
const sums = [];
for (const asset of [...files, 'SHA256SUMS']) {
  const path = join(directory, asset);
  const bytes = await readRegular(path);
  if (files.includes(asset)) sums.push(`${sha256(bytes)}  ${asset}`);
  if (asset === manifest.package.asset) assert.equal(sha256(bytes), manifest.package.sha256);
  const descriptor = manifest.artifacts.find(a => a.asset === asset);
  if (descriptor) assert.equal(sha256(bytes), descriptor.sha256);
  const result = JSON.parse(run('gh', ['attestation', 'verify', path, '--repo', REPOSITORY, '--signer-workflow', WORKFLOW, '--source-digest', manifest.source.commit, '--source-ref', manifest.source.ref, '--deny-self-hosted-runners', '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json']));
  assert.ok(Array.isArray(result) && result.length > 0);
}
assert.equal((await readRegular(join(directory, 'SHA256SUMS'))).toString(), sums.join('\n') + '\n');
// Existing npm versions or releases must be investigated, never overwritten or automatically retried.
const registry = await fetch(`https://registry.npmjs.org/@opencoven%2fopenclaw-desktop-use/${manifest.releaseVersion}`, { signal: AbortSignal.timeout(30000) });
assert.equal(registry.status, 404, 'Version must still be unpublished; staged-version availability remains npm-enforced');
const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${REPOSITORY}/releases?per_page=100`])).flat();
assert.equal(releases.some(release => release.tag_name === manifest.source.tag), false, 'Existing release requires explicit recovery review');
console.log(JSON.stringify({ status: 'preflight-passed', source: manifest.source, npmPublisher: 'not-inspected', publication: 'not-run', graphicalAcceptance: 'not-run' }));
