import assert from 'node:assert/strict';

export function assertClickResult(status, { denied }) {
  assert.equal(status.status, denied ? 'error' : 'success');
  if (denied) {
    if (Object.hasOwn(status, 'success')) assert.equal(status.success, false);
    assert.equal(status.error, 'Denied by user');
    assert.equal(status.tool, 'computer_use');
  } else assert.equal(status.success, true);
}
