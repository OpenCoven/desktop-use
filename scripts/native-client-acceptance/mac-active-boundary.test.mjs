import assert from 'node:assert/strict';
import test from 'node:test';
import * as proof from './mac-control-proof.mjs';

const event = (sequence, ns, length) => ({ sequence, kind: 'text', continuousNs: String(ns), textUtf16Length: length, scrollOffset: 0, keyCount: 0, clickCount: 0 });
const state = (events, published, text) => ({ ready: true, pid: 24, windowNumber: 55, focused: true, clicks: 0, keys: 0, scrollOffset: 0, text,
  controlObservationV1: { schemaVersion: 1, clockDomain: 'darwin-mach-continuous-nanoseconds', publishedContinuousNs: String(published), events, droppedEvents: 0 } });
const helper = () => ({ pid: 44, parent: 43, birthSeconds: 1000, birthMicroseconds: 123, path: '/owned/helper', status: 2 });
function sample() {
  return { baseline: state([], 100, ''), first: state([event(1, 130, 1)], 140, 'a'), second: state([event(1, 130, 1), event(2, 170, 2)], 180, 'aa'),
    helperFirst: helper(), helperSecond: helper(), expectedHelperPath: '/owned/helper', pendingFirst: true, pendingSecond: true,
    firstObservedNs: '150', secondObservedNs: '190', minimumActiveNs: '25', maximumStateAgeNs: '100' };
}

test('actual text growth across the required interval with the same live owned helper qualifies the active boundary', () => {
  assert.equal(typeof proof.proveMacActiveBoundary, 'function');
  const result = proof.proveMacActiveBoundary(sample());
  assert.equal(result.activeObservedNs, '190');
  assert.equal(result.growthSpanNs, '40');
  assert.equal(result.actualTextGrowthCallbacks, 2);
  assert.equal(JSON.stringify(result).includes('/owned/helper'), false);
});
test('pending approval and a single completed bulk edit do not prove continuing input', () => {
  for (const mutate of [
    input => { input.first = input.baseline; },
    input => { input.second = input.first; },
    input => { input.pendingSecond = false; },
    input => { input.pendingFirst = false; },
    input => { input.helperFirst = null; },
  ]) { const input = sample(); mutate(input); assert.throws(() => proof.proveMacActiveBoundary(input)); }
});
test('deletion and same-length changes cannot qualify actual input growth', () => {
  const input = sample();
  input.baseline = state([event(1, 90, 3)], 100, 'aaa');
  input.first = state([event(1, 90, 3), event(2, 130, 2)], 140, 'aa');
  input.second = state([event(1, 90, 3), event(2, 130, 2), event(3, 170, 2)], 180, 'bb');
  assert.throws(() => proof.proveMacActiveBoundary(input), /growth/i);
});
test('a reused, replaced or zombie helper cannot qualify the boundary', () => {
  for (const mutate of [
    input => { input.helperSecond.birthMicroseconds++; },
    input => { input.helperSecond.pid++; },
    input => { input.helperSecond.path = '/different/helper'; },
    input => { input.helperSecond.status = 5; },
    input => { input.helperSecond.status = 4; },
    input => { input.helperFirst.status = 5; },
    input => { input.helperFirst.status = 4; },
    input => { input.helperFirst.path = input.helperSecond.path = '/matching-but-unowned/helper'; },
  ]) { const input = sample(); mutate(input); assert.throws(() => proof.proveMacActiveBoundary(input)); }
});
test('late-published, stale, short or merely buffered observations do not prove an active interval', () => {
  for (const mutate of [
    input => { input.firstObservedNs = '139'; },
    input => { input.secondObservedNs = '400'; },
    input => { input.minimumActiveNs = '41'; },
    input => { input.firstObservedNs = '175'; },
    input => {
      input.first.controlObservationV1.publishedContinuousNs = '290';
      input.firstObservedNs = '300';
      input.second.controlObservationV1.events[1].continuousNs = '340';
      input.second.controlObservationV1.publishedContinuousNs = '350';
      input.secondObservedNs = '360';
    },
  ]) { const input = sample(); mutate(input); assert.throws(() => proof.proveMacActiveBoundary(input)); }
});
test('changed fixture, focus, prefix or truncated history invalidates active-work evidence', () => {
  for (const mutate of [
    input => { input.second.pid++; },
    input => { input.second.focused = false; },
    input => { input.second.controlObservationV1.events[0].continuousNs = '131'; },
    input => { input.second.controlObservationV1.droppedEvents = 1; },
  ]) { const input = sample(); mutate(input); assert.throws(() => proof.proveMacActiveBoundary(input)); }
});
