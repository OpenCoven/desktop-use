// Deterministic checks for the real-harness qualification runner. No harness binary, provider or network is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyResult, createModelEndpoint, desktopTools, extractJsonObject } from './harness-qualification/endpoint.mjs';
import { HARNESSES } from './harness-qualification/harnesses.mjs';
import { LEVELS, VERDICTS, assertReceipt, assertSanitized, combine, discoveryVerdict, exitCode, observationVerdict, overall, unqualified } from './harness-qualification/verdict.mjs';

const runner = fileURLToPath(new URL('./qualify-harness.mjs', import.meta.url));
const png = await readFile(new URL('../contracts/v1/fixtures/images/valid.png', import.meta.url));
const pngSha = createHash('sha256').update(png).digest('hex');
const listed = [{ listedAs: 'mcp__coven-desktop-use__computer_use', mcpName: 'computer_use' }];
const delivered = { called: true, resultSeen: true, status: 'success', structuredContent: 'delivered' };
const receiptFor = (levels, verdict, extra = {}) => ({ schemaVersion: 1, kind: 'harness-qualification', requestedLevels: Object.keys(levels), harness: { id: 'x', version: '1.0' }, host: { os: 'linux', displayServer: 'none' }, levels, verdict, ...extra });

test('an unqualified level can never make a run pass', () => {
  for (const l1 of VERDICTS) for (const l2 of VERDICTS) {
    const verdict = combine([l1, l2]);
    if (l1 === 'unqualified' || l2 === 'unqualified') assert.notEqual(verdict, 'pass', `${l1}+${l2}`);
    if (l1 === 'fail' || l2 === 'fail') assert.equal(verdict, 'fail', `${l1}+${l2}`);
    if (l1 === 'pass' && l2 === 'pass') assert.equal(verdict, 'pass');
  }
  assert.equal(combine([]), 'unqualified');
  assert.equal(overall({ L1: { verdict: 'pass' } }, ['L1', 'L2']), 'unqualified', 'a requested level without a result is unqualified');
  assert.equal(exitCode('pass'), 0);
  assert.notEqual(exitCode('unqualified'), 0);
  assert.notEqual(exitCode('fail'), 0);
  assert.throws(() => combine(['skipped']), /Unknown verdict/);
  assert.throws(() => unqualified(''), /reason/);
});

test('a receipt that reports an unqualified level as a pass is rejected', () => {
  assert.throws(() => assertReceipt(receiptFor({ L1: { verdict: 'pass' }, L2: unqualified('binary-not-found') }, 'pass')), /disagrees/);
  assert.throws(() => assertReceipt(receiptFor({ L1: { verdict: 'unqualified' } }, 'unqualified')), /needs a reason/);
  assert.throws(() => assertReceipt(receiptFor({ L1: { verdict: 'fail' } }, 'fail')), /needs a reason/);
  assert.throws(() => assertReceipt(receiptFor({ L1: { verdict: 'pass' } }, 'pass', { harness: { id: 'x', version: null } })), /harness version/);
  assert.throws(() => assertReceipt(receiptFor({ L1: { verdict: 'pass' } }, 'pass', { host: { os: 'linux' } })), /display server/);
  assert.throws(() => assertReceipt(receiptFor({}, 'pass')), /no requested level/);
  assert.equal(assertReceipt(receiptFor({ L1: unqualified('no-runner-recipe') }, 'unqualified')).verdict, 'unqualified');
  assert.equal(assertReceipt(receiptFor({ L1: { verdict: 'pass' }, L2: { verdict: 'pass' } }, 'pass')).verdict, 'pass');
  assert.deepEqual(LEVELS, ['L1', 'L2']);
});

test('L1 needs exactly one desktop tool named computer_use; L2 needs both structured results', () => {
  assert.equal(discoveryVerdict({ endpointReached: false, desktopTools: [] }).verdict, 'unqualified');
  assert.deepEqual(discoveryVerdict({ endpointReached: true, desktopTools: [] }), { verdict: 'fail', reason: 'computer-use-not-listed' });
  assert.deepEqual(discoveryVerdict({ endpointReached: true, connectorStarted: false, desktopTools: [] }), { verdict: 'fail', reason: 'mcp-server-not-started' });
  assert.deepEqual(discoveryVerdict({ endpointReached: true, desktopTools: [...listed, { listedAs: 'mcp__coven-desktop-use__other', mcpName: 'other' }] }), { verdict: 'fail', reason: 'unexpected-desktop-tools' });
  assert.equal(discoveryVerdict({ endpointReached: true, desktopTools: listed }).verdict, 'pass');
  const discovery = { endpointReached: true, desktopTools: listed };
  assert.equal(observationVerdict(discovery, { health: delivered, screenshot: { ...delivered, image: { handling: 'dropped' } } }).verdict, 'pass', 'image handling is recorded, not scored');
  assert.deepEqual(observationVerdict(discovery, { health: { ...delivered, structuredContent: 'transformed' }, screenshot: delivered }), { verdict: 'fail', reason: 'health-structured-result-transformed' });
  assert.deepEqual(observationVerdict(discovery, { health: delivered, screenshot: { called: true, resultSeen: false } }), { verdict: 'fail', reason: 'screenshot-result-not-returned-to-model' });
  assert.deepEqual(observationVerdict(discovery, { health: { ...delivered, status: 'error' }, screenshot: delivered }), { verdict: 'fail', reason: 'health-not-successful' });
  assert.equal(observationVerdict({ endpointReached: false, desktopTools: [] }, {}).verdict, 'unqualified');
});

test('desktop tools are recognised under each harness naming scheme', () => {
  const schema = { type: 'object' };
  assert.deepEqual(desktopTools([{ name: 'Bash' }, { name: 'mcp__coven-desktop-use__computer_use', input_schema: schema }], 'anthropic-messages').desktop.map(tool => tool.mcpName), ['computer_use']);
  assert.deepEqual(desktopTools([{ name: 'coven-desktop-use-computer_use', input_schema: schema }], 'anthropic-messages').desktop.map(tool => [tool.mcpName, tool.schemaTopLevelKeys]), [['computer_use', ['type']]]);
  const codex = desktopTools([{ type: 'function', name: 'exec_command' }, { type: 'namespace', name: 'mcp__coven_desktop_use', tools: [{ name: 'computer_use', parameters: schema }] }], 'openai-responses');
  assert.deepEqual(codex.desktop.map(tool => [tool.listedAs, tool.mcpName]), [['mcp__coven_desktop_use/computer_use', 'computer_use']]);
  assert.deepEqual(codex.otherTools, ['exec_command']);
});

test('model-visible results are classified as delivered, transformed or dropped', () => {
  const details = JSON.stringify({ status: 'success', action: 'screenshot', observationV1: {} });
  const exact = classifyResult({ texts: [details], images: [{ mediaType: 'image/png', bytes: png, carrier: 'tool-result' }], action: 'screenshot', fixtureSha256: pngSha });
  assert.equal(exact.structuredContent, 'delivered'); assert.equal(exact.structuredCarrier, 'text-json');
  assert.equal(exact.image.handling, 'delivered'); assert.equal(exact.image.fixtureBytesMatch, true);
  const resized = classifyResult({ texts: [details], images: [{ mediaType: 'image/jpeg', bytes: Buffer.from('other') }], action: 'screenshot', fixtureSha256: pngSha });
  assert.equal(resized.image.handling, 'transformed');
  const omitted = classifyResult({ texts: [`${details}\n<an image attachment was omitted from this request because image input is unavailable for the current model>`], images: [], action: 'screenshot', fixtureSha256: pngSha });
  assert.equal(omitted.structuredCarrier, 'text-json-with-harness-text'); assert.equal(omitted.image.handling, 'dropped'); assert.equal(omitted.image.textPlaceholder, true);
  const prefixed = classifyResult({ texts: [`Wall time: 0.1 seconds\nOutput:\n${JSON.stringify({ status: 'success', action: 'health' })}`], images: [], action: 'health', fixtureSha256: pngSha });
  assert.equal(prefixed.structuredContent, 'delivered'); assert.equal(prefixed.image, undefined);
  const spilled = classifyResult({ texts: ['Output too large to read at once (42.9 KB). Saved to: <file>\nPreview (first 500 chars):\n{"status":"success","success":true,"evidence":{"action":"health"'], images: [], action: 'health', fixtureSha256: pngSha });
  assert.equal(spilled.structuredContent, 'transformed'); assert.equal(spilled.transformation, 'harness-truncated-or-spilled'); assert.equal(spilled.status, 'success');
  assert.equal(classifyResult({ texts: [], images: [], action: 'health', fixtureSha256: pngSha }).structuredContent, 'dropped');
  assert.equal(extractJsonObject('{"a":"}"} trailing').value.a, '}');
  assert.equal(extractJsonObject('{"a":'), undefined);
});

async function post(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.text();
}

test('the scripted Messages endpoint calls health, then screenshot, then ends', async () => {
  const endpoint = createModelEndpoint({ protocol: 'anthropic-messages', fixtureSha256: pngSha, reason: 'private-marker' });
  const { port } = await endpoint.start();
  try {
    const tools = [{ name: 'Read', input_schema: {} }, { name: 'mcp__coven-desktop-use__computer_use', input_schema: { type: 'object' } }];
    const first = await post(port, '/v1/messages', { model: 'm', tools, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(first.content[0].type, 'tool_use'); assert.deepEqual(first.content[0].input, { action: 'health', reason: 'private-marker' });
    const health = { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: [{ type: 'text', text: JSON.stringify({ status: 'success', action: 'health' }) }] }] };
    const second = await post(port, '/v1/messages', { model: 'm', tools, messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: first.content }, health] });
    assert.equal(second.content[0].input.action, 'screenshot');
    const shot = { role: 'user', content: [{ type: 'tool_result', tool_use_id: second.content[0].id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }, { type: 'text', text: JSON.stringify({ status: 'success', action: 'screenshot' }) }] }] };
    const third = await post(port, '/v1/messages', { model: 'm', tools, messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: first.content }, health, { role: 'assistant', content: second.content }, shot] });
    assert.equal(third.content[0].type, 'text');
    const seen = endpoint.observations();
    assert.equal(seen.finished, true); assert.equal(seen.discovery.desktopTools.length, 1);
    assert.equal(seen.observation.health.structuredContent, 'delivered'); assert.equal(seen.observation.screenshot.image.handling, 'delivered');
    assert.doesNotMatch(JSON.stringify(seen), /private-marker|iVBOR/, 'observations hold no private input or image bytes');
  } finally { await endpoint.stop(); }
});

test('the scripted Responses endpoint discovers deferred MCP tools through tool_search', async () => {
  const endpoint = createModelEndpoint({ protocol: 'openai-responses', fixtureSha256: pngSha, reason: 'private-marker' });
  const { port } = await endpoint.start();
  const events = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const item = text => events(text).find(event => event.type === 'response.output_item.done').item;
  try {
    const tools = [{ type: 'function', name: 'exec_command' }, { type: 'tool_search', execution: 'client' }];
    const search = item(await post(port, '/v1/responses', { model: 'm', tools, input: [] }));
    assert.equal(search.type, 'tool_search_call');
    const found = { type: 'tool_search_output', call_id: search.call_id, status: 'completed', execution: 'client', tools: [{ type: 'namespace', name: 'mcp__coven_desktop_use', tools: [{ name: 'computer_use', parameters: { type: 'object' } }] }] };
    const call = item(await post(port, '/v1/responses', { model: 'm', tools, input: [search, found] }));
    assert.equal(call.type, 'function_call'); assert.equal(call.namespace, 'mcp__coven_desktop_use'); assert.equal(JSON.parse(call.arguments).action, 'health');
    const seen = endpoint.observations();
    assert.equal(seen.discovery.mode, 'tool-search'); assert.deepEqual(seen.discovery.search.returnedTools, ['mcp__coven_desktop_use[computer_use]']);
    assert.equal(discoveryVerdict(seen.discovery).verdict, 'pass');
  } finally { await endpoint.stop(); }
});

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
  return { status: result.status, receipt: result.stdout.trim() ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}
const privateValues = () => [homedir(), tmpdir(), fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')];

test('a missing harness binary is reported unqualified with a reason, never as a pass', () => {
  const { status, receipt } = cli(['--harness', 'codex', '--bin', join(tmpdir(), 'no-such-dir', 'codex')]);
  assert.equal(status, 2);
  assert.equal(receipt.verdict, 'unqualified');
  for (const level of ['L1', 'L2']) assert.deepEqual([receipt.levels[level].verdict, receipt.levels[level].reason], ['unqualified', 'binary-not-found']);
  assert.ok(receipt.host.os && receipt.host.displayServer);
  assertReceipt(receipt); assertSanitized(receipt, privateValues());
});

test('harnesses without a runner recipe are unqualified with their recorded blocker', () => {
  for (const id of Object.keys(HARNESSES).filter(id => HARNESSES[id].blocked)) {
    const { status, receipt } = cli(['--harness', id, '--level', 'L1']);
    assert.equal(status, 2, id); assert.equal(receipt.levels.L1.reason, 'no-runner-recipe'); assert.ok(receipt.levels.L1.detail);
  }
  assert.equal(cli(['--harness', 'not-a-harness']).status, 64);
  assert.equal(cli(['--harness', 'codex', '--level', 'L9']).status, 64);
});

test('a harness that reaches the endpoint without starting the connector fails, and one that never reaches it is unqualified', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qualify-harness-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connector = join(root, 'unused-connector.mjs');
  await writeFile(connector, '');
  // Stand-in harnesses: one asks the Messages endpoint for a turn with no tools, one exits without a request.
  const reaching = join(root, 'reaching-harness');
  await writeFile(reaching, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('stand-in 1.0'); process.exit(0); }\nfetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', tools: [{ name: 'Read', input_schema: {} }], messages: [{ role: 'user', content: 'x' }] }) }).then(r => r.text()).then(() => process.exit(0));\n`, { mode: 0o700 });
  const silent = join(root, 'silent-harness');
  await writeFile(silent, `#!${process.execPath}\nconsole.log('stand-in 1.0');\n`, { mode: 0o700 });
  const failed = cli(['--harness', 'claude-code', '--bin', reaching, '--connector', connector, '--timeout', '30']);
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(failed.receipt.levels.L1, { verdict: 'fail', reason: 'mcp-server-not-started' }, 'the stand-in never starts the connector');
  assert.equal(failed.receipt.lifecycle.connectorStarted, false);
  assert.equal(failed.receipt.harness.version, 'stand-in 1.0');
  assertReceipt(failed.receipt); assertSanitized(failed.receipt, [...privateValues(), root]);
  const quiet = cli(['--harness', 'claude-code', '--bin', silent, '--connector', connector, '--timeout', '30']);
  assert.equal(quiet.status, 2, quiet.stderr);
  assert.equal(quiet.receipt.verdict, 'unqualified'); assert.equal(quiet.receipt.levels.L1.reason, 'harness-exited-before-endpoint');
});

test('receipts with private values are refused', () => {
  assert.throws(() => assertSanitized({ path: `${homedir()}/x` }, [homedir()]), /private value/);
  assert.equal(assertSanitized({ ok: true }, [homedir(), '', 'abc']).ok, true, 'empty and very short values are not treated as private');
});
