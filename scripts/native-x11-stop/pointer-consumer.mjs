// Launched only by the exclusive-display coordinator, from a packed installation.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDesktopClient, resolveActionPermissions } from '@opencoven/openclaw-desktop-use/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { observeApiFulfillment } from './promise-settlement.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.env.NATIVE_OWNED_DISPOSABLE_DISPLAY, 'yes');
const [surface, mode, workspace, adapter, nativeHash, fixturePath, fixturePid, fixtureTitle, ptyHost, pointX, pointY] = process.argv.slice(2);
assert.ok(['sdk', 'mcp-modern', 'mcp-legacy'].includes(surface));
assert.ok(['stop', 'abort', 'timeout'].includes(mode));
assert.equal(createHash('sha256').update(await readFile(adapter)).digest('hex'), nativeHash);
const packageRoot = dirname(createRequire(import.meta.url).resolve('@opencoven/openclaw-desktop-use/package.json'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function assertNoRawDiagnostics(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!['stdout','stderr','argv','rawState','privateState'].includes(key));
    assertNoRawDiagnostics(item);
  }
}
await mkdir(workspace, { mode: 0o700 });
const audit = [];
const options = { workspaceDir: workspace, scope: { principalId: 'owned-x11-pointer-stop', sessionId: surface + mode },
  adapterPath: adapter, actionPermissions: resolveActionPermissions({ actionProfile: 'full' }),
  approvalProvider: async () => 'allowed', auditSink: async event => { audit.push(event); } };
let call, callObserved, close;
if (surface === 'sdk') {
  const client = createDesktopClient(options);
  call = (request, signal) => client.execute(request, { callId: mode + '-' + request.action, signal });
  callObserved = (request, signal) => observeApiFulfillment(call(request, signal), value => value);
  close = async () => {};
} else {
  const stateDir = join(workspace, 'state'); await mkdir(stateDir, { mode: 0o700 });
  const config = join(workspace, 'config.json');
  await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir, principalId: options.scope.principalId,
    sessionId: options.scope.sessionId, adapterPath: adapter, actionProfile: 'full' }), { mode: 0o600 });
  const { createJsonSchemaValidator } = await import(pathToFileURL(join(packageRoot, 'dist/src/mcp/schema.js')));
  const client = new Client({ name: 'owned-x11-pointer-stop', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(),
    ...(surface === 'mcp-modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
  const transport = new StdioClientTransport({ command: 'python3', args: [ptyHost, 'allow', process.execPath,
    join(packageRoot, 'dist/examples/approval-host/main.js'), '--config', config], stderr: 'pipe',
    env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XDG_SESSION_TYPE: 'x11' } });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  const rawCall = request => client.callTool({ name: 'computer_use', arguments: request });
  const normalize = value => ({ content: value.content, details: value.structuredContent });
  call = request => rawCall(request).then(normalize);
  callObserved = request => observeApiFulfillment(rawCall(request), normalize);
  close = () => client.close();
}
const controller = new AbortController();
let pending;
try {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(fixture.pid, Number(fixturePid)); assert.equal(fixture.ready, true);
  assert.equal((await call({ action: 'focus', windowTitle: fixtureTitle })).details.success, true);
  assert.ok(Number.isInteger(Number(pointX)) && Number.isInteger(Number(pointY)));
  const eventCursorBeforeInput = fixture.keys.length;
  // Observe the raw supported API's first callback before normalization and
  // independently of any coordination or Stop still awaited by this runner.
  pending = callObserved({ action: 'click', coords: pointX + ',' + pointY, double: true, timeoutMs: mode === 'timeout' ? 2000 : 15000 }, controller.signal);
  pending.catch(() => {});
  await writeFile(join(workspace, 'input-started'), 'ready');
  const deadline = Date.now() + 8000;
  while (await access(join(workspace, 'held-button-observed')).then(() => false, () => true)) {
    assert.ok(Date.now() < deadline, 'coordinator did not observe a real held helper button');
    await wait(2);
  }
  if (mode === 'stop') assert.equal((await call({ action: 'stop' })).details.success, true);
  if (mode === 'abort') controller.abort();
  const { result, resultSettledMonotonicMs, resultSettledMonotonicNs, fulfillmentBoundary } = await pending;
  assert.equal(result.details.status, mode === 'timeout' ? 'timeout' : 'cancelled');
  const native = result.details.result;
  assert.equal(native.inputCleanup.state, 'verified');
  // The coordinator proves a detached actual button-down boundary across25ms.
  // Cleanup must release that new intended button before promise fulfillment.
  assert.ok(Number.isInteger(native.inputCleanup.releasedButtons)
    && native.inputCleanup.releasedButtons === 1);
  assert.equal(native.partial, true);
  assert.equal(native.inputMayHaveStarted, true);
  assertNoRawDiagnostics(result);
  if (surface === 'sdk') assertNoRawDiagnostics(audit);
  else {
    const durable = await readFile(join(workspace, 'state', 'audit.jsonl'), 'utf8');
    for (const line of durable.trim().split('\n').filter(Boolean)) assertNoRawDiagnostics(JSON.parse(line));
  }
  await writeFile(join(workspace, 'consumer-receipt.json'), JSON.stringify({ surface, mode, status: result.details.status,
    inputCleanup: native.inputCleanup, nativeOk: native.ok, nativeCode: native.code, controlledSchedulingFaultInjection: true,
    inputMayHaveStarted: native.inputMayHaveStarted, partial: native.partial,
    resultSettledMonotonicMs, resultSettledMonotonicNs, fulfillmentBoundary, eventCursorBeforeInput,
    approvalMode: surface === 'sdk' ? 'scripted-trusted-provider' : 'scripted-trusted-reference-pty', nativeSha256: nativeHash, privateInputAbsent: true }) + '\n');
} finally {
  controller.abort(); if (pending) await pending.catch(() => {}); await close();
}
