/** Runs in an external installed package consumer, never through checkout imports. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const [packageRoot, adapterPath, version, source] = process.argv.slice(2);
const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(metadata.version, version);
const identity = JSON.parse(await readFile(join(packageRoot, 'dist/release-identity.json'), 'utf8'));
assert.equal(identity.source.commit, source);
assert.equal(identity.releaseVersion, version);
const native = JSON.parse(execFileSync(adapterPath, ['--version'], { encoding: 'utf8' }));
assert.equal(native.source.commit, source); assert.equal(native.version, version);
const { createDesktopClient } = await import(pathToFileURL(join(packageRoot, 'dist/src/sdk.js')));
const { createJsonSchemaValidator } = await import(pathToFileURL(join(packageRoot, 'dist/src/mcp/schema.js')));
const workspace = process.cwd();
const sdk = createDesktopClient({ workspaceDir: workspace, adapterPath, scope: { principalId: 'release-installed-sdk' }, auditSink: async () => {} });
const results = { sdk: {}, mcp: {} };
for (const action of ['health', 'doctor']) {
  const result = await sdk.execute({ action }, { callId: action });
  assert.equal(result.details.capabilitiesV1.producer.surface, 'sdk');
  assert.equal(result.details.capabilitiesV1.adapter.version, version);
  results.sdk[action] = result.details;
}
for (const protocol of ['2025-11-25', '2026-07-28']) {
  const state = join(workspace, protocol); await mkdir(state, { mode: 0o700 });
  const config = join(state, 'config.json');
  await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir: state, principalId: 'release-installed-mcp', adapterPath }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(packageRoot, 'dist/src/mcp/main.js'), '--config', config], stderr: 'pipe', env: { PATH: process.env.PATH, COVEN_HOME: process.env.COVEN_HOME, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR, NODE_PATH: '' } });
  const client = new Client({ name: 'release-installed-consumer', version }, { jsonSchemaValidator: createJsonSchemaValidator(), ...(protocol === '2026-07-28' ? { versionNegotiation: { mode: { pin: protocol } } } : { supportedProtocolVersions: [protocol] }) });
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), protocol);
    assert.equal(client.getServerVersion().version, version);
    const actions = {};
    for (const action of ['health', 'doctor']) {
      const result = await client.callTool({ name: 'computer_use', arguments: { action } });
      assert.equal(result.structuredContent.capabilitiesV1.producer.surface, 'mcp');
      assert.equal(result.structuredContent.capabilitiesV1.adapter.version, version);
      actions[action] = result.structuredContent;
    }
    results.mcp[protocol] = actions;
  } finally { await client.close(); }
}
const require = createRequire(join(packageRoot, 'package.json'));
assert.throws(() => require.resolve('openclaw'), 'Standalone installed SDK/MCP must not need OpenClaw');
await writeFile('installed-consumer.json', JSON.stringify({ status: 'passed', packageRoot, adapterPath, packageIdentity: identity, nativeIdentity: native, results, graphicalAcceptance: 'not-run' }, null, 2) + '\n');
