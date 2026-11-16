// Pure verdict rules for real-harness qualification receipts. No I/O.
// A level is `pass`, `fail` or `unqualified`. `unqualified` means the run could not observe the level
// (missing binary, no configurable model endpoint, harness never reached the endpoint); it is never a pass.
export const VERDICTS = Object.freeze(['pass', 'fail', 'unqualified']);
export const LEVELS = Object.freeze(['L1', 'L2']);
export const EXIT_CODES = Object.freeze({ pass: 0, fail: 1, unqualified: 2 });

export function unqualified(reason, detail) {
  if (typeof reason !== 'string' || !/^[a-z0-9-]+$/.test(reason)) throw new TypeError('An unqualified result needs a kebab-case reason');
  return detail === undefined ? { verdict: 'unqualified', reason } : { verdict: 'unqualified', reason, detail };
}

// fail beats unqualified beats pass; an empty set is unqualified.
export function combine(verdicts) {
  const list = [...verdicts];
  for (const verdict of list) if (!VERDICTS.includes(verdict)) throw new TypeError(`Unknown verdict ${String(verdict)}`);
  if (list.includes('fail')) return 'fail';
  if (list.length === 0 || list.includes('unqualified')) return 'unqualified';
  return 'pass';
}

export function overall(levels, requested) {
  return combine(requested.map(level => levels[level]?.verdict ?? 'unqualified'));
}

export function exitCode(verdict) {
  if (!VERDICTS.includes(verdict)) throw new TypeError(`Unknown verdict ${String(verdict)}`);
  return EXIT_CODES[verdict];
}

// L1 discovery: exactly one desktop tool, and it is computer_use.
export function discoveryVerdict(discovery) {
  if (!discovery?.endpointReached) return unqualified('endpoint-not-reached');
  if (discovery.desktopTools.length === 1 && discovery.desktopTools[0].mcpName === 'computer_use') return { verdict: 'pass' };
  if (discovery.desktopTools.length) return { verdict: 'fail', reason: 'unexpected-desktop-tools' };
  return { verdict: 'fail', reason: discovery.connectorStarted === false ? 'mcp-server-not-started' : 'computer-use-not-listed' };
}

// L2 observation: health and screenshot both reach the model as structured results. Image handling is recorded,
// not scored: a harness that drops images still observes through structured content.
export function observationVerdict(discovery, observation) {
  const l1 = discoveryVerdict(discovery);
  if (l1.verdict !== 'pass') return l1.verdict === 'unqualified' ? l1 : { verdict: 'fail', reason: 'discovery-failed' };
  for (const action of ['health', 'screenshot']) {
    const seen = observation?.[action];
    if (!seen?.called) return { verdict: 'fail', reason: `${action}-not-called` };
    if (!seen.resultSeen) return { verdict: 'fail', reason: `${action}-result-not-returned-to-model` };
    if (seen.structuredContent !== 'delivered') return { verdict: 'fail', reason: `${action}-structured-result-${seen.structuredContent === 'transformed' ? 'transformed' : 'missing'}` };
    if (seen.status !== 'success') return { verdict: 'fail', reason: `${action}-not-successful` };
  }
  return { verdict: 'pass' };
}

// A receipt is rejected, not reported, when its verdicts disagree with its levels.
export function assertReceipt(receipt) {
  if (receipt?.schemaVersion !== 1 || receipt.kind !== 'harness-qualification') throw new Error('Not a harness qualification receipt');
  if (!Array.isArray(receipt.requestedLevels) || receipt.requestedLevels.length === 0 || !receipt.requestedLevels.every(level => LEVELS.includes(level))) throw new Error('Receipt names no requested level');
  for (const level of receipt.requestedLevels) {
    const result = receipt.levels?.[level];
    if (!result || !VERDICTS.includes(result.verdict)) throw new Error(`Receipt level ${level} has no verdict`);
    if (result.verdict === 'unqualified' && !result.reason) throw new Error(`Unqualified level ${level} needs a reason`);
    if (result.verdict === 'fail' && !result.reason) throw new Error(`Failed level ${level} needs a reason`);
  }
  const expected = overall(receipt.levels, receipt.requestedLevels);
  if (receipt.verdict !== expected) throw new Error(`Receipt verdict ${receipt.verdict} disagrees with its levels (${expected})`);
  for (const field of ['harness', 'host']) if (!receipt[field]) throw new Error(`Receipt has no ${field}`);
  if (receipt.verdict === 'pass' && !(receipt.harness.version && receipt.host.os && receipt.host.displayServer)) throw new Error('A pass needs the harness version, OS and display server');
  return receipt;
}

// Receipts never carry private paths, private input or image bytes.
export function assertSanitized(value, forbidden) {
  const text = JSON.stringify(value);
  for (const item of forbidden) {
    if (typeof item === 'string' && item.length >= 4 && text.includes(item)) throw new Error('Receipt contains a private value');
  }
  return value;
}
