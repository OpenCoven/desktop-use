#!/usr/bin/env node
/** Assemble the single package and all four native receipts into an attestation subject. */
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { assembleReleaseManifest, sha256 } from './release-manifest.mjs';
import { releaseSource, workflowContext } from './release-delivery.mjs';
import { NATIVE_MATRIX, HOSTS } from './release-qualification.mjs';
const assets = resolve(process.argv[2]);
assert.equal(process.env.GITHUB_REPOSITORY, 'OpenCoven/desktop-use');
assert.match(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/);
const packages = (await readdir(assets)).filter(name => name.endsWith('.tgz'));
assert.equal(packages.length, 1, 'All native lanes consume exactly one packed asset');
const packed = await readFile(join(assets, packages[0]));
const receipts = await Promise.all(NATIVE_MATRIX.map(async lane => {
  const receipt = JSON.parse(await readFile(join(assets, `native-${lane.target}.json`), 'utf8'));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.packageSha256, sha256(packed));
  assert.equal(receipt.identity.source.commit, process.env.GITHUB_SHA);
  assert.equal(receipt.nativeSha256, sha256(await readFile(join(assets, receipt.artifact.asset))));
  return receipt;
}));
const identity = receipts[0].identity;
const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const evidence = Object.fromEntries(['build', 'nativeSmoke', 'cleanInstall', 'hostedGateway', 'publication', 'graphicalAcceptance'].map(key => [key, { status: key === 'build' || key === 'nativeSmoke' ? 'passed' : 'not-run', urls: key === 'build' || key === 'nativeSmoke' ? [url] : [] }]));
const manifest = await assembleReleaseManifest({ assetDirectory: assets, schemaVersion: 1, releaseVersion: identity.releaseVersion,
  source: releaseSource(identity.releaseVersion, workflowContext()),
  adapterProtocolVersion: 1, contracts: identity.contracts,
  package: { asset: packages[0], name: '@opencoven/openclaw-desktop-use', version: identity.releaseVersion, sourceCommit: process.env.GITHUB_SHA, adapterProtocolVersion: 1, surfaces: ['plugin', 'sdk', 'mcp'] },
  artifacts: receipts.map(receipt => receipt.artifact), qualifiedHosts: HOSTS.map(host => ({ ...host, status: 'not-run', evidenceUrl: null })), evidence });
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(assets, 'release.json'), bytes, { flag: 'wx' });
const checksums = [{ asset: 'release.json', sha256: sha256(bytes) }, manifest.package, ...manifest.artifacts].map(asset => `${asset.sha256}  ${asset.asset}`).join('\n') + '\n';
await writeFile(join(assets, 'SHA256SUMS'), checksums, { flag: 'wx' });
