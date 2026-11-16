import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createDesktopClient, type DesktopClientOptions } from './sdk.js';
import { serveDesktopStdio } from './mcp/server.js';
import { createJsonSchemaValidator } from './mcp/schema.js';
import { COMPUTER_USE_TOOL_NAME } from './tool-names.js';

// Catch a standalone call accidentally receiving the plugin's gateway/environment repair instructions.
for (const surface of ['sdk', 'mcp-modern', 'mcp-legacy'] as const) {
  for (const scenario of ['missing-adapter', 'nonexecutable-adapter', 'permission-denied', 'permission-granted'] as const) {
    test(`${surface} ${scenario} repair advice names the actual client surface`, async t => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'desktopuse-repair37-')));
      t.after(() => rm(root, { recursive: true, force: true }));
      const adapterPath = join(root, 'fixture-adapter.cjs');
      if (scenario !== 'missing-adapter') {
        const report = JSON.parse(await readFile(new URL(`../contracts/v1/fixtures/capabilities/macos-permission-${scenario === 'permission-denied' ? 'denied' : 'granted'}.json`, import.meta.url), 'utf8')).report;
        const response = { ok: true, platform: 'macos', backend: 'peekaboo', capabilitiesV1: report };
        await writeFile(adapterPath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response))});\n`, { mode: scenario === 'nonexecutable-adapter' ? 0o600 : 0o700 });
      }
      const options: DesktopClientOptions = { workspaceDir: root, scope: { principalId: 'repair-fixture', sessionId: surface }, adapterPath, auditSink: async () => {} };
      let execute: (action: 'health' | 'doctor') => Promise<Record<string, any>>;
      if (surface === 'sdk') {
        const client = createDesktopClient(options);
        execute = async action => (await client.execute({ action }, { callId: action })).details;
      } else {
        const input = new PassThrough(), output = new PassThrough();
        const server = serveDesktopStdio(options, { input, output });
        const client = new Client({ name: 'repair-fixture', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), ...(surface === 'mcp-modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
        t.after(async () => { await client.close(); await server.close(); });
        await client.connect(new StdioServerTransport(output, input));
        execute = async action => (await client.callTool({ name: COMPUTER_USE_TOOL_NAME, arguments: { action } })).structuredContent as Record<string, any>;
      }
      for (const action of ['health', 'doctor'] as const) {
        const details = await execute(action);
        const guidance = JSON.stringify({ repairHints: details.repairHints, permissionFlow: details.permissionFlow, adapterSetup: details.result?.adapterSetup, hint: details.result?.hint });
        assert.doesNotMatch(guidance, /OpenClaw|Gateway|COVEN_DESKTOP_USE_BIN|tccutil|pre-authoriz/i);
        if (scenario === 'missing-adapter' || scenario === 'nonexecutable-adapter') {
          assert.equal(details.adapterInvocation.phase, 'spawn');
          assert.equal(details.adapterInvocation.processStarted, false);
          assert.equal(details.adapterInvocation.code, scenario === 'missing-adapter' ? 'ENOENT' : 'EACCES');
          assert.match(details.repairHints.join(' '), surface === 'sdk' ? /trusted SDK adapterPath option/ : /trusted MCP configuration adapterPath/);
          assert.equal(details.permissionFlow, undefined);
          assert.doesNotMatch(guidance, /Screen Recording|Accessibility/);
        } else if (scenario === 'permission-denied') {
          assert.equal(details.adapterInvocation.phase, 'adapter');
          assert.match(details.repairHints.join(' '), /Screen Recording and Accessibility/);
          assert.deepEqual(details.permissionFlow.requiredPermissions, ['Screen Recording', 'Accessibility']);
          assert.ok(details.permissionFlow.grantTargets.includes('the terminal app or service that launched this client'));
          assert.match(details.permissionFlow.afterGrant, surface === 'sdk' ? /launcher of this SDK client/ : /launcher of this MCP client/);
          assert.deepEqual(details.permissionFlow.verification, { tool: COMPUTER_USE_TOOL_NAME, args: { action: 'doctor' } });
        } else {
          assert.deepEqual(details.repairHints, []);
          assert.equal(details.permissionFlow, undefined);
        }
      }
    });
  }
}
