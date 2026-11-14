import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveActionPermissions } from '../action-permissions.js';

// A missing client is asserted explicitly so the first red is the absent contract.
async function fixture(t: any, extra: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktopuse-sdk24-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = await import('./client.js').catch(() => ({} as any));
  assert.equal(typeof module.createDesktopClient, 'function', 'host-neutral client must exist');
  const audits: any[] = [];
  const options = { workspaceDir: root, scope: { principalId: 'fixture', sessionId: root }, adapterPath: '/missing/fixture-adapter', actionPermissions: resolveActionPermissions(), auditSink: async (event: any) => { audits.push(event); }, ...extra };
  return { root, audits, options, create: module.createDesktopClient, client: module.createDesktopClient(options) };
}

test('SDK rejects authority fields and aliases before approval or audit', async t => {
  const { client, audits } = await fixture(t);
  for (const request of [{ action: 'click', coords: '1,2', confirm: true }, { action: 'stop', scope: {} }, { action: 'stop', approvalProvider: {} }, { action: 'permissions' }]) {
    await assert.rejects(() => client.execute(request, { callId: 'forged' }));
  }
  assert.equal(audits.length, 0);
});

test('SDK requires trusted workspace, scope and audit construction; defaults to observation eligibility', async t => {
  const { create, options } = await fixture(t);
  for (const changed of [{ auditSink: undefined }, { workspaceDir: 'relative' }, { scope: {} }]) assert.throws(() => create({ ...options, ...changed }));
  const result = await create({ ...options, actionPermissions: undefined }).execute({ action: 'click', coords: '1,2' }, { callId: 'default' });
  assert.equal(result.details.code, 'ACTION_PROFILE_DENIED');
});

test('gated writes require an actual provider decision; private provider errors never escape', async t => {
  const { create, options, root } = await fixture(t);
  for (const provider of [undefined, async () => 'denied', async () => { throw new Error('private-provider-token'); }, async () => ({ allowed: true })]) {
    const result = await create({ ...options, approvalProvider: provider }).execute({ action: 'file-write', path: 'denied', content: 'private-input' }, { callId: 'same' });
    assert.equal(result.details.success, false);
    assert.doesNotMatch(JSON.stringify(result), /private-provider-token/);
    await assert.rejects(readFile(join(root, 'denied')));
  }
});

test('approval challenges freeze canonical inputs, policy, scope and unique operation identity', async t => {
  const challenges: any[] = [];
  const { client, root, audits } = await fixture(t, { approvalProvider: async (challenge: any) => { challenges.push(challenge); return 'allowed'; } });
  for (const path of ['one', 'two']) {
    const result = await client.execute({ action: 'file-write', path, content: 'private-input' }, { callId: 'duplicate-correlation' });
    assert.equal(result.details.status, 'success');
    assert.equal(await readFile(join(root, path), 'utf8'), 'private-input');
  }
  assert.notEqual(challenges[0].operationId, challenges[1].operationId);
  assert.notEqual(challenges[0].approvalId, challenges[1].approvalId);
  assert.equal(challenges[0].params.path, join(root, 'one'));
  for (const value of [challenges[0], challenges[0].params, challenges[0].scope, challenges[0].policy, challenges[0].policy.allowedActions]) assert.equal(Object.isFrozen(value), true);
  assert.ok(challenges[0].expiresAt - Date.now() > 299000);
  assert.doesNotMatch(JSON.stringify(audits), /private-input/);
});

test('pending approval is cancelled by same-scope Stop, but not another scope; late allow cannot write', async t => {
  let allow!: (value: string) => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  const { create, client, options, root } = await fixture(t, { approvalProvider: async () => { entered(); return new Promise(resolve => allow = resolve); } });
  const pending = client.execute({ action: 'file-write', path: 'late', content: 'not-written' }, { callId: 'pending' });
  await ready;
  assert.equal((await create({ ...options, scope: { principalId: 'other' } }).execute({ action: 'stop' }, { callId: 'other-stop' })).details.cancellationRequested, 0);
  assert.equal((await client.execute({ action: 'stop' }, { callId: 'stop' })).details.cancellationRequested, 1);
  assert.equal((await pending).details.status, 'cancelled');
  allow('allowed');
  await assert.rejects(readFile(join(root, 'late')));
});

test('AbortSignal and approval expiry finish pending work without waiting for the provider', async t => {
  const { create, options, root } = await fixture(t);
  const controller = new AbortController();
  const client = create({ ...options, approvalProvider: () => new Promise(() => {}), approvalTimeoutMs: 15 });
  const pending = client.execute({ action: 'file-write', path: 'abort', content: 'none' }, { callId: 'abort', signal: controller.signal });
  controller.abort();
  assert.equal((await pending).details.status, 'cancelled');
  assert.equal((await client.execute({ action: 'file-write', path: 'expired', content: 'none' }, { callId: 'expired' })).details.code, 'APPROVAL_EXPIRED');
  await assert.rejects(readFile(join(root, 'expired')));
});

test('caller mutation cannot change approved input and changed canonical targets require fresh approval', async t => {
  const fs = await import('node:fs/promises');
  let resolve!: (value: string) => void; let enter!: () => void;
  let ready = new Promise<void>(r => enter = r);
  const { client, root } = await fixture(t, { approvalProvider: async () => { enter(); return new Promise(r => resolve = r); } });
  const request = { action: 'file-write', path: 'original', content: 'original-content' };
  const pending = client.execute(request, { callId: 'mutation' }); await ready;
  request.content = 'changed'; request.path = 'changed'; resolve('allowed');
  assert.equal((await pending).details.status, 'success');
  assert.equal(await fs.readFile(join(root, 'original'), 'utf8'), 'original-content');
  await assert.rejects(fs.readFile(join(root, 'changed')));
  await fs.mkdir(join(root, 'parent')); await fs.mkdir(join(root, 'foreign'));
  ready = new Promise<void>(r => enter = r);
  const rebound = client.execute({ action: 'file-write', path: 'parent/out', content: 'not-written' }, { callId: 'rebind' }); await ready;
  await fs.rename(join(root, 'parent'), join(root, 'old')); await fs.symlink(join(root, 'foreign'), join(root, 'parent'));
  resolve('allowed');
  assert.equal((await rebound).details.status, 'needsApproval');
  await assert.rejects(fs.readFile(join(root, 'foreign/out')));
});

test('trusted workspace rebinding cannot reuse approval', async t => {
  const fs = await import('node:fs/promises');
  let resolve!: (value: string) => void; let enter!: () => void;
  const ready = new Promise<void>(r => enter = r);
  const { create, options, root } = await fixture(t);
  await fs.mkdir(join(root, 'first')); await fs.mkdir(join(root, 'second')); await fs.symlink(join(root, 'first'), join(root, 'workspace'));
  const client = create({ ...options, workspaceDir: join(root, 'workspace'), approvalProvider: async () => { enter(); return new Promise(r => resolve = r); } });
  const pending = client.execute({ action: 'file-write', path: 'out', content: 'not-written' }, { callId: 'workspace-rebind' }); await ready;
  await fs.unlink(join(root, 'workspace')); await fs.symlink(join(root, 'second'), join(root, 'workspace')); resolve('allowed');
  assert.equal((await pending).details.status, 'needsApproval');
  await assert.rejects(fs.readFile(join(root, 'first/out')));
  await assert.rejects(fs.readFile(join(root, 'second/out')));
});

test('approval expiry aborts the provider signal and late resolution cannot authorize dispatch', async t => {
  let signal: AbortSignal | undefined;
  const { client } = await fixture(t, { approvalTimeoutMs: 10, approvalProvider: (challenge: any) => { signal = challenge.signal; return new Promise(() => {}); } });
  const result = await client.execute({ action: 'file-write', path: 'expired-signal', content: 'none' }, { callId: 'expiry-signal' });
  assert.equal(result.details.code, 'APPROVAL_EXPIRED');
  assert.equal(signal?.aborted, true);
});

test('all eighteen canonical families traverse the client with preserved audit, image, file and process outcomes', async t => {
  const fs = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  // The host integrations must be exercised without touching the real clipboard or applications.
  t.mock.method(os, 'platform', () => 'win32'); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { create, options, root, audits } = await fixture(t);
  const imagePath = new URL('../../contracts/v1/fixtures/images/valid.png', import.meta.url).pathname;
  const receipt = JSON.parse(await fs.readFile(new URL('../../contracts/v1/fixtures/observations/valid-png.json', import.meta.url), 'utf8'));
  const adapter = join(root, 'adapter.cjs');
  await fs.writeFile(adapter, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(join(root, 'calls'))},JSON.stringify(args)+'\\n');let result={ok:true};if(['inspect','screenshot'].includes(args[0])){const path=args[args.indexOf('--path')+1];fs.copyFileSync(${JSON.stringify(imagePath)},path);const receipt=${JSON.stringify(receipt)};receipt.capturedAtMs=Date.now();result={ok:true,path,observationV1:receipt};}console.log(JSON.stringify(result));`, { mode: 0o700 });
  const client = create({ ...options, adapterPath: adapter, approvalProvider: () => 'allowed' });
  await fs.writeFile(join(root, 'read'), 'source');
  const cases: [any, string][] = [
    [{ action: 'health' }, 'success'], [{ action: 'doctor' }, 'success'], [{ action: 'inspect' }, 'success'], [{ action: 'screenshot' }, 'success'],
    [{ action: 'click', coords: '1,2' }, 'success'], [{ action: 'type-text', text: 'private-text' }, 'success'], [{ action: 'keypress', keys: ['tab'] }, 'success'],
    [{ action: 'scroll', direction: 'down' }, 'success'], [{ action: 'focus', app: 'Fixture' }, 'success'],
    [{ action: 'shell', command: process.execPath, args: ['-e', "process.stdout.write('fixture-output')"] }, 'success'],
    [{ action: 'file-list' }, 'success'], [{ action: 'file-read', path: 'read', includeText: true }, 'success'], [{ action: 'file-write', path: 'write', content: 'written' }, 'success'],
    [{ action: 'clipboard-read' }, 'unsupported'], [{ action: 'clipboard-write', clipboardText: 'private-clipboard' }, 'unsupported'],
    [{ action: 'browser-open', url: 'https://example.invalid' }, 'unsupported'], [{ action: 'app-launch', app: 'Fixture' }, 'unsupported'], [{ action: 'stop' }, 'success'],
  ];
  for (const [request, status] of cases) {
    const result = await client.execute(request, { callId: request.action });
    assert.equal(result.details.status, status, request.action);
    if (['health', 'doctor'].includes(request.action)) assert.equal(result.details.capabilitiesV1.producer.surface, 'sdk');
    if (['inspect', 'screenshot'].includes(request.action)) assert.equal(result.content[1].type, 'image');
    if (request.action === 'shell') assert.equal(result.details.stdout, 'fixture-output');
    if (request.action === 'file-read') assert.equal(result.details.text, 'source');
  }
  assert.equal(await fs.readFile(join(root, 'write'), 'utf8'), 'written');
  assert.equal(audits.length, 18);
  assert.doesNotMatch(JSON.stringify(audits), /private-text|private-clipboard|fixture-output/);
  const calls = (await fs.readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args[0]), ['doctor', 'doctor', 'inspect', 'screenshot', 'click', 'type-text', 'keypress', 'scroll', 'focus']);
});

test('same-scope Stop cancels active SDK child processes after trusted approval', async t => {
  const { client, root } = await fixture(t, { approvalProvider: () => 'allowed' });
  const marker = join(root, 'active-pid');
  const pending = client.execute({ action: 'shell', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`] }, { callId: 'active' });
  let pid = 0;
  for (let attempt = 0; attempt < 100; attempt++) { try { pid = Number(await readFile(marker, 'utf8')); } catch {} if (pid) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(pid > 0);
  assert.equal((await client.execute({ action: 'stop' }, { callId: 'stop-active' })).details.cancellationRequested, 1);
  assert.equal((await pending).details.status, 'cancelled');
  assert.throws(() => process.kill(pid, 0));
});


test('SDK health-only skips the configured process with immutable policy and no approval or repair advice', async t => {
  let approvals = 0;
  const permissions = resolveActionPermissions({ allowedActions: ['health'] });
  const snapshot = JSON.stringify(permissions);
  const { create, options, root, audits } = await fixture(t);
  const marker = join(root, 'unexpected-doctor');
  const adapter = join(root, 'configured-adapter.cjs');
  await writeFile(adapter, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');console.log('{"ok":true}')`, { mode: 0o700 });
  const client = create({ ...options, adapterPath: adapter, actionPermissions: permissions, approvalProvider: () => { approvals++; return 'allowed'; } });
  const health = await client.execute({ action: 'health', reason: 'private-sdk-health' }, { callId: 'health-only' });
  assert.equal(health.details.status, 'blocked');
  assert.deepEqual(health.details.adapterProbe, { action: 'doctor', status: 'skipped', code: 'ACTION_PROFILE_DENIED' });
  const report = health.details.capabilitiesV1 as any;
  assert.equal(report.schemaVersion, 1); assert.equal(report.producer.surface, 'sdk');
  assert.deepEqual(report.actionPermissions, { ...permissions });
  assert.equal(report.actions.doctor.state, 'unverified');
  assert.equal(report.actions.doctor.policy.profile, 'denied');
  assert.deepEqual(health.details.adapterInvocation, { configuredPath: adapter, resolvedPath: adapter, version: null, phase: 'before-start', processStarted: false, code: 'ACTION_PROFILE_DENIED' });
  assert.equal(health.details.repairHints, undefined); assert.equal(health.details.permissionFlow, undefined);
  assert.doesNotMatch(JSON.stringify(health), /private-sdk-health|MALFORMED_OUTPUT|CAPABILITY_SCHEMA_|Screen Recording|Accessibility|Install coven/);
  assert.deepEqual(JSON.parse(health.content[0].text), JSON.parse(JSON.stringify(health.details)));
  assert.equal((await client.execute({ action: 'stop' }, { callId: 'health-stop' })).details.status, 'success');
  assert.equal((await client.execute({ action: 'doctor' }, { callId: 'doctor-denied' })).details.code, 'ACTION_PROFILE_DENIED');
  await assert.rejects(readFile(marker)); assert.equal(approvals, 0);
  assert.equal(JSON.stringify(permissions), snapshot); assert.ok(Object.isFrozen(permissions.allowedActions));
  assert.deepEqual(audits[0].result, { status: 'blocked', success: false, code: 'ACTION_PROFILE_DENIED' });
  assert.doesNotMatch(JSON.stringify(audits), /private-sdk-health|capabilitiesV1|approvalId/);
  const enabled = create({ ...options, adapterPath: adapter, actionPermissions: resolveActionPermissions({ allowedActions: ['health', 'doctor'] }) });
  assert.equal((await enabled.execute({ action: 'health' }, { callId: 'health-enabled' })).details.status, 'success');
  assert.equal(await readFile(marker, 'utf8'), 'started');
});
