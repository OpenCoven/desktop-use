import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NATIVE_MATRIX } from './release-qualification.mjs';
import { fixture, commit, tar, descriptor, identity } from './fixtures/release/helpers.mjs';
const api = await import('./release-delivery.mjs').catch(() => ({}));
const context = { repository: 'OpenCoven/desktop-use', commit, ref: 'refs/tags/v0.1.3', event: 'workflow_dispatch', delivery: 'stage', runId: '123', runAttempt: '1' };

test('producer uses actual matching tag context and keeps branch candidates distinct', () => {
  assert.equal(typeof api.releaseSource, 'function');
  assert.equal(api.releaseSource('0.1.3', context).tag, 'v0.1.3');
  assert.equal(api.releaseSource('0.1.3', { ...context, ref: 'refs/heads/qualification', delivery: 'prepare' }).tag, null);
  for (const change of [{ ref: 'refs/tags/v0.1.4' }, { ref: 'refs/pull/2/merge' }, { repository: 'fork/desktop-use' }, { commit: 'abc' }]) {
    assert.throws(() => api.releaseSource('0.1.3', { ...context, ...change }));
  }
});

test('delivery requires explicit manual tag intent and completed actual rollback', () => {
  assert.equal(typeof api.assertDelivery, 'function');
  const evidence = { source: { commit, ref: context.ref, tag: 'v0.1.3' }, runId: '123', runAttempt: '1', qualification: 'passed', updateRollback: 'passed' };
  assert.doesNotThrow(() => api.assertDelivery('0.1.3', evidence, context));
  for (const change of [{ event: 'push' }, { delivery: 'prepare' }, { ref: 'refs/heads/qualification' }, { commit: 'b'.repeat(40) }, { runAttempt: '2' }]) {
    assert.throws(() => api.assertDelivery('0.1.3', evidence, { ...context, ...change }));
  }
  assert.throws(() => api.assertDelivery('0.1.3', { ...evidence, updateRollback: 'not-run' }, context));
});

test('evidence collection requires every lane bound to the same immutable manifest', async t => {
  assert.equal(typeof api.collectEvidence, 'function');
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const bytes = await readFile(join(f.root, 'release.json'));
  const binding = { runId: '123', runAttempt: '1', sourceCommit: commit, sourceRef: context.ref, manifestSha256: api.sha256(bytes), packageSha256: f.manifest.package.sha256 };
  const installs = ['macos-15', 'macos-15-intel', 'ubuntu-22.04', 'ubuntu-22.04-arm'].map(runner => ({ runner, status: 'passed', ...binding, previous: { version: '0.1.2', sourceCommit: 'b'.repeat(40), sourceRef: 'refs/heads/qualification' }, updateRollback: 'passed', rustGuard: { active: true, attempts: [] } }));
  const hosts = ['ubuntu-22.04', 'macos-15'].flatMap(runner => ['2026.4.26', '2026.11.3'].flatMap(host => ['full', 'observation-only', 'desktop-only', 'stop-only', 'sdk-authorization'].map(profile => ({ runner, profile, expectedVersion: host, status: 'passed', ...binding }))));
  const good = () => api.collectEvidence(bytes, { installs, hosts }, context);
  const result = good();
  assert.equal(result.manifest.sha256, binding.manifestSha256);
  assert.equal(result.qualification, 'passed');
  assert.equal(result.publication, 'not-run');
  assert.equal(result.graphicalAcceptance, 'not-run');
  assert.equal(result.lanes.length, 24);
  assert.deepEqual(await readFile(join(f.root, 'release.json')), bytes);
  for (const [record, key, bad] of [[hosts[0], 'runAttempt', '2'], [hosts[0], 'status', 'failed'], [hosts[0], 'sourceCommit', 'b'.repeat(40)], [hosts[0], 'manifestSha256', '0'.repeat(64)], [installs[0], 'packageSha256', '0'.repeat(64)]]) {
    const old = record[key]; record[key] = bad; assert.throws(good); record[key] = old;
  }
  assert.throws(() => api.collectEvidence(bytes, { installs: installs.slice(1), hosts }, context));
  assert.throws(() => api.collectEvidence(bytes, { installs, hosts: [...hosts, hosts[0]] }, context));
  for (const receipt of installs) { receipt.updateRollback = 'not-run-no-previous-candidate'; receipt.previous = null; }
  assert.equal(good().updateRollback, 'not-run');
  installs[0].rustGuard.attempts.push({ tool: 'cargo' }); assert.throws(good);
});

test('initial publication needs separate bootstrap intent and cannot claim rollback', () => {
  const evidence = { source: { commit, ref: 'refs/tags/v0.1.4', tag: 'v0.1.4' }, runId: '123', runAttempt: '1', qualification: 'passed', updateRollback: 'not-run', priorCandidate: null };
  assert.doesNotThrow(() => api.assertDelivery('0.1.4', evidence, { ...context, ref: 'refs/tags/v0.1.4', delivery: 'stage-bootstrap', previousRecordPresent: false }));
  assert.throws(() => api.assertDelivery('0.1.4', evidence, { ...context, ref: 'refs/tags/v0.1.4' }));
  assert.throws(() => api.assertDelivery('0.1.4', { ...evidence, priorCandidate: { version: '0.1.2' } }, { ...context, ref: 'refs/tags/v0.1.4', delivery: 'stage-bootstrap', previousRecordPresent: false }));
  assert.throws(() => api.assertDelivery('0.1.3', { ...evidence, source: { ...evidence.source, ref: 'refs/tags/v0.1.3', tag: 'v0.1.3' } }, { ...context, ref: 'refs/tags/v0.1.3', delivery: 'stage-bootstrap', previousRecordPresent: false }));
});

test('public rollback requires independently selected tag-bound previous version and source', () => {
  assert.equal(typeof api.assertPreviousManifest, 'function');
  const previous = { releaseVersion: '0.1.3', source: { commit, ref: 'refs/tags/v0.1.3', tag: 'v0.1.3' } };
  const trusted = { version: '0.1.3', sourceCommit: commit, sourceRef: 'refs/tags/v0.1.3' };
  assert.doesNotThrow(() => api.assertPreviousManifest(previous, trusted, true));
  assert.throws(() => api.assertPreviousManifest(previous, { ...trusted, sourceCommit: 'b'.repeat(40) }, true));
  assert.throws(() => api.assertPreviousManifest({ ...previous, source: { ...previous.source, tag: null, ref: 'refs/heads/main' } }, { ...trusted, sourceRef: 'refs/heads/main' }, true));
});

test('bootstrap cannot proceed when a committed previous qualification record exists', () => {
  const evidence = { source: { commit, ref: 'refs/tags/v0.1.4', tag: 'v0.1.4' }, runId: '123', runAttempt: '1', qualification: 'passed', updateRollback: 'not-run', priorCandidate: null };
  assert.throws(() => api.assertDelivery('0.1.4', evidence, { ...context, ref: 'refs/tags/v0.1.4', delivery: 'stage-bootstrap', previousRecordPresent: true }));
});

// These are nonexecutable archive parser fixtures, never native qualification evidence.
async function assemblyFixture(t) {
  const f = await fixture('0.1.4'); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(f.manifestPath);
  for (const lane of NATIVE_MATRIX) {
    const binary = Buffer.alloc(32);
    const linux = lane.platform === 'linux';
    if (linux) { binary.set([127, 69, 76, 70, 2, 1]); binary.writeUInt16LE(lane.arch === 'arm64' ? 183 : 62, 18); }
    else { binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(lane.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
    const id = { ...identity('0.1.4'), ok: true, version: '0.1.4', target: lane.target };
    const entries = [{ path: 'coven-desktop-use', data: binary, mode: 0o755 }, { path: 'release-identity.json', data: JSON.stringify(id) }];
    const bytes = tar(entries), asset = `native-${lane.target}.tar.gz`;
    await writeFile(join(f.root, asset), bytes);
    const artifact = { ...descriptor(asset, bytes, entries), target: lane.target, minimumOsVersion: linux ? '22.04' : '15.0', ...(linux ? { libc: { family: 'glibc', minimumVersion: '2.35' } } : {}), signing: { status: 'not-run', url: null } };
    await writeFile(join(f.root, `native-${lane.target}.json`), JSON.stringify({ status: 'passed', identity: id, packageSha256: f.manifest.package.sha256, nativeSha256: api.sha256(bytes), artifact }));
  }
  return f;
}

test('actual assembler and reconciliation CLIs preserve immutable tag bytes and complete lane index', async t => {
  const f = await assemblyFixture(t);
  const env = { ...process.env, GITHUB_REPOSITORY: 'OpenCoven/desktop-use', GITHUB_SHA: commit, GITHUB_REF: 'refs/tags/v0.1.4', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  execFileSync(process.execPath, ['scripts/release-candidate.mjs', f.root], { env });
  const original = await readFile(f.manifestPath);
  const manifest = JSON.parse(original);
  assert.equal(manifest.source.tag, 'v0.1.4');
  assert.equal(manifest.artifacts.length, 4);
  const binding = { runId: '123', runAttempt: '1', sourceCommit: commit, sourceRef: env.GITHUB_REF, manifestSha256: api.sha256(original), packageSha256: manifest.package.sha256 };
  const receipts = join(f.root, 'receipts'); await mkdir(receipts);
  for (const runner of ['macos-15', 'macos-15-intel', 'ubuntu-22.04', 'ubuntu-22.04-arm']) {
    const directory = join(receipts, `release-install-${runner}`); await mkdir(directory);
    await writeFile(join(directory, 'installation.json'), JSON.stringify({ runner, ...binding, status: 'passed', previous: null, updateRollback: 'not-run-no-previous-candidate', rustGuard: { active: true, attempts: [] } }));
  }
  for (const runner of ['ubuntu-22.04', 'macos-15']) for (const host of ['2026.4.26', '2026.11.3']) for (const profile of ['full', 'observation-only', 'desktop-only', 'stop-only', 'sdk-authorization']) {
    const directory = join(receipts, `release-host-${runner}-${host}-${profile}`); await mkdir(directory);
    await writeFile(join(directory, 'host-lane.json'), JSON.stringify({ runner, profile, expectedVersion: host, ...binding, status: 'passed' }));
  }
  const output = join(f.root, 'delivery');
  execFileSync(process.execPath, ['scripts/release-delivery.mjs', f.root, receipts, output], { env });
  assert.deepEqual(await readFile(f.manifestPath), original);
  assert.deepEqual(await readFile(join(output, 'release.json')), original);
  const index = JSON.parse(await readFile(join(output, 'release-evidence.json')));
  assert.equal(index.lanes.length, 24);
  assert.equal(index.priorCandidate, null);
  assert.equal(index.updateRollback, 'not-run');
  assert.equal(index.publication, 'not-run');
  const lines = (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 9);
  for (const line of lines) {
    const [hash, asset] = line.split('  ');
    assert.equal(api.sha256(await readFile(join(output, asset))), hash);
  }
  assert.throws(() => execFileSync(process.execPath, ['scripts/release-delivery.mjs', f.root, receipts, output], { env, stdio: 'pipe' }));
  await t.test('manual tag preflight needs no new governance setup and retains mandatory provenance', async () => {
    // Fixture transports for the read-only preflight only. No real GitHub or registry request occurs.
    const git = join(f.root, 'git');
    await writeFile(git, `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='rev-parse' && ['HEAD','refs/tags/v0.1.4^{commit}'].includes(a[1])) console.log('${commit}');
else if(JSON.stringify(a)!==JSON.stringify(['merge-base','--is-ancestor','${commit}','origin/main'])) process.exit(90);
`);
    await chmod(git, 0o755);
    const verifierLog = join(f.root, 'preflight-verifier.log');
    const gh = join(f.root, 'gh');
    await writeFile(gh, `#!${process.execPath}
const fs=require('node:fs');
const a=process.argv.slice(2);
if(a[0]==='api') {
 if(a.at(-1)==='repos/OpenCoven/desktop-use/environments/paired-release') console.log(JSON.stringify({name:'paired-release',protection_rules:[]}));
 else if(a.at(-1)==='repos/OpenCoven/desktop-use/branches/main') console.log(JSON.stringify({protected:false}));
 else if(JSON.stringify(a)===JSON.stringify(['api','--paginate','--slurp','repos/OpenCoven/desktop-use/releases?per_page=100'])) console.log('[[]]');
 else process.exit(91);
} else {
 if(a[0]!=='attestation'||a[1]!=='verify'||process.env.FIXTURE_BAD_PROVENANCE==='1') process.exit(92);
 for(const [flag,value] of [['--repo','OpenCoven/desktop-use'],['--signer-workflow','OpenCoven/desktop-use/.github/workflows/release.yml'],['--source-digest','${commit}'],['--source-ref','refs/tags/v0.1.4'],['--predicate-type','https://slsa.dev/provenance/v1'],['--format','json']]) if(a[a.indexOf(flag)+1]!==value) process.exit(93);
 if(!a.includes('--deny-self-hosted-runners')) process.exit(94);
 fs.appendFileSync(${JSON.stringify(verifierLog)},JSON.stringify(a)+'\\n');
 console.log('[{"fixtureOnly":true}]');
}
`);
    const transport = join(f.root, 'registry-fixture.mjs');
    await writeFile(transport, "globalThis.fetch = async url => { if(url !== 'https://registry.npmjs.org/@opencoven%2fopenclaw-desktop-use/0.1.4') throw new Error('Unexpected registry request'); return { status: 404 }; };\n");
    const preflightEnv = { ...env, PATH: `${f.root}:${process.env.PATH}`, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_DELIVERY: 'stage-bootstrap' };
    const args = ['--import', transport, 'scripts/release-prepublish.mjs', output];
    const result = JSON.parse(execFileSync(process.execPath, args, { env: preflightEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.equal(result.status, 'preflight-passed');
    assert.equal(result.publication, 'not-run');
    assert.equal((await readFile(verifierLog, 'utf8')).trim().split('\n').length, 10);
    assert.throws(() => execFileSync(process.execPath, args, { env: { ...preflightEnv, FIXTURE_BAD_PROVENANCE: '1' }, stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, args, { env: { ...preflightEnv, RELEASE_DELIVERY: 'prepare' }, stdio: 'pipe' }));
  });
});

test('assembler rejects mismatching version tag without writing a manifest', async t => {
  const f = await assemblyFixture(t);
  assert.throws(() => execFileSync(process.execPath, ['scripts/release-candidate.mjs', f.root], { env: { ...process.env, GITHUB_REPOSITORY: 'OpenCoven/desktop-use', GITHUB_SHA: commit, GITHUB_REF: 'refs/tags/v0.1.3', GITHUB_RUN_ID: '123' }, stdio: 'pipe' }));
  await assert.rejects(readFile(f.manifestPath), { code: 'ENOENT' });
});
