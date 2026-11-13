// Real public gateway approval lifecycle against an unchanged packed plugin.
// The fixture wrapper captures invocation parameters and injects explicit faults only;
// all authority, preparation and dispatch remain in the packed production implementation.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open, realpath, access, rename, symlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const [rootArg, hostArg, packArg] = process.argv.slice(2);
assert.ok(rootArg && hostArg && packArg, 'root, pinned host and extracted package are required');
let root = resolve(rootArg);
const host = await realpath(hostArg), packed = await realpath(packArg);
await mkdir(root, { recursive: true, mode: 0o700 }); root = await realpath(root);
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(100); } throw last ?? new Error('Qualification condition timed out'); }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pkg = JSON.parse(await readFile(join(host, 'package.json'), 'utf8'));
assert.ok(['2026.4.26', '2026.11.3'].includes(pkg.version));
const hostRequire = createRequire(join(host, 'package.json')), WebSocket = hostRequire('ws');
const callId = name => `call${name.replace(/[^a-zA-Z0-9]/g, '')}`;
const cases = new Map(), events = [], calls = [], pending = new Map();
const model = createServer(async (req, res) => {
  try {
    let input = ''; for await (const chunk of req) input += chunk;
    const body = JSON.parse(input), messages = body.messages ?? [];
    const index = messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('SDK_AUTH_CASE:'));
    const name = JSON.stringify(messages[index]?.content).match(/SDK_AUTH_CASE:([a-z0-9-]+)/)?.[1];
    const plan = cases.get(name); assert.ok(plan, 'Known local model scenario');
    await save(`${name}-model-inventory.json`, { tools: body.tools, model: body.model });
    const names = (body.tools ?? []).map(tool => tool.function?.name);
    plan.invokedTool = names.includes(plan.tool) ? plan.tool : names.includes('dispatch_action') ? 'dispatch_action' : undefined;
    assert.ok(plan.invokedTool, 'Requested tool or public dispatcher must be model-visible');
    const results = messages.slice(index + 1).filter(message => message.role === 'tool');
    if (results.length) await save(`${name}-provider-results.json`, results);
    calls.push({ name, finished: results.length > 0 });
    assert.ok(calls.filter(call => call.name === name).length <= 3, 'Bounded model sequence');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chatcmpl-${name}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    chunk(results.length ? { content: 'Fixture complete.' } : { tool_calls: [{ index: 0, id: callId(name), type: 'function', function: { name: plan.invokedTool, arguments: JSON.stringify(plan.invokedTool === 'dispatch_action' ? { id: plan.tool, args: plan.args } : plan.args) } }] });
    chunk({}, results.length ? 'stop' : 'tool_calls'); res.end('data: [DONE]\n\n');
  } catch (error) { await save('model-error.json', { error: String(error) }); res.writeHead(500); res.end('{}'); }
});
await listen(model);
const reservation = createServer(); await listen(reservation); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const workspace = join(root, 'workspace'), agentDir = join(root, 'state/agents/computer-use/agent'), token = randomBytes(24).toString('hex');
await mkdir(workspace); await mkdir(join(root, 'harness'));
const wrapper = `import plugin from './index.ts';\nimport { appendFileSync, realpathSync } from 'node:fs';\nimport { createRequire } from 'node:module';\nconst loadedSdk=createRequire(${JSON.stringify(join(packed, 'package.json'))}).resolve('openclaw/plugin-sdk/plugin-entry');\nappendFileSync(${JSON.stringify(join(root, 'loaded-sdk.jsonl'))},JSON.stringify({host:${JSON.stringify(host)},sdkEntry:realpathSync(loadedSdk)})+'\\n');\nexport default {...plugin, register(api){plugin.register({...api,registerTool(factory, options){api.registerTool(ctx=>{appendFileSync(${JSON.stringify(join(root, 'factory-scopes.jsonl'))},JSON.stringify({agentId:ctx.agentId,sessionKey:ctx.sessionKey,workspaceDir:ctx.workspaceDir,keys:Object.keys(ctx)})+'\\n',{mode:0o600});const tool=factory(ctx);return {...tool,async execute(id,params,signal){appendFileSync(${JSON.stringify(join(root, 'invocations.jsonl'))},JSON.stringify({id,params,ctx})+'\\n',{mode:0o600});if(params.reason==='fixture-mutate')params={...params,content:'mutated'};return tool.execute(id,params,signal);}}},options);}})}};\n`;
await symlink(host, join(root, 'harness/openclaw-host'));
await mkdir(join(root, 'harness/node_modules')); await symlink(host, join(root, 'harness/node_modules/openclaw'));
await mkdir(join(packed, 'node_modules'), { recursive: true }); await symlink(host, join(packed, 'node_modules/openclaw'));
const sdkEntry = createRequire(join(packed, 'package.json')).resolve('openclaw/plugin-sdk/plugin-entry');
assert.ok((await realpath(sdkEntry)).startsWith(host + '/'), 'Packed plugin resolves the selected actual host SDK');
await save('sdk-resolution.json', { host, hostVersion: pkg.version, sdkEntry: await realpath(sdkEntry), sdkSha256: createHash('sha256').update(await readFile(sdkEntry)).digest('hex'), packed, ancestorFallback: false });
await writeFile(join(packed, 'qualification-wrapper.ts'), wrapper);
await writeFile(join(root, 'harness/openclaw.plugin.json'), await readFile(join(packed, 'openclaw.plugin.json')));
await writeFile(join(root, 'harness/package.json'), JSON.stringify({ name: '@fixture/sdk-authorization', version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.ts'] } }));
const adapter = join(root, 'adapter.cjs');
await writeFile(adapter, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(root, 'adapter-calls.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({ok:true}));\n`, { mode: 0o700 });
const template = JSON.parse(await readFile(join(packed, 'agents/computer-use/openclaw-agent.json'), 'utf8'));
const config = {
  gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token }, controlUi: { enabled: false } },
  logging: { file: join(root, 'gateway.jsonl'), level: 'info' }, discovery: { mdns: { mode: 'off' } }, browser: { enabled: false }, cron: { enabled: false }, canvasHost: { enabled: false }, update: { checkOnStart: false },
  plugins: { allow: ['opencoven-desktop-use'], load: { paths: [join(packed, 'qualification-wrapper.ts')] }, slots: { memory: 'none' }, entries: { 'opencoven-desktop-use': { enabled: true } } }, skills: { allowBundled: [] }, tools: { profile: 'minimal' },
  models: { mode: 'merge', providers: { qualification: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'disposable-fixture', api: 'openai-completions', models: [{ id: 'fixture', name: 'Local fixture', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  agents: { defaults: { workspace, skipBootstrap: true, model: { primary: 'qualification/fixture' }, timeoutSeconds: 420, heartbeat: { every: '0m' } }, list: [
    { id: 'computer-use', default: true, workspace, agentDir, tools: template.tools },
    { id: 'legacy', workspace, agentDir: join(root, 'state/agents/legacy/agent'), tools: { ...template.tools, allow: ['desktop_use'] } },
  ] },
};
if (pkg.version === '2026.11.3') {
  config.agents.entries = Object.fromEntries(config.agents.list.map(({ id, default: _default, ...entry }) => [id, entry]));
  delete config.agents.list; config.agents.defaults.cwd = workspace; config.agents.ownership = 'explicit'; delete config.canvasHost;
}
await save('openclaw.json', config);
const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'USER'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { OPENCLAW_STATE_DIR: join(root, 'state'), OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'), OPENCLAW_HOME: join(root, 'home'), COVEN_HOME: join(root, 'coven'), OPENCLAW_LIVE_GATEWAY: '1', OPENCLAW_LIVE_GATEWAY_PROVIDERS: 'qualification', COVEN_DESKTOP_USE_BIN: adapter });
await save('identity.json', { qualifierSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), host, hostVersion: pkg.version, packed, node: process.version, wrapperSha256: createHash('sha256').update(wrapper).digest('hex'), nativeActivity: false, provider: 'local deterministic transport', expiryMs: 300000 });
const log = await open(join(root, 'console.log'), 'w', 0o600);
const gateway = spawn(process.execPath, [join(host, 'openclaw.mjs'), 'gateway', 'run'], { env, cwd: workspace, stdio: ['ignore', log.fd, log.fd] });
let exit, socket; gateway.on('exit', (code, signal) => { exit = { code, signal }; });
try {
  await until(async () => exit || (await readFile(join(root, 'console.log'), 'utf8')).includes('[gateway] ready'), 600000);
  assert.equal(exit, undefined, `Gateway exited before readiness: ${JSON.stringify(exit)}`);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const rpc = (method, params = {}, timeoutMs = 450000) => new Promise((resolve, reject) => { const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ type: 'req', id, method, params })); });
  await new Promise((resolve, reject) => {
    socket.on('error', reject); socket.on('message', data => { const frame = JSON.parse(data); if (frame.type === 'event') { events.push(frame); if (frame.event === 'connect.challenge') rpc('connect', { minProtocol: pkg.version === '2026.11.3' ? 4 : 3, maxProtocol: pkg.version === '2026.11.3' ? 4 : 3, client: { id: 'gateway-client', version: pkg.version, platform: process.platform, mode: 'backend' }, role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals'], caps: ['tool-events', 'plugin-approvals'], auth: { token } }).then(resolve, reject); } else if (frame.type === 'res' && pending.has(frame.id)) { const waiter = pending.get(frame.id); pending.delete(frame.id); clearTimeout(waiter.timer); frame.ok ? waiter.resolve(frame.payload) : waiter.reject(new Error(JSON.stringify(frame.error))); } });
  });
  const session = 'agent:computer-use:sdk-auth'; await rpc('sessions.patch', { key: session });
  await save('effective-tools.json', await rpc('tools.effective', { sessionKey: session }));
  const http = (args, sessionKey = session, tool = 'computer_use') => new Promise((resolve, reject) => { const request = httpRequest(`http://127.0.0.1:${port}/tools/invoke`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } }); }); request.setTimeout(180000, () => request.destroy(new Error('HTTP fixture request timed out'))); request.on('error', reject); request.end(JSON.stringify({ tool, args, sessionKey })); });
  async function scenario(name, args, decision = 'allow-once', options = {}) {
    const tool = options.tool ?? 'computer_use', sessionKey = options.sessionKey ?? session, start = events.length;
    cases.set(name, { args, tool });
    const startParams = { message: `SDK_AUTH_CASE:${name}`, agentId: sessionKey.split(':')[1], sessionKey, idempotencyKey: randomUUID(), deliver: false };
    const accepted = pkg.version === '2026.11.3'
      ? await rpc('chat.send', { ...startParams, timeoutMs: 420000 })
      : await rpc('agent', { ...startParams, timeout: 420 });
    await save(`${name}-admission.json`, { method: pkg.version === '2026.11.3' ? 'chat.send' : 'agent', accepted });
    const completed = rpc('agent.wait', { runId: accepted.runId, timeoutMs: 420000 }); completed.catch(() => {});
    if (decision !== 'none') {
      const approval = await until(() => events.slice(start).find(event => event.event === 'plugin.approval.requested' && event.payload.request.toolName === tool && event.payload.request.sessionKey === sessionKey), 120000);
      await save(`${name}-approval.json`, approval.payload); await options.before?.(approval, accepted);
      if (decision !== 'expire' && decision !== 'abort') await rpc('plugin.approval.resolve', { id: approval.payload.id, decision });
    }
    const outcome = await completed; await save(`${name}-outcome.json`, outcome);
    const history = await rpc('chat.history', { sessionKey, limit: 100 }); await save(`${name}-history.json`, history);
    if (decision !== 'abort') assert.equal(outcome.status, 'ok', name);
    console.log(`Completed ${name}: ${outcome.status}`);
    return history.messages?.findLast(message => message.role === 'toolResult' && message.toolName === cases.get(name).invokedTool);
  }
  const detail = message => { const value = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')); return value.tool && value.result?.content ? JSON.parse(value.result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')) : value; };
  const noFile = path => assert.rejects(access(path), { code: 'ENOENT' });
  const request = name => ({ action: 'file-write', path: `${name}.txt`, content: 'fixture-private-content' });
  let direct;
  const directPending = http({ ...request('direct'), confirm: true }).then(value => { direct = value; });
  const directApproval = await until(() => direct || events.find(event => event.event === 'plugin.approval.requested' && event.payload.request.description.includes('direct.txt')), 120000);
  if (!direct) { await save('direct-approval.json', directApproval.payload); await rpc('plugin.approval.resolve', { id: directApproval.payload.id, decision: 'deny' }); }
  await directPending; await save('direct-invocation.json', direct);
  assert.ok(direct.status === 403 || (direct.status === 200 && direct.body.result.details.status === 'needsApproval'), JSON.stringify(direct)); await noFile(join(workspace, 'direct.txt'));
  const allowed = await scenario('allowed', request('allowed')); assert.equal(detail(allowed).status, 'success');
  assert.doesNotMatch(JSON.stringify(allowed), /_desktopApproval/, 'Private continuation is absent from final tool output');
  assert.doesNotMatch(await readFile(join(root, 'allowed-provider-results.json'), 'utf8'), /_desktopApproval/, 'Private continuation is absent from provider tool results');
  assert.equal(await readFile(join(workspace, 'allowed.txt'), 'utf8'), 'fixture-private-content');
  const invocation = (await readFile(join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.params.path?.endsWith('/allowed.txt') && entry.params._desktopApproval);
  assert.ok(invocation.params._desktopApproval, 'Actual allowed host invocation carries a private continuation');
  const replay = await http(invocation.params); assert.ok(replay.status === 403 || (replay.status === 200 && replay.body.result.details.success === false)); await save('replay.json', replay);
  await scenario('denied', request('denied'), 'deny'); await noFile(join(workspace, 'denied.txt'));
  const mutated = await scenario('mutated', { ...request('mutated'), reason: 'fixture-mutate' }); assert.equal(detail(mutated).status, 'needsApproval'); await noFile(join(workspace, 'mutated.txt'));
  await scenario('forged', { ...request('forged'), _desktopApproval: invocation.params._desktopApproval }, 'none'); await noFile(join(workspace, 'forged.txt'));
  const parent = join(workspace, 'parent'), foreign = join(root, 'foreign'); await mkdir(parent); await mkdir(foreign);
  const rebound = await scenario('rebound', { ...request('unused'), path: 'parent/out.txt' }, 'allow-once', { before: async () => { await rename(parent, join(workspace, 'old')); await symlink(foreign, parent); } });
  assert.equal(detail(rebound).status, 'needsApproval'); await noFile(join(foreign, 'out.txt'));
  const stopped = await scenario('pending-stop', request('pending-stop'), 'allow-once', { before: async () => { const stop = await http({ action: 'stop' }); await save('pending-stop-request.json', stop); assert.equal(stop.body.result.details.cancellationRequested, 1); } });
  assert.equal(detail(stopped).status, 'needsApproval'); await noFile(join(workspace, 'pending-stop.txt'));
  await scenario('pending-abort', request('pending-abort'), 'abort', { before: async (_approval, accepted) => { await rpc('chat.abort', { sessionKey: session, runId: accepted.runId }); } }); await noFile(join(workspace, 'pending-abort.txt'));
  const legacySession = 'agent:legacy:sdk-auth'; await rpc('sessions.patch', { key: legacySession });
  const legacy = await scenario('legacy-input', { action: 'type', text: 'fixture' }, 'allow-once', { sessionKey: legacySession, tool: 'desktop_use' });
  assert.equal(detail(legacy).status, 'success'); assert.match(detail(legacy).deprecation, /desktop_use.*computer_use.*type.*type-text/);
  console.log('Waiting for actual five-minute gateway approval expiry.');
  const started = Date.now(); await scenario('expired', request('expired'), 'expire');
  assert.ok(Date.now() - started >= 299000); await noFile(join(workspace, 'expired.txt'));
  const expiry = JSON.parse(await readFile(join(root, 'expired-approval.json'), 'utf8')); assert.equal(expiry.expiresAtMs - expiry.createdAtMs, 300000);
  const audit = await readFile(join(dirname(agentDir), 'audit/computer-use.jsonl'), 'utf8'); assert.doesNotMatch(audit, /fixture-private-content|_desktopApproval/);
  const scopes = (await readFile(join(root, 'factory-scopes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(scopes.length > 0 && scopes.every(scope => scope.workspaceDir === workspace), 'Effective inventory, HTTP and agent factories retain one explicit canonical workspace');
  await save('scope-proof.json', { canonicalWorkspace: workspace, factories: scopes, allMatch: true });
  await save('complete.json', { success: true, hostVersion: pkg.version, actualPackedPlugin: packed, allow: true, deny: true, expiry: true, changedParams: true, canonicalRebinding: true, forgedReferences: true, replay: true, pendingStop: true, abortSignal: true, legacy: true, directInvocationMigration: 'direct factory needsApproval; HTTP invokes real host hook and requires actual resolution, confirm has no authority', nativeActivity: false });
} catch (error) { await save('failure.json', { message: String(error), stack: error.stack }); throw error; }
finally {
  await save('events.json', events); await save('model-calls.json', calls);
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  socket?.terminate(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  if (!exit) gateway.kill('SIGTERM'); await until(() => exit, 10000).catch(() => gateway.kill('SIGKILL')); await log.close();
}
