// Run from a disposable installed consumer. No repository imports or fake adapter.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createDesktopClient, resolveActionPermissions } from '@opencoven/openclaw-desktop-use/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { verifyMacIdentity } from './identity-preflight.mjs';

const surface = process.argv[2];
assert.ok(['sdk', 'mcp-modern', 'mcp-legacy'].includes(surface));
const root = await realpath(process.env.NATIVE_ACCEPTANCE_ROOT);
const adapter = await realpath(process.env.NATIVE_ACCEPTANCE_ADAPTER);
await verifyMacIdentity(root, adapter);
const python = await realpath(process.env.NATIVE_ACCEPTANCE_PYTHON);
const fixturePath = await realpath(process.env.NATIVE_ACCEPTANCE_FIXTURE_STATE);
const proofScript = await realpath(process.env.NATIVE_ACCEPTANCE_IMAGE_PROOF);
const ptyScript = await realpath(process.env.NATIVE_ACCEPTANCE_PTY);
const state = async () => JSON.parse(await readFile(fixturePath));
const initial = await state();
assert.ok(initial.ready && initial.pid > 0 && initial.windowNumber > 0);
const target = { app: 'org.opencoven.desktopuse.acceptance', windowId: initial.windowNumber };
const workspace = join(root, `${surface}-workspace`);
const privateState = join(root, `${surface}-state`);
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(privateState, { recursive: true, mode: 0o700 });
const audits = [];
let close = async () => {};
let invoke;
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('@opencoven/openclaw-desktop-use/package.json'));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
const cases = [];
if (surface === 'sdk') {
  const client = createDesktopClient({ workspaceDir: workspace, scope: { principalId: 'native-client', sessionId: surface }, adapterPath: adapter,
    actionPermissions: resolveActionPermissions({ actionProfile: 'full' }), auditSink: async event => { audits.push(event); }, approvalProvider: () => 'allowed' });
  invoke = (request, id) => client.execute(request, { callId: id });
} else {
  const config = join(root, `${surface}-config.json`);
  await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir: privateState, principalId: 'native-client', sessionId: surface, adapterPath: adapter, actionProfile: 'full' }), { mode: 0o600 });
  const { createJsonSchemaValidator } = await import(pathToFileURL(join(packageRoot, 'dist/src/mcp/schema.js')));
  const modern = surface === 'mcp-modern';
  const client = new Client({ name: 'native-acceptance', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
  const transport = new StdioClientTransport({ command: python, args: [ptyScript, 'allow', process.execPath, join(packageRoot, 'dist/examples/approval-host/main.js'), '--config', config], stderr: 'pipe', env: { PATH: process.env.PATH, TMPDIR: root, ...(process.env.PEEKABOO_CAPTURE_ENGINE ? { PEEKABOO_CAPTURE_ENGINE: process.env.PEEKABOO_CAPTURE_ENGINE } : {}) } });
  let terminalBytes = 0;
  transport.stderr?.on('data', bytes => { terminalBytes += bytes.length; });
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, manifest.version);
  assert.equal(client.getNegotiatedProtocolVersion(), modern ? '2026-07-28' : '2025-11-25');
  const discovery = await client.listTools();
  assert.deepEqual(discovery.tools.map(t => t.name), ['computer_use']);
  cases.push({ action: 'discovery', verified: true, protocol: client.getNegotiatedProtocolVersion(), canonicalActions: discovery.tools[0].inputSchema.properties.action.enum.length });
  invoke = async request => {
    const r = await client.callTool({ name: 'computer_use', arguments: request });
    return { content: r.content, details: r.structuredContent };
  };
  close = async () => { await client.close(); assert.ok(terminalBytes < 128*1024); };
}
async function call(request, suffix = request.action) {
  const current = await state();
  assert.equal(current.pid, initial.pid); assert.equal(current.windowNumber, initial.windowNumber);
  const result = await invoke(request, `${surface}-${suffix}`);
  if (result.details.success !== true) await writeFile(join(root, `${surface}-${suffix}-failure-${Date.now()}.json`), JSON.stringify(result), { mode: 0o600 });
  assert.equal(result.details.success, true, `${suffix}: ${result.details.status} ${result.details.result?.code ?? result.details.code ?? ''}`);
  return result;
}
async function image(request, label) {
  const before = await state();
  const result = await call(request, label);
  const resultPath = join(root, `${surface}-${label}-private.json`);
  const output = join(root, `${surface}-${label}-proof.json`);
  await writeFile(resultPath, JSON.stringify(result), { mode: 0o600 });
  const verifier = spawnSync(python, [proofScript, '--result', resultPath, '--fixture-state', fixturePath, '--expected', before.clicks ? 'clicked' : 'initial', '--output', output], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(verifier.status, 0, verifier.stderr);
  const proof = JSON.parse(await readFile(output));
  cases.push({ action: label, verified: true, proof });
  return { result, proof };
}
try {
  const health = await call({ action: 'health' });
  assert.equal(health.details.capabilitiesV1.schemaVersion, 1);
  cases.push({ action: 'health', verified: true, capabilitySurface: health.details.capabilitiesV1.producer.surface });
  const capture = await image({ action: 'inspect', ...target, mode: 'window', annotate: false }, 'inspect');
  await image({ action: 'screenshot', ...target, mode: 'window', format: 'png' }, 'screenshot-png');
  await image({ action: 'screenshot', ...target, mode: 'window', format: 'jpg', retina: true }, 'screenshot-jpeg-retina');
  const before = await state();
  const coords = capture.proof.desktopPoint.map(Math.round).join(',');
  await call({ action: 'click', ...target, coords });
  await new Promise(resolve => setTimeout(resolve, 250));
  const after = await state();
  assert.equal(after.clicks, before.clicks+1, 'one image-derived click must reach the fixture target');
  cases.push({ action: 'image-derived-click', verified: true, before: before.clicks, after: after.clicks, coordinateSource: 'decoded-native-image-and-receipt', clientResizePreserved: true });
  await image({ action: 'inspect', ...target, mode: 'window', annotate: false }, 'after-click');
  const keyBefore = await state();
  await call({ action: 'keypress', ...target, keys: ['a'] });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await state()).keys, keyBefore.keys+1);
  cases.push({ action: 'keypress', verified: true, visibleCounterChanged: true });
  const scan = await call({ action: 'inspect', ...target, mode: 'window', annotate: false });
  const elements = scan.details.result.result.data.ui_elements;
  const input = elements.find(e => e.identifier === 'fixture-input');
  assert.ok(input?.id);
  await call({ action: 'click', ...target, on: input.id }, 'focus-input');
  await call({ action: 'inspect', ...target, mode: 'window', annotate: false }, 'inspect-focused-input');
  const text = `fixture-${surface}`;
  await call({ action: 'type-text', ...target, text, clear: true });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await state()).text, text);
  cases.push({ action: 'type-text', verified: true, visibleFixtureTextMatched: true });
  const scrollScan = await call({ action: 'inspect', ...target, mode: 'window', annotate: false });
  const scroll = scrollScan.details.result.result.data.ui_elements.find(e => e.role === 'scrollArea' || e.ax_role === 'AXScrollArea');
  assert.ok(scroll?.id);
  const scrollBefore = (await state()).scrollOffset;
  const scrollDirection = scrollBefore > 0 ? 'up' : 'down';
  await call({ action: 'scroll', ...target, on: scroll.id, direction: scrollDirection, amount: 2 });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.notEqual((await state()).scrollOffset, scrollBefore);
  cases.push({ action: 'scroll', verified: true, direction: scrollDirection, visibleFixtureOffsetChanged: true });
  const audit = surface === 'sdk' ? JSON.stringify(audits) : await readFile(join(privateState, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes(text));
  assert.doesNotMatch(audit, /"(?:nonce|mac|approvalId|screenshot_raw)"|base64/);
  const receipt = { success: true, surface, packageVersion: manifest.version, node: process.version, adapterSha256: createHash('sha256').update(await readFile(adapter)).digest('hex'), decisionSource: surface === 'sdk' ? 'scripted-trusted-host' : 'scripted-operator-through-real-terminal-broker', captureEngine: process.env.PEEKABOO_CAPTURE_ENGINE ?? 'auto', nativeFixture: true, physicalDisplayVerified: false, publication: false, cases };
  await writeFile(join(root, `${surface}-native-receipt.json`), JSON.stringify(receipt, null, 2)+'\n');
  console.log(JSON.stringify({ success: true, surface, cases: cases.map(c => c.action) }));
} catch (error) {
  await writeFile(join(root, `${surface}-partial-${Date.now()}.json`), JSON.stringify({ success: false, surface, cases, failure: String(error.message), captureEngine: process.env.PEEKABOO_CAPTURE_ENGINE ?? 'auto' }, null, 2)+'\n');
  throw error;
} finally { await close(); }
