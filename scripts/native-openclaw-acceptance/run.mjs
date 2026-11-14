// Opt-in native fixture qualification. The default is read-only preflight.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { preflight, readJson } from './preflight.mjs';
import { proveWireObservation } from './wire-proof.mjs';
import { assertFixtureLease } from './fixture-lease.mjs';
import { cancellationScope, snapshotOwnedGateway, stopOwnedGateway } from './lifecycle.mjs';

const [descriptorPath, mode = '--preflight', outputPath] = process.argv.slice(2);
assert.ok(descriptorPath && ['--preflight', '--run-owned-fixture'].includes(mode), 'Usage: run.mjs descriptor.json [--preflight | --run-owned-fixture fresh-private-output]');
const descriptor = await readJson(resolve(descriptorPath));
const native = mode === '--run-owned-fixture';
const identity = await preflight(descriptor, { runNative: native });
if (!native) { console.log(JSON.stringify(identity)); process.exit(0); }
assert.ok(outputPath, 'A fresh private output directory is required');
const root = resolve(outputPath);
await mkdir(root, { mode: 0o700 }); // Deliberately refuse an existing directory.
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { control.check(); const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('NATIVE21_CONDITION_TIMEOUT');
}
const hostRequire = createRequire(join(identity.selected.host, 'package.json'));
const WebSocket = hostRequire('ws'), sharp = hostRequire('sharp');
assert.equal(hostRequire('sharp/package.json').version, '0.34.5');
const control = cancellationScope(Date.parse(descriptor.fixtureLease.expiresAt));
const fixture = async () => {
  control.check();
  const state = await readJson(identity.selected.fixtureState);
  assert.equal(state.ready, true); assert.equal(state.pid, descriptor.fixturePid); assert.equal(state.windowNumber, descriptor.fixtureWindowId);
  assert.ok(Date.parse(descriptor.fixtureLease.expiresAt) > Date.now(), 'Fixture lease expired');
  return state;
};
const target = descriptor.platform === 'darwin' ? { app: descriptor.fixtureBundleId, windowId: descriptor.fixtureWindowId } : {};
const captureArgs = { action: 'inspect', ...target, mode: descriptor.platform === 'darwin' ? 'window' : 'frontmost', annotate: false };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const plans = new Map(), images = [], approvals = [], events = [], activeRuns = new Set();
const seenObservationIds = new Set();
let modelFailure = false, gateway, gatewayExit, socket, rpc;
const pending = new Map();
const receipt = { schemaVersion: 1, success: false, identity, actualProviderRequest: false, nativeExecuted: false, effectVerified: false, publicRelease: false, physicalDisplayVerified: false, decisionSource: 'scripted-operator-through-actual-OpenClaw-approval-RPC', captureEngine: descriptor.captureEngine ?? 'auto', cases: [] };
const model = createServer(async (req, res) => {
  try {
    control.check();
    assert.equal(req.method, 'POST');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; assert.ok(size <= 32 * 1024 * 1024, 'Bounded provider request required'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks));
    const messageText = value => typeof value === 'string' ? value : (value ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const userIndex = body.messages.findLastIndex(message => message.role === 'user' && /NATIVE21_CASE:/.test(messageText(message.content)));
    const marker = messageText(body.messages[userIndex]?.content).match(/NATIVE21_CASE:([a-z0-9-]+)/)?.[1];
    const plan = plans.get(marker); assert.ok(plan, 'Known qualification case required');
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['computer_use']);
    const results = body.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
    assert.ok(plan.responses++ < 3, 'Do not retry native actions');
    let args, id, complete = false;
    if (results.length === 0) {
      assertFixtureLease(descriptor, await fixture(), plan.before);
      plan.captureStartedAtMs = Date.now();
      args = captureArgs; id = `native21-${marker}-capture`;
    }
    else if (results.length === 1) {
      const proof = await proveWireObservation(body, marker, { sharp, fixture: plan.before, expectedCallId: `native21-${marker}-capture`, captureStartedAtMs: plan.captureStartedAtMs, seenObservationIds });
      assert.equal(proof.actualScope?.mode, descriptor.platform === 'darwin' ? 'window' : 'frontmost', 'Native capture must retain requested fixture scope');
      assertFixtureLease(descriptor, await fixture(), plan.before);
      images.push({ marker, ...proof }); plan.proof = proof;
      receipt.actualProviderRequest = true; receipt.nativeExecuted = true;
      if (plan.captureOnly) complete = true;
      else { args = { action: 'click', ...target, coords: proof.desktopPoint.map(Math.round).join(','), ...(plan.denied ? { confirm: true } : {}) }; id = `native21-${marker}-click`; }
    } else {
      assert.equal(results.length, 2, 'Exactly one capture and one click result required');
      assert.equal(results[1].tool_call_id, `native21-${marker}-click`);
      const status = JSON.parse(messageText(results[1].content));
      assert.equal(status.status, plan.denied ? 'error' : 'success');
      assert.equal(status.success, !plan.denied);
      if (plan.denied) assert.equal(status.result?.error ?? status.error, 'Denied by user');
      complete = true;
    }
    control.check();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, reason = null) => res.write(`data: ${JSON.stringify({ id: `native21-${marker}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    chunk(complete ? { content: 'Native fixture case complete.' } : { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'computer_use', arguments: JSON.stringify(args) } }] });
    chunk({}, complete ? 'stop' : 'tool_calls'); res.end('data: [DONE]\n\n');
  } catch {
    modelFailure = true;
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NATIVE21_PROVIDER_PROOF_FAILED' } }));
  }
});
let log;
try {
  await control.wait((async () => {
  assert.equal((await fixture()).clicks, 0, 'A fresh red fixture is required for an observed red-to-green transition');
  await listen(model);
  const reservation = createServer(); await listen(reservation); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const token = randomBytes(24).toString('hex');
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const template = await readJson(join(identity.selected.pluginRoot, 'agents/computer-use/openclaw-agent.json'));
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token }, controlUi: { enabled: false } },
    logging: { file: join(root, 'gateway.jsonl'), level: 'info' },
    discovery: { mdns: { mode: 'off' } }, browser: { enabled: false }, cron: { enabled: false }, canvasHost: { enabled: false }, update: { checkOnStart: false },
    plugins: { allow: ['opencoven-desktop-use'], load: { paths: [identity.selected.pluginRoot] }, slots: { memory: 'none' }, entries: { 'opencoven-desktop-use': { enabled: true, config: { actionProfile: 'desktop-only' } } } },
    skills: { allowBundled: [] }, tools: { profile: 'minimal' },
    models: { mode: 'merge', providers: { qualification: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'disposable-local-qualification', api: 'openai-completions', models: [{ id: 'fixture', name: 'Local native acceptance transport', reasoning: false, input: ['text','image'], contextWindow: 65_536, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
    agents: { defaults: { workspace, skipBootstrap: true, model: { primary: 'qualification/fixture' }, timeoutSeconds: 180, heartbeat: { every: '0m' } }, list: [{ id: 'computer-use', default: true, workspace, agentDir: join(root, 'state/agents/computer-use/agent'), tools: template.tools }] }
  };
  await save('openclaw.json', config);
  log = await open(join(root, 'console.log'), 'wx', 0o600);
  const env = Object.fromEntries(['PATH','TMPDIR','LANG','USER'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  if (descriptor.platform === 'linux') for (const key of ['DISPLAY','XDG_SESSION_TYPE','XDG_RUNTIME_DIR','WAYLAND_DISPLAY','SWAYSOCK']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { OPENCLAW_IMAGE_BACKEND: 'sharp', OPENCLAW_STATE_DIR: join(root, 'state'), OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'), OPENCLAW_HOME: join(root, 'home'), OPENCLAW_LIVE_GATEWAY: '1', OPENCLAW_LIVE_GATEWAY_PROVIDERS: 'qualification', COVEN_DESKTOP_USE_BIN: identity.selected.adapter, COVEN_HOME: join(root, 'coven-home') });
  if (descriptor.captureEngine) env.PEEKABOO_CAPTURE_ENGINE = descriptor.captureEngine;
  if (descriptor.helperExecutable) env.PATH = `${dirname(descriptor.helperExecutable)}:${env.PATH}`;
  gateway = spawn(process.execPath, [join(identity.selected.host, 'openclaw.mjs'), 'gateway', 'run'], { cwd: workspace, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  gateway.on('exit', (code, signal) => { gatewayExit = { code, signal }; });
  gateway.on('error', () => { gatewayExit = { code: 'SPAWN_FAILED' }; });
  await until(async () => { assert.equal(gatewayExit, undefined, 'Owned gateway exited'); return (await readFile(join(root, 'console.log'), 'utf8')).includes('[gateway] ready'); }, 600_000);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  rpc = (method, params = {}, timeout = 195_000, cleanup = false) => new Promise((resolve, reject) => {
    if (!cleanup) control.check();
    const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error('NATIVE21_RPC_TIMEOUT')); }, timeout);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NATIVE21_CONNECT_TIMEOUT')), 30_000);
    socket.once('error', reject);
    socket.on('message', data => {
      const frame = JSON.parse(data);
      if (frame.type === 'event') {
        events.push(frame);
        if (frame.event === 'connect.challenge') rpc('connect', { minProtocol: 3, maxProtocol: 3, client: { id: 'gateway-client', version: descriptor.hostVersion, platform: process.platform, mode: 'backend' }, role: 'operator', scopes: ['operator.admin','operator.read','operator.write','operator.approvals'], caps: ['tool-events'], auth: { token } }).then(value => { clearTimeout(timer); resolve(value); }, reject);
      } else if (frame.type === 'res' && pending.has(frame.id)) { const waiter = pending.get(frame.id); clearTimeout(waiter.timer); pending.delete(frame.id); frame.ok ? waiter.resolve(frame.payload) : waiter.reject(new Error('NATIVE21_RPC_REJECTED')); }
    });
  });
  assert.equal(hello.server.version, descriptor.hostVersion);
  const session = 'agent:computer-use:native21'; await rpc('sessions.patch', { key: session });
  const inventory = await rpc('tools.effective', { sessionKey: session });
  assert.deepEqual(inventory.groups.flatMap(group => group.tools.map(tool => tool.id)), ['computer_use']);
  async function runCase(marker, { denied = false, captureOnly = false } = {}) {
    control.check();
    const before = await fixture();
    plans.set(marker, { before, denied, captureOnly, responses: 0 }); const eventStart = events.length;
    const accepted = await rpc('agent', { message: `NATIVE21_CASE:${marker}`, agentId: 'computer-use', sessionKey: session, idempotencyKey: randomUUID(), deliver: false, timeout: 180 });
    activeRuns.add(accepted.runId);
    const completed = rpc('agent.wait', { runId: accepted.runId, timeoutMs: 180_000 }); completed.catch(() => {});
    if (!captureOnly) {
      const approval = await until(() => {
        assert.equal(modelFailure, false, 'Provider proof failed before input');
        return events.slice(eventStart).find(event => event.event === 'plugin.approval.requested' && event.payload.request.toolCallId === `native21-${marker}-click`);
      });
      assertFixtureLease(descriptor, await fixture(), before);
      control.check();
      await rpc('plugin.approval.resolve', { id: approval.payload.id, decision: denied ? 'deny' : 'allow-once' });
      approvals.push({ marker, toolCallId: `native21-${marker}-click`, decision: denied ? 'deny' : 'allow-once', actualHostApproval: true });
    }
    const outcome = await completed; activeRuns.delete(accepted.runId);
    assert.equal(outcome.status, 'ok'); assert.equal(modelFailure, false);
    await delay(300); const after = await fixture();
    assert.equal(after.clicks, before.clicks + (captureOnly || denied ? 0 : 1), 'Observed fixture effect must match actual decision');
    assert.equal(plans.get(marker).responses, captureOnly ? 2 : 3);
    receipt.cases.push({ marker, beforeClicks: before.clicks, afterClicks: after.clicks, denied, captureOnly, actualProviderResponses: plans.get(marker).responses });
  }
  await runCase('allowed'); await runCase('allowed-after', { captureOnly: true });
  await runCase('forged-confirm-denied', { denied: true }); await runCase('denied-after', { captureOnly: true });
  const audits = await readFile(join(root, 'state/agents/computer-use/audit/computer-use.jsonl'), 'utf8');
  assert.doesNotMatch(audits, /data:image|base64|"(?:nonce|mac|approvalId|screenshot_raw)"/);
  const records = audits.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.some(record => record.action === 'click' && record.result.status === 'success'));
  control.check();
  receipt.success = true; receipt.effectVerified = true; receipt.auditPayloadsAbsent = true; receipt.images = images; receipt.approvals = approvals;
  })());
} catch {
  receipt.failureCode = 'NATIVE21_ACCEPTANCE_INCOMPLETE';
  receipt.images = images; receipt.approvals = approvals;
  process.exitCode = 1;
} finally {
  try {
  let known = [];
  try { known = snapshotOwnedGateway(gateway); } catch { receipt.cleanupInspectionFailed = true; }
  control.abort();
  if (rpc && socket?.readyState === WebSocket.OPEN) for (const runId of activeRuns) await rpc('sessions.abort', { key: 'agent:computer-use:native21', runId }, 5_000, true).catch(() => {});
  socket?.terminate();
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('NATIVE21_CLOSED')); } pending.clear();
  try { receipt.gatewayCleanup = await stopOwnedGateway(gateway, { known }); }
  catch { receipt.gatewayCleanup = { allReaped: false, inspectionFailed: true }; }
  receipt.gatewayReaped = receipt.gatewayCleanup.allReaped && !receipt.cleanupInspectionFailed;
  if (!receipt.gatewayReaped) { receipt.success = false; process.exitCode = 1; }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await log?.close();
  for (const name of ['console.log','gateway.jsonl']) {
    try {
      const text = await readFile(join(root, name), 'utf8');
      assert.doesNotMatch(text, /data:image\/(png|jpeg);base64,|"screenshot_raw"/);
    } catch (error) { if (error.code !== 'ENOENT') { receipt.success = false; receipt.diagnosticPrivacyFailure = true; process.exitCode = 1; } }
  }
  // Only the fresh root's known private files are removed; retain metadata receipts.
  for (const name of ['console.log','gateway.jsonl','openclaw.json','state','home','coven-home','workspace']) {
    try { await rm(join(root, name), { recursive: true, force: true }); }
    catch { receipt.success = false; receipt.privateCleanupFailed = true; process.exitCode = 1; }
  }
  await save('receipt.json', receipt);
  console.log(JSON.stringify({ success: receipt.success, actualProviderRequest: receipt.actualProviderRequest, effectVerified: receipt.effectVerified, caseCount: receipt.cases.length, output: root }));
  } finally { control.dispose(); }
}
