import { createJsonSchemaValidator } from './schema.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolveActionPermissions } from '../action-permissions.js';

async function fixture(t: any, era: 'modern' | 'legacy', extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp24-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = await import('./server.js').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {} as any; throw error; });
  assert.equal(typeof module.serveDesktopStdio, 'function', 'MCP connector must exist');
  const input = new PassThrough(); const output = new PassThrough(); const audits: unknown[] = [];
  const handle = module.serveDesktopStdio({ workspaceDir: root, scope: { principalId: 'fixture', sessionId: root }, adapterPath: '/missing/fixture-adapter', auditSink: async (event: unknown) => { audits.push(event); }, ...extra }, { input, output });
  const client = new Client({ name: 'second-host-fixture', version: '1' }, era === 'modern' ? { jsonSchemaValidator: createJsonSchemaValidator(), versionNegotiation: { mode: { pin: '2026-07-28' } } } : { jsonSchemaValidator: createJsonSchemaValidator(), supportedProtocolVersions: ['2025-11-25'] });
  t.after(async () => { await client.close(); await handle.close(); });
  await client.connect(new StdioServerTransport(output, input));
  assert.equal(client.getNegotiatedProtocolVersion(), era === 'modern' ? '2026-07-28' : '2025-11-25');
  return { client, root, audits, input, output };
}
for (const era of ['modern', 'legacy'] as const) {
  test(`${era} official SDK wire advertises canonical schema, truthful capabilities and structured results`, async t => {
    const { client } = await fixture(t, era);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['computer_use']);
    const schema = tools[0].inputSchema as any;
    assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.confirm, undefined);
    assert.equal(schema.properties.action.enum.length, 18);
    const result = await client.callTool({ name: 'computer_use', arguments: { action: 'health' } });
    const details = result.structuredContent as any;
    assert.equal(details.capabilitiesV1.producer.surface, 'mcp');
    assert.equal(Object.keys(details.capabilitiesV1.actions).length, 18);
    assert.deepEqual(JSON.parse((result.content as any[])[0].text), details);
    assert.equal(details.capabilitiesV1.actions['file-write'].policy.profile, 'denied');
  });
  test(`${era} health-only wire preserves skipped native evidence and trusted MCP adapter identity`, async t => {
    let approvals = 0;
    const permissions = resolveActionPermissions({ allowedActions: ['health'] });
    const snapshot = JSON.stringify(permissions);
    const { client, audits } = await fixture(t, era, { actionPermissions: permissions, approvalProvider: () => { approvals++; return 'allowed'; } });
    const { tools } = await client.listTools();
    assert.equal((tools[0].inputSchema as any).properties.action.enum.length, 18);
    const result = await client.callTool({ name: 'computer_use', arguments: { action: 'health', reason: 'private-mcp-health' } });
    const details = result.structuredContent as any;
    assert.equal(result.isError, true); assert.equal(details.status, 'blocked');
    assert.deepEqual(details.adapterProbe, { action: 'doctor', status: 'skipped', code: 'ACTION_PROFILE_DENIED' });
    assert.equal(details.capabilitiesV1.schemaVersion, 1); assert.equal(details.capabilitiesV1.producer.surface, 'mcp');
    assert.deepEqual(details.capabilitiesV1.actionPermissions, permissions);
    assert.equal(details.capabilitiesV1.actions.doctor.state, 'unverified');
    assert.equal(details.adapterInvocation.configuredPath, '/missing/fixture-adapter');
    assert.equal(details.adapterInvocation.phase, 'before-start'); assert.equal(details.adapterInvocation.processStarted, false);
    assert.equal(details.repairHints, undefined); assert.equal(details.permissionFlow, undefined);
    assert.deepEqual(JSON.parse((result.content as any[])[0].text), details);
    assert.doesNotMatch(JSON.stringify(result), /private-mcp-health|ENOENT|MALFORMED_OUTPUT|CAPABILITY_SCHEMA_|Screen Recording|Accessibility|Install coven/);
    assert.equal(((await client.callTool({ name: 'computer_use', arguments: { action: 'stop' } })).structuredContent as any).status, 'success');
    assert.equal(((await client.callTool({ name: 'computer_use', arguments: { action: 'doctor' } })).structuredContent as any).code, 'ACTION_PROFILE_DENIED');
    assert.equal(approvals, 0); assert.equal(JSON.stringify(permissions), snapshot);
    assert.deepEqual((audits[0] as any).result, { status: 'blocked', success: false, code: 'ACTION_PROFILE_DENIED' });
    assert.doesNotMatch(JSON.stringify(audits), /private-mcp-health|capabilitiesV1|approvalId/);
  });
  test(`${era} rejects model authority, aliases and malformed values without effects or private diagnostics`, async t => {
    const { client, root, audits } = await fixture(t, era, { actionPermissions: resolveActionPermissions() });
    for (const args of [{ action: 'file-write', path: 'escape', content: 'private-token', confirm: true }, { action: 'permissions' }, { action: 'stop', scope: { principalId: 'forged' } }, { action: 'type-text', text: '\0private-token' }]) {
      const result = await client.callTool({ name: 'computer_use', arguments: args });
      assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /private-token|forged/);
    }
    assert.equal(audits.length, 0); await assert.rejects(readFile(join(root, 'escape')));
  });
  test(`${era} default eligibility and missing approval fail closed`, async t => {
    const { client, root } = await fixture(t, era);
    const result = await client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'blocked', content: 'none' } });
    assert.equal((result.structuredContent as any).code, 'ACTION_PROFILE_DENIED');
    await assert.rejects(readFile(join(root, 'blocked')));
  });
  test(`${era} delivers real adapter PNG bytes through typed content and shared receipt schema`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-image24-'))); t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = await readFile(new URL('../../contracts/v1/fixtures/images/valid.png', import.meta.url));
    const receipt = JSON.parse(await readFile(new URL('../../contracts/v1/fixtures/observations/valid-png.json', import.meta.url), 'utf8'));
    const adapter = join(root, 'adapter');
    await writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const path=process.argv[process.argv.indexOf('--path')+1];fs.writeFileSync(path,Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));const receipt=${JSON.stringify(receipt)};receipt.capturedAtMs=Date.now();process.stdout.write(JSON.stringify({ok:true,path,observationV1:receipt}));`, { mode: 0o700 });
    const { client, audits } = await fixture(t, era, { adapterPath: adapter });
    const result = await client.callTool({ name: 'computer_use', arguments: { action: 'screenshot', mode: 'screen' } });
    const image = (result.content as any[]).find(block => block.type === 'image');
    assert.ok(image); assert.equal(image.mimeType, 'image/png'); assert.deepEqual(Buffer.from(image.data, 'base64'), bytes);
    assert.equal((result.structuredContent as any).observationV1.schemaVersion, 1);
    assert.doesNotMatch(JSON.stringify(audits), new RegExp(bytes.toString('base64')));
  });
}
test('unsupported modern revision is explicitly rejected by the official stdio bridge', async t => {
  const { serveDesktopStdio } = await import('./server.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-version24-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const input = new PassThrough(); const output = new PassThrough(); let wire = ''; output.on('data', chunk => wire += chunk.toString());
  const handle = serveDesktopStdio({ workspaceDir: root, scope: { principalId: 'fixture' }, adapterPath: '/missing/fixture-adapter', auditSink: async () => {} }, { input, output });
  const client = new Client({ name: 'future-client', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), versionNegotiation: { mode: { pin: '2099-01-01' } } });
  t.after(async () => { await client.close(); await handle.close(); });
  await assert.rejects(client.connect(new StdioServerTransport(output, input)));
  assert.match(wire, /2026-07-28/); assert.match(wire, /-32022/);
});
test('public JSON-schema validator seam compiles complete shared output contracts and rejects invalid receipts', async () => {
  const module = await import('./schema.js') as any;
  assert.equal(typeof module.createJsonSchemaValidator, 'function', 'patched direct AJV validator seam must exist');
  const validator = module.createJsonSchemaValidator();
  const check = validator.getValidator(module.resultContract['~standard'].jsonSchema.output({ target: 'draft-2020-12' }));
  assert.equal(check({ status: 'success', success: true }).valid, true);
  const invalid = check({ status: 'success', capabilitiesV1: { schemaVersion: 99, private: 'private-token' } });
  assert.equal(invalid.valid, false); assert.doesNotMatch(invalid.errorMessage, /private-token/);
});
test('explicit full eligibility with no broker still requires trusted approval', async t => {
  const { client, root } = await fixture(t, 'modern', { actionPermissions: resolveActionPermissions() });
  const result = await client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'unapproved', content: 'none' } });
  assert.equal((result.structuredContent as any).status, 'needsApproval'); assert.equal(result.isError, true);
  await assert.rejects(readFile(join(root, 'unapproved')));
});
