import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
function summary(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Fixture control summary required');
  assert.ok(digest(value.fixtureIdentity), 'Bound fixture identity digest required');
  assert.ok(value.entryFocused === true, 'Known entry focus required');
  for (const key of ['textLength', 'keyCount', 'clickCount']) assert.ok(count(value[key]), 'Bounded control counters required');
  assert.ok(digest(value.textSha256), 'Known text digest required');
  assert.ok(typeof value.scrollOffset === 'number' && Number.isFinite(value.scrollOffset) && value.scrollOffset >= 0 && value.scrollOffset <= 1_000_000, 'Bounded scroll offset required');
  return { fixtureIdentity: value.fixtureIdentity, textLength: value.textLength, textSha256: value.textSha256, keyCount: value.keyCount, clickCount: value.clickCount, scrollOffset: value.scrollOffset };
}

// Pure checks on already identity-bound observations. The caller must separately
// prove live fixture provenance, provider image delivery and actual host approval.
export function proveTextEffect({ before, after, text, decision }) {
  assert.ok(['allow', 'deny', 'capture-only'].includes(decision), 'Known trusted harness decision required');
  assert.ok(typeof text === 'string' && /^[a-z0-9-]{1,64}$/.test(text), 'Bounded lowercase ASCII fixture marker required');
  const start = summary(before), end = summary(after);
  assert.equal(end.fixtureIdentity, start.fixtureIdentity, 'Fixture identity changed');
  assert.equal(end.clickCount, start.clickCount, 'Unexpected pointer effect');
  assert.equal(end.scrollOffset, start.scrollOffset, 'Unexpected scroll effect');
  if (decision !== 'capture-only') {
    assert.equal(start.textLength, 0, 'Fresh empty fixture required');
    assert.equal(start.textSha256, hash(''), 'Fresh empty fixture digest required');
    assert.equal(start.keyCount, 0, 'Fresh fixture key counter required');
    assert.equal(start.clickCount, 0, 'Fresh fixture pointer counter required');
    assert.equal(start.scrollOffset, 0, 'Fresh fixture scroll state required');
  }
  if (decision === 'allow') {
    assert.equal(end.textLength, text.length, 'Planned text extent required');
    assert.equal(end.textSha256, hash(text), 'Planned exact text digest required');
    assert.equal(end.keyCount - start.keyCount, text.length, 'Exactly the planned ASCII key callbacks required');
  } else {
    assert.deepEqual(end, start, 'Denied or observation-only work must preserve all reported controls');
  }
  return { schemaVersion: 1, decision, charactersAdded: end.textLength - start.textLength, keyEventsAdded: end.keyCount - start.keyCount, finalTextLength: end.textLength, textSha256: end.textSha256, unrelatedControlsUnchanged: true };
}

// A denial after an earlier allowed action compares that existing control state.
// It supplies no approval authority and cannot stand in for an allowed operation.
export function proveNoEffect({ before, after, decision }) {
  assert.ok(['deny', 'capture-only'].includes(decision), 'A no-effect decision is required');
  const start = summary(before), end = summary(after);
  assert.deepEqual(end, start, 'Every reported control and fixture identity must remain unchanged');
  return { schemaVersion: 1, decision, charactersAdded: 0, keyEventsAdded: 0, finalTextLength: end.textLength, textSha256: end.textSha256, unrelatedControlsUnchanged: true };
}
