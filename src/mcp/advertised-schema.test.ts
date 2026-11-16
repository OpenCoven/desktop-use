import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolveActionPermissions } from '../action-permissions.js';
import { createJsonSchemaValidator } from './schema.js';
import { serveDesktopStdio } from './server.js';

// Claude Code 2.1.325 drops a tool whose input schema has a top-level allOf, anyOf or oneOf (#41).
async function fixture(t: any, era: 'modern' | 'legacy') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp41-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = new PassThrough(); const output = new PassThrough(); const audits: unknown[] = [];
  const handle = serveDesktopStdio({ workspaceDir: root, scope: { principalId: 'fixture', sessionId: root }, adapterPath: '/missing/fixture-adapter',
    actionPermissions: resolveActionPermissions(), auditSink: async (event: unknown) => { audits.push(event); } }, { input, output });
  const client = new Client({ name: 'advertised-schema-fixture', version: '1' }, era === 'modern'
    ? { jsonSchemaValidator: createJsonSchemaValidator(), versionNegotiation: { mode: { pin: '2026-07-28' } } }
    : { jsonSchemaValidator: createJsonSchemaValidator(), supportedProtocolVersions: ['2025-11-25'] });
  t.after(async () => { await client.close(); await handle.close(); });
  await client.connect(new StdioServerTransport(output, input));
  assert.equal(client.getNegotiatedProtocolVersion(), era === 'modern' ? '2026-07-28' : '2025-11-25');
  return { client, audits };
}

for (const era of ['modern', 'legacy'] as const) test(`${era} wire lists an input schema without top-level combinators and still rejects legacy clipboard text`, async t => {
  const { client, audits } = await fixture(t, era);
  const schema = (await client.listTools()).tools[0].inputSchema as Record<string, unknown>;
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) assert.equal(Object.hasOwn(schema, keyword), false, `listed schema has a top-level ${keyword}`);
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  for (const args of [{ action: 'clipboard-write', text: 'private-legacy' }, { action: 'clipboard-write', text: 'private-legacy', clipboardText: 'private-canonical' }]) {
    const result = await client.callTool({ name: 'computer_use', arguments: args });
    assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined, 'rejected before execution');
    assert.doesNotMatch(JSON.stringify(result), /private-legacy|private-canonical/);
  }
  assert.equal(audits.length, 0);
  // The canonical field passes validation and reaches policy, which fails closed without a trusted approval provider.
  const canonical = await client.callTool({ name: 'computer_use', arguments: { action: 'clipboard-write', clipboardText: 'private-canonical' } });
  assert.equal(typeof (canonical.structuredContent as any)?.status, 'string', 'canonical clipboard-write reaches execution');
  assert.doesNotMatch(JSON.stringify(canonical), /private-canonical/);
});
