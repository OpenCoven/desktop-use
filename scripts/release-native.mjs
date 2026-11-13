#!/usr/bin/env node
/** Native producer: build on the declared runner, archive, extract and execute those bytes. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, cp, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertRunner } from './release-qualification.mjs';
import { assertIdentity, inspectPair, sha256, readRegular, describeArchive } from './release-manifest.mjs';
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
export async function verifyNativePair(assets, manifest) {
  const artifact = manifest.artifacts[0];
  const packageBytes = await readRegular(join(assets, manifest.package.asset));
  const nativeBytes = await readRegular(join(assets, artifact.asset));
  const { native } = inspectPair(manifest, packageBytes, nativeBytes, artifact);
  const extracted = await mkdtemp(join(tmpdir(), 'release-native-extracted-'));
  try {
    for (const entry of native) await writeFile(join(extracted, entry.path), entry.data, { mode: entry.executable ? 0o700 : 0o600 });
    const identity = JSON.parse(run(join(extracted, 'coven-desktop-use'), ['--version']));
    assertIdentity(identity, manifest, artifact.target);
    return { identity, packageSha256: sha256(packageBytes), nativeSha256: sha256(nativeBytes), executedExtractedArchive: true };
  } finally { await rm(extracted, { recursive: true, force: true }); }
}
async function main() {
  const [target, runner, outputArg, packageArg] = process.argv.slice(2);
  assert.ok(target && runner && outputArg && packageArg, 'target runner output package required');
  const output = resolve(outputArg);
  await mkdir(output, { recursive: true });
  const receipt = { status: 'running', target, runner, graphicalAcceptance: 'not-run', publication: 'not-run', notarization: 'not-run', identitySigning: 'not-run' };
  try {
    const rustVersion = run('rustc', ['-vV']);
    const os = process.platform === 'linux' ? await readFile('/etc/os-release', 'utf8') : '';
    const field = key => os.match(new RegExp(`^${key}="?([^"\\n]+)"?$`, 'm'))?.[1];
    const observed = { platform: process.platform, arch: process.arch, rustHost: rustVersion.match(/^host: (.+)$/m)?.[1], runner, osVersion: process.platform === 'darwin' ? run('/usr/bin/sw_vers', ['-productVersion']).trim() : field('VERSION_ID'), osId: field('ID'), kernel: release(), glibc: process.report.getReport().header.glibcVersionRuntime };
    // Derive the observed label from the actual OS/architecture, not the caller's requested label.
    observed.runner = observed.platform === 'darwin'
      ? `macos-${observed.osVersion.split('.')[0]}${observed.arch === 'x64' ? '-intel' : ''}`
      : `ubuntu-${observed.osVersion}${observed.arch === 'arm64' ? '-arm' : ''}`;
    assert.equal(observed.runner, runner, 'Requested label matches actual OS and architecture');
    assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    observed.runnerEnvironment = process.env.RUNNER_ENVIRONMENT;
    observed.imageOS = process.env.ImageOS ?? null;
    observed.imageVersion = process.env.ImageVersion ?? null;
    observed.runnerName = process.env.RUNNER_NAME ?? null;
    assertRunner(target, observed);
    Object.assign(receipt, { observed, rustVersion, deploymentTarget: process.platform === 'darwin' ? '15.0' : null, olderOsExecution: 'not-run' });
    run('cargo', ['build', '--release', '--locked', '--target', target, '--jobs', '2'], { timeout: 900000, env: { ...process.env, CARGO_BUILD_JOBS: '2', ...(process.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: '15.0' } : {}) } });
    const stage = join(output, 'stage'); await mkdir(stage);
    const binary = join(stage, 'coven-desktop-use');
    await cp(join('target', target, 'release/coven-desktop-use'), binary);
    const identity = JSON.parse(run(binary, ['--version']));
    assert.equal(identity.source.commit, process.env.GITHUB_SHA, 'Native identity must match workflow full source');
    assert.equal(identity.source.dirty, false);
    await writeFile(join(stage, 'release-identity.json'), JSON.stringify(identity) + '\n', { mode: 0o644 });
    if (process.platform === 'linux') {
      const symbols = run('readelf', ['--version-info', binary]);
      const versions = [...new Set(symbols.match(/GLIBC_[0-9.]+/g) ?? [])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      assert.ok(versions.length, 'Actual linked glibc symbols');
      const maximum = versions.at(-1).slice(6);
      assert.ok(maximum.localeCompare('2.35', undefined, { numeric: true }) <= 0, 'Built artifact must support declared glibc floor');
      receipt.libc = { floor: '2.35', maximumRequiredSymbol: maximum, symbols: versions };
      receipt.linkage = run('ldd', [binary]);
    } else {
      const signing = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', binary], { encoding: 'utf8' });
      const output = signing.stderr + signing.stdout;
      assert.doesNotMatch(output, /^Authority=/m, 'This unsigned candidate workflow must not claim or consume a signing identity');
      receipt.machOSigning = { exit: signing.status, state: /Signature=adhoc/.test(output) ? 'ad-hoc' : 'unsigned', details: output };
      receipt.loadCommands = run('/usr/bin/otool', ['-l', binary]);
    }
    const asset = `coven-desktop-use-${identity.version}-${target}.tar.gz`;
    run('tar', ['--format=ustar', '-czf', join(output, asset), '-C', stage, 'coven-desktop-use', 'release-identity.json'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const packagePath = resolve(packageArg);
    const packageAsset = packagePath.split('/').at(-1);
    await cp(packagePath, join(output, packageAsset));
    const manifest = { releaseVersion: identity.version, source: identity.source, contracts: identity.contracts, package: { name: '@opencoven/openclaw-desktop-use', asset: packageAsset }, artifacts: [{ target, asset }] };
    Object.assign(receipt, await verifyNativePair(output, manifest));
    receipt.artifact = { ...describeArchive(asset, await readFile(join(output, asset))), target, minimumOsVersion: process.platform === 'darwin' ? '15.0' : '22.04', ...(process.platform === 'linux' ? { libc: { family: 'glibc', minimumVersion: '2.35' } } : {}), signing: { status: 'not-run', url: null } };
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = { name: error.name, message: error.message }; throw error;
  } finally { await writeFile(join(output, `native-${target}.json`), JSON.stringify(receipt, null, 2) + '\n'); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) await main();
