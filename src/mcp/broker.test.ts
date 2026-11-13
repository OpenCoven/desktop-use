import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, unlink, chmod, readFile, symlink } from 'node:fs/promises';
import { openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { createDesktopClient } from '../core/client.js';
import { resolveActionPermissions } from '../action-permissions.js';

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'broker24-'))); await chmod(root, 0o700);
  t.after(() => rm(root, { force: true, recursive: true }));
  const module = await import('./broker.js').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {} as any; throw error; });
  assert.equal(typeof module.createBrokerProvider, 'function', 'private broker provider must exist');
  const hostModule = await import('../../examples/approval-host/broker.js').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {} as any; throw error; });
  assert.equal(typeof hostModule.startApprovalHost, 'function', 'separate approval host must exist');
  const secret = randomBytes(32); let fdCount = 0;
  async function provider(key = secret, path = join(root, 'approval.sock')) {
    const pathFd = join(root, `secret-${fdCount++}`); const fd = openSync(pathFd, 'wx+', 0o600); writeSync(fd, key.toString('hex') + '\n', 0, 'utf8'); await unlink(pathFd);
    // The anonymous open descriptor is the exact construction boundary; no environment secret.
    const value = await module.createBrokerProvider({ socketPath: path, secretFd: fd });
    t.after(() => value.close()); return value;
  }
  const client = (broker: any, timeout = 1000) => createDesktopClient({ workspaceDir: root, scope: { principalId: 'fixture', sessionId: root }, adapterPath: '/missing/fixture-adapter', auditSink: async () => {}, actionPermissions: resolveActionPermissions(), approvalProvider: broker.provider, approvalTimeoutMs: timeout });
  async function host(prompt: any) { const h = await hostModule.startApprovalHost({ directory: root, secret, prompt }); t.after(() => h.close()); return h; }
  return { root, module, secret, provider, client, host };
}
for (const decision of ['allowed', 'denied', 'expired', 'cancelled', 'unavailable']) test(`authenticated broker ${decision} is bound to exactly one canonical operation`, async t => {
  const f = await fixture(t); let prompts = 0;
  await f.host(async (challenge: any) => { prompts++; assert.equal(challenge.params.path, join(f.root, 'effect')); assert.equal(challenge.scope.principalId, 'fixture'); return decision; });
  const c = f.client(await f.provider());
  const r = await c.execute({ action: 'file-write', path: 'effect', content: 'harmless' }, { callId: 'broker' });
  assert.equal(prompts, 1); assert.equal(r.details.success, decision === 'allowed');
  if (decision === 'allowed') assert.equal(await readFile(join(f.root, 'effect'), 'utf8'), 'harmless'); else await assert.rejects(readFile(join(f.root, 'effect')));
});
test('foreign secret is never prompted and cannot authorize', async t => {
  const f = await fixture(t); let prompts = 0; await f.host(async () => { prompts++; return 'allowed'; });
  const r = await f.client(await f.provider(randomBytes(32))).execute({ action: 'file-write', path: 'foreign', content: 'none' }, { callId: 'foreign' });
  assert.equal(r.details.status, 'needsApproval'); assert.equal(prompts, 0); await assert.rejects(readFile(join(f.root, 'foreign')));
});
test('missing broker, nonprivate directory, symlink socket and invalid inherited secret fail closed', async t => {
  const f = await fixture(t);
  const absent = await f.provider(); assert.equal((await f.client(absent).execute({ action: 'file-write', path: 'none', content: 'none' }, { callId: 'missing' })).details.status, 'needsApproval');
  await f.host(async () => 'allowed'); await chmod(f.root, 0o755);
  assert.equal((await f.client(await f.provider()).execute({ action: 'file-write', path: 'none', content: 'none' }, { callId: 'public' })).details.status, 'needsApproval');
  await chmod(f.root, 0o700); const alias = join(f.root, 'alias.sock'); await symlink(join(f.root, 'approval.sock'), alias);
  assert.equal((await f.client(await f.provider(f.secret, alias)).execute({ action: 'file-write', path: 'none', content: 'none' }, { callId: 'alias' })).details.status, 'needsApproval');
  await assert.rejects(f.module.createBrokerProvider({ socketPath: join(f.root, 'approval.sock'), secretFd: -1 }));
  await assert.rejects(readFile(join(f.root, 'none')));
});
test('Stop, expiry and provider close abort pending broker UI without effects or late approval', async t => {
  for (const mode of ['stop', 'expiry', 'close']) {
    const f = await fixture(t); let entered!: () => void; const ready = new Promise<void>(r => entered = r); let aborted!: () => void; const closed = new Promise<void>(r => aborted = r);
    await f.host(async (_challenge: any, signal: AbortSignal) => { entered(); return new Promise(resolve => signal.addEventListener('abort', () => { aborted(); resolve('allowed'); }, { once: true })); });
    const broker = await f.provider(); const client = f.client(broker, mode === 'expiry' ? 100 : 2000);
    const pending = client.execute({ action: 'file-write', path: 'late', content: 'none' }, { callId: mode }); await ready;
    if (mode === 'stop') await client.execute({ action: 'stop' }, { callId: 'stop' });
    if (mode === 'close') broker.close();
    const result = await pending; assert.equal(result.details.success, false); await closed;
    await assert.rejects(readFile(join(f.root, 'late')));
  }
});
for (const variant of ['malformed', 'mismatch', 'eof', 'oversize', 'repeated']) test(`${variant} broker response cannot authorize an operation`, async t => {
  const f = await fixture(t); const path = join(f.root, 'approval.sock');
  const server = createServer(socket => { socket.on('error', () => {}); socket.once('data', () => {
    if (variant === 'eof') return socket.end();
    socket.end(variant === 'malformed' ? 'private-provider-diagnostic\n' : variant === 'oversize' ? 'x'.repeat(1_100_000) : variant === 'repeated' ? '{}\n{}\n' : JSON.stringify({ decision: 'allowed', nonce: 'foreign', mac: '0'.repeat(64) }) + '\n');
  }); }); await new Promise<void>(resolve => server.listen(path, resolve)); await chmod(path, 0o600); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const result = await f.client(await f.provider()).execute({ action: 'file-write', path: 'bad', content: 'none' }, { callId: variant });
  assert.equal(result.details.status, 'needsApproval'); assert.doesNotMatch(JSON.stringify(result), /private-provider-diagnostic/); await assert.rejects(readFile(join(f.root, 'bad')));
});
for (const variant of ['nonce', 'digest', 'signature', 'duplicate', 'duplicate-key', 'replay']) test(`authenticated ${variant} response cannot be rebound or replayed`, async t => {
  const f = await fixture(t); const { mac, digest, readRequest, frame } = await import('./broker-protocol.js');
  const path = join(f.root, 'approval.sock'); let cached = ''; let count = 0;
  const server = createServer({ allowHalfOpen: true }, socket => { socket.on('error', () => {}); void (async () => {
    const received = await readRequest(socket); const { mac: _signature, ...request } = received; count++;
    const response = { v: 1, nonce: variant === 'nonce' ? '0'.repeat(64) : request.nonce, digest: variant === 'digest' ? '0'.repeat(64) : digest(request), decision: 'allowed' };
    const encoded = frame({ ...response, mac: variant === 'signature' ? '0'.repeat(64) : mac(f.secret, 'response', response) });
    if (variant === 'replay' && cached) socket.end(cached); else { cached = encoded; socket.end(variant === 'duplicate' ? encoded + encoded : variant === 'duplicate-key' ? '{"v":0,' + encoded.slice(1) : encoded); }
  })().catch(() => socket.destroy()); });
  await new Promise<void>(resolve => server.listen(path, resolve)); await chmod(path, 0o600); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const client = f.client(await f.provider());
  if (variant === 'replay') assert.equal((await client.execute({ action: 'file-write', path: 'first', content: 'harmless' }, { callId: 'same' })).details.success, true);
  const result = await client.execute({ action: 'file-write', path: 'second', content: 'none' }, { callId: 'same' });
  assert.equal(result.details.success, false); await assert.rejects(readFile(join(f.root, 'second')));
});
test('reference broker rejects a repeated authenticated request before a second operator prompt', async t => {
  const f = await fixture(t); let request: any; let prompts = 0;
  // Capture an authentic canonical challenge without granting the SDK operation.
  const capture = createDesktopClient({ workspaceDir: f.root, scope: { principalId: 'fixture' }, adapterPath: '/missing/fixture-adapter', actionPermissions: resolveActionPermissions(), auditSink: async () => {}, approvalProvider: challenge => { const { signal: _signal, ...body } = challenge; request = { v: 1, nonce: randomBytes(32).toString('hex'), body }; return 'denied'; } });
  await capture.execute({ action: 'file-write', path: 'not-written', content: 'none' }, { callId: 'capture' });
  const h = await f.host(async () => { prompts++; return 'denied'; });
  const { mac, frame, readFrame } = await import('./broker-protocol.js'); const { connect } = await import('node:net');
  for (let i = 0; i < 2; i++) {
    const socket = connect({ path: h.socketPath, allowHalfOpen: true }); const response = readFrame(socket).catch(() => undefined);
    socket.on('connect', () => socket.write(frame({ ...request, mac: mac(f.secret, 'request', request) })));
    const value = await response; socket.destroy(); if (i === 0) assert.equal(value.decision, 'denied'); else assert.equal(value, undefined);
  }
  assert.equal(prompts, 1); await assert.rejects(readFile(join(f.root, 'not-written')));
});
