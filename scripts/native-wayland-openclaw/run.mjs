// Opt-in native fixture qualification. The default is read-only preflight.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { preflight, readJson } from '../native-openclaw-acceptance/preflight.mjs';
import { proveProviderImage } from './provider-image.mjs';
import { readOwnedFixture } from './fixture-observation.mjs';
import { proveTextEffect, proveNoEffect } from './effect-proof.mjs';
import { providerToolCallId, assertProviderLease, acceptProviderStep } from './run-contract.mjs';
import { cancellationScope, observeOwnedGateway, stopOwnedGateway } from '../native-openclaw-acceptance/lifecycle.mjs';
import { verifyHostRuntimeStage, runtimeStageEnvironment } from '../native-openclaw-acceptance/runtime-stage.mjs';
import { removeOwnedPrivateFiles } from '../native-openclaw-acceptance/private-files.mjs';
import { safeFailure } from '../native-openclaw-acceptance/failure.mjs';
import { assertClickResult as assertInputResult } from '../native-openclaw-acceptance/click-result.mjs';

let descriptor, identity, native, root;
try {
  const [descriptorPath, mode = '--preflight', outputPath] = process.argv.slice(2);
  assert.ok(descriptorPath && ['--preflight', '--run-owned-fixture'].includes(mode));
  descriptor = await readJson(resolve(descriptorPath)); native = mode === '--run-owned-fixture';
  assert.equal(descriptor.platform, 'linux'); assert.equal(process.platform, 'linux');
  assert.ok(descriptor.wayland && [1,2].includes(descriptor.wayland.scale));
  identity = await preflight(descriptor, { runNative: native });
  if (!native) {
    console.log(JSON.stringify({ schemaVersion:1, preflightOnly:true, nativeExecuted:false, sourceCommit:identity.sourceCommit, packageSha256:identity.packageSha256, adapterSha256:identity.adapterSha256, installedPackageFilesChecked:identity.installedPackageFilesChecked, hostVersion:identity.hostVersion, scale:descriptor.wayland.scale })); process.exit(0);
  }
  assert.equal(process.env.NATIVE_OWNED_DISPOSABLE_DISPLAY, 'yes'); assert.equal(process.env.XDG_SESSION_TYPE, 'wayland');
  for (const [key,value] of Object.entries({ XDG_RUNTIME_DIR:descriptor.wayland.runtimeRoot, SWAYSOCK:descriptor.wayland.swaySocket, WAYLAND_DISPLAY:descriptor.wayland.waylandDisplay, PATH:descriptor.wayland.helperSearchPath })) assert.equal(process.env[key],value);
  assertProviderLease(descriptor, readOwnedFixture(descriptor.wayland));
  assert.ok(outputPath); root = resolve(outputPath); await mkdir(root,{mode:0o700});
} catch {
  console.error(JSON.stringify({code:'WAYLAND_PROVIDER_PREFLIGHT_REJECTED'})); process.exit(1);
}
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
const fixture = () => {
  control.check(); const observed = readOwnedFixture(descriptor.wayland);
  assertProviderLease(descriptor, observed); control.check(); return observed;
};
const plannedText = `owned-${randomBytes(12).toString('hex')}`;
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const plans = new Map(), images = [], approvals = [], events = [], activeRuns = new Set();
const seenObservationIds = new Set();
let phase = 'fixture-precondition', providerPhase = 'request-method', providerFailure;
let modelFailure = false, gateway, gatewayExit, socket, rpc, reservation, gatewayObserver;
const pending = new Map();
const {selected: _selected, hostRuntimeStage: _stage, ...publicIdentity} = identity;
const receipt = { schemaVersion: 1, success: false, identity:publicIdentity, scale:descriptor.wayland.scale, providerHttpRequests: 0, actualProviderRequest: false, nativeExecuted: false, effectVerified: false, publicRelease: false, physicalDisplayVerified: false, decisionSource: 'scripted-operator-through-actual-OpenClaw-approval-RPC', captureEngine:'grim', cases: [] };
const model = createServer(async (req, res) => {
  try {
    providerPhase = 'request-method'; receipt.providerHttpRequests++;
    control.check();
    assert.equal(req.method, 'POST');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; assert.ok(size <= 32 * 1024 * 1024, 'Bounded provider request required'); chunks.push(chunk); }
    providerPhase = 'request-json';
    const body = JSON.parse(Buffer.concat(chunks));
    const messageText = value => typeof value === 'string' ? value : (value ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const userIndex = body.messages.findLastIndex(message => message.role === 'user' && /WAYLAND21_CASE:/.test(messageText(message.content)));
    const marker = messageText(body.messages[userIndex]?.content).match(/WAYLAND21_CASE:([a-z0-9-]+)/)?.[1];
    providerPhase = 'case-marker';
    const plan = plans.get(marker); assert.ok(plan, 'Known qualification case required');
    providerPhase = 'tool-inventory';
    assert.deepEqual(body.tools.map(tool => tool.function.name), ['computer_use']);
    const results = body.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
    assert.ok(plan.responses++ < 3, 'Do not retry native actions');
    const step = acceptProviderStep(plan, results.length);
    let args, id, complete = false;
    providerPhase = 'tool-results';
    if (results.length === 0) {
      const current = fixture(); assertProviderLease(descriptor,current,plan.before);
      plan.scopeBefore = current.snapshot; plan.captureStartedAtMs = Date.now();
      args = {action:'screenshot',mode:'screen',format:plan.format,annotate:false}; id = providerToolCallId(marker,'capture');
    } else if (results.length === 1) {
      providerPhase = 'wire-image-proof';
      const current = fixture(); assertProviderLease(descriptor,current,plan.before);
      const proof = await proveProviderImage(body,marker,{sharp,fixture:plan.before.fixture,before:plan.scopeBefore,after:current.snapshot,format:plan.format,expectedCallId:providerToolCallId(marker,'capture'),captureStartedAtMs:plan.captureStartedAtMs,seenObservationIds});
      assertProviderLease(descriptor,fixture(),plan.before);
      images.push({marker,...proof}); plan.proof = proof; receipt.actualProviderRequest = true; receipt.nativeExecuted = true;
      if (step === 'complete') complete = true;
      else { args = {action:'type-text',text:plannedText,...(plan.denied?{confirm:true}:{})}; id = providerToolCallId(marker,'type'); }
    } else {
      assert.equal(results.length, 2, 'Exactly one capture and one type result required');
      assert.equal(results[1].tool_call_id, providerToolCallId(marker, 'type'));
      const status = JSON.parse(messageText(results[1].content));
      assertInputResult(status, { denied: plan.denied });
      complete = true;
    }
    control.check();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, reason = null) => res.write(`data: ${JSON.stringify({ id: `native21-${marker}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    chunk(complete ? { content: 'Native fixture case complete.' } : { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'computer_use', arguments: JSON.stringify(args) } }] });
    chunk({}, complete ? 'stop' : 'tool_calls'); res.end('data: [DONE]\n\n');
  } catch (error) {
    providerFailure ??= safeFailure(error, providerPhase);
    modelFailure = true;
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NATIVE21_PROVIDER_PROOF_FAILED' } }));
  }
});
let log;
try {
  await control.wait((async () => {
  const initial = fixture();
  proveTextEffect({before:initial.control,after:initial.control,text:plannedText,decision:'deny'});
  await control.setup(() => listen(model));
  reservation = createServer(); await control.setup(() => listen(reservation)); const port = reservation.address().port;
  await control.setup(async () => { await new Promise(resolve => reservation.close(resolve)); reservation = undefined; });
  const token = randomBytes(24).toString('hex');
  const workspace = join(root,'workspace'); await control.setup(()=>mkdir(workspace)); await control.setup(()=>mkdir(join(root,'home')));
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
  await control.setup(() => save('openclaw.json', config));
  await control.setup(async () => { log = await open(join(root, 'console.log'), 'wx', 0o600); });
  const env = Object.fromEntries(['PATH','TMPDIR','LANG','USER'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  if (descriptor.platform === 'linux') for (const key of ['DISPLAY','XDG_SESSION_TYPE','XDG_RUNTIME_DIR','WAYLAND_DISPLAY','SWAYSOCK']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { HOME:join(root,'home'), XDG_CONFIG_HOME:join(root,'home/.config'), XDG_CURRENT_DESKTOP:'sway', OPENCLAW_IMAGE_BACKEND: 'sharp', OPENCLAW_STATE_DIR: join(root, 'state'), OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'), OPENCLAW_HOME: join(root, 'home'), OPENCLAW_LIVE_GATEWAY: '1', OPENCLAW_LIVE_GATEWAY_PROVIDERS: 'qualification', COVEN_DESKTOP_USE_BIN: identity.selected.adapter, COVEN_HOME: join(root, 'coven-home') });
  const stage = await control.setup(() => verifyHostRuntimeStage(descriptor.hostRuntimeStage, { host: identity.selected.host, hostVersion: descriptor.hostVersion, officialHostVerified: Boolean(identity.hostInventory) }));
  assert.deepEqual(stage, identity.hostRuntimeStage, 'Selected stage must remain unchanged before gateway spawn');
  Object.assign(env, runtimeStageEnvironment(stage));
  env.PATH = descriptor.wayland.helperSearchPath;
  control.check();
  phase = 'gateway-spawn';
  gateway = spawn(process.execPath, [join(identity.selected.host, 'openclaw.mjs'), 'gateway', 'run'], { cwd: workspace, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  gateway.on('exit', (code, signal) => { gatewayExit = { code, signal }; });
  gateway.on('error', () => { gatewayExit = { code: 'SPAWN_FAILED' }; });
  gatewayObserver = observeOwnedGateway(gateway);
  phase = 'gateway-readiness';
  await until(async () => { assert.equal(gatewayExit, undefined, 'Owned gateway exited'); return (await readFile(join(root, 'console.log'), 'utf8')).includes('[gateway] ready'); }, 600_000);
  control.check();
  phase = 'rpc-connect';
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
  phase = 'session-create';
  const session = 'agent:computer-use:wayland21'; await rpc('sessions.patch', { key: session });
  phase = 'effective-tools';
  const inventory = await rpc('tools.effective', { sessionKey: session });
  assert.deepEqual(inventory.groups.flatMap(group => group.tools.map(tool => tool.id)), ['computer_use']);
  async function runCase(marker, { denied = false, captureOnly = false, format = 'png' } = {}) {
    control.check();
    const before = await fixture();
    plans.set(marker, { before, denied, captureOnly, format, responses: 0, nextResultCount:0 }); const eventStart = events.length;
    phase = 'agent-start';
    const accepted = await rpc('agent', { message: `WAYLAND21_CASE:${marker}`, agentId: 'computer-use', sessionKey: session, idempotencyKey: randomUUID(), deliver: false, timeout: 180 });
    activeRuns.add(accepted.runId);
    const completed = rpc('agent.wait', { runId: accepted.runId, timeoutMs: 180_000 }); completed.catch(() => {});
    if (!captureOnly) {
      phase = 'approval-request';
      const approval = await until(() => {
        assert.equal(modelFailure, false, 'Provider proof failed before input');
        return events.slice(eventStart).find(event => event.event === 'plugin.approval.requested' && event.payload.request.toolCallId === providerToolCallId(marker, 'type'));
      });
      assertProviderLease(descriptor,fixture(),before);
      control.check();
      await rpc('plugin.approval.resolve', { id: approval.payload.id, decision: denied ? 'deny' : 'allow-once' });
      approvals.push({ marker, toolCallId: providerToolCallId(marker, 'type'), decision: denied ? 'deny' : 'allow-once', actualHostApproval: true });
    }
    phase = 'agent-completion';
    const outcome = await completed; activeRuns.delete(accepted.runId);
    assert.equal(outcome.status, 'ok'); assert.equal(modelFailure, false);
    let after, effect;
    if (!captureOnly && !denied) {
      after = await until(() => {
        const current = fixture(), value = current.control, prior = before.control;
        assert.equal(value.fixtureIdentity,prior.fixtureIdentity); assert.equal(value.clickCount,prior.clickCount); assert.equal(value.scrollOffset,prior.scrollOffset);
        assert.ok(value.textLength<=plannedText.length && value.keyCount<=plannedText.length);
        if(value.textLength!==plannedText.length || value.keyCount!==plannedText.length)return false;
        effect=proveTextEffect({before:prior,after:value,text:plannedText,decision:'allow'}); return current;
      },5_000);
    } else {
      const end = Date.now()+250;
      do { after=fixture(); effect=proveNoEffect({before:before.control,after:after.control,decision:denied?'deny':'capture-only'}); await delay(25); } while(Date.now()<end);
      after=fixture(); effect=proveNoEffect({before:before.control,after:after.control,decision:denied?'deny':'capture-only'});
    }
    assert.equal(plans.get(marker).responses,captureOnly?2:3);
    assert.equal(plans.get(marker).nextResultCount,null);
    receipt.cases.push({marker,denied,captureOnly,format,effect,actualProviderResponses:plans.get(marker).responses,noEffectObservationMs:captureOnly||denied?250:undefined});
  }
  await runCase('allowed'); await runCase('allowed-after',{captureOnly:true});
  await runCase('forged-confirm-denied',{denied:true,format:'jpg'}); await runCase('denied-after',{captureOnly:true,format:'jpg'});
  phase = 'audit-proof';
  const audits = await readFile(join(root, 'state/agents/computer-use/audit/computer-use.jsonl'), 'utf8');
  assert.doesNotMatch(audits, /data:image|base64|"(?:nonce|mac|approvalId|screenshot_raw)"/);
  const records = audits.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(record=>record.action==='type-text'&&record.result.status==='success').length,1);
  assert.ok(!audits.includes(plannedText),'Private fixture text must not enter audit');
  control.check();
  receipt.success = true; receipt.effectVerified = true; receipt.auditPayloadsAbsent = true; receipt.images = images; receipt.approvals = approvals;
  })());
} catch (error) {
  receipt.failureDiagnostic = { ...safeFailure(error, phase), providerFailure, gatewayExit };
  receipt.failureCode = 'NATIVE21_ACCEPTANCE_INCOMPLETE';
  receipt.images = images; receipt.approvals = approvals;
  process.exitCode = 1;
} finally {
  try {
  control.abort();
  await control.settleSetup();
  const observation = gatewayObserver?.stop() ?? { known: [], inspectionFailed: false };
  if (observation.inspectionFailed) receipt.cleanupInspectionFailed = true;
  const known = observation.known;
  if (rpc && socket?.readyState === WebSocket.OPEN) for (const runId of activeRuns) await rpc('sessions.abort', { key:'agent:computer-use:wayland21', runId }, 5_000, true).catch(() => {});
  socket?.terminate();
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('NATIVE21_CLOSED')); } pending.clear();
  try { receipt.gatewayCleanup = await stopOwnedGateway(gateway, { known }); }
  catch { receipt.gatewayCleanup = { allReaped: false, inspectionFailed: true }; }
  receipt.gatewayReaped = receipt.gatewayCleanup.allReaped && !receipt.cleanupInspectionFailed;
  if (!receipt.gatewayReaped) { receipt.success = false; process.exitCode = 1; }
  if (reservation) await new Promise(resolve => reservation.close(resolve));
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await log?.close();
  for (const name of ['console.log','gateway.jsonl']) {
    try {
      const text = await readFile(join(root, name), 'utf8');
      assert.doesNotMatch(text, /data:image\/(png|jpeg);base64,|"screenshot_raw"/);
      assert.ok(!text.includes(plannedText),'Private fixture text must not enter diagnostics');
    } catch (error) { if (error.code !== 'ENOENT') { receipt.success = false; receipt.diagnosticPrivacyFailure = true; process.exitCode = 1; } }
  }
  // Only the fresh root's known private files are removed; retain metadata receipts.
  if (!await removeOwnedPrivateFiles(root)) { receipt.success = false; receipt.privateCleanupFailed = true; process.exitCode = 1; }
  await save('receipt.json', receipt);
  console.log(JSON.stringify({ success: receipt.success, actualProviderRequest: receipt.actualProviderRequest, effectVerified: receipt.effectVerified, caseCount:receipt.cases.length,scale:descriptor.wayland.scale }));
  } finally { control.dispose(); }
}
