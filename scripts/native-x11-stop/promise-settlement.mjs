// Attach directly to the supported API promise, before any result normalization.
export function observeApiFulfillment(promise, normalize) {
  return promise.then(value => {
    const now = process.hrtime.bigint();
    return { result: normalize(value), resultSettledMonotonicNs: now.toString(), resultSettledMonotonicMs: Number(now / 1_000_000n),
      fulfillmentBoundary: 'supported-api-first-fulfillment' };
  });
}
