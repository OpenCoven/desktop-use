import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, commit } from './fixtures/release/helpers.mjs';
const api = await import('./release-public.mjs').catch(() => ({}));

test('public download checks independent version/source and every archive, rejecting branch relabeling', async t => {
  assert.equal(typeof api.checkPublicPairBytes, 'function');
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const expected = { version: '0.1.3', sourceCommit: commit };
  await api.checkPublicPairBytes(f.root, expected);
  await assert.rejects(api.checkPublicPairBytes(f.root, { ...expected, sourceCommit: 'b'.repeat(40) }));
  f.manifest.source.tag = null; f.manifest.source.ref = 'refs/heads/qualification';
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(api.checkPublicPairBytes(f.root, expected));
  f.manifest.source.tag = 'v0.1.3'; f.manifest.source.ref = 'refs/tags/v0.1.3';
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await writeFile(join(f.root, f.manifest.artifacts[0].asset), 'corrupted');
  await assert.rejects(api.checkPublicPairBytes(f.root, expected));
});

test('npm public verification rejects repacking, wrong versions and changed registry integrity', async t => {
  assert.equal(typeof api.assertRegistryPackage, 'function');
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const bytes = await readFile(join(f.root, f.manifest.package.asset));
  const metadata = { name: '@opencoven/openclaw-desktop-use', version: '0.1.3', dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } };
  api.assertRegistryPackage(f.manifest, metadata, bytes);
  assert.throws(() => api.assertRegistryPackage(f.manifest, metadata, Buffer.concat([bytes, Buffer.from('x')])));
  assert.throws(() => api.assertRegistryPackage(f.manifest, { ...metadata, version: '0.1.2' }, bytes));
  assert.throws(() => api.assertRegistryPackage(f.manifest, { ...metadata, dist: { integrity: 'sha512-wrong' } }, bytes));
});
