import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const alive = pid => {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'A process observation needs a positive PID');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function until(read, description, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}
async function bounded(promise, ms, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, options = {}) {
  const module = await import('./factory.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.createLifecycleFixture, 'function', 'The lifecycle fixture factory must exist');
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'desktopuse-lifecycle-tests-')));
  const actors = [];
  let value;
  t.after(async () => {
    for (const actor of actors) {
      if (actor.child.exitCode === null && actor.child.signalCode === null) {
        actor.child.kill('SIGTERM');
        await bounded(actor.closed, 1000, 'owned adapter cancellation').catch(async () => {
          if (actor.child.exitCode === null && actor.child.signalCode === null) {
            if (process.platform !== 'win32') process.kill(-actor.child.pid, 'SIGKILL');
            else actor.child.kill('SIGKILL');
          }
          await bounded(actor.closed, 2000, 'owned adapter reap');
        });
      }
    }
    if (value) for (const operation of await value.readOperations()) {
      const pid = operation.active?.helperPid;
      if (pid && alive(pid)) {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        assert.ok(command.includes(join(value.root, 'helper.cjs')), 'Cleanup must confirm the exact task-owned helper');
        process.kill(pid, 'SIGKILL');
        await until(() => !alive(pid), 'orphan helper removal');
      }
    }
    await rm(sandbox, { recursive: true, force: true });
  });
  value = await module.createLifecycleFixture({ parentDir: sandbox, ...options });
  assert.equal(dirname(value.root), sandbox);
  assert.match(basename(value.root), /^desktopuse-lifecycle-/);
  assert.equal((await stat(value.root)).mode & 0o777, 0o700);
  return {
    ...value,
    start(action = 'type-text', text = 'private-fixture-input-canary') {
      const child = spawn(process.execPath, [value.adapterPath, action, '--text', text, '--confirm'], {
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: value.root, TMPDIR: value.root },
      });
      const actor = { child, stdout: '', stderr: '', closed: null };
      actors.push(actor);
      actor.closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      child.stdout.on('data', chunk => { actor.stdout += chunk; });
      child.stderr.on('data', chunk => { actor.stderr += chunk; });
      return actor;
    },
  };
}
const activeFor = (value, actor) => until(async () => (await value.readOperations()).find(operation => operation.active?.parentPid === actor.child.pid), 'actual helper-ready phase');
const afterEffectFor = (value, operation) => until(async () => {
  const current = (await value.readOperations()).find(item => item.operationId === operation.operationId);
  const held = (await value.readEvents()).some(event => event.operationId === operation.operationId && event.event === 'helper-after-effect');
  return current?.effectCommitted && (current.terminal || held) ? current : null;
}, 'held effect boundary or terminal outcome');

test('active phase follows a real child handshake and has no effect before release', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const actor = f.start();
  const operation = await activeFor(f, actor);
  assert.ok(alive(operation.active.helperPid));
  assert.notEqual(operation.active.helperPid, actor.child.pid);
  const ppid = Number(execFileSync('ps', ['-p', String(operation.active.helperPid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
  assert.equal(ppid, actor.child.pid, 'The observed ready helper must be the actual adapter child');
  assert.equal(operation.terminal, null);
  assert.equal(operation.effectCommitted, false);
  const events = await f.readEvents();
  assert.ok(events.some(event => event.event === 'helper-ready' && event.pid === operation.active.helperPid && event.operationId === operation.operationId));
  assert.equal(events.some(event => event.event === 'effect-committed'), false);
});

test('one release commits one fixed effect and the helper is reaped before terminal reporting', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const actor = f.start();
  const operation = await activeFor(f, actor);
  await f.release(operation.operationId);
  assert.deepEqual(await bounded(actor.closed, 5000, 'released operation'), { code: 0, signal: null });
  const result = JSON.parse(actor.stdout);
  assert.equal(result.ok, true);
  const final = (await f.readOperations()).find(item => item.operationId === operation.operationId);
  assert.equal(final.effectCommitted, true);
  assert.equal(final.terminal.status, 'success');
  assert.equal(final.terminal.helperReaped, true);
  assert.equal(alive(operation.active.helperPid), false);
  assert.equal((await f.readEvents()).filter(event => event.event === 'effect-committed' && event.operationId === operation.operationId).length, 1);
  await assert.rejects(f.release(operation.operationId), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.root, 'operations', operation.operationId, 'effect.txt'), 'utf8'), 'fixture-effect\n');
  assert.equal(actor.stderr, '');
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`${signal} before release reaps the actual child and a late gate cannot create an effect`, { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const actor = f.start();
  const operation = await activeFor(f, actor);
  actor.child.kill(signal);
  assert.deepEqual(await bounded(actor.closed, 5000, 'cancelled adapter'), { code: 0, signal: null });
  const result = JSON.parse(actor.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCELLED');
  const final = (await f.readOperations()).find(item => item.operationId === operation.operationId);
  assert.equal(final.terminal.status, 'cancelled');
  assert.equal(final.terminal.helperReaped, true);
  assert.equal(alive(operation.active.helperPid), false);
  await f.release(operation.operationId);
  await delay(50);
  assert.equal((await f.readOperations()).find(item => item.operationId === operation.operationId).effectCommitted, false);
  assert.equal((await f.readEvents()).some(event => event.operationId === operation.operationId && event.event === 'effect-committed'), false);
});

test('a process-group SIGTERM cleans up the adapter and helper together before a late release', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const actor = f.start();
  const operation = await activeFor(f, actor);
  process.kill(-actor.child.pid, 'SIGTERM');
  await bounded(actor.closed, 5000, 'owned process-group cancellation');
  assert.equal(alive(operation.active.helperPid), false);
  assert.equal(JSON.parse(actor.stdout).code, 'CANCELLED');
  await f.release(operation.operationId);
  await delay(50);
  assert.equal((await f.readOperations()).find(item => item.operationId === operation.operationId).effectCommitted, false);
});

test('post-effect hold exposes the committed boundary and cancellation preserves that effect', { timeout: 15000 }, async t => {
  const f = await fixture(t, { holdAfterEffect: true });
  const actor = f.start();
  const operation = await activeFor(f, actor);
  await f.release(operation.operationId);
  const committed = await afterEffectFor(f, operation);
  assert.equal(committed.terminal, null, 'The post-effect fence must hold a live helper');
  assert.ok(alive(operation.active.helperPid));
  actor.child.kill('SIGTERM');
  await bounded(actor.closed, 5000, 'post-effect cancellation');
  const final = (await f.readOperations()).find(item => item.operationId === operation.operationId);
  assert.equal(final.terminal.status, 'cancelled');
  assert.equal(final.terminal.effectCommitted, true);
  assert.equal(final.effectCommitted, true);
  assert.equal(alive(operation.active.helperPid), false);
  assert.equal(JSON.parse(actor.stdout).fixture.effectCommitted, true);
});

test('finish releases a held committed operation without a second effect', { timeout: 15000 }, async t => {
  const f = await fixture(t, { holdAfterEffect: true });
  const actor = f.start();
  const operation = await activeFor(f, actor);
  await f.release(operation.operationId);
  assert.equal((await afterEffectFor(f, operation)).terminal, null);
  await f.finish(operation.operationId);
  assert.deepEqual(await bounded(actor.closed, 5000, 'post-effect completion'), { code: 0, signal: null });
  assert.equal(JSON.parse(actor.stdout).ok, true);
  assert.equal((await f.readEvents()).filter(event => event.operationId === operation.operationId && event.event === 'effect-committed').length, 1);
  assert.equal(alive(operation.active.helperPid), false);
  await assert.rejects(f.finish(operation.operationId), { code: 'EEXIST' });
});

test('cancelling one fixture operation leaves the other active and independently releasable', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const first = f.start(), second = f.start();
  const [a, b] = await Promise.all([activeFor(f, first), activeFor(f, second)]);
  assert.notEqual(a.operationId, b.operationId);
  assert.notEqual(a.active.helperPid, b.active.helperPid);
  first.child.kill('SIGTERM');
  await bounded(first.closed, 5000, 'first operation cancellation');
  const pending = (await f.readOperations()).find(item => item.operationId === b.operationId);
  assert.equal(pending.terminal, null);
  assert.equal(pending.effectCommitted, false);
  assert.ok(alive(b.active.helperPid));
  await f.release(b.operationId);
  await bounded(second.closed, 5000, 'second operation completion');
  assert.equal(JSON.parse(second.stdout).ok, true);
  const final = await f.readOperations();
  assert.equal(final.find(item => item.operationId === a.operationId).effectCommitted, false);
  assert.equal(final.find(item => item.operationId === b.operationId).effectCommitted, true);
});

test('unsupported actions start no helper, and traversal or symlink gates write no foreign file', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const actor = f.start('doctor');
  await bounded(actor.closed, 5000, 'unsupported action');
  assert.deepEqual(JSON.parse(actor.stdout), { ok: false, code: 'FIXTURE_UNSUPPORTED' });
  assert.deepEqual(await f.readOperations(), []);
  const outside = join(dirname(f.root), 'outside');
  await mkdir(outside);
  await assert.rejects(f.release('../outside'), /Invalid fixture operation ID/);
  const link = join(f.root, 'operations', 'op-Foreign');
  await symlink(outside, link);
  try { await assert.rejects(f.release('op-Foreign'), /Unsafe fixture operation directory/); }
  finally { await rm(link); }
  await assert.rejects(readFile(join(outside, 'release')), { code: 'ENOENT' });
});

test('requested private text and raw argv stay absent from every fixture artifact and output channel', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const canary = `private-input-${randomBytes(16).toString('hex')}`;
  const actor = f.start('type-text', canary);
  const operation = await activeFor(f, actor);
  actor.child.kill('SIGTERM');
  await bounded(actor.closed, 5000, 'private operation cancellation');
  const texts = [actor.stdout, actor.stderr];
  for (const relative of await readdir(f.root, { recursive: true })) {
    const path = join(f.root, relative);
    if ((await stat(path)).isFile()) texts.push(await readFile(path, 'utf8'));
  }
  for (const text of texts) {
    assert.equal(text.includes(canary), false);
    assert.equal(text.includes(f.root), false);
  }
  assert.equal(alive(operation.active.helperPid), false);
});

test('audit snapshots expose missing or incomplete evidence and malformed records reveal no raw input', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.equal(typeof f.readAudit, 'function', 'Audit snapshots must expose completeness explicitly');
  assert.deepEqual(await f.readAudit(), { present: false, complete: false, events: [] });
  const actor = f.start();
  await activeFor(f, actor);
  actor.child.kill('SIGTERM');
  await bounded(actor.closed, 5000, 'audited cancellation');
  const before = await f.readAudit();
  assert.equal(before.present, true);
  assert.equal(before.complete, true);
  assert.ok(before.events.some(event => event.event === 'adapter-terminal'));
  await appendFile(join(f.root, 'events.jsonl'), '{"event":');
  const partial = await f.readAudit();
  assert.equal(partial.present, true);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.events, before.events);
  const canary = `private-corrupt-${randomBytes(16).toString('hex')}`;
  await appendFile(join(f.root, 'events.jsonl'), `not-json-${canary}\n`);
  await assert.rejects(f.readAudit(), error => error.message === 'Invalid fixture audit record' && !error.message.includes(canary) && !error.message.includes(f.root));
});

test('a terminal audit-write failure cannot strand a committed helper or leak its control path', { timeout: 15000 }, async t => {
  const f = await fixture(t, { holdAfterEffect: true });
  const actor = f.start();
  const operation = await activeFor(f, actor);
  await f.release(operation.operationId);
  assert.equal((await afterEffectFor(f, operation)).terminal, null);
  const audit = join(f.root, 'events.jsonl'), saved = join(f.root, 'events-before-fault.jsonl');
  await rename(audit, saved);
  await mkdir(audit);
  try {
    await f.finish(operation.operationId);
    const result = await bounded(actor.closed, 1000, 'terminal audit failure cleanup');
    assert.equal(result.code, 1);
    assert.equal(alive(operation.active.helperPid), false);
    const terminal = (await f.readOperations()).find(item => item.operationId === operation.operationId).terminal;
    assert.equal(terminal.status, 'error');
    assert.equal(terminal.effectCommitted, true);
    assert.equal(terminal.helperReaped, true);
    assert.equal(terminal.auditWritten, false);
    assert.equal(JSON.parse(actor.stdout).code, 'FIXTURE_AUDIT_FAILED');
    assert.equal(actor.stderr, '');
    assert.equal(actor.stdout.includes(f.root), false);
    await assert.rejects(f.readAudit(), /Fixture audit unavailable/);
  } finally {
    await rm(audit, { recursive: true, force: true });
    await rename(saved, audit);
    if (alive(operation.active.helperPid)) {
      const ppid = Number(execFileSync('ps', ['-p', String(operation.active.helperPid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
      assert.equal(ppid, actor.child.pid, 'Fault-probe cleanup must target the actual owned child');
      process.kill(operation.active.helperPid, 'SIGKILL');
      await bounded(actor.closed, 2000, 'fault-probe adapter reap');
    }
  }
});
