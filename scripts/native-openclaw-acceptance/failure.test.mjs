import assert from 'node:assert/strict';
import test from 'node:test';
import { safeFailure } from './failure.mjs';

test('failure metadata locates a fixed verifier site without retaining error payloads', () => {
  const error = new Error('secret-input data:image/png;base64,AAAA /private/operator');
  error.name = 'AssertionError'; error.actual = { token: 'secret-token' }; error.expected = 'private-value';
  error.stack = 'AssertionError: private-value\n at proveWireObservation (file:///private/operator/wire-proof.mjs:38:10)\n at file:///private/operator/run.mjs:80:27';
  assert.deepEqual(safeFailure(error, 'wire-image-proof'), { phase: 'wire-image-proof', errorClass: 'AssertionError', code: 'WITHHELD', module: 'wire-proof', line: 38, column: 10 });
});

test('unknown phase, class and source site cannot inject private strings into diagnostics', () => {
  const result = safeFailure({ name: 'secret-name', message: 'secret-message', stack: 'file:///private/secret.mjs:123:2' }, 'secret-phase');
  assert.deepEqual(result, { phase: 'unknown', errorClass: 'OtherError', code: 'WITHHELD' });
});

test('only fixed driver error codes survive failure classification', () => {
  assert.deepEqual(safeFailure(new Error('NATIVE21_RPC_TIMEOUT'), 'rpc-connect'), { phase: 'rpc-connect', errorClass: 'Error', code: 'NATIVE21_RPC_TIMEOUT' });
  assert.equal(safeFailure(new Error('NATIVE21_RPC_TIMEOUT private'), 'rpc-connect').code, 'WITHHELD');
});

for (const module of ['linux-scope-proof','identity-preflight']) test(`new verifier ${module} retains only allowlisted failure location`, () => {
  const error = new Error('secret-input data:image/png;base64,AAAA /private/operator');
  error.stack = `Error: secret-input\n at probe (file:///private/operator/${module}.mjs:71:3)\n at file:///private/operator/run.mjs:90:4`;
  assert.deepEqual(safeFailure(error, 'wire-image-proof'), {phase:'wire-image-proof',errorClass:'Error',code:'WITHHELD',module,line:71,column:3});
});
