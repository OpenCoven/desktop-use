import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createJsonSchemaValidator } from './schema.js';
import { queuedPrompt } from '../../examples/approval-host/queue.js';
import type { Review } from './broker-protocol.js';
import type { ApprovalResolution } from '../core/client.js';

// The approver is the operator-launched process from ADR 0001; harnesses run only `attach`. Every scenario drives the
// compiled approver under a real PTY and the compiled relay as the harness MCP command, with a fixture adapter.
const approverEntry = fileURLToPath(new URL('../../dist/examples/approval-host/approver.js', import.meta.url));
const connectorEntry = fileURLToPath(new URL('../../dist/src/mcp/main.js', import.meta.url));
const ptyHost = fileURLToPath(new URL('./fixtures/pty-host.py', import.meta.url));
const env = { PATH: process.env.PATH ?? '' };
const ATTACH_MESSAGE = 'Desktop approver unavailable or session refused; check the approver terminal and the attach socket path.\n';
const SESSION = 'attach-[a-f0-9]{6}-\\d+';
const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-harness', version: '1' } } }) + '\n';
const until = async (condition: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const missing = (path: string) => readFile(path).then(() => false, () => true);

async function fixtureRoot(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'apv-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'w'); const state = join(root, 's'); await mkdir(workspace, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
  return { root, workspace, state, socket: join(root, 'a', 'attach.sock') };
}
async function writeConfig(root: string, workspace: string, state: string, extra: Record<string, unknown> = {}) {
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ workspaceDir: workspace, stateDir: state, principalId: 'approver-fixture', sessionId: 'harness', adapterPath: '/missing/fixture-adapter', actionProfile: 'full', approvalTimeoutMs: 3000, ...extra }), { mode: 0o600 });
  return config;
}

/** Launch the approver under a scripted PTY operator (`allow`, `deny`, `cancel`, `wait`) or with no terminal (`no-tty`). */
async function startApprover(t: any, decision: string, options: { extra?: Record<string, unknown>; base?: Awaited<ReturnType<typeof fixtureRoot>>; socket?: string; ready?: boolean } = {}) {
  const base = options.base ?? await fixtureRoot(t);
  const config = await writeConfig(base.root, base.workspace, base.state, options.extra);
  const socket = options.socket ?? base.socket;
  const child = spawn('python3', [ptyHost, decision, process.execPath, approverEntry, '--config', config, '--attach-socket', socket], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let display = ''; let stdout = ''; child.stderr.on('data', chunk => display += chunk); child.stdout.on('data', chunk => stdout += chunk);
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  if (options.ready !== false) await until(() => display.includes('Desktop approver ready') || child.exitCode !== null, 'approver ready');
  if (options.ready !== false) assert.match(display, /Desktop approver ready/, display);
  return { ...base, config, socket, child, exited, display: () => display, stdout: () => stdout };
}

/** A harness launching the relay, using the official SDK client transport. */
async function attachClient(t: any, socket: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [connectorEntry, 'attach', '--socket', socket], stderr: 'pipe', env });
  let stderr = ''; transport.stderr?.on('data', chunk => stderr += chunk);
  const client = new Client({ name: 'attached-harness', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => client.close()); await client.connect(transport).catch(error => { throw new Error(`${error.message}; stderr: ${stderr}`); });
  return { client, stderr: () => stderr };
}
/** A harness relay process whose stdio the test controls directly (EOF, kill, exit status). */
async function attachProcess(t: any, socket: string) {
  const child = spawn(process.execPath, [connectorEntry, 'attach', '--socket', socket], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const client = new Client({ name: 'attached-harness-process', version: '1' }, { jsonSchemaValidator: createJsonSchemaValidator(), versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(() => client.close().catch(() => {})); await client.connect(new StdioServerTransport(child.stdout, child.stdin));
  return { child, client, exited, stderr: () => stderr };
}
/** The one connector this approver spawned, found by its trusted configuration path. */
function connectorPid(config: string) {
  const pids = spawnSync('pgrep', ['-f', config], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const found = pids.filter(pid => / --session-suffix /.test(spawnSync('ps', ['-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout));
  assert.equal(found.length, 1, found.join(',')); return Number(found[0]);
}
function runRelay(socket: string) {
  return spawnSync(process.execPath, [connectorEntry, 'attach', '--socket', socket], { input: '', encoding: 'utf8', env, timeout: 10_000 });
}

for (const decision of ['allow', 'deny', 'cancel', 'wait']) test(`attached harness ${decision}: the approver terminal authorizes only its own decision`, { timeout: 20_000 }, async t => {
  const f = await startApprover(t, decision, { extra: { approvalTimeoutMs: decision === 'wait' ? 300 : 3000 } });
  const { client } = await attachClient(t, f.socket);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['computer_use']);
  const result = await client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'effect.txt', content: 'harmless attached proof' } });
  assert.equal((result.structuredContent as any).success, decision === 'allow');
  assert.match(f.display(), /Decision \[allow\/deny\/cancel\]/);
  // The operator's terminal names the same outcome as the tool result; an unanswered review expires, not "cancelled".
  const outcome = { allow: 'allowed', deny: 'denied', cancel: 'cancelled', wait: 'expired' }[decision];
  await until(() => f.display().includes(`Approval ${outcome}.`), `terminal outcome ${outcome}`);
  if (decision === 'wait') assert.doesNotMatch(f.display(), /Approval cancelled\./);
  // The official stdio client may launch the relay more than once while connecting, so session numbers vary.
  assert.match(f.display(), /harmless attached proof/); assert.match(f.display(), new RegExp(`"sessionId": "harness:${SESSION}"`));
  assert.doesNotMatch(f.display(), /approvalId|operationId|"mac"|"nonce"/);
  if (decision === 'allow') assert.equal(await readFile(join(f.workspace, 'effect.txt'), 'utf8'), 'harmless attached proof'); else assert.ok(await missing(join(f.workspace, 'effect.txt')));
  const audit = await readFile(join(f.state, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(audit, /harmless attached proof/); assert.match(audit, new RegExp(`harness:${SESSION}`));
  assert.equal(f.stdout(), '', 'the approver never writes protocol or reviews to stdout');
});

test('two attached harness sessions get separate connectors and scopes, and their reviews queue instead of failing busy', { timeout: 20_000 }, async t => {
  const f = await startApprover(t, 'gated-allow');
  const first = await attachClient(t, f.socket); const second = await attachClient(t, f.socket);
  const pendingFirst = first.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'first.txt', content: 'first harmless' } });
  // The operator holds the first review on screen until the second has arrived; it must wait its turn, not fail as busy.
  await until(() => f.display().includes('Decision [allow/deny/cancel]'), 'first review display');
  const pendingSecond = second.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'second.txt', content: 'second harmless' } });
  await until(() => /Review waiting: 1 earlier review\(s\) first\./.test(f.display()), 'second review queued behind the first');
  f.child.kill('SIGUSR1');
  const [a, b] = await Promise.all([pendingFirst, pendingSecond]);
  assert.equal((a.structuredContent as any).success, true); assert.equal((b.structuredContent as any).success, true);
  assert.equal(await readFile(join(f.workspace, 'first.txt'), 'utf8'), 'first harmless');
  assert.equal(await readFile(join(f.workspace, 'second.txt'), 'utf8'), 'second harmless');
  assert.equal(f.display().match(/Decision \[allow\/deny\/cancel\]/g)?.length, 2);
  const reviewed = new Set([...f.display().matchAll(new RegExp(`"sessionId": "harness:(${SESSION})"`, 'g'))].map(match => match[1]));
  assert.equal(reviewed.size, 2, 'each review names its own harness session');
});

test('Stop from one attached session cannot reach another session\'s pending review (separate connectors), while same-session Stop still can', { timeout: 20_000 }, async t => {
  const f = await startApprover(t, 'wait', { extra: { approvalTimeoutMs: 60_000 } });
  const owner = await attachClient(t, f.socket); const other = await attachClient(t, f.socket);
  const pending = owner.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'pending.txt', content: 'none' } });
  await until(() => f.display().includes('Decision [allow/deny/cancel]'), 'review display');
  const foreign = await other.client.callTool({ name: 'computer_use', arguments: { action: 'stop' } });
  assert.equal((foreign.structuredContent as any).cancellationRequested, 0);
  const still = await Promise.race([pending.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('pending'), 300))]);
  assert.equal(still, 'pending', 'a different harness session must not reach the pending review');
  const own = await owner.client.callTool({ name: 'computer_use', arguments: { action: 'stop' } });
  assert.equal((own.structuredContent as any).cancellationRequested, 1);
  assert.equal(((await pending).structuredContent as any).status, 'cancelled');
  assert.ok(await missing(join(f.workspace, 'pending.txt')));
});

for (const mode of ['eof', 'kill'] as const) test(`harness ${mode === 'eof' ? 'stdin EOF' : 'relay kill'} cancels its pending review, and the approver keeps serving`, { timeout: 20_000 }, async t => {
  const f = await startApprover(t, 'wait', { extra: { approvalTimeoutMs: 60_000 } });
  const relay = await attachProcess(t, f.socket);
  const pending = relay.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'gone.txt', content: 'none' } }).catch(error => error);
  await until(() => f.display().includes('Decision [allow/deny/cancel]'), 'review display');
  if (mode === 'eof') relay.child.stdin.end(); else relay.child.kill('SIGKILL');
  const exit = await relay.exited;
  if (mode === 'eof') assert.deepEqual(exit, { code: 0, signal: null }); else assert.equal(exit.signal, 'SIGKILL');
  await pending;
  await until(() => /Harness session attach-[a-f0-9]{6}-1 detached\./.test(f.display()), 'connector exit');
  assert.match(f.display(), /Approval cancelled\./);
  assert.match(await readFile(join(f.state, 'audit.jsonl'), 'utf8'), /CANCELLED/);
  assert.ok(await missing(join(f.workspace, 'gone.txt')));
  const next = await attachClient(t, f.socket);
  assert.deepEqual((await next.client.listTools()).tools.map(tool => tool.name), ['computer_use']);
  assert.match(f.display(), /Harness session attach-[a-f0-9]{6}-2 attached\./);
});

test('a harness that stops reading and then disappears still releases its connector and session slot', { timeout: 30_000 }, async t => {
  const f = await startApprover(t, 'wait');
  const socket = connect(f.socket); socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve)); socket.pause();
  // Fill the connector's output path while the harness never reads, then drop the relay.
  const requests = [INITIALIZE, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'];
  for (let id = 1; id <= 2000; id++) requests.push(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n');
  socket.write(requests.join(''));
  await until(() => /Harness session attach-[a-f0-9]{6}-1 attached\./.test(f.display()), 'session attach');
  await new Promise(resolve => setTimeout(resolve, 1000));
  socket.destroy();
  await until(() => /Harness session attach-[a-f0-9]{6}-1 detached\./.test(f.display()), 'connector exit after relay loss', 10_000);
  const started = Date.now(); f.child.kill('SIGTERM');
  assert.equal(await f.exited, 0); assert.ok(Date.now() - started < 4000, 'shutdown needed no forced kill');
});

test('stopping the approver cancels pending reviews, ends every relay visibly and removes its socket', { timeout: 20_000 }, async t => {
  const f = await startApprover(t, 'wait', { extra: { approvalTimeoutMs: 60_000 } });
  const relay = await attachProcess(t, f.socket);
  const pending = relay.client.callTool({ name: 'computer_use', arguments: { action: 'file-write', path: 'stopped.txt', content: 'none' } }).catch(error => error);
  await until(() => f.display().includes('Decision [allow/deny/cancel]'), 'review display');
  // A repeated stop signal during cleanup must not kill the approver before sessions finish cancelling. Hold cleanup
  // open deterministically: a stopped connector cannot act on the approver's SIGTERM until it is continued.
  const connector = connectorPid(f.config);
  process.kill(connector, 'SIGSTOP'); t.after(() => { try { process.kill(connector, 'SIGCONT'); } catch {} });
  f.child.kill('SIGTERM');
  // Cleanup has begun once the attach socket is gone (server.close() unlinks it), so the repeat cannot coalesce with it.
  await until(() => lstat(f.socket).then(() => false, () => true), 'cleanup started');
  f.child.kill('SIGTERM');
  await until(() => /Still stopping: attached sessions are cancelling \(forced after 5 s\)\./.test(f.display()), 'repeat notice');
  process.kill(connector, 'SIGCONT');
  assert.equal(await f.exited, 0);
  assert.deepEqual(await relay.exited, { code: 1, signal: null });
  assert.equal(relay.stderr(), ATTACH_MESSAGE);
  await pending;
  assert.match(f.display(), /Desktop approver stopped\./);
  assert.match(await readFile(join(f.state, 'audit.jsonl'), 'utf8'), /CANCELLED/);
  assert.ok(await missing(join(f.workspace, 'stopped.txt')));
  assert.deepEqual(await readdir(join(f.root, 'a')), []);
  const after = runRelay(f.socket);
  assert.equal(after.status, 1); assert.equal(after.stdout, ''); assert.equal(after.stderr, ATTACH_MESSAGE);
});

test('the relay fails visibly with one fixed message when no live private approver is listening', { timeout: 20_000 }, async t => {
  const { root } = await fixtureRoot(t);
  const open = join(root, 'open'); await mkdir(open, { mode: 0o755 }); await chmod(open, 0o755);
  const exposed = join(open, 'attach.sock');
  const server = createServer(socket => socket.destroy()); await new Promise<void>(resolve => server.listen(exposed, resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const privateDir = join(root, 'p'); await mkdir(privateDir, { mode: 0o700 });
  const stale = join(privateDir, 'stale.sock');
  const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stale)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => holder.stdout.once('data', resolve)); holder.kill('SIGKILL'); await new Promise(resolve => holder.once('exit', resolve));
  await chmod(stale, 0o600);
  for (const socket of [join(privateDir, 'absent.sock'), 'relative/attach.sock', exposed, stale]) {
    const result = runRelay(socket);
    assert.equal(result.status, 1, socket); assert.equal(result.stdout, ''); assert.equal(result.stderr, ATTACH_MESSAGE);
  }
  const usage = spawnSync(process.execPath, [connectorEntry, 'attach'], { input: '', encoding: 'utf8', env });
  assert.equal(usage.status, 1); assert.equal(usage.stdout, ''); assert.equal(usage.stderr, ATTACH_MESSAGE);
});

test('the approver refuses unsafe startup, a second live instance and foreign files, and reclaims only its own stale socket', { timeout: 30_000 }, async t => {
  const first = await startApprover(t, 'wait');
  const failure = async (options: Parameters<typeof startApprover>[2], decision = 'wait') => {
    const f = await startApprover(t, decision, { ...options, ready: false });
    assert.equal(await f.exited, 1); assert.equal(f.stdout(), ''); return f.display();
  };
  assert.match(await failure({ base: await fixtureRoot(t), socket: first.socket }), /another approver is already listening/);
  assert.deepEqual((await (await attachClient(t, first.socket)).client.listTools()).tools.map(tool => tool.name), ['computer_use']);

  const base = await fixtureRoot(t);
  assert.match(await failure({ base }, 'no-tty'), /needs the foreground of its own terminal/);
  const foreign = join(base.root, 'a'); await mkdir(foreign, { mode: 0o700 }); await writeFile(join(foreign, 'attach.sock'), 'operator file', { mode: 0o600 });
  assert.match(await failure({ base }), /attach socket needs a short canonical absolute path/);
  assert.equal(await readFile(join(foreign, 'attach.sock'), 'utf8'), 'operator file', 'a non-socket at the attach path is never removed');
  await chmod(foreign, 0o755);
  assert.match(await failure({ base, socket: join(foreign, 'other.sock') }), /attach socket needs a short canonical absolute path/);
  assert.match(await failure({ base, socket: join(base.root, 'missing-parent', 'deeper', 'attach.sock') }), /attach socket needs a short canonical absolute path/);

  // A directory created for a rejected (non-canonical) path is removed again.
  await mkdir(join(base.root, 'real'), { mode: 0o700 }); await symlink(join(base.root, 'real'), join(base.root, 'link'));
  assert.match(await failure({ base, socket: join(base.root, 'link', 'fresh', 'attach.sock') }), /no symlinks/);
  assert.deepEqual(await readdir(join(base.root, 'real')), []);
  assert.match(await failure({ base }, 'background'), /needs the foreground of its own terminal/);

  const broken = await fixtureRoot(t); await chmod(broken.state, 0o755);
  assert.match(await failure({ base: broken }), /check the trusted configuration/);

  const reclaim = await fixtureRoot(t); await mkdir(join(reclaim.root, 'a'), { mode: 0o700 });
  const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(reclaim.socket)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => holder.stdout.once('data', resolve)); holder.kill('SIGKILL'); await new Promise(resolve => holder.once('exit', resolve));
  assert.ok((await lstat(reclaim.socket)).isSocket(), 'stale socket left behind');
  const reclaimed = await startApprover(t, 'wait', { base: reclaim });
  assert.equal(((await lstat(reclaimed.socket)).mode & 0o777), 0o600);
  assert.deepEqual((await (await attachClient(t, reclaimed.socket)).client.listTools()).tools.map(tool => tool.name), ['computer_use']);
});

test('attaches beyond the session bound are refused visibly without another connector', { timeout: 30_000 }, async t => {
  const f = await startApprover(t, 'wait');
  const held: Socket[] = []; t.after(() => { for (const socket of held) socket.destroy(); });
  const attached = () => f.display().match(/Harness session attach-[a-f0-9]{6}-\d+ attached\./g)?.length ?? 0;
  // A connection that sends nothing (for example another approver's liveness probe) spawns no connector.
  const silent = connect(f.socket); silent.on('error', () => {}); await new Promise(resolve => silent.once('connect', resolve)); silent.destroy();
  for (let i = 0; i < 8; i++) {
    const socket = connect(f.socket); socket.on('error', () => {}); socket.resume(); held.push(socket);
    await new Promise(resolve => socket.once('connect', resolve)); socket.write(INITIALIZE);
  }
  await until(() => attached() === 8, 'eight live sessions');
  assert.doesNotMatch(f.display(), /-9 attached/, 'the silent probe was not a session');
  const extra = connect(f.socket); extra.on('error', () => {}); extra.resume();
  await new Promise(resolve => extra.once('connect', resolve)); extra.write(INITIALIZE);
  await new Promise(resolve => extra.once('close', resolve));
  assert.match(f.display(), /Attach refused: 8 harness sessions already attached\./); assert.equal(attached(), 8);
  // Closing sessions frees slots (two, because the official client may launch the relay twice while connecting).
  held[0].end(); held[1].end();
  await until(() => /attach-[a-f0-9]{6}-1 detached\./.test(f.display()) && /attach-[a-f0-9]{6}-2 detached\./.test(f.display()), 'slot release');
  assert.deepEqual((await (await attachClient(t, f.socket)).client.listTools()).tools.map(tool => tool.name), ['computer_use']);
});

test('the broker secret never appears in connector arguments, environment or private directories', { timeout: 20_000 }, async t => {
  const f = await startApprover(t, 'wait');
  const { client } = await attachClient(t, f.socket); await client.listTools();
  const processes = spawnSync('pgrep', ['-f', f.config], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const commands = processes.map(pid => spawnSync('ps', ['-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout.trim()).filter(Boolean);
  const connectors = commands.filter(command => new RegExp(` --session-suffix ${SESSION}$`).test(command));
  assert.equal(connectors.length, 1, commands.join('\n'));
  assert.match(connectors[0], /--approval-secret-fd 3( |$)/);
  // Connectors run in their own session, so the operator's Ctrl+C or Ctrl+Z reaches only the approver.
  const groups = processes.map(pid => [pid, spawnSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8' }).stdout.trim(), spawnSync('ps', ['-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout]);
  const approverGroup = groups.find(([, , command]) => command.includes('approver.js') && !command.includes('pty-host'))?.[1];
  const connectorGroup = groups.find(([, , command]) => command.includes('--session-suffix'))?.[1];
  assert.ok(approverGroup && connectorGroup && approverGroup !== connectorGroup, JSON.stringify(groups.map(([pid, group]) => [pid, group])));
  for (const command of commands) assert.doesNotMatch(command, /[a-f0-9]{64}/, 'no secret-shaped value in any argument vector');
  assert.deepEqual(await readdir(join(f.root, 'a')), ['attach.sock']);
  assert.ok((await readdir(f.state)).every(name => name === 'audit.jsonl'));
  await t.test('process environments', { skip: !existsSync('/proc/self/environ') && 'process environments are not observable on this OS' }, async () => {
    for (const pid of processes) {
      const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
      assert.doesNotMatch(environ, /[a-f0-9]{64}/);
    }
  });
});

test('the review queue serializes, bounds and releases waiters without overlapping the active review', async () => {
  const review = {} as Review;
  const started: number[] = []; const finishers: Array<(value: ApprovalResolution) => void> = [];
  const queued: number[] = []; let refused = 0;
  const prompt = queuedPrompt((_review, _signal) => new Promise<ApprovalResolution>(resolve => { started.push(finishers.length); finishers.push(resolve); }), 3, { queued: waiting => queued.push(waiting), refused: () => refused++ });
  const signals = [new AbortController(), new AbortController(), new AbortController(), new AbortController()];
  const first = prompt(review, signals[0].signal); const second = prompt(review, signals[1].signal); const third = prompt(review, signals[2].signal);
  assert.equal(await prompt(review, signals[3].signal), 'unavailable', 'a full queue fails closed');
  assert.deepEqual(queued, [1, 2], 'the operator is told when a review waits'); assert.equal(refused, 1, 'and when one is refused');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0], 'only one review is displayed at a time');
  signals[1].abort(); assert.equal(await second, 'cancelled', 'a cancelled waiter leaves immediately');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0], 'the next waiter still waits for the active review');
  finishers[0]('denied'); assert.equal(await first, 'denied');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]); finishers[1]('allowed'); assert.equal(await third, 'allowed');
  const failing = queuedPrompt(() => Promise.reject(new Error('ui failure')));
  assert.equal(await failing(review, new AbortController().signal), 'unavailable');
  assert.equal(await failing(review, new AbortController().signal), 'unavailable', 'a failed review does not wedge the queue');
});
