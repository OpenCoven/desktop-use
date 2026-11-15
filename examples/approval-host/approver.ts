#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, unlink } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { privateDirectory } from '../../src/mcp/broker-protocol.js';
import { readStartupConfig } from '../../src/mcp/config.js';
import { startApprovalHost } from './broker.js';
import { spawnConnector } from './connector.js';
import { queuedPrompt } from './queue.js';
import { terminalPrompt } from './terminal.js';

// Operator-launched approver (ADR 0001). It runs in its own terminal, owns the broker secret, and gives
// every harness that attaches its own connector. The harness side runs only the secret-free attach relay.
const MAX_SESSIONS = 8;
const messages: Record<string, string> = {
  STARTUP_INVALID: 'Usage: approver.js --config /absolute/private/config.json --attach-socket /absolute/private-dir/attach.sock',
  CONFIG_INVALID: 'Desktop approver unavailable; check the trusted configuration and private audit state.',
  TERMINAL_UNAVAILABLE: 'Desktop approver needs its own terminal; start it in a terminal window that no harness uses.',
  ATTACH_PATH_UNAVAILABLE: 'Desktop approver unavailable; the attach socket needs a short absolute path (Unix socket limit) in an existing or creatable directory you own with mode 0700.',
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

/** Create the private attach directory if needed. Reclaim only our own stale socket; never unlink anything else. */
async function claimAttachPath(path: string) {
  const directory = dirname(path);
  try {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error?.code !== 'EEXIST') throw error; });
    await privateDirectory(directory);
  } catch { throw new Error('ATTACH_PATH_UNAVAILABLE'); }
  const existing = await lstat(path).catch(error => { if (error?.code === 'ENOENT') return undefined; throw new Error('ATTACH_PATH_UNAVAILABLE'); });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('ATTACH_PATH_UNAVAILABLE');
  const refused = await new Promise<boolean>(resolve => {
    const probe = connect(path);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
  });
  if (!refused) throw new Error('APPROVER_RUNNING');
  await unlink(path);
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));

let cleanup: (() => Promise<void>) | undefined;
try {
  const { config, attach } = parseArguments(process.argv.slice(2));
  // Fail here, in the operator's terminal, rather than later inside a harness log.
  await readStartupConfig(config).then(options => options.close(), () => { throw new Error('CONFIG_INVALID'); });
  const terminal = terminalPrompt();
  if (!terminal.available) { terminal.close(); throw new Error('TERMINAL_UNAVAILABLE'); }
  const directory = await realpath(await mkdtemp('/tmp/cdu-')); await chmod(directory, 0o700);
  const secret = randomBytes(32);
  cleanup = async () => { terminal.close(); secret.fill(0); await rm(directory, { force: true, recursive: true }); };
  const host = await startApprovalHost({ directory, secret, prompt: queuedPrompt(terminal.prompt, MAX_SESSIONS) });
  cleanup = async () => { await host.close(); terminal.close(); secret.fill(0); await rm(directory, { force: true, recursive: true }); };
  await claimAttachPath(attach);

  const sessions = new Map<Socket, ChildProcess>(); const sockets = new Set<Socket>(); let attached = 0; let closing = false;
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    if (closing || sessions.size >= MAX_SESSIONS) { process.stderr.write('Attach refused: attached session limit reached.\n'); socket.destroy(); return; }
    const session = `attach-${++attached}`;
    const child = spawnConnector({ config, approvalSocket: host.socketPath, secret, stdout: 'pipe', sessionSuffix: session });
    sessions.set(socket, child);
    // Harness exit or relay loss ends the connector's stdin, which runs its existing EOF cancellation and cleanup.
    socket.pipe(child.stdin!); socket.once('close', () => child.stdin!.end());
    child.stdout!.pipe(socket);
    child.once('error', () => socket.destroy());
    child.once('exit', () => { sessions.delete(socket); socket.end(() => socket.destroy()); if (!closing) process.stderr.write(`Harness session ${session} detached.\n`); });
    process.stderr.write(`Harness session ${session} attached.\n`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(attach, () => { server.removeListener('error', reject); resolve(); }); })
    .catch((error: NodeJS.ErrnoException) => { throw new Error(error?.code === 'EADDRINUSE' ? 'APPROVER_RUNNING' : 'ATTACH_PATH_UNAVAILABLE'); });
  await chmod(attach, 0o600);

  const release = cleanup;
  cleanup = async () => {
    if (closing) return; closing = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    const children = [...sessions.values()];
    for (const child of children) child.kill('SIGTERM');
    const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5000);
    await Promise.all(children.map(exited)); clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await closed; await unlink(attach).catch(() => {}); await release();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { void cleanup!().then(() => { process.stderr.write('Desktop approver stopped.\n'); }); });
  process.stderr.write(`Desktop approver ready. Harness MCP command: coven-desktop-use-mcp attach --socket ${attach}\nApproval reviews appear in this terminal. Press Ctrl+C to stop.\n`);
} catch (error) {
  await cleanup?.().catch(() => {});
  const code = error instanceof Error && error.message in messages ? error.message : 'CONFIG_INVALID';
  process.stderr.write(messages[code] + '\n'); process.exitCode = 1;
}
