import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, cleanup } from './fixtures/release/helpers.mjs';
import { verifyNativePair } from './release-native.mjs';

test('assembly executes native identity instead of trusting its adjacent JSON', async () => {
  const f = await fixture('0.1.3', { runtimeEnvelope: { version: '0.1.2' } });
  try { await assert.rejects(verifyNativePair(f.root, f.manifest), /IDENTITY/); }
  finally { await cleanup(f.root); }
});
test('assembly rejects a package from another source tree before lane acceptance', async () => {
  const f = await fixture();
  try {
    const wrong = structuredClone(f.manifest); wrong.source.commit = 'b'.repeat(40);
    await assert.rejects(verifyNativePair(f.root, wrong), /IDENTITY/);
    const receipt = await verifyNativePair(f.root, f.manifest);
    assert.equal(receipt.identity.source.commit, f.manifest.source.commit);
    assert.equal(receipt.packageSha256, f.manifest.package.sha256);
  } finally { await cleanup(f.root); }
});
