import assert from 'node:assert/strict';
import test from 'node:test';
import { observeApiFulfillment } from './promise-settlement.mjs';

test('records the API callback before result normalization can delay it', async () => {
  let normalizeStarted;
  const api = Promise.resolve({ content: [], structuredContent: { status: 'cancelled' } });
  const receipt = await observeApiFulfillment(api, value => {
    normalizeStarted = process.hrtime.bigint();
    while (process.hrtime.bigint() - normalizeStarted < 1_000_000n) {} // expose the old wrapper gap
    return { content: value.content, details: value.structuredContent };
  });
  assert.ok(BigInt(receipt.resultSettledMonotonicNs) <= normalizeStarted);
  assert.equal(receipt.resultSettledMonotonicMs, Number(BigInt(receipt.resultSettledMonotonicNs) / 1_000_000n));
  assert.deepEqual(receipt.result, { content: [], details: { status: 'cancelled' } });
  assert.equal(receipt.fulfillmentBoundary, 'supported-api-first-fulfillment');
});

test('API rejection cannot become a qualified fulfillment receipt', async () => {
  const failure = new Error('fixture-api-rejection');
  let normalized = false;
  await assert.rejects(observeApiFulfillment(Promise.reject(failure), () => { normalized = true; }), error => error === failure);
  assert.equal(normalized, false);
});

test('normalization failure cannot become a qualified fulfillment receipt', async () => {
  const failure = new Error('fixture-normalization-failure');
  await assert.rejects(observeApiFulfillment(Promise.resolve({}), () => { throw failure; }), error => error === failure);
});
