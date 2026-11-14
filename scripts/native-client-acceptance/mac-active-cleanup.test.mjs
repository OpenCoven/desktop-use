import assert from 'node:assert/strict';
import test from 'node:test';

const module = await import('./mac-active-cleanup.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
function options(extra = {}) {
  const calls = [];
  return { calls, args: { abort: () => calls.push('abort'), close: async () => calls.push('close'),
    closeLines: () => calls.push('lines'), pendingTimeoutMs: 1, stopTimeoutMs: 1, closeTimeoutMs: 1, ...extra } };
}
test('active-client cleanup is available without SDK or desktop imports', () => {
  assert.equal(typeof module.cleanupMacActiveClient, 'function');
});
test('timed-out input cleanup still closes the connector and control reader', async () => {
  const { args, calls } = options({ pending: new Promise(() => {}) });
  await assert.rejects(module.cleanupMacActiveClient(args), /deadline/i);
  assert.deepEqual(calls, ['abort', 'close', 'lines']);
});
test('rejected Stop cleanup cannot skip connector close or replace the first failure', async () => {
  const first = new Error('first pending failure');
  const { args, calls } = options({ pending: Promise.reject(first), stopPending: Promise.reject(new Error('second stop failure')) });
  // Attach before the input await so this intentional later rejection cannot
  // itself become an unrelated unhandled rejection in the test process.
  args.stopPending.catch(() => {});
  await assert.rejects(module.cleanupMacActiveClient(args), error => error === first);
  assert.deepEqual(calls, ['abort', 'close', 'lines']);
});
test('connector close failure still closes the control reader', async () => {
  const { args, calls } = options({ close: async () => { calls.push('close'); throw new Error('close failure'); } });
  await assert.rejects(module.cleanupMacActiveClient(args), /close failure/);
  assert.deepEqual(calls, ['abort', 'close', 'lines']);
});
test('normal resolved cleanup completes all phases', async () => {
  const { args, calls } = options({ pending: Promise.resolve(), stopPending: Promise.resolve() });
  await module.cleanupMacActiveClient(args);
  assert.deepEqual(calls, ['abort', 'close', 'lines']);
});
test('a rejection without an Error value still fails visibly and closes the reader', async () => {
  const { args, calls } = options({ close: () => Promise.reject(undefined) });
  await assert.rejects(module.cleanupMacActiveClient(args), /cleanup.*failed/i);
  assert.deepEqual(calls, ['abort', 'lines']);
});
test('supported API fulfillment is stamped before consumer response normalization', async () => {
  assert.equal(typeof module.observeMacCall, 'function');
  const order = [];
  const result = await module.observeMacCall(Promise.resolve('raw'), rejected => { assert.equal(rejected, false); order.push('stamp'); }, value => { order.push('normalize'); return value + '-mapped'; });
  assert.equal(result, 'raw-mapped');
  assert.deepEqual(order, ['stamp', 'normalize']);
});
test('supported API rejection is stamped once and keeps the original failure', async () => {
  assert.equal(typeof module.observeMacCall, 'function');
  const failure = new Error('API failure'), seen = [];
  await assert.rejects(module.observeMacCall(Promise.reject(failure), rejected => seen.push(rejected), () => { throw new Error('must not normalize rejection'); }), error => error === failure);
  assert.deepEqual(seen, [true]);
});
test('normalization failure cannot move or duplicate the supported API timestamp', async () => {
  assert.equal(typeof module.observeMacCall, 'function');
  const seen = [];
  await assert.rejects(module.observeMacCall(Promise.resolve({}), rejected => seen.push(rejected), () => { throw new Error('normalization failed'); }), /normalization failed/);
  assert.deepEqual(seen, [false]);
});
test('a failed rejection observer preserves the original API rejection and records the observer failure', async () => {
  const failure = new Error('original API failure'), observer = new Error('observer failure'), seen = [];
  await assert.rejects(module.observeMacCall(Promise.reject(failure), () => { throw observer; }, value => value, error => seen.push(error)), error => error === failure);
  assert.deepEqual(seen, [observer]);
});
