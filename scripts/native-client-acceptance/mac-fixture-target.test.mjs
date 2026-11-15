import test from 'node:test';
import assert from 'node:assert/strict';
import * as target from './mac-fixture-target.mjs';

function vector() {
  const process = { pid: 42, uid: 501, birthSeconds: 100, birthMicroseconds: 200, path: '/owned/new.app/Contents/MacOS/DesktopUseAcceptance' };
  return {
    baseline: { fixtureBundleIdentifier: 'org.opencoven.desktopuse.acceptance.run-1234', fixtureInfoPlistSha256: 'a'.repeat(64), fixtureBinarySha256: 'b'.repeat(64) },
    owner: { ...process, windowNumber: 88 },
    fixture: { ready: true, focused: true, pid: 42, windowNumber: 88 },
    observed: { process, expectedExecutable: process.path, bundleIdentifier: 'org.opencoven.desktopuse.acceptance.run-1234', infoPlistSha256: 'a'.repeat(64), fixtureBinarySha256: 'b'.repeat(64) }
  };
}

test('fresh fixture target binds the unique prepared bundle, exact process birth and window', () => {
  assert.equal(typeof target.assertMacFixtureTarget, 'function');
  assert.deepEqual(target.assertMacFixtureTarget(vector()), { app: 'org.opencoven.desktopuse.acceptance.run-1234', windowId: 88 });
});

test('an existing same-name fixture, reused PID, changed window or missing focus cannot be targeted', () => {
  assert.equal(typeof target.assertMacFixtureTarget, 'function');
  const mutations = [
    v => { v.observed.process = { ...v.observed.process, path: '/owned/old.app/Contents/MacOS/DesktopUseAcceptance' }; },
    v => { v.observed.process = { ...v.observed.process, birthMicroseconds: 201 }; },
    v => { v.fixture.windowNumber = 89; },
    v => { v.fixture.pid = 43; },
    v => { v.fixture.focused = false; },
    v => { v.observed.process = null; },
    v => { v.owner.uid = 502; },
  ];
  for (const mutate of mutations) { const v = vector(); mutate(v); assert.throws(() => target.assertMacFixtureTarget(v)); }
});

test('bundle identity, metadata and executable changes fail before an input target is returned', () => {
  assert.equal(typeof target.assertMacFixtureTarget, 'function');
  for (const mutate of [
    v => { v.baseline.fixtureBundleIdentifier = 'org.opencoven.desktopuse.acceptance'; },
    v => { v.observed.bundleIdentifier += '-other'; },
    v => { v.observed.infoPlistSha256 = 'c'.repeat(64); },
    v => { v.observed.fixtureBinarySha256 = 'c'.repeat(64); },
    v => { delete v.baseline.fixtureBundleIdentifier; },
    v => { v.owner.birthSeconds = 0; },
    v => { v.owner.windowNumber = 0; },
  ]) { const v = vector(); mutate(v); assert.throws(() => target.assertMacFixtureTarget(v)); }
});
