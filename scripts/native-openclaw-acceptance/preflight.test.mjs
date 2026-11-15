import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { preflight } from './preflight.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function example() {
  const root = await mkdtemp(join(tmpdir(), 'native21-preflight-test-'));
  const pluginRoot = join(root, 'package'), host = join(root, 'official-host');
  await mkdir(pluginRoot); await mkdir(join(pluginRoot, 'dist')); await mkdir(host);
  const source = { repository: 'OpenCoven/desktop-use', commit: 'a'.repeat(40), dirty: false };
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@opencoven/openclaw-desktop-use', version: '0.1.4' }));
  await writeFile(join(pluginRoot, 'dist/release-identity.json'), JSON.stringify({ source, releaseVersion: '0.1.4' }));
  await writeFile(join(host, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.4.26' }));
  await writeFile(join(pluginRoot, 'dist/owned.js'), 'export const original = true;');
  execFileSync('tar', ['-czf', join(root, 'package.tgz'), '-C', root, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const archive = await (await import('node:fs/promises')).readFile(join(root, 'package.tgz'));
  await writeFile(join(root, 'adapter'), 'native-candidate', { mode: 0o700 });
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ ready: true, pid: 123, windowNumber: 4, clicks: 0, desktopRect: { x: 0, y: 0, width: 640, height: 480 }, targetRect: [40, 40, 120, 80] }));
  const descriptor = { schemaVersion: 1, sourceCommit: source.commit, sourceTree: 'b'.repeat(40), packageVersion: '0.1.4', pluginRoot, packageArchive: join(root, 'package.tgz'), packageSha256: hash(archive), adapter: join(root, 'adapter'), adapterSha256: hash('native-candidate'), host, hostVersion: '2026.4.26', platform: process.platform, ownedDisposableDisplay: true, fixtureState: join(root, 'fixture.json'), fixturePid: 123, fixtureWindowId: 4, fixtureBundleId: 'org.opencoven.desktopuse.acceptance', captureEngine: 'cg', fixtureLease: null };
  return { root, descriptor, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test('preflight verifies selected files without starting a host or native helper', async () => {
  const sample = await example();
  try { const result = await preflight(sample.descriptor); assert.equal(result.preflightOnly, true); assert.equal(result.nativeExecuted, false); assert.equal(result.sourceAssociation, 'owner-handoff'); }
  finally { await sample.cleanup(); }
});
for (const variant of ['adapter-hash', 'package-hash', 'embedded-source', 'fixture-window', 'host-version', 'missing-lease']) test(`preflight fails closed on ${variant}`, async () => {
  const sample = await example();
  try {
    const d = sample.descriptor;
    if (variant === 'adapter-hash') d.adapterSha256 = '0'.repeat(64);
    if (variant === 'package-hash') d.packageSha256 = '0'.repeat(64);
    if (variant === 'embedded-source') d.sourceCommit = 'c'.repeat(40);
    if (variant === 'fixture-window') d.fixtureWindowId++;
    if (variant === 'host-version') d.hostVersion = '2026.11.3';
    await assert.rejects(preflight(d, { runNative: variant === 'missing-lease' }));
  } finally { await sample.cleanup(); }
});

for (const variant of ['incomplete-duplicate-inventory', 'extra-runtime-file', 'wrong-helper-name']) test(`rejects review reproduction: ${variant}`, async () => {
  const sample = await example();
  try {
    const d = sample.descriptor;
    if (variant === 'incomplete-duplicate-inventory') {
      const bytes = await (await import('node:fs/promises')).readFile(join(d.pluginRoot,'package.json'));
      d.packageInventory = Array.from({length:50},()=>({path:'package.json',bytes:bytes.length,sha256:hash(bytes)}));
      await writeFile(join(d.pluginRoot,'dist/owned.js'),'export const changed = true;');
    }
    if (variant === 'extra-runtime-file') await writeFile(join(d.pluginRoot,'dist/injected.js'),'export const injected = true;');
    if (variant === 'wrong-helper-name') {
      d.helperExecutable = join(sample.root,'not-peekaboo');d.helperSha256=hash('different-helper');
      await writeFile(d.helperExecutable,'different-helper',{mode:0o700});
    }
    await assert.rejects(preflight(d));
  } finally { await sample.cleanup(); }
});
