#!/usr/bin/env node
/** Clean explicit install and real A -> B -> A -> B selection, package reinstall and execution. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  stageRelease,
  activateRelease,
  stageCandidateRelease,
  activateCandidateRelease
} from './install-adapter.mjs';
import {
  assertUpgradePair,
  assertInstalledPackage,
  qualifyCandidateSequence,
  createNoRustGuard
} from './release-qualification.mjs';
import { assertPreviousManifest } from './release-delivery.mjs';
import { sha256 } from './release-manifest.mjs';
const [assetsArg, rootArg, previousArg, publicPreviousPolicyArg] = process.argv.slice(2);
assert.ok(assetsArg && rootArg);
assert.ok(
  !publicPreviousPolicyArg || previousArg,
  'Public previous policy requires previous public assets'
);
const assets = resolve(assetsArg);
await mkdir(resolve(rootArg), { recursive: true, mode: 0o700 });
const root = await realpath(resolve(rootArg));
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_PATH: '',
      COVEN_HOME: join(root, 'coven'),
      OPENCLAW_STATE_DIR: join(root, 'openclaw'),
      npm_config_userconfig: join(root, 'npmrc'),
      npm_config_globalconfig: join(root, 'global-npmrc'),
      npm_config_cache: join(root, 'cache')
    }
  });
await writeFile(join(root, 'npmrc'), '');
process.env.COVEN_HOME = join(root, 'coven');
process.env.OPENCLAW_STATE_DIR = join(root, 'openclaw');
let rustGuard;
const receipt = {
  status: 'running',
  rustRequired: false,
  steps: [],
  graphicalAcceptance: 'not-run',
  liveGateway: 'not-run',
  publication: 'not-run',
  updateRollback: previousArg ? 'pending' : 'not-run-no-previous-candidate'
};
try {
  rustGuard = await createNoRustGuard(root, process.env.PATH);
  process.env.PATH = rustGuard.path;
  const current = JSON.parse(await readFile(join(assets, 'release.json'), 'utf8'));
  assert.equal(current.source.commit, process.env.GITHUB_SHA);
  assert.equal(current.source.ref, process.env.GITHUB_REF);
  Object.assign(receipt, {
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    runner: process.env.RELEASE_RUNNER,
    sourceCommit: current.source.commit,
    sourceRef: current.source.ref,
    manifestSha256: sha256(await readFile(join(assets, 'release.json'))),
    packageSha256: current.package.sha256
  });
  let previous;
  receipt.previous = null;
  if (publicPreviousPolicyArg) {
    assert.equal(current.source.tag, `v${current.releaseVersion}`);
  }
  if (previousArg) {
    previous = JSON.parse(await readFile(join(resolve(previousArg), 'release.json'), 'utf8'));
    const trustedPrevious = JSON.parse(
      await readFile(publicPreviousPolicyArg ?? 'qualification/release-previous.json', 'utf8')
    );
    assertPreviousManifest(previous, trustedPrevious, Boolean(publicPreviousPolicyArg));
    receipt.previous = {
      version: previous.releaseVersion,
      sourceCommit: previous.source.commit,
      sourceRef: previous.source.ref,
      manifestSha256: sha256(await readFile(join(resolve(previousArg), 'release.json')))
    };
    assertUpgradePair(previous, current);
  }
  const consumer = join(root, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@modelcontextprotocol/client@2.4.0'
    ],
    consumer
  );
  await cp(
    new URL('./release-installed-consumer.mjs', import.meta.url),
    join(consumer, 'verify.mjs')
  );
  const installRoot = join(root, 'installation');
  await qualifyCandidateSequence({
    previous,
    current,
    stage: async (manifest) => {
      const directory = manifest === previous ? resolve(previousArg) : assets;
      const policy = { sourceCommit: manifest.source.commit, sourceRef: manifest.source.ref };
      const options = {
        version: manifest.releaseVersion,
        manifest: join(directory, 'release.json'),
        assets: directory,
        root: installRoot
      };
      const staged =
        manifest.source.tag === null
          ? await stageCandidateRelease(options, policy)
          : await stageRelease(options);
      receipt.steps.push({ stage: staged, sourceCommit: manifest.source.commit });
      // Stage is execution verified, but only explicit selection changes the pair.
    },
    activate: async (manifest, operation) => {
      const policy = { sourceCommit: manifest.source.commit, sourceRef: manifest.source.ref };
      const options = { root: installRoot, version: manifest.releaseVersion, operation };
      const selected =
        manifest.source.tag === null
          ? await activateCandidateRelease(options, policy)
          : await activateRelease(options);
      return selected;
    },
    consume: async (manifest, selected, index) => {
      const step = { selection: selected, packageSynchronization: 'pending', consumer: 'pending' };
      receipt.steps.push(step);
      run(
        'npm',
        [
          'install',
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          selected.packagePath
        ],
        consumer
      );
      const packageRoot = join(consumer, 'node_modules/@opencoven/openclaw-desktop-use');
      assert.equal(sha256(await readFile(selected.packagePath)), manifest.package.sha256);
      await assertInstalledPackage(packageRoot, manifest.package);
      step.packageSynchronization = 'passed';
      const workspace = join(consumer, `step-${index}`);
      await mkdir(workspace);
      run(
        process.execPath,
        [
          join(consumer, 'verify.mjs'),
          packageRoot,
          selected.adapterPath,
          manifest.releaseVersion,
          manifest.source.commit
        ],
        workspace
      );
      step.consumer = JSON.parse(
        await readFile(join(workspace, 'installed-consumer.json'), 'utf8')
      );
      const doctor = run(selected.adapterPath, ['doctor'], workspace);
      step.nativeDoctor = JSON.parse(doctor);
      // Doctor may truthfully report unavailable graphical backends while still executing successfully.
      step.packageSha256 = manifest.package.sha256;
      await writeFile(join(root, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n');
    }
  });
  await rustGuard.assertUnused();
  receipt.status = 'passed';
  if (previous) {
    receipt.updateRollback = 'passed';
  }
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = {
    name: error.name,
    message: error.message,
    releaseState: error.releaseState ?? null
  };
  throw error;
} finally {
  if (rustGuard) {
    receipt.rustGuard = await rustGuard.receipt();
  }
  await writeFile(join(root, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n');
}
