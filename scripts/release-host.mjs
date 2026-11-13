#!/usr/bin/env node
/** One isolated exact-host lane, using the single attested packed/native pair. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stageRelease, stageCandidateRelease } from './install-adapter.mjs';
import { HOSTS, assertHostInstallation, linkLaneHost, assertInstalledPackage } from './release-qualification.mjs';
import { sha256 } from './release-manifest.mjs';
const [assetsArg, rootArg, version, profile] = process.argv.slice(2);
assert.ok(HOSTS.some(host => host.version === version));
assert.ok(['full', 'observation-only', 'desktop-only', 'stop-only', 'sdk-authorization'].includes(profile));
assert.match(process.version, /^v24\./, 'Explicit compatible Node 24 required');
assert.ok(Number(process.versions.node.split('.')[1]) >= 22, 'Newer host engine requires Node >=24.22');
const assets = resolve(assetsArg);
await mkdir(resolve(rootArg), { recursive: true, mode: 0o700 });
const root = await realpath(resolve(rootArg));
const env = { ...process.env, NODE_PATH: '', COVEN_HOME: join(root, 'coven'), OPENCLAW_STATE_DIR: join(root, 'state'), npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc') };
const run = (command, args, cwd, timeout = 600000) => execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(root, 'npmrc'), '');
const receipt = { status: 'running', profile, node: process.version, syntheticBackend: true, graphicalAcceptance: 'not-run', publication: 'not-run', steps: [] };
try {
  const manifest = JSON.parse(await readFile(join(assets, 'release.json'), 'utf8'));
  assert.equal(manifest.source.commit, process.env.GITHUB_SHA);
  assert.equal(manifest.source.ref, process.env.GITHUB_REF);
  Object.assign(receipt, { runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, runner: process.env.RELEASE_RUNNER, sourceRef: manifest.source.ref, manifestSha256: sha256(await readFile(join(assets, 'release.json'))) });
  const options = { version: manifest.releaseVersion, manifest: join(assets, 'release.json'), assets, root: join(root, 'installation') };
  const staged = manifest.source.tag === null ? await stageCandidateRelease(options, { sourceCommit: process.env.GITHUB_SHA, sourceRef: process.env.GITHUB_REF }) : await stageRelease(options);
  const hostRoot = join(root, 'host'); await mkdir(hostRoot);
  await writeFile(join(hostRoot, 'package.json'), JSON.stringify({ private: true }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `openclaw@${version}`, 'sharp@0.34.5'], hostRoot);
  const host = join(hostRoot, 'node_modules/openclaw');
  const hostLock = join(hostRoot, 'package-lock.json');
  Object.assign(receipt, assertHostInstallation(version, JSON.parse(await readFile(join(host, 'package.json'), 'utf8')), JSON.parse(await readFile(hostLock, 'utf8'))));
  const pluginRoot = join(root, 'plugin'); await mkdir(pluginRoot);
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ private: true }));
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', staged.packagePath], pluginRoot);
  const packed = join(pluginRoot, 'node_modules/@opencoven/openclaw-desktop-use');
  await assertInstalledPackage(packed, manifest.package);
  receipt.sdk = await linkLaneHost(packed, host);
  receipt.packageSha256 = sha256(await readFile(staged.packagePath));
  assert.equal(receipt.packageSha256, manifest.package.sha256);
  receipt.nativeIdentity = JSON.parse(run(staged.adapterPath, ['--version'], root));
  receipt.sourceCommit = manifest.source.commit;
  receipt.stateRoot = root;
  receipt.productionLockSha256 = sha256(await readFile(join(pluginRoot, 'package-lock.json')));
  env.RELEASE_HOST_LOCK = hostLock;
  env.RELEASE_NATIVE_ADAPTER = staged.adapterPath;
  if (profile === 'sdk-authorization') {
    receipt.modelMode = 'host-default-dispatcher-on-newer';
    run(process.execPath, ['scripts/qualify-sdk-authorization.mjs', join(root, 'authorization'), host, packed, version], process.cwd(), 1800000);
    receipt.steps.push({ lane: 'sdk-authorization', status: 'passed' });
  } else {
    receipt.modelMode = version === '2026.11.3' ? 'explicit-toolSearch-false-direct-schema' : 'host-default';
    for (const lane of ['complete', 'capabilities']) {
      run(process.execPath, ['scripts/qualify-gateway.mjs', join(root, lane), host, packed, profile, lane, version], process.cwd(), 2400000);
      receipt.steps.push({ lane, status: 'passed' });
    }
  }
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  // Never preserve raw subprocess stdout/stderr (which can include a gateway token/config).
  receipt.failure = { code: error.code ?? null, exit: error.status ?? null, name: error.name, message: error instanceof assert.AssertionError ? error.message : 'Release host lane failed; inspect sanitized lane receipts.' };
  process.exitCode = 1;
} finally { await writeFile(join(root, 'host-lane.json'), JSON.stringify(receipt, null, 2) + '\n'); }
