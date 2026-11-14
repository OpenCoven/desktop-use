import assert from 'node:assert/strict';

export const MAC_CONTROL_CLOCK = 'darwin-mach-continuous-nanoseconds';
const eventFields = ['sequence', 'kind', 'continuousNs', 'textUtf16Length', 'scrollOffset', 'keyCount', 'clickCount'].sort();
const observationFields = ['schemaVersion', 'clockDomain', 'publishedContinuousNs', 'events', 'droppedEvents'].sort();
const kinds = new Set(['text', 'scroll', 'key', 'click']);

function nanoseconds(value, label) {
  assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), `${label} must be an exact decimal nanosecond string`);
  const result = BigInt(value);
  assert.ok(result >= 0n, `${label} must be nonnegative`);
  return result;
}
function integer(value, label, minimum = 0) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum, `${label} must be a bounded integer`);
}
function observation(state) {
  assert.equal(state.ready, true, 'fixture is not ready');
  integer(state.pid, 'fixture PID', 2);
  integer(state.windowNumber, 'fixture window', 1);
  assert.equal(state.focused, true, 'fixture lost input focus');
  integer(state.clicks, 'fixture click count');
  integer(state.keys, 'fixture key count');
  assert.ok(Number.isSafeInteger(state.scrollOffset), 'fixture scroll offset must be integral');
  assert.equal(typeof state.text, 'string', 'fixture editable value must be present');
  const value = state.controlObservationV1;
  assert.ok(value && typeof value === 'object', 'fixture control observation is missing');
  assert.deepEqual(Object.keys(value).sort(), observationFields, 'unexpected control observation fields');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.clockDomain, MAC_CONTROL_CLOCK, 'unqualified fixture clock domain');
  assert.equal(value.droppedEvents, 0, 'observer history is truncated');
  const published = nanoseconds(value.publishedContinuousNs, 'publication clock');
  assert.ok(Array.isArray(value.events), 'control history must be an array');
  let previous = 0n;
  for (const [index, event] of value.events.entries()) {
    assert.deepEqual(Object.keys(event).sort(), eventFields, 'observer events must contain only allowlisted scalars');
    assert.equal(event.sequence, index + 1, 'control sequence is incomplete or reordered');
    assert.ok(kinds.has(event.kind), 'unknown control event kind');
    const when = nanoseconds(event.continuousNs, 'callback clock');
    assert.ok(when >= previous && when <= published, 'control clock order contradicts publication');
    previous = when;
    integer(event.textUtf16Length, 'observed text length');
    integer(event.keyCount, 'observed key count');
    integer(event.clickCount, 'observed click count');
    assert.ok(Number.isSafeInteger(event.scrollOffset), 'observed scroll offset must be integral');
  }
  const last = value.events.at(-1);
  assert.equal(last?.textUtf16Length ?? 0, state.text.length, 'editable value changed without a matching callback');
  assert.equal(last?.keyCount ?? 0, state.keys, 'key state changed without a matching callback');
  assert.equal(last?.clickCount ?? 0, state.clicks, 'click state changed without a matching callback');
  assert.equal(last?.scrollOffset ?? 0, state.scrollOffset, 'scroll state changed without a matching callback');
  return { value, published };
}

export function verifyMacClockBracket({ platform, uvVersion, beforeNs, probeNs, afterNs }) {
  assert.equal(platform, 'darwin', 'clock preflight requires Darwin');
  // Audit another libuv implementation before qualifying its clock. This is a
  // harness evidence bound, not a production SDK compatibility restriction.
  assert.equal(uvVersion, '1.52.1', 'unqualified Node clock implementation');
  const before = nanoseconds(beforeNs, 'pre-probe clock');
  const probe = nanoseconds(probeNs, 'Swift clock probe');
  const after = nanoseconds(afterNs, 'post-probe clock');
  assert.ok(before <= probe && probe <= after, 'Swift and Node clock bracket does not agree');
  return { verified: true, clockDomain: MAC_CONTROL_CLOCK, bracketWidthNs: String(after - before), uvVersion };
}

export function proveMacNoLateControls({ before, after, returnedNs, observedActiveInputNs, minimumObservationNs = '750000000' }) {
  const initial = observation(before);
  const final = observation(after);
  assert.equal(after.pid, before.pid, 'fixture PID changed');
  assert.equal(after.windowNumber, before.windowNumber, 'fixture window changed');
  const returned = nanoseconds(returnedNs, 'promise fulfillment');
  const active = nanoseconds(observedActiveInputNs, 'active input observation');
  const required = nanoseconds(minimumObservationNs, 'minimum observation interval');
  assert.ok(active >= initial.published && active < returned, 'active input must be observed before promise return');
  assert.ok(final.published >= returned + required, 'post-return observation window is incomplete');
  const prefix = final.value.events.slice(0, initial.value.events.length);
  assert.deepEqual(prefix, initial.value.events, 'control history prefix changed');
  const events = final.value.events.slice(initial.value.events.length);
  assert.ok(events.every(event => nanoseconds(event.continuousNs, 'callback clock') >= initial.published), 'new callbacks predate baseline publication');
  let previousLength = before.text.length;
  const typed = events.filter(event => {
    const grew = event.kind === 'text' && event.textUtf16Length > previousLength;
    previousLength = event.textUtf16Length;
    return grew;
  });
  assert.ok(typed.some(event => nanoseconds(event.continuousNs, 'callback clock') <= active), 'actual text input must precede the active-work observation');
  const late = events.filter(event => nanoseconds(event.continuousNs, 'callback clock') >= returned);
  assert.equal(late.length, 0, 'actual control changes occurred at or after promise return');
  return {
    clockDomain: MAC_CONTROL_CLOCK,
    actualTextChanges: events.filter(event => event.kind === 'text').length,
    controlEvents: events.length,
    changesAtOrAfterReturn: late.length,
    observedAfterReturnNs: String(final.published - returned),
    completeHistoryVerified: true,
    visibleUIAcceptanceFromControlSignals: false,
  };
}
