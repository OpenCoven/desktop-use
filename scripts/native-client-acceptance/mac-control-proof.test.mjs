import assert from 'node:assert/strict';
import test from 'node:test';

const proof = await import('./mac-control-proof.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const event = (sequence, continuousNs, length = 1) => ({ sequence, kind: 'text', continuousNs, textUtf16Length: length, scrollOffset: 0, keyCount: 0, clickCount: 0 });
const snapshot = (events, publishedContinuousNs, text = 'x') => ({ ready: true, pid: 24, windowNumber: 55, focused: true, clicks: 0, keys: 0, scrollOffset: 0, text,
  controlObservationV1: { schemaVersion: 1, clockDomain: 'darwin-mach-continuous-nanoseconds', publishedContinuousNs, events, droppedEvents: 0 } });
const sample = () => ({ before: snapshot([], '100', ''), after: snapshot([event(1, '140')], '1000'), returnedNs: '200', observedActiveInputNs: '150', minimumObservationNs: '750' });

test('Mac timing proof exports the required active-input guards', () => {
  assert.equal(typeof proof.proveMacNoLateControls, 'function');
  assert.equal(typeof proof.verifyMacClockBracket, 'function');
});
test('complete real-effect history before return produces scalar evidence only', () => {
  const input = sample();
  input.after.text = 'task-private-dummy';
  input.after.controlObservationV1.events[0].textUtf16Length = input.after.text.length;
  const result = proof.proveMacNoLateControls(input);
  assert.equal(result.actualTextChanges, 1);
  assert.equal(result.changesAtOrAfterReturn, 0);
  assert.equal(result.observedAfterReturnNs, '800');
  assert.equal(JSON.stringify(result).includes(input.after.text), false);
  assert.equal(result.visibleUIAcceptanceFromControlSignals, false);
});
test('an actual control change after return fails even when later state returns to the same value', () => {
  const input = sample();
  input.after.controlObservationV1.events.push(event(2, '201', 2), event(3, '210', 1));
  assert.throws(() => proof.proveMacNoLateControls(input), /at or after.*return/i);
});
test('a callback exactly at the return timestamp remains unproven', () => {
  const input = sample(); input.after.controlObservationV1.events.push(event(2, '200'));
  assert.throws(() => proof.proveMacNoLateControls(input), /at or after.*return/i);
});
test('late observations must include the full required post-return window', () => {
  const input = sample(); input.after.controlObservationV1.publishedContinuousNs = '900';
  assert.throws(() => proof.proveMacNoLateControls(input), /observation window/i);
});
test('history truncation, reordered records and changed prefix cannot claim no delayed effects', () => {
  for (const alter of [
    input => { input.after.controlObservationV1.droppedEvents = 1; },
    input => { input.after.controlObservationV1.events[0].sequence = 2; },
    input => { input.before = snapshot([event(1, '90')], '100'); input.after.controlObservationV1.events[0].continuousNs = '91'; },
  ]) { const input = sample(); alter(input); assert.throws(() => proof.proveMacNoLateControls(input)); }
});
test('clock labels, numeric nanoseconds and private observer fields fail closed', () => {
  for (const alter of [
    input => { input.after.controlObservationV1.clockDomain = 'uptime'; },
    input => { input.after.controlObservationV1.events[0].continuousNs = 140; },
    input => { input.after.controlObservationV1.events[0].rawText = 'not an observer scalar'; },
  ]) { const input = sample(); alter(input); assert.throws(() => proof.proveMacNoLateControls(input)); }
});
test('changed fixture identity, lost focus or widget values without matching callbacks invalidate the proof', () => {
  for (const alter of [
    input => { input.after.pid += 1; },
    input => { input.after.windowNumber += 1; },
    input => { input.after.focused = false; },
    input => { input.after.text = 'unobserved mutation'; },
  ]) { const input = sample(); alter(input); assert.throws(() => proof.proveMacNoLateControls(input)); }
});
test('clear-only callbacks do not establish actual typed input before cancellation', () => {
  const input = sample(); input.after.text = ''; input.after.controlObservationV1.events[0].textUtf16Length = 0;
  assert.throws(() => proof.proveMacNoLateControls(input), /actual.*text/i);
});
test('deleting a nonempty baseline to a shorter nonempty value is not typed-input growth', () => {
  const before = snapshot([event(1, '90', 2)], '100', 'ab');
  const after = snapshot([event(1, '90', 2), event(2, '140', 1)], '1000', 'a');
  assert.throws(() => proof.proveMacNoLateControls({ before, after, returnedNs: '200', observedActiveInputNs: '150', minimumObservationNs: '750' }), /actual.*text/i);
});
test('nanoseconds beyond JavaScript integer precision stay exact', () => {
  const base = 9_007_199_254_740_992n;
  const input = { before: snapshot([], String(base), ''), after: snapshot([event(1, String(base+1n))], String(base+1_000n)), returnedNs: String(base+200n), observedActiveInputNs: String(base+100n), minimumObservationNs: '750' };
  assert.equal(proof.proveMacNoLateControls(input).changesAtOrAfterReturn, 0);
});
test('clock-only preflight rejects mismatched clocks and unaudited libuv builds', () => {
  const input = { platform: 'darwin', uvVersion: '1.52.1', beforeNs: '100', probeNs: '150', afterNs: '200' };
  assert.equal(proof.verifyMacClockBracket(input).verified, true);
  assert.throws(() => proof.verifyMacClockBracket({ ...input, probeNs: '99' }), /clock/i);
  assert.throws(() => proof.verifyMacClockBracket({ ...input, uvVersion: 'unknown' }), /clock/i);
});
