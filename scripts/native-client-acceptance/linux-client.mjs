// Opt-in actual X11/Wayland client probe, only inside the owned graphics container.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createDesktopClient, resolveActionPermissions } from '@opencoven/openclaw-desktop-use/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
assert.equal(process.platform, 'linux');
assert.equal(process.env.NATIVE_OWNED_DISPOSABLE_DISPLAY, 'yes');
const root = '/owned';
const adapter = '/owned/source/target/debug/coven-desktop-use';
const statePath = '/owned/fixture-client-state.json';
const state = async () => JSON.parse(await readFile(statePath));
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('@opencoven/openclaw-desktop-use/package.json'));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
const receipts = [];
for (const surface of ['sdk', 'mcp-modern', 'mcp-legacy']) {
  const workspace = join(root, `${surface}-workspace`), privateState = join(root, `${surface}-state`);
  await mkdir(workspace, { recursive: true, mode: 0o700 }); await mkdir(privateState, { recursive: true, mode: 0o700 });
  const audit = [];
  let invoke, close = async () => {};
  if (surface === 'sdk') {
    const client = createDesktopClient({ workspaceDir: workspace, scope: { principalId: 'linux-native', sessionId: surface }, adapterPath: adapter,
      actionPermissions: resolveActionPermissions({ actionProfile: 'full' }), approvalProvider: () => 'allowed', auditSink: async event => { audit.push(event); } });
    invoke = (request, id) => client.execute(request, { callId: id });
  } else {
    const config = join(root, `${surface}-config.json`);
    await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir: privateState, principalId: 'linux-native', sessionId: surface, adapterPath: adapter, actionProfile: 'full' }), { mode: 0o600 });
    const { createJsonSchemaValidator } = await import(pathToFileURL(join(packageRoot, 'dist/src/mcp/schema.js')));
    const modern = surface === 'mcp-modern';
    const client = new Client({ name: 'linux-native-acceptance', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
    const transport = new StdioClientTransport({ command: 'python3', args: ['/owned/pty-host.py', 'allow', process.execPath, join(packageRoot, 'dist/examples/approval-host/main.js'), '--config', config], stderr: 'pipe', env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XDG_SESSION_TYPE: 'x11' } });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    assert.equal(client.getNegotiatedProtocolVersion(), modern ? '2026-07-28' : '2025-11-25');
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map(t => t.name), ['computer_use']);
    invoke = async request => { const r = await client.callTool({ name: 'computer_use', arguments: request }); return { content: r.content, details: r.structuredContent }; };
    close = () => client.close();
  }
  const cases = [];
  async function call(request, label = request.action) {
    const result = await invoke(request, `${surface}-${label}`);
    assert.equal(result.details.success, true, `${surface}/${label}: ${result.details.status}`);
    return result;
  }
  try {
    const health = await call({ action: 'health' }); assert.equal(health.details.capabilitiesV1.schemaVersion, 1);
    await call({ action: 'focus', windowTitle: 'DesktopuseInstalledClient' });
    let decodedPoint;
    for (const format of ['png', 'jpg']) {
      const capture = await call({ action: 'screenshot', mode: 'screen', format });
      const images = capture.content.filter(c => c.type === 'image'); assert.equal(images.length, 1);
      const bytes = Buffer.from(images[0].data, 'base64'), receipt = capture.details.observationV1;
      assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.primaryImage.sha256);
      assert.equal(bytes.length, receipt.primaryImage.byteLength);
      assert.equal(receipt.geometry.state, 'available');
      const file = join(root, `${surface}-actual.${format}`); await writeFile(file, bytes, { mode: 0o600 });
      const decoded = spawnSync('python3', ['/owned/linux-image-proof.py', file, statePath, JSON.stringify(receipt)], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(decoded.status, 0, decoded.stderr);
      const pixelProof = JSON.parse(decoded.stdout);
      if (format === 'png') decodedPoint = pixelProof.desktopPoint;
      cases.push({ action: 'screenshot', mimeType: images[0].mimeType, byteLength: bytes.length, sha256: receipt.primaryImage.sha256, dimensions: receipt.primaryImage.sourceDimensions, geometry: receipt.geometry, pixelProof });
    }
    const before = await state();
    assert.ok(decodedPoint);
    await call({ action: 'click', coords: decodedPoint.map(Math.round).join(',') });
    await new Promise(resolve => setTimeout(resolve, 200));
    const after = await state(); assert.equal(after.clicks.length, before.clicks.length+1);
    assert.ok(Math.abs(after.clicks.at(-1).x-80)<=1 && Math.abs(after.clicks.at(-1).y-60)<=1);
    await call({ action: 'keypress', keys: ['a'] });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await state()).keys.length, before.keys.length+1);
    cases.push({ action: 'click', observedFixtureEffect: true }, { action: 'keypress', observedFixtureEffect: true });
    const auditText = surface === 'sdk' ? JSON.stringify(audit) : await readFile(join(privateState, 'audit.jsonl'), 'utf8');
    assert.doesNotMatch(auditText, /"(?:nonce|mac|approvalId|screenshot_raw)"|base64/);
    receipts.push({ surface, success: true, decisionSource: surface === 'sdk' ? 'scripted-trusted-host' : 'scripted-operator-through-real-terminal-broker', cases });
  } finally { await close(); }
}
await writeFile('/owned/installed-native-client-receipt.json', JSON.stringify({ success: true, packageVersion: manifest.version, node: process.version, architecture: process.arch, session: 'virtual-x11', physicalDisplayVerified: false, adapterSha256: createHash('sha256').update(await readFile(adapter)).digest('hex'), receipts }, null, 2)+'\n');
console.log(JSON.stringify({ success: true, surfaces: receipts.map(r => r.surface) }));
