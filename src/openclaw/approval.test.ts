import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { ComputerUseToolSchema } from '../request-schema.js';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import plugin from '../../index.js';
import { createComputerUseTool } from '../plugin-tool.js';

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'du24-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const ctx = { workspaceDir: root, agentDir: join(root, 'agent'), agentId: 'fixture', sessionKey: root };
  const factories: any = {}; let hook: any;
  plugin.register({ id: 'opencoven-desktop-use', config: {}, runtime: {}, logger: console,
    registerTool(factory: any, options: any) { factories[options.name] = factory; }, on(_name: string, handler: any) { hook = handler; },
  } as never);
  const tool = factories.computer_use(ctx);
  return { root, ctx, tool, factories, hook, request: { action: 'file-write', path: 'out', content: 'fixture' } };
}

test('direct confirm cannot bypass the public gateway approval resolution', async t => {
  const { root, ctx, request } = await fixture(t);
  const result = await createComputerUseTool({ ctx, appendAuditEvent: async () => {} }).execute('forged', { ...request, confirm: true });
  assert.equal(result.details.status, 'needsApproval');
  await assert.rejects(readFile(join(root, 'out')));
});

test('gateway returned parameters alone do not authorize; actual allow resolution permits exactly one dispatch', async t => {
  const { root, ctx, request, tool, hook } = await fixture(t);
  const first = await hook({ toolName: 'computer_use', params: request }, ctx);
  assert.equal((await tool.execute('before-resolution', first.params)).details.success, false);
  await assert.rejects(readFile(join(root, 'out')));
  const approved = await hook({ toolName: 'computer_use', params: request }, ctx);
  assert.equal(typeof approved.requireApproval.onResolution, 'function');
  approved.requireApproval.onResolution('allow-once');
  const result = await tool.execute('after-resolution', approved.params);
  assert.equal(result.details.status, 'success');
  assert.equal(await readFile(join(root, 'out'), 'utf8'), 'fixture');
  const repeated = await tool.execute('different-call-id', approved.params);
  assert.equal(repeated.details.success, false);
  assert.doesNotMatch(JSON.stringify(result), /_desktopApproval/);
  assert.doesNotMatch(await readFile(join(root, 'audit/computer-use.jsonl'), 'utf8'), /_desktopApproval/);
});

test('gateway denial, cancellation, timeout, changed params and foreign scopes cannot consume a grant', async t => {
  const { root, ctx, request, tool, hook, factories } = await fixture(t);
  for (const resolution of ['deny', 'cancelled', 'timeout']) {
    const approved = await hook({ toolName: 'computer_use', params: request }, ctx);
    approved.requireApproval.onResolution(resolution);
    approved.requireApproval.onResolution('allow-once');
    assert.equal((await tool.execute(resolution, approved.params)).details.success, false);
  }
  const approved = await hook({ toolName: 'computer_use', params: request }, ctx);
  approved.requireApproval.onResolution('allow-always');
  assert.equal((await tool.execute('changed', { ...approved.params, content: 'changed' })).details.success, false);
  const foreign = factories.computer_use({ ...ctx, sessionKey: 'other' });
  assert.equal((await foreign.execute('foreign', approved.params)).details.success, false);
  await assert.rejects(readFile(join(root, 'out')));
});

test('model continuation references are rejected and same-scope Stop invalidates pending approval', async t => {
  const { root, ctx, request, tool, hook } = await fixture(t);
  const approved = await hook({ toolName: 'computer_use', params: request }, ctx);
  assert.equal((await hook({ toolName: 'computer_use', params: approved.params }, ctx)).block, true);
  const stopped = await tool.execute('stop', { action: 'stop' });
  assert.equal(stopped.details.cancellationRequested, 1);
  approved.requireApproval.onResolution('allow-once');
  assert.equal((await tool.execute('late', approved.params)).details.success, false);
  await assert.rejects(readFile(join(root, 'out')));
});

test('gateway grant is invalidated when the trusted workspace is rebound before invocation', async t => {
  const fs = await import('node:fs/promises');
  const { root, ctx, request, hook, factories } = await fixture(t);
  await fs.mkdir(join(root, 'one')); await fs.mkdir(join(root, 'two')); await fs.symlink(join(root, 'one'), join(root, 'alias'));
  const aliased = { ...ctx, sessionKey: 'aliased', workspaceDir: join(root, 'alias') };
  const tool = factories.computer_use(aliased);
  const approval = await hook({ toolName: 'computer_use', params: request }, aliased);
  approval.requireApproval.onResolution('allow-once');
  await fs.unlink(join(root, 'alias')); await fs.symlink(join(root, 'two'), join(root, 'alias'));
  assert.equal((await tool.execute('rebound-workspace', approval.params)).details.success, false);
  await assert.rejects(readFile(join(root, 'one/out')));
});

test('unused gateway grants expire and bounded pending state evicts old continuations', async t => {
  const { createGatewayApprovalBridge } = await import('./approval.js');
  const { resolveActionPermissions } = await import('../action-permissions.js');
  const { root, ctx } = await fixture(t);
  const permissions = resolveActionPermissions();
  const short = createGatewayApprovalBridge(10);
  const expired = await short.prepare({ action: 'file-write', path: join(root, 'expired'), content: 'none' }, ctx, permissions);
  expired.onResolution('allow-once'); await new Promise(resolve => setTimeout(resolve, 20));
  const tool = createComputerUseTool({ ctx, approvalBridge: short, actionPermissions: permissions, appendAuditEvent: async () => {} });
  assert.equal((await tool.execute('expired', expired.params)).details.success, false);
  const bounded = createGatewayApprovalBridge(); let first: any;
  for (let index = 0; index < 257; index++) { const entry = await bounded.prepare({ action: 'click', coords: '1,1' }, ctx, permissions); if (!first) first = entry; }
  first.onResolution('allow-once');
  const stop = await tool.execute('bounded-stop', { action: 'stop' });
  assert.equal(stop.details.cancellationRequested, 256);
  await assert.rejects(readFile(join(root, 'expired')));
});


test('host continuation survives dispatcher schema validation without admitting caller authority', async t => {
  const { root, ctx, request, tool, hook } = await fixture(t);
  const validate = new Ajv.default({ strict: true }).compile(tool.parameters);
  const canonical = new Ajv.default({ strict: true }).compile(ComputerUseToolSchema);
  const pending = await hook({ toolName: 'computer_use', params: request }, ctx);
  assert.equal(validate(pending.params), true, JSON.stringify(validate.errors));
  assert.equal(canonical(pending.params), false, 'Canonical requests never admit transport authority fields');
  assert.equal(validate({ ...pending.params, arbitraryAuthority: true }), false);
  assert.equal(validate({ ...pending.params, _desktopApproval: 'forged' }), false);
  assert.equal((await hook({ toolName: 'computer_use', params: pending.params }, ctx)).block, true);
  pending.requireApproval.onResolution('allow-once');
  assert.equal((await tool.execute('validated-host-continuation', pending.params)).details.status, 'success');
  assert.equal(await readFile(join(root, 'out'), 'utf8'), 'fixture');
});
