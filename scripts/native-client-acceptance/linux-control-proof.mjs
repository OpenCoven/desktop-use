import assert from 'node:assert/strict';
function sameFixture(before, after) {
  assert.equal(before.ready, true); assert.equal(after.ready, true);
  assert.equal(after.pid, before.pid, 'Input evidence must belong to the same live fixture');
  assert.deepEqual(after.origin, before.origin, 'Fixture origin must remain stable');
  assert.deepEqual(after.size, before.size, 'Fixture extent must remain stable');
}
export function proveTextEffect(before, after, expected) {
  sameFixture(before, after);
  assert.ok(typeof expected === 'string' && expected.length > 0);
  assert.equal(after.text, expected, 'Actual editable control value must equal typed input');
  assert.notEqual(before.text, after.text, 'Editable value must actually change');
  return { observedEditableValue: true, characters: expected.length };
}
export function proveScrollEffect(before, after) {
  sameFixture(before, after);
  for (const state of [before, after]) {
    for (const key of ['scrollOffset','scrollUpper','scrollPageSize']) assert.ok(Number.isFinite(state[key]), 'Actual finite adjustment values required');
    assert.ok(state.scrollPageSize > 0 && state.scrollUpper > state.scrollPageSize, 'A real overflowing scroll region is required');
    assert.ok(state.scrollOffset >= 0 && state.scrollOffset <= state.scrollUpper - state.scrollPageSize + 1, 'Viewport offset must remain within actual adjustment limits');
  }
  assert.ok(after.scrollOffset > before.scrollOffset, 'Actual viewport must move downward');
  return { observedViewportMovement: true, before: before.scrollOffset, after: after.scrollOffset, delta: after.scrollOffset - before.scrollOffset };
}
