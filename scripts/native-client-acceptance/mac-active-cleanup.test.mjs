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
