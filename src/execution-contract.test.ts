import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as contracts from './contracts.js';
import { inputSchema, outputSchema } from './mcp/schema.js';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createJsonSchemaValidator } from './mcp/schema.js';
import { serveDesktopStdio } from './mcp/server.js';
import { createDesktopClient, resolveActionPermissions, type ApprovalResolution } from './sdk.js';
import { createComputerUseTool } from './plugin-tool.js';
import { COMPUTER_USE_TOOL_NAME } from './tool-names.js';

test('supported public execution v1 schemas describe canonical requests and full SDK results', () => {
  const api = contracts as unknown as Record<string, any>;
  assert.equal(api.desktopExecutionContractV1?.version, 1, 'The public entry must identify the supported execution version');
  assert.equal(api.desktopExecutionContractV1.requestSchema, api.desktopRequestSchemaV1);
  assert.equal(api.desktopExecutionContractV1.resultSchema, api.desktopResultSchemaV1);
  assert.equal(api.desktopExecutionContractV1.resultDetailsSchema, api.desktopResultDetailsSchemaV1);
  assert.ok(Object.isFrozen(api.desktopExecutionContractV1));
  for (const schema of [api.desktopRequestSchemaV1, api.desktopResultSchemaV1, api.desktopResultDetailsSchemaV1]) {
    assert.match(schema.$id, /\/contracts\/v1\//);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  }
  const request = new Ajv2020({ strict: false }).compile(api.desktopRequestSchemaV1);
  assert.equal(request({ action: 'stop' }), true);
  assert.equal(request({ action: 'clipboard-write', clipboardText: 'canonical' }), true);
  for (const invalid of [{ action: 'permissions' }, { action: 'stop', confirm: true }, { action: 'stop', schemaVersion: 2 }, { action: 'clipboard-write', text: 'legacy' }]) {
    assert.equal(request(invalid), false, JSON.stringify(invalid));
  }
  const result = new Ajv2020({ strict: false }).compile(api.desktopResultSchemaV1);
  assert.equal(result({ content: [{ type: 'text', text: '{}' }], details: { status: 'success', success: true } }), true);
  assert.equal(result({ content: [{ type: 'text', text: '{}' }], details: { status: 'success', futureMetadata: {} } }), true);
  assert.equal(result({ content: [], details: { status: 'success' } }), false);
  assert.equal(result({ content: [{ type: 'text', text: '{}' }], details: { status: 'invented-outcome' } }), false);
  assert.equal(result({ content: [{ type: 'text', text: '{}' }], details: { status: 'success', capabilitiesV1: { schemaVersion: 999 } } }), false);
});

test('MCP uses the same public v1 request and structured-result schemas', () => {
  const api = contracts as unknown as Record<string, any>;
  assert.equal(inputSchema, api.desktopRequestSchemaV1);
  assert.equal(outputSchema, api.desktopResultDetailsSchemaV1);
});

test('shared canonical vectors retain validation, outcome, image and audit parity across all consumers', { timeout: 30_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-contract-v1-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = join(root, 'adapter.cjs');
  const marker = join(root, 'adapter-calls');
  const bytes = await readFile(new URL('../contracts/v1/fixtures/images/valid.png', import.meta.url));
  const receipt = JSON.parse(await readFile(new URL('../contracts/v1/fixtures/observations/valid-png.json', import.meta.url), 'utf8'));
  await writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(args)+'\\n');let result={ok:true};if(args[0]==='screenshot'){const path=args[args.indexOf('--path')+1];fs.writeFileSync(path,Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));const receipt=${JSON.stringify(receipt)};receipt.capturedAtMs=Date.now();result={ok:true,path,observationV1:receipt};}console.log(JSON.stringify(result));`, { mode: 0o700 });
  const api = contracts as unknown as Record<string, any>;
  const validate = new Ajv2020({ strict: false }).compile(api.desktopResultSchemaV1);
  const permissions = resolveActionPermissions();
  const projected: unknown[][] = [];
  for (const surface of ['sdk', 'plugin', 'modern', 'legacy'] as const) {
    await t.test(surface, async () => {
      let decision: ApprovalResolution = 'allowed';
      let approvals = 0;
      const audits: unknown[] = [];
      const options = { workspaceDir: root, scope: { principalId: 'contract-parity', sessionId: root }, adapterPath: adapter,
        actionPermissions: permissions, auditSink: async (event: unknown) => { audits.push(event); },
        approvalProvider: () => { approvals++; return decision; } };
      let invoke: (request: any) => Promise<any>;
      let close = async () => {};
      if (surface === 'sdk') {
        const client = createDesktopClient(options);
        invoke = request => client.execute(request, { callId: 'shared-vector' });
      } else if (surface === 'plugin') {
        const tool = createComputerUseTool({ ctx: { workspaceDir: root, agentId: 'contract-parity', sessionKey: root }, adapterPath: adapter,
          actionPermissions: permissions, approvalProvider: options.approvalProvider, appendAuditEvent: options.auditSink });
        invoke = request => tool.execute('shared-vector', request);
      } else {
        const input = new PassThrough(); const output = new PassThrough();
        const server = serveDesktopStdio(options, { input, output });
        const client = new Client({ name: 'shared-v1-vectors', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(),
          ...(surface === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : { supportedProtocolVersions: ['2025-11-25'] }) });
        close = async () => { await client.close(); await server.close(); };
        await client.connect(new StdioServerTransport(output, input));
        invoke = async request => {
          const result = await client.callTool({ name: COMPUTER_USE_TOOL_NAME, arguments: request });
          if (!result.structuredContent) throw new Error('Request was rejected before execution.');
          return { content: result.content, details: result.structuredContent };
        };
      }
      const outcomes: unknown[] = [];
      const run = async (request: unknown) => {
        const result = await invoke(request);
        assert.equal(validate(result), true, JSON.stringify(validate.errors));
        assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.details)));
        const { status, success, action, code } = result.details;
        outcomes.push({ status, success, action, code });
        return result;
      };
      try {
        const beforeInvalid = audits.length;
        for (const invalid of [{ action: 'stop', timeoutMs: 1 }, { action: 'stop', scope: 'forged' }, { action: 'type-text', text: '\0private-vector' }]) {
          await assert.rejects(invoke(invalid));
        }
        assert.equal(audits.length, beforeInvalid);
        assert.equal((await run({ action: 'stop' })).details.cancellationRequested, 0);
        for (const [resolution, status, code] of [
          ['denied', 'blocked', 'APPROVAL_DENIED'], ['expired', 'timeout', 'APPROVAL_EXPIRED'],
          ['cancelled', 'cancelled', 'CANCELLED'], ['unavailable', 'needsApproval', undefined],
        ] as const) {
          decision = resolution;
          const beforeCalls = await readFile(marker, 'utf8').catch(() => '');
          const beforeApprovals = approvals;
          const result = await run({ action: 'file-write', path: 'must-not-exist', content: 'private-vector' });
          assert.equal(result.details.status, status); assert.equal(result.details.code, code);
          assert.equal(approvals, beforeApprovals + 1);
          assert.equal(await readFile(marker, 'utf8').catch(() => ''), beforeCalls);
          await assert.rejects(readFile(join(root, 'must-not-exist')));
        }
        decision = 'allowed';
        assert.equal((await run({ action: 'click', coords: '1,2' })).details.success, true);
        const image = await run({ action: 'screenshot', mode: 'screen' });
        assert.equal(image.content[1].type, 'image'); assert.equal(image.content[1].mimeType, 'image/png');
        assert.deepEqual(Buffer.from(image.content[1].data, 'base64'), bytes);
        assert.deepEqual(image.details.observationV1.primaryImage, receipt.primaryImage);
        const timeout = await run({ action: 'shell', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 1000 });
        assert.equal(timeout.details.status, 'timeout'); assert.equal(timeout.details.code, 'ETIMEDOUT');
        assert.doesNotMatch(JSON.stringify(audits), /private-vector/);
        assert.ok(!JSON.stringify(audits).includes(bytes.toString('base64')));
        projected.push(outcomes);
      } finally { await close(); }
    });
  }
  assert.equal(projected.length, 4);
  for (const outcomes of projected.slice(1)) assert.deepEqual(outcomes, projected[0]);
});
