// Installed-consumer child of mac-active-coordinator.py. Run only after unlock
// and an exclusive owned-fixture lease; stdout carries scalar control messages.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createDesktopClient, resolveActionPermissions } from '@opencoven/openclaw-desktop-use/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { verifyMacIdentity, focusedFixture, preparedPython, nativeHarnessEnvironment } from './identity-preflight.mjs';
import { proveMacActiveBoundary, proveMacNoLateControls, verifyMacClockBracket } from './mac-control-proof.mjs';
import { cleanupMacActiveClient, observeMacCall } from './mac-active-cleanup.mjs';

assert.equal(process.platform, 'darwin');
assert.equal(process.env.NATIVE_ACCEPTANCE_OWNED_MAC_INPUT, 'yes', 'explicit unlocked owned-fixture execution is required');
const [surface, mode, caseId] = process.argv.slice(2);
assert.ok(['sdk', 'mcp-modern', 'mcp-legacy'].includes(surface));
assert.ok(['stop', 'timeout', ...(surface === 'sdk' ? ['abort'] : [])].includes(mode));
assert.match(caseId, /^[a-f0-9-]{36}$/);
const root = await realpath(process.env.NATIVE_ACCEPTANCE_ROOT);
const adapter = await realpath(process.env.NATIVE_ACCEPTANCE_ADAPTER);
const baseline = await verifyMacIdentity(root, adapter);
assert.equal(baseline.controlObservationEnabled, true, 'a separately prepared observer-enabled fixture is required');
for (const [name, expected] of Object.entries(baseline.consumerScriptsSha256 ?? {})) {
  assert.ok(!name.includes('/') && /^[a-f0-9]{64}$/.test(expected), 'invalid prepared harness identity');
  assert.equal(createHash('sha256').update(await readFile(join(root, 'consumer', name))).digest('hex'), expected, 'prepared consumer script changed');
}
assert.ok(baseline.consumerScriptsSha256?.['mac-active-client.mjs'], 'active consumer provenance is missing');
const helperPath = await realpath(join(root, 'bin/peekaboo'));
const fixturePath = await realpath(process.env.NATIVE_ACCEPTANCE_FIXTURE_STATE);
assert.equal(fixturePath, await realpath(join(root, 'fixture-state.json')));
const python = await preparedPython(process.env.NATIVE_ACCEPTANCE_PYTHON);
const ptyScript = await realpath(process.env.NATIVE_ACCEPTANCE_PTY);
const imageProofScript = await realpath(process.env.NATIVE_ACCEPTANCE_IMAGE_PROOF);
assert.equal(ptyScript, await realpath(join(root, 'consumer/pty-host.py')));
assert.equal(imageProofScript, await realpath(join(root, 'consumer/image-proof.py')));
const caseRoot = join(root, `mac-active-${caseId}`);
await mkdir(caseRoot, { mode: 0o700 }); // Never reuse another case's state.
const workspace = join(caseRoot, 'workspace'), stateRoot = join(caseRoot, 'state');
await mkdir(workspace, { mode: 0o700 }); await mkdir(stateRoot, { mode: 0o700 });
const state = async () => focusedFixture(fixturePath, fixturePid);
let fixturePid;
const fixture = await state(); fixturePid = fixture.pid;
const target = { app: 'org.opencoven.desktopuse.acceptance', windowId: fixture.windowNumber };
assert.equal(createHash('sha256').update(await readFile(join(root, 'bin/control-clock-probe'))).digest('hex'), baseline.clockProbeSha256);
const beforeClock = String(process.hrtime.bigint());
const clock = spawnSync(join(root, 'bin/control-clock-probe'), [], { encoding: 'utf8', timeout: 3000 });
const afterClock = String(process.hrtime.bigint());
assert.equal(clock.status, 0, 'clock-only preflight failed');
const clockProof = verifyMacClockBracket({ platform: process.platform, uvVersion: process.versions.uv,
  beforeNs: beforeClock, probeNs: clock.stdout.trim(), afterNs: afterClock });
const emit = message => process.stdout.write(JSON.stringify({ schemaVersion: 1, caseId, ...message }) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lifetime = new AbortController();
lines.once('close', () => lifetime.abort());
const commands = lines[Symbol.asyncIterator]();
async function command(expected) {
  let timer;
  try {
    const line = await Promise.race([commands.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('COORDINATOR_DEADLINE')), 35_000);
    })]);
    assert.equal(line.done, false, 'coordinator pipe closed');
    assert.ok(line.value.length <= 512, 'control command exceeds its scalar budget');
    const value = JSON.parse(line.value);
    assert.equal(value.caseId, caseId); assert.equal(value.kind, expected);
    return value;
  } finally { clearTimeout(timer); }
}
const abort = new AbortController();
let invoke, close = async () => {}, pending, stopPending;
let inputReturnedNs, stopReturnedNs, stopState, settled = false;
let settlementObserverFailed = false;
const observerFailed = () => { settlementObserverFailed = true; };
const audits = [];
const packageRoot = dirname(createRequire(import.meta.url).resolve('@opencoven/openclaw-desktop-use/package.json'));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
const privateWrite = (name, value) => writeFile(join(caseRoot, name), JSON.stringify(value), { mode: 0o600 });
try {
  if (surface === 'sdk') {
    const client = createDesktopClient({ workspaceDir: workspace, scope: { principalId: 'native-active-mac', sessionId: caseId }, adapterPath: adapter,
      actionPermissions: resolveActionPermissions({ actionProfile: 'full' }), auditSink: async event => { audits.push(event); }, approvalProvider: () => 'allowed' });
    invoke = (request, signal, onSettlement) => observeMacCall(client.execute(request, { callId: `${caseId}-${request.action}`,
      signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }), onSettlement, undefined, observerFailed);
  } else {
    const config = join(caseRoot, 'config.json');
    await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir: stateRoot, principalId: 'native-active-mac', sessionId: caseId, adapterPath: adapter, actionProfile: 'full' }), { mode: 0o600 });
    const { createJsonSchemaValidator } = await import(pathToFileURL(join(packageRoot, 'dist/src/mcp/schema.js')));
    const modern = surface === 'mcp-modern';
    const client = new Client({ name: 'native-active-mac', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(),
      ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
    const transport = new StdioClientTransport({ command: python,
      args: [ptyScript, 'allow', process.execPath, join(packageRoot, 'dist/examples/approval-host/main.js'), '--config', config],
      stderr: 'pipe', env: nativeHarnessEnvironment(caseRoot) });
    close = () => transport.close(); // Also clean up a partially failed connect.
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), modern ? '2026-07-28' : '2025-11-25');
    assert.equal(client.getServerVersion().version, manifest.version);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['computer_use']);
    invoke = (request, signal, onSettlement) => observeMacCall(client.callTool({ name: 'computer_use', arguments: request },
      { signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }), onSettlement,
    result => ({ content: result.content, details: result.structuredContent }), observerFailed);
    close = () => client.close();
  }
  const call = async request => {
    const result = await invoke({ ...request, timeoutMs: request.timeoutMs ?? 5000 });
    assert.equal(result.details.success, true, 'native preparation call failed');
    return result;
  };
  const verifyImage = async (response, label) => {
    await privateWrite(`${label}-private.json`, response);
    const verifier = spawnSync(python, [imageProofScript, '--result', join(caseRoot, `${label}-private.json`),
      '--fixture-state', fixturePath, '--expected', fixture.clicks ? 'clicked' : 'initial', '--output', join(caseRoot, `${label}-proof.json`)],
    { encoding: 'utf8', timeout: 20_000 });
    assert.equal(verifier.status, 0, 'actual native fixture image did not verify');
    const images = response.content.filter(item => item.type === 'image');
    assert.equal(images.length, 1); assert.equal(images[0].mimeType, 'image/png');
    const bytes = Buffer.from(images[0].data, 'base64');
    await writeFile(join(caseRoot, `${label}-pixels-private.png`), bytes, { mode: 0o600, flag: 'wx' });
    return createHash('sha256').update(bytes).digest('hex');
  };
  assert.equal((await call({ action: 'health' })).details.capabilitiesV1.schemaVersion, 1);
  const scan = await call({ action: 'inspect', ...target, mode: 'window', annotate: false });
  const beforeImageSha256 = await verifyImage(scan, 'readiness');
  const input = scan.details.result.result.data.ui_elements.find(element => element.identifier === 'fixture-input');
  assert.ok(input?.id, 'owned fixture input element is missing');
  await call({ action: 'click', ...target, on: input.id });
  await call({ action: 'inspect', ...target, mode: 'window', annotate: false });
  await delay(250); await state();
  emit({ kind: 'ready', fixturePid, windowNumber: fixture.windowNumber, clockProof, clockNowNs: String(process.hrtime.bigint()) });
  await command('start');
  const text = 'a'.repeat(4000);
  const stampInput = rejected => {
    inputReturnedNs = String(process.hrtime.bigint()); // First supported-API callback, before normalization/await.
    settled = true;
    emit({ kind: 'input-settled', inputReturnedNs, ...(rejected ? { rejected: true } : {}) });
  };
  pending = invoke({ action: 'type-text', ...target, text, clear: true, timeoutMs: mode === 'timeout' ? 2000 : 12000 }, abort.signal, stampInput);
  pending.catch(() => {});
  emit({ kind: 'started' });
  const active = await Promise.race([command('active'), pending.then(() => { throw new Error('ACTIVE_BOUNDARY_MISSED'); })]);
  assert.equal(settled, false, 'input already settled before the active trigger');
  assert.match(active.observedActiveNs, /^[0-9]+$/);
  if (mode === 'stop') {
    stopPending = invoke({ action: 'stop' }, undefined, () => { stopReturnedNs = String(process.hrtime.bigint()); }).then(result => {
      stopState = result.details.state;
      emit({ kind: 'stop-acknowledged', stopReturnedNs, state: ['idle', 'cancelling'].includes(stopState) ? stopState : 'unknown' });
      return result;
    });
    stopPending.catch(() => {});
  } else if (mode === 'abort') abort.abort();
  const result = await pending;
  assert.equal(result.details.status, mode === 'timeout' ? 'timeout' : 'cancelled');
  if (stopPending) {
    const stopped = await stopPending;
    assert.equal(stopped.details.success, true);
    assert.ok(stopped.details.cancellationRequested >= 1, 'scoped Stop did not reach active work');
  }
  await command('proof-ready');
  const bundle = JSON.parse(await readFile(join(caseRoot, 'coordinator-proof-private.json')));
  const activeProof = proveMacActiveBoundary({ ...bundle.active, expectedHelperPath: helperPath });
  assert.equal(activeProof.activeObservedNs, active.observedActiveNs);
  assert.ok(BigInt(bundle.helperGoneNs) < BigInt(inputReturnedNs), 'helper disappearance before fulfillment is unproved');
  const controlProof = proveMacNoLateControls({ before: bundle.active.baseline, after: bundle.after,
    returnedNs: inputReturnedNs, observedActiveInputNs: active.observedActiveNs });
  const afterImageSha256 = await verifyImage(await call({ action: 'inspect', ...target, mode: 'window', annotate: false }), 'after');
  const audit = surface === 'sdk' ? JSON.stringify(audits) : await readFile(join(stateRoot, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes(text)); assert.doesNotMatch(audit, /"(?:nonce|mac|approvalId|screenshot_raw)"|base64/);
  const receipt = { schemaVersion: 1, success: true, surface, mode, packageVersion: manifest.version,
    harnessSourceCommit: baseline.harnessSourceCommit ?? baseline.sourceCommit,
    packageSha256: baseline.packageSha256, nativeSha256: baseline.nativeSha256, helperSha256: baseline.helperSha256,
    decisionSource: surface === 'sdk' ? 'scripted-trusted-host' : 'scripted-operator-through-real-terminal-broker',
    nodeVersion: process.versions.node, libuvVersion: process.versions.uv, clockProof, activeProof, controlProof,
    inputReturnedNs, ...(stopReturnedNs ? { stopReturnedNs, stopState, stopAcknowledgementIsCompletion: false } : {}),
    helperGoneNs: bundle.helperGoneNs, helperGoneBeforeInputFulfillment: true, beforeImageSha256, afterImageSha256,
    independentPixelsVerified: false, physicalDisplayVerified: false, publication: false };
  await privateWrite('client-receipt.json', receipt);
  emit({ kind: 'finished', success: true });
} catch (error) {
  await privateWrite('client-failure-private.json', { success: false, phase: settled ? 'post-settlement' : 'pre-settlement', error: String(error.message), inputReturnedNs, stopReturnedNs, settlementObserverFailed });
  emit({ kind: 'failed', success: false, phase: settled ? 'post-settlement' : 'pre-settlement' });
  process.exitCode = 1;
} finally {
  await cleanupMacActiveClient({ abort: () => abort.abort(), pending: pending?.catch(() => {}),
    stopPending: stopPending?.catch(() => {}), close, closeLines: () => lines.close() });
}
