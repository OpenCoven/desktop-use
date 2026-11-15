#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { privateDirectory } from '../../src/mcp/broker-protocol.js';
import { readStartupConfig } from '../../src/mcp/config.js';
import { startApprovalHost } from './broker.js';
import { connectorEntry, spawnConnector } from './connector.js';
import { queuedPrompt } from './queue.js';
import { terminalPrompt } from './terminal.js';

// Operator-launched approver (ADR 0001). It runs in its own terminal, owns the broker secret, and gives
// every harness that attaches its own connector. The harness side runs only the secret-free attach relay.
const MAX_SESSIONS = 8; const MAX_PENDING_REVIEWS = 8; const FIRST_BYTE_MS = 10_000; const FORCE_STOP_MS = 5000;
const messages: Record<string, string> = {
  STARTUP_INVALID: 'Usage: approver.js --config /absolute/private/config.json --attach-socket /absolute/private-dir/attach.sock',
  CONFIG_INVALID: 'Desktop approver unavailable; check the trusted configuration and private audit state.',
  TERMINAL_UNAVAILABLE: 'Desktop approver needs the foreground of its own terminal; start it, not as a background job, in a terminal window that no harness uses.',
  ATTACH_PATH_UNAVAILABLE: 'Desktop approver unavailable; the attach socket needs a short canonical absolute path (no symlinks: on macOS /tmp is /private/tmp) in a directory you own with mode 0700. A missing final directory is created.',
  APPROVER_RUNNING: 'Desktop approver unavailable; another approver is already listening on this attach socket.'
};

function parseArguments(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--attach-socket'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error('STARTUP_INVALID');
    values.set(args[i], args[i + 1]);
  }
  const config = values.get('--config'); const attach = values.get('--attach-socket');
  if (!config || !attach || !isAbsolute(config) || !isAbsolute(attach)) throw new Error('STARTUP_INVALID');
  return { config, attach };
}

/** A background job's first review read would stop it (SIGTTIN) and freeze every review. Unknown (no `ps`) is not treated as background. */
function foregroundOfOwnTerminal(): boolean {
  const result = spawnSync('ps', ['-o', 'pgid=', '-o', 'tpgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 5000 });
  const match = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(result.stdout ?? '');
  if (!match) return true;
  return Number(match[2]) > 0 && match[1] === match[2];
}

/** Create the private attach directory if needed. Reclaim only our own stale socket; never unlink anything else. */
async function claimAttachPath(path: string) {
  const directory = dirname(path); let created = false;
  try {
    await mkdir(directory, { mode: 0o700 }).then(() => { created = true; }, error => { if (error?.code !== 'EEXIST') throw error; });
    if (created) await chmod(directory, 0o700);
    await privateDirectory(directory);
  } catch {
    if (created) await rmdir(directory).catch(() => {});
    throw new Error('ATTACH_PATH_UNAVAILABLE');
  }
  const existing = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw new Error('ATTACH_PATH_UNAVAILABLE'); });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('ATTACH_PATH_UNAVAILABLE');
  // A live approver spawns nothing for a connection that sends no bytes, so this probe is silent there.
  const refused = await new Promise<boolean>(resolve => {
    const probe = connect(path);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
  });
  if (!refused) throw new Error('APPROVER_RUNNING');
  await unlink(path);
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
const say = (line: string) => { process.stderr.write(line + '\n'); };

let cleanup: (() => Promise<void>) | undefined;
try {
  const { config, attach } = parseArguments(process.argv.slice(2));
  // Fail here, in the operator's terminal, rather than later inside a harness log.
  await readStartupConfig(config).then(options => options.close(), () => { throw new Error('CONFIG_INVALID'); });
  // Check job control before opening the terminal, so a background start cannot stop on its first read.
  if (!foregroundOfOwnTerminal()) throw new Error('TERMINAL_UNAVAILABLE');
  const terminal = terminalPrompt();
  if (!terminal.available) { terminal.close(); throw new Error('TERMINAL_UNAVAILABLE'); }
  const directory = await realpath(await mkdtemp('/tmp/cdu-')); await chmod(directory, 0o700);
  const secret = randomBytes(32);
  cleanup = async () => { terminal.close(); secret.fill(0); await rm(directory, { force: true, recursive: true }); };
  const prompt = queuedPrompt(terminal.prompt, MAX_PENDING_REVIEWS, {
    queued: waiting => say(`Review waiting: ${waiting} earlier review(s) first.`),
    refused: () => say(`Review refused: ${MAX_PENDING_REVIEWS} reviews already pending. Nothing approved.`)
  });
  const host = await startApprovalHost({ directory, secret, prompt, notice: () => say('Review refused: this approver reached its review limit; restart it for a fresh session. Nothing approved.') });
  cleanup = async () => { await host.close(); terminal.close(); secret.fill(0); await rm(directory, { force: true, recursive: true }); };
  await claimAttachPath(attach);

  // Session labels are unique per approver run, so reviews and audit lines name one harness session.
  const run = randomBytes(3).toString('hex');
  const sessions = new Map<Socket, ChildProcess>(); const sockets = new Set<Socket>(); let attached = 0; let closing = false;
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    // Spawn a connector only once a client speaks; probes and idle connections cost nothing and are dropped.
    const idle = setTimeout(() => socket.destroy(), FIRST_BYTE_MS);
    socket.once('end', () => { if (!sessions.has(socket)) socket.destroy(); });
    socket.once('close', () => clearTimeout(idle));
    socket.once('data', (first: Buffer) => {
      clearTimeout(idle);
      if (closing || sessions.size >= MAX_SESSIONS) { say(`Attach refused: ${MAX_SESSIONS} harness sessions already attached.`); socket.destroy(); return; }
      const session = `attach-${run}-${++attached}`;
      const child = spawnConnector({ config, approvalSocket: host.socketPath, secret, stdout: 'pipe', sessionSuffix: session, detached: true });
      sessions.set(socket, child);
      child.stdin!.write(first); socket.pipe(child.stdin!);
      child.stdout!.pipe(socket);
      // Harness exit or relay loss ends the connector's stdin, which runs its existing EOF cancellation and audit.
      // Discard any output the harness can no longer read, so a blocked write cannot keep the connector alive.
      socket.once('close', () => { child.stdout!.unpipe(socket); child.stdout!.resume(); child.stdin!.end(); });
      child.once('error', () => socket.destroy());
      child.once('exit', () => { sessions.delete(socket); socket.end(() => socket.destroy()); if (!closing) say(`Harness session ${session} detached.`); });
      say(`Harness session ${session} attached.`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(attach, () => { server.removeListener('error', reject); resolve(); }); })
    .catch((error: NodeJS.ErrnoException) => { throw new Error(error?.code === 'EADDRINUSE' ? 'APPROVER_RUNNING' : 'ATTACH_PATH_UNAVAILABLE'); });
  await chmod(attach, 0o600);

  const release = cleanup; let stopping: Promise<void> | undefined;
  cleanup = () => stopping ??= (async () => {
    closing = true;
    // server.close() removes the socket file at once. Never unlink the path later: a newer approver may own it by then.
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    const children = [...sessions.values()];
    for (const child of children) child.kill('SIGTERM');
    const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, FORCE_STOP_MS);
    await Promise.all(children.map(exited)); clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await closed; await release();
  })();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {
    if (stopping) { say(`Still stopping: attached sessions are cancelling (forced after ${FORCE_STOP_MS / 1000} s).`); return; }
    void cleanup!().then(() => say('Desktop approver stopped.'));
  });
  say(`Desktop approver ready. Harness MCP server: command ${JSON.stringify(process.execPath)}, args ${JSON.stringify([connectorEntry, 'attach', '--socket', attach])}`);
  say('Approval reviews appear in this terminal. Press Ctrl+C to stop.');
} catch (error) {
  await cleanup?.().catch(() => {});
  const code = error instanceof Error && error.message in messages ? error.message : 'CONFIG_INVALID';
  say(messages[code]); process.exitCode = 1;
}
