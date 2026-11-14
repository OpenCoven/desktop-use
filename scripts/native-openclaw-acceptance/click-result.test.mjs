import assert from 'node:assert/strict';
import test from 'node:test';
import { assertClickResult } from './click-result.mjs';

test('the pinned host denial envelope proves denial without inventing an SDK success field', () => {
  // Official pi-tool-definition-adapter buildToolExecutionErrorResult shape.
  assert.doesNotThrow(() => assertClickResult({ status: 'error', tool: 'computer_use', error: 'Denied by user' }, { denied: true }));
});

test('approved execution still requires the explicit adapter success result', () => {
  assert.doesNotThrow(() => assertClickResult({ status: 'success', success: true }, { denied: false }));
  assert.throws(() => assertClickResult({ status: 'success' }, { denied: false }));
});

for (const result of [
  { status: 'error', tool: 'computer_use', success: true, error: 'Denied by user' },
  { status: 'success', tool: 'computer_use', success: false, error: 'Denied by user' },
  { status: 'error', tool: 'computer_use', error: 'Approval timed out' },
  { status: 'error', tool: 'computer_use', error: 'Other failure' },
  { status: 'error', tool: 'other_tool', error: 'Denied by user' },
  { status: 'error', tool: 'computer_use', success: null, error: 'Denied by user' },
]) test(`a contradictory or unrelated error is not the requested denial: ${JSON.stringify(result)}`, () => {
  assert.throws(() => assertClickResult(result, { denied: true }));
});
