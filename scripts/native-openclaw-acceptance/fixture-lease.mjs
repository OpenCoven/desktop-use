import assert from 'node:assert/strict';
export function assertFixtureLease(descriptor, current, baseline = current) {
  const lease = descriptor.fixtureLease;
  assert.equal(lease?.acknowledgement, 'native-openclaw-fixture-exclusive');
  assert.ok(typeof lease.ownerThread === 'string' && lease.ownerThread.length > 0);
  assert.ok(Date.parse(lease.expiresAt) > Date.now(), 'Current exclusive fixture lease required');
  for (const key of ['fixturePid','fixtureWindowId','adapterSha256','packageSha256','sourceCommit']) assert.equal(lease[key], descriptor[key], 'Lease must bind actual selected identities');
  assert.equal(current.ready, true); assert.equal(current.pid, descriptor.fixturePid); assert.equal(current.windowNumber, descriptor.fixtureWindowId);
  for (const key of ['clicks','desktopRect','targetRect']) assert.deepEqual(current[key], baseline[key], 'Fixture must remain unchanged immediately before capture/input authorization');
}
