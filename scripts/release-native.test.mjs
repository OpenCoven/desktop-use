import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, cleanup } from './fixtures/release/helpers.mjs';
import { verifyNativePair, classifyCodesignResult } from './release-native.mjs';

test('assembly executes native identity instead of trusting its adjacent JSON', async () => {
  const f = await fixture('0.1.3', { runtimeEnvelope: { version: '0.1.2' } });
  try {
    await assert.rejects(verifyNativePair(f.root, f.manifest), /IDENTITY/);
  } finally {
    await cleanup(f.root);
  }
});
test('assembly rejects a package from another source tree before lane acceptance', async () => {
  const f = await fixture();
  try {
    const wrong = structuredClone(f.manifest);
    wrong.source.commit = 'b'.repeat(40);
    await assert.rejects(verifyNativePair(f.root, wrong), /IDENTITY/);
    const receipt = await verifyNativePair(f.root, f.manifest);
    assert.equal(receipt.identity.source.commit, f.manifest.source.commit);
    assert.equal(receipt.packageSha256, f.manifest.package.sha256);
  } finally {
    await cleanup(f.root);
  }
});

// These fixtures exercise the real inspection policy without invoking codesign or a signing identity.
const codesignCases = [
  {
    name: 'explicit unsigned diagnostic',
    status: 1,
    stderr: '/private/stage/coven-desktop-use: code object is not signed at all\n',
    state: 'unsigned'
  },
  {
    name: 'successful explicit ad-hoc inspection',
    status: 0,
    stderr:
      'Executable=/private/stage/coven-desktop-use\nSignature=adhoc\nTeamIdentifier=not set\n',
    state: 'ad-hoc'
  },
  {
    name: 'unexpected nonzero exit',
    status: 1,
    stderr: 'internal inspection failure\n',
    state: 'failed'
  },
  { name: 'signal termination', status: null, signal: 'SIGTERM', stderr: '', state: 'failed' },
  {
    name: 'spawn error',
    status: null,
    stderr: null,
    stdout: null,
    error: Object.assign(new Error('spawn /usr/bin/codesign ENOENT'), { code: 'ENOENT' }),
    state: 'failed'
  },
  {
    name: 'malformed successful output',
    status: 0,
    stderr: 'Executable=/private/stage/coven-desktop-use\n',
    state: 'unknown'
  },
  {
    name: 'ad-hoc marker with failed inspection',
    status: 1,
    stderr: 'Signature=adhoc\ninspection failed\n',
    state: 'failed'
  },
  {
    name: 'identity-signed output',
    status: 0,
    stderr: 'Authority=Developer ID Application: Fixture\nTeamIdentifier=FIXTURE\n',
    state: 'identity-signed'
  },
  {
    name: 'unsigned diagnostic with other failure output',
    status: 1,
    stderr:
      '/private/stage/coven-desktop-use: code object is not signed at all\ninternal inspection failure\n',
    state: 'failed'
  },
  {
    name: 'unsigned diagnostic with successful exit',
    status: 0,
    stderr: '/private/stage/coven-desktop-use: code object is not signed at all\n',
    state: 'unknown'
  },
  {
    name: 'ad-hoc marker with identity authority',
    status: 0,
    stderr: 'Signature=adhoc\nAuthority=Developer ID Application: Fixture\n',
    state: 'identity-signed'
  }
];
for (const fixture of codesignCases) {
  test(`codesign classifies ${fixture.name} without hiding the process outcome`, () => {
    const processResult = {
      status: fixture.status,
      signal: null,
      error: undefined,
      stdout: '',
      ...fixture
    };
    const result = classifyCodesignResult(processResult);
    assert.equal(result.state, fixture.state);
    assert.equal(result.exit, fixture.status);
    assert.equal(result.signal, fixture.signal ?? null);
    assert.deepEqual(
      result.error,
      fixture.error
        ? { name: 'Error', message: 'spawn /usr/bin/codesign ENOENT', code: 'ENOENT' }
        : null
    );
    assert.equal(result.details, (fixture.stderr ?? '') + (fixture.stdout ?? ''));
  });
}
